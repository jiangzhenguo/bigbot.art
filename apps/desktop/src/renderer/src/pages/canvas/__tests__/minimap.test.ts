/**
 * minimap 布局测试 — 节点投影 / 视口框 / 逆变换(minimapLayout / minimapToWorld)
 * 用例:空画布、单节点、负坐标(世界盒外)节点、逆变换往返、视图平移缩放口径
 */
import { describe, it, expect } from 'vitest';
import { minimapLayout, minimapToWorld } from '../minimap.js';
import type { CanvasNode } from '../types.js';

const node = (id: string, x: number, y: number, w = 236, h?: number): CanvasNode =>
  ({ id, title: id, w, x, y, h: h ?? 72, kind: 'document', data: {} }) as CanvasNode;

const MM = { w: 140, h: 90 };
const STAGE = { w: 1400, h: 900 };

describe('minimapLayout 空画布', () => {
  it('无节点:bounds/视口为 null,节点列表为空', () => {
    const layout = minimapLayout([], { x: 0, y: 0, z: 1 }, STAGE, MM);
    expect(layout.bounds).toBeNull();
    expect(layout.viewport).toBeNull();
    expect(layout.nodes).toHaveLength(0);
  });
});

describe('minimapLayout 节点投影', () => {
  it('单节点:包围盒即节点矩形,节点缩略落在小地图内边距内', () => {
    const layout = minimapLayout([node('n1', 100, 100, 236)], { x: 20, y: 10, z: 0.86 }, STAGE, MM);
    expect(layout.bounds).toEqual({ x: 100, y: 100, w: 236, h: 72 });
    expect(layout.nodes).toHaveLength(1);
    const r = layout.nodes[0]!;
    // 节点矩形应完全落在小地图(pad=8)内
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(140 + 0.001);
    expect(r.y + r.h).toBeLessThanOrEqual(90 + 0.001);
  });

  it('负坐标节点(世界盒外):包围盒包含负值,不做 1600×1000 世界盒钳制', () => {
    const layout = minimapLayout(
      [node('p', -489, -743, 224), node('s', 1050, -198, 236)],
      { x: 420, y: 640, z: 0.86 },
      STAGE,
      MM,
    );
    expect(layout.bounds).toEqual({ x: -489, y: -743, w: 1775, h: 617 });
    expect(layout.nodes).toHaveLength(2);
    for (const r of layout.nodes) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(140 + 0.001);
      expect(r.y + r.h).toBeLessThanOrEqual(90 + 0.001);
    }
    // 节点相对顺序保持(人物1 在左,镜头在右)
    expect(layout.nodes[0]!.x).toBeLessThan(layout.nodes[1]!.x);
  });

  it('多节点:包围盒为全部节点外接矩形,节点不超出小地图', () => {
    const nodes = [node('a', 0, 0), node('b', 500, 300), node('c', 1200, 800, 300)];
    const layout = minimapLayout(nodes, { x: 40, y: 30, z: 0.6 }, STAGE, MM);
    expect(layout.bounds).toEqual({ x: 0, y: 0, w: 1500, h: 872 });
    expect(layout.nodes).toHaveLength(3);
    for (const r of layout.nodes) {
      expect(r.x + r.w).toBeLessThanOrEqual(140 + 0.001);
      expect(r.y + r.h).toBeLessThanOrEqual(90 + 0.001);
    }
  });
});

describe('minimapLayout 视口框', () => {
  it('view 平移/缩放与 .world 的 translate/scale 同口径:视口按 inverse 变换投影', () => {
    const view = { x: 20, y: 10, z: 0.86 };
    const layout = minimapLayout([node('n1', 100, 100)], view, STAGE, MM);
    expect(layout.viewport).not.toBeNull();
    // 视口世界原点 = -view / z(舞台左上角对应的世界坐标)
    const origin = minimapToWorld(layout.viewport!.x, layout.viewport!.y, layout);
    expect(origin!.x).toBeCloseTo(-view.x / view.z, 5);
    expect(origin!.y).toBeCloseTo(-view.y / view.z, 5);
    // 视口尺寸 = 舞台尺寸 / z 再按同一比例缩放
    expect(layout.viewport!.w).toBeCloseTo((STAGE.w / view.z) * layout.scale, 5);
    expect(layout.viewport!.h).toBeCloseTo((STAGE.h / view.z) * layout.scale, 5);
  });

  it('复位视图(20,10,0.86)下视口框覆盖画布大部分内容区间', () => {
    const layout = minimapLayout(
      [node('a', 0, 0), node('b', 1500, 900, 200)],
      { x: 20, y: 10, z: 0.86 },
      STAGE,
      MM,
    );
    // 视口框覆盖内容包围盒(折算到小地图尺度)的 90% 以上
    expect(layout.viewport!.w).toBeGreaterThan(layout.bounds!.w * layout.scale * 0.9);
    expect(layout.viewport!.h).toBeGreaterThan(layout.bounds!.h * layout.scale * 0.9);
  });
});

describe('minimapToWorld 逆变换', () => {
  it('世界坐标 → 小地图 → 逆变换往返一致', () => {
    const nodes = [node('a', -100, 50), node('b', 800, 700, 300, 90)];
    const view = { x: 33, y: 27, z: 0.75 };
    const layout = minimapLayout(nodes, view, STAGE, MM);
    for (const pt of [
      { x: -100, y: 50 },
      { x: 800, y: 700 },
      { x: 0, y: 0 },
      { x: 400, y: 300 },
    ]) {
      // 世界 → 小地图
      const mx = layout.offX + (pt.x - layout.bounds!.x) * layout.scale;
      const my = layout.offY + (pt.y - layout.bounds!.y) * layout.scale;
      const back = minimapToWorld(mx, my, layout)!;
      expect(back.x).toBeCloseTo(pt.x, 5);
      expect(back.y).toBeCloseTo(pt.y, 5);
    }
  });

  it('无节点时逆变换返回 null', () => {
    const layout = minimapLayout([], { x: 0, y: 0, z: 1 }, STAGE, MM);
    expect(minimapToWorld(10, 10, layout)).toBeNull();
  });
});