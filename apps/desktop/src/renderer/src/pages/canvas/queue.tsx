/**
 * 画布底部队列条 — 槽位摘要 + 队列面板用的纯函数
 */
import React from 'react';
import type { RenderJob } from '@bigbotart/shared';
import type { CanvasNode } from './types';

/** 排队中 + 运行中(用户要看/可取消的任务) */
export function activeQueueJobs(jobs: RenderJob[]): RenderJob[] {
  return jobs
    .filter((j) => j.status === 'queued' || j.status === 'running')
    .sort((a, b) => {
      if (a.status === 'running' && b.status !== 'running') return -1;
      if (b.status === 'running' && a.status !== 'running') return 1;
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    });
}

export function jobNodeTitle(job: RenderJob, nodes: CanvasNode[]): string {
  return nodes.find((n) => n.id === job.nodeId)?.title || job.nodeId;
}

export function slotLabel(slot: RenderJob['slot']): string {
  if (slot === 'video') return '视频';
  if (slot === 'image') return '图片';
  return slot;
}

export function jobStatusLabel(job: RenderJob): string {
  if (job.status === 'running') return job.stage?.trim() || '生成中…';
  if (job.status === 'queued') return '排队中';
  return job.status;
}

/** 取消单个任务(job.id 即队列侧 handle.providerTaskId) */
export async function cancelQueueJob(job: RenderJob): Promise<void> {
  await window.bigbotart.cancelRender(job.provider, { providerTaskId: job.id });
}

/** 先清排队、再杀运行中,避免放行下一个又被立刻取消的抖动 */
export async function cancelAllQueueJobs(jobs: RenderJob[]): Promise<number> {
  const active = activeQueueJobs(jobs);
  let n = 0;
  for (const j of active.filter((x) => x.status === 'queued')) {
    await cancelQueueJob(j);
    n++;
  }
  for (const j of active.filter((x) => x.status === 'running')) {
    await cancelQueueJob(j);
    n++;
  }
  return n;
}

/** 队列条:单个槽位(视频/图片)的当前任务 */
export function queueItem(slot: 'video' | 'image', jobs: RenderJob[], nodes: CanvasNode[]): React.ReactNode {
  const job = jobs.find((j) => j.slot === slot && (j.status === 'running' || j.status === 'queued'));
  const node = job ? nodes.find((n) => n.id === job.nodeId) : undefined;
  const running = job?.status === 'running';
  const label = slot === 'video' ? '视频槽位' : '图片槽位';
  if (!job) {
    return (
      <span className="qitem mut">
        <span className="dot ok"></span>
        {label}：空闲
      </span>
    );
  }
  return (
    <span className="qitem">
      <span className="dot" style={{ background: 'var(--warn)' }}></span>
      {label}：{node?.title ?? job.nodeId}
      {running ? (
        <span className="pbar" style={{ width: 110 }}>
          <i style={{ width: `${Math.round((job.progress ?? 0) * 100)}%` }}></i>
        </span>
      ) : null}
      <span className="mono mut">{running ? (job.stage ?? '等待引擎…') : '排队中'}</span>
    </span>
  );
}
