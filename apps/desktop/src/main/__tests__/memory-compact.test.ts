/**
 * MemoryStore clearConversation / compactConversation 单测(主进程 memory.ts)
 * - /clear:清空画布对话 recall + 对话压缩摘要(节点总结 summary 保留)
 * - /compact:裁剪旧消息为摘要(保留最近 keepLast 条),摘要合并进 conversationSummary
 * - buildContext:压缩摘要以「本画布对话摘要(已压缩)」注入
 *
 * 关键:memory.ts 的 DATA_DIR 在 import 时按 BIGBOTART_HOME 求值 →
 * 模块顶层先设临时目录,再在 beforeAll 里动态 import(绝不触碰真实 ~/.bigbotart)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-memory-test-'));
process.env.BIGBOTART_HOME = tmpHome;

/** 造一条 recall:canvasId + 序号,便于断言裁剪数量 */
function recallMessage(canvasId: string, i: number) {
  return {
    canvasId,
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `消息 ${i} · ${canvasId}`,
  };
}

let M: typeof import('../memory.js');
let store: import('../memory.js').MemoryStore;

beforeAll(async () => {
  M = await import('../memory.js');
  store = new M.MemoryStore();
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('MemoryStore.clearConversation(/clear)', () => {
  it('清空指定画布的 recall,其他画布不受影响', () => {
    const pid = `p-clear-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    for (let i = 1; i <= 5; i++) store.addRecall(pid, recallMessage('cA', i));
    for (let i = 1; i <= 3; i++) store.addRecall(pid, recallMessage('cB', i));

    const res = store.clearConversation(pid, 'cA');
    expect(res.cleared).toBe(5);
    expect(store.get(pid).recall.filter((r) => r.canvasId === 'cA')).toHaveLength(0);
    expect(store.get(pid).recall.filter((r) => r.canvasId === 'cB')).toHaveLength(3);
  });

  it('连同 conversationSummary 一起清除,但节点总结 summary 保留', () => {
    const pid = `p-clear2-${Date.now()}`;
    store.addRecall(pid, recallMessage('cA', 1));
    store.addRecall(pid, recallMessage('cA', 2));
    store.updateCanvasSummary(pid, 'cA', '3 个 shot 节点', 3);
    store.compactConversation(pid, 'cA', '摘要文本', 1);
    const mem = store.get(pid);
    expect(mem.canvasMemory['cA']?.conversationSummary).toBe('摘要文本');

    const res = store.clearConversation(pid, 'cA');
    expect(res.cleared).toBe(1);
    const after = store.get(pid);
    const cA = after.canvasMemory['cA'];
    expect(cA?.conversationSummary).toBeUndefined();
    expect(cA?.summary).toBe('3 个 shot 节点');
  });

  it('空画布清空返回 cleared=0', () => {
    const pid = `p-clear3-${Date.now()}`;
    const res = store.clearConversation(pid, 'cX');
    expect(res.cleared).toBe(0);
  });
});

describe('MemoryStore.compactConversation(/compact)', () => {
  it('只裁剪 keepLast 之后的消息,保留尾部承接上下文', () => {
    const pid = `p-compact-${Date.now()}`;
    for (let i = 1; i <= 12; i++) store.addRecall(pid, recallMessage('cA', i));

    const res = store.compactConversation(pid, 'cA', 'LLM 摘要', 5);
    expect(res.replaced).toBe(7);
    const left = store.get(pid).recall.filter((r) => r.canvasId === 'cA');
    expect(left).toHaveLength(5);
    // 保留的是最新的 5 条(消息 8..12)
    expect(left.at(-1)?.content).toBe('消息 12 · cA');
    expect(left[0]?.content).toBe('消息 8 · cA');
  });

  it('消息数 ≤ keepLast 时不做任何事(replaced=0,不写摘要)', () => {
    const pid = `p-compact2-${Date.now()}`;
    for (let i = 1; i <= 3; i++) store.addRecall(pid, recallMessage('cA', i));
    const res = store.compactConversation(pid, 'cA', '摘要', M.COMPACT_KEEP_LAST);
    expect(res.replaced).toBe(0);
    expect(store.get(pid).recall).toHaveLength(3);
  });

  it('多次 compact 摘要合并(追加而非覆盖)', () => {
    const pid = `p-compact3-${Date.now()}`;
    for (let i = 1; i <= 10; i++) store.addRecall(pid, recallMessage('cA', i));
    store.compactConversation(pid, 'cA', '第一段摘要', 5);
    for (let i = 11; i <= 15; i++) store.addRecall(pid, recallMessage('cA', i));
    store.compactConversation(pid, 'cA', '第二段摘要', 5);

    const cm = store.get(pid).canvasMemory['cA'];
    expect(cm?.conversationSummary).toBe('第一段摘要\n\n第二段摘要');
  });

  it('兜底摘要生成器:LLM 不可达时的确定性折叠', () => {
    const pid = `p-fallback-${Date.now()}`;
    store.addRecall(pid, { canvasId: 'cA', role: 'user', content: '帮我做一支短片' });
    store.addRecall(pid, { canvasId: 'cA', role: 'assistant', content: '好的,先出分镜表' });
    const fb = M.compactFallbackSummary(store.get(pid).recall);
    expect(fb).toContain('用户 帮我做一支短片');
    expect(fb).toContain('助手 好的,先出分镜表');
  });
});

describe('MemoryStore.buildContext 注入压缩摘要', () => {
  it('有 conversationSummary 时以「本画布对话摘要(已压缩)」注入 system prompt', () => {
    const pid = `p-ctx-${Date.now()}`;
    store.addRecall(pid, recallMessage('cA', 1));
    store.addRecall(pid, recallMessage('cA', 2));
    store.updateCanvasSummary(pid, 'cA', '画布节点总结', 2);
    store.compactConversation(pid, 'cA', '对话压缩摘要', 1);

    const ctx = store.buildContext(pid, 'cA', '继续');
    expect(ctx.systemPrompt).toContain('【本画布对话摘要(已压缩)】对话压缩摘要');
    // 当前画布节点总结不注入(只注入 conversationSummary),其他画布的 summary 走既有逻辑
  });
});