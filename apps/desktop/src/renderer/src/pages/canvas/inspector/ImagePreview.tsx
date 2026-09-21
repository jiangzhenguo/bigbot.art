import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

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
 * 全屏 = 应用内覆盖层(复用 .ovl 遮罩):Esc / 点击遮罩 / ✕ 关闭,不影响画布状态。
 * 纯展示组件,不触碰 window.bigbotart。
 */
export function ImagePreview({ src, alt = '图片预览', label, emptyHint }: ImagePreviewProps) {
  const [full, setFull] = useState(false);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

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
        <img
          src={src}
          alt={alt}
          style={{ display: 'block', width: '100%', maxHeight: 240, objectFit: 'contain' }}
        />
        <button
          type="button"
          className="btn btn-s btn-sm"
          data-od-id="image-preview-fullscreen"
          style={{ position: 'absolute', right: 6, bottom: 6 }}
          title="全屏显示图片"
          onClick={() => setFull(true)}
        >
          ⛶ 全屏
        </button>
      </div>
      {full
        ? createPortal(
            <div className="ovl" data-od-id="image-preview-lightbox" onClick={() => setFull(false)}>
              <button
                type="button"
                className="btn btn-s btn-sm"
                style={{ position: 'absolute', top: 14, right: 14 }}
                onClick={() => setFull(false)}
              >
                ✕ 关闭
              </button>
              <img
                src={src}
                alt={alt}
                onClick={(e) => e.stopPropagation()}
                style={{
                  maxWidth: '90vw',
                  maxHeight: '86vh',
                  objectFit: 'contain',
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--glass-shadow-lg)',
                }}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}