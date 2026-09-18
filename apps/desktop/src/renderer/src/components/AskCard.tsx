/**
 * AskCard — ask.user 确认卡片(设计文档 §1.5 / agent-cards.html ③)
 *
 * Agent 调 ask.user 暂停对话 → 渲染确认卡(问题 + 2~6 选项):
 * - 问题支持 Markdown(含 GFM 表格,方案对比用)
 * - 选项:字母序号圆 A~F + 主文案 + 灰色副说明 + 中性「推荐」徽标
 * - 点选后:选项收起,回显「已选择 · X · 已作为回复回传」,可「重新选择」回退
 */
import React, { useState } from 'react';
import type { AskOption } from '@bigbotart/shared';
import MarkdownText from './MarkdownText';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

const AskIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H9l-4.2 3.6c-.5.4-.8.2-.8-.4V6.5Z" />
  </svg>
);
const CheckIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
    <path d="m4.5 12.5 5 5 10-11" />
  </svg>
);

/** 容错:旧数据/异常协议里 options 可能是纯字符串 */
function normalize(o: AskOption | string): AskOption {
  return typeof o === 'string' ? { label: o } : o;
}

export function AskCard({
  question,
  options,
  onPick,
}: {
  question: string;
  options: Array<AskOption | string>;
  onPick: (label: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const opts = options.map(normalize).slice(0, 6);

  return (
    <div className={`ask${picked ? ' done' : ''}`} data-od-id="agent-ask">
      <div className="ask-h">
        {AskIcon}
        <b>{picked ? 'Agent 提问 · 已确认' : 'Agent 提问 · 等待确认'}</b>
        <span className="tag">ask.user</span>
      </div>
      <div className="ask-b">
        <div className="ask-q chat-md">
          <MarkdownText text={question} />
        </div>
        <div className="ask-opts">
          {opts.map((o, i) => (
            <button key={`${o.label}-${i}`} className="ask-opt" type="button" onClick={() => { setPicked(o.label); onPick(o.label); }}>
              <span className="ix">{LETTERS[i] ?? String(i + 1)}</span>
              <span className="tx">
                {o.label}
                {o.sub ? <span className="sub">{o.sub}</span> : null}
              </span>
              {o.recommended ? <span className="rec">推荐</span> : null}
            </button>
          ))}
        </div>
        <div className="ask-done">
          {CheckIcon}
          <span className="grow">
            已选择 · <b>{picked}</b> · 已作为回复回传
          </span>
          <span className="rst" onClick={() => setPicked(null)}>
            重新选择
          </span>
        </div>
      </div>
    </div>
  );
}

export default AskCard;
