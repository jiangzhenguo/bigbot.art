/**
 * AgentChatView — Agent 对话页签的展示层(agent-llm 行 + 消息流)
 *
 * 纯展示:所有对话状态/副作用来自 useAgentChat(见 ./useAgentChat.ts);
 * 输入区单独在 ./AgentComposer.tsx(检查器 pane 夹在两者中间,由 CanvasPage 排版)。
 */
import React from 'react';
import type { AgentChatApi } from './useAgentChat';
import ChatMessageList from './ChatMessageList';

export function AgentChatView({
  chat,
  hidden,
  onLocate,
  onOpenSettings,
}: {
  chat: AgentChatApi;
  /** 页签切到检查器时隐藏消息流(composer 保持可见,与原布局一致) */
  hidden: boolean;
  onLocate: (nodeId: string) => void;
  onOpenSettings: () => void;
}) {
  const { msgs, send, chatRef, pinToBottom, model, modelOverridden } = chat;

  return (
    <>
      <div className="agent-llm mono">
        LLM:{model} · {modelOverridden ? '项目级覆盖' : '全局默认'}
      </div>

      {/* 对话 pane */}
      <div
        className="chat"
        ref={chatRef}
        style={{ display: hidden ? 'none' : undefined }}
        onScroll={(e) => {
          // 距底 80px 内视为贴底:跟随新消息;往上翻则松开
          const el = e.currentTarget;
          pinToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <ChatMessageList msgs={msgs} onSend={send} onLocate={onLocate} onOpenSettings={onOpenSettings} />
      </div>
    </>
  );
}

export default AgentChatView;
