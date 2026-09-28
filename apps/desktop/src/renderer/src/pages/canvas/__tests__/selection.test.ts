/**
 * selection.test — 框选几何 + 分组纯函数单测
 *
 * 重点覆盖真实易错点:
 *  - 反向拖拽(右下 → 左上)必须得到正矩形,否则框选区域整个反了;
 *  - 零面积(纯点击)不能因为 `rectsIntersect` 对零宽矩形恒 false 而永远选不中;
 *  - 未测量节点(`h` 缺失)要按兜底高度参与命中,否则刚建的节点框不中;
 *  - 组扩张 / 节点删除后的脏 id 清理(否则组框会画在错误位置)。
 */
import { describe, it, expect } from 'vitest';
import type { CanvasNode } from '../types';
import {
  UNMEASURED_NODE_H,
  rectFromPoints,
  screenToWorld,
  clientPointOf,
  type PointerLike,
  nodeRect,
  rectsIntersect,
  nodesInRect,
  boundingRect,
  nextGroupName,
  createGroup,
  dissolveGroups,
  toggleGroupMember,
  pruneGroups,
  groupOfNode,
  expandSelectionToGroups,
  selectionIsWholeGroup,
  normalizeGroups,
  type NodeGroup,
} from '../selection';

/** 造节点:只给几何,其余字段用不到 */
function mkNode(id: string, x: number, y: number, w = 200, h?: number): CanvasNode {
  return { id, title: id, x, y, w, h } as CanvasNode;
}

describe('rectFromPoints — 规整矩形', () => {
  it('正向拖拽(左上→右下)', () => {
    expect(rectFromPoints(10, 20, 110, 80)).toEqual({ x: 10, y: 20, w: 100, h: 60 });
  });

  it('反向拖拽(右下→左上)得到同一个正矩形', () => {
    expect(rectFromPoints(110, 80, 10, 20)).toEqual({ x: 10, y: 20, w: 100, h: 60 });
  });

  it('零面积(原地点击)', () => {
    expect(rectFromPoints(5, 5, 5, 5)).toEqual({ x: 5, y: 5, w: 0, h: 0 });
  });
});

describe('screenToWorld — 屏幕→世界坐标', () => {
  it('按缩放与平移换算', () => {
    // 屏幕 (300,200),视图平移 (100,100)、缩放 2 → world ((300-100)/2, (200-100)/2)
    expect(screenToWorld(300, 200, { x: 100, y: 100, z: 2 })).toEqual({ x: 100, y: 50 });
  });

  it('缩放 1 平移 0 时等于自身', () => {
    expect(screenToWorld(42, 7, { x: 0, y: 0, z: 1 })).toEqual({ x: 42, y: 7 });
  });
});

describe('clientPointOf — 指针坐标当场取出(合成事件回收防护)', () => {
  it('正常事件取出 clientX/clientY', () => {
    expect(clientPointOf({ clientX: 120, clientY: 45 })).toEqual({ x: 120, y: 45 });
  });

  it('React 合成事件被回收后 clientX 为 undefined → 回退 0(绝不产出 NaN)', () => {
    // 真实事故:beginMarquee 存了 e、在 pointermove 里才读 e.clientX,
    // 得到 undefined → NaN 矩形 → 框选永远框不中任何节点。
    const recycled = { clientX: undefined, clientY: undefined } as unknown as PointerLike;
    const p = clientPointOf(recycled);
    expect(p).toEqual({ x: 0, y: 0 });
    expect(Number.isNaN(p.x)).toBe(false);
  });

  it('NaN / Infinity / null 一律回退 0,保证几何函数拿到有限数', () => {
    expect(clientPointOf({ clientX: NaN, clientY: Infinity })).toEqual({ x: 0, y: 0 });
    expect(clientPointOf(null)).toEqual({ x: 0, y: 0 });
    expect(clientPointOf(undefined)).toEqual({ x: 0, y: 0 });
  });

  it('取出的坐标喂给 rectFromPoints 得到有限矩形(框选可命中)', () => {
    const a = clientPointOf({ clientX: 10, clientY: 10 });
    const b = clientPointOf({ clientX: 60, clientY: 90 });
    const r = rectFromPoints(a.x, a.y, b.x, b.y);
    expect(r).toEqual({ x: 10, y: 10, w: 50, h: 80 });
    expect(nodesInRect([mkNode('n', 20, 20, 30, 30)], r)).toEqual(['n']);
  });
});

describe('nodeRect — 未测量高度兜底', () => {
  it('有 h 用真实高度', () => {
    expect(nodeRect(mkNode('a', 0, 0, 100, 50))).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  });

  it('无 h 用 UNMEASURED_NODE_H', () => {
    expect(nodeRect(mkNode('a', 0, 0, 100))).toEqual({
      x: 0,
      y: 0,
      w: 100,
      h: UNMEASURED_NODE_H,
    });
  });
});

describe('rectsIntersect — 相交判定', () => {
  const base = { x: 0, y: 0, w: 100, h: 100 };

  it('完全包含算相交', () => {
    expect(rectsIntersect(base, { x: 10, y: 10, w: 20, h: 20 })).toBe(true);
  });

  it('部分重叠算相交', () => {
    expect(rectsIntersect(base, { x: 90, y: 90, w: 50, h: 50 })).toBe(true);
  });

  // 相切 = 没有可见重叠面积(矩形边界正好压在节点边上),视觉上不像选中 → 不算相交。
  // 「含边界」的语义留给点命中(rectContainsPoint),那才是用户真正点上去的场景。
  it('边缘相切不算相交(无可见重叠面积)', () => {
    expect(rectsIntersect(base, { x: 100, y: 0, w: 10, h: 10 })).toBe(false);
  });

  it('重叠 1px 即算相交', () => {
    expect(rectsIntersect(base, { x: 99, y: 0, w: 10, h: 10 })).toBe(true);
  });

  it('完全分离不算', () => {
    expect(rectsIntersect(base, { x: 101, y: 0, w: 10, h: 10 })).toBe(false);
  });
});

describe('nodesInRect — 框选命中', () => {
  const nodes = [
    mkNode('a', 0, 0, 100, 100), // 左上
    mkNode('b', 300, 0, 100, 100), // 右上(与 a 不相交)
    mkNode('c', 0, 300, 100, 100), // 左下
    mkNode('d', 300, 300, 100, 100), // 右下
  ];

  it('相交即选中(默认):大框擦过边角也选中', () => {
    // 框住 a 的右下角一小块
    const ids = nodesInRect(nodes, { x: 90, y: 90, w: 20, h: 20 });
    expect(ids).toEqual(['a']);
  });

  it('覆盖全部时四个都中', () => {
    const ids = nodesInRect(nodes, { x: -10, y: -10, w: 500, h: 500 });
    expect(ids.sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('strict 模式:部分重叠不选,完全包含才选', () => {
    // 框住 a 的右下角:非完全包含 → strict 下不中
    expect(nodesInRect(nodes, { x: 90, y: 90, w: 20, h: 20 }, { strict: true })).toEqual([]);
    // 完整包住 a → 中
    expect(
      nodesInRect(nodes, { x: -5, y: -5, w: 120, h: 120 }, { strict: true }),
    ).toEqual(['a']);
  });

  it('零面积矩形按点命中处理(不因零宽恒 false)', () => {
    expect(nodesInRect(nodes, { x: 50, y: 50, w: 0, h: 0 })).toEqual(['a']);
  });

  it('零面积落在空白处不中', () => {
    expect(nodesInRect(nodes, { x: 200, y: 200, w: 0, h: 0 })).toEqual([]);
  });

  it('未测量节点也能被框中(高度兜底)', () => {
    const fresh = [mkNode('n', 100, 100, 200)]; // 无 h
    // 框住节点垂直方向中部(真实高度未知,兜底 120 内)
    expect(nodesInRect(fresh, { x: 120, y: 130, w: 40, h: 20 })).toEqual(['n']);
  });
});

describe('boundingRect — 组包围盒', () => {
  it('多节点取并集', () => {
    const nodes = [mkNode('a', 0, 0, 100, 50), mkNode('b', 200, 100, 100, 50)];
    expect(boundingRect(nodes, ['a', 'b'])).toEqual({ x: 0, y: 0, w: 300, h: 150 });
  });

  it('空集返回 null', () => {
    expect(boundingRect([mkNode('a', 0, 0)], [])).toBeNull();
  });

  it('忽略不存在的 id', () => {
    expect(boundingRect([mkNode('a', 10, 10, 100, 100)], ['a', 'ghost'])).toEqual({
      x: 10,
      y: 10,
      w: 100,
      h: 100,
    });
  });
});

describe('分组:命名与建组', () => {
  const g = (id: string, name: string, members: string[]): NodeGroup => ({
    id,
    name,
    members,
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  it('nextGroupName 递增且避开重名', () => {
    expect(nextGroupName([])).toBe('组 1');
    expect(nextGroupName([g('g1', '组 1', ['a'])])).toBe('组 2');
    expect(nextGroupName([g('g1', '组 1', ['a']), g('g2', '组 3', ['b'])])).toBe('组 4');
    // 自定义名不参与编号
    expect(nextGroupName([g('g1', '开头镜头', ['a'])])).toBe('组 1');
  });

  it('createGroup 建新组并带默认名', () => {
    const { groups, group } = createGroup([], ['a', 'b'], { id: 'g1' });
    expect(groups).toHaveLength(1);
    expect(group.name).toBe('组 1');
    expect(group.members).toEqual(['a', 'b']);
    expect(group.tone).toBe('neutral');
  });

  it('一个节点只属于一个组:建组时从旧组摘除', () => {
    const old = [g('g1', '组 1', ['a', 'b'])];
    const { groups } = createGroup(old, ['b', 'c'], { id: 'g2' });
    // g1 摘掉 b、只剩 a;g2 拿到 b、c
    expect(groupOfNode(groups, 'a')?.id).toBe('g1');
    expect(groupOfNode(groups, 'b')?.id).toBe('g2');
    expect(groupOfNode(groups, 'c')?.id).toBe('g2');
  });

  it('摘除后变空的旧组被清理', () => {
    const old = [g('g1', '组 1', ['a'])];
    const { groups } = createGroup(old, ['a'], { id: 'g2' });
    expect(groups.map((x) => x.id)).toEqual(['g2']);
  });
});

describe('分组:解组 / 成员微调 / 清理', () => {
  const g = (id: string, name: string, members: string[]): NodeGroup => ({
    id,
    name,
    members,
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  it('dissolveGroups 只移除指定组', () => {
    const groups = [g('g1', '组 1', ['a']), g('g2', '组 2', ['b'])];
    expect(dissolveGroups(groups, ['g1']).map((x) => x.id)).toEqual(['g2']);
  });

  it('toggleGroupMember 幂等增删', () => {
    const groups = [g('g1', '组 1', ['a'])];
    expect(toggleGroupMember(groups, 'g1', 'b', true)[0]!.members).toEqual(['a', 'b']);
    // 重复加入不产生重复项
    expect(toggleGroupMember(groups, 'g1', 'a', true)[0]!.members).toEqual(['a']);
    expect(toggleGroupMember(groups, 'g1', 'a', false)[0]!.members).toEqual([]);
    // 移除不存在的成员无副作用
    expect(toggleGroupMember(groups, 'g1', 'zzz', false)[0]!.members).toEqual(['a']);
  });

  it('pruneGroups 剔除脏 id 并丢弃空组', () => {
    const groups = [g('g1', '组 1', ['a', 'dead']), g('g2', '组 2', ['gone'])];
    const out = pruneGroups(groups, ['a', 'alive']);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('g1');
    expect(out[0]!.members).toEqual(['a']);
  });

  it('pruneGroups 不带 live 列表时只丢空组', () => {
    const groups = [g('g1', '组 1', []), g('g2', '组 2', ['a'])];
    expect(pruneGroups(groups).map((x) => x.id)).toEqual(['g2']);
  });
});

describe('分组:选区扩张(组概念核心手感)', () => {
  const groups: NodeGroup[] = [
    { id: 'g1', name: '组 1', members: ['a', 'b'], createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'g2', name: '组 2', members: ['c'], createdAt: '2026-01-01T00:00:00.000Z' },
  ];

  it('选中组内任一节点 → 整组成员一起选中', () => {
    expect(expandSelectionToGroups(groups, ['a']).sort()).toEqual(['a', 'b']);
  });

  it('未分组节点原样保留', () => {
    expect(expandSelectionToGroups(groups, ['z'])).toEqual(['z']);
  });

  it('混合选区:组内节点扩张,未分组不受影响', () => {
    expect(expandSelectionToGroups(groups, ['b', 'z']).sort()).toEqual(['b', 'z', 'a'].sort());
  });

  it('selectionIsWholeGroup:整组选中才返回该组', () => {
    expect(selectionIsWholeGroup(groups, ['a', 'b'])?.id).toBe('g1');
    expect(selectionIsWholeGroup(groups, ['a'])).toBeNull();
    expect(selectionIsWholeGroup(groups, [])).toBeNull();
    // 多了一个组外节点 → 不是整组
    expect(selectionIsWholeGroup(groups, ['a', 'b', 'z'])).toBeNull();
  });
});

describe('normalizeGroups — 旧项目文件兼容', () => {
  it('无 groups 字段(旧快照)→ 空数组', () => {
    expect(normalizeGroups(undefined, ['a'])).toEqual([]);
    expect(normalizeGroups(null, ['a'])).toEqual([]);
    expect(normalizeGroups('bad', ['a'])).toEqual([]);
  });

  it('剔除已不存在的成员,全空组丢弃', () => {
    const raw = [
      { id: 'g1', name: '组 1', members: ['a', 'dead'] },
      { id: 'g2', name: '组 2', members: ['gone'] },
    ];
    const out = normalizeGroups(raw, ['a', 'b']);
    expect(out).toHaveLength(1);
    expect(out[0]!.members).toEqual(['a']);
  });

  it('一个节点只保留在首个声明的组里', () => {
    const raw = [
      { id: 'g1', name: '组 1', members: ['a'] },
      { id: 'g2', name: '组 2', members: ['a', 'b'] },
    ];
    const out = normalizeGroups(raw, ['a', 'b']);
    expect(out).toHaveLength(2);
    expect(out[0]!.members).toEqual(['a']);
    expect(out[1]!.members).toEqual(['b']);
  });

  it('丢弃缺 id/name 的脏条目与重复组 id', () => {
    const raw = [
      { id: '', name: 'x', members: ['a'] },
      { id: 'g1', name: '', members: ['a'] },
      { id: 'g2', name: '组', members: ['a'] },
      { id: 'g2', name: '重复', members: ['b'] },
    ];
    const out = normalizeGroups(raw, ['a', 'b']);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('g2');
  });

  it('tone 非法值回退 neutral', () => {
    const raw = [{ id: 'g1', name: '组', members: ['a'], tone: 'rainbow' }];
    expect(normalizeGroups(raw, ['a'])[0]!.tone).toBe('neutral');
  });

  it('合法 tone 保留', () => {
    const raw = [{ id: 'g1', name: '组', members: ['a'], tone: 'accent' }];
    expect(normalizeGroups(raw, ['a'])[0]!.tone).toBe('accent');
  });
});
