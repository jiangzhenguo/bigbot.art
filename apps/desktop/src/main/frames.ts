/**
 * FrameTool — 视频取帧(ffmpeg):抽首帧 / 尾帧 PNG
 * P0 #1/#3:上游 shot 跑完后抽尾帧 → 归档为下游镜头 first-frame 参考候选;
 * 也是 shot→image-edit「取帧再编辑」的帧来源。
 *
 * 产物落 ${OUTPUTS_DIR}/frames/ 下(bba-output 协议可读),文件名
 * <视频基名>-<mode>-<毫秒时间戳>.png,多次抽取互不覆盖。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { OUTPUTS_DIR, ffmpegReadRoots, isUnderRoot } from './assets';

const FRAMES_DIR = join(OUTPUTS_DIR, 'frames');

export interface FrameExtractResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/** 全局串行链:多个任务同时完成触发抽帧时逐个执行,避免多个 ffmpeg 同时抢 CPU/IO */
let extractChain: Promise<unknown> = Promise.resolve();

export function extractFrame(
  videoPath: string,
  mode: 'first' | 'last',
): Promise<FrameExtractResult> {
  const run = extractChain.then(() => doExtract(videoPath, mode));
  // 链上任何一次失败都不影响后续任务继续执行
  extractChain = run.catch(() => undefined);
  return run;
}

function doExtract(
  videoPath: string,
  mode: 'first' | 'last',
): Promise<FrameExtractResult> {
  return new Promise((resolveP) => {
    if (!videoPath) return resolveP({ ok: false, error: '视频路径为空' });
    if (!existsSync(videoPath)) return resolveP({ ok: false, error: '视频文件不存在' });
    // 只允许产物/资产/导出目录下的视频,防任意读(含资产库素材)
    const roots = ffmpegReadRoots();
    if (!roots.some((r) => isUnderRoot(videoPath, r))) {
      return resolveP({ ok: false, error: '视频不在允许目录,拒绝取帧' });
    }
    try {
      mkdirSync(FRAMES_DIR, { recursive: true });
    } catch {
      /* 目录已存在/不可建则交给 ffmpeg 报错 */
    }
    const name = basename(videoPath).replace(/\.[^.]+$/, '') || 'frame';
    const out = join(FRAMES_DIR, `${name}-${mode}-${Date.now()}.png`);
    const args =
      mode === 'last'
        // 尾帧:-sseof 从文件末尾回退 0.2s 定位,兼容各封装
        ? ['-y', '-sseof', '-0.2', '-i', videoPath, '-frames:v', '1', out]
        : ['-y', '-i', videoPath, '-frames:v', '1', out];
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

/* ── 图片裁切(image-crop 节点):按目标画幅(A:B)裁出最大内接窗口 ── */
const CROPS_DIR = join(OUTPUTS_DIR, 'crops');
/** 支持的画幅集合(与 mlxgen capabilities.aspectRatios 对齐;可扩展) */
export const CROP_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '2:3'] as const;
export type CropAspect = (typeof CROP_ASPECTS)[number];
export type CropFocus = 'center' | 'top' | 'bottom' | 'left' | 'right';

export interface CropImageResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/** 画幅解析(纯函数):'A:B' → 宽高比;非法格式/非正数 → 错误 */
export function parseCropAspect(aspect: string): { ok: true; ratio: number } | { ok: false; error: string } {
  const m = /^(\d+)\s*:\s*(\d+)$/.exec(String(aspect).trim());
  if (!m || Number(m[1]) <= 0 || Number(m[2]) <= 0) {
    return { ok: false, error: `画幅格式非法: ${aspect}(需如 16:9)` };
  }
  return { ok: true, ratio: Number(m[1]) / Number(m[2]) };
}

/**
 * 裁切 filtergraph(纯函数):在保持源分辨率的前提下裁出最大内接画幅窗口。
 * 宽 = min(iw, ih×AR) · 高 = min(ih, iw/AR);锚点:压缩轴按 focus 取
 * (宽被裁窄 → left/right;高被裁矮 → top/bottom),未压缩轴恒居中。
 */
export function buildCropVf(ratio: number, focus: CropFocus): string {
  const focusX = focus === 'left' ? 0 : focus === 'right' ? 'iw-ow' : '(iw-ow)/2';
  const focusY = focus === 'top' ? 0 : focus === 'bottom' ? 'ih-oh' : '(ih-oh)/2';
  return `crop=min(iw\\,ih*${ratio.toFixed(6)}):min(ih\\,iw/${ratio.toFixed(6)}):${focusX}:${focusY}`;
}

/** 串行链与取帧共用:裁切同样是 ffmpeg,避免并发抢 CPU/IO */
export function cropImage(srcPath: string, aspect: string, focus: CropFocus = 'center'): Promise<CropImageResult> {
  const run = extractChain.then(() => doCrop(srcPath, aspect, focus));
  extractChain = run.catch(() => undefined);
  return run;
}

function doCrop(srcPath: string, aspect: string, focus: CropFocus): Promise<CropImageResult> {
  return new Promise((resolveP) => {
    if (!srcPath) return resolveP({ ok: false, error: '输入图片路径为空' });
    if (!existsSync(srcPath)) return resolveP({ ok: false, error: '图片文件不存在' });
    const roots = ffmpegReadRoots();
    if (!roots.some((r) => isUnderRoot(srcPath, r))) {
      return resolveP({ ok: false, error: '图片不在允许目录,拒绝裁切' });
    }
    const parsed = parseCropAspect(aspect);
    if (!parsed.ok) return resolveP({ ok: false, error: parsed.error });
    try {
      mkdirSync(CROPS_DIR, { recursive: true });
    } catch {
      /* 交给 ffmpeg 报错 */
    }
    const name = basename(srcPath).replace(/\.[^.]+$/, '') || 'img';
    const out = join(CROPS_DIR, `${name}-${aspect.replace(':', 'x')}-${Date.now()}.png`);
    const args = ['-y', '-i', srcPath, '-vf', buildCropVf(parsed.ratio, focus), out];
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