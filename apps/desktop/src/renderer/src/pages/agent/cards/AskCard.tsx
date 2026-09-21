/**
 * AskCard — ask.user 确认卡片(设计文档 §1.5 / agent-cards.html ③)
 *
 * Agent 调 ask.user 暂停对话 → 渲染确认卡(问题 + 2~6 选项):
 * - 问题支持 Markdown(含 GFM 表格,方案对比用)
 * - 选项:字母序号圆 A~F + 主文案 + 灰色副说明 + 中性「推荐」徽标
 * - 点选后:选项收起,回显「已选择 · X · 已作为回复回传」,可「重新选择」回退
 * - 选中态是受控的:picked 来自消息数据(ask.picked),由父级记录,不做本地记忆——
 *   点选即写回消息数据,重进页面/恢复历史后仍正确回显,不会丢回「等待确认」
 */
import React from 'react';
import type { AskOption } from '@bigbotart/shared';
import MarkdownText from '../../../components/MarkdownText';

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
  picked = null,
  onPick,
  onReset,
}: {
  question: string;
  options: Array<AskOption | string>;
  /** 已点选的选项文案(来自消息数据 ask.picked;null = 未点选) */
  picked?: string | null;
  /** 点选选项:父级负责记录到消息数据,并以该文案继续对话 */
  onPick: (label: string) => void;
  /** 点「重新选择」:父级清除 ask.picked,回到可点选状态 */
  onReset: () => void;
}) {
  // 最后一道防线:任何来源(实时/恢复/异常协议)给到非数组 options 都不允许崩——空选项只显示问题
  const opts = (Array.isArray(options) ? options : []).map(normalize).slice(0, 6);

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
            <button key={`${o.label}-${i}`} className="ask-opt" type="button" onClick={() => onPick(o.label)}>
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
          <span className="rst" onClick={onReset}>
            重新选择
          </span>
        </div>
      </div>
    </div>
  );
}

export default AskCard;
