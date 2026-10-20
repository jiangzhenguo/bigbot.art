/**
 * 本地图片加载失败时的占位。
 *
 * 文件在、浏览器解不开(损坏、协议拒绝、路径失效)时,<img> 会画出碎图标加 alt。
 * 那比「还没生成」更像故障。onError 换成这块占位,换 src 后重新尝试。
 */
import { useEffect, useState } from 'react';

export function ImageFail({
  fill = false,
  compact = false,
  style,
}: {
  /** 填满已有尺寸的父框(资源卡、时间线小封面) */
  fill?: boolean;
  /** 只留图标,给高度不够放文字的小格 */
  compact?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`img-fail${fill ? ' fill' : ''}${compact ? ' compact' : ''}`}
      style={style}
      role="img"
      aria-label="无法显示"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m3 16 5-4 3 2 3-3 7 6" />
        <path d="M4 4l16 16" />
      </svg>
      {compact ? null : <span>无法显示</span>}
    </div>
  );
}

export function SafeImage({
  src,
  alt,
  draggable = false,
  fill = false,
  compact = false,
  style,
  loading,
  onClick,
}: {
  src: string;
  alt: string;
  draggable?: boolean;
  fill?: boolean;
  compact?: boolean;
  style?: React.CSSProperties;
  loading?: 'lazy' | 'eager';
  onClick?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  if (failed) return <ImageFail fill={fill} compact={compact} style={style} />;
  return (
    <img
      src={src}
      alt={alt}
      draggable={draggable}
      style={style}
      loading={loading}
      onClick={onClick}
      onError={() => setFailed(true)}
    />
  );
}
