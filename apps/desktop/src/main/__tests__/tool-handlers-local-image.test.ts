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
