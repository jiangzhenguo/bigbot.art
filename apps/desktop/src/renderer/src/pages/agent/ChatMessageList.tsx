/**
 * ChatMessageList — 消息流渲染(纯展示,按消息字段分派到各卡片组件)
 *
 * 消息类型只存数据(见 ../types.ts),这里做唯一的分派:
 * user / sys(含 loading)/ error / ask / toolRuns / toolCall(旧格式兼容)/ check / plan / 文本+思考
 */
import React from 'react';
import MarkdownText from '../../components/MarkdownText';
import ToolRunCard from './cards/ToolRunCard';
import AskCard from './cards/AskCard';
import ErrorCard from './cards/ErrorCard';
import ThinkingBlock from './cards/ThinkingBlock';
import ContinuityCard from './cards/ContinuityCard';
import PlanCard from './cards/PlanCard';
import type { ChatMsg } from './types';

export function ChatMessageList({
  msgs,
  onSend,
  onLocate,
  onOpenSettings,
  onAskPick,
  onAskReset,
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
}) {
  return (
    <>
      {msgs.map((m) => {
        if (m.kind === 'user') {
          return (
            <div className="msg-user" key={m.id}>
              {m.text}
              {m.attachments?.length ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 }}>
                  {m.attachments.map((a) => (
                    <span key={a.name} className="badge" style={{ fontSize: '10px' }}>
                      {a.kind === 'image' ? '🖼' : a.kind === 'video' ? '🎬' : a.kind === 'audio' ? '🎵' : '📄'} {a.name}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          );
        }
        if (m.kind === 'sys') {
          return (
            <div className="msg-sys" key={m.id}>
              {m.loading ? <span className="spin" style={{ marginRight: 6 }} /> : null}
              {m.text}
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
          // 工具聚合卡:一轮调用一张卡(设计文档 §3)
          return <ToolRunCard key={m.id} runs={m.toolRuns} onLocate={onLocate} />;
        }
        if (m.check) {
          return <ContinuityCard key={m.id} check={m.check} />;
        }
        if (m.plan) {
          return <PlanCard key={m.id} plan={m.plan} />;
        }
        if (m.toolCall) {
          // 旧格式兼容(历史快照里逐条平铺的工具卡)
          const tc = m.toolCall;
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
          <div className="msg-agent" key={m.id} data-od-id={m.odId}>
            {m.thinking ? <ThinkingBlock thinking={m.thinking} /> : null}
            {m.text ? <MarkdownText text={m.text} /> : null}
          </div>
        );
      })}
    </>
  );
}

export default ChatMessageList;
