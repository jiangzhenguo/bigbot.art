/**
 * media-probe — 媒体基本信息探测(资源节点检查器「媒体信息」面板的数据源)
 *
 * 为什么不复用既有探测:
 *  - `assets.ts` 的 `probeMedia` 只在**导入那一刻**跑一次,且结果落盘进 assets.json;
 *    历史资产(2026-09 之前导入的 48+ 条)根本没有这些字段,改代码不会让它们长出来。
 *  - `video-post.ts` 的 `probeVideo` 是**同步** execFileSync,会卡主进程事件循环;
 *    它也只认视频,图片/音频拿不到东西。
 * 所以这里给一个**按需、异步、只读**的探测入口:检查器选中资源节点时调一次,
 * 拿到什么显示什么,**不回写资产库**(纯读操作不该有副作用)。
 *
 * 关键设计:
 *  - 纯函数 `parseProbeJson` 与 `probeLimit` 单独导出,单测直接喂 **真实 ffprobe 输出片段**,
 *    不依赖本机是否装了 ffprobe;
 *  - 文件不存在 / ffprobe 缺失 / 超时 / JSON 非法一律返回 `ok:false` 且带原因,
 *    **不抛异常**(检查器渲染路径上不该因为一个探测失败而白屏);
 *  - 白名单由调用方(IPC handler)负责,本模块只认路径。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { MediaInfo, MediaKind } from '@bigbotart/shared';

const execFileP = promisify(execFile);

/** ffprobe 超时(ms)。远程/大文件挂载盘上 metadata 读取也可能慢,给足余量 */
const PROBE_TIMEOUT_MS = 10_000;
/** ffprobe JSON 输出上限(流很多的文件会长,但 8MB 足够) */
const PROBE_MAX_BUFFER = 8 * 1024 * 1024;

/* ════════════════ 纯函数:解析 ffprobe JSON ════════════════ */

/** ffprobe 流对象(只声明我们真正读的字段) */
export interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  /** 平均帧率(比 r_frame_rate 更贴近「实际内容帧率」,优先取它) */
  avg_frame_rate?: string;
  r_frame_rate?: string;
  nb_frames?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  duration?: string;
  bit_rate?: string;
  /** 旋转元数据(手机竖拍视频):90/270 时实际展示宽高要互换 */
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
}

export interface ProbeJson {
  streams?: ProbeStream[];
  format?: { duration?: string; size?: string; bit_rate?: string; format_name?: string };
}

/**
 * 把 ffprobe 的 `r_frame_rate` / `avg_frame_rate` 字符串转成数字。
 *
 * 真实取值形态三种:`"24/1"`、`"30000/1001"`(29.97)、`"0/0"`(未知 —— ffprobe 对
 * 部分容器/图片就是这么填的)。**`0/0` 必须判成 undefined 而不是 0**,否则检查器会
 * 显示「帧率 0 fps」这种明显是 bug 的信息。保留两位小数是刻意的:29.97 / 23.98
 * 这些非整数帧率截断成 30 / 24 会误导用户以为素材是标准帧率。
 */
export function parseFps(rate: string | undefined | null): number | undefined {
  if (!rate) return undefined;
  const s = String(rate).trim();
  if (!s) return undefined;
  let v: number;
  if (s.includes('/')) {
    const [numRaw, denRaw] = s.split('/');
    const num = Number(numRaw);
    const den = Number(denRaw);
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return undefined;
    v = num / den;
  } else {
    v = Number(s);
  }
  if (!Number.isFinite(v) || v <= 0) return undefined;
  return Math.round(v * 100) / 100;
}

/**
 * 秒数统一保留 1 位小数(durationSec 在别处也是这个精度,保持一致)。
 *
 * 👀 **静图陷阱**:ffprobe 对 jpg 也会吐一个「视频流」,并给出 `duration: 0.04`
 * (按 25fps 的 1 帧算出来的假时长)。这个值一旦当真写进资产库,时间线/剪辑就会
 * 把一张静图当成 0 秒(取整后)的片段。时长**必须是个正数**才算数。
 */
function roundSec(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * 10) / 10;
}

function round1(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * 10) / 10;
}

/** 旋转角归一化:只关心是否恰好把宽高转置(tags.rotate 与 side_data rotation 两种来源) */
function rotationOf(s: ProbeStream): number {
  const fromSide = s.side_data_list?.find((x) => typeof x.rotation === 'number')?.rotation;
  const raw = fromSide !== undefined ? fromSide : Number(s.tags?.rotate);
  if (!Number.isFinite(raw)) return 0;
  return ((Math.round(raw) % 360) + 360) % 360;
}

/**
 * 解析 ffprobe `-show_streams -show_format` 的 JSON → 面板要显示的全部字段。
 *
 * 三个刻意的取舍:
 *  ① **图片**:ffprobe 对 png/jpg 也会报一条 video 流,但没有 fps 也没有 duration
 *     —— `fps`/`durationSec` 保持 undefined,不会被填成 0;
 *  ② **音频**:采样率取 `sample_rate`(字符串),声道数与布局分开给(「2 声道 · stereo」);
 *     某些容器(如 wav)的 duration 只在 format 里,故 format 优先、stream 兜底;
 *     总有那么些文件两边都没有 → 留 undefined,由 UI 显示「—」;
 *  ③ **视频**:ffprobe 对带封面的 mp4 可能给出**两条 video 流**(真实画面 + 内嵌图片);
 *     取第一条(容器声明的顺序,即主轨),与既有 `probeMedia` 的行为一致。
 */
export function parseProbeJson(j: ProbeJson, kind: MediaKind, fallbackName = ''): MediaInfo {
  const out: MediaInfo = { ok: true, name: fallbackName, kind };

  const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
  const a = (j.streams ?? []).find((s) => s.codec_type === 'audio');

  // 时长:format.duration 是**整条容器**的时长(多流时最准),stream.duration 兜底
  const durationSec = roundSec(j.format?.duration) ?? roundSec(v?.duration) ?? roundSec(a?.duration);
  if (durationSec !== undefined) out.durationSec = durationSec;

  const fmtBitrate = roundSec(j.format?.bit_rate);
  if (fmtBitrate !== undefined) out.bitrateKbps = Math.round(fmtBitrate / 1000);

  out.container = j.format?.format_name;

  if (kind === 'image') {
    if (v?.width) out.width = v.width;
    if (v?.height) out.height = v.height;
    out.videoCodec = v?.codec_name;
    /* 静图必须**清掉**从 format 里算出来的时长/码率:
       ffprobe 把 jpg 当 1 帧视频,给 duration=0.04 与一个「码率」——两者对一张
       图片都毫无意义(19501 kbps 这种数字只会让人以为哪里错了)。 */
    delete out.durationSec;
    delete out.bitrateKbps;
    return out;
  }

  if (kind === 'audio') {
    const sr = Number(a?.sample_rate);
    if (Number.isFinite(sr) && sr > 0) out.sampleRate = sr;
    if (a?.channels) out.channels = a.channels;
    out.channelLayout = a?.channel_layout;
    out.audioCodec = a?.codec_name;
    return out;
  }

  if (kind === 'video') {
    if (v?.width) out.width = v.width;
    if (v?.height) out.height = v.height;
    // 竖拍视频(rotate=90/270):容器里存的是横置画面,真实展示宽高应互换
    const rot = rotationOf(v ?? {});
    if (rot === 90 || rot === 270) {
      const w = out.width;
      out.width = out.height;
      out.height = w;
      out.rotation = rot;
    }
    // 优先 avg_frame_rate:r_frame_rate 对 VFR 素材会给「最大帧率」,看着虚高
    out.fps = parseFps(v?.avg_frame_rate) ?? parseFps(v?.r_frame_rate);
    const frames = Number(v?.nb_frames);
    if (Number.isFinite(frames) && frames > 0) out.frameCount = frames;
    out.videoCodec = v?.codec_name;
    if (a) {
      out.hasAudio = true;
      out.audioCodec = a.codec_name;
      const sr = Number(a.sample_rate);
      if (Number.isFinite(sr) && sr > 0) out.sampleRate = sr;
      if (a.channels) out.channels = a.channels;
      out.channelLayout = a.channel_layout;
    } else {
      out.hasAudio = false;
    }
    return out;
  }

  // document:只给文件名/容器,不做媒体字段
  return out;
}

/**
 * 文件大小上限 —— 只做**提示**,不阻断探测。
 * ffprobe 读 metadata 是 seek 到文件头/尾,GB 级文件也是毫秒级,没有理由拒绝。
 */
export function probeLimit(bytes: number): { human: string; overLimit: boolean } {
  const mb = bytes / (1024 * 1024);
  const human = mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
  return { human, overLimit: false };
}

/** 扩展名 → 媒体类型(探测入参用;未知按图片处理不了,返回 null 让调用方决定) */
const EXT_KIND: Record<string, MediaKind> = {
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image', bmp: 'image', tif: 'image', tiff: 'image', avif: 'image',
  mp4: 'video', mov: 'video', m4v: 'video', webm: 'video', mkv: 'video', avi: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', ogg: 'audio',
};

/** 从扩展名推断媒体类型(纯函数) */
export function kindByExt(path: string): MediaKind | null {
  return EXT_KIND[extname(path).slice(1).toLowerCase()] ?? null;
}

/* ════════════════ 探测入口 ════════════════ */

/**
 * 探测一个本地媒体的基本信息(异步,不阻塞主进程)。
 *
 * 失败一律返回 `{ ok: false, error }` 而不是抛异常 —— 调用方(IPC handler)把它当成
 * 「这项信息暂时拿不到」展示即可。**绝不静默**:错误文案里带 ffprobe 的 stderr 尾部,
 * 让「文件损坏」和「ffprobe 没装」这两种失败在 UI 上长得不一样。
 */
export async function probeMediaInfo(
  path: string,
  kindHint?: MediaKind,
): Promise<MediaInfo> {
  const name = basename(path);
  const kind = kindHint ?? kindByExt(path) ?? 'document';

  if (!path) return { ok: false, error: '路径为空', name, kind };
  try {
    if (!existsSync(path)) {
      return { ok: false, error: `文件不存在:${path}`, name, kind };
    }
    const st = statSync(path);
    if (!st.isFile()) return { ok: false, error: '不是常规文件', name, kind };
    if (st.size === 0) return { ok: false, error: '文件为空(0 字节)', name, kind };

    const r = await execFileP(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path],
      { timeout: PROBE_TIMEOUT_MS, encoding: 'utf-8', maxBuffer: PROBE_MAX_BUFFER },
    );

    let parsed: ProbeJson;
    try {
      parsed = JSON.parse(r.stdout) as ProbeJson;
    } catch {
      return { ok: false, error: 'ffprobe 输出无法解析(不是合法 JSON)', name, kind };
    }

    const info = parseProbeJson(parsed, kind, name);
    info.sizeBytes = st.size;
    // 探测到的真实容器流与扩展名不一致时以流为准(如 .webm 里其实是音频)
    if (kind === 'document' && (parsed.streams ?? []).some((s) => s.codec_type === 'video')) {
      info.kind = 'video';
    } else if (kind === 'document' && (parsed.streams ?? []).some((s) => s.codec_type === 'audio')) {
      info.kind = 'audio';
    }
    return info;
  } catch (e) {
    const err = e as { code?: string; stderr?: string; message?: string; killed?: boolean };
    if (err.killed) return { ok: false, error: `探测超时(>${PROBE_TIMEOUT_MS / 1000}s)`, name, kind };
    if (err.code === 'ENOENT') {
      return { ok: false, error: '未找到 ffprobe · 请安装 ffmpeg(brew install ffmpeg)', name, kind };
    }
    const tail = (err.stderr ?? '').split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 200);
    return { ok: false, error: tail || err.message || '探测失败', name, kind };
  }
}
