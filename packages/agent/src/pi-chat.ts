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
 * 轮询抑制闸(结构兜底,与 system prompt 的「提交即收尾」规则同口径)。
 *
 * 真实事故:用户说「连给 image-gen 的 ref-image」,模型建节点+连线+engine.submit 都做对了,
 * 但提交后开始反复轮询 engine.queue_status / canvas.get_node / canvas.list_nodes
 * 「看看图好了没有」——生成是分钟级后台任务,同步查询永远查不到结果,
 * 20 轮 MAX_TOOL_ROUNDS 被空转烧光,最终以「已达到最大工具调用轮数」收场,
 * 用户看到的是失败,实际任务已成功入队。
 *
 * 判定:engine.submit 成功后,本轮若继续调用「只读轮询类」工具(白名单见下)累计达阈值,
 * 直接判定为无效空转 → 强制结束本轮,并给出诚实的收尾话术(而不是「已达最大轮数」)。
 */
const POLL_TOOLS = new Set(['engine.queue_status', 'canvas.get_node', 'canvas.list_nodes']);
/** 提交成功后允许的只读轮询次数上限(超过即视为空转) */
const POST_SUBMIT_POLL_LIMIT = 2;
/** 强制收尾话术(submit 已成功,不能报成失败) */
const POLL_ABORT_REPLY = '已提交生成,任务正在后台排队渲染。完成后画布会自动刷新,无需等待——你可以先继续别的工作。';

/**
 * 空转轮询判定(纯函数,便于单测):
 * 已提交过生成,且本轮**全部**工具调用都是只读轮询类 → 计一次空转。
 * 只要有任意一个非轮询调用(如 create/connect/update),本轮视为有效工作,不计数。
 * @param submitted 本轮对话中是否已有成功的 engine.submit
 * @param callNames 本轮 LLM 请求的工具名
 */
export function isPollingRound(submitted: boolean, callNames: string[]): boolean {
  if (!submitted || callNames.length === 0) return false;
  return callNames.every((n) => POLL_TOOLS.has(n));
}

/** 累计空转次数是否已超阈值(超了就该强制收尾,而不是继续让 LLM 空转) */
export function isPollingExhausted(pollCount: number): boolean {
  return pollCount > POST_SUBMIT_POLL_LIMIT;
}

/** 强制收尾话术(导出供测试断言:提交成功的话术不能长成「已失败」) */
export const POLL_ABORT_MESSAGE = POLL_ABORT_REPLY;

/**
 * 敏感操作强制确认闸(结构兜底,与 memory.ts 的提问规则对应)。
 * 模型不守 prompt、用纯文本提问/直接执行时,由这里拦截:不执行,改发 ask.user 确认卡。
 * 用户点选确认后,授权签名粘滞(approvedSensitive),同操作本会话内不再二次拦截。
 *
 * ⚠️ 只拦「不可逆」操作:canvas.delete_node(Agent 侧删除不经过渲染层撤销栈,不可恢复)。
 * engine.submit / storyboard.materialize / timeline.export / create / connect 等均可回退或有产物留档,
 * 一律不拦——确认卡太多会把对话卡死在「确认 → 再确认」循环里(真实事故)。
 */
const SENSITIVE_TOOLS = new Set(['canvas.delete_node']);
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
  private pendingConfirm: { options: string[]; calls: Array<{ name: string; args: Record<string, unknown> }> } | null = null;
  /** 已授权的敏感操作签名(name+args):用户点过「确认执行」后,同一操作本会话内不再二次拦截。
   *  真实事故:授权只放行一轮,模型若在该轮复述确认问题而未重发工具调用,授权即失效,
   *  之后每次 engine.submit 都被确认闸拦回,陷入「确认执行 → 再确认」死循环。 */
  private approvedSensitive = new Set<string>();
  /** 上一次暂停待答的问题文本(确认闸/模型自己的 ask.user 都记录)。
   *  真实事故:确认卡「确认继续吗?」作为 assistant 消息留在上下文里,模型下一轮不复读工具调用
   *  而是复述同一个确认问题——用户点「确认执行」它再问一遍,永不执行(engine.submit 死循环)。
   *  判定:模型再发 ask.user 且问题与上次逐字相同 → 驳回并督促执行,不再暂停。 */
  private lastAskQuestion: string | null = null;
  /** worker → 主进程的工具调用回调(由 worker.ts 注入) */
  onToolCall: ((req: ToolCallRequest) => Promise<ToolCallResponse>) | null = null;

  /** 敏感操作签名:同名同参视为同一操作(重跑同节点同参数 = 用户已授权过的动作) */
  private static sensitiveSig(name: string, args: Record<string, unknown>): string {
    return `${name}:${JSON.stringify(args)}`;
  }

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
      contextWindow: 100_000, maxTokens: 12000,
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
        // 授权粘滞:这批操作的签名记入 approvedSensitive,之后同操作不再二次拦截
        for (const c of this.pendingConfirm.calls) {
          this.approvedSensitive.add(PiChatSession.sensitiveSig(c.name, c.args));
        }
        // 给模型明确授权信号 + 要执行的确切工具调用(只写「请直接执行」太泛,模型会复述确认问题再绕回确认闸)
        const callLines = this.pendingConfirm.calls
          .map((c) => `- ${c.name}(${JSON.stringify(c.args)})`)
          .join('\n');
        userText = `${params.text}\n\n(系统:用户已在确认卡片中授权,请立即逐条执行以下工具调用,不要再提问、不要再确认:\n${callLines})`;
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
        // system 动作记录(工具成功后的划线):pi-ai 无原生 system 消息,转成 user 角色并加标记,
        // 让模型明确这是"系统记录发生的事"而非用户新指令
        if (m.role === 'system') {
          return {
            role: 'user',
            content: `[系统记录] ${m.content}`,
            timestamp: Date.now(),
          } as unknown as Message;
        }
        return { role: 'user', content: m.content, timestamp: Date.now() } as Message;
      }),
      { role: 'user', content: userText, timestamp: Date.now() } as Message,
    ];

    const tools = toolDefinitions() as never;

    /** 本轮对话里是否已有成功的 engine.submit(提交成功即进入「收尾期」) */
    let submitted = false;
    /** 提交成功后的只读轮询累计次数(超过 POST_SUBMIT_POLL_LIMIT 即判定空转) */
    let postSubmitPolls = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (signal.aborted) return { reply: '', toolCalls, aborted: true };
      const context: Context = { systemPrompt: params.context.systemPrompt, messages, tools };
      let assistant: AssistantMessage;
      try {
        assistant = await models.complete(models.getModel('bigbotart-llm', ep.modelId)!, context, {
          // 输出预算:12000(2026-09 从 4000 调大)——本地推理型(带 thinking)模型做多节点规划
          // 时思维链会吃掉大量 output token,4000 常在发出工具调用前被 finish_reason=length 截断,
          // 表现为「思考半天后空回复」;配合工具说明的「大任务分步」双管齐下
          maxTokens: 12000,
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
      console.error(`[pi-chat] round=${round} calls=${calls.map((c) => c.name).join(',') || '(none)'}`);

      // 结构化提问拦截:ask.user → 暂停本轮,返回 {ask},等待用户在确认卡片选择后继续
      const askCall = calls.find((c) => c.name === 'ask.user');
      if (askCall) {
        const args = (askCall.arguments ?? {}) as { question?: string; options?: unknown };
        const question = String(args.question ?? '').trim() || '需要你确认一下';
        const options = normalizeAskOptions(args.options);
        if (options.length >= 2 && !signal.aborted) {
          // 逐字比对前先做空白归一化:模型复述确认问题时常有换行/空格微差
          const norm = (s: string) => s.replace(/\s+/g, '');
          if (this.lastAskQuestion && norm(this.lastAskQuestion) === norm(question)) {
            // 同一问题逐字重复(确认死循环特征)→ 不暂停:驳回这次提问,督促直接执行
            const approved = [...this.approvedSensitive];
            const nudge =
              '(系统)该问题用户刚刚已经回答过,禁止就同一事项重复提问/二次确认。' +
              (approved.length ? `已授权的操作:${approved.join('; ')}——请立即执行。` : '请直接执行相应工具,或给出最终回复。');
            messages.push(assistant);
            messages.push({
              role: 'toolResult' as const,
              toolCallId: askCall.id,
              toolName: 'ask.user',
              content: [{ type: 'text' as const, text: nudge }],
              isError: true,
              timestamp: Date.now(),
            } as never);
            continue;
          }
          this.lastAskQuestion = question;
          const ask = { question, options };
          // 提问本身也作为一次"用户可见回复",便于渲染层只渲染卡片即可
          return { reply: question, thinking: collectThinking(), toolCalls, ask };
        }
        // options 不足 2 个 → 不当提问处理,继续当普通回复(防 Agent 滥用)。
        // 但必须先把这次调用从 calls 里摘掉:ask.user 不是工具桥上的工具,交给桥只会得到
        // 「未知工具:ask.user」——旧版本正是这样把一条截断的 options 字符串变成了脏 recall
        // 记录(渲染层恢复时显示成 `ask.user({...` 的裸文本气泡,看着像调用失败)。
        // 摘掉后,若本轮只剩它,则走下面的 calls.length===0 分支,以模型自己的文本作为回复。
        const idx = calls.indexOf(askCall);
        if (idx >= 0) calls.splice(idx, 1);
        if (calls.length === 0) {
          // 模型想提问但没给出可用选项:退回它的文本回复(通常就是那句问句),让用户照常对话
          const t = splitThink(
            blocks.filter((c) => c.type === 'text').map((c) => ('text' in c ? c.text : '')).join(''),
          ).text;
          return { reply: t || question, thinking: collectThinking(), toolCalls };
        }
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

      // 轮询抑制闸:已提交生成后,若本轮全是只读轮询类工具调用 → 判定空转,直接收尾。
      // 只在「全部调用都是轮询工具」时触发,不误伤正常的「查一下再改」组合操作。
      if (isPollingRound(submitted, calls.map((c) => c.name))) {
        postSubmitPolls += 1;
        if (isPollingExhausted(postSubmitPolls)) {
          console.error(
            `[pi-chat] 提交后空转轮询 ${postSubmitPolls} 次(${calls.map((c) => c.name).join(',')}),强制收尾`,
          );
          return { reply: POLL_ABORT_REPLY, thinking: collectThinking(), toolCalls };
        }
      }

      // 敏感操作确认闸(结构兜底):未授权时一个都不执行,改发 ask.user 确认卡
      // —— 防模型绕过 prompt 直接 delete/materialize/export/submit
      // 已授权过的签名(用户点过「确认执行」的同 name+args 操作)直接放行,不再二次拦截
      const sensitiveCalls = calls.filter(
        (c) =>
          SENSITIVE_TOOLS.has(c.name) &&
          !this.approvedSensitive.has(
            PiChatSession.sensitiveSig(c.name, (c.arguments ?? {}) as Record<string, unknown>),
          ),
      );
      if (sensitiveCalls.length > 0 && !sensitiveApproved && !signal.aborted) {
        const lines = sensitiveCalls.slice(0, 5).map((c) => describeAction(c.name, (c.arguments ?? {}) as Record<string, unknown>));
        const more = sensitiveCalls.length > 5 ? `\n- … 共 ${sensitiveCalls.length} 项` : '';
        const question = `即将执行 ${sensitiveCalls.length} 项不可轻易撤销的操作:${lines.map((l) => `\n- ${l}`).join('')}${more}\n\n确认继续吗?`;
        const confirmLabel = '确认执行';
        const cancelLabel = '先不执行';
        this.pendingConfirm = {
          options: [confirmLabel, cancelLabel],
          calls: sensitiveCalls.map((c) => ({ name: c.name, args: (c.arguments ?? {}) as Record<string, unknown> })),
        };
        this.lastAskQuestion = question; // 确认卡问题也记入:模型复述它时按重复提问驳回
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
        // 提交成功 → 进入「收尾期」,后续只读轮询开始计数(见上方轮询抑制闸)
        if (call.name === 'engine.submit' && tr.ok) submitted = true;
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