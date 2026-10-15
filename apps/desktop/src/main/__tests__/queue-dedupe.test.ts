/**
 * RenderQueue 同节点去重闸 单测(2026-10-14「技能5测试」双提交事故回归)
 *
 * 事故形态:静帧出图成功这一刻,渲染层 cascade 接力与主进程 auto-continue 唤醒的
 * Agent 对**同一个 shot** 各提交了一次(间隔约 28s),两条 h3 任务各跑几十分钟,
 * 后到者覆盖 resultPath/currentTakeId。
 *
 * 本测试锁:
 *  1. 同 nodeId 已有 queued 任务 → 再次 submit 抛错(拒绝重复入队)
 *  2. 同 nodeId 已有 running 任务 → 抛错且文案说明「正在渲染」
 *  3. 不同 nodeId 不受影响
 *  4. 在途任务被取消(queued → cancelled)后 → 允许重提
 *  5. 任务跑完(succeeded)后 → 允许重提(重跑语义不受影响)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-queue-dedupe-'));
process.env.BIGBOTART_HOME = tmpHome;

let RenderQueue: typeof import('../render-queue.js').RenderQueue;

/** status 永远 RUNNING 的 provider:让任务停在 running,不去终态 */
function makeHangingQueue() {
  const provider = {
    id: 'mlxgen',
    check: async () => ({ ready: true }),
    submit: async () => ({ providerTaskId: 'h-hang' }),
    status: async () => ({ status: 'RUNNING' as const, progress: 0.5 }),
    cancel: async () => {},
  };
  const registry = { get: () => provider } as never;
  const settings = { get: () => ({ renderMode: 'real', ssdStreaming: false }) } as never;
  return new RenderQueue(registry, settings, { log: () => {} } as never);
}

/** status 立刻 SUCCEEDED 的 provider */
function makeInstantQueue() {
  const provider = {
    id: 'mlxgen',
    check: async () => ({ ready: true }),
    submit: async () => ({ providerTaskId: 'h-fast' }),
    status: async () => ({ status: 'SUCCEEDED' as const, resultPath: join(tmpHome, 'out.png'), progress: 1 }),
    cancel: async () => {},
  };
  const registry = { get: () => provider } as never;
  const settings = { get: () => ({ renderMode: 'real', ssdStreaming: false }) } as never;
  return new RenderQueue(registry, settings, { log: () => {} } as never);
}

const req = (nodeId: string) =>
  ({ provider: 'mlxgen', nodeId, slot: 'image', params: { prompt: 'x' } }) as never;

/** 等队列里某节点进入指定状态(最多 4s) */
async function waitStatus(q: InstanceType<typeof RenderQueue>, nodeId: string, want: string) {
  const deadline = Date.now() + 4000;
  for (;;) {
    const j = q.list().find((x) => x.nodeId === nodeId);
    if (j && j.status === want) return j;
    if (Date.now() > deadline) throw new Error(`等不到 ${nodeId} → ${want}(当前 ${j?.status ?? '无'})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  RenderQueue = (await import('../render-queue.js')).RenderQueue;
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('RenderQueue 同节点去重(事故回归)', () => {
  it('同 nodeId 已 queued → 再次 submit 抛「拒绝重复入队」', () => {
    const q = makeHangingQueue();
    q.submit(req('n1'));
    expect(() => q.submit(req('n1'))).toThrow(/拒绝重复入队/);
    expect(q.list().filter((j) => j.nodeId === 'n1')).toHaveLength(1);
  });

  it('同 nodeId 已 running → 抛错且文案指名「正在渲染」', async () => {
    const q = makeHangingQueue();
    q.submit(req('n1'));
    await waitStatus(q, 'n1', 'running');
    expect(() => q.submit(req('n1'))).toThrow(/正在渲染/);
  });

  it('不同 nodeId 互不影响', async () => {
    const q = makeHangingQueue();
    q.submit(req('n1'));
    const h2 = q.submit(req('n2'));
    expect(h2.providerTaskId).toBeTruthy();
    await waitStatus(q, 'n1', 'running');
    // n2 排队中(n1 占着槽位),不抛错
    expect(q.list().filter((j) => j.nodeId === 'n2')).toHaveLength(1);
  });

  it('在途任务取消后 → 允许重提', async () => {
    const q = makeHangingQueue();
    const h = q.submit(req('n1'));
    // queued 状态直接取消(不等 running)
    await q.cancel(h);
    const j = q.list().find((x) => x.nodeId === 'n1');
    expect(j?.status).toBe('cancelled');
    expect(() => q.submit(req('n1'))).not.toThrow();
  });

  it('任务跑完(succeeded)后 → 允许重提(重跑语义不破)', async () => {
    const q = makeInstantQueue();
    q.submit(req('n1'));
    await waitStatus(q, 'n1', 'succeeded'); // 队列 2s 轮询一次
    expect(() => q.submit(req('n1'))).not.toThrow();
  }, 8000);
});
