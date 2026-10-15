/**
 * Agent 工具 web.search / web.fetch_image 的接线。
 * fetch 全部打桩,不访问外网;资产目录指向临时 HOME。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-web-tool-'));
process.env.BIGBOTART_HOME = tmpHome;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let ToolHandlers: typeof import('../tool-handlers.js').ToolHandlers;

const PROJECT = 'p-web';
const CANVAS = 'c-web';

function makeStore() {
  const snapshot = {
    id: CANVAS,
    name: '主画布',
    version: 3,
    nodes: [] as Array<Record<string, unknown>>,
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
  };
}

function makeAssets() {
  const imported: string[][] = [];
  return {
    imported,
    get: () => undefined,
    importFromPaths: async (paths: string[], opts?: { projectId?: string }) => {
      imported.push(paths);
      expect(existsSync(paths[0]!), '导入时暂存文件应还在').toBe(true);
      return {
        assets: paths.map((p, i) => ({
          id: `asset-web-${imported.length}-${i}`,
          kind: 'image',
          name: 'net',
          localPath: p,
          projectId: opts?.projectId,
        })),
        failed: [],
      };
    },
  };
}

const lookup = async () => ['1.1.1.1'];

beforeAll(async () => {
  ToolHandlers = (await import('../tool-handlers.js')).ToolHandlers;
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

const ctx = { projectId: PROJECT, canvasId: CANVAS };

describe('web.search', () => {
  it('返回检索摘要,不写画布', async () => {
    const store = makeStore();
    const html = `<a class="result__a" href="https://example.com/a">庭院参考</a><a class="result__snippet">白墙黛瓦</a>`;
    const h = new ToolHandlers(store as never, makeAssets() as never, {} as never, {} as never, {} as never, {} as never, {
      web: {
        env: {},
        dataDir: tmpHome,
        lookup,
        fetch: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
      },
    });
    const res = await h.call('web.search', { query: '中式庭院', limit: 3 }, ctx);
    expect(res.ok).toBe(true);
    expect(res.result).toContain('https://example.com/a');
    expect(res.result).toContain('不要自动下载');
    expect(store.__saved).toHaveLength(0);
    expect(store.__snapshot.nodes).toHaveLength(0);
  });

  it('空检索词直接失败', async () => {
    const h = new ToolHandlers({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {
      web: { env: {}, fetch: async () => new Response('no') },
    });
    const res = await h.call('web.search', { query: '  ' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('检索词为空');
  });
});

describe('web.fetch_image', () => {
  it('下载后导入资产并建成资源节点,暂存文件随后清掉', async () => {
    const store = makeStore();
    const assets = makeAssets();
    const h = new ToolHandlers(store as never, assets as never, {} as never, {} as never, {} as never, {} as never, {
      web: {
        env: {},
        dataDir: tmpHome,
        lookup,
        fetch: async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
      },
    });
    const res = await h.call('web.fetch_image', {
      url: 'https://cdn.example.com/ref.png',
      label: '参考图',
    }, ctx);
    expect(res.ok).toBe(true);
    expect(res.nodeId).toMatch(/^asset-/);
    expect(res.result).toContain('参考图');
    expect(res.result).toContain('asset-web-1-0');
    expect(assets.imported).toHaveLength(1);
    expect(existsSync(assets.imported[0]![0]!), '导入副本落地后应删除暂存').toBe(false);
    expect(store.__snapshot.nodes).toHaveLength(1);
    expect(store.__snapshot.version).toBe(4);
    const node = store.__snapshot.nodes[0] as { label: string; data: { assetId: string; mediaType: string; webSource: { url: string } } };
    expect(node.label).toBe('参考图');
    expect(node.data.assetId).toBe('asset-web-1-0');
    expect(node.data.mediaType).toBe('image');
    expect(node.data.webSource.url).toBe('https://cdn.example.com/ref.png');
    expect(assets.imported[0]).toBeDefined();
  });

  it('内网地址不入库、不建节点', async () => {
    const store = makeStore();
    const assets = makeAssets();
    const h = new ToolHandlers(store as never, assets as never, {} as never, {} as never, {} as never, {} as never, {
      web: { env: {}, dataDir: tmpHome, lookup, fetch: async () => new Response(PNG) },
    });
    const res = await h.call('web.fetch_image', { url: 'http://127.0.0.1/a.png' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('拒绝访问');
    expect(assets.imported).toHaveLength(0);
    expect(store.__snapshot.nodes).toHaveLength(0);
  });

  it('导入失败不留节点', async () => {
    const store = makeStore();
    const h = new ToolHandlers(store as never, {
      importFromPaths: async () => ({ assets: [], failed: [{ name: 'a.png', error: '磁盘满' }] }),
    } as never, {} as never, {} as never, {} as never, {} as never, {
      web: {
        env: {},
        dataDir: tmpHome,
        lookup,
        fetch: async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
      },
    });
    const res = await h.call('web.fetch_image', { url: 'https://cdn.example.com/a.png' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('磁盘满');
    expect(store.__snapshot.nodes).toHaveLength(0);
    expect(res.nodeId).toBeUndefined();
  });
});
