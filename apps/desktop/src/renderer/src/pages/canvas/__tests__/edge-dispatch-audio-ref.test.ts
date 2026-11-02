/**
 * 音频参考节点(audio-ref)→ 镜头 ref-audio —— 渲染层派发补齐(2026-11)
 *
 * 事故面:`audio-ref` 节点能连到 shot 的 `ref-audio` 端口
 * (渲染层 connectors.ts 的 BY_KIND['audio-ref'].shot = ['ref-audio', …],
 *  shared 的 CONNECTOR_MAP 同款;音乐闸 skill-gates 也认这个来源),
 * 但 edge-dispatch 的 shot 分支只处理 asset / fromShot / VIDEO_KINDS / fromImage,
 * **没有 audio-ref** ⇒ 这条边「画得出来、却什么都不派发」。
 *
 * 修法:audio-ref 节点通过 data.assetId 绑定一条**音频资产**,
 * 派发产出 `{ assetId, role:'ref-audio', auto:true }` —— 与 asset 分支**完全一致**
 * (资产 id 引用,不是路径),并同样遵守 autoBlocked 让位规则
 * (用户手绑优先 / refsSuppressed 停用)。
 *
 * 与 shared 侧 deriveShotRefsFromEdges 同口径 —— 两条链路不能分叉。
 */
import { describe, it, expect } from 'vitest';
import { computeEdgeDerivations } from '../edge-dispatch.js';
import type { CanvasNode, Edge } from '../types.js';

const node = (id: string, kind: string, data: Record<string, unknown> = {}): CanvasNode =>
  ({ id, title: id, w: 200, x: 0, y: 0, kind: kind as CanvasNode['kind'], data }) as CanvasNode;

const edge = (from: string, to: string, label: string): Edge => ({ from, to, cls: '', label });

type Ref = { assetId?: string; path?: string; role: string; auto?: boolean };

const refsOf = (ns: CanvasNode[], id: string): Ref[] =>
  ((ns.find((n) => n.id === id)!.data as { refs?: Ref[] }).refs ?? []);

describe('audio-ref 节点 → shot 的 ref-audio 派发(渲染层)', () => {
  it('audio-ref → shot:refs 注入 { assetId, role:ref-audio, auto:true }(与 asset 分支同构)', () => {
    const nodes = [node('ar', 'audio-ref', { assetId: 'asset-audio-1' }), node('down', 'shot', { refs: [] })];
    const { nextNodes } = computeEdgeDerivations(nodes, [edge('ar', 'down', 'ref-audio')]);
    expect(refsOf(nextNodes, 'down')).toEqual([{ assetId: 'asset-audio-1', role: 'ref-audio', auto: true }]);
  });

  it('对照组:asset(audio) → shot ref-audio 行为不变(仍是 assetId 引用)', () => {
    const nodes = [node('au', 'asset', { mediaType: 'audio', assetId: 'asset-au' }), node('down', 'shot', { refs: [] })];
    const { nextNodes } = computeEdgeDerivations(nodes, [edge('au', 'down', 'ref-audio')]);
    expect(refsOf(nextNodes, 'down')).toEqual([{ assetId: 'asset-au', role: 'ref-audio', auto: true }]);
  });

  it('节点还没绑定资产(data.assetId 为空)⇒ 不产出空引用(与 asset 分支同纪律)', () => {
    const nodes = [node('ar', 'audio-ref', {}), node('down', 'shot', { refs: [] })];
    const { nextNodes } = computeEdgeDerivations(nodes, [edge('ar', 'down', 'ref-audio')]);
    expect(refsOf(nextNodes, 'down')).toEqual([]);
  });

  it('让位规则:用户手动绑定了 ref-audio(非 auto)⇒ 自动项不覆盖用户意图', () => {
    const nodes = [
      node('ar', 'audio-ref', { assetId: 'asset-audio-1' }),
      node('down', 'shot', { refs: [{ assetId: 'asset-manual', role: 'ref-audio' }] }),
    ];
    const { nextNodes } = computeEdgeDerivations(nodes, [edge('ar', 'down', 'ref-audio')]);
    const refs = refsOf(nextNodes, 'down');
    expect(refs.some((r) => r.assetId === 'asset-manual')).toBe(true);
    expect(refs.some((r) => r.assetId === 'asset-audio-1')).toBe(false);
  });

  it('让位规则:refsSuppressed 停用了 ref-audio ⇒ 不自动注入(用户点过 ×)', () => {
    const nodes = [
      node('ar', 'audio-ref', { assetId: 'asset-audio-1' }),
      node('down', 'shot', { refs: [], refsSuppressed: ['ref-audio'] }),
    ];
    const { nextNodes } = computeEdgeDerivations(nodes, [edge('ar', 'down', 'ref-audio')]);
    expect(refsOf(nextNodes, 'down')).toEqual([]);
  });

  it('删掉 ref-audio 边 ⇒ 自动注入的引用被撤销(手动项保留)', () => {
    const nodes = [
      node('ar', 'audio-ref', { assetId: 'asset-audio-1' }),
      node('down', 'shot', { refs: [] }),
    ];
    const once = computeEdgeDerivations(nodes, [edge('ar', 'down', 'ref-audio')]);
    expect(refsOf(once.nextNodes, 'down')).toHaveLength(1);
    const twice = computeEdgeDerivations(once.nextNodes, []);
    expect(refsOf(twice.nextNodes, 'down')).toEqual([]);
  });

  it('ref-audio 边不触发 mode 自动切换(参考音频是独立语义,不当作首帧接续)', () => {
    const nodes = [
      node('ar', 'audio-ref', { assetId: 'asset-audio-1' }),
      node('down', 'shot', { mode: 'text2video', refs: [] }),
    ];
    const { nextNodes } = computeEdgeDerivations(nodes, [edge('ar', 'down', 'ref-audio')]);
    expect((nextNodes.find((n) => n.id === 'down')!.data as { mode: string }).mode).toBe('text2video');
  });

  it('幂等:同一份边再算一次内容不变(changed=false)', () => {
    const nodes = [node('ar', 'audio-ref', { assetId: 'asset-audio-1' }), node('down', 'shot', { refs: [] })];
    const edges = [edge('ar', 'down', 'ref-audio')];
    const once = computeEdgeDerivations(nodes, edges);
    expect(once.changed).toBe(true);
    const twice = computeEdgeDerivations(once.nextNodes, edges);
    expect(twice.changed).toBe(false);
    expect(refsOf(twice.nextNodes, 'down')).toEqual([{ assetId: 'asset-audio-1', role: 'ref-audio', auto: true }]);
  });
});
