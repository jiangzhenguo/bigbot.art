/**
 * MediaInfoPanel — 资源节点的「媒体信息」面板(图片宽高 / 视频时长·分辨率·帧率 / 音频时长·采样率)
 *
 * 数据来源是主进程 **按需 ffprobe**(`window.bigbotart.probeMedia`),不是资产记录里的字段:
 * 历史资产(2026-09 之前导入的那批)assets.json 里根本没有 fps / 采样率,
 * 读资产字段会显示一堆「—」,看起来像功能没做;现探一次新旧资产一视同仁。
 *
 * 三条设计约束:
 *  ① **失败要说清楚** —— 探测失败显示 `error` 原文(「文件不存在」/「未找到 ffprobe」/
 *     「路径不在允许目录」语义完全不同),而不是静默留空或假装「无信息」;
 *  ② **探测结果只作展示兜底** —— 真实播放器元素(<video>/<audio>)的 `loadedmetadata`
 *     比 ffprobe 更权威(它读的就是浏览器真正要解码的那条轨),所以本组件把探测值当
 *     `fallback` 传下去,由播放器在元数据到达时覆盖;
 *  ③ **不写盘** —— 纯读操作,不 setData/不碰资产库,可以随时重探(「重新探测」按钮)。
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { MediaInfo, MediaKind } from '@bigbotart/shared';
import { Lbl } from './fields';

export interface MediaInfoPanelProps {
  /** 资产本地绝对路径(缺省 = 未绑定资产,不给探测入口) */
  path: string | null;
  /** 媒体类型(仅作 ffprobe 的 kind 提示;真实类型以容器里的流为准) */
  kind: MediaKind;
  /**
   * 播放器已经拿到的权威值(可选)。
   * 有值时**优先显示**它 —— 浏览器解码的是真实那条轨,ffprobe 只是探测。
   */
  live?: { width?: number; height?: number; durationSec?: number };
}

/** 秒 → `1:23.4` / `1:02:03`(视频/音频时长展示;保留到 0.1 秒便于比对生成参数) */
export function formatClock(sec: number | undefined): string | null {
  if (sec === undefined || !Number.isFinite(sec) || sec < 0) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const sTxt = h > 0 ? String(Math.floor(s)).padStart(2, '0') : s.toFixed(1).padStart(4, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sTxt}` : `${m}:${sTxt}`;
}

/** 采样率 → `44.1 kHz`(整数 kHz 不带小数,48000→48 kHz 而不是 48.0 kHz) */
export function formatSampleRate(hz: number | undefined): string | null {
  if (hz === undefined || !Number.isFinite(hz) || hz <= 0) return null;
  const khz = hz / 1000;
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
}

/** 声道数 → `2 声道 · stereo`(布局缺失时只给声道数) */
export function formatChannels(channels: number | undefined, layout: string | undefined): string | null {
  const parts: string[] = [];
  if (channels !== undefined && channels > 0) parts.push(`${channels} 声道`);
  if (layout) parts.push(layout);
  return parts.length ? parts.join(' · ') : null;
}

/** 帧率 → `29.97 fps`(整数不带小数) */
export function formatFps(fps: number | undefined): string | null {
  if (fps === undefined || !Number.isFinite(fps) || fps <= 0) return null;
  return `${Number.isInteger(fps) ? fps : fps.toFixed(2)} fps`;
}

/** 字节 → `126.4 MB` */
export function formatBytes(bytes: number | undefined): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

/**
 * 常见画幅比例。**只认这些** —— 与其显示一个数学正确但没人看得懂的约分结果
 * (854×480 约分后是 427:240),不如什么都不显示。
 *
 * 匹配分两步,**先按容差匹配标准画幅,再退回精确小整数比**:
 *
 *  ① 容差匹配(±0.5%)覆盖真实素材的常见近似:
 *       854×480  → 16:9  (差 0.078%,这是 16:9 最常见的近似分辨率之一)
 *     容差取 0.5% 是权衡出来的:再放宽会把「1150×1144」(距 1:1 仅 0.52%)、
 *     「1410×1066」(距 4:3 0.80%)这类**真·怪尺寸**强行归到标准画幅上 ——
 *     显示一个错误的「4:3」比不显示比例更糟(用户会照着它去配参数)。
 *     代价是 2560×1080(距 2.39:1 有 0.82%)拿不到标签,这是**安全方向**的漏判。
 *
 *  ② 都不命中时,才看它是不是个**真·简单整数比**(约分后两数都 ≤ 16):
 *       864×480 → 9:5 ✅ 个位数、一眼看懂,不该被 16:9 抢走(两者差 1.25%)
 *       1024×768 → 4:3 ✅
 *       1150×1144 → 575:572 ❌ 三位数,没人认得出
 */
const KNOWN_RATIOS: Array<[string, number]> = [
  ['1:1', 1 / 1],
  ['9:5', 9 / 5],
  ['4:3', 4 / 3],
  ['3:2', 3 / 2],
  ['16:10', 16 / 10],
  ['16:9', 16 / 9],
  ['1.85:1', 1.85],
  ['2:1', 2 / 1],
  ['21:9', 21 / 9],
  ['2.39:1', 2.39],
  ['5:9', 5 / 9],
  ['9:16', 9 / 16],
  ['3:4', 3 / 4],
  ['2:3', 2 / 3],
];

/**
 * 相对误差容差。0.5% 的依据见上方注释:刚好容纳 16:9 的 854×480 近似,
 * 又不至于把 1.005 这种真·怪比例(距 1:1 仅 0.52%)误标成 1:1。
 */
const RATIO_TOLERANCE = 0.005;

/** 约分后两数都不超过这个值,才算「人认得出的简单比例」 */
const SIMPLE_RATIO_MAX = 16;

/** 宽高 → 常见比例标签(`16:9`);不是任何常见比例时返回 null(宁可不说,不印 `427:240`) */
export function simpleRatio(w: number | undefined, h: number | undefined): string | null {
  if (!w || !h || w <= 0 || h <= 0) return null;
  const actual = w / h;

  // ① 容差内就近匹配标准画幅(取误差最小的那个)
  let best: { label: string; diff: number } | null = null;
  for (const [label, target] of KNOWN_RATIOS) {
    const diff = Math.abs(actual - target) / target;
    if (diff <= RATIO_TOLERANCE && (!best || diff < best.diff)) best = { label, diff };
  }
  if (best) return best.label;

  // ② 退回精确小整数比(最大公约数约分后两数都 ≤ 16 才认)
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const d = gcd(w, h);
  const nw = w / d;
  const nh = h / d;
  if (Number.isInteger(nw) && Number.isInteger(nh) && nw <= SIMPLE_RATIO_MAX && nh <= SIMPLE_RATIO_MAX) {
    return `${nw}:${nh}`;
  }
  return null;
}

/**
 * 组装展示行(纯函数,单测直接覆盖)。
 *
 * 「显示什么」按媒体类型分派,每条规则都是「拿不到就不显示」而不是填 `—`——
 * 一行 `帧率 —` 只是噪音,反而让人怀疑是 bug。
 * `live` 里的播放器实测值优先于探测值(width/height/durationSec 三项)。
 */
export function mediaRows(
  info: MediaInfo | null,
  kind: MediaKind,
  live?: { width?: number; height?: number; durationSec?: number },
): Array<[string, string]> {
  if (!info?.ok) return [];
  const rows: Array<[string, string]> = [];

  const w = live?.width ?? info.width;
  const h = live?.height ?? info.height;
  const dur = live?.durationSec ?? info.durationSec;

  if (kind === 'image') {
    if (w && h) {
      // 顺带给像素总量:百万像素是判断「这图够不够放大」最直接的依据
      const mp = (w * h) / 1e6;
      rows.push(['尺寸', `${w} × ${h}${mp >= 0.1 ? ` · ${mp.toFixed(1)} MP` : ''}`]);
    }
    if (info.videoCodec) rows.push(['格式', info.videoCodec.toUpperCase()]);
  }

  if (kind === 'video') {
    if (w && h) {
      // 宽高比是下游判断「能否直接进 h3 / 要不要裁切」的常用信息。
      // 只有**认得出来**的比例才值得显示:854×480 约分后是 427:240 —— 数学上正确,
      // 但对人毫无意义(真实事故:面板上就这么印着「854 × 480 · 427:240」)。
      // 判定用「约分结果是否简单」而不是字符长度:427:240 才 7 个字符,长度阈值拦不住。
      const ratio = simpleRatio(w, h);
      rows.push(['分辨率', `${w} × ${h}${ratio ? ` · ${ratio}` : ''}`]);
    }
    const clock = formatClock(dur);
    if (clock) {
      // 帧数 = 时长 × 帧率只是估算,真实总帧数能从容器读到才显示
      rows.push(['时长', `${clock}${info.frameCount ? ` · ${info.frameCount} 帧` : ''}`]);
    }
    const fps = formatFps(info.fps);
    if (fps) rows.push(['帧率', fps]);
    if (info.videoCodec) rows.push(['视频编码', info.videoCodec.toUpperCase()]);
    // 音轨有无是有实际后果的信息:带音轨的参考视频会触发 h3 的「输出 ≥2 秒」硬规则
    if (info.hasAudio === true) {
      const sr = formatSampleRate(info.sampleRate);
      const ch = formatChannels(info.channels, info.channelLayout);
      rows.push(['音轨', [info.audioCodec?.toUpperCase(), sr, ch].filter(Boolean).join(' · ') || '有']);
    } else if (info.hasAudio === false) {
      rows.push(['音轨', '无(静音)']);
    }
  }

  if (kind === 'audio') {
    const clock = formatClock(dur);
    if (clock) rows.push(['时长', clock]);
    const sr = formatSampleRate(info.sampleRate);
    if (sr) rows.push(['采样率', sr]);
    const ch = formatChannels(info.channels, info.channelLayout);
    if (ch) rows.push(['声道', ch]);
    if (info.audioCodec) rows.push(['音频编码', info.audioCodec.toUpperCase()]);
  }

  if (info.rotation) rows.push(['旋转', `${info.rotation}°(已按显示方向给宽高)`]);
  if (info.bitrateKbps) rows.push(['码率', `${info.bitrateKbps} kbps`]);
  const size = formatBytes(info.sizeBytes);
  if (size) rows.push(['文件', size]);

  return rows;
}

export function MediaInfoPanel({ path, kind, live }: MediaInfoPanelProps) {
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(
    async (p: string) => {
      setLoading(true);
      try {
        const r = await window.bigbotart.probeMedia(p, kind);
        setInfo(r);
      } catch (e) {
        // IPC 本身失败(主进程未就绪等)也要落到「失败」态,不能停在 loading 转圈
        setInfo({ ok: false, error: (e as Error).message || '探测请求失败' });
      } finally {
        setLoading(false);
      }
    },
    [kind],
  );

  useEffect(() => {
    if (!path) {
      setInfo(null);
      return;
    }
    let alive = true;
    setLoading(true);
    void window.bigbotart
      .probeMedia(path, kind)
      .then((r) => {
        if (alive) setInfo(r);
      })
      .catch((e: unknown) => {
        if (alive) setInfo({ ok: false, error: (e as Error).message || '探测请求失败' });
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    // 卸载后不再 setState(检查器会随选中节点切换频繁重挂载)
    return () => {
      alive = false;
    };
  }, [path, kind]);

  if (!path) return null;

  const rows = mediaRows(info, kind, live);

  return (
    <div data-od-id="media-info">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <Lbl>媒体信息</Lbl>
        <button
          className="btn btn-s btn-sm"
          style={{ marginBottom: 8 }}
          disabled={loading}
          onClick={() => void run(path)}
        >
          {loading ? '探测中…' : '重新探测'}
        </button>
      </div>
      {info && !info.ok ? (
        <div className="mut" style={{ fontSize: 11, lineHeight: 1.5 }}>
          探测失败:{info.error}
        </div>
      ) : rows.length ? (
        <div className="kv">
          {rows.map(([k, v]) => (
            <div className="kr" key={k}>
              <span>{k}</span>
              <span className="mono">{v}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mut" style={{ fontSize: 11 }}>
          {loading ? '正在读取媒体信息…' : '未获取到媒体信息'}
        </div>
      )}
    </div>
  );
}
