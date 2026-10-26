/**
 * ChatMessageList — 消息流渲染(纯展示,按消息字段分派到各卡片组件)
 *
 * 消息类型只存数据(见 ../types.ts),这里做唯一的分派:
 * user / sys(含 loading)/ error / ask / toolRuns / toolCall(旧格式兼容)/ check / plan / 文本+思考
 *
 * 复制按钮:用户气泡常显 + 「每轮最终回答」(odId=agent-reply);
 * 「已执行 xxx」系统记录 / 工具卡不挂。
 */
import React from 'react';
import MarkdownText from '../../components/MarkdownText';
import ToolRunCard from './cards/ToolRunCard';
import AskCard from './cards/AskCard';
import ErrorCard from './cards/ErrorCard';
import ThinkingBlock from './cards/ThinkingBlock';
import ContinuityCard from './cards/ContinuityCard';
import PlanCard from './cards/PlanCard';
import SkillInjectCard from './cards/SkillInjectCard';
import MsgCopyBtn from './MsgCopyBtn';
import { AudioPlayer, previewUrlOf } from '../canvas/media';
import { isTodoActivityText, isTodoToolName, withoutTodoToolRuns } from './todo-display';
import type { ChatMedia, ChatMsg } from './types';

type ChatAttachment = { name: string; kind: string; localPath?: string };

/** 图片/视频已经在气泡里出了画面,文件名叠在画面上,不再在正文下再排一排文字徽标 */
function captionOnMedia(a: ChatAttachment): boolean {
  return Boolean(a.localPath) && (a.kind === 'image' || a.kind === 'video');
}

/** 附件内联媒体(有 localPath 才能显示;历史 recall 记录没有路径 → 回退文件名徽标) */
function AttachmentMedia({ a }: { a: ChatAttachment }) {
  const url = a.localPath ? previewUrlOf(a.localPath) : null;
  if (!url) return null;
  if (a.kind === 'image' || a.kind === 'video') {
    return (
      <span className={`att-tile${a.kind === 'video' ? ' att-tile--video' : ''}`}>
        {a.kind === 'image' ? (
          <img className="att-media" src={url} alt={a.name} />
        ) : (
          <video className="att-media" src={url} controls preload="metadata" />
        )}
        <span className="att-cap">{a.name}</span>
      </span>
    );
  }
  if (a.kind === 'audio') return <AudioPlayer src={url} name={a.name} compact />;
  return null;
}

/** 工具活动系统记录文案(如「已执行 vision.caption」)— 不是最终回答,不能挂复制 */
const TOOL_ACTIVITY_RE = /^已执行\s+\S/;

/** 本轮最终回答(可复制):显式 odId,或兼容未打标的旧气泡(排除「已执行 …」) */
export function isCopyableReply(m: ChatMsg): boolean {
  const text = m.text?.trim();
  if (!text) return false;
  if (m.kind !== 'agent' || m.streaming) return false;
  if (m.toolRuns || m.ask || m.error || m.check || m.plan || m.skill || m.toolCall) return false;
  if (m.odId === 'agent-reply') return true;
  if (m.odId) return false;
  // 热更新前已入列、尚未打 agent-reply 的旧气泡:排除工具活动摘要
  if (TOOL_ACTIVITY_RE.test(text)) return false;
  return true;
}

export function ChatMessageList({
  msgs,
  onSend,
  onLocate,
  onOpenSettings,
  onAskPick,
  onAskReset,
  onEditSkill,
  resolveMedia,
}: {
  msgs: ChatMsg[];
  /** 发送一条用户消息(ask 点选 / 错误卡重试) */
  onSend: (text: string) => void;
  onLocate: (nodeId: string) => void;
  onOpenSettings: () => void;
  /** ask 确认卡点选:父级记录选择到消息数据(ask.picked),并以该文案继续对话 */
  onAskPick: (msgId: number, label: string) => void;
  /** ask 确认卡「重新选择」:父级清除 ask.picked,回到可点选 */
  onAskReset: (msgId: number) => void;
  /** 技能注入卡「查看 / 编辑指令 →」:跳转技能页 */
  onEditSkill?: () => void;
  /** 节点 → 产物媒体(工具卡内联显示生成结果;CanvasPage 按 nodes/takeResults 解析) */
  resolveMedia?: (nodeId: string) => ChatMedia | null;
}) {
  return (
    <>
      {msgs.map((m) => {
        if (m.kind === 'user') {
          const nameBadges = m.attachments?.filter((a) => !captionOnMedia(a)) ?? [];
          return (
            <div className="msg-user-wrap" key={m.id}>
              <div className="msg-user">
                {/* 附件媒体内联预览(图片/视频/音频直接可看在气泡里,不再只是文件名) */}
                {m.attachments?.some((a) => a.localPath) ? (
                  <div className="att-media-row">
                    {m.attachments.map((a, i) => (
                      <AttachmentMedia key={`${a.name}-${i}`} a={a} />
                    ))}
                  </div>
                ) : null}
                {m.text}
                {m.contextNodes?.length || nameBadges.length ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 }}>
                    {m.contextNodes?.map((cn) => (
                      <span
                        key={cn.id}
                        className="badge ctx-node"
                        data-od-id="msg-context-node"
                        style={{ fontSize: '10px' }}
                        title={`本轮发送时已附带节点「${cn.title}」的详情作为 Agent 上下文 · 点按定位到节点`}
                        onClick={() => onLocate(cn.id)}
                      >
                        ◎ 关注:{cn.title}
                      </span>
                    ))}
                    {nameBadges.map((a, i) => (
                      <span key={`${a.name}-${i}`} className="badge" style={{ fontSize: '10px' }}>
                        {a.kind === 'image' ? '🖼' : a.kind === 'video' ? '🎬' : a.kind === 'audio' ? '🎵' : '📄'} {a.name}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              {m.text?.trim() ? <MsgCopyBtn text={m.text} className="msg-copy--user" /> : null}
            </div>
          );
        }
        if (m.kind === 'sys') {
          // todo 的进度与系统摘要都由底部固定面板承接，不再重复占用聊天内容。
          if (isTodoActivityText(m.text)) return null;
          return (
            <div className="msg-sys" key={m.id}>
              {m.loading ? (
                /* 加载态复用工具调用「运行中」动效:小 spinner + accent 色文字(与 tr-row.running 同款) */
                <span className="tr-st" style={{ margin: '0 auto', color: 'color-mix(in oklab,var(--accent) 82%,var(--fg))' }}>
                  <span className="spin sm" />
                  {m.text}
                </span>
              ) : (
                m.text
              )}
            </div>
          );
        }
        if (m.error) {
          return (
            <ErrorCard
              key={m.id}
              title={m.error.title}
              detail={m.error.detail}
              retryText={m.error.retryText}
              onRetry={onSend}
              onOpenSettings={onOpenSettings}
            />
          );
        }
        if (m.ask) {
          // 确认卡片(Agent 调 ask.user):点选选项作为你的答复继续对话;
          // selected 来自消息数据(ask.picked),重进页面/恢复历史后仍正确回显
          return (
            <AskCard
              key={m.id}
              question={m.ask.question}
              options={m.ask.options}
              picked={m.ask.picked ?? null}
              onPick={(label) => onAskPick(m.id, label)}
              onReset={() => onAskReset(m.id)}
            />
          );
        }
        if (m.toolRuns) {
          // todo.write 由固定进度面板展示；其他工具仍按原聚合卡留痕。
          const runs = withoutTodoToolRuns(m.toolRuns);
          if (runs.length === 0) return null;
          // 工具聚合卡:一轮调用一张卡(设计文档 §3);resolveMedia 让成功行内联显示产物(图片/视频/音频)
          return <ToolRunCard key={m.id} runs={runs} onLocate={onLocate} resolveMedia={resolveMedia} />;
        }
        if (m.skill) {
          // 技能注入卡(配置事件;设计稿 trc-skill,与工具卡并列但独立计数)
          return <SkillInjectCard key={m.id} data={m.skill} onEdit={onEditSkill} />;
        }
        if (m.check) {
          return <ContinuityCard key={m.id} check={m.check} />;
        }
        if (m.plan) {
          return <PlanCard key={m.id} plan={m.plan} />;
        }
        if (m.toolCall) {
          // 旧格式兼容(历史快照里逐条平铺的工具卡)；todo 同样只进固定面板。
          const tc = m.toolCall;
          if (isTodoToolName(tc.name)) return null;
          return (
            <div className="msg-agent" key={m.id} data-od-id="agent-tools">
              <div className="tool">
                <div className="th">
                  <span className="mono" style={{ fontSize: '11px' }}>
                    {tc.name}
                  </span>
                  <span className="badge" style={{ marginLeft: 'auto' }}>
                    {tc.status === 'running' ? (
                      <>
                        <span className="dot" style={{ background: 'var(--warn)' }}></span>
                        运行中
                      </>
                    ) : tc.status === 'success' ? (
                      '成功'
                    ) : (
                      '失败'
                    )}
                  </span>
                  {tc.nodeId ? (
                    <span className="locate" onClick={() => onLocate(tc.nodeId!)}>
                      定位到节点 →
                    </span>
                  ) : null}
                </div>
                <div className="tb mono">{tc.result ?? JSON.stringify(tc.args).slice(0, 140)}</div>
              </div>
            </div>
          );
        }
        return (
          <div className="msg-agent" key={m.id} data-od-id={m.odId} data-streaming={m.streaming ? 'true' : undefined}>
            {m.thinking ? <ThinkingBlock thinking={m.thinking} /> : null}
            {m.text ? <MarkdownText text={m.text} /> : null}
            {m.streaming ? <span className="spin sm" aria-label="正在流式生成" style={{ marginLeft: 6 }} /> : null}
            {/* 每轮最终回答常显复制(Markdown 原文);已执行 xxx / 工具卡不进这里 */}
            {isCopyableReply(m) ? (
              <div className="msg-agent-actions">
                <MsgCopyBtn text={m.text!} className="msg-copy--agent" />
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

export default ChatMessageList;
