/**
 * 节点接力(cascade)纯函数测试 — 上游成功后自动接力下游生成节点
 * 覆盖:直接下游过滤 / 传递闭包(含环安全)/ 接力目标选择(产物/stale/忙 三重判定)
 */
import { describe, it, expect } from 'vitest';
import {
  CASCADE_KINDS,
  directDownstreamGenIds,
  allDownstreamGenIds,
  pickCascadeTargets,
  shouldKickCascade,
} from '../cascade.js';
import type { CanvasNode, Edge } from '../types.js';

const node = (id: string, kind: string, data: Record<string, unknown> = {}): CanvasNode =>
  ({ id, title: id, w: 200, x: 0, y: 0, kind: kind as CanvasNode['kind'], data }) as CanvasNode;

const edge = (from: string, to: string): Edge => ({ from, to, cls: '' });

describe('directDownstreamGenIds · 直接下游生成节点', () => {
  it('只取 sourceId 出边指向的生成类节点,文档/时间线等不参与接力', () => {
    const nodes = [
      node('u', 'shot', { resultPath: '/o/u.mp4', tailFramePath: '/o/u-last.png' }),
      node('d1', 'shot'),
      node('d2', 'image-gen'),
      node('doc', 'document', { markdown: 'x' }),
      node('tl', 'timeline'),
    ];
    const edges = [edge('u', 'd1'), edge('u', 'doc'), edge('u', 'tl'), edge('u', 'd2')];
    expect(directDownstreamGenIds('u', nodes, edges)).toEqual(['d1', 'd2']);
  });

  it('多出边指向同一下游去重,保持边序', () => {
    const nodes = [node('u', 'shot'), node('d', 'shot')];
    const edges = [edge('u', 'd'), { ...edge('u', 'd'), cls: 'ghost' as const }];
    expect(directDownstreamGenIds('u', nodes, edges)).toEqual(['d']);
  });
});

describe('allDownstreamGenIds · 传递闭包', () => {
  it('链式 A→B→C→D 全量收集(不含源自身)', () => {
    const nodes = [node('a', 'shot'), node('b', 'shot'), node('c', 'image-gen'), node('d', 'shot')];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')];
    expect(allDownstreamGenIds(['a'], nodes, edges)).toEqual(['b', 'c', 'd']);
  });

  it('环(a→b→a)不死循环', () => {
    const nodes = [node('a', 'shot'), node('b', 'shot')];
    const edges = [edge('a', 'b'), edge('b', 'a')];
    expect(allDownstreamGenIds(['a'], nodes, edges)).toEqual(['b']);
  });

  it('非生成类节点不进入闭包且不继续向下遍历', () => {
    const nodes = [node('a', 'shot'), node('doc', 'document'), node('x', 'shot')];
    const edges = [edge('a', 'doc'), edge('doc', 'x')];
    expect(allDownstreamGenIds(['a'], nodes, edges)).toEqual([]);
  });

  it('CASCADE_KINDS 覆盖四种生成节点 + 裁切', () => {
    expect(CASCADE_KINDS.has('shot')).toBe(true);
    expect(CASCADE_KINDS.has('image-gen')).toBe(true);
    expect(CASCADE_KINDS.has('image-edit')).toBe(true);
    expect(CASCADE_KINDS.has('image-upscale')).toBe(true);
    expect(CASCADE_KINDS.has('image-crop')).toBe(true);
    expect(CASCADE_KINDS.has('document')).toBe(false);
    expect(CASCADE_KINDS.has('workflow-output')).toBe(false);
  });
});

describe('pickCascadeTargets · 接力目标选择', () => {
  const neverBusy = () => false;

  it('无产物(首跑/幽灵)的直接下游入选', () => {
    const nodes = [node('u', 'shot'), node('d', 'shot')]; // d 无 resultPath
    expect(pickCascadeTargets('u', nodes, [edge('u', 'd')], { isBusy: neverBusy })).toEqual(['d']);
  });

  it('已有产物且未 stale ⇒ 视为最新,跳过', () => {
    const nodes = [node('u', 'shot'), node('d', 'shot', { resultPath: '/o/d.mp4' })];
    expect(pickCascadeTargets('u', nodes, [edge('u', 'd')], { isBusy: neverBusy })).toEqual([]);
  });

  it('已有产物但已标 stale ⇒ 重新接力(上游重跑的刷新语义)', () => {
    const nodes = [node('u', 'shot'), { ...node('d', 'shot', { resultPath: '/o/d.mp4' }), stale: true }];
    expect(pickCascadeTargets('u', nodes, [edge('u', 'd')], { isBusy: neverBusy })).toEqual(['d']);
  });

  it('已在队列(queued/running)或本接力轮已提交 ⇒ 跳过,防重复入队', () => {
    const nodes = [node('u', 'shot'), node('d1', 'shot'), node('d2', 'shot')];
    const edges = [edge('u', 'd1'), edge('u', 'd2')];
    const busy = (id: string) => id === 'd1';
    expect(pickCascadeTargets('u', nodes, edges, { isBusy: busy })).toEqual(['d2']);
  });
});

describe('shouldKickCascade · 进画布不得误接力(猫侠传事故)', () => {
  it('queued → succeeded:真正完成,应接力', () => {
    expect(shouldKickCascade('queued', 'succeeded')).toBe(true);
  });

  it('running → succeeded:真正完成,应接力', () => {
    expect(shouldKickCascade('running', 'succeeded')).toBe(true);
  });

  it('undefined → succeeded:重挂载首次看见历史成功任务,不接力', () => {
    expect(shouldKickCascade(undefined, 'succeeded')).toBe(false);
  });

  it('succeeded → succeeded:无迁移,不接力', () => {
    expect(shouldKickCascade('succeeded', 'succeeded')).toBe(false);
  });

  it('failed/cancelled → succeeded:不是在途完成,不接力', () => {
    expect(shouldKickCascade('failed', 'succeeded')).toBe(false);
    expect(shouldKickCascade('cancelled', 'succeeded')).toBe(false);
  });

  it('非成功终态一律不接力', () => {
    expect(shouldKickCascade('queued', 'running')).toBe(false);
    expect(shouldKickCascade('running', 'failed')).toBe(false);
    expect(shouldKickCascade(undefined, 'running')).toBe(false);
  });
});
