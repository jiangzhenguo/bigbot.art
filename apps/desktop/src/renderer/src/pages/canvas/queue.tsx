import React from 'react';
import type { RenderJob } from '@bigbotart/shared';
import type { CanvasNode } from './types';

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
