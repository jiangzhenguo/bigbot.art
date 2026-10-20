import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ImageFail } from '../../../components/SafeImage';
import { ImageLightbox } from './ImageLightbox';

interface ImagePreviewProps {
  /** 可直接显示的 URL(bba-asset:// / bba-output://)或 null(未绑定) */
  src: string | null;
  alt?: string;
  /** 小节名(显示在图片上方的 lbl) */
  label?: string;
  /** 无源时的提示文案(与 label 同列,缺省不渲染) */
  emptyHint?: string;
}

/**
 * 检查器图片预览:完整显示源图(object-fit: contain)+「⛶ 全屏」按钮。
 * 全屏 = 应用内覆盖层(ImageLightbox):Esc / 点击背景 / 关闭按钮,不影响画布状态;
 * 覆盖层内支持放大缩小(按钮 / 滚轮 / Mac 触控板双指捏合 / 双击)与拖动平移,
 * 详见 `ImageLightbox` 顶部注释。点击缩略图本身也进入全屏(与主流看图交互一致)。
 * 纯展示组件,不触碰 window.bigbotart。
 */
export function ImagePreview({ src, alt = '图片预览', label, emptyHint }: ImagePreviewProps) {
  const [full, setFull] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  /* 源图被换掉(切 Take / 换节点)时关掉全屏层:否则悬着一层显示旧图的覆盖层 */
  useEffect(() => {
    setFull(false);
    setFailed(false);
  }, [src]);

  if (!src) {
    if (!emptyHint) return null;
    return (
      <div data-od-id="image-preview-empty">
        {label ? <div className="lbl">{label}</div> : null}
        <div className="f-hint">{emptyHint}</div>
      </div>
    );
  }

  return (
    <div data-od-id="image-preview">
      {label ? <div className="lbl">{label}</div> : null}
      <div
        style={{
          position: 'relative',
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden',
          border: '1px solid var(--border-soft)',
          background: 'var(--surface-warm)',
        }}
      >
        {failed ? (
          <ImageFail style={{ maxHeight: 240 }} />
        ) : (
          <img
            src={src}
            alt={alt}
            title="点击全屏查看(可放大 / 双指缩放)"
            style={{ display: 'block', width: '100%', maxHeight: 240, objectFit: 'contain', cursor: 'zoom-in' }}
            onClick={() => setFull(true)}
            onError={() => setFailed(true)}
          />
        )}
        {failed ? null : (
        <button
          type="button"
          className="btn btn-s btn-sm"
          data-od-id="image-preview-fullscreen"
          style={{ position: 'absolute', right: 6, bottom: 6 }}
          title="全屏显示图片(支持放大 / 双指缩放)"
          onClick={() => setFull(true)}
        >
          ⛶ 全屏
        </button>
        )}
      </div>
      {full ? createPortal(<ImageLightbox src={src} alt={alt} onClose={() => setFull(false)} />, document.body) : null}
    </div>
  );
}
