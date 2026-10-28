import { describe, expect, it } from 'vitest';
import type { CanvasNode, CanvasEdge } from '@bigbotart/shared';
import { STORYBOARD_HEAD, tableToGfm } from '@bigbotart/shared';
import { ToolHandlers } from '../tool-handlers';

const PROJECT = 'proj-test';
const CANVAS = 'cv-test';
const CTX = { projectId: PROJECT, canvasId: CANVAS };
const HEAD = [...STORYBOARD_HEAD] as string[];

function row(n: number, desc: string, role = ''): string[] {
  return HEAD.map((name) => {
    const cells: Record<string, string> = {
      镜号: String(n), 画面描述: desc, 景别: '中景', 运镜: '固定', '时长(s)': '5', 需配图: '是', 衔接: n === 1 ? '硬切' : '接尾帧', 角色: role,
    };
    return cells[name] ?? '';
  });
}

function storyboard(id: string, rows: string[][]): CanvasNode {
  const gfm = tableToGfm(HEAD, rows);
  return { id, kind: 'storyboard', label: '分镜表', position: { x: 0, y: 0 }, data: { markdown: gfm, lastTable: gfm } } as CanvasNode;
}

function harness(opts: {
  nodes: CanvasNode[];
  plan?: () => Promise<{ storyboard: CanvasNode; images: CanvasNode[]; shots: CanvasNode[]; edges: []; report: string }>;
  saveOk?: (count: number) => boolean;
  activeSkillId?: string;
}) {
  let persisted = {
    projectId: PROJECT,
    canvases: [{ id: CANVAS, projectId: PROJECT, name: '主画布', nodes: opts.nodes, edges: [] as CanvasEdge[], groups: [], version: 1, updatedAt: new Date().toISOString(), createdAt: new Date().toISOString() }],
  };
  let saves = 0;
  let loads = 0;
  const store = {
    loadProjectCanvases: () => {
      loads += 1;
      return structuredClone(persisted);
    },
    saveCanvasSnapshot: (snap: typeof persisted.canvases[number]) => {
      saves += 1;
      if (opts.saveOk && !opts.saveOk(saves)) return { ok: false, stale: true };
      persisted = { projectId: PROJECT, canvases: [structuredClone(snap)] };
      return { ok: true };
    },
  };
  const h = new ToolHandlers(
    store as never,
    { get: () => undefined } as never,
    {} as never,
    {} as never,
    {} as never,
    { getActiveSkillId: () => opts.activeSkillId } as never,
    { planStoryboard: opts.plan },
  );
  return { h, loads: () => loads, saves: () => saves, persisted: () => persisted };
}

describe('storyboard.plan — 长 LLM 后保存不能产出幽灵节点', () => {
  it('第一次保存被版本防护拒绝 → 重载最新快照重试;规划只调用一次', async () => {
    const sb = storyboard('sb-new', [row(1, '两名亚洲女模对峙')]);
    let plans = 0;
    const { h, loads, saves, persisted } = harness({
      nodes: [],
      saveOk: (count) => count > 1,
      plan: async () => {
        plans += 1;
        return { storyboard: sb, images: [], shots: [], edges: [], report: '已生成分镜表:1 行' };
      },
    });
    const res = await h.call('storyboard.plan', { brief: '两名亚洲女模在T台冲突' }, CTX);
    expect(res.ok).toBe(true);
    expect(res.nodeId).toBe('sb-new');
    expect(plans).toBe(1);
    expect(saves()).toBe(2);
    expect(loads()).toBeGreaterThanOrEqual(2);
    expect(persisted().canvases[0]!.nodes.map((n) => n.id)).toContain('sb-new');
  });

  it('持续保存失败 → 明确返回失败,不能报告不存在的节点 id', async () => {
    const sb = storyboard('sb-ghost', [row(1, '空镜')]);
    const { h, persisted } = harness({
      nodes: [],
      saveOk: () => false,
      plan: async () => ({ storyboard: sb, images: [], shots: [], edges: [], report: '已生成分镜表:1 行' }),
    });
    const res = await h.call('storyboard.plan', { brief: '空镜' }, CTX);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('保存');
    expect(res.nodeId).toBeUndefined();
    expect(persisted().canvases[0]!.nodes).toHaveLength(0);
  });
});

describe('storyboard.materialize — 重复角色身份锁硬闸', () => {
  it('无技能 + 多镜重复女模 + 无角色卡 → 拒绝铺节点并指引先建卡', async () => {
    const sb = storyboard('sb', [
      row(1, 'T台尽头,两名亚洲女模在聚光灯下对峙'),
      row(2, '两人互相推搡格挡'),
      row(3, '一名女模被推搡踉跄失衡'),
    ]);
    const { h, persisted } = harness({ nodes: [sb] });
    const res = await h.call('storyboard.materialize', { nodeId: 'sb' }, CTX);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('角色卡');
    expect(res.result).toContain('模特');
    expect(persisted().canvases[0]!.nodes).toHaveLength(1);
  });

  it('显式重复角色名缺卡 → 即使静帧类技能激活也不放行', async () => {
    const sb = storyboard('sb', [row(1, '女孩翻纸', '小纸'), row(2, '继续翻纸', '小纸')]);
    const { h } = harness({ nodes: [sb], activeSkillId: 'paper-collage-explainer' });
    const res = await h.call('storyboard.materialize', { nodeId: 'sb' }, CTX);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('小纸');
  });

  it('已有角色卡且重复点名 → 放行并连 ref-image', async () => {
    const card = { id: 'card-a', kind: 'image-gen', label: '角色卡·女模A', position: { x: 0, y: 0 }, data: { prompt: '全身正面' } } as CanvasNode;
    const sb = storyboard('sb', [row(1, '两人对峙', '女模A'), row(2, '切到近景', '女模A')]);
    const { h, persisted } = harness({ nodes: [sb, card] });
    const res = await h.call('storyboard.materialize', { nodeId: 'sb' }, CTX);
    expect(res.ok).toBe(true);
    const edges = persisted().canvases[0]!.edges;
    expect(edges.some((e) => e.source === 'card-a' && e.label === 'ref-image')).toBe(true);
  });
});
