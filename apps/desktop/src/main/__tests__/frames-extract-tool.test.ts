/**
 * Agent 工具 `frames.extract` 单测(抽帧 → 导入资产 → 建资源节点)
 *
 * 覆盖三层:
 *  1. 参数校验:来源缺失 / at 非法 / 节点无产物(都不该碰 ffmpeg)
 *  2. 集成:ffmpeg 真实抽帧 → 资产库入库 → 画布多出一个 asset 节点(产物在临时 HOME 下)
 *  3. 画布写入:节点落盘 + version 自增(渲染层据此同步)
 *
 * 关键:frames.ts / assets.ts 的模块级常量(OUTPUTS_DIR/ASSETS_DIR)在 import 时按 env 求值 →
 * 必须在模块顶层先设 env,再在测试内动态 import(与 frames-crop.test.ts 同约定)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// ⚠️ 先于任何主进程模块加载:产物与资产目录都指向临时 HOME,绝不触碰真实用户数据(R5)
const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-frames-tool-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');

const hasFfmpeg = (() => {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

const outDir = join(tmpHome, 'outputs');
const assetDir = join(tmpHome, 'assets');

let videoPath = '';
let outsidePath = '';
let ToolHandlers: typeof import('../tool-handlers.js').ToolHandlers;
let store: import('../store.js').ProjectStore;

const PROJECT = 'p-test';
const CANVAS = 'c-test';

/** 造一个只实现被 frames.extract 用到的方法的 store stub(loadProjectCanvases/saveCanvasSnapshot) */
function makeStore(): import('../store.js').ProjectStore {
  const snapshot = {
    id: CANVAS,
    name: '主画布',
    version: 1,
    nodes: [
      {
        id: 'shot-1',
        kind: 'shot',
        label: '开场镜头',
        position: { x: 100, y: 100 },
        data: { resultPath: videoPath },
      },
      {
        id: 'shot-empty',
        kind: 'shot',
        label: '空镜头',
        position: { x: 100, y: 400 },
        data: {},
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
  } as unknown as import('../store.js').ProjectStore;
}

/** 造一个只实现 get / importFromPaths 的 AssetStore stub(真实入库逻辑另有 assets 单测) */
function makeAssets(): import('../assets.js').AssetStore & { __imported: string[][] } {
  const imported: string[][] = [];
  const table = new Map<string, { id: string; kind: string; name: string; localPath: string }>();
  return {
    get: (id: string) => table.get(id) as never,
    importFromPaths: async (paths: string[], opts?: { projectId?: string }) => {
      imported.push(paths);
      const assets = paths.map((p, i) => {
        const a = {
          id: `asset-${imported.length}-${i}`,
          kind: 'image',
          name: 'frame',
          localPath: p,
          projectId: opts?.projectId,
        };
        table.set(a.id, a);
        return a;
      });
      return { assets, failed: [] };
    },
    __imported: imported,
  } as unknown as import('../assets.js').AssetStore & { __imported: string[][] };
}

/** 构造 ToolHandlers(其余依赖 frames.extract 路径上不会被触碰,给空对象即可) */
function makeHandlers(storeImpl: import('../store.js').ProjectStore, assetsImpl: import('../assets.js').AssetStore) {
  return new ToolHandlers(
    storeImpl,
    assetsImpl,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

const ctx = { projectId: PROJECT, canvasId: CANVAS };

beforeAll(async () => {
  ToolHandlers = (await import('../tool-handlers.js')).ToolHandlers;
  store = makeStore();
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe.runIf(hasFfmpeg)('frames.extract', () => {
  beforeAll(() => {
    mkdirSync(outDir, { recursive: true });
    mkdirSync(assetDir, { recursive: true });
    // 2 秒测试视频(放产物目录,白名单内)
    videoPath = join(outDir, 'src-video.mp4');
    const gen = spawnSync(
      'ffmpeg',
      ['-y', '-f', 'lavfi', '-i', 'testsrc=s=320x240:d=2:r=24', '-pix_fmt', 'yuv420p', videoPath],
      { stdio: 'ignore' },
    );
    if (gen.status !== 0) throw new Error('无法生成测试视频(ffmpeg 异常)');
    // 白名单外的视频(临时 HOME 之外的系统文件,用 hosts 伪装视频后缀)
    outsidePath = '/etc/hosts';
    // 让 store 里 shot-1 的产物指向刚生成的视频(替换占位)
    const snap = (store as unknown as { __snapshot: { nodes: Array<{ data: Record<string, unknown> }> } }).__snapshot;
    snap.nodes[0]!.data.resultPath = videoPath;
  });

  it('nodeId + at=first → 抽帧 + 导入资产 + 建 asset 节点', async () => {
    const assets = makeAssets();
    const h = makeHandlers(store, assets);
    const res = await h.call('frames.extract', { nodeId: 'shot-1' }, ctx);

    expect(res.ok, res.result).toBe(true);
    expect(res.nodeId).toBeTruthy();
    // 抽出的帧确实进了资产库
    expect(assets.__imported.length).toBe(1);
    expect(assets.__imported[0]![0]).toContain(tmpHome);
    expect(existsSync(assets.__imported[0]![0]!)).toBe(true);

    // 画布多出一个 asset 节点,且指向新资产、带取帧来源
    const snap = (store as unknown as { __snapshot: { nodes: Array<Record<string, unknown>>; version: number } }).__snapshot;
    const created = snap.nodes.find((n) => n.id === res.nodeId) as Record<string, unknown>;
    expect(created.kind).toBe('asset');
    expect(created.label).toContain('开场镜头');
    expect(created.label).toContain('首帧');
    const d = created.data as Record<string, unknown>;
    expect(d.assetId).toBeTruthy();
    expect((d.frameSource as Record<string, unknown>).fromNodeId).toBe('shot-1');
    expect((d.frameSource as Record<string, unknown>).mode).toBe('first');
  });

  it('at=数字 → 时间点模式(结果文案与 frameSource 都记录秒数)', async () => {
    const assets = makeAssets();
    const h = makeHandlers(store, assets);
    const res = await h.call('frames.extract', { nodeId: 'shot-1', at: 1 }, ctx);
    expect(res.ok, res.result).toBe(true);
    expect(res.result).toContain('第 1s 帧');
    const snap = (store as unknown as { __snapshot: { nodes: Array<Record<string, unknown>> } }).__snapshot;
    const created = snap.nodes.find((n) => n.id === res.nodeId) as Record<string, unknown>;
    const fs = (created.data as Record<string, unknown>).frameSource as Record<string, unknown>;
    expect(fs.mode).toBe('at');
    expect(fs.seconds).toBe(1);
  });

  it('at=last → 尾帧', async () => {
    const assets = makeAssets();
    const h = makeHandlers(store, assets);
    const res = await h.call('frames.extract', { nodeId: 'shot-1', at: 'last' }, ctx);
    expect(res.ok, res.result).toBe(true);
    expect(res.result).toContain('尾帧');
  });

  it('videoPath 直传(白名单内)→ 可抽帧;来源名取文件名', async () => {
    const assets = makeAssets();
    const h = makeHandlers(store, assets);
    const res = await h.call('frames.extract', { videoPath, at: 0.5 }, ctx);
    expect(res.ok, res.result).toBe(true);
    expect(res.result).toContain('src-video');
  });

  it('label 显式指定 → 用给定标题', async () => {
    const assets = makeAssets();
    const h = makeHandlers(store, assets);
    const res = await h.call('frames.extract', { nodeId: 'shot-1', at: 0.5, label: '我的关键帧' }, ctx);
    expect(res.ok, res.result).toBe(true);
    const snap = (store as unknown as { __snapshot: { nodes: Array<Record<string, unknown>> } }).__snapshot;
    expect((snap.nodes.find((n) => n.id === res.nodeId) as Record<string, unknown>).label).toBe('我的关键帧');
  });

  it('缺来源(nodeId 与 videoPath 都空)→ 拒绝', async () => {
    const h = makeHandlers(store, makeAssets());
    const res = await h.call('frames.extract', {}, ctx);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('nodeId');
  });

  it('节点不存在 → 拒绝', async () => {
    const h = makeHandlers(store, makeAssets());
    const res = await h.call('frames.extract', { nodeId: 'nope' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('不存在');
  });

  it('节点无视频产物 → 明确提示先生成(不静默失败)', async () => {
    const h = makeHandlers(store, makeAssets());
    const res = await h.call('frames.extract', { nodeId: 'shot-empty' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('还没有视频产物');
  });

  it('at 非法(负数/文字)→ 拒绝', async () => {
    const h = makeHandlers(store, makeAssets());
    const neg = await h.call('frames.extract', { nodeId: 'shot-1', at: -3 }, ctx);
    expect(neg.ok).toBe(false);
    expect(neg.result).toContain('非法');
    const word = await h.call('frames.extract', { nodeId: 'shot-1', at: 'middle' }, ctx);
    expect(word.ok).toBe(false);
    expect(word.result).toContain('非法');
  });

  it('videoPath 在允许目录外 → 拒绝取帧(安全边界不放宽)', async () => {
    const h = makeHandlers(store, makeAssets());
    const res = await h.call('frames.extract', { videoPath: outsidePath }, ctx);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('允许目录');
  });

  it('时间点超片长 → 拒绝且不建节点(2s 视频取第 30s)', async () => {
    const assets = makeAssets();
    const h = makeHandlers(store, assets);
    const before = (store as unknown as { __snapshot: { nodes: unknown[] } }).__snapshot.nodes.length;
    const res = await h.call('frames.extract', { nodeId: 'shot-1', at: 30 }, ctx);
    expect(res.ok).toBe(false);
    expect(assets.__imported.length).toBe(0);
    // 失败不留半成品节点
    expect((store as unknown as { __snapshot: { nodes: unknown[] } }).__snapshot.nodes.length).toBe(before);
  });

  it('画布写入:每次成功都落盘并自增 version(渲染层据此同步)', async () => {
    const assets = makeAssets();
    const h = makeHandlers(store, assets);
    const snap = (store as unknown as { __snapshot: { version: number } }).__snapshot;
    const v0 = snap.version;
    const res = await h.call('frames.extract', { nodeId: 'shot-1' }, ctx);
    expect(res.ok, res.result).toBe(true);
    expect(snap.version).toBeGreaterThan(v0);
    expect((store as unknown as { __saved: unknown[] }).__saved.length).toBeGreaterThan(0);
  });

  it('新节点默认落在来源节点右侧(不重叠遮挡)', async () => {
    const assets = makeAssets();
    const h = makeHandlers(store, assets);
    const res = await h.call('frames.extract', { nodeId: 'shot-1' }, ctx);
    expect(res.ok, res.result).toBe(true);
    const snap = (store as unknown as { __snapshot: { nodes: Array<Record<string, unknown>> } }).__snapshot;
    const created = snap.nodes.find((n) => n.id === res.nodeId) as Record<string, unknown>;
    const pos = created.position as { x: number; y: number };
    // shot-1 在 (100,100)
    expect(pos.x).toBeGreaterThan(100);
    expect(pos.y).toBe(100);
  });
});
