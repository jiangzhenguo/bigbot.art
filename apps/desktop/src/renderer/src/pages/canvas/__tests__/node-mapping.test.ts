/**
 * 节点映射测试 — image-crop 初始数据与 shared↔本地 转换
 */
import { describe, it, expect } from 'vitest';
import { makeInitialData, fromSharedNode, toSharedNodes, defaultDataFor, contentKey, preserveMeasuredSize } from '../node-mapping.js';

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

  /* ═══ 2026-09-29 事故回归:extra 参与比对 ⇒ 必须进快照 ═══
     事故:生成完成后 ⑨ 分支设 extra='✓ 文件名' 与 data.resultPath,但 toSharedNodes **丢掉 extra**;
     写盘广播回推后 fromSharedNode 还原的节点没有 extra → applyCanvasSnapshot 的裸 stringify 比对
     判「内容变了」→ setNodes 整体替换 → 刚写入的 resultPath 一并被回退。
     表现:图片明明生成成功(Take 里 resultPath 完整),节点卡不出图、Take 停在「排队中」。
     修法:让 extra 真正随快照往返(而不是把它列为瞬态)。 */
  it('extra 随快照往返 —— 写盘再回推后内容相等(事故回归)', () => {
    const local = { ...base, extra: '✓ out.png', data: { resultPath: '/o/a.png' } };
    const shared = toSharedNodes([local as never]);
    expect((shared[0] as { extra?: string }).extra).toBe('✓ out.png');
    const roundTrip = fromSharedNode(shared[0] as never);
    expect(roundTrip.extra).toBe('✓ out.png');
    // 关键断言:往返后 contentKey 必须相等,否则每次推送都会整体替换掉刚落盘的字段
    expect(contentKey([roundTrip as never], [], [])).toBe(contentKey([local as never], [], []));
  });

  it('无 extra 的节点往返后仍无 extra(不凭空造字段)', () => {
    const local = { ...base, data: { prompt: 'x' } };
    const shared = toSharedNodes([local as never]);
    expect('extra' in (shared[0] as object)).toBe(false);
    expect(fromSharedNode(shared[0] as never).extra).toBeUndefined();
  });

  /* ═══ 2026-10 事故回归:「进画布连线先在中间、随后跳到节点顶部」═══
     事故链:RO 测出 h → 连线在中点 → 写盘广播回推 applyCanvasSnapshot →
     快照节点(无 h)与本地节点(有 h)contentKey 不等 → 判「内容变了」→
     setNodes 整批替换 → h 全丢 → 端点退回兜底高度(节点顶部);
     且 DOM 复用、尺寸未变,RO 不再触发,h 永久缺失。 */
  it('实测高度 h 不参与内容比对(否则每次写盘回推都判内容变更)', () => {
    const a = contentKey([{ ...base }], [], []);
    const b = contentKey([{ ...base, h: 342 }], [], []);
    expect(b).toBe(a);
  });

  it('快照还原节点经 preserveMeasuredSize 合回已测 h 后,与本地内容相等(端到端回归)', () => {
    // 本地:已被 RO 测量(有 h);快照:无 h
    const local = { ...base, h: 342, data: { prompt: 'x' } };
    const restored = fromSharedNode(toSharedNodes([local as never])[0] as never);
    expect(restored.h).toBeUndefined();
    // 不修:contentKey 不等(有 h vs 无 h)→ applyCanvasSnapshot 判内容变更 → 整批替换
    const merged = preserveMeasuredSize([restored], [local as never]);
    expect(merged[0]!.h).toBe(342);
    expect(contentKey(merged as never, [], [])).toBe(contentKey([local as never], [], []));
    // 且快照还原本身与本地内容也判等(h 不算内容)
    expect(contentKey([restored as never], [], [])).toBe(contentKey([local as never], [], []));
  });
});

describe('preserveMeasuredSize · 已测高度按 id 合并', () => {
  const base = { id: 'n1', title: '镜头', w: 250, x: 0, y: 0, kind: 'shot' as const };

  it('按 id 合回 h;快照里没有的新节点保持未测(交由 RO 补测)', () => {
    const loaded = [{ ...base }, { ...base, id: 'n2' }];
    const prev = [{ ...base, h: 200 }, { ...base, id: 'gone', h: 300 }];
    const out = preserveMeasuredSize(loaded as never, prev as never);
    expect(out[0]!.h).toBe(200);
    expect(out[1]!.h).toBeUndefined();
  });

  it('已带 h 的节点不被旧值覆盖(以最新测量为准)', () => {
    const out = preserveMeasuredSize([{ ...base, h: 500 }] as never, [{ ...base, h: 200 }] as never);
    expect(out[0]!.h).toBe(500);
  });

  it('空输入直通(挂载首轮 / 清空画布不炸)', () => {
    expect(preserveMeasuredSize([], [{ ...base, h: 1 }] as never)).toEqual([]);
    const loaded = [{ ...base }];
    expect(preserveMeasuredSize(loaded as never, [])).toBe(loaded);
  });

  it('prev 全部未测时原样返回(不产新数组,避免无谓重渲染)', () => {
    const loaded = [{ ...base }];
    expect(preserveMeasuredSize(loaded as never, [{ ...base }] as never)).toBe(loaded);
  });

  it('非法 h(NaN / 非数字)不参与合并', () => {
    const out = preserveMeasuredSize([{ ...base }] as never, [{ ...base, h: Number.NaN }] as never);
    expect(out[0]!.h).toBeUndefined();
  });
});
