/**
 * Cursor CLI 推理适配器。
 *
 * cursor-agent 不是 OpenAI 兼容 HTTP 端点，也不接受外部 function tools。
 * 这里把 BigBotArt 的 Context/工具定义编成严格 JSON 协议，再把 CLI 的文本结果
 * 还原成 pi-ai AssistantMessage，使现有工具桥、确认闸与诚实性检查全部复用。
 *
 * 安全边界:固定 --mode ask，不传 --force/--approve-mcps，工作区指向空目录。
 * Cursor 自带工具不得代替 BigBotArt 工具执行任何画布或文件操作。
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, Context, ToolCall } from '@earendil-works/pi-ai';

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const activeChildren = new Set<ReturnType<typeof spawn>>();

/** worker 被主进程终止时也杀掉 Cursor 子进程，避免取消后仍在后台消耗额度。 */
export function cancelAllCursorCli(): void {
  for (const child of activeChildren) child.kill('SIGTERM');
  activeChildren.clear();
}

interface CursorEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  error?: unknown;
}

interface CursorReply {
  text: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/** 把一轮完整上下文编码为 CLI prompt;stdin 传入，不受 argv 长度限制。 */
export function buildCursorPrompt(context: Context): string {
  return [
    '你是 BigBotArt 的 Cursor CLI 推理后端。你只负责决定下一条助手消息。',
    '禁止调用 Cursor 自带的任何工具，禁止读取/修改文件、执行 Shell 或访问 MCP；只根据下方对话作出决策。',
    'BigBotArt 会真正执行工具。你不能声称已经执行了某个工具，除非历史消息中已有对应 toolResult。',
    '',
    '只输出一个 JSON 对象，不要 Markdown 代码围栏，不要输出解释性前缀或后缀。形状为:',
    '{"text":"给用户看的文本，可为空字符串","toolCalls":[{"name":"工具名","arguments":{}}]}',
    '需要执行一个或多个工具时填写 toolCalls；任务完成或只需回答时 toolCalls 必须为 []。',
    'arguments 必须是 JSON 对象，不要用字符串包裹。toolCalls 中只能使用下方声明的工具名。',
    '需要向用户提问时调用 ask.user；不要只用正文提问。',
    '',
    '【BigBotArt 系统指令】',
    context.systemPrompt,
    '',
    '【可用工具定义(JSON)】',
    JSON.stringify(context.tools ?? []),
    '',
    '【对话消息(JSON，按时间顺序;toolResult 是真实工具执行结果)】',
    JSON.stringify(context.messages),
  ].join('\n');
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'string') {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('arguments 字符串必须解析为 JSON 对象');
    }
    return parsed as Record<string, unknown>;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('arguments 必须是 JSON 对象');
  return raw as Record<string, unknown>;
}

/** 从「说明文字 + JSON + 尾随文字」中提取首个协议对象，字符串内的花括号不参与配对。 */
function embeddedJsonObject(raw: string): unknown | undefined {
  const match = /\{\s*"(?:text|reply|toolCalls|tool_calls)"\s*:/.exec(raw);
  if (!match) return undefined;
  const start = match.index;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** 解析模型在 CLI envelope.result 中返回的 JSON;普通文本作为最终回复兼容。 */
export function parseCursorReply(raw: string): CursorReply {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Cursor CLI 返回了空回复');
  let parsed: unknown;
  try {
    const unfenced = trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    parsed = JSON.parse(unfenced);
  } catch {
    parsed = embeddedJsonObject(trimmed);
    if (!parsed) {
      // 模型完全没遵守 JSON 协议时保留其实际文本，交给既有「只说不做」等闸门处理。
      return { text: trimmed, toolCalls: [] };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { text: trimmed, toolCalls: [] };
  }
  const value = parsed as {
    text?: unknown;
    reply?: unknown;
    toolCalls?: unknown;
    tool_calls?: unknown;
  };
  const rawCalls = value.toolCalls ?? value.tool_calls ?? [];
  if (!Array.isArray(rawCalls)) throw new Error('Cursor CLI 返回的 toolCalls 不是数组');
  const toolCalls = rawCalls.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Cursor CLI 第 ${index + 1} 个工具调用不是对象`);
    }
    const call = entry as { name?: unknown; arguments?: unknown; args?: unknown };
    const name = String(call.name ?? '').trim();
    if (!name) throw new Error(`Cursor CLI 第 ${index + 1} 个工具调用缺少 name`);
    try {
      return { name, arguments: parseArguments(call.arguments ?? call.args) };
    } catch (error) {
      throw new Error(`Cursor CLI 工具 ${name} 参数无效: ${errorText(error)}`);
    }
  });
  const text = typeof value.text === 'string' ? value.text : typeof value.reply === 'string' ? value.reply : '';
  if (!text.trim() && toolCalls.length === 0) throw new Error('Cursor CLI 返回的 JSON 既没有文本也没有工具调用');
  return { text, toolCalls };
}

export function toCursorAssistantMessage(raw: string): AssistantMessage {
  const parsed = parseCursorReply(raw);
  const content: Array<{ type: 'text'; text: string } | ToolCall> = [];
  if (parsed.text.trim()) content.push({ type: 'text', text: parsed.text });
  parsed.toolCalls.forEach((call, index) => {
    content.push({
      type: 'toolCall',
      id: `cursor-${Date.now()}-${index}`,
      name: call.name,
      arguments: call.arguments,
    } as ToolCall);
  });
  return {
    role: 'assistant',
    content,
    api: 'cursor-cli',
    provider: 'cursor-cli',
    model: 'cursor-cli',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/**
 * 从模型逐步输出的 JSON 中提取 text/reply 字符串前缀。
 * 只发已经解码出的新增文本，不把 {"text":...,"toolCalls":...} 协议外壳推到聊天界面。
 */
export class CursorReplyTextStream {
  private raw = '';
  private sent = '';

  push(delta: string): string {
    this.raw += delta;
    const current = readTextPrefix(this.raw);
    if (current.length <= this.sent.length) return '';
    const next = current.slice(this.sent.length);
    this.sent = current;
    return next;
  }
}

function readTextPrefix(raw: string): string {
  const match = /"(?:text|reply)"\s*:\s*"/.exec(raw);
  if (!match) return '';
  let i = match.index + match[0].length;
  let out = '';
  const escapes: Record<string, string> = {
    '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
  };
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === '"') return out;
    if (c !== '\\') {
      out += c;
      i += 1;
      continue;
    }
    if (i + 1 >= raw.length) return out;
    const escaped = raw[i + 1]!;
    if (escaped === 'u') {
      if (i + 5 >= raw.length) return out;
      const hex = raw.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 6;
      continue;
    }
    const decoded = escapes[escaped];
    if (decoded === undefined) return out;
    out += decoded;
    i += 2;
  }
  return out;
}

interface CursorStreamEvent extends CursorEnvelope {
  timestamp_ms?: number;
  model_call_id?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
}

export interface CursorCliOptions {
  model?: string;
  signal?: AbortSignal;
  /** 已解码的用户可见文本增量;协议 JSON 与 toolCalls 不会经此通道泄漏。 */
  onTextDelta?: (delta: string) => void;
  /** 测试/特殊安装可覆盖;默认使用 PATH 中的 cursor-agent。 */
  executable?: string;
}

/** 调一次本机 cursor-agent;stream-json 实时转文本增量,终态仍返回完整工具调用。 */
export async function completeCursorCli(context: Context, opts: CursorCliOptions = {}): Promise<AssistantMessage> {
  if (opts.signal?.aborted) throw new Error('Cursor CLI 已取消');
  const workspace = join(tmpdir(), `bigbotart-cursor-cli-${process.pid}`);
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const executable = opts.executable ?? process.env.BIGBOTART_CURSOR_CLI ?? 'cursor-agent';
  const args = [
    '--print', '--mode', 'ask', '--output-format', 'stream-json', '--stream-partial-output',
    '--trust', '--workspace', workspace,
  ];
  if (opts.model?.trim() && opts.model.trim().toLowerCase() !== 'auto') args.push('--model', opts.model.trim());
  const prompt = buildCursorPrompt(context);

  const finalText = await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: workspace,
      env: { ...process.env, NO_OPEN_BROWSER: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    activeChildren.add(child);
    let lineBuffer = '';
    let result = '';
    let terminalError = '';
    let err = '';
    let settled = false;
    const textStream = new CursorReplyTextStream();
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill('SIGTERM');
      finish(() => reject(new Error('Cursor CLI 已取消')));
    };
    const consumeLine = (line: string) => {
      if (!line.trim()) return;
      let event: CursorStreamEvent;
      try {
        event = JSON.parse(line) as CursorStreamEvent;
      } catch {
        throw new Error(`Cursor CLI 返回了无法解析的流式事件: ${line.slice(0, 1000)}`);
      }
      if (event.type === 'assistant') {
        // 官方去重规则:仅 timestamp_ms 存在且 model_call_id 缺失的事件含新文本。
        if (event.timestamp_ms === undefined || event.model_call_id !== undefined) return;
        for (const block of event.message?.content ?? []) {
          if (block.type !== 'text' || typeof block.text !== 'string') continue;
          const delta = textStream.push(block.text);
          if (delta && !opts.signal?.aborted) opts.onTextDelta?.(delta);
        }
        return;
      }
      if (event.type === 'result') {
        if (event.is_error || event.subtype === 'error') {
          terminalError = String(event.result ?? event.error ?? '未知错误');
        } else if (typeof event.result === 'string') {
          result = event.result;
        }
      }
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      try {
        lineBuffer += chunk;
        if (lineBuffer.length > MAX_OUTPUT_BYTES) throw new Error('Cursor CLI 流式输出超过 16MB 上限');
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) consumeLine(line);
      } catch (error) {
        child.kill('SIGTERM');
        finish(() => reject(error));
      }
    });
    child.stderr.on('data', (chunk: string) => {
      if (err.length < MAX_OUTPUT_BYTES) err += chunk;
    });
    child.on('error', (error) => {
      finish(() => reject(new Error(
        `无法启动 Cursor CLI(${executable}): ${error.message}。请安装 cursor-agent 并完成 cursor-agent login，或在设置页改选其他 LLM 来源。`,
      )));
    });
    child.on('close', (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(`Cursor CLI 退出码 ${code ?? 'null'}: ${err.trim() || terminalError || '未知错误'}`));
          return;
        }
        try {
          if (lineBuffer.trim()) consumeLine(lineBuffer);
          if (terminalError) throw new Error(`Cursor CLI 执行失败: ${terminalError}`);
          if (!result) throw new Error('Cursor CLI 流式响应缺少最终 result 文本');
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });
    child.stdin.on('error', (error) => {
      // abort/进程提前退出可能伴随 EPIPE;close/error 会给出真正的终态。
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
        finish(() => reject(new Error(`写入 Cursor CLI 输入失败: ${error.message}`)));
      }
    });
    child.stdin.end(prompt);
  });
  return toCursorAssistantMessage(finalText);
}
