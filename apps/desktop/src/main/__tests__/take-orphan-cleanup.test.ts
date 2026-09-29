/**
 * 孤儿 Take 清理测试 —— 「Take 永久停在排队中」事故回归(2026-09-29)
 *
 * 事故形态:`RenderQueue` 的 jobs 是**纯内存**数组,应用退出/崩溃后队列丢失,但 Take 记录
 * 已由提交方 `takesCreate(queued)` 写进磁盘 → 下次启动这些 Take 永远停在 `queued`/`running`。
 * 检查器里显示成「排队中」永不消失,用户以为任务还在跑(实际早随进程一起消失)。
 * 真实触发:生成过程中重启应用。
 *
 * 清理语义:进程已不可能再更新这些 Take → 标记为 `failed` 并写明原因(比「排队中」诚实,
 * 符合红线 R6 不静默吞);**不动已终态的 Take**,也不删产物文件。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;
type Mod = typeof import('../takes');
let mod: Mod;

beforeAll(async () => {
  // takes.ts 的 DATA_DIR 在模块加载时读 env —— 动态 import 前设好隔离目录
  home = mkdtempSync(join(tmpdir(), 'bbart-orphan-'));
  process.env.BIGBOTART_HOME = home;
  mod = await import('../takes');
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

/** 每个用例用独立项目 id,避免共享 store 的磁盘状态互相污染 */
let seq = 0;
const P = () => `proj-test-${++seq}`;

describe('TakeStore.reconcileOrphaned · 清理重启前残留的未完成 Take', () => {
  it('queued T5 → 标为 failed 并写明原因(不再显示「排队中」)', () => {
    const pid = P();
    const store = new mod.TakeStore();
    store.append(pid, { shotNodeId: 'n1', status: 'queued', params: {} });
    const doc = store.list(pid);
    expect(doc).toHaveLength(1);
    expect(doc[0]!.status).toBe('queued');

    const r = store.reconcileOrphaned([pid]);

    expect(r.cleaned).toBe(1);
    expect(r.details[0]!.from).toBe('queued');
    const after = store.list(pid)[0]!;
    expect(after.status).toBe('failed');
    expect(after.error).toContain('应用已重启');
    expect(after.finishedAt).toBeTruthy();
  });

  it('running 同样被清理', () => {
    const pid = P();
    const store = new mod.TakeStore();
    store.append(pid, { shotNodeId: 'n1', status: 'running', params: {} });

    const r = store.reconcileOrphaned([pid]);

    expect(r.cleaned).toBe(1);
    expect(r.details[0]!.from).toBe('running');
    expect(store.list(pid)[0]!.status).toBe('failed');
  });

  it('**已终态的 Take 一律不动**(成功记录必须保住)', () => {
    const pid = P();
    const store = new mod.TakeStore();
    store.append(pid, { shotNodeId: 'n1', status: 'succeeded', params: {}, resultPath: '/out/a.png' });
    store.append(pid, { shotNodeId: 'n1', status: 'failed', params: {}, error: '原错误' });
    store.append(pid, { shotNodeId: 'n1', status: 'queued', params: {} });

    const r = store.reconcileOrphaned([pid]);

    expect(r.cleaned).toBe(1); // 只有那条 queued
    const list = store.list(pid);
    const ok = list.find((t) => t.status === 'succeeded')!;
    expect(ok.resultPath).toBe('/out/a.png'); // 成功记录与产物路径完好
    const failed = list.find((t) => t.error === '原错误')!;
    expect(failed.error).toBe('原错误'); // 原失败原因不被覆盖
  });

  it('没有孤儿时不写盘(clean 为 0,不制造无意义 IO)', () => {
    const pid = P();
    const store = new mod.TakeStore();
    store.append(pid, { shotNodeId: 'n1', status: 'succeeded', params: {}, resultPath: '/a.png' })
    const r = store.reconcileOrphaned([pid]);
    expect(r.cleaned).toBe(0);
    expect(r.details).toEqual([]);
  });

  it('多个项目一次清理,互不影响', () => {
    const pidA = P();
    const pidB = P();
    const store = new mod.TakeStore();
    store.append(pidA, { shotNodeId: 'n1', status: 'queued', params: {} });
    store.append(pidB, { shotNodeId: 'n2', status: 'running', params: {} });
    store.append(pidB, { shotNodeId: 'n2', status: 'succeeded', params: {}, resultPath: '/b.png' });

    const r = store.reconcileOrphaned([pidA, pidB]);

    expect(r.cleaned).toBe(2);
    expect(store.list(pidA)[0]!.status).toBe('failed');
    expect(store.list(pidB).find((t) => t.status === 'succeeded')).toBeTruthy();
  });

  it('不存在的项目 id 不抛错(容错)', () => {
    const store = new mod.TakeStore();
    expect(() => store.reconcileOrphaned(['nope-1', 'nope-2'])).not.toThrow();
    expect(store.reconcileOrphaned(['nope-1']).cleaned).toBe(0);
  });

  it('清理结果落盘:新实例重新加载仍是 failed(不是只改内存)', () => {
    const pid = P();
    const store = new mod.TakeStore();
    store.append(pid, { shotNodeId: 'n1', status: 'queued', params: {} });
    store.reconcileOrphaned([pid]);

    // 新实例(清空内存缓存)重新读盘
    const fresh = new mod.TakeStore();
    expect(fresh.list(pid)[0]!.status).toBe('failed');
    expect(existsSync(join(home, 'workspaces', pid, 'takes.json'))).toBe(true);
  });
});
