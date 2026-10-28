/**
 * Agent 子进程通信协议 — JSON-RPC over stdio (JSONL)
 * 消息 = 单行 JSON,换行分隔。
 */

export type AgentMethod = 'plan' | 'plan-storyboard' | 'ping' | 'chat' | 'cancel';

export interface AgentRequest<R = unknown> {
  id: number;
  method: AgentMethod;
  params?: R;
}

export interface AgentResponse<T = unknown> {
  id: number;
  result?: T;
  error?: { code: string; message: string };
}

/** plan 请求 */
export interface PlanParams {
  brief: string;
  /** 项目已有节点(增量规划参考) */
  existingNodeIds?: string[];
  projectName?: string;
  /** 本次规划的 LLM 来源(项目级覆盖/全局设置;未传走 worker 默认端点) */
  llm?: import('@bigbotart/shared').LlmSource;
}

/** plan 结果:画布规划(骨架期确定性模板产出) */
export interface PlanResult {
  /** Brief 文档节点 */
  document: import('@bigbotart/shared').CanvasNode;
  /** 拆出的镜头节点 */
  shots: import('@bigbotart/shared').CanvasNode[];
  /** 连线(Brief → 各镜头) */
  edges: import('@bigbotart/shared').CanvasEdge[];
  report: string;
}

/** plan-storyboard 请求:从文档/小说生成分镜表(文档 §7) */
export interface PlanStoryboardParams extends PlanParams {
  /** 全局质感段(铺节点时注入每行) */
  basePrompt?: string;
  /** true=自动档:同时铺出 image-gen/shot 节点;false=分步(默认,只出表) */
  autoMaterialize?: boolean;
}

/** plan-storyboard 结果:分镜表节点 + (自动档)铺出的生成节点 */
export interface PlanStoryboardResult {
  /** 分镜表节点(kind='storyboard',markdown = 标题+说明+表格) */
  storyboard: import('@bigbotart/shared').CanvasNode;
  /** 需配图行的 image-gen 节点(分步模式为空) */
  images: import('@bigbotart/shared').CanvasNode[];
  /** 每行一个 shot 节点(分步模式为空) */
  shots: import('@bigbotart/shared').CanvasNode[];
  /** 连线(storyboard→* / image-gen→shot first-frame) */
  edges: import('@bigbotart/shared').CanvasEdge[];
  report: string;
  /**
   * 走了确定性模板兜底时的原因(2026-10-28「剧本生成测试」事故)。
   *
   * 为什么要有这个字段:LLM 分镜规划失败时**静默**回退到确定性模板,而模板产出的
   * report 与成功路径**一字不差**(「已生成分镜表:4 行」)—— 用户以为拿到了 LLM 拆的镜,
   * 实际是模板按句子数硬切的 4 行,于是「效果和描述对不上」却查不出原因。
   * 有值 = 这次是兜底,上层必须把原因透出给用户,不能冒充成功。
   */
  fallbackReason?: string;
}

/** chat 请求:多轮对话 + 工具调用 */
export interface ChatParams {
  projectId: string;
  canvasId: string;
  /** 目标会话;流式事件原样带回,避免主进程用「最近上下文」误路由到别的会话 */
  threadId?: string;
  text: string;
  /** 记忆上下文(主进程组装好发给 worker) */
  context: {
    systemPrompt: string;
    /** 历史消息(user/assistant 文本 + system 动作记录);system 在 worker 里转成 user 角色注入(pi-ai 无原生 system 消息) */
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  };
  /** 本轮声明给框架的上下文窗口。缺省时 worker 用 10 万兜底。 */
  contextWindow?: number;
  llm?: import('@bigbotart/shared').LlmSource;
}

/** 一轮 chat 内的模型增量。工具参数不流式执行,仍等完整 assistant 后过现有确认闸。 */
export type ChatStreamEvent =
  | { kind: 'round-start'; round: number }
  | { kind: 'text-delta' | 'thinking-delta'; round: number; contentIndex: number; delta: string };

/** worker → 主进程的流式通知;requestId 对应触发它的 chat RPC,seq 用于界面精确去重。 */
export interface ChatStreamNotification {
  method: 'stream';
  requestId: number;
  params: ChatStreamEvent & {
    seq: number;
    projectId: string;
    canvasId: string;
    threadId?: string;
  };
}

/** chat 期间 worker → 主进程的工具调用请求(反向 RPC) */
export interface ToolCallRequest {
  id: number;
  method: 'tool';
  params: {
    tool: string;
    args: Record<string, unknown>;
    /** 会话上下文:避免并发 chat 串写全局 currentToolCtx */
    projectId: string;
    canvasId: string;
    /** 与 chat 一致的会话路由;工具事件不再依赖主进程的全局「最近上下文」 */
    threadId?: string;
  };
}

export interface ToolCallResponse {
  id: number;
  result?: { ok: boolean; result: string; nodeId?: string };
  error?: { code: string; message: string };
}

/** chat 结果 */
export interface ChatResult {
  reply: string;
  /** 模型的思考内容(reasoning 块 / <think> 段;前端折叠展示,不进记忆) */
  thinking?: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; ok: boolean; result: string; nodeId?: string }>;
  /** 🆕 结构化提问(Agent 调 ask.user 暂停,等用户在确认卡片选择);options 已归一化为对象 */
  ask?: { question: string; options: import('@bigbotart/shared').AskOption[] };
  aborted?: boolean;
}

/** ping 响应 */
export interface PingResult {
  ok: true;
  startedAt: string;
  pid: number;
}