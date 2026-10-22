/**
 * QueueBar — 画布底部队列状态条
 *
 * 点击打开队列面板:列出排队/运行中任务,可取消单个或全部取消。
 */
import React, { useEffect, useRef, useState } from 'react';
import type { RenderJob } from '@bigbotart/shared';
import type { CanvasNode } from './types';
import {
  activeQueueJobs,
  cancelAllQueueJobs,
  cancelQueueJob,
  jobNodeTitle,
  jobStatusLabel,
  queueItem,
  slotLabel,
} from './queue';

interface QueueBarProps {
  jobs: RenderJob[];
  nodes: CanvasNode[];
}

export function QueueBar({ jobs, nodes }: QueueBarProps) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancellingAll, setCancellingAll] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const active = activeQueueJobs(jobs);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onCancelOne = async (job: RenderJob, e: React.MouseEvent) => {
    e.stopPropagation();
    if (busyId || cancellingAll) return;
    setBusyId(job.id);
    try {
      await cancelQueueJob(job);
    } finally {
      setBusyId(null);
    }
  };

  const onCancelAll = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!active.length || cancellingAll) return;
    setCancellingAll(true);
    try {
      await cancelAllQueueJobs(jobs);
    } finally {
      setCancellingAll(false);
    }
  };

  return (
    <footer
      ref={rootRef}
      className={`queue${open ? ' open' : ''}`}
      data-od-id="canvas-queue"
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-label="打开渲染队列"
      title="点击查看队列任务"
      onClick={() => setOpen((v) => !v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setOpen((v) => !v);
        }
      }}
    >
      <span className="lbl">队列{active.length ? ` · ${active.length}` : ''}</span>
      {queueItem('video', jobs, nodes)}
      {queueItem('image', jobs, nodes)}
      <span className="spacer"></span>
      <span className="queue-hint mono mut">{open ? '收起' : '查看'}</span>

      {open ? (
        <div
          className="queue-panel"
          data-od-id="canvas-queue-panel"
          role="dialog"
          aria-label="渲染队列"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="queue-panel-h">
            <b>渲染队列</b>
            <span className="mono mut">{active.length ? `${active.length} 个进行中` : '空闲'}</span>
            <span className="spacer"></span>
            {active.length ? (
              <button
                type="button"
                className="btn btn-s btn-sm"
                disabled={cancellingAll}
                onClick={onCancelAll}
                data-od-id="queue-cancel-all"
              >
                {cancellingAll ? '取消中…' : '全部取消'}
              </button>
            ) : null}
            <button type="button" className="btn btn-s btn-sm" onClick={() => setOpen(false)}>
              关闭
            </button>
          </div>

          {active.length === 0 ? (
            <div className="queue-empty mut">暂无排队或运行中的任务</div>
          ) : (
            <ul className="queue-list">
              {active.map((job) => {
                const pct = Math.round((job.progress ?? 0) * 100);
                const running = job.status === 'running';
                return (
                  <li key={job.id} className="queue-row" data-od-id={`queue-job-${job.id}`}>
                    <span className="dot" style={{ background: running ? 'var(--warn)' : 'var(--meta)' }} />
                    <div className="queue-row-main">
                      <div className="queue-row-title">
                        <b>{jobNodeTitle(job, nodes)}</b>
                        <span className="mono mut">
                          {slotLabel(job.slot)} · {job.provider}
                        </span>
                      </div>
                      <div className="queue-row-sub mono mut">
                        {jobStatusLabel(job)}
                        {running ? ` · ${pct}%` : null}
                      </div>
                      {running ? (
                        <span className="pbar queue-row-bar">
                          <i style={{ width: `${pct}%` }} />
                        </span>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="btn btn-s btn-sm"
                      disabled={busyId === job.id || cancellingAll}
                      onClick={(e) => void onCancelOne(job, e)}
                      data-od-id={`queue-cancel-${job.id}`}
                    >
                      {busyId === job.id ? '…' : '取消'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </footer>
  );
}
