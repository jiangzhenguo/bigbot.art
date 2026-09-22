/**
 * SkillInjectCard — 技能注入卡(配置事件,独立于 ToolRunCard;对齐设计稿 trc-skill)
 * 激活/停用/读取 = 画布级配置变更,常驻一行摘要(可展开看注入全文),
 * 不参与「本轮执行 N 个工具」的计数。纯展示,不触碰 window.bigbotart。
 */
import React, { useState } from 'react';
import type { ChatMsg } from '../types';

export function SkillInjectCard({
  data,
  onEdit,
}: {
  data: NonNullable<ChatMsg['skill']>;
  /** 「查看 / 编辑指令 →」跳转技能页(由容器接 onNavigate('skills')) */
  onEdit?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { action, name, inject } = data;

  return (
    <div className="skc" data-od-id="skill-inject-card" data-action={action}>
      <div className="skc-head">
        <span className="skc-ico">
          <svg viewBox="0 0 24 24" fill="currentColor" width={12} height={12}>
            <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
          </svg>
        </span>
        <div className="skc-tx">
          {action === 'activate' && (
            <>
              已加载技能 <b>{name}</b> 的操作指令
              {inject ? <span className="mono skc-inj"> · inject: {inject}</span> : null}
              <span className="skc-sub"> · 后续对话按此执行</span>
            </>
          )}
          {action === 'deactivate' && <>已停用技能 <b>{name}</b> · 不再注入指令</>}
          {action === 'read' && <>技能 <b>{name}</b> · 指令全文(按需读取)</>}
        </div>
        <button className="skc-toggle" type="button" onClick={() => setOpen((o) => !o)} aria-label={open ? '收起' : '展开'}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            {open ? <path d="m6 15 6-6 6 6" /> : <path d="m6 9 6 6 6-6" />}
          </svg>
        </button>
      </div>
      {open ? (
        <div className="skc-body">
          {data.instructionsText ? (
            <pre className="skc-pre mono">{data.instructionsText}</pre>
          ) : data.preview ? (
            <pre className="skc-pre mono">{data.preview}</pre>
          ) : (
            <div className="skc-hint">注入点 · systemPrompt「【当前技能】」段 · 紧贴画布能力知识之后</div>
          )}
          <div className="skc-foot">
            <span className="mut">注入点 · systemPrompt「【当前技能】」段 · 紧贴画布能力知识之后</span>
            {onEdit ? (
              <a className="locate" onClick={onEdit} role="button" tabIndex={0}>
                查看 / 编辑指令 →
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default SkillInjectCard;