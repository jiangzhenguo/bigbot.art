/**
 * Agent 子进程通信协议 — JSON-RPC over stdio (JSONL)
 * 消息 = 单行 JSON,换行分隔。
 */

export type AgentMethod = 'plan' | 'ping' | 'chat' | 'cancel';

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

/** chat 请求:多轮对话 + 工具调用 */
export interface ChatParams {
  projectId: string;
  canvasId: string;
  text: string;
  /** 记忆上下文(主进程组装好发给 worker) */
  context: {
    systemPrompt: string;
    /** 历史消息(user/assistant 文本) */
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  };
  llm?: import('@bigbotart/shared').LlmSource;
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
  toolCalls: Array<{ name: string; args: Record<string, unknown>; ok: boolean; result: string; nodeId?: string }>;
  aborted?: boolean;
}

/** ping 响应 */
export interface PingResult {
  ok: true;
  startedAt: string;
  pid: number;
}