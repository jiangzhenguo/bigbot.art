import React, { useCallback, useEffect, useRef, useState } from 'react';

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
  createCanvas: (w: number, h: number) => { draw: (v: HTMLVideoElement) => void; toDataURL: () => string } | null;
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
    return <span style={{ display: 'block', width: '100%', height: '100%', background: '#000', ...style }} />;
  }
  return <img src={poster} alt={alt ?? ''} style={style} />;
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
      style={{ position: 'relative', background: '#000', aspectRatio: ar ?? '16/9', overflow: 'hidden' }}
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
          style={{ position: 'absolute', left: 6, bottom: 6, margin: 0, background: 'rgba(0,0,0,.55)', color: '#fff', padding: '2px 7px', borderRadius: 6, fontSize: 10 }}
        >
          {badge}
        </span>
      ) : null}
    </div>
  );
}
