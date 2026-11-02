/**
 * 资源管理「在画布使用」回归：点击必须真的创建并持久化资源节点，
 * 不能只跳转画布再提示用户手动换绑。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Asset, CanvasSnapshot, ProjectCanvases } from '@bigbotart/shared';
import { addAssetToActiveCanvas, appendAssetNode } from '../assets/useInCanvas';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const assetsPageSrc = readFileSync(resolve(here, '../AssetsPage.tsx'), 'utf8');
const appSrc = readFileSync(resolve(here, '../../App.tsx'), 'utf8');

const imageAsset: Asset = {
  id: 'asset-image-1',
  kind: 'image',
  name: '参考图',
  localPath: '/tmp/reference.webp',
  tags: [],
  createdAt: '2026-11-02T07:00:00.000Z',
};

function makeSnapshot(id: string, version = 3): CanvasSnapshot {
  return {
    id,
    projectId: 'p1',
    name: id === 'c2' ? '活动画布' : '其他画布',
    nodes: [],
    edges: [],
    version,
    viewport: { x: 0, y: 0, z: 1 },
    createdAt: '2026-11-02T07:00:00.000Z',
    updatedAt: '2026-11-02T07:00:00.000Z',
  };
}

function makeProjectCanvases(): ProjectCanvases {
  return { projectId: 'p1', canvases: [makeSnapshot('c1'), makeSnapshot('c2', 7)], activeCanvasId: 'c2' };
}

describe('资源添加到活动画布', () => {
  it('追加绑定资源 id/类型的真实 asset 节点，保存活动画布并更新本地版本', async () => {
    const pc = makeProjectCanvases();
    const saveCanvasSnapshot = vi.fn(async (_snap: CanvasSnapshot) => ({ ok: true }));
    const loadProjectCanvases = vi.fn(async (_projectId: string) => pc);

    const result = await addAssetToActiveCanvas({ loadProjectCanvases, saveCanvasSnapshot }, 'p1', imageAsset);

    expect(loadProjectCanvases).toHaveBeenCalledWith('p1');
    expect(saveCanvasSnapshot).toHaveBeenCalledTimes(1);
    const saved = saveCanvasSnapshot.mock.calls[0]![0];
    expect(saved.id).toBe('c2');
    expect(saved.nodes).toHaveLength(1);
    expect(saved.nodes[0]).toMatchObject({
      id: result.nodeId,
      kind: 'asset',
      label: '参考图',
      data: { assetId: 'asset-image-1', mediaType: 'image' },
    });
    expect(result.projectCanvases.activeCanvasId).toBe('c2');
    expect(result.projectCanvases.canvases.find((c) => c.id === 'c2')?.version).toBe(8);
  });

  it('追加节点不修改输入快照，并保留既有节点和连线', () => {
    const original = makeSnapshot('c1');
    original.edges.push({ id: 'e1', source: 'a', target: 'b', label: 'ref-image' });
    const result = appendAssetNode(original, imageAsset, { id: 'asset-node-fixed', now: '2026-11-02T08:00:00.000Z' });

    expect(original.nodes).toHaveLength(0);
    expect(result.snapshot.nodes.map((n) => n.id)).toEqual(['asset-node-fixed']);
    expect(result.snapshot.edges).toEqual(original.edges);
    expect(result.node.createdAt).toBe('2026-11-02T08:00:00.000Z');
  });

  it('保存失败明确抛错，不返回假成功结果', async () => {
    const api = {
      loadProjectCanvases: vi.fn(async () => makeProjectCanvases()),
      saveCanvasSnapshot: vi.fn(async (_snap: CanvasSnapshot) => ({ ok: false })),
    };
    await expect(addAssetToActiveCanvas(api, 'p1', imageAsset)).rejects.toThrow('画布保存失败');
  });

  it('版本冲突时在 store 最新快照上重试，不覆盖并发新增节点', async () => {
    const pc = makeProjectCanvases();
    const concurrent: CanvasSnapshot = {
      ...pc.canvases[1]!,
      version: 8,
      nodes: [
        {
          id: 'concurrent-node',
          kind: 'document',
          label: '并发新增',
          position: { x: 0, y: 0 },
          data: { markdown: '保留我' },
          createdAt: '2026-11-02T07:30:00.000Z',
          updatedAt: '2026-11-02T07:30:00.000Z',
        },
      ],
    };
    const saveCanvasSnapshot = vi.fn(
      async (_snap: CanvasSnapshot): Promise<{ ok: boolean; stale?: boolean; current?: CanvasSnapshot }> => ({ ok: true }),
    );
    saveCanvasSnapshot.mockResolvedValueOnce({ ok: false, stale: true, current: concurrent });

    const result = await addAssetToActiveCanvas(
      { loadProjectCanvases: vi.fn(async () => pc), saveCanvasSnapshot },
      'p1',
      imageAsset,
    );

    expect(saveCanvasSnapshot).toHaveBeenCalledTimes(2);
    const retried = saveCanvasSnapshot.mock.calls[1]![0];
    expect(retried.version).toBe(8);
    expect(retried.nodes.map((n) => n.id)).toContain('concurrent-node');
    expect(retried.nodes.map((n) => n.id)).toContain(result.nodeId);
  });
});

describe('资源管理 · 在画布使用', () => {
  it('按钮把当前选中资源交给添加动作，而不是只跳转页面', () => {
    const anchor = 'onUseInCanvas={() => {';
    const start = assetsPageSrc.indexOf(anchor);
    expect(start, 'AssetsPage 必须接通详情按钮').toBeGreaterThan(-1);
    const body = assetsPageSrc.slice(start, assetsPageSrc.indexOf('/>', start));
    expect(body).toContain('onUseInCanvas(selAsset)');
    expect(body).not.toContain("onNavigate('canvas')");
  });

  it('App 提供真正的添加处理器', () => {
    expect(appSrc).toContain('onUseInCanvas={handleUseInCanvas}');
  });
});
