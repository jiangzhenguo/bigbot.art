/**
 * AgentComposer — Agent 对话输入区(附件行 + 输入框 + 模型/技能弹层 + 发送/打断)
 *
 * 纯展示:对话状态来自 useAgentChat;附件/技能标签/弹层是本组件的本地 UI 状态。
 */
import React, { useState } from 'react';
import type { Asset } from '@bigbotart/shared';
import type { AgentChatApi } from './useAgentChat';
import { COMPOSER_SKILLS } from './constants';

export function AgentComposer({
  chat,
  toastMsg,
}: {
  chat: AgentChatApi;
  toastMsg: (msg: string) => void;
}) {
  /* 本地 UI 状态:弹层 / 附件 / 技能标签(不进对话逻辑) */
  const [openPop, setOpenPop] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Asset[]>([]);
  const [skill, setSkill] = useState('无技能');
  const skillOn = !!skill && skill !== '无技能';

  const {
    sending, send, interrupt,
    setChatInput, inputRef, autoGrow,
    model, modelOptions, loadModelOptions, pickModel,
  } = chat;

  /** 发送(带附件;发出后清空附件区) */
  const sendWithAttachments = () => {
    send(undefined, attachments);
    if (attachments.length) setAttachments([]);
  };

  return (
    <div className="composer" data-od-id="agent-composer">
      <div className="attach-row">
        {attachments.map((a) => (
          <span className="attach" key={a.id} title={a.localPath}>
            <span className="thumb">
              {a.kind === 'image' ? (
                <img src={`bba-asset://${a.localPath.split('/').pop()}`} alt="" />
              ) : (
                <span className={`attach-kind attach-kind--${a.kind}`}>
                  {a.kind === 'video' ? '🎬' : a.kind === 'audio' ? '🎵' : '📄'}
                </span>
              )}
            </span>
            <span>{a.name}</span>
            <span className="mono mut" style={{ fontSize: '10px' }}>
              {a.kind}
              {a.width ? ` · ${a.width}×${a.height}` : ''}
              {a.durationSec ? ` · ${a.durationSec}s` : ''}
            </span>
            <button
              className="x"
              aria-label="移除附件"
              onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </span>
        ))}
      </div>
      <div className="input-box">
        {skillOn ? (
          <span className="skill-tag" data-od-id="composer-skill-tag">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
            </svg>
            <span>
              技能：<b style={{ fontWeight: 600 }}>{skill}</b>
            </span>
            <button className="x" aria-label="移除技能" onClick={() => setSkill('无技能')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </span>
        ) : null}
        <textarea
          rows={2}
          ref={inputRef}
          placeholder="追问 / 修改需求，如「镜2 改低机位仰拍」…"
          onChange={(e) => {
            setChatInput(e.target.value);
            autoGrow(e.target);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendWithAttachments();
            }
          }}
        />
      </div>
      <div className="toolrow">
        <button
          className="chip"
          onClick={(e) => {
            e.stopPropagation();
            // dev/E2E 钩子:一次性消费——读出即删,避免残留导致之后每次点击都绕过 Finder 重复导入同一张图
            const win = window as unknown as { __bbaDevImportPaths?: string[] };
            const paths = win.__bbaDevImportPaths;
            delete win.__bbaDevImportPaths;
            void window.bigbotart
              .importAssets(paths?.length ? { paths } : undefined)
              .then((res) => {
                if (res.canceled || !res.assets?.length) return;
                // 按资产 id 去重,同一资产重复导入只保留一个 chip
                setAttachments((list) => [...list, ...res.assets.filter((a) => !list.some((x) => x.id === a.id))]);
                if (res.failed.length) {
                  toastMsg(`已导入 ${res.assets.length} 个;失败 ${res.failed.length}:${res.failed.map((f) => f.name).join(', ')}`);
                }
              });
          }}
        >
          ＋ 参考图 / 文件
        </button>
        <button
          className="chip"
          onClick={(e) => {
            e.stopPropagation();
            const opening = openPop !== 'modelPop';
            setOpenPop((p) => (p === 'modelPop' ? null : 'modelPop'));
            if (opening) void loadModelOptions();
          }}
        >
          模型:{model}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <div className={`pop${openPop === 'modelPop' ? ' open' : ''}`} onClick={(e) => e.stopPropagation()}>
          {modelOptions.map((m) => (
            <div
              className="pop-it"
              key={m.name}
              onClick={() => {
                pickModel(m);
                setOpenPop(null);
              }}
            >
              {m.sub}
              {model === m.name ? <span className="ck">✓</span> : null}
            </div>
          ))}
          <div
            className="pop-it dim"
            style={{
              borderTop: '1px solid var(--border-soft)',
              marginTop: 4,
              paddingTop: 9,
            }}
          >
            项目级覆盖 · 规划时优先使用该 LLM
          </div>
        </div>
        <button
          className="chip"
          onClick={(e) => {
            e.stopPropagation();
            setOpenPop((p) => (p === 'skillPop' ? null : 'skillPop'));
          }}
        >
          ＋ 技能
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <div className={`pop${openPop === 'skillPop' ? ' open' : ''}`} onClick={(e) => e.stopPropagation()}>
          <div
            className="pop-it"
            onClick={() => {
              setSkill('无技能');
              setOpenPop(null);
            }}
          >
            无技能 · 自由编排
            {skill === '无技能' ? <span className="ck">✓</span> : null}
          </div>
          {COMPOSER_SKILLS.map((s) => (
            <div
              className="pop-it"
              key={s}
              onClick={() => {
                setSkill(s);
                setOpenPop(null);
              }}
            >
              {s}
              {skill === s ? <span className="ck">✓</span> : null}
            </div>
          ))}
        </div>
      </div>
      <div className="composer-actions">
        <button className="btn btn-g btn-sm" onClick={interrupt}>
          打断并改画布
        </button>
        <button className="btn btn-p btn-sm" onClick={sendWithAttachments} disabled={sending}>
          发送
        </button>
      </div>
    </div>
  );
}

export default AgentComposer;
