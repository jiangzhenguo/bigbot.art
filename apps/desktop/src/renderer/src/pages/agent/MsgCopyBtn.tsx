/**
 * MsgCopyBtn — 对话气泡复制按钮(用户消息 / 助手回复共用)
 *
 * 复制纯文本(助手侧为 Markdown 原文,便于粘贴);成功后图标短暂切成勾。
 * 用本地态反馈,不依赖 toast 链路,避免给展示组件多穿一层 props。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { copyTextToClipboard } from '@bigbotart/shared';

export function MsgCopyBtn({
  text,
  className,
  label = '复制',
}: {
  text: string;
  /** 额外 class(如 msg-copy--user / msg-copy--agent) */
  className?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const onCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const t = text.trim();
      if (!t) return;
      copyTextToClipboard(t, (msg) => {
        if (msg !== '已复制') return;
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1600);
      });
    },
    [text],
  );

  if (!text.trim()) return null;

  return (
    <button
      type="button"
      className={`msg-copy${className ? ` ${className}` : ''}${copied ? ' ok' : ''}`}
      data-od-id="msg-copy"
      title={copied ? '已复制' : label}
      aria-label={copied ? '已复制' : label}
      onClick={onCopy}
    >
      {copied ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <rect x="8" y="8" width="12" height="12" rx="2" />
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" strokeLinecap="round" />
        </svg>
      )}
      <span>{copied ? '已复制' : label}</span>
    </button>
  );
}

export default MsgCopyBtn;
