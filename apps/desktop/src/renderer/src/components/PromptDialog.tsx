import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface PromptDialogProps {
  title: string;
  initial?: string;
  placeholder?: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}

/**
 * 应用内输入弹层(替代 window.prompt —— Electron 不支持 prompt(),调用会抛
 * 「prompt() is and will not be supported」)。纯展示组件。
 * 复用 .ovl 遮罩 + portal 到 body(脱离祖先包含块):Esc/点击遮罩 = 取消,Enter/确定 = 确认。
 */
export function PromptDialog({ title, initial = '', placeholder, onCancel, onConfirm }: PromptDialogProps) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return createPortal(
    <div className="ovl" data-od-id="prompt-dialog" onClick={onCancel}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 320,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: '16px 18px',
          background: 'var(--bg)',
          border: '1px solid var(--border-soft)',
          borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--elev-raised)',
        }}
      >
        <div className="lbl" style={{ fontSize: 13, fontWeight: 600 }}>
          {title}
        </div>
        <input
          ref={inputRef}
          className="input-w mono"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onConfirm(value);
          }}
          style={{ width: '100%' }}
        />
        <div className="row g6" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-s btn-sm" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn btn-p btn-sm" onClick={() => onConfirm(value)}>
            确定
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}