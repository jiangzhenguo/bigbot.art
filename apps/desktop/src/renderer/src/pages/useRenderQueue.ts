/**
 * useRenderQueue — 首页队列状态订阅(容器/展示分离 §5.2)
 *
 * 主进程 RenderQueue(apps/desktop/src/main/render-queue.ts)是真实实现:
 * FIFO 串行 + 2s 进度轮询,每次 提交/进度 tick/完成/取消 都经 onChange
 * 去抖推送精简视图。这里只做三件事:挂载拉全量 queueStatus()、
 * 订阅 onQueueChanged 推送、卸载退订;另加低频轮询兜底(事件丢失防护,
 * 对齐 CanvasPage 的 8s 轮询先例)。
 */
import { useEffect, useState } from 'react';
import type { RenderJob } from '@bigbotart/shared';

/** 兜底轮询间隔(主进程事件推送为主,10s 一次足够) */
const POLL_MS = 10_000;

export interface RenderQueueSnapshot {
  /** 全量任务(含历史终态;精简视图,无请求参数) */
  jobs: RenderJob[];
  /** 当前运行中的任务(全局同一时刻至多一个) */
  running: RenderJob | null;
  /** 排队中任务数 */
  queued: number;
  /** 活跃任务数(running + queued) */
  active: number;
}

export function useRenderQueue(): RenderQueueSnapshot {
  const [jobs, setJobs] = useState<RenderJob[]>([]);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const list = await window.bigbotart.queueStatus();
        if (alive) setJobs(list);
      } catch {
        /* 轮询失败静默:主进程事件推送是主通道,轮询仅兜底 */
      }
    };
    const unsub = window.bigbotart.onQueueChanged((list) => {
      if (alive) setJobs(list);
    });
    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      unsub();
      window.clearInterval(timer);
    };
  }, []);

  const running = jobs.find((j) => j.status === 'running') ?? null;
  const queued = jobs.filter((j) => j.status === 'queued').length;
  return { jobs, running, queued, active: running ? queued + 1 : queued };
}