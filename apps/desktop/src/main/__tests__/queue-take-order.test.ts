/**
 * 队列完成时序回归单测 —— Take 终态必须**先落盘**,再推送队列变更。
 *
 * 事故背景(2026-09-29,真实):
 *   图片编辑生成成功后,检查器里的 Take chip 一直停在「排队中/未完成」,
 *   **必须用户再点一下**才变成「已完成」。
 *
 * 根因是 `RenderQueue.finishJob` 的调用顺序竞态:
 *   ```
 *   this.onJobFinish?.(job);   // index.ts 里是 `void takes.patch(...)` —— 异步,没 await
 *   this.pump();
 *   this.notify();             // 立刻推队列变更给渲染层
 *   ```
 *   而 `TakeStore.patch` 是 async:成功且有产物时还要 `await probeMedia()`(ffprobe 探测媒体时长)
 *   才会 `save()` 写盘。于是渲染层收到队列变更 → 按 job 签名变化重拉 `takesHistory`
 *   时,**盘上那条 Take 还是 queued** → chip 停在排队中;此后没有任何事件再触发刷新,
 *   只能等用户手动点一下(触发重渲染 + 重拉)才看到终态。
 *
 * 本测试锁三件事:
 *  1. `finishJob` 触发的 onJobFinish 若返回 Promise,notify **必须等它 resolve 之后**才发
 *  2. notify 时刻读盘,Take 已经是终态(而不是 queued)
 *  3. onJobFinish 抛错既不吞(写日志)也不阻断 notify / pump(否则一次归档异常卡死队列)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-queue-order-'));
process.env.BIGBOTART_HOME = tmpHome;

const PROJECT = 'p-order';
const CANVAS = 'c-order';

let RenderQueue: typeof import('../render-queue.js').RenderQueue;
let TakeStore: typeof import('../takes.js').TakeStore;

type TakeRow = { id: string; status: string; resultPath?: string };
let takes: InstanceType<typeof TakeStore>;

/** 读盘(断言真实落盘内容,不看内存缓存)
 *  2026-09-29 起 Take 落在 workspaces/<pid>/takes.json(原 takes-<pid>.json 平铺)。 */
function readTake(takeId: string): TakeRow | undefined {
  const f = join(tmpHome, 'workspaces', PROJECT, 'takes.json');
  if (!existsSync(f)) return undefined;
  const doc = JSON.parse(readFileSync(f, 'utf-8')) as { takes: TakeRow[] };
  return doc.takes.find((t) => t.id === takeId);
}

/**
 * 造一个「提交即成功」的 provider stub:submit 立刻返回 handle,status 返回 SUCCEEDED。
 * 队列内部 2s 轮询一次 → 用假定时器推进,避免真等。
 */
function makeQueue(onChange: (jobs: unknown[]) => void) {
  const provider = {
    id: 'mlxgen',
    check: async () => ({ ready: true }),
    submit: async () => ({ providerTaskId: 'h-1' }),
    status: async () => ({ status: 'SUCCEEDED', resultPath: join(tmpHome, 'out.png'), progress: 1 }),
    cancel: async () => {},
  };
  const registry = { get: () => provider } as never;
  const settings = { get: () => ({ renderMode: 'real', ssdStreaming: false }) } as never;
  const logger = { log: () => {} } as never;
  const q = new RenderQueue(registry, settings, logger);
  q.onChange = onChange as never;
  return q;
}

beforeEach(async () => {
  RenderQueue = (await import('../render-queue.js')).RenderQueue;
  TakeStore = (await import('../takes.js')).TakeStore;
  takes = new TakeStore();
});

afterEach(() => {
  // 每个用例独立 HOME 内容,避免 attempt 串号
  const f = join(tmpHome, `takes-${PROJECT}.json`);
  if (existsSync(f)) rmSync(f);
});

describe('队列完成时序:Take 终态先落盘,再 notify 渲染层', () => {
  it('onJobFinish 返回 Promise 时,notify 必须等它 resolve(事故回归)', async () => {
    let notified = false;
    let takeStatusAtNotify: string | undefined;
    const q = makeQueue(() => {
      notified = true;
      // notify 那一刻读盘 —— 必须已经是终态
      takeStatusAtNotify = readTake(takeId)?.status;
    });

    // 先建一条 queued Take(与渲染层 runNode 同口径)
    const takeId = takes.append(PROJECT, { shotNodeId: 'n1', status: 'queued', params: { prompt: '改背景' } }).id;
    expect(readTake(takeId)?.status).toBe('queued');

    // onJobFinish 模拟 index.ts:await patch 后才返回
    q.onJobFinish = async (job) => {
      await takes.patch(PROJECT, (job as { takeId: string }).takeId, {
        status: 'succeeded',
        resultPath: join(tmpHome, 'out.png'),
      });
    };

    q.submit({
      provider: 'mlxgen',
      nodeId: 'n1',
      slot: 'image',
      projectId: PROJECT,
      canvasId: CANVAS,
      takeId,
      params: {},
    } as never);

    // 推进队列内部 2s 状态轮询(假定时器):submit → 探测就绪 → status 返回 SUCCEEDED → finishJob
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 2100));

    expect(notified).toBe(true);
    // 核心断言:渲染层被通知去重拉 Take 历史时,盘上已经是 succeeded 而不是 queued
    expect(takeStatusAtNotify).toBe('succeeded');
    expect(readTake(takeId)?.resultPath).toBe(join(tmpHome, 'out.png'));
  }, 10_000);

  it('onJobFinish 抛错不阻断 notify,也不吞掉(队列不被卡死)', async () => {
    const logs: string[] = [];
    let notified = false;
    const q = makeQueue(() => {
      notified = true;
    });
    // 注入会记录日志的 logger
    (q as unknown as { logger: { log: (lv: string, m: string) => void } }).logger = {
      log: (lv, m) => logs.push(`${lv}:${m}`),
    };
    q.onJobFinish = () => {
      throw new Error('归档炸了');
    };

    q.submit({
      provider: 'mlxgen',
      nodeId: 'n2',
      slot: 'image',
      projectId: PROJECT,
      canvasId: CANVAS,
      params: {},
    } as never);

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 2100));

    // 异常被记录(红线 R6:禁止静默吞错),但队列照常放行下一个任务
    expect(logs.some((l) => l.includes('onJobFinish') && l.includes('归档炸了'))).toBe(true);
    expect(notified).toBe(true);
    expect(q.list().every((j) => j.status !== 'running')).toBe(true);
  }, 10_000);
});
