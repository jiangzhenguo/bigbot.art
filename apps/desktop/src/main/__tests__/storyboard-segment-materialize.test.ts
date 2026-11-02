/**
 * storyboard.materialize — 段(一次生成里的多个切)
 *
 * 三件事必须同时成立,缺一个就是「报告成功但铺错」:
 *  1. 同段三行只铺 **一个** shot(不是三个),秒数 = 各切之和;
 *  2. 提示词按累计时刻切镜(`[Shot 2] At 00:04.000,`),且节点带 data.segment.cuts 供审阅;
 *  3. 节点记住**全部行号**,否则再点一次「铺节点」会把同段的其余切当成新行重复铺。
 */
import { describe, expect, it } from 'vitest';
import type { CanvasEdge, CanvasNode } from '@bigbotart/shared';
import { STORYBOARD_HEAD, tableToGfm } from '@bigbotart/shared';
import { ToolHandlers } from '../tool-handlers';

const PROJECT = 'proj-seg';
const CANVAS = 'cv-seg';
const CTX = { projectId: PROJECT, canvasId: CANVAS };
const HEAD = [...STORYBOARD_HEAD] as string[];

function row(n: number, cells: Record<string, string> = {}): string[] {
  const base: Record<string, string> = {
    镜号: String(n),
    画面描述: `可见动作 ${n}`,
    '时长(s)': '3',
    需配图: '否',
    衔接: '硬切',
    角色: '',
    景别: n % 2 === 0 ? '近景' : '中景',
    ...cells,
  };
  return HEAD.map((name) => base[name] ?? '');
}

function storyboardNode(id: string, rows: string[][]): CanvasNode {
  const gfm = tableToGfm(HEAD, rows);
  return {
    id,
    kind: 'storyboard',
    label: '分镜表',
    position: { x: 0, y: 0 },
    data: { markdown: gfm, lastTable: gfm },
  } as CanvasNode;
}

function harness(nodes: CanvasNode[]) {
  let persisted = {
    projectId: PROJECT,
    canvases: [
      {
        id: CANVAS,
        projectId: PROJECT,
        name: '主画布',
        nodes,
        edges: [] as CanvasEdge[],
        groups: [],
        version: 1,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
    ],
  };
  const store = {
    loadProjectCanvases: () => structuredClone(persisted),
    saveCanvasSnapshot: (snap: (typeof persisted)['canvases'][number]) => {
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
    { getActiveSkillId: () => undefined } as never,
  );
  return { h, persisted: () => persisted };
}

describe('storyboard.materialize — 段内多切一次生成', () => {
  it('同段三行铺出一个 shot:秒数求和、切点带累计时刻、节点记住全部行', async () => {
    const rows = [
      row(1, { 段: '1', '时长(s)': '4', 画面描述: '她推开门' }),
      row(2, { 段: '1', '时长(s)': '3', 画面描述: '桌上一封信' }),
      row(3, { 段: '1', '时长(s)': '2', 画面描述: '她抬起头' }),
    ];
    const sb = storyboardNode('sb-seg', rows);
    const { h, persisted } = harness([sb]);
    const res = await h.call('storyboard.materialize', { nodeId: 'sb-seg' }, CTX);
    expect(res.ok).toBe(true);

    const nodes = persisted().canvases[0]!.nodes;
    const shots = nodes.filter((n) => n.kind === 'shot');
    expect(shots).toHaveLength(1);
    const shot = shots[0]!;
    const data = shot.data as Record<string, unknown>;
    expect(shot.label).toBe('镜头 01–03');
    expect(data.seconds).toBe(9);
    expect(data.storyboardRows).toEqual([1, 2, 3]);
    expect(data.storyboardRow).toBe(1);
    const segment = data.segment as { rows: number[]; seconds: number; cuts: Array<{ rowNo: number; seconds: number }> };
    expect(segment.rows).toEqual([1, 2, 3]);
    expect(segment.seconds).toBe(9);
    expect(segment.cuts.map((c) => c.rowNo)).toEqual([1, 2, 3]);
    expect(segment.cuts.map((c) => c.seconds)).toEqual([4, 3, 2]);

    const prompt = String(data.prompt);
    expect(prompt).toContain('[Shot 1] Scene: 她推开门');
    expect(prompt).toContain('[Shot 2] At 00:04.000, Scene: 桌上一封信');
    expect(prompt).toContain('[Shot 3] At 00:07.000, Scene: 她抬起头');

    /* 分镜表 → 本段镜头只有一条 prompt 边(另一条 sb→静帧 属于首帧,不影响本段语义) */
    const edges = persisted().canvases[0]!.edges;
    expect(
      edges.filter((e) => e.source === 'sb-seg' && e.target === shot.id && e.label === 'prompt'),
    ).toHaveLength(1);
  });

  it('再铺一次:三行都记在已铺里,不重复铺出第二个 shot', async () => {
    const rows = [
      row(1, { 段: '1' }),
      row(2, { 段: '1' }),
      row(3, { 段: '1' }),
    ];
    const sb = storyboardNode('sb-seg2', rows);
    const { h, persisted } = harness([sb]);
    await h.call('storyboard.materialize', { nodeId: 'sb-seg2' }, CTX);
    const again = await h.call('storyboard.materialize', { nodeId: 'sb-seg2' }, CTX);
    expect(again.ok).toBe(true);
    expect(again.result).toContain('均已铺出');
    expect(persisted().canvases[0]!.nodes.filter((n) => n.kind === 'shot')).toHaveLength(1);
  });

  it('半铺出的段拒绝补铺:指出段号与已铺行,不产生新节点', async () => {
    const rows = [row(1, { 段: '1' }), row(2, { 段: '1' }), row(3, { 段: '1' })];
    const sb = storyboardNode('sb-partial', rows);
    /* 模拟上一次只铺了第 2 行(旧版本/手删部分节点留下的裂口) */
    const orphan = {
      id: 'shot-orphan',
      kind: 'shot',
      label: '镜头 02',
      position: { x: 900, y: 0 },
      data: { engine: 'h3c', mode: 'text2video', prompt: 'x', seconds: 3, storyboardId: 'sb-partial', storyboardRow: 2 },
    } as CanvasNode;
    const { h, persisted } = harness([sb, orphan]);
    const res = await h.call('storyboard.materialize', { nodeId: 'sb-partial' }, CTX);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('段「1」');
    expect(res.result).toContain('原子单位');
    expect(persisted().canvases[0]!.nodes).toHaveLength(2);
  });

  it('段合计超 15 秒 → 结构门拒绝,画布只有分镜表', async () => {
    const rows = [
      row(1, { 段: '1', '时长(s)': '8' }),
      row(2, { 段: '1', '时长(s)': '9' }),
    ];
    const sb = storyboardNode('sb-too-long', rows);
    const { h, persisted } = harness([sb]);
    const res = await h.call('storyboard.materialize', { nodeId: 'sb-too-long' }, CTX);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('超过单次生成上限');
    expect(persisted().canvases[0]!.nodes).toHaveLength(1);
  });

  it('没写段的表行为不变:一行一个 shot', async () => {
    const rows = [row(1), row(2)];
    const sb = storyboardNode('sb-legacy', rows);
    const { h, persisted } = harness([sb]);
    const res = await h.call('storyboard.materialize', { nodeId: 'sb-legacy' }, CTX);
    expect(res.ok).toBe(true);
    const shots = persisted().canvases[0]!.nodes.filter((n) => n.kind === 'shot');
    expect(shots).toHaveLength(2);
    for (const shot of shots) {
      const data = shot.data as Record<string, unknown>;
      expect(data.segment).toBeUndefined();
      expect(data.storyboardRows).toBeUndefined();
    }
  });
});
