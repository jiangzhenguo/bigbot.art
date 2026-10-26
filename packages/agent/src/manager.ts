/**
 * AgentManager(主进程侧)— 管理 agent worker 子进程生命周期
 * 已确认:pi 以子进程隔离运行(崩溃不影响主服务,便于升级隔离)。
 * worker 内嵌 pi-ai(真 LLM 规划);inline=true 仅供调试(确定性规划)。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import type { AgentProcessState, LlmSource, AgentEvent } from '@bigbotart/shared';
import type { AgentRequest, AgentResponse, PlanParams, PlanResult, PlanStoryboardParams, PlanStoryboardResult, ChatParams, ChatResult, ChatStreamNotification, ToolCallRequest, ToolCallResponse } from './protocol.js';
import { deterministicPlanner, planStoryboardDeterministic } from './plan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * worker 必须是磁盘上的真实文件:spawn 读不了 app.asar,且
 * ELECTRON_RUN_AS_NODE 也读不了 asar 里的 node_modules。
 * 安装包把整份 node_modules 解到 app.asar.unpacked,这里改走那份 worker.js,
 * 让 Node 自己解析 pi-ai。不要再 esbuild 打成单文件:循环依赖会把
 * ModelsImpl 留在未初始化状态,对话一进来就抛
 * "ModelsImpl is not a constructor"(界面上截成 ModelSimpl)。
 */
export function resolveWorkerEntry(fromDir = __dirname): string {
  const beside = join(fromDir, 'worker.js');
  const asarSeg = `${sep}app.asar${sep}`;
  if (!fromDir.includes(asarSeg)) return beside;
  const unpacked = beside.replace(asarSeg, `${sep}app.asar.unpacked${sep}`);
  return existsSync(unpacked) ? unpacked : beside;
}

/** worker 入口(编译产物) */
export const WORKER_ENTRY = resolveWorkerEntry();

/**
 * chat 的**静默**超时(不是总超时):连续这么久没有任何心跳才判失败。
 * 只要 worker 还在推进(轮首心跳 + 轮内定时心跳)就续期,跑多久都不会被杀 —— 见 request 的看门狗说明。
 *
 * ⚠️ 取值必须 **大于「最长无心跳间隔」**。心跳来自两处:
 *   ① 轮首(每轮 LLM 调用前一次,`PiChatSession.onRound`);
 *   ② **轮内定时心跳**(pi-chat 等待 LLM 返回期间按 `LLM_HEARTBEAT_MS` 周期补发)。
 * 轮内心跳把最大间隔压到 LLM_HEARTBEAT_MS 量级,所以本值主要防「worker 真死/整体挂起」,
 * 不必再贴着单轮推理耗时去设。
 *
 * 默认 10 分钟(2026-09 由 3 分钟调大):本机 35B 本地模型实测,**一轮**真实规模请求
 * (30 个工具定义 + 13 节点画布状态 + 历史 ≈ 75KB,thinking + maxTokens 12000)就要 **78 秒**,
 * 连「你好」这种极小请求都要 30 秒;多步任务动辄 5-10 轮,原 180s 会在任务正常推进中判死,
 * 表现为「agent 无响应」的**假失败**(模型其实还在算,画布改动也可能已生效)。
 */
const SILENT_TIMEOUT_MS = Number(process.env.BIGBOTART_AGENT_SILENT_TIMEOUT_MS ?? 600_000);

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
  /**
   * 在飞请求表。`bump` 是静默看门狗的续期钩子(有 worker 活动时重置计时),
   * 见 request() 的说明 —— 长任务靠它避免被「总时长」误杀。
   */
  private pending = new Map<number, { resolve: (v: AgentResponse) => void; bump?: () => void }>();
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
        const msg = JSON.parse(line) as AgentResponse | ToolCallRequest | ChatStreamNotification;
        // 模型正文/思考增量:按 chat requestId 路由并生成稳定 eventId。
        // 已超时/已结束的请求不许再把迟到草稿推回界面;在飞请求则用 token 活动续期看门狗。
        if ('method' in msg && msg.method === 'stream') {
          const notice = msg as ChatStreamNotification;
          if (!this.pending.has(notice.requestId)) return;
          this.bumpAllHeartbeats();
          const { seq, ...event } = notice.params;
          this.onEvent?.({ ...event, eventId: `${notice.requestId}:${seq}` });
          return;
        }
        // worker 心跳(批次1):每轮循环开始都发,给静默看门狗续期 ——
        // 覆盖「首轮 LLM 推理」这段没有工具活动的空窗期(否则任务会在真正开始前被误杀)
        if ('method' in msg && (msg as { method?: string }).method === 'heartbeat') {
          this.bumpAllHeartbeats();
          return;
        }
        // worker 发来的工具调用请求(反向 RPC):method==='tool'
        if ('method' in msg && msg.method === 'tool') {
          console.error('[agent-mgr] 收到 worker 工具请求:', (msg as ToolCallRequest).params?.tool);
          // 有工具活动 = worker 活着 → 给当前在跑的 chat 请求续期(静默看门狗,见 request)
          this.bumpAllHeartbeats();
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

  /** 一句话起活 → 分镜表(plan-storyboard;默认分步只出表,autoMaterialize 时同时铺节点) */
  async planStoryboard(
    brief: string,
    llm?: LlmSource,
    ctx?: { projectName?: string; basePrompt?: string; autoMaterialize?: boolean },
  ): Promise<PlanStoryboardResult> {
    if (this.inline) {
      return planStoryboardDeterministic({
        brief,
        projectName: ctx?.projectName,
        basePrompt: ctx?.basePrompt,
        autoMaterialize: ctx?.autoMaterialize,
      });
    }
    await this.start();
    const res = await this.request<PlanStoryboardParams, PlanStoryboardResult>('plan-storyboard', {
      brief,
      projectName: ctx?.projectName,
      basePrompt: ctx?.basePrompt,
      autoMaterialize: ctx?.autoMaterialize,
      llm,
    });
    if (res.error) throw new Error(`agent plan-storyboard 失败: ${res.error.message}`);
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
        threadId: req.params.threadId,
        eventId: `tool:${req.id}:start`,
        toolName: req.params.tool,
        toolArgs: req.params.args,
      });
      try {
        res = await this.toolExecutor(req);
      } catch (e) {
        /* 工具执行**必须**兜住异常并回写结果:
           否则 worker 侧 pendingTools 永远等不到 resolve → 整个对话挂起,
           最终表现为看门狗超时「agent 无响应」,而真因(某个工具抛了)完全丢失。
           这里转成 worker 可见的失败结果,让模型能据此调整或如实汇报。 */
        res = { id: req.id, result: { ok: false, result: `工具执行异常:${(e as Error).message}` } };
      }
      // 事件推送:工具结束
      this.onEvent?.({
        kind: 'tool-end',
        projectId: req.params.projectId,
        canvasId: req.params.canvasId,
        threadId: req.params.threadId,
        eventId: `tool:${req.id}:end`,
        toolName: req.params.tool,
        toolArgs: req.params.args,
        ok: res.result?.ok,
        result: res.result?.result,
        nodeId: res.result?.nodeId,
      });
    } else {
      res = { id: req.id, error: { code: 'NO_EXECUTOR', message: '工具执行器未注入' } };
    }
    try {
      this.child.stdin!.write(JSON.stringify(res) + '\n');
    } catch (e) {
      // 回写失败(管道断裂 / worker 已退):记录但不抛,避免未捕获的 rejection
      console.error('[agent-mgr] 工具结果回写失败:', (e as Error).message);
    }
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

  /**
   * 静默看门狗(批次1)。
   *
   * 旧实现是一个固定的总超时(chat 5 分钟),长任务会被「总时长」误杀:实测一次「反推提示词」
   * 跑了 11 轮 / 249 秒,最后生成回复时撞穿 5 分钟被判定「agent 无响应」,而任务其实已经成功
   * (提示词早已写进节点)——用户看到的是假失败。
   *
   * 现在改为**静默超时**:只要 worker 还有动静(每轮工具调用都会 bump 心跳)就续期,
   * 只有**真的卡死**(连续 SILENT_TIMEOUT_MS 无任何心跳)才判失败。
   * 配合主进程改用事件推送终局,长任务不再受单次请求时长约束。
   */
  private request<P, R>(method: AgentRequest<P>['method'], params: P): Promise<AgentResponse<R>> {
    const id = ++this.reqSeq;
    const msg: AgentRequest<P> = { id, method, params };
    const timeoutMs = method === 'chat' ? SILENT_TIMEOUT_MS : this.requestTimeoutMs;
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const p = this.pending.get(id);
          if (p) {
            this.pending.delete(id);
            p.resolve({ id, error: { code: 'TIMEOUT', message: `agent 无响应(已静默 ${Math.round(timeoutMs / 1000)}s,本地 LLM 可能加载中或已崩溃)` } });
          }
        }, timeoutMs);
      };
      // 心跳续期:worker 每次发出工具请求都算「还活着」
      this.pending.set(id, { resolve: resolve as (v: AgentResponse) => void, bump: arm });
      this.child!.stdin!.write(JSON.stringify(msg) + '\n');
      arm();
    });
  }

  /**
   * 给所有在跑的长请求续期。
   * 工具请求走的是反向 RPC,自带一个独立的 id(不是 chat 请求的 id),所以无法精确对应;
   * 但同一时刻通常只有一个 chat 在跑,全部续期是安全且够用的(多 chat 并发时最坏也只是
   * 让另一个请求的看门狗延后,不会误杀)。
   */
  private bumpAllHeartbeats(): void {
    for (const p of this.pending.values()) {
      p.bump?.();
    }
  }

  private requestTimeoutMs = 180_000;
}

export * from './protocol.js';
export { planDeterministic, deterministicPlanner, planStoryboardDeterministic, deterministicStoryboardPlanner, buildStoryboardMaterialized } from './plan.js';