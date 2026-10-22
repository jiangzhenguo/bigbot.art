/**
 * 资源名称可改 + 文案 caption 落盘 / Agent 可读
 *
 * ⚠️ AssetStore 的 DATA_DIR 在模块加载时按 BIGBOTART_HOME 求值,
 * 必须在任何 import 之前设好临时目录(与 project-cover-store.test.ts 同口径)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Asset } from '@bigbotart/shared';

const tmpHome = mkdtempSync(join(tmpdir(), 'bba-asset-cap-'));
process.env.BIGBOTART_HOME = tmpHome;
mkdirSync(join(tmpHome, 'assets'), { recursive: true });

let AssetStore: typeof import('../assets').AssetStore;
let formatAssetBrief: typeof import('../assets').formatAssetBrief;
let ToolHandlers: typeof import('../tool-handlers').ToolHandlers;

beforeAll(async () => {
  ({ AssetStore, formatAssetBrief } = await import('../assets.js'));
  ({ ToolHandlers } = await import('../tool-handlers.js'));
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function seedPng(name: string): string {
  const p = join(tmpHome, name);
  writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return p;
}

describe('formatAssetBrief', () => {
  it('名称优先 + 有文案时附上', () => {
    const a = {
      id: 'asset-1',
      kind: 'image',
      name: '主角',
      localPath: '/x.png',
      tags: [],
      createdAt: '',
      width: 512,
      height: 768,
      caption: '红衣少女站在窗边看雨',
    } satisfies Asset;
    const s = formatAssetBrief(a);
    expect(s).toContain('「主角」');
    expect(s).toContain('512×768');
    expect(s).toContain('assetId=asset-1');
    expect(s).toContain('文案:红衣少女站在窗边看雨');
  });

  it('无文案时不带文案行', () => {
    const a = {
      id: 'asset-2',
      kind: 'image',
      name: '空',
      localPath: '/y.png',
      tags: [],
      createdAt: '',
    } satisfies Asset;
    expect(formatAssetBrief(a)).not.toContain('文案:');
  });
});

describe('AssetStore.update 名称与文案', () => {
  it('可写 name + caption;空名拒绝;空 caption 清空;落盘到临时目录', async () => {
    const store = new AssetStore();
    const asset = await store.ingest(seedPng('hero.png'), { projectId: 'p1' });
    expect(asset).toBeTruthy();
    const id = asset!.id;

    expect(store.update(id, { name: '  ' }).ok).toBe(false);
    expect(store.update(id, { name: '主角立绘' }).ok).toBe(true);
    expect(store.get(id)?.name).toBe('主角立绘');

    expect(store.update(id, { caption: '一位红衣少女站在窗边' }).ok).toBe(true);
    expect(store.get(id)?.caption).toBe('一位红衣少女站在窗边');

    expect(existsSync(join(tmpHome, 'workspaces', 'p1', 'assets.json')) || existsSync(join(tmpHome, 'assets.json'))).toBe(true);

    expect(store.update(id, { caption: '' }).ok).toBe(true);
    expect(store.get(id)?.caption).toBeUndefined();
  });
});

describe('Agent 工具 assets.update / canvas.get_node', () => {
  it('assets.update / get 返回名称与文案', async () => {
    const assets = new AssetStore();
    const asset = await assets.ingest(seedPng('cat.png'));
    expect(asset).toBeTruthy();

    const handlers = new ToolHandlers(
      {
        loadProjectCanvases: () => ({ canvases: [] }),
        listProjects: () => [],
        saveCanvasSnapshot: () => ({ ok: true }),
      } as never,
      assets,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const ctx = { projectId: 'p1', canvasId: 'c1' };
    const up = await handlers.call(
      'assets.update',
      { assetId: asset!.id, name: '小猫', caption: '一只橘色小猫趴在地毯上' },
      ctx,
    );
    expect(up.ok).toBe(true);
    expect(up.result).toContain('「小猫」');
    expect(up.result).toContain('橘色小猫');

    const got = await handlers.call('assets.get', { assetId: asset!.id }, ctx);
    expect(got.ok).toBe(true);
    expect(got.result).toContain('「小猫」');
    expect(got.result).toContain('文案:一只橘色小猫趴在地毯上');
  });

  it('canvas.get_node 对 asset 节点注入资产名与文案', async () => {
    const assets = new AssetStore();
    const asset = await assets.ingest(seedPng('ref.png'));
    assets.update(asset!.id, { name: '参考图 A', caption: '蓝天白云下的城堡' });

    const canvas = {
      id: 'c1',
      projectId: 'p1',
      name: '主画布',
      version: 1,
      nodes: [
        {
          id: 'asset-n1',
          kind: 'asset' as const,
          label: '资源',
          position: { x: 0, y: 0 },
          data: { assetId: asset!.id, mediaType: 'image' },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      edges: [],
    };

    const handlers = new ToolHandlers(
      {
        loadProjectCanvases: () => ({ canvases: [canvas] }),
        listProjects: () => [{ id: 'p1' }],
        saveCanvasSnapshot: () => ({ ok: true }),
      } as never,
      assets,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const res = await handlers.call(
      'canvas.get_node',
      { nodeId: 'asset-n1' },
      { projectId: 'p1', canvasId: 'c1' },
    );
    expect(res.ok).toBe(true);
    expect(res.result).toContain('「参考图 A」');
    expect(res.result).toContain('文案:蓝天白云下的城堡');
    expect(res.result).toContain(`assetId=${asset!.id}`);
  });
});

describe('AssetStore.archiveProducts 名称与文案', () => {
  it('用传入的 name/caption 入库,缺省才回退文件名', async () => {
    const store = new AssetStore();
    const path = seedPng('hash-name.png');
    const r = await store.archiveProducts('p1', [
      { nodeId: 'n-edit', path, name: '  卫猫立绘  ', caption: ' 红袍官帽的猫,四视图  ' },
    ]);
    expect(r.ok).toBe(true);
    expect(r.assets).toHaveLength(1);
    expect(r.assets[0]!.name).toBe('卫猫立绘');
    expect(r.assets[0]!.caption).toBe('红袍官帽的猫,四视图');
    expect(r.assets[0]!.originNodeId).toBe('n-edit');
    expect(r.assets[0]!.source).toBe('product');

    const bare = await store.archiveProducts('p1', [{ nodeId: 'n2', path }]);
    expect(bare.assets[0]!.name).toBe('hash-name');
    expect(bare.assets[0]!.caption).toBeUndefined();
  });

  it('文件不存在时明确失败', async () => {
    const store = new AssetStore();
    const r = await store.archiveProducts('p1', [{ nodeId: 'n', path: join(tmpHome, 'missing.png'), name: '无' }]);
    expect(r.ok).toBe(false);
    expect(r.assets).toHaveLength(0);
    expect(r.error).toContain('没有可入库');
  });
});
