/**
 * image-zoom — 全屏图片查看器的缩放数学(纯函数,无 React/DOM 依赖)
 *
 * 抽出成纯模块的原因:缩放钳制与「以光标为锚点」的坐标换算是这个交互里唯一
 * 容易算错又最难肉眼验证的部分(锚点算错表现为图片往一侧漂),放在纯函数里
 * 可以直接用单测锁住,见 `__tests__/image-zoom.test.ts`。
 */

/** 最小缩放(1 = 适应窗口;允许缩到 1/4 看整体构图) */
export const MIN_ZOOM = 0.25;
/** 最大缩放(细胞级看细节;再大只会看到马赛克) */
export const MAX_ZOOM = 12;
/** 平滑档位:按钮 / 键盘 / 双击在这些倍率之间跳 */
export const ZOOM_STOPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12];

/** 缩放与平移量(单位为**图片显示尺寸的百分比**,故与图片像素尺寸无关) */
export interface ZoomView {
  zoom: number;
  tx: number;
  ty: number;
}

/** 默认视图 = 适应窗口、不偏移 */
export const IDENTITY_VIEW: ZoomView = { zoom: 1, tx: 0, ty: 0 };

/** 把任意数值钳进 [min, max];NaN 回落到 min,+∞/-∞ 分别落到 max/min(不产生 NaN 视图) */
export function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return Math.min(Math.max(v, min), max);
}

/** 缩放倍率钳制 */
export function clampZoom(z: number): number {
  return clamp(z, MIN_ZOOM, MAX_ZOOM);
}

/**
 * 把 `-0` 归一成 `0`,并把浮点毛刺(1e-16 级)抹平 —— 缩放回到恰好 1 倍时若残留
 * `5.5e-17` 的偏移,虽不影响视觉,却会让「是否已复位」的判断与断言失效。
 */
const tidy = (v: number): number => {
  const n = Math.abs(v) < 1e-9 ? 0 : v;
  return n === 0 ? 0 : n;
};

/**
 * 平移钳制 —— 禁止把图拖出视口。
 *
 * **语义已用真实 Chromium 实测锁定**(探针 `scripts/probe-lightbox-css.cjs`):
 *  ① `transform: translate(t%, …) scale(z)` 的百分比基准是**未缩放的图片显示尺寸 S**,
 *     不是缩放后的 z·S(实测:1000px 图在 z=2 时 `translate(10%)` 只位移 100px,不是 200px);
 *  ② 图片在 `.ovl-lb-viewport`(grid 居中)里与视口中心重合。
 *
 * 于是图片缩放后在该方向**占据的视觉尺度**(即 `object-fit` 的 padding 也一起被放大):
 *   slack = z·S + (z−1)·L        (L = 另一方向上的图片尺寸;z ≥ 1 时恒为正)
 * 例:500×500 的图放进 1000×800 视口,左右各留 250;放大 2 倍后图宽 1000,
 * 留白被撑成每边 500 ⇒ 视觉总宽 2000。
 * 中心偏移可用范围 = (slack − V) / 2,换算成 t 的单位(S)即 `(slack − V) / 2S`;
 * slack ≤ V(图放大后仍装得下)⇒ 正好居中,返回 0。
 *
 * @param zoom 当前倍率
 * @param dispW,dispH 图片**原样显示**时的尺寸(px,即 contain 后的尺寸)
 * @param viewW,viewH 视口尺寸(px)
 */
export function panLimit(
  zoom: number,
  dispW: number,
  dispH: number,
  viewW: number,
  viewH: number,
): { x: number; y: number } {
  const z = clampZoom(zoom);
  if (viewW <= 0 || viewH <= 0) return { x: 0, y: 0 };
  const norm = clampZoom(1);
  const dw = Number.isFinite(dispW) && dispW > 0 ? dispW : 0;
  const dh = Number.isFinite(dispH) && dispH > 0 ? dispH : 0;
  // 本方向尺寸走 z·S,另一方向的留白按 (z−1) 一起撑开
  const slackW = z * dw + (z - norm) * dh;
  const slackH = z * dh + (z - norm) * dw;
  const ox = (slackW - viewW) / 2;
  const oy = (slackH - viewH) / 2;
  return {
    x: ox <= 0 || dw <= 0 ? 0 : ox / dw,
    y: oy <= 0 || dh <= 0 ? 0 : oy / dh,
  };
}

/** 归一化平移量(`-0` → `0`,抹掉浮点毛刺) */
const noNegZero = (v: number): number => tidy(v);

/**
 * 按视口尺寸钳制平移;尺寸未知(未测量)时退化为 **未放大语义**(居中不动),
 * 这样「首次渲染那一帧」不会先闪一个偏移。
 */
export function clampPanView(
  tx: number,
  ty: number,
  zoom: number,
  dispW: number,
  dispH: number,
  viewW: number,
  viewH: number,
): { tx: number; ty: number } {
  const z = clampZoom(zoom);
  const measured = viewW > 0 && viewH > 0 && dispW > 0 && dispH > 0;
  // 未放大 = 适应窗口,此时唯一正确的平移量就是 0(居中);测量未回来也一律居中,
  // 免得首帧先闪一个偏移
  if (!measured || z <= clampZoom(1)) return { tx: 0, ty: 0 };
  // 偏移量本身非法(拖拽事件缺字段 / 除零)时同样回落到居中,而不是把 NaN 传下去
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return { tx: 0, ty: 0 };
  const lim = panLimit(z, dispW, dispH, viewW, viewH);
  return { tx: noNegZero(clamp(tx, -lim.x, lim.x)), ty: noNegZero(clamp(ty, -lim.y, lim.y)) };
}

/**
 * 以视口内某点为锚点缩放:该点在屏幕上**保持不动**(触控板 / 滚轮的直觉)。
 *
 * @param prev   缩放前的视图
 * @param nextZoom 目标倍率(内部会钳制)
 * @param px,py  锚点相对视口中心的偏移,单位为 **px**
 * @param dispW,dispH 图片原样(contain 后)尺寸 px;锚点相对**图片中心**的偏移由它换算
 * @param viewW,viewH 视口尺寸(px)
 *
 * 关键点:`tx·100%` 的百分比基准是 **图片自身显示尺寸**(CSS transform 的 translate 百分比),
 * 而锚点 p 是相对**视口中心**量的,两者只有在图片恰好填满视口(或填满的方向上)才重合。
 * 故先把 p 投影到图片坐标系 `a = clamp((p ± (S - V)/2) / S)`(超出图片范围取边界,
 * 保证「点在屏幕上不动」的求解不会把图推出可视区),再解
 * `t' = a - (a - t) · z/z'`。
 */
export function zoomAtPoint(
  prev: ZoomView,
  nextZoom: number,
  px: number,
  py: number,
  dispW: number,
  dispH: number,
  viewW: number,
  viewH: number,
): ZoomView {
  const z = clampZoom(nextZoom);
  const z0 = clampZoom(prev.zoom);
  if (!Number.isFinite(px) || !Number.isFinite(py) || viewW <= 0 || viewH <= 0 || dispW <= 0 || dispH <= 0) {
    return { zoom: z, tx: prev.tx, ty: prev.ty };
  }
  // 锚点在图片坐标系中的位置(相对图片中心,单位为「图片显示尺寸」的比例)
  const ax = clamp((px + (dispW - viewW) / 2) / dispW, 0, 1);
  const ay = clamp((py + (dispH - viewH) / 2) / dispH, 0, 1);
  const ratio = z / z0;
  const nx = ax - (ax - prev.tx) * ratio;
  const ny = ay - (ay - prev.ty) * ratio;
  const p = clampPanView(nx, ny, z, dispW, dispH, viewW, viewH);
  return { zoom: z, tx: tidy(p.tx), ty: tidy(p.ty) };
}

/** 在当前倍率基础上乘一个因子(滚轮/捏合),并保持锚点 */
export function zoomByFactor(
  prev: ZoomView,
  factor: number,
  px: number,
  py: number,
  dispW: number,
  dispH: number,
  viewW: number,
  viewH: number,
): ZoomView {
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
  return zoomAtPoint(prev, prev.zoom * f, px, py, dispW, dispH, viewW, viewH);
}

/** 档位步进:step > 0 取下一个更大档,step < 0 取下一个更小档(已在端点上则停在端点) */
export function nextStop(zoom: number, step: number): number {
  const z = clampZoom(zoom);
  const eps = 1e-4;
  if (step > 0) {
    for (const s of ZOOM_STOPS) if (s > z + eps) return s;
    return MAX_ZOOM;
  }
  for (let i = ZOOM_STOPS.length - 1; i >= 0; i -= 1) {
    const s = ZOOM_STOPS[i]!;
    if (s < z - eps) return s;
  }
  return MIN_ZOOM;
}

/** 档位步进并保持锚点(默认锚点 = 视口中心,即纯缩放) */
export function zoomToStop(
  prev: ZoomView,
  step: number,
  dispW: number,
  dispH: number,
  viewW: number,
  viewH: number,
): ZoomView {
  return zoomAtPoint(prev, nextStop(prev.zoom, step), 0, 0, dispW, dispH, viewW, viewH);
}

/**
 * 把「期望的屏幕位移(px)」换算成 view 里的平移增量 t。
 *
 * ⚠️ 关键单位关系(实测锁定,见 `panLimit` 注释):
 * `translate(tx·100%, …)` 的百分比基准是图片**未缩放**尺寸 S,不是缩放后的 z·S,
 * 因此图片移动 1 个 t 单位 = 屏幕移动 **S** 像素(与 zoom 无关)。
 * 于是「屏幕移动 px 像素」对应的增量是 `px / S` —— **不要**再除以 zoom
 * (那是「以 z·S 为基准」的错误假设,会让键盘平移随放大而变慢)。
 */
export function panDeltaFor(px: number, dispSize: number): number {
  if (!Number.isFinite(px) || !Number.isFinite(dispSize) || dispSize <= 0) return 0;
  return px / dispSize;
}

/** 缩放百分比文案(工具栏显示用) */
export function zoomLabel(zoom: number): string {
  return `${Math.round(clampZoom(zoom) * 100)}%`;
}
