/**
 * 节点映射测试 — image-crop 初始数据与 shared↔本地 转换
 */
import { describe, it, expect } from 'vitest';
import { makeInitialData, fromSharedNode, toSharedNodes, defaultDataFor, contentKey } from '../node-mapping.js';

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
describe('contentKey · 瞬态 UI 字段归一化', () => {
  const base = { id: 'n1', title: '图片生成', w: 220, x: 0, y: 0, kind: 'image-gen' as const };

  it('运行期 badge/running 变化不算内容改动(否则每次队列推送都写盘)', () => {
    const a = contentKey([{ ...base }], [], []);
    const b = contentKey([{ ...base, badge: '采样中… 40%', running: true }], [], []);
    expect(b).toBe(a);
  });

  it('进度/幽灵/过期/接力标记同样不参与比对', () => {
    const a = contentKey([{ ...base }], [], []);
    const b = contentKey(
      [{ ...base, progress: { text: '超分 3/5', pct: 0.4 }, ghost: true, stale: true, agentOn: true }],
      [],
      [],
    );
    expect(b).toBe(a);
  });

  it('真实内容改动(badge 之外)仍能识别', () => {
    const a = contentKey([{ ...base }], [], []);
    expect(contentKey([{ ...base, data: { prompt: 'x' } }], [], [])).not.toBe(a);
    expect(contentKey([{ ...base, x: 10 }], [], [])).not.toBe(a);
  });

  it('extra(产物提示行)参与比对 —— 它承载「✓ 完成」回填,抹掉会丢反馈', () => {
    const a = contentKey([{ ...base }], [], []);
    expect(contentKey([{ ...base, extra: '✓ out.mp4' }], [], [])).not.toBe(a);
  });
});
