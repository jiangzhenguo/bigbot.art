/**
 * AgentManager(主进程侧)— 管理 agent worker 子进程生命周期
 * 已确认:pi 以子进程隔离运行(崩溃不影响主服务,便于升级隔离)。
 * worker 内嵌 pi-ai(真 LLM 规划);inline=true 仅供调试(确定性规划)。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AgentProcessState, LlmSource, AgentEvent } from '@bigbotart/shared';
import type { AgentRequest, AgentResponse, PlanParams, PlanResult, ChatParams, ChatResult, ToolCallRequest, ToolCallResponse } from './protocol.js';
import { deterministicPlanner } from './plan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** worker 入口(编译产物) */
export const WORKER_ENTRY = join(__dirname, 'worker.js');

export interface AgentManagerOptions {
  /** 覆盖 worker 脚本路径(指向 pi 入口或自定义 worker) */
  workerEntry?: string;
  /** 调试用:内联确定性规划(不 spawn 子进程);默认 false 走子进程(pi 隔离) */
  inline?: boolean;
  defaultLlm?: LlmSource;
  /** 传给 worker 的 LLM 环境变量:远端 OpenAI 兼容端点 */
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  /** 本地 LM Studio 配置(远端未配置时使用) */
  lmStudioUrl?: string;
  lmStudioModel?: string;
}

export class AgentManager {
  private child?: ChildProcess;
  private pending = new Map<number, { resolve: (v: AgentResponse) => void }>();
  private reqSeq = 0;
  private startedAt?: string;
  private inline: boolean;
  private workerEntry: string;
  private envOverrides: Record<string, string> = {};
  defaultLlm: LlmSource | undefined;

  /** 工具执行回调(主进程注入):worker 发来 ToolCallRequest 时路由到主进程工具桥 */
  toolExecutor: ((req: ToolCallRequest) => Promise<ToolCallResponse>) | null = null;
  /** Agent 实时事件回调(主进程注入,转发到渲染层) */
  onEvent: ((ev: AgentEvent) => void) | null = null;

  constructor(opts: AgentManagerOptions = {}) {
    this.inline = opts.inline ?? false;
    this.workerEntry = opts.workerEntry ?? WORKER_ENTRY;
    this.defaultLlm = opts.defaultLlm;
    if (opts.llmBaseUrl) this.envOverrides.BIGBOTART_LLM_BASE_URL = opts.llmBaseUrl;
    // 故意不写入 BIGBOTART_LLM_API_KEY:钥匙串/远端 key 仅经单次 RPC 的 LlmSource 传递,不进 worker 环境
    if (opts.llmModel) this.envOverrides.BIGBOTART_LLM_MODEL = opts.llmModel;
    if (opts.lmStudioUrl) this.envOverrides.BIGBOTART_LMSTUDIO_URL = opts.lmStudioUrl;
    if (opts.lmStudioModel) this.envOverrides.BIGBOTART_LMSTUDIO_MODEL = opts.lmStudioModel;
  }

  async start(): Promise<AgentProcessState> {
    if (this.inline) {
      this.startedAt = new Date().toISOString();
      return { running: true, startedAt: this.startedAt };
    }
    if (this.child && !this.child.killed) {
      return this.status();
    }
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.envOverrides };
    // Electron 二进制当 Node 用;否则会当成第二个 App 启动
    env.ELECTRON_RUN_AS_NODE = '1';
    // 保险:即便父进程环境里有 key,也不泄漏到 worker 环境
    delete env.BIGBOTART_LLM_API_KEY;
    const child = spawn(process.execPath, [this.workerEntry], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env,
    });
    this.child = child;
    this.startedAt = new Date().toISOString();
    const rl = (await import('node:readline')).createInterface({ input: child.stdout!, terminal: false });
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line) as AgentResponse | ToolCallRequest;
        // worker 发来的工具调用请求(反向 RPC):method==='tool'
        if ('method' in msg && msg.method === 'tool') {
          console.error('[agent-mgr] 收到 worker 工具请求:', (msg as ToolCallRequest).params?.tool);
          void this.handleToolCall(msg as ToolCallRequest);
          return;
        }
        const p = this.pending.get((msg as AgentResponse).id);
        if (p) {
          this.pending.delete((msg as AgentResponse).id);
          p.resolve(msg as AgentResponse);
        }
      } catch {
        // 忽略非 JSON 行
      }
    });
    child.on('exit', () => {
      this.child = undefined;
      for (const [, p] of this.pending) p.resolve({ id: -1, error: { code: 'EXITED', message: 'worker 退出' } });
      this.pending.clear();
    });
    return this.status();
  }

  async stop(): Promise<{ ok: boolean }> {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = undefined;
    }
    return { ok: true };
  }

  status(): AgentProcessState {
    return {
      running: this.inline ? true : !!this.child && !this.child.killed,
      pid: this.child?.pid,
      startedAt: this.startedAt,
    };
  }

  /** 一句话起活:规划 Brief → 画布(可指定 LLM 来源与项目上下文) */
  async plan(
    brief: string,
    llm?: LlmSource,
    ctx?: { projectName?: string; existingNodeIds?: string[] },
  ): Promise<PlanResult> {
    if (this.inline) {
      return deterministicPlanner({ brief, projectName: ctx?.projectName }, llm ?? this.defaultLlm);
    }
    await this.start();
    const res = await this.request<PlanParams, PlanResult>('plan', {
      brief,
      projectName: ctx?.projectName,
      existingNodeIds: ctx?.existingNodeIds,
      llm,
    });
    if (res.error) throw new Error(`agent plan 失败: ${res.error.message}`);
    return res.result!;
  }

  /** worker 工具调用 → 主进程工具桥执行 → 结果回写 worker stdin */
  private async handleToolCall(req: ToolCallRequest): Promise<void> {
    if (!this.child || this.child.killed) return;
    let res: ToolCallResponse;
    if (this.toolExecutor) {
      // 事件推送:工具开始
      this.onEvent?.({
        kind: 'tool-start',
        projectId: req.params.projectId,
        canvasId: req.params.canvasId,
        toolName: req.params.tool,
        toolArgs: req.params.args,
      });
      res = await this.toolExecutor(req);
      // 事件推送:工具结束
      this.onEvent?.({
        kind: 'tool-end',
        projectId: req.params.projectId,
        canvasId: req.params.canvasId,
        toolName: req.params.tool,
        toolArgs: req.params.args,
        ok: res.result?.ok,
        result: res.result?.result,
        nodeId: res.result?.nodeId,
      });
    } else {
      res = { id: req.id, error: { code: 'NO_EXECUTOR', message: '工具执行器未注入' } };
    }
    this.child.stdin!.write(JSON.stringify(res) + '\n');
  }

  /** 多轮对话 + 工具调用(画布页 Agent) */
  async chat(params: ChatParams): Promise<ChatResult> {
    if (this.inline) {
      return { reply: '（内联调试模式:不支持对话,请用子进程)', toolCalls: [] };
    }
    await this.start();
    const res = await this.request<ChatParams, ChatResult>('chat', params);
    if (res.error) throw new Error(`agent chat 失败: ${res.error.message}`);
    return res.result!;
  }

  /** 真实打断:中止 worker 内当前 chat(AbortSignal) */
  async cancel(): Promise<{ ok: boolean }> {
    if (this.inline) return { ok: true };
    if (!this.child || this.child.killed) return { ok: false };
    this.child.stdin!.write(JSON.stringify({ id: ++this.reqSeq, method: 'cancel', params: {} }) + '\n');
    return { ok: true };
  }

  private request<P, R>(method: AgentRequest<P>['method'], params: P): Promise<AgentResponse<R>> {
    const id = ++this.reqSeq;
    const msg: AgentRequest<P> = { id, method, params };
    return new Promise((resolve) => {
      this.pending.set(id, { resolve: resolve as (v: AgentResponse) => void });
      this.child!.stdin!.write(JSON.stringify(msg) + '\n');
      // 超时回退(本地 LLM 首次加载可能超过 1 分钟;chat 多轮工具循环给 5 分钟)
      setTimeout(() => {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          p.resolve({ id, error: { code: 'TIMEOUT', message: 'agent 无响应(本地 LLM 加载中或已崩溃)' } });
        }
      }, method === 'chat' ? 300_000 : this.requestTimeoutMs);
    });
  }

  private requestTimeoutMs = 180_000;
}

export * from './protocol.js';
export { planDeterministic, deterministicPlanner } from './plan.js';