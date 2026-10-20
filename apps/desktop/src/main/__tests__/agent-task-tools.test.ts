/**
 * 任务清单与多镜真跑确认的工具接线。
 * 清单进画布记忆并在下一轮系统提示里出现;两镜未出片时 engine.submit 被拒绝,
 * 用户点「按此执行」且镜头集合没变才放行。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-agent-task-'));
process.env.BIGBOTART_HOME = tmpHome;

let ToolHandlers: typeof import('../tool-handlers.js').ToolHandlers;
let MemoryStore: typeof import('../memory.js').MemoryStore;

beforeAll(async () => {
  ({ ToolHandlers } = await import('../tool-handlers.js'));
  ({ MemoryStore } = await import('../memory.js'));
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

let seq = 0;

function shot(id: string, label: string, resultPath?: string) {
  return {
    id,
    kind: 'shot' as const,
    label,
    position: { x: 0, y: 0 },
    data: resultPath ? { prompt: '已有', resultPath } : { prompt: '' },
    createdAt: '',
    updatedAt: '',
  };
}

function handlers(nodes: ReturnType<typeof shot>[]) {
  const ctx = { projectId: `p-task-${seq++}`, canvasId: 'c-task' };
  const memory = new MemoryStore();
  const store = {
    loadProjectCanvases: () => ({
      projectId: ctx.projectId,
      canvases: [{ id: ctx.canvasId, name: '主画布', version: 1, nodes, edges: [] }],
    }),
    saveCanvasSnapshot: () => ({ ok: true }),
  };
  const queue = { list: () => [] };
  const h = new ToolHandlers(store as never, {} as never, {} as never, {} as never, queue as never, memory);
  return { h, memory, ctx };
}

describe('todo.write', () => {
  it('整表写入记忆,下一轮系统提示能看见未完成项', async () => {
    const { h, memory, ctx } = handlers([]);
    const r = await h.call('todo.write', {
      todos: [
        { content: '出锚定图', status: 'in_progress' },
        { content: '写镜头提示词', status: 'pending' },
      ],
    }, ctx);
    expect(r.ok).toBe(true);
    expect(r.result).toContain('进行中 1');
    const prompt = memory.buildContext(ctx.projectId, ctx.canvasId, '继续').systemPrompt;
    expect(prompt).toContain('【当前任务清单】');
    expect(prompt.indexOf('进行中:出锚定图')).toBeLessThan(prompt.indexOf('待办:写镜头提示词'));
  });

  it('两项同时进行会被拒绝,记忆保持空', async () => {
    const { h, memory, ctx } = handlers([]);
    const r = await h.call('todo.write', {
      todos: [
        { content: '甲', status: 'in_progress' },
        { content: '乙', status: 'in_progress' },
      ],
    }, ctx);
    expect(r.ok).toBe(false);
    expect(memory.buildContext(ctx.projectId, ctx.canvasId, '继续').systemPrompt).not.toContain('【当前任务清单】');
  });
});

describe('plan.present 与 engine.submit', () => {
  const plan = '# 出片\n\n提交镜头 01 和镜头 02,不新建别的节点。';

  it('两镜未点头时拒绝提交,单镜不拦', async () => {
    const two = handlers([shot('a', '镜头 01'), shot('b', '镜头 02')]);
    const blocked = await two.h.call('engine.submit', { nodeId: 'a' }, two.ctx);
    expect(blocked.ok).toBe(false);
    expect(blocked.result).toContain('plan.present');

    const one = handlers([shot('a', '镜头 01')]);
    const passed = await one.h.call('engine.submit', { nodeId: 'a' }, one.ctx);
    expect(passed.result).not.toContain('plan.present');
    expect(passed.result).toContain('提示词为空');
  });

  it('点头且镜头没变才放行;再交一份计划会作废旧批准', async () => {
    const { h, memory, ctx } = handlers([shot('a', '镜头 01'), shot('b', '镜头 02')]);
    const presented = await h.call('plan.present', { markdown: plan }, ctx);
    expect(presented.ok).toBe(true);
    expect(presented.result).toContain('镜头 01');

    const still = await h.call('engine.submit', { nodeId: 'a' }, ctx);
    expect(still.ok).toBe(false);

    const approved = memory.tryApproveShotPlan(ctx.projectId, ctx.canvasId, ['a', 'b']);
    expect(approved.ok).toBe(true);
    const go = await h.call('engine.submit', { nodeId: 'a' }, ctx);
    expect(go.result).toContain('提示词为空');
    expect(go.result).not.toContain('plan.present');

    await h.call('plan.present', { markdown: plan }, ctx);
    const again = await h.call('engine.submit', { nodeId: 'b' }, ctx);
    expect(again.result).toContain('plan.present');
  });

  it('未满两镜时 plan.present 拒绝,且不留下待确认计划', async () => {
    const { h, memory, ctx } = handlers([shot('a', '镜头 01')]);
    const r = await h.call('plan.present', { markdown: plan }, ctx);
    expect(r.ok).toBe(false);
    expect(memory.tryApproveShotPlan(ctx.projectId, ctx.canvasId, ['a'])).toEqual({ ok: false, silent: true });
  });
});
