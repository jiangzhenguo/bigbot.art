import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { TimelineData } from '@bigbotart/shared';

/**
 * 时间线成片预览器 — 参考 states.html「时间线 / 剪辑 · 已生成成片」的 .npv 内嵌播放器
 *  - stage:视频画面(真实 <video>;未加载出封面时黑底 + 中央播放钮)
 *  - chip:左上「成片 · 分辨率 / 素材原始」
 *  - ctl:播放/暂停 + 时间码 + 进度条 + 静音 + 全屏
 *  - meta:格式 · 时长 · 音轨;下方多平台 chips(保留 lastExport 信息)
 */
export function TimelineExportPreview({
  lastExport,
  compact = true,
}: {
  lastExport: NonNullable<TimelineData['lastExport']>;
  compact?: boolean;
}): React.ReactElement {
  const vRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  // video 初始 muted=true(hover 无手势方可自动播放);用户点静音切换
  const [muted, setMuted] = useState(true);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(lastExport.durationSec ?? 0);
  /** 成片加载失败(文件被移动/删除):给文字兜底,而不是留一块黑屏让人以为「只是没播」 */
  const [loadErr, setLoadErr] = useState(false);

  const togglePlay = useCallback(() => {
    const v = vRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().then(() => setPlaying(true)).catch(() => {});
    } else {
      v.pause();
      setPlaying(false);
    }
  }, []);

  /** 鼠标悬停:从头循环播放(与镜头节点卡 VideoThumb 一致) */
  const playOnHover = useCallback(() => {
    const v = vRef.current;
    if (!v) return;
    v.currentTime = 0;
    v.play().then(() => setPlaying(true)).catch(() => {});
  }, []);

  /** 鼠标移出:暂停并复位到开头 */
  const pauseOnLeave = useCallback(() => {
    const v = vRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = 0;
    setPlaying(false);
  }, []);

  const seek = useCallback((clientX: number, el: HTMLElement) => {
    const v = vRef.current;
    if (!v) return;
    const r = el.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    v.currentTime = (v.duration || 0) * p;
    setT(v.currentTime);
  }, []);

  const toggleMute = useCallback(() => {
    const v = vRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  }, []);

  const toggleFull = useCallback(() => {
    const v = vRef.current;
    if (!v) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void v.requestFullscreen?.();
  }, []);

  useEffect(() => {
    setLoadErr(false);
    const v = vRef.current;
    if (!v) return;
    const onTime = () => setT(v.currentTime);
    const onMeta = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) setDur(v.duration);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
    };
  }, [lastExport.path]);

  const fmt = (s: number): string => {
    s = Math.max(0, s);
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${m < 10 ? '0' : ''}${m}:${ss < 10 ? '0' : ''}${ss}`;
  };

  const fmtLabel = lastExport.format === 'prores' ? 'ProRes' : 'FFmpeg · H.264+AAC';
  const volInfo = '−14 LUFS';

  return (
    <div className={`npv${compact ? '' : ' npv-lg'}`} data-od-id="timeline-export-preview">
      {loadErr ? (
        <div
          style={{
            aspectRatio: '16/9',
            display: 'grid',
            placeItems: 'center',
            background: 'var(--surface-warm)',
            border: '1.5px dashed var(--border)',
            color: 'var(--meta)',
            fontSize: 11,
            textAlign: 'center',
            padding: '0 16px',
            lineHeight: 1.7,
          }}
        >
          成片无法加载:{lastExport.name ?? '导出文件'} 可能已被移动或删除
          <br />
          重新导出即可恢复预览
        </div>
      ) : (
      <div
        className="pv-stage"
        onClick={togglePlay}
        onMouseEnter={playOnHover}
        onMouseLeave={pauseOnLeave}
      >
        <video
          ref={vRef}
          src={lastExport.path}
          preload="metadata"
          muted
          loop
          playsInline
          onError={() => setLoadErr(true)}
          onClick={(e) => {
            e.stopPropagation();
            togglePlay();
          }}
          style={{ width: '100%', display: 'block', background: 'var(--media-bg)', aspectRatio: '16/9', objectFit: 'contain' }}
        />
        {!playing && (
          <button
            className="pv-big"
            aria-label="播放"
            title="播放 / 暂停"
            onClick={(e) => {
              e.stopPropagation();
              togglePlay();
            }}
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5.5v13l11-6.5Z" />
            </svg>
          </button>
        )}
        <span className="pv-chip mono">
          成片 · {lastExport.resolution && lastExport.resolution !== 'source' ? lastExport.resolution : '素材原始'}
        </span>
        <div className="pv-ctl" onClick={(e) => e.stopPropagation()}>
          <span className="tc">
            {fmt(t)} / {fmt(dur)}
          </span>
          <span
            className="pv-track"
            aria-hidden="true"
            onPointerDown={(e) => seek(e.clientX, e.currentTarget)}
          >
            <i style={{ width: `${(dur > 0 ? (t / dur) * 100 : 0).toFixed(1)}%` }}></i>
          </span>
          <button className="pv-btn" aria-label="静音" title="静音" onClick={toggleMute}>
            {muted ? (
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M4 9v6h4l5 4V5L8 9H4Z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M4 9v6h4l5 4V5L8 9H4Z" />
                <path d="M16.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
              </svg>
            )}
          </button>
          <button className="pv-btn" aria-label="全屏" title="全屏" onClick={toggleFull}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
            </svg>
          </button>
        </div>
      </div>
      )}
      {!compact ? (
        <div className="pv-meta">
          <span className="mono mut" style={{ fontSize: 11 }}>
            {fmtLabel} · {dur.toFixed(1)}s · {volInfo}
          </span>
        </div>
      ) : null}
    </div>
  );
}