/**
 * RenderQueue — 主进程渲染队列(PRD §5.3:槽位互斥 + FIFO + 进度可轮询)
 * - 全局同一时刻只跑一个任务(视频/图片槽位互斥,64GB 内存策略)
 * - demo 模式(settings.renderMode='demo',默认):一律路由 mock 占位,秒回
 * - real 模式:按请求引擎(h3c/mlxgen),运行时就绪则真实推理,否则兜底 mock
 * - 进度:对运行中任务每 2s 调 provider.status(),渲染层轮询 queue-status
 */
import type {
  ProviderId,
  ProviderRegistry,
  RenderJob,
  RenderJobHandle,
  RenderRequest,
  RenderStatus,
} from '@bigbotart/shared';
import type { SettingsStore } from './settings';
import type { DebugLogger } from './logger';

const POLL_MS = 2000;
const READY_TTL_MS = 60_000;

/** 队列内部任务 = RenderJob + 原始请求(执行时还原) */
interface QueuedJob extends RenderJob {
  req?: RenderRequest;
}

export class RenderQueue {
  private jobs: QueuedJob[] = [];
  private running: QueuedJob | null = null;
  private handles = new Map<string, RenderJobHandle>();
  private pollTimer: NodeJS.Timeout | null = null;
  private providerReadyCache = new Map<ProviderId, { ready: boolean; at: number }>();

  constructor(
    private registry: ProviderRegistry,
    private settings: SettingsStore,
    private logger?: DebugLogger,
  ) {}

  /**
   * 任务完成回调(Take 终态归档 + 连续性校验等)。
   *
   * ⚠️ **可以返回 Promise,且 finishJob 会等它落盘后才 notify**。
   * 这是 2026-09-29「图片编辑生成成功后 Take 不会自动变成完成,需要再点一次」的修法:
   * 旧实现 `void takes.patch(...)` 是异步的(成功且有产物时还要 await ffprobe 探测媒体时长),
   * 而 finishJob 紧接着就 `notify()` 把新队列状态推给渲染层 → 渲染层按 job 签名变化重拉
   * takesHistory 时,**盘上那条 Take 还是 queued**(patch 尚未 save()),
   * 于是检查器里 chip 一直显示排队中;又因为此后没有任何事件再触发刷新,
   * 只能等用户手动点一下(触发重渲染)才看到「已完成」。
   */
  onJobFinish: ((job: RenderJob) => void | Promise<void>) | null = null;

  /** 队列变更回调(当前 tick 内合并去抖;推送 slimList 精简视图,渲染层订阅用) */
  onChange: ((jobs: RenderJob[]) => void) | null = null;
  private notifyScheduled = false;

  /** 提交任务入队;返回队列任务 id(兼容 RenderJobHandle.providerTaskId 语义) */
  submit(req: RenderRequest & { takeId?: string }): RenderJobHandle {
    const provider = req.provider ?? (req.slot === 'video' ? 'h3c' : 'mlxgen');
    const now = new Date().toISOString();
    const job: QueuedJob = {
      id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      nodeId: req.nodeId,
      provider,
      status: 'queued',
      slot: req.slot,
      projectId: req.projectId,
      canvasId: req.canvasId,
      takeId: req.takeId,
      req,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.push(job);
    this.pump();
    this.notify();
    return { providerTaskId: job.id };
  }

  async cancel(handle: RenderJobHandle): Promise<void> {
    const job = this.jobs.find((j) => j.id === handle.providerTaskId);
    if (!job) return;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.updatedAt = new Date().toISOString();
      this.notify();
      return;
    }
    if (job.status === 'running' && this.running?.id === job.id) {
      // 先等 provider 把真实子进程杀干净,再归档 + 放行下一个任务(避免新旧 h3 重叠)
      const real = this.handles.get(job.id);
      if (real) {
        const p = this.registry.get(this.effectiveProvider(job));
        try {
          await p?.cancel(real);
        } catch {
          /* provider.cancel 失败不阻断归档 */
        }
      }
      this.finishJob(job, { status: 'cancelled', stage: '已取消' });
    }
  }

  list(): RenderJob[] {
    return [...this.jobs].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  /** 对外精简视图:剔除内部 req(含参数/提示词/引用大对象),仅暴露渲染层所需字段 */
  slimList(): RenderJob[] {
    return this.jobs
      .map((j) => ({
        id: j.id,
        nodeId: j.nodeId,
        provider: j.provider,
        status: j.status,
        slot: j.slot,
        projectId: j.projectId,
        canvasId: j.canvasId,
        progress: j.progress,
        stage: j.stage,
        error: j.error,
        takeId: j.takeId,
        resultPath: j.resultPath,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
      }))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  /** 变更通知:合并到同一事件循环 tick 内只推一次(避免 submit+状态轮询连发多条 IPC) */
  private notify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    setImmediate(() => {
      this.notifyScheduled = false;
      this.onChange?.(this.slimList());
    });
  }

  getJob(id: string): RenderJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  /** 实际会用的 provider(考虑 demo 模式 + 就绪兜底) */
  private effectiveProvider(job: QueuedJob): ProviderId {
    if (this.settings.get().renderMode === 'demo') return 'mock';
    if (job.provider === 'mock') return 'mock';
    return job.provider as ProviderId;
  }

  /** 真实引擎就绪?(缓存 60s;h3c.check 会跑 --info,较慢) */
  private async isProviderReady(id: ProviderId): Promise<boolean> {
    const cached = this.providerReadyCache.get(id);
    if (cached && Date.now() - cached.at < READY_TTL_MS) return cached.ready;
    try {
      const p = this.registry.get(id);
      const st = p ? await p.check() : undefined;
      const ready = !!st?.ready;
      this.providerReadyCache.set(id, { ready, at: Date.now() });
      return ready;
    } catch {
      this.providerReadyCache.set(id, { ready: false, at: Date.now() });
      return false;
    }
  }

  private pump() {
    if (this.running) return;
    const next = this.jobs.find((j) => j.status === 'queued');
    if (!next) return;
    this.running = next;
    void this.runAsync(next);
  }

  private async runAsync(job: QueuedJob): Promise<void> {
    job.status = 'running';
    job.stage = '准备引擎…';
    job.updatedAt = new Date().toISOString();

    const providerId = this.effectiveProvider(job);
    let p = this.registry.get(providerId);
    if (!p) p = this.registry.get('mock')!;
    this.logger?.log("info", `[queue] job=${job.id} node=${job.nodeId} → provider=${providerId}`);

    // real 模式下默认引擎未就绪 → 兜底 mock(记录原因)
    if (providerId !== 'mock' && !(await this.isProviderReady(providerId))) {
      job.stage = `${providerId} 未就绪,演示占位兜底`;
      job.updatedAt = new Date().toISOString();
      this.logger?.log("info", `[queue] ${providerId} 未就绪 → 兜底 mock`);
      p = this.registry.get('mock')!;
    }
    // ⚠️ 引擎探测(可能耗时数秒~20s)期间用户可能已取消:取消后不再启动引擎/不再 submit
    if (job.status !== 'running') {
      this.logger?.log("info", `[queue] job=${job.id} 探测期间已取消,不再启动引擎`);
      return;
    }

    const req0: RenderRequest = job.req
      ?? { provider: providerId, nodeId: job.nodeId, slot: job.slot === 'video' ? 'video' : 'image', params: {} };
    // 全局「SSD 流式读权重」开关(设置页通用,默认关):视频任务在提交前注入 params.ssdStreaming,
    // h3c provider 据此追加 --ssd-streaming(覆盖画布/Agent 两条提交路径;不改动已存 job.req)
    const req: RenderRequest =
      job.slot === 'video' && this.settings.get().ssdStreaming === true
        ? { ...req0, params: { ...(req0.params ?? {}), ssdStreaming: true } }
        : req0;

    let handle: RenderJobHandle;
    try {
      handle = await p.submit(req);
      this.logger?.log("info", `[queue] submit ok provider=${p.id} handle=${handle.providerTaskId}`);
    } catch (e) {
      this.logger?.log("info", `[queue] submit 失败: ${(e as Error).message} ${(e as Error).stack ?? ''}`);
      this.finishJob(job, { status: 'failed', stage: '提交失败', error: (e as Error).message });
      return;
    }
    // 提交刚完成、handle 尚未登记的最小窗口内被取消 → 立即回收刚 spawn 的引擎进程
    if (job.status !== 'running') {
      this.logger?.log("info", `[queue] job=${job.id} 提交后已被取消,立即回收引擎进程`);
      try {
        await p?.cancel(handle);
      } catch {
        /* 忽略 */
      }
      return;
    }
    this.handles.set(job.id, handle);
    this.scheduleStatusPoll(job, handle, p as { status(h: RenderJobHandle): Promise<RenderStatus> });
  }

  private scheduleStatusPoll(
    job: QueuedJob,
    handle: RenderJobHandle,
    p: { status(h: RenderJobHandle): Promise<RenderStatus> },
  ) {
    const tick = async () => {
      if (job.status !== 'running') return;
      let st: RenderStatus;
      try {
        st = await p.status(handle);
      } catch (e) {
        this.finishJob(job, { status: 'failed', stage: '状态查询失败', error: (e as Error).message });
        return;
      }
      if (st.progress !== undefined) job.progress = st.progress;
      if (st.stage) job.stage = st.stage;
      job.updatedAt = new Date().toISOString();
      this.notify();
      if (st.status === 'SUCCEEDED' || st.status === 'FAILED' || st.status === 'EXPIRED') {
        this.finishJob(job, {
          status: st.status === 'SUCCEEDED' ? 'succeeded' : 'failed',
          stage: st.stage ?? (st.status === 'SUCCEEDED' ? '完成' : '失败'),
          error: st.error,
          resultPath: st.resultPath,
        });
        return;
      }
      this.pollTimer = setTimeout(tick, POLL_MS);
    };
    this.pollTimer = setTimeout(tick, POLL_MS);
  }

  private finishJob(
    job: QueuedJob,
    patch: { status: RenderJob['status']; stage?: string; error?: string; resultPath?: string },
  ) {
    job.status = patch.status;
    if (patch.stage) job.stage = patch.stage;
    if (patch.error) job.error = patch.error;
    if (patch.resultPath) job.resultPath = patch.resultPath;
    if (patch.status === 'succeeded') job.progress = 1;
    job.updatedAt = new Date().toISOString();
    this.logger?.log("info", `[queue] job=${job.id} node=${job.nodeId} → ${job.status}${patch.error ? ` · err=${patch.error}` : ''}${patch.resultPath ? ` · out=${basename(patch.resultPath)}` : ''}`);
    this.handles.delete(job.id);
    this.running = null;
    /* 终态归档必须先于 notify:渲染层收到队列变更就会重拉 Take 历史,
       若 Take 还没落盘(见 onJobFinish 注释),检查器会一直停在「排队中」。
       onJobFinish 抛错不能吞(红线 R6),也不该阻断 notify 与 pump —— 否则
       一次归档异常会卡死整个队列,所以这里分开 catch。 */
    const afterFinish = (): void => {
      this.pump();
      this.notify();
    };
    void (async () => {
      try {
        await this.onJobFinish?.(job);
      } catch (e) {
        this.logger?.log('warn', `[queue] job=${job.id} onJobFinish 回调异常: ${(e as Error).message}`);
      }
      afterFinish();
    })();
  }
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}