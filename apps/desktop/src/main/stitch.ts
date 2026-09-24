/**
 * StitchTool — 图片拼接 / 拆分(ffmpeg):image-stitch / image-split 节点的执行层
 *
 * 与 frames.ts 的取帧/裁切同构:纯 ffmpeg、不推理、全局串行链防并发抢 CPU/IO,
 * 产物落 ${OUTPUTS_DIR}/stitches|splits/ 下(bba-output 协议可读),文件名带毫秒时间戳互不覆盖。
 *
 * 拼接:先 ffprobe 量出各图尺寸 → planStitch 纯函数算出画布与每片落位(缩放只缩不放,
 * 对齐轴取最小值保画质)→ color 底版 + 逐张 overlay,行列/网格统一一条 filtergraph。
 * 拆分:planSplit 纯函数算每片 crop 矩形(末行/末列吃余数)→ 单条 ffmpeg split+crop 多输出。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { OUTPUTS_DIR, ffmpegReadRoots, isUnderRoot } from './assets';

const STITCH_DIR = join(OUTPUTS_DIR, 'stitches');
const SPLITS_DIR = join(OUTPUTS_DIR, 'splits');

/** 拼接/拆分片数上限(防呆:避免误填 999 把磁盘打爆) */
export const MAX_PIECES = 16;

/** 全局串行链(与 frames.ts 同款):拼接/拆分都是 ffmpeg,逐个执行避免抢 CPU/IO */
let stitchChain: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = stitchChain.then(job);
  stitchChain = run.catch(() => undefined);
  return run;
}

/* ════════════════ 尺寸探测(ffprobe) ════════════════ */

export interface ImageSize {
  w: number;
  h: number;
}

function probeImage(path: string): Promise<{ ok: boolean; size?: ImageSize; error?: string }> {
  return new Promise((resolveP) => {
    const args = ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', path];
    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errAcc = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (errAcc += d.toString()));
    child.on('close', (code) => {
      const m = /^(\d+)x(\d+)/.exec(out.trim());
      if (code === 0 && m) {
        resolveP({ ok: true, size: { w: Number(m[1]), h: Number(m[2]) } });
      } else {
        const tail = errAcc.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 160);
        resolveP({ ok: false, error: `ffprobe exit ${code}: ${tail || `无法读取尺寸(${out.trim() || '无输出'})`}` });
      }
    });
    child.on('error', (e) => resolveP({ ok: false, error: e.message }));
  });
}

/** 读源白名单校验(与 frames.ts 同口径:产物/资产/导出目录) */
function checkReadable(p: string): string | null {
  if (!p) return '图片路径为空';
  if (!existsSync(p)) return `图片文件不存在: ${p}`;
  const roots = ffmpegReadRoots();
  if (!roots.some((r) => isUnderRoot(p, r))) return '图片不在允许目录,拒绝处理';
  return null;
}

/* ════════════════ 拼接(image-stitch) ════════════════ */

export type StitchMode = 'row' | 'column' | 'grid';

export interface StitchPlacement {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StitchPlan {
  canvas: ImageSize;
  /** 与输入一一对应:缩放后尺寸 + 落位 */
  placements: StitchPlacement[];
}

/**
 * 拼接布局(纯函数):
 * - row(横排):所有图缩放到同一高度(取最小高,只缩不放),横向依次排开
 * - column(竖排/长图):所有图缩放到同一宽度(取最小宽),纵向依次排开
 * - grid(网格):单元格 = 最小宽 × 最小高,缩放保持比例后居中贴入单元格(留白填底色);
 *   列数 gridCols,行数 = ceil(n/cols),最后一行不满时留白
 */
export function planStitch(
  sizes: ImageSize[],
  mode: StitchMode,
  gridCols = 3,
  gap = 0,
): { ok: true; plan: StitchPlan } | { ok: false; error: string } {
  const n = sizes.length;
  if (n < 2) return { ok: false, error: '拼接至少需要 2 张图片' };
  if (n > MAX_PIECES) return { ok: false, error: `拼接最多 ${MAX_PIECES} 张图片(收到 ${n})` };
  if (sizes.some((s) => s.w < 1 || s.h < 1)) return { ok: false, error: '存在非法图片尺寸' };
  const g = Math.max(0, Math.round(gap));

  if (mode === 'row') {
    const H = Math.min(...sizes.map((s) => s.h));
    const ws = sizes.map((s) => Math.max(2, Math.round((s.w * H) / s.h)));
    const placements: StitchPlacement[] = [];
    let x = 0;
    for (let i = 0; i < n; i++) {
      placements.push({ x, y: 0, w: ws[i]!, h: H });
      x += ws[i]! + g;
    }
    return { ok: true, plan: { canvas: { w: x - g, h: H }, placements } };
  }
  if (mode === 'column') {
    const W = Math.min(...sizes.map((s) => s.w));
    const hs = sizes.map((s) => Math.max(2, Math.round((s.h * W) / s.w)));
    const placements: StitchPlacement[] = [];
    let y = 0;
    for (let i = 0; i < n; i++) {
      placements.push({ x: 0, y, w: W, h: hs[i]! });
      y += hs[i]! + g;
    }
    return { ok: true, plan: { canvas: { w: W, h: y - g }, placements } };
  }
  // grid
  const cols = Math.min(Math.max(1, Math.round(gridCols)), n);
  const rows = Math.ceil(n / cols);
  const cellW = Math.min(...sizes.map((s) => s.w));
  const cellH = Math.min(...sizes.map((s) => s.h));
  const placements: StitchPlacement[] = sizes.map((s, i) => {
    // 缩放保持比例贴入单元格(只缩不放),单元格内居中
    const k = Math.min(cellW / s.w, cellH / s.h, 1);
    const w = Math.max(2, Math.round(s.w * k));
    const h = Math.max(2, Math.round(s.h * k));
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      x: col * (cellW + g) + Math.round((cellW - w) / 2),
      y: row * (cellH + g) + Math.round((cellH - h) / 2),
      w,
      h,
    };
  });
  return {
    ok: true,
    plan: {
      canvas: { w: cols * cellW + g * (cols - 1), h: rows * cellH + g * (rows - 1) },
      placements,
    },
  };
}

/**
 * 拼接 filtergraph(纯函数):color 底版 + 逐张 overlay。
 * 输入序:0..n-1 = 图片,n = color lavfi 底版;输出标签 [out]。
 */
export function buildStitchFilter(plan: StitchPlan, bg: string): string {
  const n = plan.placements.length;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = plan.placements[i]!;
    parts.push(`[${i}:v]scale=${p.w}:${p.h}[v${i}]`);
  }
  let prev = `[${n}:v]`;
  for (let i = 0; i < n; i++) {
    const p = plan.placements[i]!;
    const out = i === n - 1 ? '[out]' : `[t${i}]`;
    parts.push(`${prev}[v${i}]overlay=${p.x}:${p.y}${out}`);
    prev = `[t${i}]`;
  }
  void bg; // 底色由 color lavfi 源承担(见 doStitch)
  return parts.join(';');
}

export interface StitchResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export interface StitchOptions {
  mode: StitchMode;
  gridCols?: number;
  gap?: number;
  bg?: string;
}

export function stitchImages(paths: string[], opts: StitchOptions): Promise<StitchResult> {
  return enqueue(() => doStitch(paths, opts));
}

async function doStitch(paths: string[], opts: StitchOptions): Promise<StitchResult> {
  if (!Array.isArray(paths) || paths.length < 2) return { ok: false, error: '拼接至少需要 2 张图片' };
  if (paths.length > MAX_PIECES) return { ok: false, error: `拼接最多 ${MAX_PIECES} 张图片(收到 ${paths.length})` };
  for (const p of paths) {
    const bad = checkReadable(p);
    if (bad) return { ok: false, error: bad };
  }
  const sizes: ImageSize[] = [];
  for (const p of paths) {
    const probed = await probeImage(p);
    if (!probed.ok || !probed.size) return { ok: false, error: `读取尺寸失败(${basename(p)}):${probed.error ?? '未知'}` };
    sizes.push(probed.size);
  }
  const planned = planStitch(sizes, opts.mode, opts.gridCols ?? 3, opts.gap ?? 0);
  if (!planned.ok) return { ok: false, error: planned.error };
  const { plan } = planned;
  const bg = (opts.bg ?? 'white').trim() || 'white';
  try {
    mkdirSync(STITCH_DIR, { recursive: true });
  } catch {
    /* 交给 ffmpeg 报错 */
  }
  const base = basename(paths[0]!).replace(/\.[^.]+$/, '') || 'img';
  const out = join(STITCH_DIR, `${base}-stitch-${opts.mode}-${Date.now()}.png`);
  const filter = buildStitchFilter(plan, bg);
  const args = ['-y'];
  for (const p of paths) args.push('-i', p);
  args.push('-f', 'lavfi', '-i', `color=c=${bg}:s=${plan.canvas.w}x${plan.canvas.h}`);
  args.push('-filter_complex', filter, '-map', '[out]', '-frames:v', '1', out);
  return runFfmpeg(args, out);
}

/* ════════════════ 拆分(image-split) ════════════════ */

export type SplitMode = 'rows' | 'cols' | 'grid';

export interface SplitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 拆分矩形(纯函数):等分源图,末行/末列吃余数(保证拼回恰好覆盖全图)。
 * - rows:横切 N 段(水平条,自上而下)
 * - cols:竖切 N 段(竖条,自左而右)
 * - grid:gridCols × gridRows 网格(行优先编号:piece-1 = 左上)
 */
export function planSplit(
  size: ImageSize,
  mode: SplitMode,
  count = 3,
  gridCols = 3,
  gridRows = 3,
): { ok: true; rects: SplitRect[] } | { ok: false; error: string } {
  const { w: W, h: H } = size;
  if (W < 1 || H < 1) return { ok: false, error: '非法图片尺寸' };

  /** 沿一轴等分:返回每段的 (起点, 长度),末段吃余数 */
  const slices = (total: number, n: number): Array<{ at: number; len: number }> => {
    const base = Math.floor(total / n);
    const out: Array<{ at: number; len: number }> = [];
    let at = 0;
    for (let i = 0; i < n; i++) {
      const len = i === n - 1 ? total - at : base;
      out.push({ at, len });
      at += len;
    }
    return out;
  };

  const checkCount = (n: number): string | null =>
    n < 2 ? '拆分至少 2 片' : n > MAX_PIECES ? `拆分最多 ${MAX_PIECES} 片(收到 ${n})` : null;

  if (mode === 'rows') {
    const n = Math.round(count);
    const bad = checkCount(n);
    if (bad) return { ok: false, error: bad };
    const hs = slices(H, n);
    if (hs.some((s) => s.len < 1)) return { ok: false, error: `图片高度 ${H} 不足以拆成 ${n} 片` };
    return { ok: true, rects: hs.map((s) => ({ x: 0, y: s.at, w: W, h: s.len })) };
  }
  if (mode === 'cols') {
    const n = Math.round(count);
    const bad = checkCount(n);
    if (bad) return { ok: false, error: bad };
    const ws = slices(W, n);
    if (ws.some((s) => s.len < 1)) return { ok: false, error: `图片宽度 ${W} 不足以拆成 ${n} 片` };
    return { ok: true, rects: ws.map((s) => ({ x: s.at, y: 0, w: s.len, h: H })) };
  }
  // grid
  const cols = Math.round(gridCols);
  const rows = Math.round(gridRows);
  const bad = checkCount(cols * rows) ?? (cols < 1 || rows < 1 ? '网格行列数须 ≥ 1' : null);
  if (bad) return { ok: false, error: bad };
  const ws = slices(W, cols);
  const hs = slices(H, rows);
  if (ws.some((s) => s.len < 1) || hs.some((s) => s.len < 1)) {
    return { ok: false, error: `图片 ${W}×${H} 不足以拆成 ${cols}×${rows} 网格` };
  }
  const rects: SplitRect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      rects.push({ x: ws[c]!.at, y: hs[r]!.at, w: ws[c]!.len, h: hs[r]!.len });
    }
  }
  return { ok: true, rects };
}

/** 拆分 filtergraph(纯函数):split=N 后逐片 crop,输出标签 [o0]..[oN-1] */
export function buildSplitFilter(rects: SplitRect[]): string {
  const n = rects.length;
  const tags = rects.map((_, i) => `[s${i}]`).join('');
  const parts = [`[0:v]split=${n}${tags}`];
  for (let i = 0; i < n; i++) {
    const r = rects[i]!;
    parts.push(`[s${i}]crop=${r.w}:${r.h}:${r.x}:${r.y}[o${i}]`);
  }
  return parts.join(';');
}

export interface SplitResult {
  ok: boolean;
  paths?: string[];
  error?: string;
}

export interface SplitOptions {
  mode: SplitMode;
  count?: number;
  gridCols?: number;
  gridRows?: number;
}

export function splitImage(srcPath: string, opts: SplitOptions): Promise<SplitResult> {
  return enqueue(() => doSplit(srcPath, opts));
}

async function doSplit(srcPath: string, opts: SplitOptions): Promise<SplitResult> {
  const bad = checkReadable(srcPath);
  if (bad) return { ok: false, error: bad };
  const probed = await probeImage(srcPath);
  if (!probed.ok || !probed.size) return { ok: false, error: `读取尺寸失败:${probed.error ?? '未知'}` };
  const planned = planSplit(probed.size, opts.mode, opts.count ?? 3, opts.gridCols ?? 3, opts.gridRows ?? 3);
  if (!planned.ok) return { ok: false, error: planned.error };
  const { rects } = planned;
  try {
    mkdirSync(SPLITS_DIR, { recursive: true });
  } catch {
    /* 交给 ffmpeg 报错 */
  }
  const base = basename(srcPath).replace(/\.[^.]+$/, '') || 'img';
  const stamp = `${opts.mode}-${Date.now()}`;
  const outs = rects.map((_, i) => join(SPLITS_DIR, `${base}-${stamp}-p${i + 1}.png`));
  const args = ['-y', '-i', srcPath, '-filter_complex', buildSplitFilter(rects)];
  for (let i = 0; i < outs.length; i++) args.push('-map', `[o${i}]`, outs[i]!);
  return runFfmpegMulti(args, outs);
}

/* ════════════════ ffmpeg 执行 ════════════════ */

function runFfmpeg(args: string[], out: string): Promise<StitchResult> {
  return new Promise((resolveP) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errAcc = '';
    child.stderr.on('data', (d: Buffer) => (errAcc += d.toString()));
    child.on('close', (code) => {
      if (code === 0 && existsSync(out)) resolveP({ ok: true, path: out });
      else {
        const tail = errAcc.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 200);
        resolveP({ ok: false, error: `ffmpeg exit ${code}: ${tail || '未知错误'}` });
      }
    });
    child.on('error', (e) => resolveP({ ok: false, error: e.message }));
  });
}

function runFfmpegMulti(args: string[], outs: string[]): Promise<SplitResult> {
  return new Promise((resolveP) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errAcc = '';
    child.stderr.on('data', (d: Buffer) => (errAcc += d.toString()));
    child.on('close', (code) => {
      if (code === 0 && outs.every((o) => existsSync(o))) resolveP({ ok: true, paths: outs });
      else {
        const tail = errAcc.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 200);
        resolveP({ ok: false, error: `ffmpeg exit ${code}: ${tail || '未知错误'}` });
      }
    });
    child.on('error', (e) => resolveP({ ok: false, error: e.message }));
  });
}
