/**
 * engine.submit 本地图片节点(crop/stitch/split)输入解析器单测
 * 覆盖:resolveNodeImagePath(asset / piece-N 取片 / resultPath)、
 *       resolveSingleImageInput(连线 > inputImageFrom > inputAssetId 优先级)、
 *       resolveStitchInputs(piece 入边按模式排序 / piecesFrom 回退 / 无产物过滤)
 */
import { describe, it, expect } from 'vitest';
import type { CanvasNode, CanvasEdge } from '@bigbotart/shared';
import {
  resolveNodeImagePath,
  resolveSingleImageInput,
  resolveStitchInputs,
} from '../tool-handlers';

const node = (id: string, kind: string, data: Record<string, unknown> = {}, x = 0, y = 0): CanvasNode =>
  ({ id, kind, label: id, position: { x, y }, data }) as unknown as CanvasNode;

const edge = (source: string, target: string, label?: string): CanvasEdge =>
  ({ source, target, label }) as CanvasEdge;

/** 资产路径表(assetId → localPath) */
const assets = (m: Record<string, string>) => (id: string) => m[id];

describe('resolveNodeImagePath', () => {
  it('asset 节点 → 资产本地路径', () => {
    const n = node('a1', 'asset', { assetId: 'asset-1' });
    expect(resolveNodeImagePath(n, 'input', assets({ 'asset-1': '/lib/pic.png' }))).toBe('/lib/pic.png');
  });

  it('image-split + piece-N 边 → 取第 N 片;越界/无片 → undefined(不静默回退)', () => {
    const sp = node('sp', 'image-split', { resultPath: '/o/p1.png', pieces: ['/o/p1.png', '/o/p2.png', '/o/p3.png'] });
    expect(resolveNodeImagePath(sp, 'piece-2', assets({}))).toBe('/o/p2.png');
    expect(resolveNodeImagePath(sp, 'piece-9', assets({}))).toBeUndefined();
    // 非 piece-N 标签(input)→ 整图默认第 1 片语义由 resultPath 承担
    expect(resolveNodeImagePath(sp, 'input', assets({}))).toBe('/o/p1.png');
  });

  it('普通图片节点 → data.resultPath;无产物 → undefined', () => {
    expect(resolveNodeImagePath(node('g', 'image-gen', { resultPath: '/o/g.png' }), 'input', assets({}))).toBe('/o/g.png');
    expect(resolveNodeImagePath(node('g2', 'image-gen', {}), 'input', assets({}))).toBeUndefined();
    expect(resolveNodeImagePath(undefined, 'input', assets({}))).toBeUndefined();
  });
});

describe('resolveSingleImageInput(裁切/拆分)', () => {
  const canvas = {
    nodes: [
      node('g1', 'image-gen', { resultPath: '/o/g1.png' }),
      node('sp', 'image-split', { pieces: ['/o/s1.png', '/o/s2.png'] }),
      node('a1', 'asset', { assetId: 'asset-9' }),
      node('c', 'image-crop', {}),
      node('c2', 'image-crop', { inputImageFrom: { nodeId: 'g1' } }),
      node('c3', 'image-crop', { inputAssetId: 'asset-9' }),
    ],
    edges: [
      edge('g1', 'c', 'input'),
      edge('sp', 'c2', 'piece-2'), // c2 的 inputImageFrom 指向 g1,但连线 piece-2 优先?不:连线属于 c2 的只有 sp→c2
    ],
  };
  const ap = assets({ 'asset-9': '/lib/a9.png' });

  it('连线 input 端口优先', () => {
    const c = canvas.nodes.find((n) => n.id === 'c')!;
    expect(resolveSingleImageInput(canvas, c, ap)).toBe('/o/g1.png');
  });

  it('piece-N 连线优先于 data.inputImageFrom', () => {
    const c2 = canvas.nodes.find((n) => n.id === 'c2')!;
    // c2 有一条 sp→c2 的 piece-2 边:连线优先,取拆分第 2 片而非 g1 整图
    expect(resolveSingleImageInput(canvas, c2, ap)).toBe('/o/s2.png');
  });

  it('无连线时回退 data.inputAssetId', () => {
    const c3 = canvas.nodes.find((n) => n.id === 'c3')!;
    expect(resolveSingleImageInput(canvas, c3, ap)).toBe('/lib/a9.png');
  });

  it('全空 → undefined', () => {
    const bare = node('cx', 'image-crop', {});
    expect(resolveSingleImageInput({ nodes: [bare], edges: [] }, bare, ap)).toBeUndefined();
  });
});

describe('resolveStitchInputs(拼接)', () => {
  it('column/grid 模式按源节点 y 排序;无产物节点被过滤', () => {
    const st = node('st', 'image-stitch', { mode: 'column' });
    const canvas = {
      nodes: [
        node('gA', 'image-gen', { resultPath: '/o/A.png' }, 0, 300),
        node('gB', 'image-gen', { resultPath: '/o/B.png' }, 0, 100),
        node('gC', 'image-gen', {}, 0, 200), // 无产物 → 过滤
        st,
      ],
      edges: [edge('gA', 'st', 'piece'), edge('gB', 'st', 'piece'), edge('gC', 'st', 'piece')],
    };
    expect(resolveStitchInputs(canvas, st, assets({}))).toEqual(['/o/B.png', '/o/A.png']);
  });

  it('row 模式按源节点 x 排序', () => {
    const st = node('st', 'image-stitch', { mode: 'row' });
    const canvas = {
      nodes: [node('gA', 'image-gen', { resultPath: '/o/A.png' }, 500, 0), node('gB', 'image-gen', { resultPath: '/o/B.png' }, 100, 0), st],
      edges: [edge('gA', 'st', 'piece'), edge('gB', 'st', 'piece')],
    };
    expect(resolveStitchInputs(canvas, st, assets({}))).toEqual(['/o/B.png', '/o/A.png']);
  });

  it('无 piece 入边时回退 data.piecesFrom(渲染层边派生写入)', () => {
    const st = node('st', 'image-stitch', { mode: 'column', piecesFrom: [{ nodeId: 'gA' }, { nodeId: 'gB' }] });
    const canvas = {
      nodes: [node('gA', 'image-gen', { resultPath: '/o/A.png' }), node('gB', 'image-gen', { resultPath: '/o/B.png' }), st],
      edges: [],
    };
    expect(resolveStitchInputs(canvas, st, assets({}))).toEqual(['/o/A.png', '/o/B.png']);
  });
});

describe('resolveRefImagePaths(image-gen 参考图)', () => {
  it('ref-image 入边 → 上游图片路径数组(asset 取资产路径,产物节点取 resultPath)', async () => {
    const { resolveRefImagePaths } = await import('../tool-handlers');
    const canvas = {
      nodes: [
        node('a1', 'asset', { assetId: 'asset-1' }),
        node('g1', 'image-gen', { resultPath: '/o/g1.png' }),
        node('g2', 'image-gen', {}), // 无产物,应被过滤
        node('t', 'image-gen', {}),
      ],
      edges: [
        edge('a1', 't', 'ref-image'),
        edge('g1', 't', 'ref-image'),
        edge('g2', 't', 'ref-image'),
        edge('a1', 't', 'input'), // 非 ref-image 边不计入
      ],
    };
    expect(resolveRefImagePaths(canvas, canvas.nodes[3]!, assets({ 'asset-1': '/lib/p1.png' }))).toEqual([
      '/lib/p1.png',
      '/o/g1.png',
    ]);
  });

  it('无 ref-image 入边 → 空数组', async () => {
    const { resolveRefImagePaths } = await import('../tool-handlers');
    const canvas = { nodes: [node('t', 'image-gen', {})], edges: [] };
    expect(resolveRefImagePaths(canvas, canvas.nodes[0]!, assets({}))).toEqual([]);
  });

  it('image-edit 同样收集 ref-image(2.1 多参考编辑;此前只认 image-gen,Agent 连的参考图被丢弃)', async () => {
    const { resolveRefImagePaths } = await import('../tool-handlers');
    const canvas = {
      nodes: [
        node('a1', 'asset', { assetId: 'asset-1' }),
        node('g1', 'image-gen', { resultPath: '/o/g1.png' }),
        node('e1', 'image-edit', { mode: 'instruction' }),
      ],
      edges: [
        edge('a1', 'e1', 'ref-image'),
        edge('g1', 'e1', 'ref-image'),
        edge('a1', 'e1', 'input'), // input 边不计入参考图
      ],
    };
    expect(resolveRefImagePaths(canvas, canvas.nodes[2]!, assets({ 'asset-1': '/lib/p1.png' }))).toEqual([
      '/lib/p1.png',
      '/o/g1.png',
    ]);
  });
});

describe('buildImageSubmitParams · 工具模型缺省解析(2026-09-29 v1)', () => {
  it('image-gen 未选模型 + 设置页指定 → 用设置值', async () => {
    const { buildImageSubmitParams } = await import('../tool-handlers');
    const canvas = { nodes: [node('g', 'image-gen', { prompt: '猫' })], edges: [] };
    const r = buildImageSubmitParams(canvas, canvas.nodes[0]!, assets({}), {
      image: { 'image.generate': 'Qwen/Qwen-Image-2.1' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.model).toBe('Qwen/Qwen-Image-2.1');
  });

  it('image-gen 未选模型 + 未配置 → 内置默认 z-image-turbo(存量行为)', async () => {
    const { buildImageSubmitParams } = await import('../tool-handlers');
    const canvas = { nodes: [node('g', 'image-gen', { prompt: '猫' })], edges: [] };
    const r = buildImageSubmitParams(canvas, canvas.nodes[0]!, assets({}));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.model).toBe('AbstractFramework/z-image-turbo-8bit');
  });

  it('image-edit(instruction)未选模型 → 内置默认 2.1(决策 1)', async () => {
    const { buildImageSubmitParams } = await import('../tool-handlers');
    const canvas = {
      nodes: [node('a1', 'asset', { assetId: 'asset-1' }), node('e', 'image-edit', { mode: 'instruction' })],
      edges: [edge('a1', 'e', 'input')],
    };
    const r = buildImageSubmitParams(canvas, canvas.nodes[1]!, assets({ 'asset-1': '/lib/p.png' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.model).toBe('Qwen/Qwen-Image-2.1');
  });

  it('节点显式 model 永远优先于设置页与内置默认', async () => {
    const { buildImageSubmitParams } = await import('../tool-handlers');
    const canvas = { nodes: [node('g', 'image-gen', { prompt: '猫', model: 'AbstractFramework/flux.2-klein-9b-8bit' })], edges: [] };
    const r = buildImageSubmitParams(canvas, canvas.nodes[0]!, assets({}), {
      image: { 'image.generate': 'Qwen/Qwen-Image-2.1' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.model).toBe('AbstractFramework/flux.2-klein-9b-8bit');
  });

  it('image-gen 显式 Uncensored + 有 ref-image → 自动改成 instruction 模型(静帧 05 事故)', async () => {
    const { buildImageSubmitParams } = await import('../tool-handlers');
    const canvas = {
      nodes: [
        node('ref', 'image-gen', { resultPath: '/o/ref.png' }),
        node('g', 'image-gen', {
          prompt: '姿势静帧',
          model: 'Qwen-Image-2.1-Uncensored-MLX',
        }),
      ],
      edges: [edge('ref', 'g', 'ref-image')],
    };
    const r = buildImageSubmitParams(canvas, canvas.nodes[1]!, assets({}), {
      image: {
        'image.generate': 'Qwen-Image-2.1-Uncensored-MLX',
        'image.instruction': 'Qwen/Qwen-Image-2.1-Turbo',
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.model).toBe('Qwen/Qwen-Image-2.1-Turbo');
      expect(r.params.__modelHealedFrom).toBe('Qwen-Image-2.1-Uncensored-MLX');
      expect(String(r.params.__modelHealNote)).toContain('不支持参考编辑');
    }
  });
});

describe('buildImageSubmitParams(image 类节点提交参数)', () => {
  it('image-edit:kind 从 mode 推导为 instruction,inputPath 从 input 连线解析', async () => {
    const { buildImageSubmitParams } = await import('../tool-handlers');
    const canvas = {
      nodes: [node('a1', 'asset', { assetId: 'asset-1' }), node('e', 'image-edit', { mode: 'instruction', prompt: '去文字' })],
      edges: [edge('a1', 'e', 'input')],
    };
    const r = buildImageSubmitParams(canvas, canvas.nodes[1]!, assets({ 'asset-1': '/lib/p.png' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.kind).toBe('instruction');
      expect(r.params.inputPath).toBe('/lib/p.png');
      expect(r.params.prompt).toBe('去文字');
    }
  });

  it('image-edit 无输入图连线 → 明确报错(不再静默跑成文生图)', async () => {
    const { buildImageSubmitParams } = await import('../tool-handlers');
    const canvas = { nodes: [node('e', 'image-edit', { mode: 'instruction' })], edges: [] };
    const r = buildImageSubmitParams(canvas, canvas.nodes[0]!, assets({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('没有输入图');
  });

  it('2.1 缺省模型:无 input 但有 ref-image → 放行(create_node 不写 model,提交期才解析成 2.1)', async () => {
    const { buildImageSubmitParams } = await import('../tool-handlers');
    const canvas = {
      nodes: [
        node('g1', 'image-gen', { resultPath: '/o/p1.png' }),
        node('g2', 'image-gen', { resultPath: '/o/p2.png' }),
        node('e', 'image-edit', { mode: 'instruction', prompt: '16:9 主菜单', width: 1024, height: 576 }),
      ],
      edges: [edge('g1', 'e', 'ref-image'), edge('g2', 'e', 'ref-image')],
    };
    const r = buildImageSubmitParams(canvas, canvas.nodes[2]!, assets({}));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.model).toBe('Qwen/Qwen-Image-2.1');
      expect(r.params.kind).toBe('instruction');
      expect(r.params.width).toBe(1024);
      expect(r.params.height).toBe(576);
      expect(r.params.inputPath).toBeUndefined();
    }
  });

  it('2.1 指令编辑:无 input 但有 ref-image 参考图 → 放行(qwen21.edit 允许无底图)', async () => {
    const { buildImageSubmitParams } = await import('../tool-handlers');
    const canvas = {
      nodes: [
        node('a1', 'asset', { assetId: 'asset-1' }),
        node('e', 'image-edit', { mode: 'instruction', model: 'Qwen/Qwen-Image-2.1', prompt: '换成海报风格' }),
      ],
      edges: [edge('a1', 'e', 'ref-image')],
    };
    const r = buildImageSubmitParams(canvas, canvas.nodes[1]!, assets({ 'asset-1': '/lib/p.png' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.inputPath).toBeUndefined();
  });

  it('非 2.1 模型:无 input 只有 ref-image → 仍拦截(qwen.edit/flux2.edit 必须要底图)', async () => {
    const { buildImageSubmitParams } = await import('../tool-handlers');
    const canvas = {
      nodes: [
        node('a1', 'asset', { assetId: 'asset-1' }),
        node('e', 'image-edit', { mode: 'instruction', model: 'mlx-community/Qwen-Image-Edit-8bit' }),
      ],
      edges: [edge('a1', 'e', 'ref-image')],
    };
    const r = buildImageSubmitParams(canvas, canvas.nodes[1]!, assets({ 'asset-1': '/lib/p.png' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('没有输入图');
  });

  it('image-upscale:kind=upscale;image-gen:kind=generate 且不强制输入图', async () => {
    const { buildImageSubmitParams } = await import('../tool-handlers');
    const up = node('u', 'image-upscale', { scale: 2 });
    const g = node('g', 'image-gen', { prompt: 'x' });
    const canvas = { nodes: [up, g], edges: [] };
    const r1 = buildImageSubmitParams(canvas, up, assets({}));
    expect(r1.ok).toBe(false); // upscale 必须有输入图
    const r2 = buildImageSubmitParams(canvas, g, assets({}));
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.params.kind).toBe('generate');
  });
});
