/**
 * 镜头检查器 × 自动绑定 → 定位对应入边(2026-10-13 技能4 回归)
 *
 * 事故:× 只写 refsSuppressed,不删边;ref-image 多值端口停用无效 → 条目弹回、连线仍在。
 */
import { describe, it, expect } from 'vitest';
import { findAutoRefEdgeSource } from '../ref-binding';

const nodes = [
  { id: 'env', data: { resultPath: '/out/env.png' } },
  { id: 'card', data: { resultPath: '/out/card.png' } },
  { id: 'hand', data: { resultPath: '/out/hand.png' } },
  { id: 'asset', data: { assetId: 'asset-a1' } },
  { id: 'up', data: { resultPath: '/out/up.mp4', tailFramePath: '/out/up-tail.png' } },
  { id: 'shot', data: { mode: 'ref-image' } },
];

const edges = [
  { from: 'env', to: 'shot', label: 'first-frame' },
  { from: 'card', to: 'shot', label: 'ref-image' },
  { from: 'hand', to: 'shot', label: 'ref-image' },
  { from: 'asset', to: 'shot', label: 'ref-image' },
];

describe('findAutoRefEdgeSource', () => {
  it('按 path 精确命中多值 ref-image 中的一张(技能4 形态)', () => {
    expect(
      findAutoRefEdgeSource(
        'shot',
        { role: 'ref-image', path: '/out/card.png', auto: true },
        nodes,
        edges,
      ),
    ).toBe('card');
    expect(
      findAutoRefEdgeSource(
        'shot',
        { role: 'ref-image', path: '/out/hand.png', auto: true },
        nodes,
        edges,
      ),
    ).toBe('hand');
  });

  it('按 assetId 命中资产参考', () => {
    expect(
      findAutoRefEdgeSource(
        'shot',
        { role: 'ref-image', assetId: 'asset-a1', auto: true },
        nodes,
        edges,
      ),
    ).toBe('asset');
  });

  it('首帧边按 path 命中', () => {
    expect(
      findAutoRefEdgeSource(
        'shot',
        { role: 'first-frame', path: '/out/env.png', auto: true },
        nodes,
        edges,
      ),
    ).toBe('env');
  });

  it('上游尾帧路径命中 first-frame 边', () => {
    const e = [{ from: 'up', to: 'shot', label: 'first-frame' }];
    expect(
      findAutoRefEdgeSource(
        'shot',
        { role: 'first-frame', path: '/out/up-tail.png', auto: true },
        nodes,
        e,
      ),
    ).toBe('up');
  });

  it('手动绑定(非 auto)不找边', () => {
    expect(
      findAutoRefEdgeSource(
        'shot',
        { role: 'ref-image', path: '/out/card.png', auto: false },
        nodes,
        edges,
      ),
    ).toBeNull();
  });

  it('role/path 对不上 → null', () => {
    expect(
      findAutoRefEdgeSource(
        'shot',
        { role: 'ref-image', path: '/out/missing.png', auto: true },
        nodes,
        edges,
      ),
    ).toBeNull();
  });
});
