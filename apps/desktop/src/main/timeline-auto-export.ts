/**
 * 时间线确定性导出。
 *
 * 背景(2026-10-28「故事脚本测试」):5 镜全部出片、时间线 5 条 clip 连线齐备,
 * 但最后的 `timeline.export` 依赖 Agent 再被唤醒一次;实际停在待办「导出时间线成片」,
 * 时间线节点没有 resultPath。拼接是确定性收口,不该依赖额外一轮 LLM。
 *
 * 本模块:画布保存后检查「时间线入轨镜头是否全部有产物」,齐了就自动提交 ffmpeg 导出,
 * 成功后把 outputPath 写回 timeline.data.resultPath。同一条时间线在同一输入签名下只尝试一次。
 */
import { existsSync } from 'node:fs';
import type {
  CanvasEdge,
  CanvasNode,
  CanvasSnapshot,
  ExportTask,
  ProjectCanvases,
  TimelineExportRequest,
} from '@bigbotart/shared';

interface StoreLike {
  listProjects(): Array<{ id: string }>;
  loadProjectCanvases(projectId: string): ProjectCanvases;
  saveCanvasSnapshot(snap: CanvasSnapshot): { ok: boolean; stale?: boolean; current?: CanvasSnapshot };
}

interface ExportLike {
  submit(req: TimelineExportRequest): { taskId: string };
  status(taskId: string): ExportTask;
}

interface LoggerLike {
  log(level: 'info' | 'warn' | 'error', msg: string): void;
}

export interface TimelineClip {
  path: string;
  label?: string;
  nodeId?: string;
}

export interface ReadyTimelineExport {
  timelineId: string;
  label: string;
  clips: TimelineClip[];
  /** 完整导出请求(高级编排 timeline 用 sequence;简单 timeline 用 clips) */
  request: TimelineExportRequest;
  /** 输入签名:镜头 id + 产物路径;变了才允许重新自动导出 */
  signature: string;
}

export interface TimelineExportCoordinatorOptions {
  pollMs?: number;
  maxWaitMs?: number;
}

/** 取时间线引用的镜头 id:优先 data.shotNodeIds,其次 sequence,最后回退 clip 连线顺序。 */
export function timelineShotIds(node: CanvasNode, edges: CanvasEdge[]): string[] {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const fromData = Array.isArray(data.shotNodeIds) ? data.shotNodeIds.map(String) : [];
  if (fromData.length) return fromData;
  const sequence = Array.isArray(data.sequence) ? data.sequence : [];
  const fromSequence = sequence
    .map((s) => (s && typeof s === 'object' ? String((s as { shotNodeId?: unknown }).shotNodeId ?? '') : ''))
    .filter(Boolean);
  if (fromSequence.length) return fromSequence;
  return edges
    .filter((e) => e.target === node.id && (e.label === 'clip' || !e.label))
    .map((e) => e.source);
}

/**
 * 找出「全部入轨镜头已出片、且尚未导出成功」的时间线。
 * 只读、无副作用,便于单测。
 */
export function collectReadyTimelineExports(
  snap: Pick<CanvasSnapshot, 'nodes' | 'edges' | 'projectId'>,
  options: { fileExists?: (path: string) => boolean } = {},
): ReadyTimelineExport[] {
  const fileExists = options.fileExists ?? ((p: string) => existsSync(p));
  const byId = new Map(snap.nodes.map((n) => [n.id, n]));
  const out: ReadyTimelineExport[] = [];
  for (const node of snap.nodes) {
    if (node.kind !== 'timeline') continue;
    const data = (node.data ?? {}) as Record<string, unknown>;
    const existing = String(data.resultPath ?? '');
    if (existing && fileExists(existing)) continue; // 已经导出成功
    const shotIds = timelineShotIds(node, snap.edges);
    if (!shotIds.length) continue;
    const clips: TimelineClip[] = [];
    let ready = true;
    for (const id of shotIds) {
      const shot = byId.get(id);
      const path = String((shot?.data as Record<string, unknown> | undefined)?.resultPath ?? '');
      if (!shot || shot.kind !== 'shot' || !path || !fileExists(path)) {
        ready = false;
        break;
      }
      clips.push({ path, label: shot.label, nodeId: shot.id });
    }
    if (!ready) continue;
    const signature = `${shotIds.join('>')}|${clips.map((c) => c.path).join('>')}`;
    const base: TimelineExportRequest = {
      projectId: snap.projectId,
      clips: [],
      outputName: node.label || 'timeline',
    };
    const sequence = Array.isArray(data.sequence) ? data.sequence : undefined;
    const request: TimelineExportRequest = sequence?.length
      ? {
          ...base,
          clips: [],
          sequence: sequence as TimelineExportRequest['sequence'],
          transitions: data.transitions as TimelineExportRequest['transitions'],
          audio: data.audio as TimelineExportRequest['audio'],
          exportPreset: data.exportPreset as TimelineExportRequest['exportPreset'],
        }
      : { ...base, clips };
    out.push({ timelineId: node.id, label: node.label || node.id, clips, request, signature });
  }
  return out;
}

export class TimelineExportCoordinator {
  private attempts = new Map<string, { signature: string; status: 'running' | 'succeeded' | 'failed' }>();
  private inFlight = new Set<string>();
  private readonly pollMs: number;
  private readonly maxWaitMs: number;

  constructor(
    private store: StoreLike,
    private exportSvc: ExportLike,
    private logger?: LoggerLike,
    opts: TimelineExportCoordinatorOptions = {},
  ) {
    this.pollMs = opts.pollMs ?? 1000;
    this.maxWaitMs = opts.maxWaitMs ?? 30 * 60_000;
  }

  /** 画布保存后调用(不 await,不阻塞保存链路) */
  onCanvasSaved(snap: CanvasSnapshot): void {
    this.check(snap);
  }

  /** 启动时扫一遍:App 重启前已经齐备但未导出的时间线也补收口 */
  async scanAll(): Promise<void> {
    for (const project of this.store.listProjects()) {
      const pc = this.store.loadProjectCanvases(project.id);
      for (const canvas of pc.canvases) {
        this.check({ ...canvas, projectId: project.id });
      }
    }
  }

  /**
   * 手动导出某条时间线(Agent timeline.export / 渲染层入口)。
   * 与自动导出共用同一份 clips 顺序与结果回写。
   */
  async exportNode(projectId: string, canvasId: string, nodeId: string, outputName?: string): Promise<{ taskId: string; clipCount: number }> {
    const snap = this.store.loadProjectCanvases(projectId).canvases.find((c) => c.id === canvasId);
    if (!snap) throw new Error('画布不存在');
    const node = snap.nodes.find((n) => n.id === nodeId);
    if (!node || node.kind !== 'timeline') throw new Error(`节点 ${nodeId} 不是时间线`);
    const shotIds = timelineShotIds(node, snap.edges);
    if (!shotIds.length) throw new Error('时间线没有入轨镜头');
    const byId = new Map(snap.nodes.map((n) => [n.id, n]));
    const clips: TimelineClip[] = [];
    const missing: string[] = [];
    for (const id of shotIds) {
      const shot = byId.get(id);
      const path = String((shot?.data as Record<string, unknown> | undefined)?.resultPath ?? '');
      if (!shot || shot.kind !== 'shot' || !path || !existsSync(path)) {
        missing.push(shot?.label || id);
        continue;
      }
      clips.push({ path, label: shot.label, nodeId: shot.id });
    }
    if (missing.length) throw new Error(`时间线缺少可用成片:${missing.join('、')}。请先等这些镜头生成完成。`);
    const data = (node.data ?? {}) as Record<string, unknown>;
    const request: TimelineExportRequest = Array.isArray(data.sequence) && data.sequence.length
      ? {
          projectId,
          clips: [],
          sequence: data.sequence as TimelineExportRequest['sequence'],
          transitions: data.transitions as TimelineExportRequest['transitions'],
          audio: data.audio as TimelineExportRequest['audio'],
          exportPreset: data.exportPreset as TimelineExportRequest['exportPreset'],
          outputName: outputName || node.label || 'timeline',
        }
      : { projectId, clips, outputName: outputName || node.label || 'timeline' };
    return this.start(projectId, canvasId, node.id, node.label || node.id, request, clips.length);
  }

  private check(snap: CanvasSnapshot): void {
    const ready = collectReadyTimelineExports(snap);
    for (const item of ready) {
      if (this.inFlight.has(item.timelineId)) continue;
      const prev = this.attempts.get(item.timelineId);
      // running/succeeded:同一签名不重复;failed:同一输入不自动重试,避免每次保存都烧 ffmpeg。
      if (prev?.signature === item.signature && prev.status !== 'failed') continue;
      if (prev?.signature === item.signature && prev.status === 'failed') continue;
      void this.start(snap.projectId, snap.id, item.timelineId, item.label, item.request, item.clips.length, item.signature);
    }
  }

  private async start(
    projectId: string,
    canvasId: string,
    timelineId: string,
    label: string,
    request: TimelineExportRequest,
    clipCount: number,
    signature?: string,
  ): Promise<{ taskId: string; clipCount: number }> {
    this.inFlight.add(timelineId);
    if (signature) this.attempts.set(timelineId, { signature, status: 'running' });
    try {
      const { taskId } = this.exportSvc.submit(request);
      this.logger?.log('info', `[timeline] 自动导出「${label}」· ${clipCount} 个片段 · ${taskId}`);
      void this.watch(projectId, canvasId, timelineId, label, taskId, signature);
      return { taskId, clipCount };
    } catch (e) {
      if (signature) this.attempts.set(timelineId, { signature, status: 'failed' });
      this.inFlight.delete(timelineId);
      this.logger?.log('error', `[timeline] 导出提交失败「${label}」:${(e as Error).message}`);
      throw e;
    }
  }

  private async watch(
    projectId: string,
    canvasId: string,
    timelineId: string,
    label: string,
    taskId: string,
    signature?: string,
  ): Promise<void> {
    const started = Date.now();
    try {
      for (;;) {
        const task = this.exportSvc.status(taskId);
        if (task.status === 'succeeded' && task.outputPath) {
          if (signature) this.attempts.set(timelineId, { signature, status: 'succeeded' });
          this.writeBack(projectId, timelineId, task.outputPath, taskId);
          this.logger?.log('info', `[timeline] 成片已生成「${label}」→ ${task.outputPath}`);
          return;
        }
        if (task.status === 'failed') {
          if (signature) this.attempts.set(timelineId, { signature, status: 'failed' });
          this.logger?.log('error', `[timeline] 导出失败「${label}」:${task.error ?? '未知错误'}`);
          return;
        }
        if (Date.now() - started > this.maxWaitMs) {
          if (signature) this.attempts.set(timelineId, { signature, status: 'failed' });
          this.logger?.log('error', `[timeline] 导出超时「${label}」`);
          return;
        }
        await new Promise((r) => setTimeout(r, this.pollMs));
      }
    } finally {
      this.inFlight.delete(timelineId);
    }
  }

  /** 重载最新快照再写 resultPath;版本冲突重试 3 次,不覆盖其他并发画布改动。 */
  private writeBack(projectId: string, timelineId: string, outputPath: string, taskId: string): void {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pc = this.store.loadProjectCanvases(projectId);
      const canvas = pc.canvases.find((c) => c.nodes.some((n) => n.id === timelineId));
      if (!canvas) return;
      const node = canvas.nodes.find((n) => n.id === timelineId);
      if (!node) return;
      node.data = {
        ...(node.data as Record<string, unknown>),
        resultPath: outputPath,
        exportTaskId: taskId,
        exportedAt: new Date().toISOString(),
      } as CanvasNode['data'];
      canvas.version = (canvas.version ?? 0) + 1;
      canvas.updatedAt = new Date().toISOString();
      const saved = this.store.saveCanvasSnapshot(canvas);
      if (saved.ok !== false) return;
    }
    this.logger?.log('error', `[timeline] 成片路径写回失败(快照连续冲突):${outputPath}`);
  }
}
