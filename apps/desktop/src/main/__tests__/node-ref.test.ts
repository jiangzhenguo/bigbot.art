/**
 * 节点引用解析单测 — resolveNodeRef / resolveNodeRefOrError
 *
 * 背景(真实事故 2026-09-28 主画布对话失败):
 *   `canvas.list_nodes` 与 `get_node` 的输出按产品规则「标题为主、id 在行尾」排版,
 *   模型于是把**标题**当 nodeId 回传:
 *     [dbg:info] agent.tool → canvas.get_node({"nodeId":"镜头 03"})
 *     [dbg:error] agent.tool ✕ canvas.get_node → 节点 镜头 03 不存在
 *   原实现只做 `n.id === nodeId` 严格匹配,必报「不存在」,白烧一整轮往返
 *   (本机 35B 单轮实测 78 秒),直接推高看门狗超时风险。
 *
 * 容错策略(保守):id 精确优先 → 标题(去空白)唯一才用 → 多个则报歧义不猜 → 都没有则不存在。
 */
import { describe, it, expect } from 'vitest';
import type { CanvasNode } from '@bigbotart/shared';
import { resolveNodeRef, resolveNodeRefOrError } from '../tool-handlers';

const node = (id: string, label = id, kind = 'shot'): CanvasNode =>
  ({ id, kind, label, position: { x: 0, y: 0 }, data: {} }) as unknown as CanvasNode;

describe('resolveNodeRef — id 优先', () => {
  it('id 精确命中', () => {
    const nodes = [node('shot-1790001542801-gyec', '镜头 03')];
    expect(resolveNodeRef(nodes, 'shot-1790001542801-gyec').node?.id).toBe('shot-1790001542801-gyec');
  });

  it('id 命中时不被同名标题干扰(id 优先级更高)', () => {
    // 极端情况:某节点 id 恰好等于另一节点的标题 —— id 必须先赢,保证语义稳定
    const nodes = [node('镜头 03', '别的节点'), node('real-1', '镜头 03')];
    expect(resolveNodeRef(nodes, '镜头 03').node?.id).toBe('镜头 03');
  });
});

describe('resolveNodeRef — 标题兜底', () => {
  it('唯一标题(事故现场用例)→ 正确解析出节点', () => {
    const nodes = [node('new9-nhz9', '镜头（视频）'), node('shot-1790001542801-gyec', '镜头 03')];
    expect(resolveNodeRef(nodes, '镜头 03').node?.id).toBe('shot-1790001542801-gyec');
  });

  it('标题里的空格差异被容忍(模型排版不稳定)', () => {
    const nodes = [node('s1', '镜头 03')];
    expect(resolveNodeRef(nodes, '镜头03').node?.id).toBe('s1');
    expect(resolveNodeRef(nodes, ' 镜头 03 ').node?.id).toBe('s1');
  });

  it('标题重复 → 不猜,返回全部候选', () => {
    const nodes = [node('a', '镜头'), node('b', '镜头')];
    const r = resolveNodeRef(nodes, '镜头');
    expect(r.node).toBeUndefined();
    expect(r.ambiguous.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('都不命中 → undefined 且无歧义', () => {
    const r = resolveNodeRef([node('a', '镜头 01')], '不存在的节点');
    expect(r.node).toBeUndefined();
    expect(r.ambiguous).toEqual([]);
  });

  it('空引用 → 不误match(空标题节点也不该被空串命中)', () => {
    const nodes = [node('a', '')];
    expect(resolveNodeRef(nodes, '').node).toBeUndefined();
    expect(resolveNodeRef(nodes, '   ').node).toBeUndefined();
  });
});

describe('resolveNodeRefOrError — 工具入口友好报错', () => {
  it('命中 → ok:true + 节点', () => {
    const r = resolveNodeRefOrError([node('s1', '镜头 03')], '镜头 03');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.id).toBe('s1');
  });

  it('歧义 → 报「匹配到多个」并列出候选 id(提示改用 id)', () => {
    const r = resolveNodeRefOrError([node('a', '镜头'), node('b', '镜头')], '镜头', '目标节点');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('匹配到多个');
      expect(r.error).toContain('id=a');
      expect(r.error).toContain('id=b');
    }
  });

  it('不存在 → 报「不存在」并带角色名(源/目标节点区分)', () => {
    const r = resolveNodeRefOrError([node('a', '镜头 01')], 'ghost', '源节点');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('源节点 ghost 不存在');
  });
});
