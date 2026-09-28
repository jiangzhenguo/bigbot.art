/**
 * NodeCard memo 有效性测试(P1)
 *
 * memo 的成败完全取决于「props 引用是否稳定」。这里不 mount 整棵画布
 * (需要 window.bigbotart 等一堆环境),而是验证两件事:
 *   1. NodeCard 确实是 memo 组件;
 *   2. 其 props 的浅比较语义符合预期 —— 这正是 memo 默认比较器的判定依据。
 *
 * ⚠️ 注意:React.memo(fn) 用默认比较器时,返回对象上**没有** .compare 字段
 * (只有传了自定义比较器才有)。所以这里自己实现浅比较,而不是去读 .compare。
 *
 * 另有一条源码扫描护栏:若有人把 CanvasPage 的节点回调改回内联箭头,
 * memo 会静默失效(功能正常、优化归零)—— 这类回归靠静态断言兜住。
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { NodeCard } from '../NodeCard.js';
import type { CanvasNode } from '../types.js';

const node = (over: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id: 'n1', title: '镜头 01', w: 236, h: 120, x: 0, y: 0, kind: 'document', data: {}, ...over }) as CanvasNode;

const noop = () => undefined;

/** 构造一组完整 props(memo 浅比较的输入面) */
function props(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    node: node(),
    selected: false,
    flash: false,
    dragging: false,
    group: null,
    isConnectTarget: false,
    connectHitOk: false,
    nodes: [],
    takeResults: {},
    assetMeta: {},
    onSelect: noop,
    onContextMenu: noop,
    onHeaderPointerDown: noop,
    onAddPointerDown: noop,
    onAddClick: noop,
    registerRef: noop,
    ...over,
  };
}

/** React.memo 默认比较器用的浅比较(Object.is 逐键) */
function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
}

describe('NodeCard 是 memo 组件', () => {
  it('导出的 $$typeof 是 react.memo', () => {
    const t = (NodeCard as unknown as { $$typeof?: symbol }).$$typeof?.toString() ?? '';
    expect(t).toContain('react.memo');
  });
});

describe('浅比较语义 — 对应视口平移「不重渲染」的场景', () => {
  it('同一组 props 引用 → 相等(不重渲染)', () => {
    const p = props();
    expect(shallowEqual(p, p)).toBe(true);
  });

  it('节点引用相同 + 回调/数组引用复用 → 相等 ← 视口平移必须命中这条', () => {
    const n = node();
    const stable = { nodes: [], takeResults: {}, assetMeta: {}, onSelect: noop, registerRef: noop };
    expect(shallowEqual(props({ node: n, ...stable }), props({ node: n, ...stable }))).toBe(true);
  });
});

describe('浅比较语义 — 必须重渲染的变更(不能被 memo 挡掉)', () => {
  const stable = { nodes: [], takeResults: {}, assetMeta: {}, onSelect: noop, registerRef: noop };

  it('节点对象换新引用(位置/内容变化)', () => {
    expect(shallowEqual(props({ node: node(), ...stable }), props({ node: node({ x: 10 }), ...stable }))).toBe(false);
  });

  it('回调换新函数 ← 内联箭头导致 memo 失效的机制', () => {
    const n = node();
    const a = props({ node: n, ...stable, onSelect: () => undefined });
    const b = props({ node: n, ...stable, onSelect: () => undefined });
    expect(shallowEqual(a, b)).toBe(false);
  });

  it('nodes 数组换新引用 ← StageView 用 refNodes 派生数组规避', () => {
    const n = node();
    expect(shallowEqual(props({ node: n, nodes: [node()] }), props({ node: n, nodes: [node()] }))).toBe(false);
  });

  it('选中态变化(必须重渲染以更新高亮)', () => {
    const n = node();
    expect(shallowEqual(props({ node: n, ...stable, selected: false }), props({ node: n, ...stable, selected: true }))).toBe(false);
  });

  it('拖动态变化(必须重渲染以挂 dragging 类)', () => {
    const n = node();
    expect(shallowEqual(props({ node: n, ...stable, dragging: false }), props({ node: n, ...stable, dragging: true }))).toBe(false);
  });

  it('连接目标命中变化(必须重渲染以画绿/红高亮)', () => {
    const n = node();
    expect(
      shallowEqual(
        props({ node: n, ...stable, isConnectTarget: true, connectHitOk: false }),
        props({ node: n, ...stable, isConnectTarget: true, connectHitOk: true }),
      ),
    ).toBe(false);
  });

  it('分组变化(必须重渲染以更新组徽标/组色)', () => {
    const n = node();
    const g = { id: 'g1', name: '组', members: ['n1'], tone: 'accent' } as never;
    expect(shallowEqual(props({ node: n, ...stable, group: null }), props({ node: n, ...stable, group: g }))).toBe(false);
  });
});

describe('回归护栏 — CanvasPage 的节点回调不得写成内联箭头', () => {
  /* 内联箭头每次渲染都是新函数,memo 会静默失效(功能正常但性能优化归零)。
     这类回归没有运行时症状,只能靠静态断言兜住。 */
  it('6 个节点级 props 全部传稳定标识符', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'CanvasPage.tsx'), 'utf8');
    for (const name of [
      'onNodeSelect',
      'onNodeContextMenu',
      'onNodeHeaderPointerDown',
      'onNodeAddPointerDown',
      'onNodeAddClick',
      'registerNodeRef',
    ]) {
      expect(new RegExp(`${name}=\\{\\s*\\(`).test(src), `${name} 不应是内联箭头函数(会让 NodeCard 的 memo 失效)`).toBe(false);
      expect(new RegExp(`${name}=\\{[A-Za-z_]`).test(src), `${name} 应传入稳定标识符`).toBe(true);
    }
  });

  it('registerRef 在 CanvasPage 中是 useCallback 定义的稳定引用', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'CanvasPage.tsx'), 'utf8');
    expect(src).toMatch(/const registerNodeRef = useCallback\(/);
  });

  it('StageView 传给 NodeCard 的不是全量 nodes,而是派生数组', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'StageView.tsx'), 'utf8');
    expect(src).toMatch(/nodes=\{refNodes\}/);
    expect(src).toMatch(/refNodesSignature/);
  });
});
