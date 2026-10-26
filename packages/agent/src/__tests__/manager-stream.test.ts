import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@bigbotart/shared';
import { AgentManager } from '../manager.js';

describe('AgentManager · worker 流式通知', () => {
  it('delta 经 onEvent 有序转发且不提前 resolve;最终响应仍只返回一次', async () => {
    const workerEntry = fileURLToPath(new URL('./fixtures/stream-worker.mjs', import.meta.url));
    const manager = new AgentManager({ workerEntry });
    const events: AgentEvent[] = [];
    let notifyFirstText!: () => void;
    const firstText = new Promise<void>((resolve) => { notifyFirstText = resolve; });
    manager.onEvent = (ev) => {
      events.push(ev);
      if (ev.kind === 'text-delta') notifyFirstText();
    };

    let settled = false;
    const pending = manager.chat({
      projectId: 'p1',
      canvasId: 'c1',
      threadId: 'thread-1',
      text: '你好',
      context: { systemPrompt: 'sys', messages: [] },
    }).then((result) => {
      settled = true;
      return result;
    });

    try {
      await firstText;
      expect(settled).toBe(false);
      const result = await pending;
      expect(result.reply).toBe('你好');
      expect(events.map((e) => e.kind)).toEqual(['round-start', 'thinking-delta', 'text-delta', 'text-delta']);
      expect(events.filter((e) => e.kind === 'text-delta').map((e) => e.delta)).toEqual(['你', '好']);
      expect(events.every((e) => e.projectId === 'p1' && e.canvasId === 'c1' && e.threadId === 'thread-1')).toBe(true);
      expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
      expect(events.every((e) => /^\d+:\d+$/.test(e.eventId ?? ''))).toBe(true);
    } finally {
      await manager.stop();
    }
  });
});
