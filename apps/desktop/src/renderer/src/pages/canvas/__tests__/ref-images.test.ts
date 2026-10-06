/**
 * 参考图展示区单测 —— image-ui 的 resolveRefImages(RefImagesCard 的唯一数据源)
 *
 * 背景(2026-10 用户要求):ref-image 与 input 是**两个不同端口** ——
 * input 是「被编辑的底图」,ref-image 是「参考」。早期实现把参考图塞进
 * 「输入图」那张卡(ref-image 仅作无底图时的兜底),用户分不清哪张会被改。
 * 现在参考图有独立的展示区,本文件锁住它的解析口径:
 *  ① asset 参考图走 assetCache,其余走 resultPath(与 upstreamImagePath 同口径);
 *  ② 拿不到图时给出**具体原因**,不能只留空框;
 *  ③ 源节点被删掉必须显式标注,而不是静默显示空框;
 *  ④ 顺序即语义(Submitted 时首张锚定几何),不得重排。
 */
import { describe, it, expect } from 'vitest';
import { resolveRefImages } from '../inspector/image-ui';
import type { CanvasNode } from '../types';

const node = (id: string, kind: string, data: Record<string, unknown> = {}, title?: string): CanvasNode =>
  ({ id, title: title ?? id, x: 0, y: 0, w: 200, kind: kind as CanvasNode['kind'], data }) as CanvasNode;

const emptyCache: Record<string, string> = {};

describe('resolveRefImages — 基本解析', () => {
  it('空 / 缺省 → 空数组(组件据此不渲染整块)', () => {
    expect(resolveRefImages({ nodes: [], assetCache: emptyCache })).toEqual([]);
    expect(resolveRefImages({ refImageFrom: [], nodes: [], assetCache: emptyCache })).toEqual([]);
  });

  it('过滤掉缺 nodeId 的脏数据(派生态残留不该渲染成空格子)', () => {
    const r = resolveRefImages({
      refImageFrom: [{}, { nodeId: '' }, { nodeId: 'g1' }],
      nodes: [node('g1', 'image-gen', { resultPath: '/a/outputs/images/x.png' })],
      assetCache: emptyCache,
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.nodeId).toBe('g1');
  });

  it('image-gen 参考图:走 data.resultPath,src 为 bba-output URL', () => {
    const gen = node('g1', 'image-gen', { resultPath: '/Users/me/.bigbotart/outputs/images/ref-1.png' }, '参考图 A');
    const r = resolveRefImages({ refImageFrom: [{ nodeId: 'g1' }], nodes: [gen], assetCache: emptyCache });
    expect(r[0]!.src).toBe('bba-output://images/ref-1.png');
    expect(r[0]!.title).toBe('参考图 A');
    expect(r[0]!.note).toContain('产物直通');
    expect(r[0]!.missing).toBe(false);
  });

  it('asset 参考图:走 assetCache[data.assetId](asset 节点没有 resultPath)', () => {
    const a = node('a1', 'asset', { assetId: 'asset-ref' }, '参考图 B');
    const r = resolveRefImages({
      refImageFrom: [{ nodeId: 'a1' }],
      nodes: [a],
      assetCache: { 'asset-ref': '/Users/me/.bigbotart/assets/asset-ref.webp' },
    });
    expect(r[0]!.src).toBe('bba-asset://asset-ref.webp');
    expect(r[0]!.note).toContain('素材直通');
  });

  it('顺序即语义:输入顺序原样保留(提交时首张锚定几何)', () => {
    const nodes = [
      node('c', 'image-gen', { resultPath: '/a/outputs/images/c.png' }, 'C'),
      node('a', 'image-gen', { resultPath: '/a/outputs/images/a.png' }, 'A'),
      node('b', 'image-gen', { resultPath: '/a/outputs/images/b.png' }, 'B'),
    ];
    const r = resolveRefImages({
      refImageFrom: [{ nodeId: 'c' }, { nodeId: 'a' }, { nodeId: 'b' }],
      nodes,
      assetCache: emptyCache,
    });
    expect(r.map((x) => x.title)).toEqual(['C', 'A', 'B']);
  });
});

describe('resolveRefImages — 未就绪时的原因必须具体', () => {
  it('参考图节点还没跑出产物:note 说「上游暂无产物」,src 为 null', () => {
    const gen = node('g1', 'image-gen', {}, '还没跑');
    const r = resolveRefImages({ refImageFrom: [{ nodeId: 'g1' }], nodes: [gen], assetCache: emptyCache });
    expect(r[0]!.src).toBeNull();
    expect(r[0]!.note).toBe('上游暂无产物');
  });

  it('asset 参考图但缓存未命中:note 带上 assetId,便于排查', () => {
    const a = node('a1', 'asset', { assetId: 'asset-missing' }, '资产参考');
    const r = resolveRefImages({ refImageFrom: [{ nodeId: 'a1' }], nodes: [a], assetCache: emptyCache });
    expect(r[0]!.src).toBeNull();
    expect(r[0]!.note).toContain('资产未加载');
    expect(r[0]!.note).toContain('asset-missing');
  });

  it('asset 节点没绑资产:与「绑了但没加载」区分开', () => {
    const a = node('a1', 'asset', {}, '空资产节点');
    const r = resolveRefImages({ refImageFrom: [{ nodeId: 'a1' }], nodes: [a], assetCache: emptyCache });
    expect(r[0]!.note).toBe('节点未绑定资产');
  });

  it('源节点已被删除:显式标注 missing,不静默显示空框', () => {
    const r = resolveRefImages({ refImageFrom: [{ nodeId: 'gone' }], nodes: [], assetCache: emptyCache });
    expect(r[0]!.missing).toBe(true);
    expect(r[0]!.src).toBeNull();
    expect(r[0]!.note).toBe('源节点已删除');
    expect(r[0]!.title).toBe('gone'); // 无标题可回落 → 用 id 兜底
  });
});
