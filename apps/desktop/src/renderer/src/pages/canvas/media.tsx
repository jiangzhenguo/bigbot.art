import React, { useCallback, useEffect, useRef, useState } from 'react';
import { WAVE_BARS } from './constants';

export function basenameOf(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? p;
}

/** 绝对产物路径 → bba-output:// 相对 URL(保留 mock/、images/ 等子目录) */
export function outputUrlOf(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const markers = ['/.bigbotart/outputs/', '/outputs/'];
  for (const m of markers) {
    const i = norm.lastIndexOf(m);
    if (i >= 0) {
      const rel = norm.slice(i + m.length);
      return `bba-output://${rel.split('/').map(encodeURIComponent).join('/')}`;
    }
  }
  return `bba-output://${encodeURIComponent(basenameOf(p))}`;
}

/**
 * 秒 → 人类可读时长(空值/非法值返回 null,由调用方决定不显示)。
 *
 * 用于 Take 历史/检查器的「生成时长」展示:低于 1 分钟只给秒,否则「N分M秒」;
 * 秒数取整(生成耗时是墙钟秒,小数位没有信息量)。
 * 非有限数(NaN / Infinity)一律当缺失 —— `Math.round(NaN)` 会渲染成「NaN秒」。
 */
export function formatDurationSec(sec: number | null | undefined): string | null {
  if (sec === null || sec === undefined) return null;
  const s = Number(sec);
  if (!Number.isFinite(s) || s < 0) return null;
  const total = Math.round(s);
  if (total < 60) return `${total}秒`;
  const m = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${m}分` : `${m}分${rest}秒`;
}

/** 缩略图 src(asset localPath → bba-asset://) */
export function thumbSrc(assetPath: string | undefined): string | null {
  if (!assetPath) return null;
  return `bba-asset://${assetPath.split('/').pop()}`;
}

/** 统一本地路径 → 可显示 URL:产物(outputs/)走 bba-output,资产库走 bba-asset */
export function previewUrlOf(p: string | null | undefined): string | null {
  if (!p) return null;
  return p.includes('/outputs/') ? outputUrlOf(p) : thumbSrc(p);
}

/** 视频扩展名白名单(与主进程 assets.ts 的 MIME_BY_EXT 同口径) */
const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;

/**
 * 该路径是否为视频文件。
 *
 * 取文件名再判扩展名,而不是直接测整串:目录名里带 `.mov` 之类会误判,
 * 且 h3 产物路径形如 `outputs/frames/shot-1.mp4/` 这类前缀命中也会传染。
 */
export function isVideoPath(p: string | null | undefined): boolean {
  if (!p) return false;
  return VIDEO_EXT_RE.test(basenameOf(p));
}

/**
 * 参考绑定槽位/资源卡的缩略图 —— **视频必须走 <video> 抽帧,不能塞进 <img>**。
 *
 * 真实事故(2026-09):检查器「参考绑定」只写 `<img draggable={false} src={thumbSrc(path)}>`,
 * 当 ref 是视频(asset 视频素材 / 上游镜头整段成片)时拿到的是
 * `bba-asset://asset-x.mp4`,而 `<img draggable={false} src=…mp4>` 是**必然 onerror**(浏览器不做视频解码),
 * 于是参考视频那一行左侧只剩一块空框。
 *
 * 注意**不能用 `isShotSrc`(有没有 path 字段)来判断是否为视频** —— 资产视频的 ref 只有
 * `assetId`,同样得到空框。唯一可靠依据是 URL/路径的扩展名。
 *
 * 返回 null = 调用方渲染 VideoPoster(抽帧 → 失败自动回退 VideoThumb)。
 */
export function thumbImageSrc(
  p: string | null | undefined,
): { kind: 'img'; src: string } | { kind: 'video' } | null {
  if (!p) return null;
  const src = p.includes('/outputs/') ? outputUrlOf(p) : thumbSrc(p);
  if (!src) return null;
  return isVideoPath(p) ? { kind: 'video' } : { kind: 'img', src };
}

/** 宽/高 → 合法 32 倍数(小于 32 取 32;h3 硬性要求) */
export function clamp32(v: number, fallback = 544): number {
  const n = Number.isFinite(v) && v > 0 ? v : fallback;
  return Math.max(32, Math.round(n / 32) * 32);
}

/* ── 视频封面帧缓存(P2) ──
   「渲染视频时画布卡」的主因之一:画布上大量真实 <video> 元素。
   即使只给 preload="metadata"、从不播放,Chromium 也要为每个 video 维护
   独立的媒体合成层与解码器上下文;节点一多就是几十个。

   思路:纯展示场景(分镜表里的一格封面)没必要常驻 video ——
   挂一个隐藏 video 抽第一帧到 canvas,转成 dataURL 后**立刻卸载 video**,
   之后只渲染 <img>。缓存按 src 复用,同一视频不重复抽帧。 */
const posterCache = new Map<string, string>();
/** 抽帧中的 promise(同一 src 并发请求时复用,避免重复挂 video) */
const posterPending = new Map<string, Promise<string | null>>();

/**
 * 首帧「几乎全黑」判定 —— 见到纯黑封面等于没封面。
 *
 * 真实案例(2026-09):素材视频 `asset-1790491690265-qpsg.mp4` 首帧平均亮度 8/255(近全黑),
 * 抽帧**成功**却给出一个纯黑方块 —— 和修复前的空框一样让用户以为「封面没展示」。
 * 因此抽帧后统计亮度,过暗就当作失败,回退真实 `<video>`(它同样显示首帧为黑,
 * 但至少是可悬停播放的元素,且能区分「视频就是这么黑」与「缩略图坏了」)。
 *
 * 阈值刻意取「像素均值 <16 且没有亮像素」而不是单纯均值:
 * 夜景/黑底字幕视频常有少量高光,那些仍应正常显示。
 */
export function hasVisibleContent(data: Uint8ClampedArray | Uint8Array): boolean {
  let sum = 0;
  let bright = 0;
  const n = Math.floor(data.length / 4);
  if (n === 0) return false;
  for (let i = 0; i < data.length; i += 4) {
    const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
    sum += v;
    if (v > 60) bright += 1;
  }
  return bright >= 3 || sum / n >= 16;
}

/**
 * 抽帧所需的最小 DOM 能力(依赖注入)。
 *
 * 抽出来有两个理由:
 *  ① 可测 —— 纯 node 环境(本项目 vitest 跑在 environment:'node'、且未装 jsdom)
 *     也能覆盖缓存/并发/失败回退这些真正的逻辑,不必为了测一段状态机引依赖;
 *  ② 意图清晰 —— 这个函数只碰这几样东西,没有隐藏的全局耦合。
 */
export interface PosterDeps {
  /** 造一个 video 元素(调用方负责在 finally 里释放) */
  createVideo: () => HTMLVideoElement;
  /** 造一个 canvas 并返回 2d context(不可用时返回 null) */
  createCanvas: (w: number, h: number) => {
    draw: (v: HTMLVideoElement) => void;
    toDataURL: () => string;
    /** 取像素(可选):用于首帧过暗判定;缺失时跳过该判定,行为与旧版一致 */
    sample?: () => Uint8ClampedArray | null;
  } | null;
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
}

/** 浏览器环境默认实现 */
const browserDeps: PosterDeps = {
  createVideo: () => document.createElement('video'),
  createCanvas: (w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    return {
      draw: (v) => ctx.drawImage(v, 0, 0, w, h),
      toDataURL: () => c.toDataURL('image/jpeg', 0.72),
      sample: () => {
        try {
          return ctx.getImageData(0, 0, w, h).data;
        } catch {
          // canvas 被跨源污染等 → 无法判定,交由调用方按「有内容」处理
          return null;
        }
      },
    };
  },
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

/**
 * 把视频首帧抽成 dataURL(纯渲染层,不走 IPC)。
 * 失败/超时返回 null,调用方回退到真实 <video>(宁可多一个元素,也不能白屏)。
 *
 * @param deps 仅测试注入;生产走 browserDeps
 */
export function extractPoster(
  src: string,
  timeoutMs = 8000,
  deps: PosterDeps = browserDeps,
): Promise<string | null> {
  const hit = posterCache.get(src);
  if (hit) return Promise.resolve(hit);
  const inflight = posterPending.get(src);
  if (inflight) return inflight;

  const task = new Promise<string | null>((resolve) => {
    const v = deps.createVideo();
    let done = false;
    const finish = (url: string | null) => {
      if (done) return;
      done = true;
      deps.clearTimeout(timer);
      v.removeAttribute('src');
      v.load(); // 主动释放解码器,别把临时元素留在后台
      posterPending.delete(src);
      if (url) posterCache.set(src, url);
      resolve(url);
    };
    const timer = deps.setTimeout(() => finish(null), timeoutMs);

    // 抽帧不需要声音,且必须 muted 才允许在无用户手势下 play/seek
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';

    v.onloadeddata = () => {
      try {
        const w = v.videoWidth;
        const h = v.videoHeight;
        if (!w || !h) return finish(null);
        // 缩到卡片级尺寸即可(封面最宽约 236px),避免大图 dataURL 占内存
        const scale = Math.min(1, 320 / w);
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));
        const canvas = deps.createCanvas(cw, ch);
        if (!canvas) return finish(null);
        canvas.draw(v);
        // 抽帧成功但画面近全黑 → 等同于「没有封面」,回退真实 <video>(见 hasVisibleContent 注释)
        const px = canvas.sample?.();
        if (px && !hasVisibleContent(px)) return finish(null);
        finish(canvas.toDataURL());
      } catch {
        // 跨源污染 canvas 等 → 放弃封面,回退真实 video
        finish(null);
      }
    };
    v.onerror = () => finish(null);
    v.src = src;
  });

  posterPending.set(src, task);
  return task;
}

/**
 * 视频静态封面帧:抽帧成功渲染 <img>,失败回退真实 <video>(VideoThumb)。
 *
 * 用于**纯展示**场景(分镜表的一格封面)——那里不需要 hover 播放,
 * 常驻 video 元素纯属浪费。需要 hover 播放的地方(主产物预览)仍用 VideoThumb。
 */
export function VideoPoster({
  src,
  alt,
  badge,
  style,
}: {
  src: string;
  alt?: string;
  badge?: string;
  style?: React.CSSProperties;
}) {
  const [poster, setPoster] = React.useState<string | null>(() => posterCache.get(src) ?? null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    const hit = posterCache.get(src);
    if (hit) {
      setPoster(hit);
      setFailed(false);
      return;
    }
    setPoster(null);
    setFailed(false);
    void extractPoster(src).then((url) => {
      if (!alive) return;
      if (url) setPoster(url);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [src]);

  // 抽帧失败(编码不支持/超时):回退真实 video,保证不白屏
  if (failed) return <VideoThumb src={src} badge={badge} />;

  if (!poster) {
    // 抽帧中:给一块与视频容器同色的占位,避免布局跳动
    return <span style={{ display: 'block', width: '100%', height: '100%', background: 'var(--media-bg)', ...style }} />;
  }
  return <img draggable={false} src={poster} alt={alt ?? ''} style={style} />;
}

/**
 * 视频封面:从 <video> metadata 读真实宽高,按视频比例展示(不再固定 16:9);
 * 鼠标悬停从头循环播放,移出暂停复位(产品既有交互,保留)。
 *
 * 播放可靠性(2026-09 修复「视频卡住后再次划过不自动播放」):
 * 旧实现是「mouseenter → currentTime=0 → play()」一把梭,`play()` 的 reject 被 `.catch(()=>{})`
 * 静默吞掉。视频只有 `preload="metadata"`,首次划过时往往 `readyState < HAVE_FUTURE_DATA`
 * (只有元数据、还没缓冲到能播),`play()` 当场被拒 —— 而 `loop` 让 `ended` 永不触发、
 * mouseenter 也不重试,于是元素停在 paused 且**没有任何救回路径**,表现为「卡住,再划过也不播」。
 *
 * 现在把「想播」抽成独立意图(hoverRef),用**事件驱动**真正播放:
 *  - `canplay` / `loadeddata` 到达时,只要指针仍在卡片上就重新 `play()`(缓冲慢也能自动接上);
 *  - `play()` 被拒时不再丢弃 —— 挂一次性 `canplay` 重试(带计数上限,防极端下无限重试);
 *  - 移出时 `pause()` + 复位,并把意图置 false,避免离场后事件回调又把视频点起来。
 * 关键:意图与重试都走 ref(不依赖 React 状态),因为 StrictMode 下混进 setState 的副作用会双跑。
 */
export function VideoThumb({ src, badge }: { src: string; badge?: string }) {
  const [ar, setAr] = useState<string | undefined>();
  const vRef = useRef<HTMLVideoElement | null>(null);
  /** 指针是否停在卡片上(「想播」意图;事件回调据此决定要不要续播) */
  const hoverRef = useRef(false);
  /** 连续重试次数(每次真正 play 成功即清零;防止异常视频无限重试) */
  const retryRef = useRef(0);

  /** 真正尝试播放:失败则挂一次性 canplay 重试(最多 3 次),而不是静默丢弃 */
  const tryPlay = useCallback(() => {
    const v = vRef.current;
    if (!v || !hoverRef.current) return;
    v.play().then(
      () => {
        retryRef.current = 0;
      },
      () => {
        // 常见于「元数据已到、数据还不够」:等下一次 canplay 再试,别把错误吞掉就完事
        if (!hoverRef.current || retryRef.current >= 3) return;
        retryRef.current += 1;
        const onReady = () => {
          v.removeEventListener('canplay', onReady);
          tryPlay();
        };
        v.addEventListener('canplay', onReady, { once: true });
      },
    );
  }, []);

  const playOnHover = useCallback(() => {
    const v = vRef.current;
    if (!v) return;
    hoverRef.current = true;
    retryRef.current = 0;
    // 只在需要时复位,避免每次 mouseenter 都打断已经在播的循环
    if (v.readyState >= 1 && v.currentTime > 0) v.currentTime = 0;
    tryPlay();
  }, [tryPlay]);

  const pauseOnLeave = useCallback(() => {
    const v = vRef.current;
    if (!v) return;
    hoverRef.current = false;
    v.pause();
    // 仅在元数据就绪时复位(未就绪时设 currentTime 会被忽略并可能抛错)
    if (v.readyState >= 1) v.currentTime = 0;
  }, []);

  /** 缓冲/加载到位:指针仍在卡片上就接着播(覆盖「首次划过时数据不足」的主场景) */
  const resumeIfHovered = useCallback(() => {
    const v = vRef.current;
    if (!v || !hoverRef.current) return;
    if (v.paused) tryPlay();
  }, [tryPlay]);

  // 换绑视频源时重置意图与重试计数(节点可能被复用渲染另一个 asset)
  useEffect(() => {
    hoverRef.current = false;
    retryRef.current = 0;
  }, [src]);

  return (
    <div
      className="nthumb"
      style={{ position: 'relative', background: 'var(--media-bg)', aspectRatio: ar ?? '16/9', overflow: 'hidden' }}
      onMouseEnter={playOnHover}
      onMouseLeave={pauseOnLeave}
    >
      <video
        ref={vRef}
        src={src}
        preload="metadata"
        muted
        loop
        playsInline
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (v.videoWidth && v.videoHeight) setAr(`${v.videoWidth} / ${v.videoHeight}`);
        }}
        // 数据到位 + 指针还在卡片上 → 续播;这是「卡住后不再自动播放」的兜底路径
        onCanPlay={resumeIfHovered}
        onLoadedData={resumeIfHovered}
        /* objectFit 用 contain 而非 fill(P2):外层容器已按视频真实宽高比设置
           aspectRatio,contain 不会产生黑边;而 fill 会触发非等比拉伸的额外
           重采样路径 —— 视频与容器比例一致时它纯属白付代价。 */
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
      />
      {badge ? (
        <span
          className="nmeta mono"
          style={{ position: 'absolute', left: 6, bottom: 6, margin: 0, background: 'var(--on-media-bg)', color: 'var(--on-media)', padding: '2px 7px', borderRadius: 6, fontSize: 10 }}
        >
          {badge}
        </span>
      ) : null}
    </div>
  );
}

/* ───────────────────────── 音频播放(audio-ref 节点) ───────────────────────── */

/** 音频扩展名白名单(与主进程 assets.ts 的 MIME_BY_EXT 同口径) */
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|aac|flac|ogg)$/i;

/** 该路径是否为音频文件(同样先取 basename,避免目录名误命中) */
export function isAudioPath(p: string | null | undefined): boolean {
  if (!p) return false;
  return AUDIO_EXT_RE.test(basenameOf(p));
}

/**
 * 秒 → `m:ss`(播放器时间轴用)。
 *
 * 与 `formatDurationSec` 分开是因为用途不同:那个是「生成耗时」的人读文案(「3分20秒」),
 * 这个是播放器上的紧凑计时(「3:20」),且**必须容忍 NaN** ——
 * 音频还没 loadedmetadata 时 `duration` 是 NaN,直接渲染会出现「NaN:NaN」。
 * 非有限值/负数一律回 `0:00`,让 UI 有个确定的样子。
 */
export function formatClock(sec: number | null | undefined): string {
  const s = Number(sec);
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const total = Math.floor(s);
  const m = Math.floor(total / 60);
  const rest = total % 60;
  return `${m}:${String(rest).padStart(2, '0')}`;
}

/** 播放进度 0~1(时长未知/非法时回 0,供波形高亮用) */
export function playProgress(current: number, duration: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(1, Math.max(0, current / duration));
}

/**
 * 音频播放器(节点卡与检查器共用)。
 *
 * 为什么不用 `<audio controls>` 原生控件:
 *  1. 原生控件在 224px 宽的节点卡里会被裁掉一半(时间/音量挤不下);
 *  2. 项目视觉语言是自绘的波形条(`.wave`),原生控件风格完全对不上。
 * 故自绘:波形 + 点击定位 + 播放/暂停 + 时间。
 *
 * ⚠️ **拖动进度条不要用 onInput 直接改 state**:`onTimeUpdate` 在播放时会持续回写
 * `current`,与用户拖拽互相打架(表现为拖动时指针乱跳)。这里的做法是拖拽期间
 * 用 `scrubbingRef` 冻结 timeupdate 的写入,松手才同步。
 */
export function AudioPlayer({
  src,
  name,
  compact,
}: {
  src: string;
  /** 文件名(展示用;缺省不显示) */
  name?: string;
  /** 紧凑模式(节点卡内;检查器用完整尺寸) */
  compact?: boolean;
}) {
  const aRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  /** 加载失败原因(未绑定/文件缺失时给出人话,而不是一个死按钮) */
  const [err, setErr] = useState<string | null>(null);
  /** 拖拽中:冻结 timeupdate 回写,避免与用户操作互相覆盖 */
  const scrubbingRef = useRef(false);

  const toggle = useCallback(() => {
    const a = aRef.current;
    if (!a || err) return;
    if (a.paused) {
      // 播放失败(格式不支持/文件损坏)必须让用户看见,不能静默什么都不发生
      void a.play().catch((e: unknown) => {
        setErr(`无法播放:${(e as Error).message}`);
        setPlaying(false);
      });
      setPlaying(true);
    } else {
      a.pause();
      setPlaying(false);
    }
  }, [err]);

  /** 波形点击/拖动定位:ratio 0~1 */
  const seekTo = useCallback((ratio: number) => {
    const a = aRef.current;
    if (!a || !Number.isFinite(a.duration) || a.duration <= 0) return;
    const t = Math.min(a.duration, Math.max(0, ratio * a.duration));
    a.currentTime = t;
    setCurrent(t);
  }, []);

  const pct = playProgress(current, duration);
  /** 已播过的波形条数(高亮到播放头) */
  const playedBars = Math.round(pct * WAVE_BARS.length);

  return (
    <div className={`aud${compact ? ' compact' : ''}`}>
      <audio
        ref={aRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const a = e.currentTarget;
          if (Number.isFinite(a.duration)) setDuration(a.duration);
        }}
        onTimeUpdate={(e) => {
          if (!scrubbingRef.current) setCurrent(e.currentTarget.currentTime);
        }}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
          const a = aRef.current;
          if (a) a.currentTime = 0;
        }}
        onError={() => setErr('音频加载失败(文件可能已被移动或删除)')}
      />
      <button
        className="aud-play"
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
        disabled={!!err}
        title={err ?? (playing ? '暂停' : '播放')}
        aria-label={playing ? '暂停' : '播放'}
      >
        {playing ? (
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M8 5.5v13l11-6.5z" />
          </svg>
        )}
      </button>
      {/* 波形即进度条:已播部分高亮,点击/拖动定位 */}
      <div
        className="aud-wave"
        role="slider"
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct * 100)}
        tabIndex={0}
        onPointerDown={(e) => {
          e.stopPropagation();
          scrubbingRef.current = true;
          const r = e.currentTarget.getBoundingClientRect();
          seekTo((e.clientX - r.left) / r.width);
        }}
        onPointerMove={(e) => {
          if (!scrubbingRef.current) return;
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          seekTo((e.clientX - r.left) / r.width);
        }}
        onPointerUp={() => {
          scrubbingRef.current = false;
        }}
        onPointerLeave={() => {
          scrubbingRef.current = false;
        }}
      >
        {WAVE_BARS.map((h, i) => (
          <i key={i} style={{ height: h }} className={i < playedBars ? 'on' : undefined} />
        ))}
      </div>
      <span className="aud-time mono">
        {formatClock(current)}/{formatClock(duration)}
      </span>
      {name && !compact ? <span className="aud-name mono">{name}</span> : null}
      {err ? <span className="aud-err">{err}</span> : null}
    </div>
  );
}
