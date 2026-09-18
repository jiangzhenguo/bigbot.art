/**
 * ErrorCard — 对话失败错误卡(LLM 不可达等;agent-cards.html ④)
 * 工具执行失败不走这里,走 ToolRunCard 失败行。
 */
import React from 'react';

export function ErrorCard({
  title,
  detail,
  retryText,
  onRetry,
  onOpenSettings,
}: {
  title: string;
  detail: string;
  retryText?: string;
  onRetry?: (text: string) => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="msg-agent err" data-od-id="agent-error">
      <div className="eh">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 4 2.8 19.2h18.4L12 4Z" />
          <path d="M12 10v4" />
          <circle cx="12" cy="16.6" r=".9" fill="currentColor" stroke="none" />
        </svg>
        {title}
      </div>
      <div className="mut" style={{ marginTop: 4, fontSize: '11px' }}>{detail}</div>
      <div className="row g8" style={{ marginTop: 8 }}>
        {retryText && onRetry ? (
          <button className="btn btn-s btn-sm" onClick={() => onRetry(retryText)}>
            重试本轮
          </button>
        ) : null}
        <button className="btn btn-g btn-sm" onClick={onOpenSettings}>
          打开设置
        </button>
      </div>
    </div>
  );
}

export default ErrorCard;
