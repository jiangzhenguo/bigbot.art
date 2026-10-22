/**
 * 资源绑定防幻觉闸 单测(2026-10-14「测试技能5」事故回归)
 *
 * 事故形态:
 *   ① assets.import 不传 projectId → 用户素材落进全局库,项目资源库为空;
 *   ② 模型凭记忆编造不存在的资产 id(asset-c7aab6029a87)建 asset 节点,
 *      canvas.create_node 零校验照样成功 → 节点永远「资产未加载」;
 *   ③ ref-image 连线在提交时被 .filter(Boolean) / `if (!as) continue` 静默吞掉,
 *      references 为空照样提交 → 纯文生图,参考图根本没进生成命令(假成功)。
 *
 * 本测试锁五条修复:
 *   1. assets.import 把 ctx.projectId 传给 importFromDialog / importFromPaths
 *   2. canvas.create_node(kind='asset') 拒绝不存在的/缺失的 assetId,并列出真实候选
 *   3. engine.submit(image-edit,以及非资产来源的 image-gen):有 ref-image 入边但解析不到图 → 指名拒绝
 *   4. engine.submit(shot):派生 ref 的资产 id 不存在 → 拒绝(不再 `continue` 静默吞)
 *   5. engine.submit(image-gen):入边是用户素材的 ref-image → 角色参考闸拒绝,不入队
 *      (2026-10-22 checkCharacterRefEditGate。事故③的「解析不到 / 解析得到」改在 image-edit 上锁,
 *      因为 image-gen + 用户素材 ref-image 会更早被这条闸拦住,到不了资产解析)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ⚠️ 先于主进程模块加载:frames/assets 等模块在 import 时按 env 求值数据目录
const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-asset-guard-'));
process.env.BIGBOTART_HOME = tmpHome;

const PROJECT = 'p-guard';
const CANVAS = 'c-guard';

let ToolHandlers: typeof import('../tool-handlers.js').ToolHandlers;

interface Captured {
  req: Record<string, unknown>;
}
const captured: Captured[] = [];

/** 伪造的「在途任务」清单:用例可往里推 queued/running 任务,模拟另一提交方先入了队 */
const fakeJobs: Array<{ id: string; nodeId: string; status: string }> = [];

function makeQueue() {
  return {
    submit: (req: Record<string, unknown>) => {
      captured.push({ req });
      return { providerTaskId: `job-guard-${captured.length}` };
    },
    list: () => fakeJobs,
    cancel: () => {},
  } as unknown as import('../render-queue.js').RenderQueue;
}

type NodeSpec = { id: string; kind: string; label?: string; data?: Record<string, unknown> };
const n = (s: NodeSpec) =>
  ({ position: { x: 0, y: 0 }, width: 236, label: s.id, ...s }) as unknown as import('@bigbotart/shared').CanvasNode;

/** 可变画布 store stub:用例间共享,用 seed() 重置内容 */
function makeStore() {
  const state = {
    nodes: [] as import('@bigbotart/shared').CanvasNode[],
    edges: [] as import('@bigbotart/shared').CanvasEdge[],
  };
  const canvas = () => ({
    id: CANVAS,
    name: '主画布',
    version: 1,
    nodes: state.nodes,
    edges: state.edges,
    groups: [],
    updatedAt: new Date().toISOString(),
  });
  return {
    loadProjectCanvases: () => ({ projectId: PROJECT, canvases: [canvas()] }),
    saveCanvasSnapshot: () => ({ ok: true }),
    seed(nodes: NodeSpec[], edges: Array<{ source: string; target: string; label?: string }> = []) {
      state.nodes = nodes.map(n);
      state.edges = edges.map((e, i) => ({ id: `e${i}`, ...e })) as unknown as import('@bigbotart/shared').CanvasEdge[];
    },
  } as unknown as import('../store.js').ProjectStore & {
    seed: (nodes: NodeSpec[], edges?: Array<{ source: string; target: string; label?: string }>) => void;
  };
}

/** 资产库 stub:真实条目表 + 导入调用捕获(验 projectId 透传) */
function makeAssets(real: Record<string, string>) {
  const imports: Array<{ via: string; projectId?: string }> = [];
  return {
    get: (id: string) =>
      real[id]
        ? { id, kind: 'image', name: id, localPath: real[id], tags: [], createdAt: '' }
        : undefined,
    list: () =>
      Object.entries(real).map(([id, p]) => ({ id, kind: 'image', name: id, localPath: p, tags: [], createdAt: '' })),
    importFromDialog: async (projectId?: string) => {
      imports.push({ via: 'dialog', projectId });
      return { canceled: false, assets: [], failed: [] };
    },
    importFromPaths: async (_paths: string[], opts?: { projectId?: string }) => {
      imports.push({ via: 'paths', projectId: opts?.projectId });
      return { canceled: false, assets: [], failed: [] };
    },
    __imports: imports,
  } as never;
}

const ctx = { projectId: PROJECT, canvasId: CANVAS };

let store: ReturnType<typeof makeStore>;
let assets: ReturnType<typeof makeAssets>;
let handlers: InstanceType<typeof ToolHandlers>;

const REAL = { 'asset-real-1': '/lib/logo.png' };

beforeAll(async () => {
  ToolHandlers = (await import('../tool-handlers.js')).ToolHandlers;
  store = makeStore();
  assets = makeAssets(REAL);
  handlers = new ToolHandlers(store, assets, {} as never, {} as never, makeQueue(), {} as never);
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('assets.import 项目归属(事故①)', () => {
  it('openDialog 路径把 ctx.projectId 传给 importFromDialog', async () => {
    // assets 为空 → 返回「未选中任何文件」,但导入调用已经发生,projectId 必须带上
    await handlers.call('assets.import', { openDialog: true }, ctx);
    const im = (assets as unknown as { __imports: Array<{ via: string; projectId?: string }> }).__imports;
    expect(im.at(-1)).toEqual({ via: 'dialog', projectId: PROJECT });
  });

  it('paths 路径把 ctx.projectId 传给 importFromPaths', async () => {
    await handlers.call('assets.import', { paths: ['/tmp/x.png'] }, ctx);
    const im = (assets as unknown as { __imports: Array<{ via: string; projectId?: string }> }).__imports;
    expect(im.at(-1)).toEqual({ via: 'paths', projectId: PROJECT });
  });
});

describe('canvas.create_node(kind=asset) 资产绑定校验(事故②)', () => {
  it('assetId 不存在 → 拒绝创建,列出真实候选,画布不留节点', async () => {
    store.seed([], []);
    const res = await handlers.call(
      'canvas.create_node',
      { kind: 'asset', label: 'LOGO', data: { assetId: 'asset-c7aab6029a87' } },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.result).toContain('不存在');
    expect(res.result).toContain('asset-real-1'); // 真实候选被列出,模型可照抄
    store.seed([], []);
    const cur = store.loadProjectCanvases(PROJECT).canvases[0]!;
    expect(cur.nodes).toHaveLength(0); // 不留空壳节点
  });

  it('assetId 缺失 → 拒绝并指引 assets.list / assets.import', async () => {
    const res = await handlers.call('canvas.create_node', { kind: 'asset', label: 'LOGO', data: {} }, ctx);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('assetId');
    expect(res.result).toContain('assets.list');
  });

  it('assetId 真实存在 → 正常创建(不误伤)', async () => {
    store.seed([], []);
    const res = await handlers.call(
      'canvas.create_node',
      { kind: 'asset', label: 'LOGO', data: { assetId: 'asset-real-1' } },
      ctx,
    );
    expect(res.ok).toBe(true);
    const cur = store.loadProjectCanvases(PROJECT).canvases[0]!;
    expect(cur.nodes).toHaveLength(1);
    expect((cur.nodes[0]!.data as Record<string, unknown>).assetId).toBe('asset-real-1');
  });

  it('非 asset 节点不受该校验影响', async () => {
    store.seed([], []);
    const res = await handlers.call('canvas.create_node', { kind: 'image-gen', label: '图' }, ctx);
    expect(res.ok).toBe(true);
  });
});

describe('engine.submit ref-image 连线必须解析出图(事故③·图片节点)', () => {
  // 2026-10-22:用户素材的参考图必须走 image-edit(Qwen-Image-2.1 允许只连 ref-image、无 input 底图)。
  // image-gen + 资产 ref-image 由角色参考闸拒绝,到不了这里的解析闸。
  const edit = (id: string) => ({
    id,
    kind: 'image-edit' as const,
    label: '镜1',
    data: { engine: 'mlxgen', mode: 'instruction', model: 'Qwen/Qwen-Image-2.1', prompt: '画一个符号' },
  });

  it('image-edit 有 ref-image 入边但源资产不存在 → 指名拒绝,不入队', async () => {
    store.seed(
      [
        { id: 'a-logo', kind: 'asset', label: 'BigBotArt LOGO', data: { assetId: 'asset-ghost' } },
        edit('e1'),
      ],
      [{ source: 'a-logo', target: 'e1', label: 'ref-image' }],
    );
    const before = captured.length;
    const res = await handlers.call('engine.submit', { nodeId: 'e1' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('BigBotArt LOGO');
    expect(res.result).toContain('asset-ghost');
    expect(captured.length).toBe(before); // 没有入队 = 没有假成功
  });

  it('ref-image 边全部可解析 → 正常入队且 references 带 ref-image', async () => {
    store.seed(
      [
        { id: 'a-logo', kind: 'asset', label: 'LOGO', data: { assetId: 'asset-real-1' } },
        edit('e1'),
      ],
      [{ source: 'a-logo', target: 'e1', label: 'ref-image' }],
    );
    const before = captured.length;
    const res = await handlers.call('engine.submit', { nodeId: 'e1' }, ctx);
    expect(res.ok).toBe(true);
    expect(captured.length).toBe(before + 1);
    const refs = captured.at(-1)!.req.references as Array<{ role: string; localPath: string }>;
    expect(refs).toHaveLength(1);
    expect(refs[0]!.role).toBe('ref-image');
    expect(refs[0]!.localPath).toBe('/lib/logo.png');
  });

  it('image-gen 把用户素材连成 ref-image → 角色参考闸拒绝,不入队', async () => {
    // 资产真实存在,排除「解析不到图」那条旧闸:拒绝来自 checkCharacterRefEditGate
    store.seed(
      [
        { id: 'a-logo', kind: 'asset', label: 'BigBotArt LOGO', data: { assetId: 'asset-real-1' } },
        { id: 'g1', kind: 'image-gen', label: '镜1', data: { engine: 'mlxgen', prompt: '画一个符号' } },
      ],
      [{ source: 'a-logo', target: 'g1', label: 'ref-image' }],
    );
    const before = captured.length;
    const res = await handlers.call('engine.submit', { nodeId: 'g1' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('BigBotArt LOGO');
    expect(res.result).toContain('image-edit');
    expect(res.result).toContain('ref-image');
    expect(captured.length).toBe(before);
  });

  it('图片产物源未生成(无 resultPath) → 同样拒绝并说明原因', async () => {
    store.seed(
      [
        { id: 'g0', kind: 'image-gen', label: '上游图', data: {} },
        { id: 'g1', kind: 'image-gen', label: '下游图', data: { engine: 'mlxgen', prompt: 'x' } },
      ],
      [{ source: 'g0', target: 'g1', label: 'ref-image' }],
    );
    const res = await handlers.call('engine.submit', { nodeId: 'g1' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('上游图');
    expect(res.result).toContain('还没有图片产物');
  });
});

describe('engine.submit 同节点在途任务预查(2026-10-14 双提交事故)', () => {
  it('节点已有 running 任务 → 友好拒绝,不重复入队、不留孤儿 Take', async () => {
    store.seed([
      { id: 'g1', kind: 'image-gen', label: '镜1', data: { engine: 'mlxgen', prompt: '画一个符号' } },
    ]);
    fakeJobs.push({ id: 'job-busy-1', nodeId: 'g1', status: 'running' });
    try {
      const before = captured.length;
      const res = await handlers.call('engine.submit', { nodeId: 'g1' }, ctx);
      expect(res.ok).toBe(false);
      expect(res.result).toContain('正在渲染');
      expect(res.result).toContain('job-busy-1'); // 给模型可执行的 engine.cancel 目标
      expect(captured.length).toBe(before); // 没有入队
    } finally {
      fakeJobs.length = 0;
    }
  });

  it('queued 状态同样拦截(接力提交抢先入队的场景)', async () => {
    store.seed([
      { id: 'g1', kind: 'image-gen', label: '镜1', data: { engine: 'mlxgen', prompt: '画一个符号' } },
    ]);
    fakeJobs.push({ id: 'job-cascade-1', nodeId: 'g1', status: 'queued' });
    try {
      const res = await handlers.call('engine.submit', { nodeId: 'g1' }, ctx);
      expect(res.ok).toBe(false);
      expect(res.result).toContain('排队中');
    } finally {
      fakeJobs.length = 0;
    }
  });

  it('其它节点的在途任务不影响本节点提交', async () => {
    store.seed([
      { id: 'g1', kind: 'image-gen', label: '镜1', data: { engine: 'mlxgen', prompt: '画一个符号' } },
    ]);
    fakeJobs.push({ id: 'job-other', nodeId: 'someone-else', status: 'running' });
    try {
      const res = await handlers.call('engine.submit', { nodeId: 'g1' }, ctx);
      expect(res.ok).toBe(true);
    } finally {
      fakeJobs.length = 0;
    }
  });
});

describe('engine.submit shot 派生 ref 的资产不存在(事故③·镜头)', () => {
  it('ref-image 入边的资产 id 不存在 → 拒绝(不再 `if (!as) continue` 静默吞)', async () => {
    store.seed(
      [
        { id: 'a-logo', kind: 'asset', label: 'LOGO', data: { assetId: 'asset-ghost' } },
        {
          id: 's1',
          kind: 'shot',
          label: '镜头 01',
          data: {
            engine: 'h3c', mode: 'ref-image', prompt: '一段视频',
            width: 544, height: 960, seconds: 5, frames: 121, tier: 'preview',
          },
        },
      ],
      [{ source: 'a-logo', target: 's1', label: 'ref-image' }],
    );
    const before = captured.length;
    const res = await handlers.call('engine.submit', { nodeId: 's1' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('asset-ghost');
    expect(captured.length).toBe(before);
  });
});
