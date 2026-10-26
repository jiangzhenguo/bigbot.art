/**
 * 主进程画布落点 — Agent 新建节点时避开重叠,并限制在已有内容附近。
 *
 * 渲染层自己的「+」/拖入走 CanvasPage.findFreeSpot(实测高度)。
 * Agent 路径(create_node / fetch_image / frames.extract / storyboard.materialize)
 * 以前用 `80 + n*60` 或 `行号 * 186`,会叠在一起,或被模型传入的超大坐标甩到很远。
 *
 * 卡片高度:优先用快照里的 `height`(渲染层实测回写);没有时按 kind 与媒体宽高比估算。
 * 估算与实测取较大值,避免空卡片先测得很矮、出图后变高再盖住邻居。
 */

/** 节点之间留下的空隙(px) */
export const PLACE_GAP = 24;
/** 空画布第一张节点的落点 */
export const PLACE_ORIGIN = { x: 80, y: 80 };
/** 模型传入的绝对坐标,最多偏离现有内容包围盒这么远 */
export const PLACE_CLAMP_MARGIN = 800;
/** 默认锚点对齐的网格 */
export const PLACE_GRID = 20;
/** 从首选锚点向外找空位的最远距离;再远就改放到内容正下方,避免飞出画布 */
const SEARCH_LIMIT = 960;
const SPIRAL_RINGS = 12;
const SPIRAL_STEP = 48;
/** 内容已经铺得很宽时,下一张改放到包围盒下方,而不是继续向右拉长 */
const ROW_WRAP = 1400;

const HEADER = 36;
const BODY_PAD = 20;
const META = 32;
const CHROME = HEADER + BODY_PAD + META;

const MEDIA_KINDS = new Set([
  'asset',
  'image-gen',
  'image-edit',
  'image-upscale',
  'image-crop',
  'image-stitch',
  'image-split',
  'frame-grab',
  'shot',
  'video-upscale',
]);

export interface Occupant {
  id: string;
  kind: string;
  x: number;
  y: number;
  /** 卡片宽;缺省按 kind */
  width?: number;
  /** 已落盘的卡片高(实测或上一次估算) */
  height?: number;
  data?: unknown;
  /** 媒体像素,用来估算卡片高(asset 取资产库,其余取 data.width/height) */
  mediaWidth?: number;
  mediaHeight?: number;
}

export interface PlaceRequest {
  kind: string;
  width?: number;
  height?: number;
  data?: unknown;
  mediaWidth?: number;
  mediaHeight?: number;
  /** 绝对坐标建议;省略则自动选锚点 */
  x?: number;
  y?: number;
  /** 贴着某个已有节点;有它时忽略 x/y */
  place?: { relativeTo?: string; dir?: 'right' | 'below' };
  /** 本轮用户选中的节点:没有 place / 坐标时放在它右侧 */
  selectedNodeId?: string;
}

export interface PlaceResult {
  x: number;
  y: number;
  width: number;
  height: number;
  /** place.relativeTo 在画布上不存在,已退回自动锚点 */
  unresolvedRelative?: boolean;
}

export interface BatchCell {
  key: string;
  kind: string;
  width?: number;
  height?: number;
  /** 列号,同一批里从左到右 */
  col: number;
  /** 批内行号(0 起),不是分镜表的原始行号 */
  row: number;
  data?: unknown;
  mediaWidth?: number;
  mediaHeight?: number;
}

export interface PlacedCell {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlaceBatchOptions {
  /** 整块的首选左上角(通常是分镜表右侧) */
  anchor?: { x: number; y: number };
  /** 该表已经铺出的节点;有则整块接在它们下方 */
  continueFrom?: Occupant[];
  /** 与 continueFrom 合用:块的左边缘。缺省取 continueFrom 包围盒左缘 */
  originX?: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function positive(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function defaultCardWidth(kind: string): number {
  switch (kind) {
    case 'storyboard':
      return 318;
    case 'shot':
      return 250;
    case 'image-gen':
    case 'image-edit':
      return 232;
    default:
      return 236;
  }
}

/** 媒体宽高比(宽/高)。读不到时按 16:9。 */
export function mediaAspectRatio(input: {
  data?: unknown;
  mediaWidth?: number;
  mediaHeight?: number;
}): number {
  const mw = positive(input.mediaWidth);
  const mh = positive(input.mediaHeight);
  if (mw && mh) return mw / mh;
  const d = (input.data ?? {}) as Record<string, unknown>;
  const w = positive(d.width);
  const h = positive(d.height);
  if (w && h) return w / h;
  const aspect = String(d.aspect ?? '');
  const m = aspect.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const aw = Number(m[1]);
    const ah = Number(m[2]);
    if (aw > 0 && ah > 0) return aw / ah;
  }
  return 16 / 9;
}

function aspectCardHeight(kind: string, width: number, ratio: number): number {
  if (kind === 'storyboard') return 280;
  if (kind === 'document') return 220;
  if (kind === 'timeline') return 200;
  if (kind === 'audio-ref') return 160;
  if (!MEDIA_KINDS.has(kind)) return 200;
  const thumb = Math.min(Math.max(width / ratio, 72), width * 2);
  return CHROME + thumb;
}

/** 卡片宽高。height 是已记录的卡片高;与按宽高比估算取较大值。 */
export function estimateNodeSize(input: {
  kind: string;
  width?: number;
  height?: number;
  data?: unknown;
  mediaWidth?: number;
  mediaHeight?: number;
}): { width: number; height: number } {
  const width = positive(input.width) ?? defaultCardWidth(input.kind);
  const fromAspect = aspectCardHeight(input.kind, width, mediaAspectRatio(input));
  const recorded = positive(input.height);
  const height = recorded ? Math.max(recorded, fromAspect) : fromAspect;
  return { width, height: Math.round(height) };
}

export function rectOf(n: Occupant): Rect {
  const size = estimateNodeSize(n);
  return { x: n.x, y: n.y, w: size.width, h: size.height };
}

export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return !(
    a.x + a.w + gap <= b.x ||
    b.x + b.w + gap <= a.x ||
    a.y + a.h + gap <= b.y ||
    b.y + b.h + gap <= a.y
  );
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boundsOf(rects: Rect[]): Bounds | undefined {
  if (rects.length === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { minX, minY, maxX, maxY };
}

function snapNear(n: number): number {
  return Math.round(n / PLACE_GRID) * PLACE_GRID;
}

/** 向远离内容的方向取整,避免把锚点吸进已有节点 */
function snapAway(n: number, towardPositive: boolean): number {
  const g = PLACE_GRID;
  return towardPositive ? Math.ceil(n / g) * g : Math.floor(n / g) * g;
}

function hits(rects: Rect[], x: number, y: number, w: number, h: number): boolean {
  const mine: Rect = { x, y, w, h };
  return rects.some((r) => rectsOverlap(mine, r, PLACE_GAP));
}

/**
 * 锚点被挡住时:先向右、再向下,然后小范围螺旋,最后贴着整片内容的下沿。
 * 搜索半径有上限,不会把节点甩到离内容很远的地方。
 */
export function resolveRect(existing: Occupant[], x: number, y: number, w: number, h: number): { x: number; y: number } {
  const rects = existing.map(rectOf);
  if (!hits(rects, x, y, w, h)) return { x, y };
  const stride = Math.max(PLACE_GRID, Math.min(w + PLACE_GAP, 280));
  for (let dx = stride; dx <= SEARCH_LIMIT; dx += stride) {
    if (!hits(rects, x + dx, y, w, h)) return { x: x + dx, y };
  }
  for (let dy = stride; dy <= SEARCH_LIMIT; dy += stride) {
    if (!hits(rects, x, y + dy, w, h)) return { x, y: y + dy };
  }
  // 螺旋只在内容右下方附近找。钻到包围盒上方或左外侧时,节点会离开用户正在看的那一片,
  // 那种情况交给下面「贴着整片内容下沿」的兜底。
  const boxForSpiral = boundsOf(rects);
  const minX = (boxForSpiral?.minX ?? x) - PLACE_GAP;
  const minY = (boxForSpiral?.minY ?? y) - PLACE_GAP;
  for (let ring = 1; ring <= SPIRAL_RINGS; ring++) {
    const steps = ring * 8;
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const nx = Math.round(x + Math.cos(a) * ring * SPIRAL_STEP);
      const ny = Math.round(y + Math.sin(a) * ring * SPIRAL_STEP);
      if (nx < minX || ny < minY) continue;
      if (Math.hypot(nx - x, ny - y) > SEARCH_LIMIT) continue;
      if (!hits(rects, nx, ny, w, h)) return { x: nx, y: ny };
    }
  }
  const box = boundsOf(rects);
  const fx = box ? box.minX : PLACE_ORIGIN.x;
  const baseY = (box ? box.maxY : y) + PLACE_GAP;
  for (let i = 0; i < 8; i++) {
    const ny = baseY + i * (h + PLACE_GAP);
    if (!hits(rects, fx, ny, w, h)) return { x: fx, y: ny };
  }
  return { x: fx, y: baseY + h + PLACE_GAP };
}

function clampToContent(existing: Occupant[], x: number, y: number): { x: number; y: number } {
  const box = boundsOf(existing.map(rectOf));
  if (!box) {
    return {
      x: Math.min(Math.max(x, PLACE_ORIGIN.x - PLACE_CLAMP_MARGIN), PLACE_ORIGIN.x + PLACE_CLAMP_MARGIN),
      y: Math.min(Math.max(y, PLACE_ORIGIN.y - PLACE_CLAMP_MARGIN), PLACE_ORIGIN.y + PLACE_CLAMP_MARGIN),
    };
  }
  return {
    x: Math.min(Math.max(x, box.minX - PLACE_CLAMP_MARGIN), box.maxX + PLACE_CLAMP_MARGIN),
    y: Math.min(Math.max(y, box.minY - PLACE_CLAMP_MARGIN), box.maxY + PLACE_CLAMP_MARGIN),
  };
}

function defaultAnchor(existing: Occupant[], w: number, h: number): { x: number; y: number } {
  void w;
  void h;
  if (existing.length === 0) return { ...PLACE_ORIGIN };
  const rects = existing.map(rectOf);
  const box = boundsOf(rects)!;
  // 只看最下面一行。若用整张包围盒的宽度,第一行铺满之后会永远往下单列堆,越堆越远。
  const row = rects.filter((r) => r.y + r.h >= box.maxY - 8);
  const band = row.length > 0 ? row : rects;
  const rowMinY = Math.min(...band.map((r) => r.y));
  const rowMaxX = Math.max(...band.map((r) => r.x + r.w));
  if (rowMaxX - box.minX < ROW_WRAP) {
    return { x: snapAway(rowMaxX + PLACE_GAP, true), y: snapNear(rowMinY) };
  }
  return { x: snapNear(box.minX), y: snapAway(box.maxY + PLACE_GAP, true) };
}

function chooseAnchor(
  existing: Occupant[],
  req: PlaceRequest,
  size: { width: number; height: number },
): { x: number; y: number; unresolvedRelative?: boolean } {
  const rel = req.place?.relativeTo?.trim();
  if (rel) {
    const target = existing.find((n) => n.id === rel);
    if (target) {
      const box = rectOf(target);
      const dir = req.place?.dir === 'below' ? 'below' : 'right';
      if (dir === 'below') return { x: box.x, y: snapAway(box.y + box.h + PLACE_GAP, true) };
      return { x: snapAway(box.x + box.w + PLACE_GAP, true), y: box.y };
    }
    // 参照节点不存在:继续走后面的锚点,并告诉调用方
  }
  if (req.x != null || req.y != null) {
    const box = boundsOf(existing.map(rectOf));
    const fallback = box ? { x: box.minX, y: box.minY } : { ...PLACE_ORIGIN };
    const hinted = clampToContent(existing, req.x ?? fallback.x, req.y ?? fallback.y);
    return { ...hinted, unresolvedRelative: !!rel };
  }
  if (req.selectedNodeId) {
    const sel = existing.find((n) => n.id === req.selectedNodeId);
    if (sel) {
      const box = rectOf(sel);
      return {
        x: snapAway(box.x + box.w + PLACE_GAP, true),
        y: box.y,
        unresolvedRelative: !!rel,
      };
    }
  }
  const anchor = defaultAnchor(existing, size.width, size.height);
  return { ...anchor, unresolvedRelative: !!rel };
}

/** 为单个新节点选一个不与 existing 重叠的落点。不修改 existing。 */
export function placeNode(existing: Occupant[], req: PlaceRequest): PlaceResult {
  const size = estimateNodeSize(req);
  const anchor = chooseAnchor(existing, req, size);
  const spot = resolveRect(existing, anchor.x, anchor.y, size.width, size.height);
  return {
    x: spot.x,
    y: spot.y,
    width: size.width,
    height: size.height,
    ...(anchor.unresolvedRelative ? { unresolvedRelative: true } : {}),
  };
}

interface SizedCell extends BatchCell {
  w: number;
  h: number;
}

/** 批内相对坐标(左上为 0,0),行距按该行最高的卡片。 */
export function layoutBatch(cells: BatchCell[]): {
  items: PlacedCell[];
  blockWidth: number;
  blockHeight: number;
} {
  if (cells.length === 0) return { items: [], blockWidth: 0, blockHeight: 0 };
  const sized: SizedCell[] = cells.map((c) => {
    const size = estimateNodeSize(c);
    return { ...c, w: size.width, h: size.height };
  });
  const cols = [...new Set(sized.map((c) => c.col))].sort((a, b) => a - b);
  const rows = [...new Set(sized.map((c) => c.row))].sort((a, b) => a - b);
  const colX = new Map<number, number>();
  let xCursor = 0;
  for (const col of cols) {
    colX.set(col, xCursor);
    const w = Math.max(...sized.filter((s) => s.col === col).map((s) => s.w));
    xCursor += w + PLACE_GAP;
  }
  const blockWidth = Math.max(0, xCursor - PLACE_GAP);
  const rowY = new Map<number, number>();
  let yCursor = 0;
  for (const row of rows) {
    rowY.set(row, yCursor);
    const h = Math.max(...sized.filter((s) => s.row === row).map((s) => s.h));
    yCursor += h + PLACE_GAP;
  }
  const blockHeight = Math.max(0, yCursor - PLACE_GAP);
  const items = sized.map((s) => ({
    key: s.key,
    x: colX.get(s.col) ?? 0,
    y: rowY.get(s.row) ?? 0,
    width: s.w,
    height: s.h,
  }));
  return { items, blockWidth, blockHeight };
}

/**
 * 把一整批节点当成一个矩形找空位,再按批内行列填进去。
 * 追加(continueFrom)时接在已有节点下方,而不是用分镜表原始行号把 y 推得很远。
 */
export function placeBatch(existing: Occupant[], cells: BatchCell[], opts: PlaceBatchOptions = {}): PlacedCell[] {
  const layout = layoutBatch(cells);
  if (layout.items.length === 0) return [];
  let originX: number;
  let originY: number;
  if (opts.continueFrom && opts.continueFrom.length > 0) {
    const box = boundsOf(opts.continueFrom.map(rectOf));
    originX = opts.originX ?? box?.minX ?? PLACE_ORIGIN.x;
    originY = snapAway((box?.maxY ?? PLACE_ORIGIN.y) + PLACE_GAP, true);
  } else if (opts.anchor) {
    // 调用方已经算好「贴着参照物外侧」的点,再取整会把间隙吃掉,重新判成重叠
    originX = opts.anchor.x;
    originY = opts.anchor.y;
  } else {
    const anchor = defaultAnchor(existing, layout.blockWidth, layout.blockHeight);
    originX = anchor.x;
    originY = anchor.y;
  }
  const free = resolveRect(existing, originX, originY, layout.blockWidth, layout.blockHeight);
  return layout.items.map((it) => ({
    ...it,
    x: free.x + it.x,
    y: free.y + it.y,
  }));
}
