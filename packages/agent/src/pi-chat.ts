/**
 * PiChatSession — 画布页 Agent 多轮对话 + 工具调用循环
 *
 * 流程:
 *   1. buildContext(主进程组装) → messages + tools 发给 LLM
 *   2. LLM 返回 toolUse → 通过反向 RPC 调主进程执行工具 → toolResult 追加进 messages → 再调 LLM
 *   3. 直到 LLM 不再调工具(stop)或达到最大轮数 → 返回 reply + toolCalls
 *   4. AbortSignal 随时可中止(103ms 内生效,已 spike 验证)
 *
 * 端点解析与 pi-planner 一致(远端 env > LM Studio 本地)。
 */
import { createModels, createProvider, type Context, type Message, type AssistantMessage, type ToolCall } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { LlmSource, AskOption } from '@bigbotart/shared';
import type { ChatParams, ChatResult, ToolCallRequest, ToolCallResponse } from './protocol.js';
import { PiPlanner } from './pi-planner.js';
import { toolDefinitions } from '@bigbotart/shared';

/**
 * 最大工具调用轮数(LLM ↔ 工具往返)。
 * 参考:原生 pi(CLI agent)用 maxTurns 做无限循环保护,生态常见默认 50
 * (pi-subagents 可配置 default max turns;reactLoop maxTurns=50)。
 * 本项目按上下文窗口等比例折算取保守值:32k 窗口原 8 轮 → 100k 窗口 ≈ 25 轮,
 * 留余量取 20(每轮历史线性增长,超窗会让远端拒绝;若遇长任务可手动拆小)。
 */
const MAX_TOOL_ROUNDS = 20;

/**
 * 敏感操作强制确认闸(结构兜底,与 memory.ts 的提问规则对应)。
 * 模型不守 prompt、用纯文本提问/直接执行时,由这里拦截:不执行,改发 ask.user 确认卡。
 * 用户点选确认后,下一轮 chat 凭选项文本授权放行。
 */
const SENSITIVE_TOOLS = new Set(['canvas.delete_node', 'storyboard.materialize', 'timeline.export', 'engine.submit']);
/** 否定/取消类选项(用户选了这些 = 未授权) */
const NEGATIVE_RE = /不|取消|算了|想想|保持|别/;

/** 把敏感工具调用描述成一行人话(确认卡清单用) */
function describeAction(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'canvas.delete_node':
      return `删除节点 ${args.nodeId ?? ''}`;
    case 'storyboard.materialize':
      return `按分镜表 ${args.nodeId ?? ''} 铺节点`;
    case 'timeline.export':
      return `导出时间线${args.outputName ? `(${args.outputName})` : ''}`;
    case 'engine.submit':
      return `提交生成 ${args.nodeId ?? ''}`;
    default:
      return `${name}(${JSON.stringify(args).slice(0, 60)})`;
  }
}

/** 从正文拆出思考内容(reasoning 模型经 OpenAI 兼容端点常把 <think> 漏进 text;兼容未闭合) */
/**
 * LLM 端点错误注解:识别本地模型(LM Studio)prompt template 渲染失败类错误并附中文修复指引。
 * 这类错误不是应用 bug:Ornith/Qwen3.5 系 GGUF 内置 chat_template 有硬 raise_exception,
 * agent 工具调用消息流(末尾是 tool 结果而非 user query)渲染即抛「No user query found in messages.」
 * (LM Studio 0.4.6 已知问题,见 lmstudio-bug-tracker #1586 / Ornith 官方修复 commit)。
 */
const LLM_TEMPLATE_ERR_RE = /jinja|prompt\s*template|no user query|render(?:ing)?\s*prompt/i;
const LLM_TEMPLATE_HINT =
  '【修复指引】此错误来自本地模型(LM Studio)的 Prompt Template 损坏,不是 BigBotArt 的问题:' +
  'Agent 的工具调用消息流渲染失败。请在 LM Studio 换用 lmstudio-community 的新版模型,' +
  '或在 My Models → 模型设置 → Prompt Template 覆盖为修复版模板(Ornith/Qwen3.5 系已知问题)。';

/** 给 LLM 返回错误追加可操作的修复指引(仅模板类错误;已注解的文本不重复追加) */
function annotateLlmError(raw: string): string {
  if (raw && LLM_TEMPLATE_ERR_RE.test(raw) && !raw.includes('【修复指引】')) {
    return `${raw}\n\n${LLM_TEMPLATE_HINT}`;
  }
  return raw;
}

function splitThink(raw: string): { text: string; thinking?: string } {
  const thinks: string[] = [];
  const cleaned = raw.replace(/<think>([\s\S]*?)(?:<\/think>|$)/g, (_m, inner: string) => {
    const t = inner.trim();
    if (t) thinks.push(t);
    return '';
  });
  return { text: cleaned.trim(), thinking: thinks.length > 0 ? thinks.join('\n\n') : undefined };
}

/**
 * ask.user 选项归一化:字符串 → {label};对象 → {label, sub?, recommended?}(协议扩展,见 tool-defs.ts ask.user)。
 * 容忍 LLM 把整个数组序列化成 JSON 字符串(真实事故:options 是 string 时 Array.isArray 失败 →
 * 漏拦截落到工具桥报「未知工具:ask.user」,模型连着重试烧轮次,recall 里的字符串 options 还把渲染层搞白屏)。
 */
function normalizeAskOptions(raw: unknown): AskOption[] {
  let list: unknown = raw;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((o): AskOption | null => {
      if (typeof o === 'string') {
        const label = o.trim();
        return label ? { label } : null;
      }
      if (o && typeof o === 'object') {
        const r = o as { label?: unknown; sub?: unknown; recommended?: unknown };
        const label = String(r.label ?? '').trim();
        if (!label) return null;
        const opt: AskOption = { label };
        const sub = String(r.sub ?? '').trim();
        if (sub) opt.sub = sub;
        if (r.recommended === true) opt.recommended = true;
        return opt;
      }
      return null;
    })
    .filter((o): o is AskOption => o !== null)
    .slice(0, 6);
}

export class PiChatSession {
  private planner = new PiPlanner();
  private abort: AbortController | null = null;
  private toolCallSeq = 0;
  /** 确认闸:挂起的敏感操作确认(用户点选后,下一轮 chat 用选项文本放行) */
  private pendingConfirm: { options: string[] } | null = null;
  /** worker → 主进程的工具调用回调(由 worker.ts 注入) */
  onToolCall: ((req: ToolCallRequest) => Promise<ToolCallResponse>) | null = null;

  /** 中止当前对话(真实打断) */
  cancel(): void {
    this.abort?.abort();
  }

  async chat(params: ChatParams): Promise<ChatResult> {
    const ep = this.planner['resolveEndpoint'](params.llm);
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const toolCalls: ChatResult['toolCalls'] = [];

    const model = {
      id: ep.modelId, name: ep.modelId, api: 'openai-completions' as const,
      provider: 'bigbotart-llm' as const, baseUrl: ep.baseUrl, reasoning: false,
      input: ['text'] as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000, maxTokens: 4000,
    };
    const provider = createProvider({
      id: 'bigbotart-llm', name: 'BigBotArt LLM', baseUrl: ep.baseUrl,
      auth: { apiKey: { name: 'BigBotArt LLM', resolve: async () => ({ auth: {} }) } },
      models: [model], api: openAICompletionsApi(),
    });
    const models = createModels();
    models.setProvider(provider);

    // 历史消息:pi-ai 的 AssistantMessage.content 必须是块数组(string 会触发 flatMap 错误)
    // 确认闸判定:上一轮挂起了敏感操作确认 → 本轮用户消息若是其中的确认类选项,放行敏感工具
    let sensitiveApproved = false;
    let userText = params.text;
    if (this.pendingConfirm) {
      const picked = this.pendingConfirm.options.find((o) => o === params.text.trim());
      if (picked && !NEGATIVE_RE.test(picked)) {
        sensitiveApproved = true;
        // 给模型一个明确授权信号,防止它再追问一轮
        userText = `${params.text}\n\n(系统:用户已在确认卡片中授权本次操作,请直接执行对应工具,不要再追问)`;
      }
      this.pendingConfirm = null;
    }
    const messages: Message[] = [
      ...params.context.messages.map((m) => {
        if (m.role === 'assistant') {
          return {
            role: 'assistant',
            content: [{ type: 'text', text: m.content }],
            timestamp: Date.now(),
          } as unknown as Message;
        }
        return { role: 'user', content: m.content, timestamp: Date.now() } as Message;
      }),
      { role: 'user', content: userText, timestamp: Date.now() } as Message,
    ];

    const tools = toolDefinitions() as never;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (signal.aborted) return { reply: '', toolCalls, aborted: true };
      const context: Context = { systemPrompt: params.context.systemPrompt, messages, tools };
      let assistant: AssistantMessage;
      try {
        assistant = await models.complete(models.getModel('bigbotart-llm', ep.modelId)!, context, {
          maxTokens: 4000,
          temperature: 0.4,
          apiKey: ep.apiKey ?? 'unused',
          signal,
        });
      } catch (e) {
        if (signal.aborted) return { reply: '', toolCalls, aborted: true };
        // LLM 请求失败(401/超时/不可达)必须向上抛,让主进程返回 {ok:false, error}
        // ——静默吞掉会让错误端点表现为"成功但空回复"
        throw e;
      }
      if (assistant.stopReason === 'aborted') return { reply: '', toolCalls, aborted: true };
      if (assistant.stopReason === 'error' || assistant.errorMessage) {
        throw new Error(`LLM 返回错误: ${annotateLlmError(assistant.errorMessage ?? assistant.stopReason)}`);
      }

      // 调试:记录本轮 LLM 返回结构
      const blocks = assistant.content ?? [];
      console.error(`[pi-chat] round=${round} stop=${assistant.stopReason} blocks=${blocks.map((b) => b.type).join(',')} err=${assistant.errorMessage ?? ''}`);

      // 收集本轮思考内容(thinking 块 + 漏进 text 的 <think> 段),供前端折叠展示
      const collectThinking = (): string | undefined => {
        const fromBlocks = blocks
          .filter((c) => c.type === 'thinking')
          .map((c) => ('thinking' in c ? c.thinking : ''))
          .join('')
          .trim();
        const fromText = splitThink(
          blocks
            .filter((c) => c.type === 'text')
            .map((c) => ('text' in c ? c.text : ''))
            .join(''),
        ).thinking;
        const all = [fromBlocks, fromText].filter(Boolean).join('\n\n').trim();
        return all || undefined;
      };

      // 收集本轮 toolCalls 并执行
      const calls = blocks.filter((c): c is ToolCall => c.type === 'toolCall');

      // 结构化提问拦截:ask.user → 暂停本轮,返回 {ask},等待用户在确认卡片选择后继续
      const askCall = calls.find((c) => c.name === 'ask.user');
      if (askCall) {
        const args = (askCall.arguments ?? {}) as { question?: string; options?: unknown };
        const question = String(args.question ?? '').trim() || '需要你确认一下';
        const options = normalizeAskOptions(args.options);
        if (options.length >= 2 && !signal.aborted) {
          const ask = { question, options };
          // 提问本身也作为一次"用户可见回复",便于渲染层只渲染卡片即可
          return { reply: question, thinking: collectThinking(), toolCalls, ask };
        }
        // options 不足 2 个 → 不当提问处理,继续当普通回复(防 Agent 滥用)
      }

      if (calls.length === 0) {
        // 无工具调用 → 最终回复;思考内容拆出单独字段(前端折叠展示,不混进正文)
        const thinking = collectThinking();
        const reply = splitThink(
          blocks
            .filter((c) => c.type === 'text')
            .map((c) => ('text' in c ? c.text : ''))
            .join(''),
        ).text;
        return { reply, thinking, toolCalls };
      }

      // 敏感操作确认闸(结构兜底):未授权时一个都不执行,改发 ask.user 确认卡
      // —— 防模型绕过 prompt 直接 delete/materialize/export/submit
      const sensitiveCalls = calls.filter((c) => SENSITIVE_TOOLS.has(c.name));
      if (sensitiveCalls.length > 0 && !sensitiveApproved && !signal.aborted) {
        const lines = sensitiveCalls.slice(0, 5).map((c) => describeAction(c.name, (c.arguments ?? {}) as Record<string, unknown>));
        const more = sensitiveCalls.length > 5 ? `\n- … 共 ${sensitiveCalls.length} 项` : '';
        const question = `即将执行 ${sensitiveCalls.length} 项不可轻易撤销的操作:${lines.map((l) => `\n- ${l}`).join('')}${more}\n\n确认继续吗?`;
        const confirmLabel = '确认执行';
        const cancelLabel = '先不执行';
        this.pendingConfirm = { options: [confirmLabel, cancelLabel] };
        const ask = {
          question,
          options: [
            { label: confirmLabel, sub: '按上述清单执行,产物变更/删除不可自动恢复' },
            { label: cancelLabel, sub: '不执行,返回继续讨论方案', recommended: true },
          ],
        };
        return { reply: question, thinking: collectThinking(), toolCalls, ask };
      }

      // 执行每个工具调用(反向 RPC 到主进程)
      messages.push(assistant);
      for (const call of calls) {
        const args = (call.arguments ?? {}) as Record<string, unknown>;
        const req: ToolCallRequest = {
          id: ++this.toolCallSeq,
          method: 'tool',
          params: {
            tool: call.name,
            args,
            projectId: params.projectId,
            canvasId: params.canvasId,
          },
        };
        let res: ToolCallResponse;
        if (this.onToolCall) {
          res = await this.onToolCall(req);
        } else {
          res = { id: req.id, error: { code: 'NO_BRIDGE', message: '工具桥未注入' } };
        }
        const tr = res.result ?? { ok: false, result: res.error?.message ?? '工具调用失败' };
        toolCalls.push({ name: call.name, args, ok: tr.ok, result: tr.result, nodeId: tr.nodeId });
        // toolResult 追加进 messages(OpenAI 协议)
        messages.push({
          role: 'toolResult' as const,
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: 'text' as const, text: tr.result }],
          isError: !tr.ok,
          timestamp: Date.now(),
        } as never);
      }
    }
    return { reply: '已达到最大工具调用轮数,请拆小任务继续。', toolCalls };
  }


}