/**
 * viewport-ensure — 选中节点时把视口平移到「不被左右面板遮挡」的安全区
 *
 * 检查器 / 节点面板 / Agent 都是叠在 stage 上的绝对定位浮层。
 * 选中节点或拖宽检查器后,用本模块算最小平移,让节点包围盒进入可见安全矩形。
 * 纯函数,单测钉边界(与 selection.ts 同口径)。
 */

export interface ViewXY {
  x: number;
  y: number;
  z: number;
}

export interface WorldBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 舞台四周被浮层占用的边距(屏幕像素,相对 stage 左上) */
export interface SafeInsets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 与 design-pages.css 浮层几何对齐 */
export const PANEL_EDGE = 12;
export const PANEL_TOP = 66;
export const PALETTE_W = 200;
export const INSP_PALETTE_GAP = 8;
export const DEFAULT_INSP_W = 300;
export const MIN_INSP_W = 260;
export const MAX_INSP_W_CAP = 480;
export const ENSURE_MARGIN = 24;

/**
 * 左侧 chrome 占用宽度(检查器开 + 可选节点面板)。
 * 几何与 CSS 一致:
 *   insp left=12 width=inspW;
 *   palette 在 insp-open 时 left = 12 + inspW + 8, width=200(或收起为 0)。
 */
export function leftChromeWidth(args: {
  inspOpen: boolean;
  inspW: number;
  palCollapsed: boolean;
}): number {
  const { inspOpen, inspW, palCollapsed } = args;
  if (!inspOpen) {
    return palCollapsed ? 0 : PANEL_EDGE + PALETTE_W;
  }
  return PANEL_EDGE + inspW + INSP_PALETTE_GAP + (palCollapsed ? 0 : PALETTE_W);
}

/** 右侧 Agent 面板占用(right=12 + width) */
export function rightChromeWidth(agentW: number): number {
  return PANEL_EDGE + agentW;
}

/** 世界包围盒 → stage 屏幕坐标(与 CSS transform translate(view)+scale(z) 同系) */
export function worldBoxToScreen(box: WorldBox, view: ViewXY): ScreenRect {
  const z = view.z;
  return {
    left: box.x * z + view.x,
    top: box.y * z + view.y,
    right: (box.x + box.w) * z + view.x,
    bottom: (box.y + box.h) * z + view.y,
  };
}

/**
 * 把屏幕矩形移进安全区所需的最小平移(加到 view.x/y 上)。
 * 节点比安全区还宽/高时:贴齐安全区左/上边,宁可露右边也不钻进检查器。
 */
export function panDeltaToFit(
  screen: ScreenRect,
  stage: { w: number; h: number },
  insets: SafeInsets,
  margin: number = ENSURE_MARGIN,
): { dx: number; dy: number } {
  const safeL = insets.left + margin;
  const safeT = insets.top + margin;
  const safeR = stage.w - insets.right - margin;
  const safeB = stage.h - insets.bottom - margin;

  let dx = 0;
  let dy = 0;

  const nodeW = screen.right - screen.left;
  const nodeH = screen.bottom - screen.top;
  const safeW = safeR - safeL;
  const safeH = safeB - safeT;

  if (safeW <= 0 || safeH <= 0) return { dx: 0, dy: 0 };

  if (nodeW >= safeW) {
    dx = safeL - screen.left;
  } else if (screen.left < safeL) {
    dx = safeL - screen.left;
  } else if (screen.right > safeR) {
    dx = safeR - screen.right;
  }

  if (nodeH >= safeH) {
    dy = safeT - screen.top;
  } else if (screen.top < safeT) {
    dy = safeT - screen.top;
  } else if (screen.bottom > safeB) {
    dy = safeB - screen.bottom;
  }

  return { dx, dy };
}

/** 一步算完:若需平移返回新 view,否则返回 null(调用方勿无意义 commit) */
export function ensureWorldBoxVisible(args: {
  box: WorldBox;
  view: ViewXY;
  stage: { w: number; h: number };
  insets: SafeInsets;
  margin?: number;
}): ViewXY | null {
  const screen = worldBoxToScreen(args.box, args.view);
  const { dx, dy } = panDeltaToFit(screen, args.stage, args.insets, args.margin);
  if (dx === 0 && dy === 0) return null;
  return { x: args.view.x + dx, y: args.view.y + dy, z: args.view.z };
}

export function clampInspWidth(w: number, maxCap: number = MAX_INSP_W_CAP): number {
  const max = Math.max(MIN_INSP_W, Math.min(maxCap, Math.round(typeof window !== 'undefined' ? window.innerWidth * 0.4 : maxCap)));
  return Math.max(MIN_INSP_W, Math.min(max, Math.round(w)));
}

/** 避让平移时长(ms);与面板弹出 ~220ms 同量级,略长一点更顺 */
export const REVEAL_ANIM_MS = 320;

/** easeOutCubic:起步快、收尾软(画布避让手感) */
export function easeOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - (1 - x) ** 3;
}

/** 线性插值两个视口(缩放一般不变,仍一并插便于复用) */
export function lerpView(from: ViewXY, to: ViewXY, t: number): ViewXY {
  const e = easeOutCubic(t);
  return {
    x: from.x + (to.x - from.x) * e,
    y: from.y + (to.y - from.y) * e,
    z: from.z + (to.z - from.z) * e,
  };
}
