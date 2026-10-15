/**
 * Agent `engine.submit` 的加速 LoRA 解析单测(2026-10-09 事故)
 *
 * 事故:镜头 03 的节点上 `data.accel={enabled:true, packId:'turbo-t8test', steps:8}` 明明开着,
 * 但经 **Agent 提交**时加速静默失效 —— 因为 `engine.submit` **直接** `queue.submit`,
 * 绕过了渲染层的 `submit-render` IPC,而 accel → `modelDir`(-d)+ `steps` 的解析
 * **只写在那条 IPC 里**(index.ts)。h3c.ts 只认 `params.modelDir`,拿不到就用默认模型。
 *
 * 本文件锁两件事:
 *   ① 开了加速 → 提交参数必须带 modelDir + 解析后的 steps;
 *   ② 包不可用 → **明确报错**,不静默退回默认模型(否则就是"以为在加速其实没加速")。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-accel-submit-'));
process.env.BIGBOTART_HOME = tmpHome;

const PROJECT = 'p-accel';
const CANVAS = 'c-accel';
const SHOT_ID = 'shot-accel-1';

let ToolHandlers: typeof import('../tool-handlers.js').ToolHandlers;

function makeStore() {
  const snapshot = {
    id: CANVAS,
    name: '主画布',
    version: 1,
    nodes: [
      {
        id: SHOT_ID,
        kind: 'shot',
        label: '镜头 03',
        position: { x: 0, y: 0 },
        data: {
          engine: 'h3c',
          mode: 'text2video',
          prompt: 'Scene: 机翼对峙',
          width: 1024,
          height: 576,
          steps: 30,
          layers: 50,
          reuse: 1,
          tier: 'preview',
          seed: 42,
          refs: [],
          accel: { enabled: true, packId: 'turbo-t8test', steps: 8 },
        },
      },
    ],
    edges: [],
    groups: [],
    updatedAt: new Date().toISOString(),
  };
  return {
    loadProjectCanvases: () => ({ projectId: PROJECT, canvases: [snapshot] }),
    saveCanvasSnapshot: () => ({ ok: true }),
    __snapshot: snapshot,
  } as unknown as import('../store.js').ProjectStore & { __snapshot: typeof snapshot };
}

/** 假的 AccelStore:按需返回解析结果(null = 包不可用);kind 缺省 accel(与真实 resolveAccel 同形) */
function makeAccel(resolved: { modelDir: string; steps: number; kind?: 'accel' | 'style' } | null) {
  return {
    resolveAccel: () => (resolved ? { kind: 'accel' as const, ...resolved } : null),
  } as unknown as import('../lora.js').AccelStore;
}

/** 记录 queue.submit 收到的参数 */
function makeQueue() {
  const submits: Array<Record<string, unknown>> = [];
  return {
    submit: (req: Record<string, unknown>) => {
      submits.push(req);
      return { providerTaskId: 'fake-1' };
    },
    // engine.submit 的「同节点在途任务预查」(2026-10-14 双提交事故)需要它
    list: () => [],
    cancel: () => {},
    __submits: submits,
  };
}

function makeHandlers(accel: import('../lora.js').AccelStore | undefined, queue: ReturnType<typeof makeQueue>) {
  return new ToolHandlers(
    makeStore(),
    {} as never, // assets
    {} as never, // skills
    {} as never, // exportSvc
    queue as never,
    {} as never, // memory
    { accel: accel as never },
  );
}

const ctx = { projectId: PROJECT, canvasId: CANVAS };

beforeAll(async () => {
  ToolHandlers = (await import('../tool-handlers.js')).ToolHandlers;
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('engine.submit · 加速 LoRA 必须真的解析', () => {
  it('开启加速 → 提交参数带 modelDir 与解析后的 steps(修复前完全没有)', async () => {
    const queue = makeQueue();
    const h = makeHandlers(makeAccel({ modelDir: '/models/turbo-T8test', steps: 8 }), queue);
    const res = await h.call('engine.submit', { nodeId: SHOT_ID }, ctx);
    expect(res.ok).toBe(true);
    const params = queue.__submits[0]?.params as Record<string, unknown>;
    expect(params.modelDir).toBe('/models/turbo-T8test'); // -d 换蒸馏模型目录
    expect(params.steps).toBe(8); // 覆盖节点上的 30
  });

  it('风格包(kind=style,2026-10 mystic 接入)→ modelDir/steps 落地且 kind 透传给 provider(ETA 不打折)', async () => {
    const queue = makeQueue();
    const h = makeHandlers(makeAccel({ modelDir: '/models/MiniMax-H3-mystic', steps: 20, kind: 'style' }), queue);
    const res = await h.call('engine.submit', { nodeId: SHOT_ID }, ctx);
    expect(res.ok).toBe(true);
    const params = queue.__submits[0]?.params as Record<string, unknown>;
    expect(params.modelDir).toBe('/models/MiniMax-H3-mystic');
    expect(params.steps).toBe(20);
    expect((params.accel as { kind?: string }).kind).toBe('style');
  });

  it('包不可用 → 明确报错,不静默退回默认模型', async () => {
    const queue = makeQueue();
    const h = makeHandlers(makeAccel(null), queue);
    const res = await h.call('engine.submit', { nodeId: SHOT_ID }, ctx);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('模型包');
    expect(res.result).toContain('设置页');
    // 关键:不能入队 —— 否则就是"以为在加速,其实没加速"
    expect(queue.__submits).toHaveLength(0);
  });

  it('没开加速(节点无 accel 或 enabled=false)→ 不写 modelDir,走默认模型', async () => {
    const queue = makeQueue();
    const h = makeHandlers(makeAccel({ modelDir: '/should/not/use', steps: 8 }), queue);
    // 关掉节点的 accel
    const store = (h as unknown as { store: { __snapshot: { nodes: Array<{ data: Record<string, unknown> }> } } }).store;
    delete store.__snapshot.nodes[0]!.data.accel;
    const res = await h.call('engine.submit', { nodeId: SHOT_ID }, ctx);
    expect(res.ok).toBe(true);
    const params = queue.__submits[0]?.params as Record<string, unknown>;
    expect(params.modelDir).toBeUndefined();
  });

  it('未注入 AccelStore 但节点开了加速 → 报错而不是假装成功', async () => {
    const queue = makeQueue();
    const h = makeHandlers(undefined, queue);
    const res = await h.call('engine.submit', { nodeId: SHOT_ID }, ctx);
    expect(res.ok).toBe(false);
    expect(queue.__submits).toHaveLength(0);
  });
});

describe('engine.submit · 图片节点不受加速逻辑波及', () => {
  it('image-gen 节点带 accel 也不解析(加速是 h3 视频的概念)', async () => {
    const queue = makeQueue();
    const h = makeHandlers(makeAccel({ modelDir: '/should/not/use', steps: 8 }), queue);
    const store = (h as unknown as { store: { __snapshot: { nodes: Array<Record<string, unknown>> } } }).store;
    // 换成一个 image-gen 节点
    store.__snapshot.nodes[0] = {
      id: 'img-1',
      kind: 'image-gen',
      label: '图片生成',
      position: { x: 0, y: 0 },
      data: { engine: 'mlxgen', prompt: 'a cat', width: 1024, height: 1024, steps: 24, accel: { enabled: true } },
    } as never;
    const res = await h.call('engine.submit', { nodeId: 'img-1' }, ctx);
    expect(res.ok).toBe(true);
    const params = queue.__submits[0]?.params as Record<string, unknown>;
    expect(params.modelDir).toBeUndefined();
  });
});
