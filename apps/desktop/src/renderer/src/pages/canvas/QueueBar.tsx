/**
 * QueueBar — 画布底部队列状态条(纯展示)
 *
 * 拆分自 CanvasPage 的 <footer class="queue"> 区块;槽位内容来自 canvas/queue.tsx。
 */
import React from 'react';
import type { RenderJob } from '@bigbotart/shared';
import type { CanvasNode } from './types';
import { queueItem } from './queue';

interface QueueBarProps {
  jobs: RenderJob[];
  nodes: CanvasNode[];
}

export function QueueBar({ jobs, nodes }: QueueBarProps) {
  return (
    <footer className="queue" data-od-id="canvas-queue">
      <span className="lbl">队列</span>
      {queueItem('video', jobs, nodes)}
      {queueItem('image', jobs, nodes)}
      <span className="spacer"></span>
    </footer>
  );
}