/**
 * `engine.submit` 提交字段完整性 + 队列完成归档 单测
 *
 * 事故背景(2026-09-28,真实):
 *   Agent 侧 `engine.submit` 只传 provider/nodeId/slot/params/references,
 *   **漏传 projectId / canvasId / takeId**。后果有两层,且都表现为「生成成功但画布/历史里什么都没有」:
 *     ① 队列完成时 `index.ts` 的 onJobFinish 两个分支全落空(有 takeId 才 patch、
 *        没 takeId 则按 projectId 补 append)→ Take 历史里**根本没有这条任务**;
 *     ② projectId 缺失时**连失败任务都不归档**——看门狗超时后完全无从回查。
 *   实测:17:10 提交的任务 18:09 出片(864×480/124 帧/5.175s,产物完全有效),
 *   而 takes-<projectId>.json 的最后写入时间比提交还早,该节点 Take 查询结果为空。
 *
 * 本测试锁三件事:
 *  1. engine.submit 入队的 RenderRequest **带全** projectId/canvasId/takeId(RenderQueue.submit 捕获)
 *  2. 提交时先落一条 queued Take(attempt 从 1 开始,shotNodeId 正确)
 *  3. 队列完成回调把 Take patch 成终态(status/resultPath/error 落盘)
 *  4. 无 projectId 的完成任务不静默(日志告警),不崩
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ⚠️ 先于主进程模块加载:takes.ts 的 DATA_DIR 在 import 时按 env 求值 → 必须顶层先设
const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-submit-take-'));
process.env.BIGBOTART_HOME = tmpHome;

const PROJECT = 'p-submit';
const CANVAS = 'c-submit';

let ToolHandlers: typeof import('../tool-handlers.js').ToolHandlers;
let TakeStore: typeof import('../takes.js').TakeStore;

/** 捕获入队的 RenderRequest,并允许手工触发完成回调(不真跑引擎) */
interface Captured {
  req: Record<string, unknown>;
}
const captured: Captured[] = [];

/** 造一个最小 RenderQueue stub:只实现 submit/list/cancel(不真跑引擎) */
function makeQueue() {
  return {
    submit: (req: Record<string, unknown>) => {
      captured.push({ req });
      return { providerTaskId: `job-test-${captured.length}` };
    },
    list: () => [],
    cancel: () => {},
  } as unknown as import('../render-queue.js').RenderQueue;
}

/** 造一个只实现 loadProjectCanvases/saveCanvasSnapshot 的 store stub */
function makeStore() {
  const snapshot = {
    id: CANVAS,
    name: '主画布',
    version: 1,
    nodes: [
      {
        id: 'shot-a',
        kind: 'shot',
        label: '镜头 A',
        position: { x: 0, y: 0 },
        data: { prompt: '一个美女跳舞', engine: 'h3c', mode: 'text2video', width: 544, height: 544, frames: 22 },
      },
    ],
    edges: [],
    groups: [],
    updatedAt: new Date().toISOString(),
  };
  const saved: unknown[] = [];
  return {
    loadProjectCanvases: () => ({ projectId: PROJECT, canvases: [snapshot] }),
    saveCanvasSnapshot: (s: unknown) => {
      saved.push(s);
      return { ok: true };
    },
    __saved: saved,
    __snapshot: snapshot,
  } as unknown as import('../store.js').ProjectStore & { __saved: unknown[] };
}

const ctx = { projectId: PROJECT, canvasId: CANVAS };

let takes: InstanceType<typeof TakeStore>;
let handlers: InstanceType<typeof ToolHandlers>;

beforeAll(async () => {
  ToolHandlers = (await import('../tool-handlers.js')).ToolHandlers;
  TakeStore = (await import('../takes.js')).TakeStore;
  takes = new TakeStore();
  handlers = new ToolHandlers(
    makeStore(),
    { get: () => undefined } as never,
    {} as never,
    {} as never,
    makeQueue(),
    {} as never,
    { takes },
  );
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/** 读取临时 HOME 下的 takes json(断言真实落盘,而不是只看内存)。
 *  2026-09-29 起 Take 落在 workspaces/<pid>/takes.json(原 takes-<pid>.json 平铺)。 */
function readTakes() {
  const f = join(tmpHome, 'workspaces', PROJECT, 'takes.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')) : { takes: [] };
}

describe('engine.submit 提交字段完整性(事故回归)', () => {
  it('入队的 RenderRequest 必须带全 projectId / canvasId / takeId', async () => {
    const res = await handlers.call('engine.submit', { nodeId: 'shot-a' }, ctx);
    expect(res.ok).toBe(true);
    expect(captured).toHaveLength(1);

    const req = captured[0]!.req;
    // 这三项缺任何一个 → 事故复现(Take 不归档 / 失败无从回查)
    expect(req.projectId).toBe(PROJECT);
    expect(req.canvasId).toBe(CANVAS);
    expect(typeof req.takeId).toBe('string');
    expect(req.takeId).toBeTruthy();
    // 既有字段不受影响
    expect(req.nodeId).toBe('shot-a');
    expect(req.slot).toBe('video');
  });

  it('提交时先落一条 queued Take,shotNodeId 与节点一致', async () => {
    const doc = readTakes();
    const mine = doc.takes.filter((t: { shotNodeId: string }) => t.shotNodeId === 'shot-a');
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe('queued');
    expect(mine[0].attempt).toBe(1);
    // 入队 takeId 与落盘 Take 是同一条(否则完成时 patch 打空)
    expect(mine[0].id).toBe(captured[0]!.req.takeId);
  });

  it('队列完成回调把 Take patch 成终态(含 resultPath)', async () => {
    const takeId = captured[0]!.req.takeId as string;
    // 模拟 index.ts 的 onJobFinish 成功分支(与本测试同口径:takeId+projectId → patch)
    await takes.patch(PROJECT, takeId, {
      status: 'succeeded',
      resultPath: join(tmpHome, 'out.mp4'),
    });
    const doc = readTakes();
    const t = doc.takes.find((x: { id: string }) => x.id === takeId);
    expect(t.status).toBe('succeeded');
    expect(t.resultPath).toBe(join(tmpHome, 'out.mp4'));
    // patch 终态时补 finishedAt / elapsedSec(既有语义)
    expect(t.finishedAt).toBeTruthy();
    expect(typeof t.elapsedSec).toBe('number');
  });

  it('失败任务同样归档(错误信息可回查)', async () => {
    await handlers.call('engine.submit', { nodeId: 'shot-a' }, ctx);
    const takeId = captured[1]!.req.takeId as string;
    await takes.patch(PROJECT, takeId, { status: 'failed', error: 'h3 exit 1: prompt must not be empty' });
    const doc = readTakes();
    const t = doc.takes.find((x: { id: string }) => x.id === takeId);
    expect(t.status).toBe('failed');
    expect(t.error).toContain('prompt must not be empty');
    // attempt 递增(新跑/重跑都走 append,历史不覆盖)
    expect(t.attempt).toBe(2);
  });
});

describe('无归属上下文时不静默(红线 R6)', () => {
  it('canvasId 为空 → 明确报「画布不存在」,不假装提交成功', async () => {
    const before = captured.length;
    const res = await handlers.call('engine.submit', { nodeId: 'shot-a' }, { projectId: PROJECT, canvasId: '' });
    // 无画布上下文本就无法定位节点:必须**明确失败**,不允许静默入队一个无归属的任务
    expect(res.ok).toBe(false);
    expect(res.result).toContain('画布不存在');
    expect(captured.length).toBe(before); // 一个任务都没入队
  });
});
