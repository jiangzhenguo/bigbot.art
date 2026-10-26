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
import { storyboardLinkOf } from '@bigbotart/shared';

/** 节点之间留下的空隙(px) */
export const PLACE_GAP = 24;
/** 空画布第一张节点的落点 */
export const PLACE_ORIGIN = { x: 80, y: 80 };
/** 模型传入的绝对坐标,最多偏离现有内容包围盒这么远 */
export const PLACE_CLAMP_MARGIN = 800;
/**
 * 一次落点相对「调用开始时内容包围盒」的绝对上限,四个方向一样。
 * 内容比这个上限更宽/更高时,允许停在现有边缘,但余量不能再把包围盒往外推。
 * 锚点取对侧边缘:往右长时左边不动,往左漂时右边不动,所以重复传入超大负坐标也不会按 800px 一直走。
 */
export const PLACE_ABS_CAP = 4000;
/** 默认锚点对齐的网格 */
export const PLACE_GRID = 20;
/** 从首选锚点向外找空位的最远距离;再远就改放到内容正下方,避免飞出画布 */
const SEARCH_LIMIT = 960;
const SPIRAL_RINGS = 12;
const SPIRAL_STEP = 48;
/** 内容已经铺得很宽时,下一张改放到包围盒下方,而不是继续向右拉长 */
const ROW_WRAP = 1400;
/** 整理时视为同一行的顶边容差。折行后的行距远大于它,同一行顶边则对齐。 */
const ROW_BAND = 64;

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
  /** 节点间距;缺省 PLACE_GAP */
  gap?: number;
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

interface PlaceCap {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * 本次调用的落点不能走出的范围。以调用开始时的内容包围盒为参照,四个方向最多再走 PLACE_ABS_CAP。
 * 内容已经更宽/更高时停在现有边缘,避免反复超大坐标把画布越推越远。
 */
function limitsOf(existing: Occupant[]): PlaceCap {
  const box = boundsOf(existing.map(rectOf));
  if (!box) {
    return {
      minX: PLACE_ORIGIN.x - PLACE_ABS_CAP,
      minY: PLACE_ORIGIN.y - PLACE_ABS_CAP,
      maxX: PLACE_ORIGIN.x + PLACE_ABS_CAP,
      maxY: PLACE_ORIGIN.y + PLACE_ABS_CAP,
    };
  }
  const capLeft = box.maxX - PLACE_ABS_CAP;
  const capRight = box.minX + PLACE_ABS_CAP;
  const capTop = box.maxY - PLACE_ABS_CAP;
  const capBottom = box.minY + PLACE_ABS_CAP;
  return {
    minX: box.minX < capLeft ? box.minX : capLeft,
    minY: box.minY < capTop ? box.minY : capTop,
    maxX: box.maxX > capRight ? box.maxX : capRight,
    maxY: box.maxY > capBottom ? box.maxY : capBottom,
  };
}

function fitsCap(cap: PlaceCap, x: number, y: number, w: number, h: number): boolean {
  return x >= cap.minX - 0.5 && y >= cap.minY - 0.5 && x + w <= cap.maxX + 0.5 && y + h <= cap.maxY + 0.5;
}

function hits(rects: Rect[], x: number, y: number, w: number, h: number, gap = PLACE_GAP): boolean {
  const mine: Rect = { x, y, w, h };
  return rects.some((r) => rectsOverlap(mine, r, gap));
}

/**
 * 锚点被挡住时:先向右、再向下,然后小范围螺旋,最后贴着整片内容的下沿。
 * 搜索半径有上限,并且不会越过本次内容的绝对上限。
 */
export function resolveRect(
  existing: Occupant[],
  x: number,
  y: number,
  w: number,
  h: number,
  gap = PLACE_GAP,
): { x: number; y: number } {
  const rects = existing.map(rectOf);
  const cap = limitsOf(existing);
  const free = (px: number, py: number) => fitsCap(cap, px, py, w, h) && !hits(rects, px, py, w, h, gap);
  const ax = Math.min(Math.max(x, cap.minX), Math.max(cap.minX, cap.maxX - w));
  const ay = Math.min(Math.max(y, cap.minY), Math.max(cap.minY, cap.maxY - h));
  if (free(ax, ay)) return { x: ax, y: ay };
  const stride = Math.max(PLACE_GRID, Math.min(w + gap, 280));
  for (let dx = stride; dx <= SEARCH_LIMIT; dx += stride) {
    if (free(ax + dx, ay)) return { x: ax + dx, y: ay };
  }
  for (let dy = stride; dy <= SEARCH_LIMIT; dy += stride) {
    if (free(ax, ay + dy)) return { x: ax, y: ay + dy };
  }
  // 螺旋只在内容右下方、且仍在绝对上限内找。钻到包围盒上方或左外侧会离开用户正在看的那一片。
  const boxForSpiral = boundsOf(rects);
  const minX = (boxForSpiral?.minX ?? ax) - gap;
  const minY = (boxForSpiral?.minY ?? ay) - gap;
  for (let ring = 1; ring <= SPIRAL_RINGS; ring++) {
    const steps = ring * 8;
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const nx = Math.round(ax + Math.cos(a) * ring * SPIRAL_STEP);
      const ny = Math.round(ay + Math.sin(a) * ring * SPIRAL_STEP);
      if (nx < minX || ny < minY) continue;
      if (Math.hypot(nx - ax, ny - ay) > SEARCH_LIMIT) continue;
      if (free(nx, ny)) return { x: nx, y: ny };
    }
  }
  const box = boundsOf(rects);
  const fx = Math.min(box ? box.minX : PLACE_ORIGIN.x, Math.max(cap.minX, cap.maxX - w));
  const baseY = (box ? box.maxY : ay) + gap;
  for (let i = 0; i < 8; i++) {
    const ny = baseY + i * (h + gap);
    if (free(fx, ny)) return { x: fx, y: ny };
  }
  // 上限里实在没有空位:贴着内容下沿放一行,只在这一步允许略微超出,避免叠回去
  return { x: fx, y: baseY };
}

function clampToContent(existing: Occupant[], x: number, y: number, w: number, h: number): { x: number; y: number } {
  const cap = limitsOf(existing);
  const box = boundsOf(existing.map(rectOf));
  const nearLeft = (box?.minX ?? PLACE_ORIGIN.x) - PLACE_CLAMP_MARGIN;
  const nearTop = (box?.minY ?? PLACE_ORIGIN.y) - PLACE_CLAMP_MARGIN;
  const nearRight = (box?.maxX ?? PLACE_ORIGIN.x) + PLACE_CLAMP_MARGIN;
  const nearBottom = (box?.maxY ?? PLACE_ORIGIN.y) + PLACE_CLAMP_MARGIN;
  const xLo = Math.max(nearLeft, cap.minX);
  const yLo = Math.max(nearTop, cap.minY);
  const xHi = Math.min(nearRight, cap.maxX - w);
  const yHi = Math.min(nearBottom, cap.maxY - h);
  return {
    x: Math.min(Math.max(x, xLo), Math.max(xLo, xHi)),
    y: Math.min(Math.max(y, yLo), Math.max(yLo, yHi)),
  };
}

function defaultAnchor(existing: Occupant[], w: number, h: number): { x: number; y: number } {
  if (existing.length === 0) return { ...PLACE_ORIGIN };
  const rects = existing.map(rectOf);
  const box = boundsOf(rects)!;
  const cap = limitsOf(existing);
  // 只看最下面一行。若用整张包围盒的宽度,第一行铺满之后会永远往下单列堆,越堆越远。
  const row = rects.filter((r) => r.y + r.h >= box.maxY - 8);
  const band = row.length > 0 ? row : rects;
  const rowMinY = Math.min(...band.map((r) => r.y));
  const rowMaxX = Math.max(...band.map((r) => r.x + r.w));
  const rightX = snapAway(rowMaxX + PLACE_GAP, true);
  if (rowMaxX - box.minX < ROW_WRAP && rightX + w <= cap.maxX + 0.5) {
    return { x: rightX, y: snapNear(rowMinY) };
  }
  const below = snapAway(box.maxY + PLACE_GAP, true);
  return { x: snapNear(box.minX), y: below + h <= cap.maxY + 0.5 ? below : snapNear(box.minY) };
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
    const hinted = clampToContent(existing, req.x ?? fallback.x, req.y ?? fallback.y, size.width, size.height);
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
export function layoutBatch(cells: BatchCell[], gap = PLACE_GAP): {
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
    xCursor += w + gap;
  }
  const blockWidth = Math.max(0, xCursor - gap);
  const rowY = new Map<number, number>();
  let yCursor = 0;
  for (const row of rows) {
    rowY.set(row, yCursor);
    const h = Math.max(...sized.filter((s) => s.row === row).map((s) => s.h));
    yCursor += h + gap;
  }
  const blockHeight = Math.max(0, yCursor - gap);
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
  const gap = opts.gap ?? PLACE_GAP;
  const layout = layoutBatch(cells, gap);
  if (layout.items.length === 0) return [];
  let originX: number;
  let originY: number;
  if (opts.continueFrom && opts.continueFrom.length > 0) {
    const box = boundsOf(opts.continueFrom.map(rectOf));
    originX = opts.originX ?? box?.minX ?? PLACE_ORIGIN.x;
    originY = snapAway((box?.maxY ?? PLACE_ORIGIN.y) + gap, true);
  } else if (opts.anchor) {
    // 调用方已经算好「贴着参照物外侧」的点,再取整会把间隙吃掉,重新判成重叠
    originX = opts.anchor.x;
    originY = opts.anchor.y;
  } else {
    const anchor = defaultAnchor(existing, layout.blockWidth, layout.blockHeight);
    originX = anchor.x;
    originY = anchor.y;
  }
  const free = resolveRect(existing, originX, originY, layout.blockWidth, layout.blockHeight, gap);
  return layout.items.map((it) => ({
    ...it,
    x: free.x + it.x,
    y: free.y + it.y,
  }));
}

export interface MaterializeRow {
  /** 批内行号,从 0 起,不是分镜表原始行号 */
  row: number;
  shotKey: string;
  imageKey?: string;
  mediaWidth?: number;
  mediaHeight?: number;
}

/**
 * 分镜表铺节点的整块落点。storyboard.materialize、storyboard.plan 和检查器「铺节点」共用。
 * 追加时接在 prior 下方;否则放在分镜表右侧。
 */
export function placeMaterializeRows(
  existing: Occupant[],
  storyboard: Occupant,
  rows: MaterializeRow[],
  prior: Occupant[] = [],
  gap = PLACE_GAP,
): PlacedCell[] {
  const cells: BatchCell[] = [];
  for (const row of rows) {
    const media = { mediaWidth: row.mediaWidth, mediaHeight: row.mediaHeight };
    if (row.imageKey) {
      cells.push({ key: row.imageKey, kind: 'image-gen', width: 232, col: 0, row: row.row, ...media });
    }
    cells.push({ key: row.shotKey, kind: 'shot', width: 250, col: 1, row: row.row, ...media });
  }
  const priorShots = prior.filter((n) => n.kind === 'shot');
  const hasNewImage = cells.some((c) => c.col === 0);
  const originX = !prior.length
    ? undefined
    : hasNewImage
      ? Math.min(...prior.map((n) => n.x))
      : Math.min(...(priorShots.length ? priorShots : prior).map((n) => n.x));
  const sbBox = rectOf(storyboard);
  return placeBatch(existing, cells, {
    anchor: { x: sbBox.x + sbBox.w + gap, y: sbBox.y },
    continueFrom: prior.length ? prior : undefined,
    originX,
    gap,
  });
}

export interface TidyEdge {
  source: string;
  target: string;
}

export interface TidyOptions {
  scope?: 'all' | 'selected';
  selectedIds?: string[];
  /** 间距,钳在 8–80;缺省 PLACE_GAP */
  gap?: number;
  /** 用户建的组:成员留在同一块里,从左到右保持原有顺序 */
  groups?: Array<{ members: string[] }>;
  /** 本次节点列表里没有、但边的 source 仍是分镜表(选中整理时表不在移动集合里) */
  externalStoryboardIds?: string[];
}

export interface TidyResult {
  moves: Array<{ id: string; x: number; y: number }>;
  bbox: { x: number; y: number; w: number; h: number };
}

interface FlowBlock {
  local: Map<string, { x: number; y: number }>;
  w: number;
  h: number;
  sortX: number;
  sortY: number;
}

function tidyGap(gap?: number): number {
  if (gap == null || !Number.isFinite(gap)) return PLACE_GAP;
  return Math.min(80, Math.max(8, Math.round(gap)));
}

function contentBBox(nodes: Array<Occupant & { x: number; y: number }>): { x: number; y: number; w: number; h: number } {
  if (nodes.length === 0) return { x: PLACE_ORIGIN.x, y: PLACE_ORIGIN.y, w: 0, h: 0 };
  const rects = nodes.map(rectOf);
  const box = boundsOf(rects)!;
  return { x: box.minX, y: box.minY, w: box.maxX - box.minX, h: box.maxY - box.minY };
}

function leafBlock(n: Occupant): FlowBlock {
  const size = estimateNodeSize(n);
  return {
    local: new Map([[n.id, { x: 0, y: 0 }]]),
    w: size.width,
    h: size.height,
    sortX: n.x,
    sortY: n.y,
  };
}

function rowsBlock(
  members: Occupant[],
  gap: number,
  rowOf: (n: Occupant) => number,
  withStoryboard?: Occupant,
): FlowBlock {
  const sorted = [...members].sort((a, b) => {
    const ra = rowOf(a);
    const rb = rowOf(b);
    if (ra !== rb) return ra - rb;
    if (a.x !== b.x) return a.x - b.x;
    if (a.kind !== b.kind) return a.kind === 'shot' ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });
  const rowOrder: number[] = [];
  const byRow = new Map<number, Occupant[]>();
  for (const n of sorted) {
    const row = rowOf(n);
    if (!byRow.has(row)) rowOrder.push(row);
    const list = byRow.get(row) ?? [];
    list.push(n);
    byRow.set(row, list);
  }
  const cells: BatchCell[] = [];
  rowOrder.forEach((rowNo, row) => {
    const list = byRow.get(rowNo) ?? [];
    const imgs = list.filter((n) => n.kind !== 'shot');
    const shots = list.filter((n) => n.kind === 'shot');
    const ordered = imgs.length + shots.length > 0 ? [...imgs, ...shots] : list;
    ordered.forEach((n, col) => {
      cells.push({
        key: n.id,
        kind: n.kind,
        width: n.width,
        height: n.height,
        col,
        row,
        data: n.data,
        mediaWidth: n.mediaWidth,
        mediaHeight: n.mediaHeight,
      });
    });
  });
  const laid = layoutBatch(cells, gap);
  const local = new Map<string, { x: number; y: number }>();
  let originX = 0;
  let maxR = 0;
  let maxB = 0;
  if (withStoryboard) {
    const sb = estimateNodeSize(withStoryboard);
    local.set(withStoryboard.id, { x: 0, y: 0 });
    originX = sb.width + gap;
    maxR = sb.width;
    maxB = sb.height;
  }
  for (const it of laid.items) {
    const x = originX + it.x;
    local.set(it.key, { x, y: it.y });
    maxR = Math.max(maxR, x + it.width);
    maxB = Math.max(maxB, it.y + it.height);
  }
  const xs = withStoryboard ? [withStoryboard.x, ...members.map((n) => n.x)] : members.map((n) => n.x);
  const ys = withStoryboard ? [withStoryboard.y, ...members.map((n) => n.y)] : members.map((n) => n.y);
  return {
    local,
    w: maxR,
    h: maxB,
    sortX: Math.min(...xs),
    sortY: Math.min(...ys),
  };
}

function readingOrder<T>(items: T[], yOf: (t: T) => number, xOf: (t: T) => number, idOf: (t: T) => string): T[] {
  const sorted = [...items].sort(
    (a, b) => yOf(a) - yOf(b) || xOf(a) - xOf(b) || (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0),
  );
  const bands: T[][] = [];
  for (const item of sorted) {
    const band = bands[bands.length - 1];
    if (!band || yOf(item) - yOf(band[0]!) > ROW_BAND) bands.push([item]);
    else band.push(item);
  }
  const out: T[] = [];
  for (const band of bands) {
    band.sort((a, b) => xOf(a) - xOf(b) || yOf(a) - yOf(b) || (idOf(a) < idOf(b) ? -1 : 1));
    out.push(...band);
  }
  return out;
}

function blockKey(block: FlowBlock): string {
  let min = '';
  for (const id of block.local.keys()) {
    if (!min || id < min) min = id;
  }
  return min;
}

function flowBlock(members: Occupant[], gap: number): FlowBlock {
  const sorted = readingOrder(members, (n) => n.y, (n) => n.x, (n) => n.id);
  const local = new Map<string, { x: number; y: number }>();
  let x = 0;
  let y = 0;
  let rowH = 0;
  let maxW = 0;
  for (const n of sorted) {
    const size = estimateNodeSize(n);
    if (x > 0 && x + size.width > ROW_WRAP) {
      y += rowH + gap;
      x = 0;
      rowH = 0;
    }
    local.set(n.id, { x, y });
    x += size.width + gap;
    rowH = Math.max(rowH, size.height);
    maxW = Math.max(maxW, x - gap);
  }
  return {
    local,
    w: maxW,
    h: y + rowH,
    sortX: Math.min(...sorted.map((n) => n.x)),
    sortY: Math.min(...sorted.map((n) => n.y)),
  };
}

function packBlocks(blocks: FlowBlock[], gap: number): Map<string, { x: number; y: number }> {
  const ordered = readingOrder(blocks, (b) => b.sortY, (b) => b.sortX, blockKey);
  const out = new Map<string, { x: number; y: number }>();
  let x = PLACE_ORIGIN.x;
  let y = PLACE_ORIGIN.y;
  let rowH = 0;
  const wrapAt = PLACE_ORIGIN.x + Math.min(ROW_WRAP, PLACE_ABS_CAP);
  for (const block of ordered) {
    if (x > PLACE_ORIGIN.x && x + block.w > wrapAt) {
      y += rowH + gap;
      x = PLACE_ORIGIN.x;
      rowH = 0;
    }
    for (const [id, local] of block.local) {
      out.set(id, { x: x + local.x, y: y + local.y });
    }
    x += block.w + gap;
    rowH = Math.max(rowH, block.h);
  }
  return out;
}

function rowBands(nodes: Occupant[], explicit: Map<string, number>): Map<string, number> {
  const out = new Map(explicit);
  const missing = nodes.filter((n) => !out.has(n.id));
  if (missing.length === 0) return out;
  if (out.size === 0) {
    const ordered = readingOrder(missing, (n) => n.y, (n) => n.x, (n) => n.id);
    let band = 0;
    let bandY = ordered[0]?.y ?? 0;
    for (const n of ordered) {
      if (n.y - bandY > ROW_BAND) {
        band += 1;
        bandY = n.y;
      }
      out.set(n.id, band);
    }
    return out;
  }
  let next = Math.max(...out.values()) + 1;
  const ordered = [...missing].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1));
  for (const n of ordered) out.set(n.id, next++);
  return out;
}

function blocksOf(nodes: Occupant[], opts: TidyOptions, gap: number, edges: TidyEdge[]): FlowBlock[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const storyboardIds = new Set(opts.externalStoryboardIds ?? []);
  for (const n of nodes) if (n.kind === 'storyboard') storyboardIds.add(n.id);
  const edgeParent = new Map<string, string>();
  for (const e of edges) {
    if (!storyboardIds.has(e.source) || edgeParent.has(e.target)) continue;
    edgeParent.set(e.target, e.source);
  }
  const parentOf = (n: Occupant): { nodeId: string; row?: number } | undefined => {
    const link = storyboardLinkOf(n.data);
    if (link) return link;
    const via = edgeParent.get(n.id);
    return via ? { nodeId: via } : undefined;
  };
  const consumed = new Set<string>();
  const blocks: FlowBlock[] = [];
  const pushRows = (kids: Occupant[], withStoryboard?: Occupant) => {
    const explicit = new Map<string, number>();
    for (const k of kids) {
      const row = parentOf(k)?.row;
      if (typeof row === 'number') explicit.set(k.id, row);
    }
    const rows = rowBands(kids, explicit);
    blocks.push(rowsBlock(kids, gap, (n) => rows.get(n.id) ?? 0, withStoryboard));
    if (withStoryboard) consumed.add(withStoryboard.id);
    for (const k of kids) consumed.add(k.id);
  };
  for (const n of nodes) {
    if (n.kind !== 'storyboard' || consumed.has(n.id)) continue;
    const kids = nodes.filter((k) => parentOf(k)?.nodeId === n.id);
    pushRows(kids, n);
  }
  const orphans = new Map<string, Occupant[]>();
  for (const n of nodes) {
    if (consumed.has(n.id)) continue;
    const parent = parentOf(n)?.nodeId;
    if (!parent || byId.has(parent)) continue;
    const list = orphans.get(parent) ?? [];
    list.push(n);
    orphans.set(parent, list);
  }
  for (const list of orphans.values()) pushRows(list);
  for (const group of opts.groups ?? []) {
    const members = group.members.map((id) => byId.get(id)).filter((n): n is Occupant => !!n && !consumed.has(n.id));
    if (members.length < 2) continue;
    blocks.push(flowBlock(members, gap));
    for (const n of members) consumed.add(n.id);
  }
  for (const n of nodes) {
    if (!consumed.has(n.id)) blocks.push(leafBlock(n));
  }
  return blocks;
}

function separation(a: Rect, b: Rect): number {
  const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0);
  const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h), 0);
  return Math.hypot(dx, dy);
}

/** 选中整理只在原选区附近找空位,远处的离群节点不当锚点。 */
function resolveNear(fixed: Occupant[], x: number, y: number, w: number, h: number, gap: number): { x: number; y: number } {
  const anchor: Rect = { x, y, w: Math.max(w, 1), h: Math.max(h, 1) };
  const local = fixed.filter((n) => separation(rectOf(n), anchor) <= PLACE_ABS_CAP);
  const spot = resolveRect(local, x, y, w, h, gap);
  if (Math.hypot(spot.x - x, spot.y - y) > PLACE_ABS_CAP) return { x, y };
  return spot;
}

/**
 * 只重排坐标。分镜表和它铺出的镜头留在同一块(看 storyboardId、promptFrom 或来自分镜表的边),
 * 用户分组留在同一块,其余按「先上后下、行内从左到右」折行。
 * 这个顺序和折行结果一致,所以对结果再整理不会换位。
 * scope=selected 时只移动选中节点,落点靠近原来的选区,不贴到远处的离群节点旁边。
 */
export function tidyNodes(nodes: Occupant[], edges: TidyEdge[] = [], opts: TidyOptions = {}): TidyResult {
  const gap = tidyGap(opts.gap);
  const scope = opts.scope === 'selected' ? 'selected' : 'all';
  if (scope === 'selected') {
    const selected = new Set(opts.selectedIds ?? []);
    const moving = nodes.filter((n) => selected.has(n.id));
    const fixed = nodes.filter((n) => !selected.has(n.id));
    if (moving.length === 0) return { moves: [], bbox: contentBBox(nodes) };
    const externalStoryboardIds = nodes.filter((n) => n.kind === 'storyboard').map((n) => n.id);
    const inner = tidyNodes(moving, edges, { scope: 'all', gap, groups: opts.groups, externalStoryboardIds });
    const sel = boundsOf(moving.map(rectOf));
    const anchor = sel ? { x: sel.minX, y: sel.minY } : { ...PLACE_ORIGIN };
    const spot = fixed.length
      ? resolveNear(fixed, anchor.x, anchor.y, Math.max(inner.bbox.w, 1), Math.max(inner.bbox.h, 1), gap)
      : anchor;
    const dx = spot.x - inner.bbox.x;
    const dy = spot.y - inner.bbox.y;
    const moves = inner.moves.map((m) => ({ id: m.id, x: m.x + dx, y: m.y + dy }));
    const moved = new Map(moves.map((m) => [m.id, m]));
    const next = nodes.map((n) => {
      const m = moved.get(n.id);
      return m ? { ...n, x: m.x, y: m.y } : n;
    });
    return { moves, bbox: contentBBox(next) };
  }
  const placed = packBlocks(blocksOf(nodes, opts, gap, edges), gap);
  const moves = nodes.map((n) => {
    const p = placed.get(n.id) ?? { x: n.x, y: n.y };
    return { id: n.id, x: p.x, y: p.y };
  });
  const next = nodes.map((n) => {
    const p = placed.get(n.id);
    return p ? { ...n, x: p.x, y: p.y } : n;
  });
  return { moves, bbox: contentBBox(next) };
}
