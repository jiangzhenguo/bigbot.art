/**
 * minimap — 画布右下角小地图的布局计算(纯函数,可单测)
 *
 * 把「画布世界内容(节点包围盒)+ 当前视口」投影到一个固定尺寸的小地图上:
 *   1. 取全部节点的包围盒作为内容范围(无限画布,节点可能在 1600×1000 世界盒外,不做钳制);
 *   2. 按「保持比例、尽量铺满」缩放进小地图内边距区域,居中;
 *   3. 视口(舞台可见的世界区域)按同一变换投影成带边框的矩形。
 *
 * 输入全是可序列化数据,不读 DOM/ref;StageView 用它渲染,
 * 点击/拖拽跳转用 minimapToWorld 做逆变换。
 */
import type { CanvasNode } from './types';

/** 未实测节点高度时的估算兜底(px,与 CanvasPage 的 UNMEASURED_NODE_H 同值) */
const UNMEASURED_H = 72;
/** .node 默认宽度(未实测时) */
const DEFAULT_W = 236;

export interface MinimapLayout {
  /** 节点内容的世界包围盒(null = 无节点) */
  bounds: { x: number; y: number; w: number; h: number } | null;
  /** 世界坐标 → 小地图坐标:mx = offX + (wx - bounds.x) * scale */
  scale: number;
  offX: number;
  offY: number;
  /** 节点在小地图内的矩形(px) */
  nodes: Array<{ id: string; x: number; y: number; w: number; h: number }>;
  /** 当前视口在小地图内的矩形(null = 无节点) */
  viewport: { x: number; y: number; w: number; h: number } | null;
}

/**
 * 计算小地图布局。
 * @param nodes 画布节点(只需 id / x / y / w / h)
 * @param view  视图状态(平移 + 缩放,与 .world 的 translate/scale 同口径)
 * @param stage 舞台可视区尺寸(px)
 * @param mm    小地图容器尺寸(px)
 * @param pad   内容与小地图边缘的最小留白(px)
 */
export function minimapLayout(
  nodes: Array<Pick<CanvasNode, 'id' | 'x' | 'y' | 'w' | 'h'>>,
  view: { x: number; y: number; z: number },
  stage: { w: number; h: number },
  mm: { w: number; h: number },
  pad = 8,
): MinimapLayout {
  const empty: MinimapLayout = { bounds: null, scale: 1, offX: 0, offY: 0, nodes: [], viewport: null };
  const rects = nodes.map((n) => ({
    id: n.id,
    x: n.x,
    y: n.y,
    w: n.w ?? DEFAULT_W,
    h: n.h ?? UNMEASURED_H,
  }));
  if (rects.length === 0) return empty;

  const bx = Math.min(...rects.map((r) => r.x));
  const by = Math.min(...rects.map((r) => r.y));
  const bw = Math.max(...rects.map((r) => r.x + r.w)) - bx;
  const bh = Math.max(...rects.map((r) => r.y + r.h)) - by;
  const scale = Math.min((mm.w - pad * 2) / bw, (mm.h - pad * 2) / bh) || 1;
  const offX = (mm.w - bw * scale) / 2;
  const offY = (mm.h - bh * scale) / 2;
  const toMm = (wx: number, wy: number) => ({
    x: offX + (wx - bx) * scale,
    y: offY + (wy - by) * scale,
  });

  const nodesMm = rects.map((r) => {
    const p = toMm(r.x, r.y);
    return { id: r.id, x: p.x, y: p.y, w: r.w * scale, h: r.h * scale };
  });

  // 视口:舞台可视区的世界矩形(与 .world 平移缩放互逆),再投影到小地图
  const vx = -view.x / view.z;
  const vy = -view.y / view.z;
  const vw = stage.w / view.z;
  const vh = stage.h / view.z;
  const vp = toMm(vx, vy);
  const viewport = { x: vp.x, y: vp.y, w: vw * scale, h: vh * scale };

  return { bounds: { x: bx, y: by, w: bw, h: bh }, scale, offX, offY, nodes: nodesMm, viewport };
}

/**
 * 小地图像素坐标 → 画布世界坐标(minimapLayout 的逆变换)。
 * @param layout minimapLayout 的返回值(取 bounds/scale/offX/offY)
 */
export function minimapToWorld(
  mx: number,
  my: number,
  layout: Pick<MinimapLayout, 'bounds' | 'scale' | 'offX' | 'offY'>,
): { x: number; y: number } | null {
  const b = layout.bounds;
  if (!b) return null;
  return { x: b.x + (mx - layout.offX) / layout.scale, y: b.y + (my - layout.offY) / layout.scale };
}