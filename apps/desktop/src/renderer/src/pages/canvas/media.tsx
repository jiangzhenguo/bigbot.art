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
        style={{ width: '100%', height: '100%', objectFit: 'fill', display: 'block' }}
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
