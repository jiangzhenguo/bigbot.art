import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@bigbotart/shared';
import { AgentManager } from '../manager.js';

describe('AgentManager · 工具事件身份与路由', () => {
  it('tool-start/end 带稳定 eventId 与请求自己的 threadId', async () => {
    const workerEntry = fileURLToPath(new URL('./fixtures/tool-worker.mjs', import.meta.url));
    const manager = new AgentManager({ workerEntry });
    const events: AgentEvent[] = [];
    manager.onEvent = (ev) => events.push(ev);
    manager.toolExecutor = async (req) => {
      expect(req.params.threadId).toBe('thread-1');
      return { id: req.id, result: { ok: true, result: '节点 A' } };
    };

    try {
      const result = await manager.chat({
        projectId: 'p1',
        canvasId: 'c1',
        threadId: 'thread-1',
        text: '查节点',
        context: { systemPrompt: 'sys', messages: [] },
      });
      expect(result.reply).toBe('工具完成');
      expect(events.map((e) => e.kind)).toEqual(['tool-start', 'tool-end']);
      expect(events.map((e) => e.eventId)).toEqual(['tool:99:start', 'tool:99:end']);
      expect(events.every((e) => e.threadId === 'thread-1')).toBe(true);
    } finally {
      await manager.stop();
    }
  });
});
