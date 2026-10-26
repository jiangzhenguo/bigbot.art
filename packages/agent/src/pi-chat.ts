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
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import type { LlmSource, LlmProtocol, AskOption } from '@bigbotart/shared';
import { PLAN_APPROVE_LABEL, PLAN_REVISE_LABEL, withOpenCodeGoHeaders } from '@bigbotart/shared';
import type { ChatParams, ChatResult, ChatStreamEvent, ToolCallRequest, ToolCallResponse } from './protocol.js';
import { ThinkTagStreamParser } from './think-stream.js';
import { PiPlanner } from './pi-planner.js';
import { toolDefinitions } from '@bigbotart/shared';
import { fetchImageNeedsConfirm, userCorpusFromChat } from './web-gate.js';

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
 *
 * ⚠️ 「出」是 2026-10-09「测试1」事故补进来的:模型的原话是「我开始**出**分镜表」,
 * 而「出片/出图/出表/出分镜表」是本产品的高频动词(见 memory.ts 的 ask.user 规则、
 * 技能文档里的「出分镜表」)。少了它,承诺态闸对事故原话直接失配 —— 这正是单测
 * 「事故原话必须命中」锁住的回归。
 * 「铺」同理:storyboard.materialize 在本产品的说法是「**铺**节点/铺出来」(见 tool-defs 描述)。
 *
 * ⚠️⚠️ 「建 / 做 / 制作 / 搞 / 弄」是 2026-10-09「飞机」项目事故补的,教训很重要:
 * 我此前按**书面语**建表(「创建」「新建」),而模型说的是**口语**
 * —— 事故原话是「我**先建**苏青的角色卡」,单字「建」不在表里 → 承诺态闸失配 →
 * 零工具调用被当正常回复放行,任务停住。
 *
 * **同一个坑已经踩了三次**(出分镜表漏「出」、铺节点漏「铺」、建角色卡漏「建」),
 * 说明「动词白名单」这个方向天然不完备 —— 收录了书面语就漏口语,永远补不完。
 * 因此除了补词,另加一条**不依赖具体动词**的句式判据(见 PROMISE_STRUCTURE_RE),
 * 双保险。**新增动词时请务必同时给出口语变体。**
 */
const DONE_ACTION_RE =
  '(提交|生成|重跑|重新生成|重新提交|重提交|创建|新建|建|连接|连线|删除|移除|导出|更新|修改|导入|上传|增强|裁切|裁剪|拼接|拆|拆分|放大|执行|出|铺|做|制作|搞|弄|开始|继续|推进|落)';

/**
 * **不依赖动词表**的承诺句式判据(2026-10-09 补,治「动词表永远补不完」)。
 *
 * 结构:**第一人称 + 意愿副词 + (可选助词) + 任意动词性成分**
 *   - 主语:`我 / 我们`
 *   - 意愿副词:`先 / 来 / 马上 / 立刻 / 这就 / 现在 / 接下来 / 下一步 / 准备 / 会 / 将 / 开始`
 *   - 后面允许接**任意 1–6 个汉字**再跟一个宾语性成分(名词/量词)
 *
 * 为什么要这么宽:中文口语的动作说法无穷无尽(建/做/搞/弄/出/跑/拉/搭…),
 * 逐个收录必然遗漏。而这套句式的**语义**是稳定的:「我 + 意愿 + 动作」就是在宣布
 * 「我接下来要动手」—— 在没有工具调用支撑时,它就是空头承诺。
 *
 * ⚠️ 误伤是主要风险,故要求:
 *   ① 必须**第一人称开头**(「系统会生成」这类被动/第三方不算);
 *   ② 意愿副词后必须紧跟动词性内容(排除「我先说一句」「我的想法是」这类元话语);
 *   ③ 由调用方保证只在 `calls.length === 0`(本轮啥也没干)时使用。
 */
const PROMISE_STRUCTURE_RE =
  /(?:我|我们)\s*(?:先|来|马上|立刻|这就|现在|接下来|下一步|准备|会|将|开始|要)\s*(?:去|来|给|把)?\s*[\u4e00-\u9fa5]{1,6}(?:节点|图|表|卡|片|视频|角色|场景|镜头|文档|简报|大纲|分镜|素材|资产|连线|参数)/;

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

/* ══ 第六变体:把「已经问过的老问题」当纯文本复述出来(2026-10-09 「测试3」事故) ══
 *
 * 事故形态:
 *   14:25:33  assistant「2个美女在机翼上战斗——想走哪种动作风格?」+ **ask.user 卡片**(用户答了)
 *   14:27:09  用户「确认,推进故事大纲」
 *   14:27:11  assistant「2个美女在机翼上战斗——想走哪种动作风格?」 ← **逐字复述**,且**没有卡片**
 *   该轮工具调用数 = 0。
 *
 * 后果:界面上是一条**没有任何可点选项**的纯文本气泡 —— 用户无从回答,对话卡死。
 *
 * 为什么已有的防重闸没拦住:`pi-chat` 里那段「同一问题逐字重复 → 驳回」的判定
 * **写在 `if (askCall)` 分支内**,只有模型**再次调用 ask.user** 时才执行。
 * 这次模型压根没调工具,直接走 `calls.length === 0` 分支被当成正常回复返回了。
 *
 * 与前面几个变体的关系:都是「用正文代替了工具调用」这一家族,但这一支最隐蔽 ——
 * 前几个谎报的是**动作**(已提交/已创建),这一支复述的是**问题**,看起来像在正常对话。
 */

/** 空白归一化:模型复述问题时常有换行/空格微差(与 ask 分支内的判据同口径) */
function normQuestion(s: string): string {
  return s.replace(/\s+/g, '');
}

/**
 * 判定「本轮回复是**逐字复述**上一次已经问过、且用户已经回答过的问题」。
 *
 * 判据刻意严格(要求**逐字相同**),避免误伤:
 *   - 只有与 `lastAskQuestion` 逐字(去空白后)相同才算;
 *   - 用户后来提出的**新**问题(哪怕句式很像)不会命中,因为文本不同;
 *   - 模型正常的追问(补充条件、换角度)文本必然不同,不会被拦。
 *
 * @param reply 本轮回复文本
 * @param lastAsked 上一次通过 ask.user 问过的问题(无则 null)
 */
export function isRepeatedPlainTextQuestion(reply: string, lastAsked: string | null): boolean {
  if (!lastAsked) return false;
  const body = reply.trim();
  if (!body) return false;
  // 逐字相同(忽略空白差异)才算复述 —— 宁可漏判,不可误伤正常追问
  return normQuestion(body) === normQuestion(lastAsked);
}

/**
 * 复述老问题时的纠正指令:明确告诉模型「这个已经答过了」,并督促它推进下一步。
 *
 * 必须点名它复述的那句话 + 给出「去查一下当前状态再继续」的可执行指引 ——
 * 事故现场它其实只需要查一次节点就知道图已出好(见 memory.ts 的「例外」规则)。
 */
export function repeatedQuestionNudge(reply: string): string {
  const quoted = reply.trim().slice(0, 120);
  return (
    `(系统)你刚才回复了「${quoted}」—— 这个问题**用户已经回答过了**,不要重复提问。\n` +
    '请立即推进任务:① 先用 canvas.list_nodes / canvas.get_node 查一下当前画布状态' +
    '(尤其上一轮提交过的节点是否已有 resultPath);② 按技能流程做下一步;' +
    '③ 确需用户决策时,必须用 ask.user 工具提问(带 2 个以上选项),不要写成正文。\n' +
    '不要复述本提示,直接调用工具。'
  );
}

/**
 * 复述老问题、重试后仍未推进时的收尾文案:
 * 保留模型的话,但**明确标注这是重复提问、本轮未推进**,不让它看起来像正常对话。
 */
export function composeRepeatedQuestionReply(reply: string): string {
  const body = reply.trim();
  const warn =
    '\n\n⚠️(以上是**重复提问**:这个问题此前已经问过且用户已作答,模型又原样复述了一遍,' +
    '本轮没有推进任何操作。如果卡住了,可以直接告诉它「继续」并指明下一步。)' ;
  if (!body) {
    return '⚠️ 本轮模型重复了此前已问过的问题,没有推进任务。请再说一次「继续」,或直接指明下一步要做什么。';
  }
  return `${reply}${warn}`;
}

/* ══ 「假成功」第四变体:承诺了动作却没发工具调用(2026-10-09 真实事故) ══
 *
 * 事故形态(测试1 画布,技能 3d-animation-short):
 *   用户「2个美女在飞机机翼上打斗」→ 模型连问两轮 ask.user(风格、强度)→ 用户答完后,
 *   模型回「明白:**写实电影感 + 激烈打斗**——我开始出分镜表。」**本轮零工具调用**,对话到此结束。
 *   recall 里这条 assistant 前后没有任何 tool 记录,画布 nodes 始终为 []。
 *
 * 为什么第三变体的闸没拦住:第三变体认的是**完成态**措辞(「已提交」「创建了节点」),
 * 而这句话是**承诺态**(「我开始…」)——「我**开始**出分镜表」在语法上既不是「做完了」,
 * 也不含 DONE_ACTION_RE 的「已+动词」或「句首动词+宾语」形态,于是被当作正常收尾放行。
 *
 * 与第三变体的关系:两者是同一病灶的两副面孔 —— 都是「模型用正文代替了工具调用」,
 * 区别只在时态(完成态 vs 承诺态)。承诺态**比完成态更隐蔽**:用户看到「我开始出分镜表」
 * 会以为马上就有产出,实际上进程已经结束了。
 */

/**
 * 承诺态句式:模型宣称**即将/正在**执行某动作。
 *
 * 覆盖三种最常见形态(与 DONE_CLAIM_RE 互补,不重叠):
 *   ① 「我开始出分镜表」= 我 + 开始/先/马上/立刻/这就 + 动词;
 *   ② 「接下来我会生成…」「现在我来创建…」= 时间连接词 + 我 + 会/来/去 + 动词;
 *   ③ 「正在生成分镜表」= 正在 + 动词(进行态,同样代表还没发生)。
 *
 * ⚠️ 只匹配**第一人称主动承诺**。「请稍等,系统会生成」这类被动/第三方表述不拦
 * (那不是模型承诺自己要调工具)。
 */
const PROMISE_CLAIM_RE = new RegExp(
  // ① 我(们) + 开始/先/马上/立刻/这就/现在 + 可选「就/来/去/会/要」 + 动作
  //    ⚠️ 「就」必须单列:中文里「我现在就出分镜表」的「就」夹在时间副词与动作之间,
  //    只写 `现在` 直接接动作会失配(实测踩中)。
  `(?:我|我们)\\s*(?:开始|先|马上|立刻|这就|现在|准备)\\s*(?:就|来|去|会|要)?\\s*${DONE_ACTION_RE}` +
    // ② 接下来/然后/下一步 + 我(们) + 会/来/去/开始 + 动作
    `|(?:接下来|然后|下一步|下面)\\s*(?:我|我们)\\s*(?:会|来|去|将|开始|先)?\\s*${DONE_ACTION_RE}` +
    // ③ 正在 + 动作(进行态)
    `|正在${DONE_ACTION_RE}`,
);

/**
 * 判定「模型承诺要做某事、但本轮没有任何工具调用支撑」(承诺态)。
 *
 * 与 isUnbackedCompletionClaim(完成态)分开实现、**各自独立生效**:
 * 完成态的 EXPLANATORY_RE 白名单含「之后/以后/将会/会生成」等规划词,与承诺态语义天然冲突,
 * 混在一个函数里会让两边互相误伤。此处只做承诺态判定,并复用否定/征询两个兜底白名单。
 *
 * 反例(绝不能拦,全是正常对话):
 *   「生成背视图需要先有参考图」→ 无第一人称承诺结构;
 *   「接下来需要你确认风格」     → 「接下来」后是「需要你」,不是「我会+动作」;
 *   「我会生成 3 个方案供你选」  → 含「供你选」,征询语气,由 INTERROGATIVE_RE 放行。
 */
export function isUnbackedPromiseClaim(reply: string, hadCalls: boolean): boolean {
  if (hadCalls) return false;
  const body = reply.trim();
  if (!body) return false;
  /* 双判据(2026-10-09 补第二条):
     ① 动词白名单(PROMISE_CLAIM_RE)——精确,但**永远补不全**(中文口语说法太多);
     ② 句式结构(PROMISE_STRUCTURE_RE)——「第一人称 + 意愿副词 + 动作 + 宾语」,
        不依赖具体动词,兜住白名单漏掉的写法(事故原话「我先建苏青的角色卡」正是漏网者)。
     任一命中即视为承诺。 */
  if (!PROMISE_CLAIM_RE.test(body) && !PROMISE_STRUCTURE_RE.test(body)) return false;
  if (NEGATED_RE.test(body)) return false;
  if (INTERROGATIVE_RE.test(body)) return false;
  // 说明/指示语气兜底:「我先把节点建好,然后才能提交」是在讲步骤,不是在承诺本次执行
  if (/(才能|之后才|以后才|需要先)/.test(body)) return false;
  return true;
}

/**
 * 承诺未兑现时的纠正指令(承诺态专用)。
 *
 * 与 unbackedClaimNudge 的区别:那句针对「谎报已完成」,要求它**别再说了、去执行**;
 * 这句针对「说了要做、但没做」,语气是**催促兑现**——模型没撒谎,只是把「宣布」当成了「完成」。
 * 同样必须指名道姓给出工具名,否则模型会再复述一遍承诺。
 */
export function unbackedPromiseNudge(reply: string): string {
  const quoted = reply.trim().slice(0, 120);
  return (
    `(系统)你刚才回复了「${quoted}」,但**本轮没有发出任何工具调用**,该动作并未真正发生。\n` +
    '「宣布要做什么」不等于「做了」——请立即**真的调用工具**把它做掉:\n' +
    '① 要出分镜表 → 直接调用 storyboard.plan(brief=…);\n' +
    '② 要铺节点 → 直接调用 storyboard.materialize(nodeId=…) 或 canvas.create_node / canvas.connect;\n' +
    '③ 要出片 → 直接调用 engine.submit(nodeId=…)。\n' +
    '不要承诺、不要复述本提示、不要再向用户确认(参数已够就直接干)。只发工具调用。'
  );
}

/**
 * 承诺未兑现、重试后仍无工具调用时的收尾文案(承诺态专用):
 * 保留模型的话,但**明确标注未执行** —— 用户必须知道「我开始出分镜表」之后其实什么都没发生。
 */
export function composeUnbackedPromiseReply(reply: string): string {
  const body = reply.trim();
  const warn =
    '\n\n⚠️(以上动作**未实际执行**:模型只表示「即将执行」,但重试后仍未发出任何工具调用。' +
    '画布没有任何变化,请再发一次指令或直接说「现在执行」。)';
  if (!body) {
    return '⚠️ 本轮模型表示即将执行某操作,但**没有发出任何工具调用**,该操作**未实际执行**。\n请重试,或直接说明要操作哪个节点。';
  }
  return `${reply}${warn}`;
}

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
 * 「调了工具、工具失败、却宣布成功」的判定(纯函数,便于单测)。
 *
 * 与前面三个闸的区别(第五变体,2026-10-09 事故):
 *   ① 截断闸  → 输出被腰斩;
 *   ② 完成态闸 → **本轮零工具调用**却宣称做完了;
 *   ③ 承诺态闸 → **本轮零工具调用**却宣布要做;
 *   ④ **本闸** → 本轮**真的调了工具**,但工具**明确失败**,模型却宣布成功。
 *
 * 为什么前三个闸都拦不住:它们的判据都是 `hadCalls === false`(本轮没调用)。
 * 这次事故里模型**调了** `storyboard.materialize`(只是传了个幻觉 id 导致失败),
 * 于是三个闸全部放行,模型回「12 个 shot 已铺出」骗过用户 —— 画布上其实一个 shot 都没有。
 *
 * 判据:本轮**有工具失败** + 回复是完成/承诺声明。
 *   - 有失败 → 必须给出「失败也要如实说」的纠正,不允许宣布成功;
 *   - 无失败 → 与本闸无关(前面三个闸照常工作)。
 *
 * ⚠️ 只看**本轮**的失败,不看历史累计:历史里的失败早就该被处理掉了,
 * 拿累计值会把「上一轮失败、这一轮老老实实汇报完成」的正常收尾也误伤。
 *
 * @param reply      本轮模型文本(已剥 thinking)
 * @param failedTools 本轮**明确失败**的工具名(成功的不计入)
 */
export function isFalseSuccessAfterFailure(reply: string, failedTools: string[]): boolean {
  if (failedTools.length === 0) return false;
  const body = reply.trim();
  if (!body) return false;
  // 否定语气优先:模型如果老实说了失败,不拦(「materialize 失败了,我改用…」)
  if (NEGATED_RE.test(body)) return false;
  // 征询语气优先:在问用户怎么办,不是宣布成功
  if (INTERROGATIVE_RE.test(body)) return false;
  // 完成态或承诺态任一命中即视为「宣布成功」
  return DONE_CLAIM_RE.test(body) || PROMISE_CLAIM_RE.test(body);
}

/**
 * 工具失败却宣布成功时的纠正指令。
 *
 * 要点:必须**逐条点名失败的工具与真实报错** —— 只说「你失败了」模型不知道该改什么;
 * 这次事故的关键就是模型没有去读工具返回的那句「节点 xxx 不存在」。
 */
export function falseSuccessNudge(reply: string, failed: Array<{ name: string; result: string }>): string {
  const quoted = reply.trim().slice(0, 100);
  const detail = failed
    .slice(0, 3)
    .map((f) => `- ${f.name} 失败:${f.result.slice(0, 200)}`)
    .join('\n');
  return (
    `(系统)你刚才回复了「${quoted}」,但**本轮有工具调用失败了**,该操作并未成功:\n${detail}\n` +
    '禁止把失败报成成功。请立即:① 按上面的报错修正参数并**重新调用**该工具(报错里若有可用 id/候选,直接用它们;' +
    '不确定就先 canvas.list_nodes 现拉最新列表,**不要凭记忆拼 id**);' +
    '② 若确实修不好,如实告诉用户失败原因与下一步建议。\n' +
    '不要复述本提示、不要再宣布完成。'
  );
}

/**
 * 重试后仍然「工具失败却报成功」时的收尾文案:
 * 保留模型的话,但**明确标注因工具失败而未执行**,绝不让它冒充成功。
 */
export function composeFalseSuccessReply(reply: string, failed: Array<{ name: string; result: string }>): string {
  const names = [...new Set(failed.map((f) => f.name))].join('、');
  const detail = failed
    .slice(0, 3)
    .map((f) => `  · ${f.name}:${f.result.slice(0, 160)}`)
    .join('\n');
  const warn =
    `\n\n⚠️(以上动作**未成功执行**:工具 ${names} 返回了失败,` +
    '模型却把它报告成了已完成。真实报错:\n' +
    `${detail}\n画布与队列没有相应变化,请修正参数后重试。)`;
  const body = reply.trim();
  if (!body) {
    return `⚠️ 本轮工具 ${names} 执行失败,但模型没有报告失败。\n真实报错:\n${detail}\n请修正后重试。`;
  }
  return `${reply}${warn}`;
}

/* ══ 第七变体:用正文提问,而不是 ask.user(2026-10-09 「飞机」项目事故)══
 *
 * 事故链(两轮,第一轮埋雷、第二轮爆雷):
 *   15:21:54  assistant「故事大纲已落画布…」结尾写「**请选下一步:**」
 *             ← 问句,但**没有 ask.user 卡片**(该轮工具只有 list_nodes / create_node)
 *   15:22:58  用户「继续」
 *   15:23:02  assistant「进入角色卡阶段。先建苏青的角色卡…我先建苏青的角色卡」
 *             ← **工具调用数 = 0**,画布上至今没有任何角色卡
 *
 * **因果关系是决定性的**:模型上一轮用正文问了「请选下一步」,于是把用户随后的
 * 「继续」理解成**对那个问题的回答** → 进入「交代我接下来要做什么」的**说明模式**,
 * 而不是「动手做」的**执行模式**。
 *
 * 实测相关性 100%(同一个项目 5 轮):
 *   - 用户输入前有 ask.user 卡片 → 本轮**都调了工具**(4/4)
 *   - 用户输入前没有卡片(裸「继续」)→ 本轮**零调用**(1/1)
 *
 * 为什么它能溜过去:`ask.user` 规范只写在 system prompt 里(「禁止把问句写成正文」),
 * 而**纯文本问句不被任何闸检查** —— `lastAskQuestion` 只在真的调 ask.user 时才更新,
 * 所以「复述老问题」闸也抓不到(压根没有"老问题"被记录)。
 *
 * 修法:在回复里检测「**在要求用户做决定**」的句式,若本轮又没调 ask.user → 驳回,
 * 强制它改用工具。堵住源头,下一轮才不会把用户的回答误读成对话。
 */

/** 明确的「请用户做决定」措辞(命中即视为在征询) */
const ASK_PROMPT_RE =
  /(请选|请选择|请您选|选一个|选哪个|要怎么走|接下来怎么走|怎么走|要不要|是否要|是否需要我|需要我|要我|是否继续|确认吗|可以吗|好吗|行吗|请您确认|请确认|取决于你|给我个方向|你决定|您决定)/;

/**
 * 判定「本轮在**用正文要求用户做决定**」,而这本该走 ask.user 工具。
 *
 * ⚠️ 判据必须**窄**(踩过坑):第一版把「以问号结尾」也算作征询,结果
 * 「你好,有什么可以帮你?」「提示词已写好,要现在提交生成吗?」这些**完全正常**的
 * 收尾全被拦下重试 —— 3 个既有集成用例当场被打破。宁可漏判,不可误伤正常对话。
 *
 * 现在的判据(必须**同时**满足):
 *   ① 出现明确的**决策征询措辞**(ASK_PROMPT_RE:请选/要不要/是否需要我/请确认…)
 *      —— 单纯一个问号不算(「有什么可以帮你?」是寒暄,不是要用户拍板);
 *   ② 结尾（最后 40 字内）确实是**收在问题上** —— 要么有问号,要么以「:」「：」收束
 *      （事故原话正是「请选下一步:」，冒号结尾、没有问号）。
 *
 * 排除项:
 *   - 复述用户的话（「你说/你问…」）→ 放行；
 *   - 空回复 → 不判。
 *
 * @param reply 本轮回复文本
 */
export function isPlainTextAsk(reply: string): boolean {
  const body = reply.trim();
  if (!body) return false;
  // 复述用户的话 → 不当作提问(「你问的『要不要加对白』我先答一句…」)
  if (/(?:你说|您说|你问|您问|你的问题|您的问题)/.test(body)) return false;
  if (!ASK_PROMPT_RE.test(body)) return false;
  // 必须收在问题上:结尾 40 字内出现问号,或整段以冒号收束（「请选下一步:」）
  const tail = body.slice(-40);
  return /[?？]/.test(tail) || /[:：]\s*$/.test(body);
}

/**
 * 「该用 ask.user 却写成正文」时的纠正指令。
 *
 * 要点:不仅要它改用工具,还要**说明后果** —— 正文提问会让下一轮的「继续」被误读成
 * 对问题的回答,整条流水线就此断掉(这正是事故的传导机制)。
 * 同时给它一条出路:如果其实不需要用户拍板,就直接干活,别用问句收尾。
 */
export function plainTextAskNudge(reply: string): string {
  const quoted = reply.trim().slice(-80);
  return (
    `(系统)你刚才的回复结尾是「…${quoted}」,这是在**用正文向用户提问**,违反了【提问规则】:\n` +
    '① 若你确实需要用户在**多个选项中做决定** → 立即调用 `ask.user`(带 question + 至少 2 个 options),不要写成正文;\n' +
    '② 若其实不需要用户拍板(下一步该做什么已经明确) → **直接调用工具把它做掉**,不要用问句收尾。\n' +
    '⚠️ 为什么必须改:正文提问不会生成可点选的卡片,用户只能自己打字;而下一轮你的\n' +
    '「继续」会被你理解成对该问题的回答,于是只顾着说明计划、**一个工具都不调**,任务就此停住。\n' +
    '不要复述本提示,直接调用工具。'
  );
}

/**
 * 重试后仍在用正文提问时的收尾文案:保留它的话,但**补一张明确的「这是提问、不是交付」标注**,
 * 并显式提醒用户可以用「执行」类指令推动它动手。
 */
export function composePlainTextAskReply(reply: string): string {
  const body = reply.trim();
  const warn =
    '\n\n⚠️(以上是**纯文本提问**,模型没有使用确认卡片。如需继续,建议直接下**执行指令**' +
    '(例如「直接建角色卡并提交」),而不是只说「继续」——否则它可能把「继续」当成对上面问题的回答,' +
    '只说明计划而不实际动手。)';
  if (!body) {
    return '⚠️ 本轮模型想向你提问,但没有使用确认卡片,也没有执行任何操作。请直接下执行指令推动它。';
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
/** 多镜计划确认卡。选项固定,不让模型自己编「批准」文案。 */
export function planReviewAsk(markdown: string): { question: string; options: AskOption[] } {
  return {
    question: markdown,
    options: [
      { label: PLAN_APPROVE_LABEL, sub: '允许提交计划覆盖的未出片镜头', recommended: true },
      { label: PLAN_REVISE_LABEL, sub: '先不跑,改完计划再确认' },
    ],
  };
}

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
    case 'web.fetch_image': {
      const url = String(args.url ?? '').trim();
      try {
        const u = new URL(url);
        return `下载图片 ${`${u.host}${u.pathname}`.slice(0, 80)}`;
      } catch {
        return `下载图片 ${url.slice(0, 80)}`;
      }
    }
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

/**
 * 工具名净化(Kimi coding 等端点,2026-10-10「kimi-coding 对话 400」事故):
 * 这类端点只接受 [a-zA-Z0-9_-] 的 function 名,含 '.' 直接报
 * 400「function name is invalid, must start with a letter and can contain
 * letters, numbers, underscores, and dashes」—— 而本项目工具名全是「域.动作」
 * 格式(canvas.list_nodes / engine.submit)。
 * 处理:**首次撞上该错误时**,本会话把工具定义切换成短横线别名(canvas-list_nodes)
 * 并重试本轮;模型回传的调用名再映射还原供闸判/工具桥使用。历史里的 assistant 块
 * 保持别名原样不动(协议一致性:声明用什么名,调用与 toolResult 就用什么名,
 * 否则第二轮请求又会因历史里的点号名被 400)。
 * 全部工具名均为单点号且无短横线(tool-name-sanitize 测试锁定),映射可逆。
 * 切换只会实际发生在第 0 轮:任何一轮成功都说明端点接受了当时的工具名。
 *
 * 错误文案有多个变种,全部要接住(漏一个就是「每轮对话都 400」的硬故障):
 *  - Kimi coding:「function name is invalid, must start with a letter…」
 *  - DeepSeek 系(OpenCode Go 实测 2026-10-20):
 *    「Invalid 'tools[0].function.name': string does not match pattern.
 *      Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'」
 *    这条上游把 OpenAPI 的 schema 校验原话透出来了,不含 "invalid function name" 字样。
 */
export const FUNC_NAME_INVALID_RE =
  /function name is invalid|invalid function name|function\.name[^\n]*?(does not match pattern|matches the pattern)/i;

/**
 * 端点声明「该模型不支持这套协议」(OpenCode Go:grok-4.6 只开 /v1/responses,
 * 2026-10-20 实测 400 `{"type":"ModelProtocolUnsupported","message":"Model does not support this protocol."}`;
 * 部分网关还会回 404 unknown endpoint)。
 * 撞上即换另一套协议重试本轮 —— 与工具名净化 / temperature 降级同一手法,
 * 这样自建端点或官方后续迁移模型协议都不需要用户去改配置。
 */
export const PROTOCOL_UNSUPPORTED_RE =
  /ModelProtocolUnsupported|does not support this protocol|unsupported (?:api|protocol)|unknown (?:endpoint|url)/i;

/**
 * 端点拒绝自定义 temperature 的错误特征(Kimi k3,2026-10-10 实测:
 * 400「invalid temperature: only 1 is allowed for this model」)。
 * 撞上即本会话改走端点默认(不下发 temperature 字段)重试,与工具名净化同一手法。
 */
const TEMPERATURE_INVALID_RE = /invalid temperature|temperature.*only .*allowed/i;

/** 内部名 → 端点别名('.' → '-') */
export const sanitizeToolName = (name: string): string => name.replace(/\./g, '-');
/** 端点别名 → 内部名(首个 '-' → '.';无 '-' 原样返回,幂等) */
export const desanitizeToolName = (name: string): string => name.replace('-', '.');

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

  async chat(params: ChatParams, onStream?: (event: ChatStreamEvent) => void): Promise<ChatResult> {
    const ep = this.planner['resolveEndpoint'](params.llm);
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const toolCalls: ChatResult['toolCalls'] = [];

    /**
     * 对话协议(chat = /v1/chat/completions,responses = /v1/responses)。
     * pi-ai 把两套报文的差异归一化在 api 实现里:上层 Context/AssistantMessage/工具调用
     * 形状完全一致,所以切换协议只是换 api 实现 + model.api,不动消息构造与工具桥。
     */
    let protocol: LlmProtocol = ep.protocol ?? 'chat';
    /** 换错方向不反复翻:已试过的协议记下来,另一套也不认就如实抛错 */
    const triedProtocols = new Set<LlmProtocol>([protocol]);
    const buildModels = () => {
      const model = {
        id: ep.modelId, name: ep.modelId,
        api: (protocol === 'responses' ? 'openai-responses' : 'openai-completions') as string,
        provider: 'bigbotart-llm' as const, baseUrl: ep.baseUrl, reasoning: false,
        input: ['text'] as ('text' | 'image')[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: params.contextWindow && params.contextWindow > 0 ? params.contextWindow : LLM_CONTEXT_WINDOW, maxTokens: LLM_MAX_TOKENS,
      };
      const provider = createProvider({
        id: 'bigbotart-llm', name: 'BigBotArt LLM', baseUrl: ep.baseUrl,
        auth: { apiKey: { name: 'BigBotArt LLM', resolve: async () => ({ auth: {} }) } },
        models: [model],
        api: protocol === 'responses' ? openAIResponsesApi() : openAICompletionsApi(),
      });
      const m = createModels();
      m.setProvider(provider);
      return m;
    };
    let models = buildModels();

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
    // 图片下载确认只认用户原文(本轮 + 历史 user),不认系统记录里回放的搜索链接
    const imageAuthCorpus = userCorpusFromChat(params.text, params.context.messages);
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

    /** 端点拒绝点号工具名时置 true,工具定义改用短横线别名(见 sanitizeToolName 注释) */
    let sanitizeNames = false;
    /** 端点拒绝自定义 temperature 时置 true,之后不再下发该字段(见 TEMPERATURE_INVALID_RE) */
    let dropTemperature = false;
    const buildTools = (): unknown[] => {
      const defs = toolDefinitions();
      return sanitizeNames ? defs.map((t) => ({ ...t, name: sanitizeToolName(t.name) })) : defs;
    };
    let tools = buildTools() as never;

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
    /**
     * 「工具失败却宣布成功」已重试次数(见 isFalseSuccessAfterFailure,第五变体)。
     * 同样只给一次纠正机会。
     */
    let falseSuccessRetries = 0;
    /**
     * 本轮**明确失败**的工具(name + 真实报错),供下一轮的假成功判定用。
     *
     * 为什么必须跨轮携带:模型的调用与它的回复在**同一轮 LLM 输出**里
     * (toolCalls 与 text 一起返回),所以「调了工具→工具失败→宣布成功」这句话
     * 是在**下一轮**才产生的。判定必须在下一轮开始时能拿到上一轮的失败清单。
     * 每轮开头清空,保证只看最近一轮的失败(见 isFalseSuccessAfterFailure 注释)。
     */
    let lastRoundFailures: Array<{ name: string; result: string }> = [];
    /** 「了复述老问题」已重试次数(第六变体,见 isRepeatedPlainTextQuestion) */
    let repeatedQuestionRetries = 0;
    /** 「用正文提问」已重试次数(第七变体,见 isPlainTextAsk) */
    let plainTextAskRetries = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (signal.aborted) return { reply: '', toolCalls, aborted: true };
      // 轮次心跳:主进程的静默看门狗据此续期。必须在**调用 LLM 之前**发 ——
      // 首轮推理可以长达 30-60 秒(本地 35B 模型),若只在工具调用时才报活,
      // 任务会在真正开始前就被看门狗误杀(实测踩过)。
      this.onRound?.(round);
      // 新一轮/纠错重试共用一个界面草稿:round-start 让渲染层清空上一段未收尾文本。
      onStream?.({ kind: 'round-start', round });
      const context: Context = { systemPrompt: params.context.systemPrompt, messages, tools };
      let assistant: AssistantMessage;
      // 轮内心跳:推理期间定时报活(见 onTick 说明)。只包住 LLM 调用这一段 ——
      // 工具执行本身已由主进程的 tool 请求续期,不需要重复计时。
      const tick = this.onTick ? setInterval(() => this.onTick?.(round), LLM_HEARTBEAT_MS) : null;
      try {
        const llmOptions = {
          // 输出预算:见 LLM_MAX_TOKENS(2026-09-28 由 12000 调大到 32000)
          maxTokens: LLM_MAX_TOKENS,
          // Kimi k3 等端点只允许 temperature=1:撞上后不再下发该字段(走端点默认)
          ...(dropTemperature ? {} : { temperature: 0.4 }),
          apiKey: ep.apiKey ?? 'unused',
          signal,
          // OpenCode Go 强制 x-opencode-session(缺则 400 MissingSessionID);canvasId 作会话稳定 id
          headers: withOpenCodeGoHeaders(ep.baseUrl, params.canvasId),
        };
        const model = models.getModel('bigbotart-llm', ep.modelId)!;
        if (onStream && typeof models.stream === 'function') {
          // pi-ai 的 complete() 本身就是 stream().result();这里改为显式消费同一流,
          // 把增量送到 UI,同时仍以最终 AssistantMessage 跑工具与所有诚实性闸门。
          const stream = models.stream(model, context, llmOptions);
          const textParsers = new Map<number, ThinkTagStreamParser>();
          const emit = (channel: 'text' | 'thinking', contentIndex: number, delta: string) => {
            if (delta) onStream({ kind: channel === 'text' ? 'text-delta' : 'thinking-delta', round, contentIndex, delta });
          };
          const flushText = (contentIndex: number) => {
            const parser = textParsers.get(contentIndex);
            if (!parser) return;
            for (const part of parser.flush()) emit(part.channel, contentIndex, part.delta);
            textParsers.delete(contentIndex);
          };
          for await (const event of stream) {
            // abort 后仍把流 drain 到 result(),但不再把缓冲里的旧 token 推回界面。
            if (signal.aborted) continue;
            if (event.type === 'text_delta') {
              let parser = textParsers.get(event.contentIndex);
              if (!parser) {
                parser = new ThinkTagStreamParser();
                textParsers.set(event.contentIndex, parser);
              }
              for (const part of parser.push(event.delta)) emit(part.channel, event.contentIndex, part.delta);
            } else if (event.type === 'thinking_delta') {
              emit('thinking', event.contentIndex, event.delta);
            } else if (event.type === 'text_end') {
              flushText(event.contentIndex);
            }
          }
          assistant = await stream.result();
          // 流异常/协议降级时不补发 parser 里的半个标签或失败 attempt 残余;
          // 正常但未闭合的 <think> 仍按 splitThink 口径 flush 到思考区。
          if (!signal.aborted && assistant.stopReason !== 'error' && !assistant.errorMessage) {
            for (const contentIndex of [...textParsers.keys()]) flushText(contentIndex);
          }
        } else {
          // 无监听器/旧测试替身的兼容路径;真实 worker 总是走上面的流式分支。
          assistant = await models.complete(model, context, llmOptions);
        }
      } catch (e) {
        if (signal.aborted) return { reply: '', toolCalls, aborted: true };
        // 端点拒绝含点号的 function 名(抛异常形态)→ 切换短横线别名重试本轮
        if (!sanitizeNames && FUNC_NAME_INVALID_RE.test(e instanceof Error ? e.message : String(e))) {
          sanitizeNames = true;
          tools = buildTools() as never;
          console.error('[pi-chat] 端点拒绝含点号的工具名,已切换短横线别名重试');
          round--;
          continue;
        }
        // 端点拒绝自定义 temperature(抛异常形态)→ 不再下发该字段重试本轮
        if (!dropTemperature && TEMPERATURE_INVALID_RE.test(e instanceof Error ? e.message : String(e))) {
          dropTemperature = true;
          console.error('[pi-chat] 端点不接受自定义 temperature,已改走端点默认重试');
          round--;
          continue;
        }
        // 端点不支持当前协议(抛异常形态)→ 换另一套协议重试本轮(见 PROTOCOL_UNSUPPORTED_RE)
        const thrownMsg = e instanceof Error ? e.message : String(e);
        if (PROTOCOL_UNSUPPORTED_RE.test(thrownMsg)) {
          const other: LlmProtocol = protocol === 'responses' ? 'chat' : 'responses';
          if (!triedProtocols.has(other)) {
            triedProtocols.add(other);
            protocol = other;
            models = buildModels();
            console.error(`[pi-chat] 端点不支持当前协议,已切换 ${protocol} 协议重试`);
            round--;
            continue;
          }
        }
        // LLM 请求失败(401/超时/不可达)必须向上抛,让主进程返回 {ok:false, error}
        // ——静默吞掉会让错误端点表现为"成功但空回复"
        throw e;
      } finally {
        if (tick) clearInterval(tick);
      }
      // 取消可能与流完成同时发生:即使 provider 已给 stop,也不能再进入工具处理。
      if (signal.aborted) return { reply: '', toolCalls, aborted: true };
      if (assistant.stopReason === 'aborted') return { reply: '', toolCalls, aborted: true };
      if (assistant.stopReason === 'error' || assistant.errorMessage) {
        const errMsg = assistant.errorMessage ?? String(assistant.stopReason);
        // 端点拒绝含点号的 function 名(stopReason=error 形态,实测 Kimi coding 走这条)→
        // 切换短横线别名重试本轮。此刻 assistant 块尚未入 history,切换无协议不一致风险。
        if (!sanitizeNames && FUNC_NAME_INVALID_RE.test(errMsg)) {
          sanitizeNames = true;
          tools = buildTools() as never;
          console.error('[pi-chat] 端点拒绝含点号的工具名,已切换短横线别名重试');
          round--;
          continue;
        }
        // 端点拒绝自定义 temperature(stopReason=error 形态,实测 Kimi k3 走这条)→
        // 不再下发该字段重试本轮
        if (!dropTemperature && TEMPERATURE_INVALID_RE.test(errMsg)) {
          dropTemperature = true;
          console.error('[pi-chat] 端点不接受自定义 temperature,已改走端点默认重试');
          round--;
          continue;
        }
        // 端点不支持当前协议(stopReason=error 形态)→ 换另一套协议重试本轮
        if (PROTOCOL_UNSUPPORTED_RE.test(errMsg)) {
          const other: LlmProtocol = protocol === 'responses' ? 'chat' : 'responses';
          if (!triedProtocols.has(other)) {
            triedProtocols.add(other);
            protocol = other;
            models = buildModels();
            console.error(`[pi-chat] 端点不支持当前协议,已切换 ${protocol} 协议重试`);
            round--;
            continue;
          }
        }
        throw new Error(`LLM 返回错误: ${annotateLlmError(errMsg)}`);
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

      // 收集本轮 toolCalls 并执行。
      // sanitizeNames 模式下模型回传的是短横线别名:映射还原成内部名(拷贝,不改 blocks ——
      // assistant 块要原样入 history,保持「声明名/调用名」一致,否则下一轮请求又被 400)。
      // rawName 保留端点别名,toolResult 的 toolName 必须用它(协议一致性)。
      const calls: Array<ToolCall & { rawName?: string }> = blocks
        .filter((c): c is ToolCall => c.type === 'toolCall')
        .map((c) => {
          if (!sanitizeNames) return c;
          const orig = desanitizeToolName(c.name);
          return orig === c.name ? c : { ...c, name: orig, rawName: c.name };
        });
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
              // toolName 必须与 tools 声明名一致(sanitize 模式下是短横线别名)
              toolName: askCall.rawName ?? 'ask.user',
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
        /* ⚠️ 「复述老问题」闸(第六变体,2026-10-09 「测试3」事故)—— 放在**最前面**。
         *
         * 为什么最前:它判的是「模型有没有在复述一个**已经答过**的问题」,与「有没有调工具」
         * 无关 —— 而下面几个闸的判据都建立在「本轮没有有效动作」之上,
         * 让复述句先被识别出来,才不会流到后面被当成正常收尾放行。
         *
         * 事故现场:模型逐字复述了 2 分钟前问过、用户已答的「想走哪种动作风格?」,
         * 且没带 ask.user 卡片 → 界面是一条**没有可点选项**的死气泡,用户无从回答。
         * 注意:`lastAskQuestion` 只在模型**真的调用 ask.user** 时才更新,
         * 所以这里能区分「复述老问题」(命中)与「正常追问」(文本不同,不命中)。 */
        if (isRepeatedPlainTextQuestion(reply, this.lastAskQuestion)) {
          if (repeatedQuestionRetries < 1 && !signal.aborted) {
            repeatedQuestionRetries += 1;
            console.error('[pi-chat] 复述了已答过的老问题且未用 ask.user,已回灌督促指令重试一次');
            messages.push({
              role: 'user',
              content: repeatedQuestionNudge(reply),
              timestamp: Date.now(),
            } as Message);
            continue;
          }
          console.error('[pi-chat] 重试后仍在复述老问题,标记为未推进收尾');
          return { reply: composeRepeatedQuestionReply(reply), thinking, toolCalls };
        }
        /* ⚠️ 「该用 ask.user 却写成正文」闸(第七变体,2026-10-09 「飞机」项目事故)。
         *
         * 为什么单列一道:上面那道只管「**复述**已答过的老问题」(要求逐字相同),
         * 而事故里模型写的是一句**全新的**「请选下一步:」—— 它连"老问题"都算不上,
         * 所以上一道闸抓不到。可它同样没有卡片,同样让用户无从点选,
         * 更糟的是:**它把下一轮污染了** —— 用户回「继续」时,模型把这三个字理解成
         * 对「请选下一步」的回答,于是只顾着说明计划、零工具调用,任务停住。
         *
         * 放在这里(承诺态/完成态闸之前)的理由:一旦模型用正文提问,本轮就注定
         * 不会再有有效动作了,先把它扭回 ask.user 轨道,比让它流到后面被当正常回复更早止损。 */
        if (isPlainTextAsk(reply)) {
          if (plainTextAskRetries < 1 && !signal.aborted) {
            plainTextAskRetries += 1;
            console.error('[pi-chat] 用正文提问却未调 ask.user,已回灌纠正指令重试一次');
            messages.push({
              role: 'user',
              content: plainTextAskNudge(reply),
              timestamp: Date.now(),
            } as Message);
            continue;
          }
          console.error('[pi-chat] 重试后仍用正文提问,标记为「需用户推动」收尾');
          return { reply: composePlainTextAskReply(reply), thinking, toolCalls };
        }
        /* ⚠️ 「工具失败却宣布成功」闸(第五变体,2026-10-09 事故):
         *
         * 为什么:上面几个闸的判据都是「本轮零工具调用」,而本变体恰恰是**调了工具**
         * (只是失败)—— 若不先在这里拦,下面 `isUnbackedCompletionClaim(reply, false)`
         * 之类根本不会触发,模型就能一路宣布「12 个 shot 已铺出」而画布上一个都没有。
         *
         * 顺序理由:这是唯一「有事实依据」的闸(有真实报错在手),优先级高于纯文本推断的闸。 */
        if (isFalseSuccessAfterFailure(reply, lastRoundFailures.map((f) => f.name))) {
          if (falseSuccessRetries < 1 && !signal.aborted) {
            falseSuccessRetries += 1;
            console.error(
              `[pi-chat] 工具失败(${lastRoundFailures.map((f) => f.name).join(',')})却被报告为成功,已回灌纠正指令重试一次`,
            );
            messages.push({
              role: 'user',
              content: falseSuccessNudge(reply, lastRoundFailures),
              timestamp: Date.now(),
            } as Message);
            continue;
          }
          console.error('[pi-chat] 重试后仍把工具失败报成成功,标记为未成功收尾');
          return { reply: composeFalseSuccessReply(reply, lastRoundFailures), thinking, toolCalls };
        }
        // 截断判定(优先于诚实性闸:输出腰斩时连话都没说完,先解释截断更准确)
        // 输出被 maxTokens 截断(stopReason === 'length')时**必须明确告知** ——
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
        /* 「承诺未兑现」闸(第四变体,2026-10-09 事故,见 isUnbackedPromiseClaim 顶部注释):
           与上面的完成态闸是同一病灶的两副面孔 —— 都是「用正文代替了工具调用」,
           区别只在时态:上面查「已提交/创建了」(谎报已完成),这里查「我开始/接下来我会/正在」(宣布要做却没做)。
           事故现场正是后者:模型回「我开始出分镜表」,零工具调用,画布 nodes 始终为 []。
           同样只给**一次**纠正机会:催不动就如实打上未执行标记,绝不让「宣布」冒充「完成」。

           ⚠️ 顺序很重要:完成态闸在前。两者理论上可在同一句里同时命中(罕见),
           优先按更严重的「谎报已完成」处理。 */
        if (isUnbackedPromiseClaim(reply, false)) {
          if (unbackedRetries < 1 && !signal.aborted) {
            unbackedRetries += 1;
            console.error('[pi-chat] 只承诺未执行(承诺态)且无工具调用,已回灌催促指令重试一次');
            messages.push({
              role: 'user',
              content: unbackedPromiseNudge(reply),
              timestamp: Date.now(),
            } as Message);
            continue;
          }
          console.error('[pi-chat] 承诺态重试后仍未调用工具,标记为未执行收尾');
          return { reply: composeUnbackedPromiseReply(reply), thinking, toolCalls };
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

      // 多镜计划:plan.present 成功就暂停,同一批里的其它工具(尤其 engine.submit)先不执行。
      // 失败则把错误喂回模型,其余工具照常跑(未满两镜时可以直接提交)。
      // 失败清单只保留这一轮(plan.present 与其后的工具都算本轮)。
      lastRoundFailures = [];
      let planConsumedAssistant = false;
      const planCall = calls.find((c) => c.name === 'plan.present');
      if (planCall && !signal.aborted) {
        const planArgs = (planCall.arguments ?? {}) as Record<string, unknown>;
        const markdown = String(planArgs.markdown ?? '').trim();
        const norm = (s: string) => s.replace(/\s+/g, '');
        const repeated = !!this.lastAskQuestion && norm(this.lastAskQuestion) === norm(markdown);
        calls.splice(calls.indexOf(planCall), 1);
        messages.push(assistant);
        planConsumedAssistant = true;
        const pushPlanResult = (ok: boolean, text: string) => {
          toolCalls.push({ name: 'plan.present', args: planArgs, ok, result: text });
          if (!ok) lastRoundFailures.push({ name: 'plan.present', result: text });
          messages.push({
            role: 'toolResult' as const,
            toolCallId: planCall.id,
            toolName: planCall.rawName ?? 'plan.present',
            content: [{ type: 'text' as const, text }],
            isError: !ok,
            timestamp: Date.now(),
          } as never);
        };
        if (repeated) {
          const nudge = params.text.trim().startsWith(PLAN_APPROVE_LABEL)
            ? '该计划用户已点「按此执行」。不要再次 plan.present,直接 engine.submit 已批准的镜头。'
            : '这张计划与刚才相同。用户若要求修改,请改写正文后再 plan.present,不要原样重交。';
          pushPlanResult(false, nudge);
          if (calls.length === 0) {
            messages.push({ role: 'user', content: nudge, timestamp: Date.now() } as Message);
            continue;
          }
        } else {
          const req: ToolCallRequest = {
            id: ++this.toolCallSeq,
            method: 'tool',
            params: { tool: 'plan.present', args: planArgs, projectId: params.projectId, canvasId: params.canvasId, threadId: params.threadId },
          };
          const res = this.onToolCall
            ? await this.onToolCall(req)
            : { id: req.id, error: { code: 'NO_BRIDGE', message: '工具桥未注入' } };
          const tr = res.result ?? { ok: false, result: res.error?.message ?? '工具调用失败' };
          pushPlanResult(tr.ok, tr.result);
          if (signal.aborted) return { reply: '', toolCalls, aborted: true };
          if (tr.ok) {
            this.lastAskQuestion = markdown;
            return { reply: markdown, thinking: collectThinking(), toolCalls, ask: planReviewAsk(markdown) };
          }
          if (calls.length === 0) continue;
        }
      }

      // 敏感操作确认闸(结构兜底):未授权时一个都不执行,改发 ask.user 确认卡
      // —— 防模型绕过 prompt 直接 delete;图片下载另加一条:地址没在用户原文里出现过就先确认
      // 已授权过的签名(用户点过确认的同 name+args 操作)直接放行,不再二次拦截
      const sensitiveCalls = calls.filter((c) => {
        const args = (c.arguments ?? {}) as Record<string, unknown>;
        if (this.approvedSensitive.has(PiChatSession.sensitiveSig(c.name, args))) return false;
        if (SENSITIVE_TOOLS.has(c.name)) return true;
        return c.name === 'web.fetch_image' && fetchImageNeedsConfirm(args, imageAuthCorpus);
      });
      if (sensitiveCalls.length > 0 && !sensitiveApproved && !signal.aborted) {
        const lines = sensitiveCalls.slice(0, 5).map((c) => describeAction(c.name, (c.arguments ?? {}) as Record<string, unknown>));
        const more = sensitiveCalls.length > 5 ? `\n- … 共 ${sensitiveCalls.length} 项` : '';
        const onlyFetch = sensitiveCalls.every((c) => c.name === 'web.fetch_image');
        const confirmLabel = onlyFetch ? '下载' : '确认执行';
        const cancelLabel = onlyFetch ? '先不下载' : '先不执行';
        const question = onlyFetch
          ? `即将下载 ${sensitiveCalls.length} 张网络图片到当前项目(进入资产库并出现在画布上):${lines.map((l) => `\n- ${l}`).join('')}${more}\n\n确认下载吗?`
          : `即将执行 ${sensitiveCalls.length} 项不可轻易撤销的操作:${lines.map((l) => `\n- ${l}`).join('')}${more}\n\n确认继续吗?`;
        this.pendingConfirm = {
          options: [confirmLabel, cancelLabel],
          calls: sensitiveCalls.map((c) => ({ name: c.name, args: (c.arguments ?? {}) as Record<string, unknown> })),
        };
        this.lastAskQuestion = question; // 确认卡问题也记入:模型复述它时按重复提问驳回
        const ask = {
          question,
          options: onlyFetch
            ? [
                { label: confirmLabel, sub: '下载到项目资产并在画布上新建资源节点' },
                { label: cancelLabel, sub: '不下载', recommended: true },
              ]
            : [
                { label: confirmLabel, sub: '按上述清单执行,产物变更/删除不可自动恢复' },
                { label: cancelLabel, sub: '不执行,返回继续讨论方案', recommended: true },
              ],
        };
        return { reply: question, thinking: collectThinking(), toolCalls, ask };
      }

      // 执行每个工具调用(反向 RPC 到主进程)
      // plan.present 若已把 assistant 写入消息,这里不能再推一次。
      if (!planConsumedAssistant) messages.push(assistant);
      for (const call of calls) {
        if (signal.aborted) return { reply: '', toolCalls, aborted: true };
        const args = (call.arguments ?? {}) as Record<string, unknown>;
        const req: ToolCallRequest = {
          id: ++this.toolCallSeq,
          method: 'tool',
          params: {
            tool: call.name,
            args,
            projectId: params.projectId,
            canvasId: params.canvasId,
            threadId: params.threadId,
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
        // 记录本轮失败(供下一轮的「假成功」闸判定;见 isFalseSuccessAfterFailure)
        if (!tr.ok) lastRoundFailures.push({ name: call.name, result: String(tr.result ?? '工具调用失败') });
        // 提交成功 → 进入「收尾期」,后续只读轮询开始计数(见上方轮询抑制闸)
        if (call.name === 'engine.submit' && tr.ok) submitted = true;
        // 当前工具的结果已经真实产生,保留在 toolCalls 中;但取消后绝不再执行后续调用。
        if (signal.aborted) return { reply: '', toolCalls, aborted: true };
        // 工具结果文本:结构化 nodeId 必须拼进正文(见 buildToolResultText 注释)。
        const resultText = buildToolResultText(tr.result, tr.nodeId, tr.ok);
        // toolResult 追加进 messages(OpenAI 协议)
        // toolName 必须与 tools 声明名一致(sanitize 模式下用端点别名 rawName)
        messages.push({
          role: 'toolResult' as const,
          toolCallId: call.id,
          toolName: call.rawName ?? call.name,
          content: [{ type: 'text' as const, text: resultText }],
          isError: !tr.ok,
          timestamp: Date.now(),
        } as never);
      }
    }
    return { reply: '已达到最大工具调用轮数,请拆小任务继续。', toolCalls };
  }


}