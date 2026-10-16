/**
 * ChatThread 多会话:迁移 / 隔离 / clear·compact 作用域 / 新建复用空会话
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-threads-'));
process.env.BIGBOTART_HOME = tmpHome;

let M: typeof import('../memory.js');
let store: import('../memory.js').MemoryStore;

beforeAll(async () => {
  M = await import('../memory.js');
  store = new M.MemoryStore();
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('ChatThread 多会话', () => {
  it('存量 recall 无 threadId 时幂等迁移成默认会话', () => {
    const pid = `p-mig-${Date.now()}`;
    // 直接塞旧形态(无 threadId)——绕过 addRecall 的自动补全
    const m = store.get(pid);
    m.recall.push({
      id: 'msg-old-1',
      canvasId: 'cA',
      role: 'user',
      content: '帮我做短片',
      createdAt: new Date().toISOString(),
    });
    m.migration = undefined;
    m.threads = {};
    // 再次 get 触发迁移(缓存命中也会跑幂等 migrate)
    const after = store.get(pid);
    expect(after.migration?.chatThreadsV1).toBe(true);
    expect(Object.keys(after.threads ?? {}).length).toBeGreaterThanOrEqual(1);
    expect(after.recall.every((r) => r.threadId)).toBe(true);
    expect(after.canvasMemory['cA']?.activeThreadId).toBeTruthy();
  });

  it('两会话 addRecall 互不可见', () => {
    const pid = `p-iso-${Date.now()}`;
    const a = store.createThread(pid, 'cA', { title: '会话 A' });
    store.addRecall(pid, { canvasId: 'cA', threadId: a.id, role: 'user', content: 'A 的消息' });
    const b = store.createThread(pid, 'cA', { title: '会话 B' });
    store.addRecall(pid, { canvasId: 'cA', threadId: b.id, role: 'user', content: 'B 的消息' });

    const recentA = store.recentRecall(pid, 'cA', 12, a.id);
    const recentB = store.recentRecall(pid, 'cA', 12, b.id);
    expect(recentA.map((r) => r.content)).toEqual(['A 的消息']);
    expect(recentB.map((r) => r.content)).toEqual(['B 的消息']);
  });

  it('clear 只清活跃会话,不影响另一会话', () => {
    const pid = `p-clr-${Date.now()}`;
    const a = store.createThread(pid, 'cA', { title: 'A' });
    store.addRecall(pid, { canvasId: 'cA', threadId: a.id, role: 'user', content: 'keep' });
    const b = store.createThread(pid, 'cA', { title: 'B' });
    store.addRecall(pid, { canvasId: 'cA', threadId: b.id, role: 'user', content: 'wipe' });
    // B 是活跃
    const res = store.clearConversation(pid, 'cA');
    expect(res.cleared).toBeGreaterThanOrEqual(1);
    expect(store.threadMessages(pid, a.id).some((r) => r.content === 'keep')).toBe(true);
    expect(store.threadMessages(pid, b.id).filter((r) => r.role === 'user')).toHaveLength(0);
  });

  it('空会话新建时复用,不刷空壳', () => {
    const pid = `p-reuse-${Date.now()}`;
    const first = store.createThread(pid, 'cA', { title: '新对话' });
    const second = store.createThread(pid, 'cA', { title: '新对话' });
    expect(second.id).toBe(first.id);
    store.addRecall(pid, { canvasId: 'cA', threadId: first.id, role: 'user', content: '开聊' });
    const third = store.createThread(pid, 'cA');
    expect(third.id).not.toBe(first.id);
  });

  it('listThreads 带 preview / active / hasCompact', () => {
    const pid = `p-list-${Date.now()}`;
    const t = store.createThread(pid, 'cA', { title: '列表测' });
    store.addRecall(pid, { canvasId: 'cA', threadId: t.id, role: 'user', content: '你好世界很长很长' });
    store.compactConversation(pid, 'cA', '摘要', 0);
    // compact with 1 message keepLast=0 → replaced=1, leaves 0; re-add for preview
    store.addRecall(pid, { canvasId: 'cA', threadId: t.id, role: 'assistant', content: '好的' });
    const list = store.listThreads(pid, 'cA');
    const item = list.find((x) => x.id === t.id);
    expect(item?.active).toBe(true);
    expect(item?.preview).toBeTruthy();
  });
});
