/**
 * canvas-history 测试 — 撤销/重做历史栈
 * 用例:结构签名去重(尺寸/瞬态字段变更不记)、上下限裁剪、撤销/重做往返、
 *      回放闸门(回放期间的 commit 被忽略)、reset/clear 语义
 */
import { describe, it, expect } from 'vitest';
import { HistoryStack, structureSig, HISTORY_LIMIT } from '../canvas-history.js';

/** 造一个最小节点(只含签名关心的字段) */
const n = (id: string, x = 0, y = 0, data: Record<string, unknown> = {}) => ({
  id,
  title: id,
  x,
  y,
  kind: 'document',
  data,
});

const content = (nodes: unknown[], edges: unknown[] = []) => ({ nodes, edges });

describe('structureSig', () => {
  it('忽略节点尺寸 w/h(measure 抖动不产生历史)', () => {
    const a = [{ ...n('a'), w: 224, h: 72 }];
    const b = [{ ...n('a'), w: 236, h: 180 }];
    expect(structureSig(a, [])).toBe(structureSig(b, []));
  });

  it('忽略 badge/flash/stale/ghost 等瞬态字段', () => {
    const a = [{ ...n('a'), badge: '生成中…', flash: true, stale: true, ghost: true }];
    const b = [{ ...n('a'), badge: undefined, flash: false, stale: false, ghost: false }];
    expect(structureSig(a, [])).toBe(structureSig(b, []));
  });

  it('位置/标题/数据/连线变化会改变签名', () => {
    expect(structureSig([n('a', 1)], [])).not.toBe(structureSig([n('a', 2)], []));
    expect(structureSig([n('a', 0, 0, { p: 1 })], [])).not.toBe(structureSig([n('a', 0, 0, { p: 2 })], []));
    expect(structureSig([n('a')], [{ from: 'a', to: 'b' }])).not.toBe(structureSig([n('a')], []));
  });

  it('与数组顺序无关(节点顺序调整不算编辑)', () => {
    expect(structureSig([n('a'), n('b')], [])).toBe(structureSig([n('b'), n('a')], []));
  });
});

describe('HistoryStack', () => {
  it('结构无变化时不记录(拖动/测量的高频写入被吸收)', () => {
    const h = new HistoryStack();
    h.reset(content([n('a')]));
    h.commit(content([n('a')]), '改写提示词'); // 与基线同 → 丢弃
    expect(h.canUndo()).toBe(false);
  });

  it('提交后可以撤销,撤销后可以重做(往返一致)', () => {
    const h = new HistoryStack();
    const v0 = content([n('a')]);
    const v1 = content([n('a', 100)]);
    h.reset(v0);
    h.commit(v1, '移动节点'); // 编辑后 = v1(编辑前 v0 由基线保存)
    expect(h.canUndo()).toBe(true);

    const undo = h.stepUndo(v1);
    expect(undo?.label).toBe('移动节点');
    expect(undo?.content).toEqual(v0);
    h.endReplay(v0);

    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(true);

    const redo = h.stepRedo(v0);
    expect(redo?.content).toEqual(v1);
    h.endReplay(v1);
    expect(h.canRedo()).toBe(false);
    expect(h.canUndo()).toBe(true);
  });

  it('新的编辑会清空重做栈', () => {
    const h = new HistoryStack();
    const v0 = content([n('a')]);
    const v1 = content([n('a', 50)]);
    h.reset(v0);
    h.commit(v1, '移动');
    h.endReplay(h.stepUndo(v1)!.content);
    expect(h.canRedo()).toBe(true);
    h.commit(content([n('a', 50), n('b')]), '新增节点');
    expect(h.canRedo()).toBe(false);
  });

  it('回放闸门:回放期间的 commit 一律忽略', () => {
    const h = new HistoryStack();
    h.reset(content([n('a')]));
    h.beginReplay();
    h.commit(content([n('a', 10)]), '回放写入');
    expect(h.canUndo()).toBe(false);
    h.endReplay(content([n('a', 10)]));
    expect(h.canUndo()).toBe(false);
  });

  it('超过上限时丢弃最旧的一条', () => {
    const h = new HistoryStack();
    let cur = content([n('a', 0)]);
    h.reset(cur);
    for (let i = 1; i <= HISTORY_LIMIT + 5; i++) {
      h.commit(content([n('a', i)]), `编辑 ${i}`);
      cur = content([n('a', i)]);
    }
    expect(h.counts().undo).toBe(HISTORY_LIMIT);
  });

  it('结束时不能撤销;reset 清空重做栈', () => {
    const h = new HistoryStack();
    const v0 = content([n('a')]);
    const v1 = content([n('a', 9)]);
    h.reset(v0);
    h.commit(v1, '移动');
    h.endReplay(h.stepUndo(v1)!.content);
    expect(h.canRedo()).toBe(true);
    h.reset(v1);
    expect(h.canRedo()).toBe(false);
  });

  it('空栈上撤销/重做返回 null', () => {
    const h = new HistoryStack();
    h.reset(content([]));
    expect(h.stepUndo(content([]))).toBeNull();
    expect(h.stepRedo(content([]))).toBeNull();
  });

  /* ── 回归:2026-09-22「新建的节点撤销不掉」实测事故 ──
     多条独立缺陷,任何一条复发都会让撤销永远置灰,这里逐条钉住。 */

  it('回归①:commit 只需传「编辑后」内容,内部用基线当撤销目标', () => {
    const h = new HistoryStack();
    const before = content([n('a')]);
    const after = content([n('a'), n('b')]);
    h.reset(before);
    h.commit(after, '从节点库添加节点'); // 只传编辑后内容
    expect(h.canUndo()).toBe(true);
    expect(h.stepUndo(after)?.content).toEqual(before); // 撤销目标 = 编辑前
  });

  it('回归②:重复 commit 同一份内容不会重复入栈(自动保存回推不污染历史)', () => {
    const h = new HistoryStack();
    const before = content([n('a')]);
    const after = content([n('a'), n('b')]);
    h.reset(before);
    h.commit(after, '添加节点');
    h.commit(after, '添加节点');
    h.commit(after, '添加节点');
    expect(h.counts().undo).toBe(1); // 只记一条
  });

  it('回归③:reset(画布加载/外部写入)后旧历史失效,新编辑仍可撤销', () => {
    const h = new HistoryStack();
    const v0 = content([n('a')]);
    const v1 = content([n('a'), n('b')]);
    h.reset(v0);
    h.commit(v1, '添加节点');
    expect(h.canUndo()).toBe(true);
    h.clear();
    h.reset(v1); // 外部写入(Agent 工具 / 另一方保存)→ 换基线
    expect(h.canUndo()).toBe(false);
    const v2 = content([n('a'), n('b'), n('c')]);
    h.commit(v2, '再添加节点');
    expect(h.canUndo()).toBe(true);
    expect(h.stepUndo(v2)?.content).toEqual(v1);
  });

  it('回归④:拖动这类长事务用 commitFrom 指定起点', () => {
    const h = new HistoryStack();
    const atPress = content([n('a', 0)]);
    const afterDrag = content([n('a', 300)]);
    h.reset(atPress);
    h.commitFrom(atPress, afterDrag, '移动节点');
    expect(h.canUndo()).toBe(true);
    expect(h.stepUndo(afterDrag)?.content).toEqual(atPress);
  });
});

/* ══════════ 分组(groups)纳入历史 ══════════ */

describe('groups — 分组编辑可撤销', () => {
  /** 带分组的画布内容 */
  const gc = (nodes: unknown[], groups: unknown[], edges: unknown[] = []) => ({
    nodes,
    edges,
    groups,
  });

  it('structureSig 区分有无分组(只改组也算一次真实编辑)', () => {
    const withG = gc([n('a')], [{ id: 'g1', name: '组 1', members: ['a'] }]);
    const without = gc([n('a')], []);
    expect(structureSig(withG.nodes, withG.edges, withG.groups)).not.toBe(
      structureSig(without.nodes, without.edges, without.groups),
    );
  });

  it('structureSig 区分组成员变化', () => {
    const a = gc([n('a'), n('b')], [{ id: 'g1', name: '组 1', members: ['a'] }]);
    const b = gc([n('a'), n('b')], [{ id: 'g1', name: '组 1', members: ['a', 'b'] }]);
    expect(structureSig(a.nodes, a.edges, a.groups)).not.toBe(
      structureSig(b.nodes, b.edges, b.groups),
    );
  });

  it('structureSig 区分组名', () => {
    const a = gc([n('a')], [{ id: 'g1', name: '组 1', members: ['a'] }]);
    const b = gc([n('a')], [{ id: 'g1', name: '镜头组', members: ['a'] }]);
    expect(structureSig(a.nodes, a.edges, a.groups)).not.toBe(
      structureSig(b.nodes, b.edges, b.groups),
    );
  });

  it('建组可撤销:撤销回到无分组状态', () => {
    const h = new HistoryStack();
    const before = gc([n('a'), n('b')], []);
    const after = gc([n('a'), n('b')], [{ id: 'g1', name: '组 1', members: ['a', 'b'] }]);
    h.reset(before);
    h.commit(after, '建组');
    expect(h.canUndo()).toBe(true);
    expect(h.stepUndo(after)?.content).toEqual(before);
  });

  it('解组可撤销:撤销回到有分组状态', () => {
    const h = new HistoryStack();
    const grouped = gc([n('a'), n('b')], [{ id: 'g1', name: '组 1', members: ['a', 'b'] }]);
    const dissolved = gc([n('a'), n('b')], []);
    h.reset(grouped);
    h.commit(dissolved, '解组');
    expect(h.stepUndo(dissolved)?.content).toEqual(grouped);
  });

  it('不带 groups 的旧调用点仍然工作(向后兼容)', () => {
    const h = new HistoryStack();
    const v0 = content([n('a')]);
    const v1 = content([n('a'), n('b')]);
    h.reset(v0);
    h.commit(v1, '添加节点');
    expect(h.canUndo()).toBe(true);
    expect(h.stepUndo(v1)?.content).toEqual(v0);
  });

  it('回放期间的分组提交被闸门忽略', () => {
    const h = new HistoryStack();
    const v0 = gc([n('a')], []);
    h.reset(v0);
    h.beginReplay();
    h.commit(gc([n('a')], [{ id: 'g1', name: '组 1', members: ['a'] }]), '回放中建组');
    expect(h.canUndo()).toBe(false);
  });
});
