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

  /** 任务完成回调(连续性校验等) */
  onJobFinish: ((job: RenderJob) => void) | null = null;

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
    return { providerTaskId: job.id };
  }

  cancel(handle: RenderJobHandle): void {
    const job = this.jobs.find((j) => j.id === handle.providerTaskId);
    if (!job) return;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.updatedAt = new Date().toISOString();
      return;
    }
    if (job.status === 'running' && this.running?.id === job.id) {
      const real = this.handles.get(job.id);
      if (real) {
        const p = this.registry.get(this.effectiveProvider(job));
        void p?.cancel(real).catch(() => undefined);
      }
      this.finishJob(job, { status: 'cancelled', stage: '已取消' });
    }
  }

  list(): RenderJob[] {
    return [...this.jobs].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
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

    const req: RenderRequest = job.req
      ?? { provider: providerId, nodeId: job.nodeId, slot: job.slot === 'video' ? 'video' : 'image', params: {} };

    let handle: RenderJobHandle;
    try {
      handle = await p.submit(req);
      this.logger?.log("info", `[queue] submit ok provider=${p.id} handle=${handle.providerTaskId}`);
    } catch (e) {
      this.logger?.log("info", `[queue] submit 失败: ${(e as Error).message} ${(e as Error).stack ?? ''}`);
      this.finishJob(job, { status: 'failed', stage: '提交失败', error: (e as Error).message });
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
    // 完成回调(连续性校验等)
    this.onJobFinish?.(job);
    this.pump();
  }
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}