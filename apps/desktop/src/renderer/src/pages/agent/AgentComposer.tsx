/**
 * AgentComposer — Agent 对话输入区(附件行 + 技能 chip + 输入框 + 模型/技能弹层 + 发送/打断)
 *
 * 纯展示:对话状态来自 useAgentChat;附件/弹层是本组件的本地 UI 状态。
 * 技能:弹层选项来自真实技能库(listSkills),选中即真实激活(skillActivate)——
 * 激活/停用是画布级配置事件,由 useAgentChat.activateSkill/deactivateSkill 落盘并生成注入卡。
 */
import React, { useEffect, useState } from 'react';
import type { Asset, Skill } from '@bigbotart/shared';
import type { AgentChatApi } from './useAgentChat';

export function AgentComposer({
  chat,
  toastMsg,
  focusNodes,
  onLocate,
  onRemoveFocus,
  mentionNodes,
}: {
  chat: AgentChatApi;
  toastMsg: (msg: string) => void;
  /** Agent 对话的「关注节点」列表(画布右键「添加到聊天窗口」累积设定;空 = 未关注) */
  focusNodes?: Array<{ id: string; title: string }>;
  /** 点按关注节点 chip → 画布定位到该节点 */
  onLocate?: (nodeId: string) => void;
  /** chip 上的 × :移除某一个关注节点(与画布选中态无关) */
  onRemoveFocus?: (nodeId: string) => void;
  /** 输入框 @ 提及的候选节点(当前画布全部节点) */
  mentionNodes?: Array<{ id: string; title: string; kind: string }>;
}) {
  /* 本地 UI 状态:弹层 / 附件 */
  const [openPop, setOpenPop] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Asset[]>([]);
  /** 本条消息里通过 @ 提及引用的节点(消息级,发送后清空;与常驻关注节点按 id 去重合并) */
  const [mentions, setMentions] = useState<Array<{ id: string; title: string }>>([]);
  /** @ 提及弹层状态:start = 「@」在文本中的下标,query = @ 后已输入的过滤词 */
  const [mentionPop, setMentionPop] = useState<{ start: number; query: string } | null>(null);
  /** 弹层键盘高亮下标 */
  const [mentionIdx, setMentionIdx] = useState(0);
  /** 技能弹层选项(真实技能库;unmounted 清理) */
  const [skillOptions, setSkillOptions] = useState<Skill[]>([]);

  const {
    sending, send, interrupt,
    clearChat, compactChat,
    setChatInput, inputRef, autoGrow,
    model, modelOptions, loadModelOptions, pickModel,
    activeSkill, activateSkill, deactivateSkill,
  } = chat;

  /** @ 弹层的过滤候选(标题模糊匹配,最多 8 条) */
  const mentionCandidates = (mentionNodes ?? [])
    .filter((n) => !mentionPop || n.title.toLowerCase().includes(mentionPop.query.toLowerCase()))
    .slice(0, 8);

  /** 选中一个 @ 候选:把「@query」替换成「@节点标题 」并登记为引用 */
  const pickMention = (node: { id: string; title: string }) => {
    const el = inputRef.current;
    if (!el || !mentionPop) return;
    const caret = el.selectionStart ?? el.value.length;
    const next = `${el.value.slice(0, mentionPop.start)}@${node.title} ${el.value.slice(caret)}`;
    setChatInput(next);
    el.value = next;
    autoGrow(el);
    setMentions((cur) => (cur.some((x) => x.id === node.id) ? cur : [...cur, { id: node.id, title: node.title }]));
    setMentionPop(null);
    // 光标移到插入文本之后(等 chatInput 同步 effect 跑完再设,避免被覆盖)
    const pos = mentionPop.start + node.title.length + 2;
    window.setTimeout(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    }, 0);
  };

  /** 输入变化:同步 chatInput + 检测/关闭 @ 弹层 + 剪掉文本里已被删掉的提及 */
  const onInputChange = (el: HTMLTextAreaElement) => {
    const v = el.value;
    setChatInput(v);
    autoGrow(el);
    // 提及剪枝:用户把「@标题」删掉了 → 该引用一并失效(不留看不见的隐藏引用)
    setMentions((cur) => cur.filter((m) => v.includes(`@${m.title}`)));
    // 触发检测:光标前最近的「@」需位于词首(行首/空白后),且与光标之间无空白
    const caret = el.selectionStart ?? v.length;
    const before = v.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at >= 0 && (at === 0 || /\s/.test(before[at - 1] ?? ' '))) {
      const query = before.slice(at + 1);
      if (!/\s/.test(query)) {
        setMentionPop({ start: at, query });
        setMentionIdx(0);
        return;
      }
    }
    setMentionPop(null);
  };

  useEffect(() => {
    let alive = true;
    void window.bigbotart
      .listSkills()
      .then((list) => {
        if (alive) setSkillOptions(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /** 发送(带附件 + @ 提及;发出后清空附件区与提及) */
  const sendWithAttachments = () => {
    send(undefined, attachments, mentions);
    if (attachments.length) setAttachments([]);
    if (mentions.length) setMentions([]);
    setMentionPop(null);
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
        {(focusNodes ?? []).map((fn) => (
          <span
            key={fn.id}
            className="skill-tag focus-tag"
            data-od-id="composer-focus-node"
            role="button"
            tabIndex={0}
            title={`关注节点:发送时其详情会作为上下文一并发给 Agent\n点按定位到节点;点 × 取消关注`}
            onClick={() => onLocate?.(fn.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onLocate?.(fn.id);
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx="12" cy="12" r="7" />
              <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
            </svg>
            <span>
              关注：<b style={{ fontWeight: 600 }}>{fn.title}</b>
            </span>
            <button
              className="x"
              aria-label={`取消关注 ${fn.title}`}
              onClick={(e) => {
                e.stopPropagation();
                onRemoveFocus?.(fn.id);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </span>
        ))}
        {mentions.map((m) => (
          <span
            key={m.id}
            className="skill-tag focus-tag"
            data-od-id="composer-mention-node"
            title={`本条消息 @ 引用的节点:仅随下一条消息发送一次\n点 × 移除该引用(文本里的 @${m.title} 保留为普通文字)`}
          >
            <span>
              @<b style={{ fontWeight: 600 }}>{m.title}</b>
            </span>
            <button
              className="x"
              aria-label={`移除引用 ${m.title}`}
              onClick={() => setMentions((cur) => cur.filter((x) => x.id !== m.id))}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </span>
        ))}
        {activeSkill ? (
          <span className="skill-tag" data-od-id="composer-skill-tag" title={`已激活技能「${activeSkill.name}」,对话已注入其操作指令`}>
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
            </svg>
            <span>
              技能：<b style={{ fontWeight: 600 }}>{activeSkill.name}</b>
            </span>
            <button className="x" aria-label="停用技能" onClick={deactivateSkill}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </span>
        ) : null}
        <textarea
          rows={2}
          ref={inputRef}
          placeholder="追问 / 修改需求，如「镜2 改低机位仰拍」…（@ 引用节点 · /clear 清空 · /compact 压缩）"
          onChange={(e) => onInputChange(e.target)}
          onKeyDown={(e) => {
            // @ 弹层打开时:方向键/回车/Tab/Esc 先给弹层,不发送
            if (mentionPop) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMentionIdx((i) => (mentionCandidates.length ? (i + 1) % mentionCandidates.length : 0));
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMentionIdx((i) => (mentionCandidates.length ? (i - 1 + mentionCandidates.length) % mentionCandidates.length : 0));
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setMentionPop(null);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                const pick = mentionCandidates[mentionIdx] ?? mentionCandidates[0];
                if (pick) pickMention(pick);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendWithAttachments();
            }
          }}
          onBlur={() => {
            // 失焦关弹层(延迟一拍,让弹层里的 click 先触发)
            window.setTimeout(() => setMentionPop(null), 150);
          }}
        />
        {/* @ 提及节点弹层(候选 = 当前画布节点,按标题过滤) */}
        {mentionPop ? (
          <div className="pop open mention-pop" data-od-id="mention-pop" onMouseDown={(e) => e.preventDefault()}>
            {mentionCandidates.length === 0 ? (
              <div className="pop-it dim">没有匹配「{mentionPop.query}」的节点</div>
            ) : (
              mentionCandidates.map((n, i) => (
                <div
                  key={n.id}
                  className="pop-it"
                  style={i === mentionIdx ? { background: 'color-mix(in oklab,var(--accent) 12%,transparent)' } : undefined}
                  onMouseEnter={() => setMentionIdx(i)}
                  onClick={() => pickMention(n)}
                >
                  {n.title}
                  <span className="mut mono" style={{ fontSize: 10 }}> · {n.kind}</span>
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
      <div className="toolrow">
        <button className="chip mono" onClick={clearChat} title="清空当前画布对话(移除全部对话记录,不可恢复;画布与产物不受影响)">
          /clear
        </button>
        <button className="chip mono" onClick={compactChat} title="把旧对话压缩成摘要并裁剪上下文,保留最近几轮">
          /compact
        </button>
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
              deactivateSkill();
              setOpenPop(null);
            }}
          >
            无技能 · 自由编排
            {!activeSkill ? <span className="ck">✓</span> : null}
          </div>
          {skillOptions.map((s) => (
            <div
              className="pop-it"
              key={s.id}
              onClick={() => {
                activateSkill({ skillId: s.id, name: s.name, inject: s.inject });
                setOpenPop(null);
              }}
            >
              {s.name}
              {s.instructions ? <span className="mut mono" style={{ fontSize: 10 }}> · 指令</span> : null}
              {activeSkill?.skillId === s.id ? <span className="ck">✓</span> : null}
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
