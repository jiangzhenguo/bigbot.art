/**
 * 主进程落点:估算高度、单节点避让、整批铺排。
 * 不碰画布存储,只锁 placeNode / placeBatch 的几何不变量。
 */
import { describe, expect, it } from 'vitest';
import {
  PLACE_ABS_CAP,
  PLACE_CLAMP_MARGIN,
  PLACE_GAP,
  PLACE_ORIGIN,
  estimateNodeSize,
  layoutBatch,
  placeBatch,
  placeNode,
  rectOf,
  rectsOverlap,
  tidyNodes,
  type Occupant,
} from '../canvas-placement.js';

function occ(partial: Partial<Occupant> & Pick<Occupant, 'id'>): Occupant {
  return {
    kind: 'document',
    x: 0,
    y: 0,
    ...partial,
  };
}

function overlapsAny(nodes: Occupant[], gap = PLACE_GAP): boolean {
  const rects = nodes.map(rectOf);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (rectsOverlap(rects[i]!, rects[j]!, gap)) return true;
    }
  }
  return false;
}

describe('estimateNodeSize', () => {
  it('9:16 卡片明显高于 16:9', () => {
    const wide = estimateNodeSize({ kind: 'image-gen', width: 232, mediaWidth: 1024, mediaHeight: 576 });
    const tall = estimateNodeSize({ kind: 'image-gen', width: 232, mediaWidth: 576, mediaHeight: 1024 });
    expect(tall.height).toBeGreaterThan(wide.height + 150);
  });

  it('已记录的卡片高比估算更高时,用记录值', () => {
    const sized = estimateNodeSize({ kind: 'document', width: 236, height: 480 });
    expect(sized.height).toBe(480);
  });
});

describe('placeNode', () => {
  it('空画布第一张落在 (80,80) 附近', () => {
    const spot = placeNode([], { kind: 'document', width: 236 });
    expect(spot.x).toBe(PLACE_ORIGIN.x);
    expect(spot.y).toBe(PLACE_ORIGIN.y);
  });

  it('连续 20 次不重叠', () => {
    const nodes: Occupant[] = [];
    for (let i = 0; i < 20; i++) {
      const spot = placeNode(nodes, { kind: 'document', width: 236 });
      nodes.push({ id: `n${i}`, kind: 'document', x: spot.x, y: spot.y, width: spot.width, height: spot.height });
    }
    expect(overlapsAny(nodes)).toBe(false);
    const ys = nodes.map((n) => n.y);
    // 折行排成几行,而不是单列堆到几千像素外
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1600);
  });

  it('默认槽位已被占住时,新节点不叠上去', () => {
    const nodes: Occupant[] = Array.from({ length: 6 }, (_, i) =>
      occ({ id: `old-${i}`, x: 80 + i * 60, y: 80, width: 236, height: 220 }),
    );
    const spot = placeNode(nodes, { kind: 'document', width: 236 });
    const created = occ({ id: 'new', x: spot.x, y: spot.y, width: spot.width, height: spot.height });
    // 预置的旧槽位彼此重叠(那正是要修的旧排布);新节点不能再叠上去
    for (const old of nodes) {
      expect(rectsOverlap(rectOf(created), rectOf(old), PLACE_GAP)).toBe(false);
    }
  });

  it('x:99999 被拉回现有内容附近', () => {
    const nodes = [occ({ id: 'a', x: 80, y: 80, width: 236, height: 220 })];
    const box = rectOf(nodes[0]!);
    const spot = placeNode(nodes, { kind: 'document', width: 236, x: 99999, y: 80 });
    expect(spot.x).not.toBe(99999);
    expect(spot.x).toBeLessThanOrEqual(box.x + box.w + PLACE_CLAMP_MARGIN);
    expect(spot.x).toBeGreaterThan(box.x);
    const next = [...nodes, occ({ id: 'b', ...spot, kind: 'document' })];
    expect(overlapsAny(next)).toBe(false);
  });

  it('放在 9:16 图片右侧时不被竖图盖住', () => {
    const portrait = occ({
      id: 'tall',
      kind: 'image-gen',
      x: 80,
      y: 80,
      width: 232,
      mediaWidth: 576,
      mediaHeight: 1024,
    });
    const spot = placeNode([portrait], { kind: 'document', width: 236, place: { relativeTo: 'tall', dir: 'right' } });
    const box = rectOf(portrait);
    expect(spot.x).toBeGreaterThanOrEqual(box.x + box.w);
    expect(box.h).toBeGreaterThan(400);
    const next = [portrait, occ({ id: 'side', x: spot.x, y: spot.y, width: spot.width, height: spot.height })];
    expect(overlapsAny(next)).toBe(false);
  });

  it('relativeTo 右侧被占时改到不重叠的位置', () => {
    const host = occ({ id: 'host', x: 80, y: 80, width: 236, height: 220 });
    const hostBox = rectOf(host);
    const blocker = occ({
      id: 'block',
      x: hostBox.x + hostBox.w + PLACE_GAP,
      y: hostBox.y,
      width: 236,
      height: 220,
    });
    const spot = placeNode([host, blocker], {
      kind: 'document',
      width: 236,
      place: { relativeTo: 'host', dir: 'right' },
    });
    const next = [host, blocker, occ({ id: 'n', x: spot.x, y: spot.y, width: spot.width, height: spot.height })];
    expect(overlapsAny(next)).toBe(false);
  });

  it('relativeTo below 落在参照节点下方', () => {
    const host = occ({ id: 'host', x: 120, y: 160, width: 236, height: 220 });
    const spot = placeNode([host], { kind: 'document', width: 236, place: { relativeTo: 'host', dir: 'below' } });
    const box = rectOf(host);
    expect(spot.y).toBeGreaterThanOrEqual(box.y + box.h);
    expect(Math.abs(spot.x - box.x)).toBeLessThanOrEqual(PLACE_GAP);
    const next = [host, occ({ id: 'n', x: spot.x, y: spot.y, width: spot.width, height: spot.height })];
    expect(overlapsAny(next)).toBe(false);
  });

  it('选中节点时默认放在它右侧', () => {
    const host = occ({ id: 'sel', x: 200, y: 140, width: 236, height: 220 });
    const spot = placeNode([host], { kind: 'shot', width: 250, selectedNodeId: 'sel' });
    expect(spot.x).toBeGreaterThanOrEqual(rectOf(host).x + rectOf(host).w);
    expect(spot.y).toBe(host.y);
  });
});

describe('placeBatch', () => {
  it('竖图行距大于横图行距', () => {
    const cells = (w: number, h: number) => [
      { key: 'img-0', kind: 'image-gen', width: 232, col: 0, row: 0, mediaWidth: w, mediaHeight: h },
      { key: 'shot-0', kind: 'shot', width: 250, col: 1, row: 0, mediaWidth: w, mediaHeight: h },
      { key: 'shot-1', kind: 'shot', width: 250, col: 1, row: 1, mediaWidth: w, mediaHeight: h },
    ];
    const wide = layoutBatch(cells(1024, 576));
    const tall = layoutBatch(cells(576, 1024));
    const dy = (items: { key: string; y: number }[]) =>
      items.find((i) => i.key === 'shot-1')!.y - items.find((i) => i.key === 'shot-0')!.y;
    expect(dy(tall.items)).toBeGreaterThan(dy(wide.items) + 100);
  });

  it('追加时接在已有块下方,而不是按大行号跳走', () => {
    const prior = placeBatch(
      [],
      [
        { key: 's0', kind: 'shot', width: 250, col: 1, row: 0, mediaWidth: 1024, mediaHeight: 576 },
        { key: 's1', kind: 'shot', width: 250, col: 1, row: 1, mediaWidth: 1024, mediaHeight: 576 },
        { key: 's2', kind: 'shot', width: 250, col: 1, row: 2, mediaWidth: 1024, mediaHeight: 576 },
      ],
      { anchor: { x: 400, y: 80 } },
    );
    const existing: Occupant[] = prior.map((p) => occ({ id: p.key, kind: 'shot', x: p.x, y: p.y, width: p.width, height: p.height }));
    const bottom = Math.max(...existing.map((n) => n.y + rectOf(n).h));
    const more = placeBatch(
      existing,
      Array.from({ length: 5 }, (_, i) => ({
        key: `s${i + 3}`,
        kind: 'shot',
        width: 250,
        col: 1,
        row: i,
        mediaWidth: 1024,
        mediaHeight: 576,
      })),
      { continueFrom: existing, anchor: { x: 400, y: 80 + 40 * 186 } },
    );
    const minY = Math.min(...more.map((p) => p.y));
    expect(minY).toBeGreaterThanOrEqual(bottom);
    expect(minY - bottom).toBeLessThan(80);
    const all = [
      ...existing,
      ...more.map((p) => occ({ id: p.key, kind: 'shot', x: p.x, y: p.y, width: p.width, height: p.height })),
    ];
    expect(overlapsAny(all)).toBe(false);
  });

  it('两块锚点靠近时整块互相避开', () => {
    const sb = occ({ id: 'sb', kind: 'storyboard', x: 60, y: 80 });
    const cells = [
      { key: 'img', kind: 'image-gen', width: 232, col: 0, row: 0, mediaWidth: 1024, mediaHeight: 576 },
      { key: 's0', kind: 'shot', width: 250, col: 1, row: 0, mediaWidth: 1024, mediaHeight: 576 },
      { key: 's1', kind: 'shot', width: 250, col: 1, row: 1, mediaWidth: 1024, mediaHeight: 576 },
    ];
    const first = placeBatch([sb], cells, { anchor: { x: 60 + rectOf(sb).w + PLACE_GAP, y: 80 } });
    const mid: Occupant[] = [
      sb,
      ...first.map((p) => occ({ id: p.key, kind: p.key.startsWith('img') ? 'image-gen' : 'shot', x: p.x, y: p.y, width: p.width, height: p.height })),
    ];
    const second = placeBatch(
      mid,
      cells.map((c) => ({ ...c, key: `b-${c.key}` })),
      { anchor: { x: 60 + rectOf(sb).w + PLACE_GAP, y: 200 } },
    );
    const all: Occupant[] = [
      ...mid,
      ...second.map((p) => occ({ id: p.key, kind: 'shot', x: p.x, y: p.y, width: p.width, height: p.height })),
    ];
    expect(overlapsAny(all)).toBe(false);
    const firstMaxY = Math.max(...first.map((p) => p.y));
    const secondMinY = Math.min(...second.map((p) => p.y));
    expect(Math.abs(secondMinY - firstMaxY)).toBeLessThan(1600);
  });
});

describe('绝对上限', () => {
  it('反复传入超大 x 不会一步步把画布推出上限', () => {
    const nodes: Occupant[] = [occ({ id: 'seed', x: 80, y: 80, width: 236, height: 220 })];
    for (let i = 0; i < 12; i++) {
      const spot = placeNode(nodes, { kind: 'document', width: 236, x: 99999, y: 80 });
      expect(spot.x + spot.width).toBeLessThanOrEqual(PLACE_ORIGIN.x + PLACE_ABS_CAP + 1);
      nodes.push(occ({ id: `far-${i}`, x: spot.x, y: spot.y, width: spot.width, height: spot.height }));
    }
    expect(overlapsAny(nodes)).toBe(false);
  });

  it('负方向反复传入超大坐标也会停住,不会按余量一直往左上漂', () => {
    const nodes: Occupant[] = [occ({ id: 'seed', x: 80, y: 80, width: 236, height: 220 })];
    for (let i = 0; i < 20; i++) {
      const spot = placeNode(nodes, { kind: 'document', width: 236, x: -99999, y: -99999 });
      expect(spot.x).toBeGreaterThanOrEqual(PLACE_ORIGIN.x - PLACE_ABS_CAP - 1);
      expect(spot.y).toBeGreaterThanOrEqual(PLACE_ORIGIN.y - PLACE_ABS_CAP - 1);
      nodes.push(occ({ id: `neg-${i}`, x: spot.x, y: spot.y, width: spot.width, height: spot.height }));
    }
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const edge = placeNode(nodes, { kind: 'document', width: 236, x: -99999, y: -99999 });
    expect(edge.x).toBeGreaterThanOrEqual(minX - 1);
    expect(edge.y).toBeGreaterThanOrEqual(minY - 1);
    expect(edge.x).toBeGreaterThan(-5000);
    expect(edge.y).toBeGreaterThan(-5000);
  });

  it('内容已经在上限左侧时,新的负坐标不再越过现有左边缘一个上限', () => {
    const nodes: Occupant[] = [occ({ id: 'seed', x: -20000, y: -20000, width: 236, height: 220 })];
    for (let i = 0; i < 20; i++) {
      const spot = placeNode(nodes, { kind: 'document', width: 236, x: -99999, y: -99999 });
      expect(spot.x).toBeGreaterThanOrEqual(-20000 - PLACE_ABS_CAP - 1);
      expect(spot.y).toBeGreaterThanOrEqual(-20000 - PLACE_ABS_CAP - 1);
      nodes.push(occ({ id: `far-${i}`, x: spot.x, y: spot.y, width: spot.width, height: spot.height }));
    }
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const edge = placeNode(nodes, { kind: 'document', width: 236, x: -99999, y: -99999 });
    expect(edge.x).toBeGreaterThanOrEqual(minX - 1);
    expect(edge.y).toBeGreaterThanOrEqual(minY - 1);
  });
});

describe('tidyNodes', () => {
  function apply(nodes: Occupant[], moves: Array<{ id: string; x: number; y: number }>): Occupant[] {
    const byId = new Map(moves.map((m) => [m.id, m]));
    return nodes.map((n) => {
      const m = byId.get(n.id);
      return m ? { ...n, x: m.x, y: m.y } : n;
    });
  }

  it('重叠和散落的节点整理后不重叠,包围盒有界', () => {
    const nodes: Occupant[] = [
      occ({ id: 'a', x: 80, y: 80, width: 236, height: 220 }),
      occ({ id: 'b', x: 100, y: 90, width: 236, height: 220 }),
      occ({ id: 'c', x: 9000, y: -4000, width: 236, height: 220 }),
      occ({
        id: 'sb',
        kind: 'storyboard',
        x: 4000,
        y: 2000,
        width: 318,
        height: 280,
      }),
      occ({
        id: 'shot-2',
        kind: 'shot',
        x: 80,
        y: 2400,
        width: 250,
        data: { promptFrom: { nodeId: 'sb', mode: 'row', row: 2 }, width: 1024, height: 576 },
      }),
      occ({
        id: 'shot-1',
        kind: 'shot',
        x: 7000,
        y: 300,
        width: 250,
        data: { promptFrom: { nodeId: 'sb', mode: 'row', row: 1 }, width: 1024, height: 576 },
      }),
    ];
    const tidy = tidyNodes(nodes, [
      { source: 'sb', target: 'shot-1' },
      { source: 'sb', target: 'shot-2' },
    ]);
    const next = apply(nodes, tidy.moves);
    expect(overlapsAny(next)).toBe(false);
    expect(tidy.bbox.w).toBeLessThan(PLACE_ABS_CAP);
    expect(tidy.bbox.h).toBeLessThan(PLACE_ABS_CAP);
    expect(tidy.bbox.x).toBeGreaterThanOrEqual(PLACE_ORIGIN.x - 1);
    expect(tidy.bbox.y).toBeGreaterThanOrEqual(PLACE_ORIGIN.y - 1);
    const sb = next.find((n) => n.id === 'sb')!;
    const s1 = next.find((n) => n.id === 'shot-1')!;
    const s2 = next.find((n) => n.id === 'shot-2')!;
    expect(s1.x).toBeGreaterThan(sb.x);
    expect(s2.y).toBeGreaterThan(s1.y);
    const again = tidyNodes(next, []);
    const twice = apply(next, again.moves);
    for (const n of twice) {
      const prev = next.find((p) => p.id === n.id)!;
      expect(n.x).toBe(prev.x);
      expect(n.y).toBe(prev.y);
    }
  });

  it('selected 只移动选中节点,未选中的坐标不变', () => {
    const nodes: Occupant[] = [
      occ({ id: 'keep', x: 400, y: 400, width: 236, height: 220 }),
      occ({ id: 'move-a', x: 410, y: 410, width: 236, height: 220 }),
      occ({ id: 'move-b', x: 5000, y: 80, width: 236, height: 220 }),
    ];
    const tidy = tidyNodes(nodes, [], { scope: 'selected', selectedIds: ['move-a', 'move-b'] });
    const next = apply(nodes, tidy.moves);
    const keep = next.find((n) => n.id === 'keep')!;
    expect(keep.x).toBe(400);
    expect(keep.y).toBe(400);
    expect(tidy.moves.map((m) => m.id).sort()).toEqual(['move-a', 'move-b']);
    expect(overlapsAny(next)).toBe(false);
    const again = tidyNodes(next, [], { scope: 'selected', selectedIds: ['move-a', 'move-b'] });
    const twice = apply(next, again.moves);
    for (const id of ['move-a', 'move-b', 'keep']) {
      const a = next.find((n) => n.id === id)!;
      const b = twice.find((n) => n.id === id)!;
      expect(b.x).toBe(a.x);
      expect(b.y).toBe(a.y);
    }
  });

  function sig(nodes: Occupant[]): string {
    return nodes.map((n) => `${n.id}:${n.x},${n.y}`).join('|');
  }

  it('已经按行排好的 6 个文档再整理四次,坐标不变', () => {
    const w = 236;
    const h = 220;
    const rowY = PLACE_ORIGIN.y;
    const nextY = rowY + h + PLACE_GAP;
    const nodes = [
      ...Array.from({ length: 5 }, (_, i) =>
        occ({
          id: `d${i}`,
          kind: 'document',
          x: PLACE_ORIGIN.x + i * (w + PLACE_GAP),
          y: rowY,
          width: w,
          height: h,
        }),
      ),
      occ({
        id: 'd5',
        kind: 'document',
        x: PLACE_ORIGIN.x,
        y: nextY,
        width: w,
        height: h,
      }),
    ];
    let next = apply(nodes, tidyNodes(nodes).moves);
    expect(sig(next)).toBe(sig(nodes));
    const first = sig(next);
    for (let i = 0; i < 3; i++) {
      next = apply(next, tidyNodes(next).moves);
      expect(sig(next)).toBe(first);
    }
    const selIds = next.map((n) => n.id);
    let selected = next;
    for (let i = 0; i < 3; i++) {
      selected = apply(selected, tidyNodes(selected, [], { scope: 'selected', selectedIds: selIds }).moves);
      expect(sig(selected)).toBe(first);
    }
  });

  it('分组和分镜表一起整理四次,坐标不变,镜头留在表旁边', () => {
    const nodes: Occupant[] = [
      occ({ id: 'sb', kind: 'storyboard', x: 2400, y: 1800, width: 318, height: 280 }),
      occ({
        id: 'img-1',
        kind: 'image-gen',
        x: 100,
        y: 100,
        width: 232,
        data: { storyboardId: 'sb', storyboardRow: 1, width: 1024, height: 576 },
      }),
      occ({
        id: 'shot-1',
        kind: 'shot',
        x: 900,
        y: 40,
        width: 250,
        data: { storyboardId: 'sb', storyboardRow: 1, width: 1024, height: 576 },
      }),
      occ({
        id: 'img-2',
        kind: 'image-gen',
        x: 80,
        y: 900,
        width: 232,
        data: { storyboardId: 'sb', storyboardRow: 2, width: 1024, height: 576 },
      }),
      occ({
        id: 'shot-2',
        kind: 'shot',
        x: 1400,
        y: 1100,
        width: 250,
        data: { storyboardId: 'sb', storyboardRow: 2, width: 1024, height: 576 },
      }),
      ...Array.from({ length: 4 }, (_, i) =>
        occ({ id: `g${i}`, kind: 'document', x: 300 + i * 30, y: 2000 + (i % 2) * 40, width: 236, height: 220 }),
      ),
    ];
    const opts = { groups: [{ members: ['g0', 'g1', 'g2', 'g3'] }] };
    let next = apply(nodes, tidyNodes(nodes, [], opts).moves);
    const sb = next.find((n) => n.id === 'sb')!;
    const img1 = next.find((n) => n.id === 'img-1')!;
    const shot1 = next.find((n) => n.id === 'shot-1')!;
    const img2 = next.find((n) => n.id === 'img-2')!;
    expect(img1.x).toBeGreaterThan(sb.x);
    expect(shot1.x).toBeGreaterThan(img1.x);
    expect(img1.y).toBe(shot1.y);
    expect(img2.y).toBeGreaterThan(img1.y);
    const first = sig(next);
    for (let i = 0; i < 3; i++) {
      next = apply(next, tidyNodes(next, [], opts).moves);
      expect(sig(next)).toBe(first);
    }
  });

  it('边分派清掉 promptFrom 之后,分镜表和镜头仍按边留在一块', () => {
    const nodes: Occupant[] = [
      occ({ id: 'doc', kind: 'document', x: 80, y: 80, width: 236, height: 220 }),
      occ({ id: 'sb', kind: 'storyboard', x: 2200, y: 1600, width: 318, height: 280 }),
      occ({ id: 'img', kind: 'image-gen', x: 120, y: 400, width: 232, data: { width: 1024, height: 576 } }),
      occ({ id: 'shot', kind: 'shot', x: 480, y: 860, width: 250, data: { width: 1024, height: 576 } }),
    ];
    const edges = [
      { source: 'sb', target: 'img' },
      { source: 'sb', target: 'shot' },
    ];
    let next = apply(nodes, tidyNodes(nodes, edges).moves);
    const sb = next.find((n) => n.id === 'sb')!;
    const img = next.find((n) => n.id === 'img')!;
    const shot = next.find((n) => n.id === 'shot')!;
    const doc = next.find((n) => n.id === 'doc')!;
    expect(img.x).toBeGreaterThan(sb.x);
    expect(shot.x).toBeGreaterThan(sb.x);
    expect(img.y).toBeLessThan(shot.y);
    expect(Math.abs(doc.y - sb.y) > 8 || doc.x + 236 < sb.x || doc.x > img.x).toBe(true);
    const first = sig(next);
    for (let i = 0; i < 3; i++) {
      next = apply(next, tidyNodes(next, edges).moves);
      expect(sig(next)).toBe(first);
    }
  });

  it('选中整理落在原选区附近,不贴到远处的离群节点', () => {
    const nodes: Occupant[] = [
      occ({ id: 'near', kind: 'document', x: 200, y: 180, width: 236, height: 220 }),
      occ({ id: 'shot', kind: 'shot', x: 400, y: 300, width: 250, height: 220 }),
      occ({ id: 'outlier', kind: 'document', x: -3740, y: 2491, width: 236, height: 220 }),
    ];
    let next = apply(nodes, tidyNodes(nodes, [], { scope: 'selected', selectedIds: ['shot'] }).moves);
    const shot = next.find((n) => n.id === 'shot')!;
    const outlier = next.find((n) => n.id === 'outlier')!;
    expect(Math.hypot(shot.x - 400, shot.y - 300)).toBeLessThan(800);
    expect(Math.hypot(shot.x - outlier.x, shot.y - outlier.y)).toBeGreaterThan(2000);
    expect(outlier.x).toBe(-3740);
    expect(outlier.y).toBe(2491);
    const first = sig(next);
    for (let i = 0; i < 3; i++) {
      next = apply(next, tidyNodes(next, [], { scope: 'selected', selectedIds: ['shot'] }).moves);
      expect(sig(next)).toBe(first);
    }
  });
});
