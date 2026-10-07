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
 * 轮内心跳间隔(2026-09 补):等待 LLM 返回期间,每隔这么久向主进程报活一次。
 *
 * 动机:轮首心跳(见 onRound)之后,本轮剩余时间全花在推理上,期间零信号 ——
 * 本机 35B 模型一轮真实规模请求实测 78 秒,主进程看门狗只能盲等。取 15 秒:
 * 远小于看门狗默认值(600s),又不会把心跳刷得太密(每轮只多发几条 stdout 行)。
 */
const LLM_HEARTBEAT_MS = Number(process.env.BIGBOTART_AGENT_HEARTBEAT_MS ?? 15_000);

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
/**
 * 单轮输出预算(tokens)。
 *
 * 2026-09-28 由 12000 调大到 32000 —— **实测依据**:本机 LM Studio 上
 * `ornith-1.5-35b-a3b-abliterated-mlx` 的 `loaded_context_length = 262144`(256K),
 * 且实测 `max_tokens: 20000` / `32000` 均被接受(finish_reason=stop,无报错),空间充足。
 *
 * 为什么必须调大:原 12000 在「写带几千字提示词的节点参数」时会被烧光 ——
 * 本地推理模型带 thinking,思维链常占输出预算的一半以上;模型还倾向把 `data` 对象
 * **序列化成 JSON 字符串**(转义符放大输出量),两者叠加导致输出被腰斩:
 * 实测 JSON 在 552 字符处断成非法值,下一轮重试又截断,最终 0 工具调用 / 0 字回复。
 *
 * 可用 `BIGBOTART_AGENT_MAX_TOKENS` 覆盖(不同模型/端点上限不同)。
 */
const LLM_MAX_TOKENS = Number(process.env.BIGBOTART_AGENT_MAX_TOKENS ?? 32_000);

/** 声明给框架的模型上下文窗口(实际由端点决定;本地 35B 实测 256K) */
const LLM_CONTEXT_WINDOW = Number(process.env.BIGBOTART_AGENT_CONTEXT_WINDOW ?? 100_000);

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
 * 输出被 maxTokens 截断时的收尾文案(纯函数,便于单测)。
 *
 * 背景:`assistant.stopReason === 'length'` 表示模型输出达到 token 上限被腰斩。
 * 原实现对此**毫无处理** —— 若本轮没发出工具调用,就把 `reply`(可能为空)当作正常回复返回,
 * 用户看到静默的 0 字回复;若有半句话,则被当成完整交付。二者都是「假成功」。
 *
 * 分两种:
 *   - 无任何文本 → 完整解释 + 可执行建议(提示"一次写入太长"这个最常见原因);
 *   - 有部分文本 → 保留内容(模型确实说了话,不该丢),但**明确标注不完整**。
 */
export function composeTruncatedReply(reply: string): string {
  const body = reply.trim();
  if (!body) {
    return (
      '⚠️ 本轮输出被截断(模型输出达到 token 上限,未产生任何有效操作或回复)。\n' +
      '常见原因:一次要写入的内容太长(例如把几千字的提示词塞进单个 canvas.update_node 的 data 里)。\n' +
      '建议:把内容拆成多轮写入,或先写简短版本再逐步补充;也可减少单次任务涉及的节点数。'
    );
  }
  return `${reply}\n\n⚠️(以上回复被截断:模型输出达到 token 上限,内容可能不完整。)`;
}

/* ══ 「假成功」第三变体:承诺了动作却没发工具调用(2026-10-07 真实事故) ══
 *
 * 事故形态:用户说「生成」,模型回了「已提交生成,完成后画布会自动刷新。」——
 * 但**一个工具调用都没发**。三条独立证据:
 *   ① 真提交耗时 23.15s,这一轮 1.6s 就返回(连一次工具往返都不够);
 *   ② recall 里这条 assistant 前后**没有任何 tool 记录**;
 *   ③ takes.json 里没有对应 take(真提交哪怕失败也会先落一条 queued)。
 * 结果:节点 prompt 齐全、resultPath 空,用户以为在生成、实际什么都没发生。
 *
 * 与已有防护的关系(同一「假成功」家族的第 3 个变体,前两个已修):
 *   ① `stopReason === 'length'` → composeTruncatedReply(输出被腰斩);
 *   ② 批次1 的「假失败」→ 任务化 + 静默看门狗;
 *   ③ **本变体** → 模型正常说完一句话(stopReason === 'stop'),但话的内容是「我做了 X」,
 *      而 X 从没发生过。旧代码对此毫无校验,文本被原样当成交付返回。
 *
 * 为什么小模型特别容易触发:上一轮它以「要现在提交生成吗?」结尾,用户回一个裸的
 * 「生成」,模型被自己上一轮的问答模板带偏,直接续写「确认后」的答复话术,跳过执行。
 */

/**
 * 完成声明里的**动作动词**。这些动词是「执行了什么」而非「讨论什么」。
 */
const DONE_ACTION_RE =
  '(提交|生成|重跑|重新生成|重新提交|重提交|创建|新建|连接|删除|移除|导出|更新|修改|导入|上传|增强|裁切|拼接|拆分|放大|执行)';

/**
 * 动作完成声明:模型宣称**做完了**某件事。
 * 命中即代表这句话是「执行结果」而非「讨论/计划/提问」,必须有工具调用支撑。
 *
 * 两种句式(**必须同时覆盖**,少一个就会漏掉事故里的某次谎报):
 *   ① 「已提交…」= 副词 + 动词。最可靠的形态,几乎不会误伤。
 *   ② 「重提交 new24-ix8p(背视图)。」= 动词直接开头。事故里用户追问「没触发啊」时,
 *      模型正是这么答的 —— 「重提交」没有「已」字,只匹配①会漏掉这次谎报。
 *
 * ② 的误伤风险高得多,所以要求**动词后面紧跟具体宾语**(节点 id / 「任务」/「了」),
 * 而不是光看动词。反例(全是正常对话,绝不能拦):
 *   「生成背视图需要先有一张正面参考图」→ 动词后是「需要」,是说明不是声明;
 *   「删除节点是不可逆的」            → 后面在讲性质;
 *   「更新提示词后需要重新提交」       → 后面是「后需要」,是流程说明;
 *   「连接这两个节点即可」            → 指示性说法(「即可」),不是已完成。
 * 正例:「重提交 new24-ix8p」「生成完成」「创建了节点」。
 */
const DONE_CLAIM_RE = new RegExp(
  `(?:(已|刚刚|已经)${DONE_ACTION_RE})` + // ① 已提交 / 刚刚生成
    `|(?:^|[。!！,，;；\\s])${DONE_ACTION_RE}` + // ② 句首动词 …
    `(?=\\s*[a-zA-Z0-9_-]|\\s*(了|任务|完成|成功|好|完毕|节点|图片|视频|时间线))`, // … + 具体宾语
);

/**
 * 说明/指示语气:动词后面跟着这些词时是在**解释流程或讲性质**,不是宣称做完。
 * ② 句式尤其需要它兜底(「生成背视图**需要**…」「连接这两个节点**即可**」)。
 */
const EXPLANATORY_RE =
  /(需要|必须先|要先|是不可逆|无法撤销|即可|就可以|可以再|会生成|将会|之后|以后|的话|时,|时需|前需要)/;

/**
 * 「提交类」完成声明的窄匹配:仅在**已经真的提交成功过**时用于免检(见主循环注释)。
 * 只认提交/生成这两个动词,不沿用宽泛的 DONE_ACTION_RE —— 避免把「已删除节点 xxx」
 * 这类**尚未发生**的动作也一起放行。
 */
const DONE_SUBMIT_RE = /(提交|生成)/;

/** 征询/计划语气:出现这些说明是在问或准备做,不是在宣称做完 */
const INTERROGATIVE_RE = /(吗|呢|是否|要不要|需要我|是否要|可以吗|请确认|要我|建议|计划|打算|准备)\s*[?？]?/;

/** 否定/条件语气:「没法提交」「提交失败」「如果提交」都不算完成声明 */
const NEGATED_RE = /(失败|不成功|无法|没法|未能|没能|不能|出错|报错|取消|未提交|未生成|没有提交|还没)/;

/**
 * 判定「模型声称已完成某动作、但本轮没有任何工具调用支撑」。
 *
 * @param reply    本轮模型文本(已剥 thinking)
 * @param hadCalls 本轮是否真的执行过工具调用
 * @returns 命中时应重试/警示;返回 false 表示正常收尾
 */
export function isUnbackedCompletionClaim(reply: string, hadCalls: boolean): boolean {
  if (hadCalls) return false;
  const body = reply.trim();
  if (!body) return false;
  if (!DONE_CLAIM_RE.test(body)) return false;
  if (NEGATED_RE.test(body)) return false;
  // 说明/指示语气优先:「生成背视图需要先有参考图」「连接这两个节点即可」
  if (EXPLANATORY_RE.test(body)) return false;
  // 征询语气优先:整句里只要有问句特征就不当作完成声明(「已提交了吗?」这类)
  if (INTERROGATIVE_RE.test(body)) return false;
  return true;
}

/**
 * 承诺未兑现时的**纠正指令**:塞回对话让模型立即补上真正的工具调用。
 *
 * 要点(踩过的坑):
 *   · 必须**指名道姓**要它调 engine.submit —— 只说「请真正执行」模型会复述确认;
 *   · 必须点名它谎报的那句话,否则模型不知道自己错在哪;
 *   · 明确告知「不要重新提问、不要重新写提示词」—— 提示词上一轮已经写好了,
 *     让它再写一遍既浪费 token 又可能改坏内容。
 */
export function unbackedClaimNudge(reply: string): string {
  const quoted = reply.trim().slice(0, 120);
  return (
    `(系统)你刚才回复了「${quoted}」,但**本轮没有发出任何工具调用**,该动作并未真正发生。\n` +
    '禁止再声称已完成。请立即:① 若需要提交生成,直接调用 engine.submit(nodeId=…);' +
    '② 若需要改参数,直接调用 canvas.update_node。\n' +
    '不要重复提问、不要重新写提示词(上一轮已写好)、不要复述本提示。只发工具调用。'
  );
}

/**
 * 重试后仍然没有工具调用时的收尾文案:保留模型的话但**打上未执行标记**,
 * 绝不让它继续冒充成功。与 composeTruncatedReply 同口径。
 */
export function composeUnbackedClaimReply(reply: string): string {
  const body = reply.trim();
  const warn =
    '\n\n⚠️(以上动作**未实际执行**:模型声称已完成,但重试后仍未发出任何工具调用。' +
    '画布与队列都没有变化,请手动重试或换一种说法再让它执行一次。)';
  if (!body) {
    return '⚠️ 本轮模型声称已执行某操作,但**没有发出任何工具调用**,该操作并未发生。\n请重试,或直接说明要操作哪个节点。';
  }
  return `${reply}${warn}`;
}

/**
 * 组装喂给模型的工具结果文本。
 *
 * 关键:工具的**结构化 nodeId 必须拼进正文**。此前只喂 `result` 文本,模型拿不到新建
 * 节点的 id,只能拿标题硬猜(真实事故 2026-09-28:一次「反推提示词」共 18 次工具调用,
 * 其中 get_node 用 `人物参考图-1790509845606-00a2` 这类「标题-id」拼出的幻觉 id 直接 404,
 * 再绕道 assets.list 翻 47 项资产找真 id,白烧 4 个往返)。
 *
 * @param result 工具返回的人读摘要
 * @param nodeId 工具返回的结构化节点 id(有则拼进正文)
 * @param ok     工具是否成功(id 只在成功时才可信)
 */
export function buildToolResultText(result: string, nodeId?: string, ok = true): string {
  if (!nodeId || !ok) return result;
  return (
    `${result}\n\n[节点 id = ${nodeId}] ` +
    `后续以 id 为参数的工具(canvas.connect / canvas.get_node / vision.caption / engine.submit 等)` +
    `直接用这个值,不要用标题拼 id。`
  );
}

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
  /**
   * 每轮循环开始时的回调(批次1):worker 用它向主进程发心跳,让静默看门狗续期。
   * 覆盖「首轮 LLM 推理」这段没有任何工具活动的空窗期。
   */
  onRound: ((round: number) => void) | null = null;
  /**
   * 轮内心跳(2026-09 补):等待 LLM 返回期间的周期性报活。
   * 轮首心跳只标记「进入本轮」这一瞬间,而本轮真正耗时的是**推理本身** ——
   * 实测本机 35B 模型一轮真实规模请求 78 秒(极小请求也要 30 秒),这期间没有任何信号,
   * 看门狗只能干等。轮内定时心跳把最长无信号间隔压到 LLM_HEARTBEAT_MS。
   */
  onTick: ((round: number) => void) | null = null;

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
      contextWindow: LLM_CONTEXT_WINDOW, maxTokens: LLM_MAX_TOKENS,
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
    /**
     * 「承诺未兑现」已重试次数(见 isUnbackedCompletionClaim)。
     * 只给**一次**纠正机会:模型若在被明确点名后仍只说不做,再喂回去只会无限烧 token,
     * 此时改用 composeUnbackedClaimReply 打上未执行标记收尾 —— 宁可如实说失败,不要假成功。
     */
    let unbackedRetries = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (signal.aborted) return { reply: '', toolCalls, aborted: true };
      // 轮次心跳:主进程的静默看门狗据此续期。必须在**调用 LLM 之前**发 ——
      // 首轮推理可以长达 30-60 秒(本地 35B 模型),若只在工具调用时才报活,
      // 任务会在真正开始前就被看门狗误杀(实测踩过)。
      this.onRound?.(round);
      const context: Context = { systemPrompt: params.context.systemPrompt, messages, tools };
      let assistant: AssistantMessage;
      // 轮内心跳:推理期间定时报活(见 onTick 说明)。只包住 LLM 调用这一段 ——
      // 工具执行本身已由主进程的 tool 请求续期,不需要重复计时。
      const tick = this.onTick ? setInterval(() => this.onTick?.(round), LLM_HEARTBEAT_MS) : null;
      try {
        assistant = await models.complete(models.getModel('bigbotart-llm', ep.modelId)!, context, {
          // 输出预算:见 LLM_MAX_TOKENS(2026-09-28 由 12000 调大到 32000)
          maxTokens: LLM_MAX_TOKENS,
          temperature: 0.4,
          apiKey: ep.apiKey ?? 'unused',
          signal,
        });
      } catch (e) {
        if (signal.aborted) return { reply: '', toolCalls, aborted: true };
        // LLM 请求失败(401/超时/不可达)必须向上抛,让主进程返回 {ok:false, error}
        // ——静默吞掉会让错误端点表现为"成功但空回复"
        throw e;
      } finally {
        if (tick) clearInterval(tick);
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
        // 输出被 maxTokens 截断(assistant.stopReason === 'length')时**必须明确告知** ——
        // 否则会返回「reply 空 / 无工具调用」或「半句话」,被上层当作**正常完成**:
        // 用户看到静默的 0 字回复,或把腰斩的内容当成完整交付(真实事故 2026-09-28
        // 「将3d人物转化成真人」:第 2 轮写含几千字 prompt 的 data JSON 烧光 12000 token
        // → JSON 在 552 字符处断成非法值;第 3 轮重试时 thinking 又用尽 token,
        // 连工具调用都没发 → stop=length / blocks=thinking / 回复 0 字,整轮被判成功)。
        // 这是「假成功」,与批次1 修的「假失败」是同一类问题的镜像:都不能静默吞掉。
        if (assistant.stopReason === 'length') {
          return { reply: composeTruncatedReply(reply), thinking, toolCalls };
        }
        /* 「承诺未兑现」闸(2026-10-07 事故,见 isUnbackedCompletionClaim 顶部注释):
           stopReason 正常、话说得很完整,但内容是「已提交生成」而本轮**没有任何工具调用**。
           旧代码把这种文本原样当成功交付,用户以为在生成、实际画布与队列毫无变化。
           处理:给一次纠正机会把话塞回去;再犯就以「未执行」标记收尾,不再冒充成功。

           ⚠️ 判据是「本轮有没有调用」,不是「整轮对话累计有没有」——
           若用累计值,事故现场的「上一轮写了 prompt、这一轮谎称提交」会被放行。

           ⚠️ 但当**某个动作已经真的成功过**(submitted=已成功 engine.submit)时,
           后续轮次的「已提交生成 xxx」是对**既有事实的复述**(收尾致辞),不是谎报。
           真实回归:纠正成功后第 3 轮说「已提交生成 new24-ix8p。」本是正常收尾,
           若继续按「本轮无调用」判,会把一次**成功**提交污蔑成「未实际执行」——
           比原 bug 更糟(用户会去重复提交)。故已提交成功即对提交类声明免检。 */
        if (submitted && DONE_SUBMIT_RE.test(reply)) {
          return { reply, thinking, toolCalls };
        }
        if (isUnbackedCompletionClaim(reply, false)) {
          if (unbackedRetries < 1 && !signal.aborted) {
            unbackedRetries += 1;
            console.error('[pi-chat] 声称已完成但无工具调用,已回灌纠正指令重试一次');
            messages.push({
              role: 'user',
              content: unbackedClaimNudge(reply),
              timestamp: Date.now(),
            } as Message);
            continue;
          }
          console.error('[pi-chat] 承诺未兑现且重试后仍未调用工具,标记为未执行收尾');
          return { reply: composeUnbackedClaimReply(reply), thinking, toolCalls };
        }
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
        // 工具结果文本:结构化 nodeId 必须拼进正文(见 buildToolResultText 注释)。
        const resultText = buildToolResultText(tr.result, tr.nodeId, tr.ok);
        // toolResult 追加进 messages(OpenAI 协议)
        messages.push({
          role: 'toolResult' as const,
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: 'text' as const, text: resultText }],
          isError: !tr.ok,
          timestamp: Date.now(),
        } as never);
      }
    }
    return { reply: '已达到最大工具调用轮数,请拆小任务继续。', toolCalls };
  }


}