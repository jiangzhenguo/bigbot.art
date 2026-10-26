/**
 * Agent 工具落点接线:create_node / list_nodes / storyboard.materialize
 * 走 ToolHandlers,确认主进程不再用 80+n*60 或行号*186。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rectOf, rectsOverlap, PLACE_ORIGIN, type Occupant } from '../canvas-placement.js';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-place-'));
process.env.BIGBOTART_HOME = tmpHome;

const PROJECT = 'p-place';
const CANVAS = 'c-place';

type Node = {
  id: string;
  kind: string;
  label?: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  data?: Record<string, unknown>;
};

let ToolHandlers: typeof import('../tool-handlers.js').ToolHandlers;

function makeStore(nodes: Node[]) {
  const snapshot = {
    id: CANVAS,
    name: '主画布',
    version: 1,
    nodes,
    edges: [] as Array<{ id: string; source: string; target: string; label?: string }>,
    groups: [],
    updatedAt: new Date().toISOString(),
  };
  return {
    loadProjectCanvases: () => ({ projectId: PROJECT, canvases: [snapshot] }),
    saveCanvasSnapshot: () => ({ ok: true }),
    __snapshot: snapshot,
  };
}

function makeHandlers(store: ReturnType<typeof makeStore>) {
  return new ToolHandlers(store as never, { get: () => undefined } as never, {} as never, {} as never, {} as never, {} as never);
}

const ctx = { projectId: PROJECT, canvasId: CANVAS };

function asOcc(n: Node): Occupant {
  const d = (n.data ?? {}) as Record<string, unknown>;
  return {
    id: n.id,
    kind: n.kind,
    x: n.position?.x ?? 0,
    y: n.position?.y ?? 0,
    width: n.width,
    height: n.height,
    mediaWidth: typeof d.width === 'number' ? d.width : undefined,
    mediaHeight: typeof d.height === 'number' ? d.height : undefined,
    data: n.data,
  };
}

function assertSeparated(nodes: Node[]) {
  const rects = nodes.map((n) => rectOf(asOcc(n)));
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      expect(
        rectsOverlap(rects[i]!, rects[j]!, 24),
        `${nodes[i]!.id} @${rects[i]!.x},${rects[i]!.y} 与 ${nodes[j]!.id} @${rects[j]!.x},${rects[j]!.y} 重叠`,
      ).toBe(false);
    }
  }
}

function storyboard(id: string, x: number, y: number, rows: number, aspect = '16:9'): Node {
  const body = Array.from({ length: rows }, (_, i) => {
    const no = i + 1;
    return `| ${no} | 画面 ${no} | 无 | 中景 | 固定 | 5 | 是 |`;
  }).join('\n');
  return {
    id,
    kind: 'storyboard',
    label: id,
    position: { x, y },
    data: {
      markdown: [
        '| 镜号 | 画面描述 | 对白/旁白 | 景别 | 运镜 | 时长(s) | 需配图 |',
        '|---|---|---|---|---|---|---|',
        body,
      ].join('\n'),
      aspect,
      tier: 'default',
    },
  };
}

beforeAll(async () => {
  ToolHandlers = (await import('../tool-handlers.js')).ToolHandlers;
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('canvas.create_node 落点', () => {
  it('空画布第一张在 (80,80) 附近', async () => {
    const store = makeStore([]);
    const h = makeHandlers(store);
    const res = await h.call('canvas.create_node', { kind: 'document', label: '第一张' }, ctx);
    expect(res.ok, res.result).toBe(true);
    const n = store.__snapshot.nodes[0]!;
    expect(Math.abs(n.position.x - PLACE_ORIGIN.x)).toBeLessThanOrEqual(20);
    expect(Math.abs(n.position.y - PLACE_ORIGIN.y)).toBeLessThanOrEqual(20);
  });

  it('连续 20 次不传坐标,彼此不重叠', async () => {
    const store = makeStore([]);
    const h = makeHandlers(store);
    for (let i = 0; i < 20; i++) {
      const res = await h.call('canvas.create_node', { kind: 'document', label: `节点 ${i}` }, ctx);
      expect(res.ok, res.result).toBe(true);
    }
    expect(store.__snapshot.nodes).toHaveLength(20);
    assertSeparated(store.__snapshot.nodes);
    const ys = store.__snapshot.nodes.map((n) => n.position.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1600);
  });

  it('旧的默认槽位已被占住时,新节点不叠上去', async () => {
    const taken: Node[] = Array.from({ length: 6 }, (_, i) => ({
      id: `old-${i}`,
      kind: 'document',
      label: `旧 ${i}`,
      position: { x: 80 + i * 60, y: 80 },
      width: 236,
      height: 220,
      data: {},
    }));
    const store = makeStore(taken);
    const h = makeHandlers(store);
    const res = await h.call('canvas.create_node', { kind: 'document', label: '新的' }, ctx);
    expect(res.ok, res.result).toBe(true);
    const created = store.__snapshot.nodes.find((n) => n.id === res.nodeId)!;
    // makeStore 与 taken 共用同一个数组,创建后 taken 里也有新节点,不能拿它和自己比
    for (const old of taken) {
      if (old.id === created.id) continue;
      const a = rectOf(asOcc(created));
      const b = rectOf(asOcc(old));
      expect(rectsOverlap(a, b, 24), `new ${a.x},${a.y} ${a.w}x${a.h} vs ${old.id} ${b.x},${b.y} ${b.w}x${b.h}`).toBe(false);
    }
  });

  it('x:99999 被拉到现有内容附近', async () => {
    const store = makeStore([
      { id: 'a', kind: 'document', label: '已有', position: { x: 80, y: 80 }, width: 236, height: 220, data: {} },
    ]);
    const h = makeHandlers(store);
    const res = await h.call('canvas.create_node', { kind: 'document', label: '很远', x: 99999, y: 80 }, ctx);
    expect(res.ok, res.result).toBe(true);
    const created = store.__snapshot.nodes.find((n) => n.id === res.nodeId)!;
    expect(created.position.x).toBeLessThan(2000);
    expect(created.position.x).toBeGreaterThan(80);
    assertSeparated(store.__snapshot.nodes);
  });

  it('放在 9:16 图片右侧时不被竖图盖住', async () => {
    const store = makeStore([
      {
        id: 'tall',
        kind: 'image-gen',
        label: '竖图',
        position: { x: 80, y: 80 },
        width: 232,
        data: { width: 576, height: 1024 },
      },
    ]);
    const h = makeHandlers(store);
    const res = await h.call(
      'canvas.create_node',
      { kind: 'document', label: '旁边', place: { relativeTo: 'tall', dir: 'right' } },
      ctx,
    );
    expect(res.ok, res.result).toBe(true);
    const created = store.__snapshot.nodes.find((n) => n.id === res.nodeId)!;
    const box = rectOf(asOcc(store.__snapshot.nodes[0]!));
    expect(box.h).toBeGreaterThan(400);
    expect(created.position.x).toBeGreaterThanOrEqual(box.x + box.w);
    assertSeparated(store.__snapshot.nodes);
  });

  it('relativeTo right / below 避开已占用的位置', async () => {
    const store = makeStore([
      { id: 'host', kind: 'document', label: '参照', position: { x: 80, y: 80 }, width: 236, height: 220, data: {} },
    ]);
    const h = makeHandlers(store);
    const right = await h.call(
      'canvas.create_node',
      { kind: 'document', label: '右侧', place: { relativeTo: 'host', dir: 'right' } },
      ctx,
    );
    expect(right.ok, right.result).toBe(true);
    const rightNode = store.__snapshot.nodes.find((n) => n.id === right.nodeId)!;
    expect(rightNode.position.x).toBeGreaterThan(80);
    expect(rightNode.position.y).toBe(80);

    const below = await h.call(
      'canvas.create_node',
      { kind: 'document', label: '下方', place: { relativeTo: 'host', dir: 'below' } },
      ctx,
    );
    expect(below.ok, below.result).toBe(true);
    const belowNode = store.__snapshot.nodes.find((n) => n.id === below.nodeId)!;
    expect(belowNode.position.y).toBeGreaterThan(80);
    assertSeparated(store.__snapshot.nodes);

    const blocked = await h.call(
      'canvas.create_node',
      { kind: 'document', label: '再右侧', place: { relativeTo: 'host', dir: 'right' } },
      ctx,
    );
    expect(blocked.ok, blocked.result).toBe(true);
    assertSeparated(store.__snapshot.nodes);
  });

  it('本轮选中节点时,不传坐标就放在它右侧', async () => {
    const store = makeStore([
      { id: 'sel', kind: 'document', label: '选中', position: { x: 200, y: 140 }, width: 236, height: 220, data: {} },
    ]);
    const h = makeHandlers(store);
    const res = await h.call('canvas.create_node', { kind: 'document', label: '跟着选中' }, { ...ctx, selectedNodeId: 'sel' });
    expect(res.ok, res.result).toBe(true);
    const created = store.__snapshot.nodes.find((n) => n.id === res.nodeId)!;
    expect(created.position.x).toBeGreaterThanOrEqual(200 + 236);
    expect(created.position.y).toBe(140);
    assertSeparated(store.__snapshot.nodes);
  });

  it('list_nodes 带上坐标和卡片宽高', async () => {
    const store = makeStore([
      { id: 'a', kind: 'document', label: '简报', position: { x: 80, y: 80 }, width: 236, height: 220, data: {} },
    ]);
    const h = makeHandlers(store);
    const res = await h.call('canvas.list_nodes', {}, ctx);
    expect(res.ok).toBe(true);
    expect(res.result).toContain('@(80,80');
    expect(res.result).toContain('卡片');
  });
});

describe('canvas.tidy', () => {
  it('重叠和散落的节点整理后不重叠,内容不变,再整理一次坐标不变', async () => {
    const store = makeStore([
      { id: 'a', kind: 'document', label: '甲', position: { x: 80, y: 80 }, width: 236, height: 220, data: { markdown: 'keep' } },
      { id: 'b', kind: 'document', label: '乙', position: { x: 100, y: 100 }, width: 236, height: 220, data: { markdown: 'keep-b' } },
      { id: 'c', kind: 'document', label: '丙', position: { x: 9000, y: -2000 }, width: 236, height: 220, data: {} },
    ]);
    const h = makeHandlers(store);
    const res = await h.call('canvas.tidy', {}, ctx);
    expect(res.ok, res.result).toBe(true);
    const nodes = store.__snapshot.nodes;
    assertSeparated(nodes);
    const ys = nodes.map((n) => n.position.y);
    const xs = nodes.map((n) => n.position.x);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(4000);
    expect(Math.max(...xs)).toBeLessThan(4000);
    expect(nodes.find((n) => n.id === 'a')!.data).toEqual({ markdown: 'keep' });
    const once = nodes.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y }));
    const again = await h.call('canvas.tidy', {}, ctx);
    expect(again.ok, again.result).toBe(true);
    for (const prev of once) {
      const n = store.__snapshot.nodes.find((x) => x.id === prev.id)!;
      expect(n.position.x).toBe(prev.x);
      expect(n.position.y).toBe(prev.y);
    }
  });

  it('scope=selected 只移动选中的节点', async () => {
    const store = makeStore([
      { id: 'keep', kind: 'document', label: '留', position: { x: 400, y: 360 }, width: 236, height: 220, data: { markdown: 'stay' } },
      { id: 'move', kind: 'document', label: '动', position: { x: 410, y: 370 }, width: 236, height: 220, data: {} },
    ]);
    const h = makeHandlers(store);
    const res = await h.call('canvas.tidy', { scope: 'selected', selectedIds: ['move'] }, ctx);
    expect(res.ok, res.result).toBe(true);
    const keep = store.__snapshot.nodes.find((n) => n.id === 'keep')!;
    expect(keep.position).toEqual({ x: 400, y: 360 });
    expect(keep.data).toEqual({ markdown: 'stay' });
    assertSeparated(store.__snapshot.nodes);
  });
});

describe('storyboard.materialize 落点', () => {
  function shotsOf(nodes: Node[]) {
    return nodes.filter((n) => n.kind === 'shot');
  }

  it('先铺 3 行再追加 5 行:不重叠,y 也不跳几千像素', async () => {
    const sb = storyboard('sb-1', 60, 80, 3);
    const store = makeStore([sb]);
    const h = makeHandlers(store);
    const first = await h.call('storyboard.materialize', { nodeId: 'sb-1' }, ctx);
    expect(first.ok, first.result).toBe(true);
    const afterFirst = shotsOf(store.__snapshot.nodes);
    expect(afterFirst).toHaveLength(3);
    const prevBottom = Math.max(...store.__snapshot.nodes.map((n) => n.position.y + (rectOf(asOcc(n)).h)));

    sb.data = { ...storyboard('sb-1', 60, 80, 8).data, aspect: '16:9', tier: 'default' };
    const second = await h.call('storyboard.materialize', { nodeId: 'sb-1' }, ctx);
    expect(second.ok, second.result).toBe(true);
    const after = shotsOf(store.__snapshot.nodes);
    expect(after).toHaveLength(8);
    const appended = after.filter((n) => ((n.data?.promptFrom as { row?: number })?.row ?? 0) > 3);
    expect(appended.length).toBe(5);
    const newMinY = Math.min(...appended.map((n) => n.position.y));
    expect(newMinY).toBeGreaterThanOrEqual(prevBottom - 1);
    expect(newMinY - prevBottom).toBeLessThan(200);
    const ys = after.map((n) => n.position.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(4000);
    assertSeparated(store.__snapshot.nodes);
  });

  it('两张表锚点靠近时铺出的节点不重叠', async () => {
    const store = makeStore([storyboard('sb-a', 60, 80, 2), storyboard('sb-b', 60, 400, 2)]);
    const h = makeHandlers(store);
    expect((await h.call('storyboard.materialize', { nodeId: 'sb-a' }, ctx)).ok).toBe(true);
    expect((await h.call('storyboard.materialize', { nodeId: 'sb-b' }, ctx)).ok).toBe(true);
    const generated = store.__snapshot.nodes.filter((n) => n.kind === 'shot' || n.kind === 'image-gen');
    expect(generated.length).toBeGreaterThanOrEqual(4);
    assertSeparated(store.__snapshot.nodes);
    const ys = generated.map((n) => n.position.y);
    expect(Math.max(...ys)).toBeLessThan(3000);
  });

  it('竖构图行距大于横构图', async () => {
    async function pitch(aspect: string) {
      const store = makeStore([storyboard('sb-1', 60, 80, 2, aspect)]);
      const h = makeHandlers(store);
      const res = await h.call('storyboard.materialize', { nodeId: 'sb-1', aspect }, ctx);
      expect(res.ok, res.result).toBe(true);
      const shots = shotsOf(store.__snapshot.nodes).sort(
        (a, b) =>
          ((a.data?.promptFrom as { row?: number }).row ?? 0) - ((b.data?.promptFrom as { row?: number }).row ?? 0),
      );
      expect(shots).toHaveLength(2);
      return shots[1]!.position.y - shots[0]!.position.y;
    }
    const wide = await pitch('16:9');
    const tall = await pitch('9:16');
    expect(tall).toBeGreaterThan(wide + 80);
  });
});
