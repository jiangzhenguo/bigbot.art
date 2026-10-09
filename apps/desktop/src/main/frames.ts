/**
 * FrameTool — 视频取帧(ffmpeg):抽首帧 / 尾帧 / **指定时间点帧** PNG
 * P0 #1/#3:上游 shot 跑完后抽尾帧 → 归档为下游镜头 first-frame 参考候选;
 * 也是 shot→image-edit「取帧再编辑」的帧来源。
 * 时间点模式(`mode:'at'` + `seconds`)供 Agent `frames.extract` 从任意视频取中间帧。
 *
 * 产物落 ${OUTPUTS_DIR}/frames/ 下(bba-output 协议可读),文件名
 * <视频基名>-<mode>[-<秒数>]-<毫秒时间戳>.png,多次抽取互不覆盖。
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

/** 取帧位置:首帧 / 尾帧 / 指定时间点(秒) */
export type FrameMode = 'first' | 'last' | 'at';

/**
 * 时间点参数校验(纯函数):`mode:'at'` 时 seconds 必填且为**有限非负数**。
 * 返回归一化后的秒数(NaN/负数/非数 → 错误),供 IPC 与单测复用。
 */
export function parseAtSeconds(
  mode: FrameMode,
  seconds: unknown,
): { ok: true; seconds?: number } | { ok: false; error: string } {
  if (mode !== 'at') return { ok: true };
  const n = typeof seconds === 'number' ? seconds : Number(seconds);
  if (seconds === undefined || seconds === null || seconds === '' || !Number.isFinite(n)) {
    return { ok: false, error: "mode='at' 需要 seconds(非负数字,单位秒)" };
  }
  if (n < 0) return { ok: false, error: `时间点不能为负数: ${n}s` };
  return { ok: true, seconds: n };
}

/** 全局串行链:多个任务同时完成触发抽帧时逐个执行,避免多个 ffmpeg 同时抢 CPU/IO */
let extractChain: Promise<unknown> = Promise.resolve();

export function extractFrame(
  videoPath: string,
  mode: FrameMode,
  seconds?: number,
): Promise<FrameExtractResult> {
  const run = extractChain.then(() => doExtract(videoPath, mode, seconds));
  // 链上任何一次失败都不影响后续任务继续执行
  extractChain = run.catch(() => undefined);
  return run;
}

function doExtract(
  videoPath: string,
  mode: FrameMode,
  seconds?: number,
): Promise<FrameExtractResult> {
  return new Promise((resolveP) => {
    if (!videoPath) return resolveP({ ok: false, error: '视频路径为空' });
    if (!existsSync(videoPath)) return resolveP({ ok: false, error: '视频文件不存在' });
    // 只允许产物/资产/导出目录下的视频,防任意读(含资产库素材)
    const roots = ffmpegReadRoots();
    if (!roots.some((r) => isUnderRoot(videoPath, r))) {
      return resolveP({ ok: false, error: '视频不在允许目录,拒绝取帧' });
    }
    const at = parseAtSeconds(mode, seconds);
    if (!at.ok) return resolveP({ ok: false, error: at.error });
    try {
      mkdirSync(FRAMES_DIR, { recursive: true });
    } catch {
      /* 目录已存在/不可建则交给 ffmpeg 报错 */
    }
    const name = basename(videoPath).replace(/\.[^.]+$/, '') || 'frame';
    // 时间点模式文件名带秒数,便于人眼辨认「这一帧是第几秒」
    const suffix = mode === 'at' ? `at-${(at.seconds ?? 0).toFixed(2).replace(/\.?0+$/, '')}s` : mode;
    const out = join(FRAMES_DIR, `${name}-${suffix}-${Date.now()}.png`);
    const args =
      mode === 'last'
        // 尾帧:-sseof 从文件末尾回退 0.2s 定位,兼容各封装
        ? ['-y', '-sseof', '-0.2', '-i', videoPath, '-frames:v', '1', out]
        : mode === 'at'
          // 时间点:-ss 放在 -i **之前**为输入侧定位(关键帧 seek,秒级定位不重解码全片);
          // 用 -frames:v 1 取该时刻后第一帧。超出片长时 ffmpeg 输出 0 帧 → 由下方 existsSync 判定失败
          ? ['-y', '-ss', String(at.seconds), '-i', videoPath, '-frames:v', '1', out]
          : ['-y', '-i', videoPath, '-frames:v', '1', out];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errAcc = '';
    child.stderr.on('data', (d: Buffer) => (errAcc += d.toString()));
    child.on('close', (code) => {
      if (code === 0 && existsSync(out)) resolveP({ ok: true, path: out });
      else if (mode === 'at' && code === 0) {
        // ffmpeg 对超出片长的时间点可能退 0 退出码但不出文件
        resolveP({ ok: false, error: `第 ${at.seconds}s 处没有取到帧(可能超出视频时长),请确认时间点在片长内` });
      } else {
        const tail = errAcc.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 200);
        resolveP({ ok: false, error: `ffmpeg exit ${code}: ${tail || '未知错误'}` });
      }
    });
    child.on('error', (e) => resolveP({ ok: false, error: e.message }));
  });
}

/* ── 音轨抽取:视频 → wav(作 shot 的 ref-audio 参考) ──

   动机(2026-10-08):`ref-audio` 端口过去只接受**音频资产**,于是「把上游镜头的声音
   拿来当这一段的声音参考」这条最自然的用法反而走不通 —— 视频节点(shot / video-upscale)
   的产物是 mp4,连不到 ref-audio 上。现在放开「视频节点 → shot 的 ref-audio」直连:
   提交时用 ffmpeg 从视频里抽出音轨,再走既有的 `--ref-audio`。

   ⚠️ **抽成 wav 而不是直接把 mp4 交给 h3**:h3 的 `--ref-audio` 语义是音轨参考,
   喂 mp4 等于让它自己解容器,行为不确定;先落地成标准 PCM wav 更可控,
   也与「产物可见、可回查」的项目口径一致(产物落 outputs/audio/)。 */
const AUDIO_DIR = join(OUTPUTS_DIR, 'audio');

export interface AudioExtractResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/**
 * 从视频/音频抽取音轨 → wav(16-bit PCM,48kHz 立体声)。
 *
 * 无音轨是**明确失败**而非静默产出空文件:h3 拿到一个 0 字节的 wav 只会在很远的地方
 * 报一句看不懂的错,不如在这里就说清「这个视频没有声音」。
 * `-vn` 丢掉视频流;`-map 0:a:0` 只取第一条音轨(多轨时不猜)。
 */
export function extractAudio(srcPath: string): Promise<AudioExtractResult> {
  const run = extractChain.then(() => doExtractAudio(srcPath));
  extractChain = run.catch(() => undefined);
  return run;
}

function doExtractAudio(srcPath: string): Promise<AudioExtractResult> {
  return new Promise((resolveP) => {
    if (!srcPath) return resolveP({ ok: false, error: '视频路径为空' });
    if (!existsSync(srcPath)) return resolveP({ ok: false, error: '视频文件不存在' });
    // 与取帧/裁切同白名单:只读产物/资产/导出目录,防任意读
    const roots = ffmpegReadRoots();
    if (!roots.some((r) => isUnderRoot(srcPath, r))) {
      return resolveP({ ok: false, error: '视频不在允许目录,拒绝抽取音轨' });
    }
    try {
      mkdirSync(AUDIO_DIR, { recursive: true });
    } catch {
      /* 交给 ffmpeg 报错 */
    }
    const name = basename(srcPath).replace(/\.[^.]+$/, '') || 'audio';
    const out = join(AUDIO_DIR, `${name}-${Date.now()}.wav`);
    const args = [
      '-y',
      '-i', srcPath,
      '-vn', // 丢弃视频流
      '-map', '0:a:0?', // 第一条音轨;`?` 让「无音轨」不直接让 ffmpeg 报参数错,由下方判定
      '-acodec', 'pcm_s16le',
      '-ar', '48000',
      '-ac', '2',
      out,
    ];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errAcc = '';
    child.stderr.on('data', (d: Buffer) => (errAcc += d.toString()));
    child.on('close', (code) => {
      if (code === 0 && existsSync(out)) return resolveP({ ok: true, path: out });
      // 无音轨是最常见的失败原因,单独给一句人能看懂的错(而不是抛 ffmpeg 的英文尾巴)
      const noAudio = /does not contain any stream|matches no streams|Stream map .* matches no streams/i.test(errAcc);
      if (noAudio) {
        return resolveP({ ok: false, error: '该视频没有音轨,无法作为音频参考(可改用参考视频,或另配音频资产)' });
      }
      const tail = errAcc.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 200);
      resolveP({ ok: false, error: `ffmpeg exit ${code}: ${tail || '未知错误'}` });
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