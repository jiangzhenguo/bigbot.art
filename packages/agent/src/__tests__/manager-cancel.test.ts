import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@bigbotart/shared';
import { AgentManager } from '../manager.js';

describe('AgentManager · 立即停止', () => {
  it('worker 不响应 cancel 也立即结束 chat;旧 worker 的迟到流/工具事件不再进入 UI', async () => {
    const workerEntry = fileURLToPath(new URL('./fixtures/cancel-worker.mjs', import.meta.url));
    const manager = new AgentManager({ workerEntry });
    const events: AgentEvent[] = [];
    let notifyRound!: () => void;
    const round = new Promise<void>((resolve) => { notifyRound = resolve; });
    manager.onEvent = (ev) => {
      events.push(ev);
      if (ev.kind === 'round-start') notifyRound();
    };
    const pending = manager.chat({
      projectId: 'p1', canvasId: 'c1', threadId: 'thread-1', text: '长任务',
      context: { systemPrompt: 'sys', messages: [] },
    });
    try {
      await round;
      const before = Date.now();
      const cancel = await manager.cancel();
      expect(cancel.ok).toBe(true);
      const result = await Promise.race([
        pending,
        new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), 500)),
      ]);
      expect(result).not.toEqual({ timeout: true });
      expect(result).toMatchObject({ aborted: true });
      expect(Date.now() - before).toBeLessThan(500);
      expect(manager.status().running).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 180));
      expect(events.some((e) => e.kind === 'text-delta')).toBe(false);
      expect(events.some((e) => e.kind === 'tool-start' || e.kind === 'tool-end')).toBe(false);

      // 下一次任务自动起新 worker,不复用已取消进程。
      const started = await manager.start();
      expect(started.running).toBe(true);
    } finally {
      await manager.stop();
    }
  });
});
