/**
 * 镜头尺寸落盘前规整(2026-10-15「骑士小猫」事故回归)
 *
 * 事故链:Agent 建「中世纪暗黑草原 · 举剑 · 披风 5s」镜头时把参考图尺寸
 * 2752×1536 直接写进 data → 创建不拦,engine.submit 才拒(面积超限);
 * 模型改 1280×720(720 非 32 倍数)→ 再被拒。两轮引擎往返白烧。
 *
 * 修法:create_node / update_node 对 shot 的显式 width/height 一律经
 * snapShotDimensions 落盘前规整(带 note 明示),节点始终保持「可提交」。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-snapdim-'));
process.env.BIGBOTART_HOME = tmpHome;

const PROJECT = 'p-snap';
const CANVAS = 'c-snap';
const SHOT_ID = 'shot-snap-1';

let M: typeof import('../tool-handlers.js');

function makeStore(initialData: Record<string, unknown> = {}) {
  const snapshot = {
    id: CANVAS,
    name: '主画布',
    version: 1,
    nodes: [
      { id: SHOT_ID, kind: 'shot', label: '镜头 01', position: { x: 0, y: 0 }, data: { engine: 'h3c', ...initialData } },
      { id: 'img-1', kind: 'image-gen', label: '图', position: { x: 0, y: 0 }, data: {} },
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

function makeHandlers(store: import('../store.js').ProjectStore) {
  return new M.ToolHandlers(store, {} as never, {} as never, {} as never, {} as never, {} as never, {});
}

const ctx = { projectId: PROJECT, canvasId: CANVAS };

beforeAll(async () => {
  M = await import('../tool-handlers.js');
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('canvas.create_node — shot 显式尺寸落盘前规整', () => {
  it('2752×1536(参考图尺寸)→ 规整到 h3 合法档并在结果里明示', async () => {
    const store = makeStore();
    const h = makeHandlers(store);
    const res = await h.call(
      'canvas.create_node',
      { kind: 'shot', label: '举剑 5s', data: { seconds: 5, width: 2752, height: 1536 } },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.result).toContain('已规整为');
    const created = store.__snapshot.nodes.find((n) => n.id === res.nodeId)!;
    const cd = created.data as Record<string, unknown>;
    const w = Number(cd.width);
    const hh = Number(cd.height);
    expect(w % 32).toBe(0);
    expect(hh % 32).toBe(0);
    expect(w * hh).toBeLessThanOrEqual(768 * 1344);
  });

  it('合法尺寸不改动、不带规整说明', async () => {
    const store = makeStore();
    const h = makeHandlers(store);
    const res = await h.call(
      'canvas.create_node',
      { kind: 'shot', label: '举剑 5s', data: { seconds: 5, width: 864, height: 480 } },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.result).not.toContain('已规整为');
    const created = store.__snapshot.nodes.find((n) => n.id === res.nodeId)!;
    const cd2 = created.data as Record<string, unknown>;
    expect(cd2.width).toBe(864);
    expect(cd2.height).toBe(480);
  });
});

describe('canvas.update_node — shot 尺寸规整', () => {
  it('1280×720(720 非 32 倍数)→ 规整成功且不误报「未生效」', async () => {
    const store = makeStore({ seconds: 5, width: 864, height: 480 });
    const h = makeHandlers(store);
    const res = await h.call('canvas.update_node', { nodeId: SHOT_ID, data: { width: 1280, height: 720 } }, ctx);
    expect(res.ok).toBe(true);
    expect(res.result).toContain('已规整为');
    expect(res.result).not.toContain('未生效');
    const shot = store.__snapshot.nodes.find((n) => n.id === SHOT_ID)!;
    const sd = shot.data as Record<string, unknown>;
    expect(Number(sd.width) % 32).toBe(0);
    expect(Number(sd.height) % 32).toBe(0);
  });

  it('非 shot 节点的 width/height 不规整(图片节点尺寸不受 h3 约束)', async () => {
    const store = makeStore();
    const h = makeHandlers(store);
    const res = await h.call('canvas.update_node', { nodeId: 'img-1', data: { width: 2752, height: 1536 } }, ctx);
    expect(res.ok).toBe(true);
    const img = store.__snapshot.nodes.find((n) => n.id === 'img-1')!;
    const id = img.data as Record<string, unknown>;
    expect(id.width).toBe(2752);
    expect(id.height).toBe(1536);
  });
});
