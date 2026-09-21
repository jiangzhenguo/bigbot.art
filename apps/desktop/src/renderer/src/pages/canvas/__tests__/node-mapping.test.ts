/**
 * 节点映射测试 — image-crop 初始数据与 shared↔本地 转换
 */
import { describe, it, expect } from 'vitest';
import { makeInitialData, fromSharedNode, toSharedNodes, defaultDataFor } from '../node-mapping.js';

describe('makeInitialData · image-crop', () => {
  it('默认为 9:16 · center 锚点', () => {
    const d = makeInitialData({ id: 'crop', kind: 'image-crop', name: '图片裁切', sub: '' });
    expect(d.aspect).toBe('9:16');
    expect(d.focus).toBe('center');
  });
});

describe('defaultDataFor · image-crop(快照缺数据时)', () => {
  it('与 makeInitialData 一致(渲染与生成可用默认值)', () => {
    expect(defaultDataFor('image-crop')).toEqual(makeInitialData({ id: '', kind: 'image-crop', name: '', sub: '' }));
  });
});

describe('fromSharedNode / toSharedNodes · image-crop 往返', () => {
  it('shared image-crop 节点 → 本地节点 kind 透传', () => {
    const n = fromSharedNode({ id: 'c1', kind: 'image-crop', label: '裁切', width: 220, position: { x: 1, y: 2 } });
    expect(n.kind).toBe('image-crop');
    expect(n.w).toBe(220);
  });

  it('本地 image-crop 节点 → shared 快照保留 kind 与 data', () => {
    const out = toSharedNodes([{ id: 'c1', title: '裁切', w: 220, x: 1, y: 2, kind: 'image-crop', data: { aspect: '16:9', focus: 'top' } }]);
    expect(out[0]!.kind).toBe('image-crop');
    expect((out[0]!.data as { aspect: string }).aspect).toBe('16:9');
  });
});