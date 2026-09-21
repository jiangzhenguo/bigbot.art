import React, { useRef, useState } from 'react';

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

/** 视频封面:从 <video> metadata 读真实宽高,按视频比例展示(不再固定 16:9);
 *  鼠标悬停从头循环播放,移出暂停复位(产品既有交互,保留) */
export function VideoThumb({ src, badge }: { src: string; badge?: string }) {
  const [ar, setAr] = useState<string | undefined>();
  const vRef = useRef<HTMLVideoElement | null>(null);

  const playOnHover = () => {
    const v = vRef.current;
    if (!v) return;
    v.currentTime = 0;
    v.play().catch(() => {});
  };
  const pauseOnLeave = () => {
    const v = vRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = 0;
  };

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
