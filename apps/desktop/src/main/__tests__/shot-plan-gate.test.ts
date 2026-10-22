/**
 * 多镜计划批准闸的**接线**测试(2026-10-20)
 *
 * 背景:`shotSubmitAllowed`(packages/shared/src/agent-task.ts)是纯函数,只验证它本身
 * 无法证明 `engine.submit` 真的调用它 —— 更没证明「调用失败/存根不全」时的行为。
 * 实测事故:5 个 engine.submit 测试的文件级存根 memory 是 `{}`,
 * 而 engine.submit 里写的是 `this.memory.getApprovedShotIds(...)`(非可选),
 * 于是抛 `getApprovedShotIds is not a function` 被包成「工具执行异常」,整批提交全灭。
 *
 * 本文件锁四件事:
 *  1. 两个未出片镜头 + 未批准 → 拒绝(理由指引 plan.present),不入队、不落 Take
 *  2. 用户点头后(approvedShotIds 含该镜头)→ 放行并正常入队
 *  3. 只剩 1 个未出片镜头 → 不需要批准,放行
 *  4. memory 没有该方法(存根不全)→ 不抛异常,按「未批准」拦下(**fail-closed**,绝不放宽闸门)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ⚠️ 先于主进程模块加载:takes.ts 的 DATA_DIR 在 import 时按 env 求值
const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-shot-gate-'));
process.env.BIGBOTART_HOME = tmpHome;

const PROJECT = 'p-gate';
const CANVAS = 'c-gate';

let ToolHandlers: typeof import('../tool-handlers.js').ToolHandlers;
let TakeStore: typeof import('../takes.js').TakeStore;

interface ShotSpec {
  id: string;
  label: string;
  /** 已出片 = data.resultPath 有值(openShots 会把它排除) */
  rendered?: boolean;
}

const captured: Array<{ req: Record<string, unknown> }> = [];

function makeQueue() {
  return {
    submit: (req: Record<string, unknown>) => {
      captured.push({ req });
      return { providerTaskId: `job-${captured.length}` };
    },
    list: () => [],
    cancel: () => {},
  } as unknown as import('../render-queue.js').RenderQueue;
}

function makeStore(shots: ShotSpec[]) {
  const snapshot = {
    id: CANVAS,
    name: '主画布',
    version: 1,
    nodes: shots.map((s, i) => ({
      id: s.id,
      kind: 'shot',
      label: s.label,
      position: { x: i * 400, y: 0 },
      data: {
        prompt: '一个美女跳舞',
        engine: 'h3c',
        mode: 'text2video',
        width: 544,
        height: 544,
        frames: 22,
        ...(s.rendered ? { resultPath: join(tmpHome, 'outputs', `${s.id}.mp4`) } : {}),
      },
    })),
    edges: [],
    groups: [],
    updatedAt: new Date().toISOString(),
  };
  return {
    loadProjectCanvases: () => ({ projectId: PROJECT, canvases: [snapshot] }),
    saveCanvasSnapshot: () => ({ ok: true }),
  } as unknown as import('../store.js').ProjectStore;
}

const ctx = { projectId: PROJECT, canvasId: CANVAS };

let takes: InstanceType<typeof TakeStore>;

beforeAll(async () => {
  ToolHandlers = (await import('../tool-handlers.js')).ToolHandlers;
  TakeStore = (await import('../takes.js')).TakeStore;
  takes = new TakeStore();
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/** 造一个只实现 loadProjectCanvases 的 store + 指定 memory 存根 */
function makeHandlers(shots: ShotSpec[], memory: unknown) {
  return new ToolHandlers(
    makeStore(shots),
    { get: () => undefined } as never,
    {} as never,
    {} as never,
    makeQueue(),
    memory as never,
    { takes } as never,
  );
}

function resetCaptured() {
  captured.length = 0;
}

function readTakes() {
  const f = join(tmpHome, 'workspaces', PROJECT, 'takes.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')) : { takes: [] };
}

describe('engine.submit · 多镜批准闸接线', () => {
  it('两个未出片镜头 + 未批准 → 拒绝,不入队、不落 Take', async () => {
    resetCaptured();
    const h = makeHandlers(
      [
        { id: 'shot-a', label: '镜头 01' },
        { id: 'shot-b', label: '镜头 02' },
      ],
      { getApprovedShotIds: () => undefined },
    );
    const res = await h.call('engine.submit', { nodeId: 'shot-a' }, ctx);
    expect(res.ok).toBe(false);
    expect(String(res.result)).toContain('plan.present');
    expect(captured).toHaveLength(0);
    expect(readTakes().takes).toHaveLength(0);
  });

  it('用户点头后(approvedShotIds 含该镜头)→ 放行并落 Take + 入队', async () => {
    resetCaptured();
    const h = makeHandlers(
      [
        { id: 'shot-a', label: '镜头 01' },
        { id: 'shot-b', label: '镜头 02' },
      ],
      { getApprovedShotIds: () => ['shot-a', 'shot-b'] },
    );
    const res = await h.call('engine.submit', { nodeId: 'shot-a' }, ctx);
    expect(res.ok, String(res.result)).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.req.takeId).toBeTruthy();
    expect(readTakes().takes.filter((t: { shotNodeId: string }) => t.shotNodeId === 'shot-a')).toHaveLength(1);
  });

  it('只有 1 个未出片镜头(其余已出片)→ 不需要批准,放行', async () => {
    resetCaptured();
    const h = makeHandlers(
      [
        { id: 'shot-a', label: '镜头 01', rendered: true },
        { id: 'shot-b', label: '镜头 02' },
      ],
      { getApprovedShotIds: () => undefined },
    );
    const res = await h.call('engine.submit', { nodeId: 'shot-b' }, ctx);
    expect(res.ok, String(res.result)).toBe(true);
    expect(captured).toHaveLength(1);
  });

  it('memory 存根没有 getApprovedShotIds(本次失败形态)→ 不抛异常,按未批准拦下(fail-closed)', async () => {
    resetCaptured();
    const h = makeHandlers(
      [
        { id: 'shot-a', label: '镜头 01' },
        { id: 'shot-b', label: '镜头 02' },
      ],
      {}, // 事故形态:文件级存根只有 `{} as never`
    );
    const res = await h.call('engine.submit', { nodeId: 'shot-a' }, ctx);
    expect(String(res.result)).not.toContain('工具执行异常');
    expect(res.ok).toBe(false);
    expect(String(res.result)).toContain('plan.present');
    expect(captured).toHaveLength(0);
  });
});
