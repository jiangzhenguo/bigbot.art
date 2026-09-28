/**
 * refNodesSignature 测试 — P1 画布节点 memo 的「内容指纹」
 *
 * 这个签名的唯一职责:判断「与分镜表统计相关的内容」有没有变。
 * 它变了 ⇒ StageView 重建 refNodes 派生数组 ⇒ 所有 NodeCard 的 props 换引用。
 * 所以它的**误报(该稳定时不稳定)**会直接让 memo 失效,必须锁死。
 *
 * 关键边界:位置/尺寸/标题/提示词等与统计无关的字段变化,签名必须**不变**。
 */
import { describe, it, expect } from 'vitest';
import { refNodesSignature, sbImgCount, sbMaterializedRows, sbDirty } from '../storyboard.js';
import type { CanvasNode } from '../types.js';

const node = (id: string, extra: Record<string, unknown> = {}, over: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, title: id, w: 236, x: 0, y: 0, h: 72, kind: 'shot', data: extra, ...over }) as CanvasNode;

/** 已铺节点:带 promptFrom 指向某分镜表 */
const materialized = (id: string, sbId: string, row: number, kind = 'shot'): CanvasNode =>
  node(id, { promptFrom: { nodeId: sbId, mode: 'row', row } }, { kind: kind as CanvasNode['kind'] });

describe('refNodesSignature — 与统计无关的变化必须不产生新签名', () => {
  it('位置变化(x/y)不改签名', () => {
    const a = [materialized('n1', 'sb1', 0)];
    const moved = [{ ...a[0]!, x: 999, y: -123 }];
    expect(refNodesSignature(moved)).toBe(refNodesSignature(a));
  });

  it('尺寸变化(w/h)不改签名', () => {
    const a = [materialized('n1', 'sb1', 0)];
    const resized = [{ ...a[0]!, w: 400, h: 300 }];
    expect(refNodesSignature(resized)).toBe(refNodesSignature(a));
  });

  it('标题变化不改签名(统计只看 id/kind/promptFrom)', () => {
    const a = [materialized('n1', 'sb1', 0)];
    const renamed = [{ ...a[0]!, title: '完全不同的标题' }];
    expect(refNodesSignature(renamed)).toBe(refNodesSignature(a));
  });

  it('提示词等 data 字段变化不改签名', () => {
    const a = [materialized('n1', 'sb1', 0)];
    const written = [{ ...a[0]!, data: { ...a[0]!.data, prompt: '一段很长的提示词' } }];
    expect(refNodesSignature(written)).toBe(refNodesSignature(a));
  });

  it('节点数组顺序变化不改签名(排序后拼接)', () => {
    const a = [materialized('n1', 'sb1', 0), materialized('n2', 'sb1', 1)];
    const reordered = [a[1]!, a[0]!];
    expect(refNodesSignature(reordered)).toBe(refNodesSignature(a));
  });

  it('无 promptFrom 的节点增删不改签名(不参与统计)', () => {
    const a = [materialized('n1', 'sb1', 0)];
    const withPlain = [...a, node('plain1'), node('plain2', { prompt: 'x' })];
    expect(refNodesSignature(withPlain)).toBe(refNodesSignature(a));
  });

  it('空数组 → 空签名', () => {
    expect(refNodesSignature([])).toBe('');
  });
});

describe('refNodesSignature — 与统计相关的变化必须产生新签名', () => {
  it('新增已铺节点 → 签名变化', () => {
    const a = [materialized('n1', 'sb1', 0)];
    const b = [...a, materialized('n2', 'sb1', 1)];
    expect(refNodesSignature(b)).not.toBe(refNodesSignature(a));
  });

  it('行号变化 → 签名变化', () => {
    const a = [materialized('n1', 'sb1', 0)];
    const b = [materialized('n1', 'sb1', 2)];
    expect(refNodesSignature(b)).not.toBe(refNodesSignature(a));
  });

  it('指向的分镜表变化 → 签名变化', () => {
    const a = [materialized('n1', 'sb1', 0)];
    const b = [materialized('n1', 'sb2', 0)];
    expect(refNodesSignature(b)).not.toBe(refNodesSignature(a));
  });

  it('kind 变化 → 签名变化(image-gen 计数依赖它)', () => {
    const a = [materialized('n1', 'sb1', 0, 'shot')];
    const b = [materialized('n1', 'sb1', 0, 'image-gen')];
    expect(refNodesSignature(b)).not.toBe(refNodesSignature(a));
  });

  it('删除已铺节点 → 签名变化', () => {
    const a = [materialized('n1', 'sb1', 0), materialized('n2', 'sb1', 1)];
    expect(refNodesSignature([a[0]!])).not.toBe(refNodesSignature(a));
  });
});

describe('派生数组的语义等价性 — 签名不变 ⇒ 统计结果不变', () => {
  /* 这是签名正确性的**因果验证**:签名宣称「统计不会变」,就直接跑统计比结果。
     比只比对字符串更能防「签名漏了某个字段」的回归。 */
  const SB = node('sb1', { markdown: '| 镜 | 画面 |\n|---|---|\n| 1 | 甲 |\n| 2 | 乙 |' }, { kind: 'storyboard' as CanvasNode['kind'] });

  const stats = (ns: CanvasNode[]) => ({
    rows: sbMaterializedRows('sb1', ns),
    imgs: sbImgCount('sb1', ns),
    dirty: sbDirty(SB, ns),
  });

  it('位置/尺寸/标题变化后,三项统计结果完全一致', () => {
    const a = [materialized('n1', 'sb1', 0), materialized('n2', 'sb1', 1, 'image-gen')];
    const moved = a.map((n, i) => ({ ...n, x: i * 500, y: -i * 200, w: 300, title: `改过${i}` }));
    expect(refNodesSignature(moved)).toBe(refNodesSignature(a));
    expect(stats(moved)).toEqual(stats(a));
  });

  it('新增已铺节点后,统计结果确实变化(签名与语义同向)', () => {
    const a = [materialized('n1', 'sb1', 0)];
    const b = [...a, materialized('n2', 'sb1', 1)];
    expect(refNodesSignature(b)).not.toBe(refNodesSignature(a));
    expect(stats(b)).not.toEqual(stats(a));
  });

  it('image-gen 计数只认非 shot 节点(签名含 kind 的原因)', () => {
    const shotOnly = [materialized('n1', 'sb1', 0, 'shot')];
    const withImg = [materialized('n1', 'sb1', 0, 'shot'), materialized('n2', 'sb1', 1, 'image-gen')];
    expect(stats(shotOnly).imgs).toBe(0);
    expect(stats(withImg).imgs).toBe(1);
  });
});
