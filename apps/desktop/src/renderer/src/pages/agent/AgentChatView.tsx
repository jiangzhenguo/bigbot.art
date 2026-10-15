/**
 * AgentChatView — Agent 对话面板的展示层(agent-llm 行 + 消息流)
 *
 * 纯展示:所有对话状态/副作用来自 useAgentChat(见 ./useAgentChat.ts);
 * 输入区单独在 ./AgentComposer.tsx。
 */
import React from 'react';
import type { AgentChatApi } from './useAgentChat';
import ChatMessageList from './ChatMessageList';
import type { ChatMedia } from './types';

export function AgentChatView({
  chat,
  onLocate,
  onOpenSettings,
  onEditSkill,
  resolveMedia,
}: {
  chat: AgentChatApi;
  onLocate: (nodeId: string) => void;
  onOpenSettings: () => void;
  /** 技能注入卡「查看 / 编辑指令 →」:跳转技能页(可为空 = 不显示入口) */
  onEditSkill?: () => void;
  /** 节点 → 产物媒体(工具卡内联显示生成结果) */
  resolveMedia?: (nodeId: string) => ChatMedia | null;
}) {
  const { msgs, send, askPick, askReset, chatRef, pinToBottom, model, modelOverridden } = chat;

  return (
    <>
      <div className="agent-llm mono">
        LLM:{model} · {modelOverridden ? '项目级覆盖' : '全局默认'}
      </div>

      {/* 对话 pane */}
      <div
        className="chat"
        ref={chatRef}
        onScroll={(e) => {
          // 距底 80px 内视为贴底:跟随新消息;往上翻则松开
          const el = e.currentTarget;
          pinToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <ChatMessageList
          msgs={msgs}
          onSend={send}
          onLocate={onLocate}
          onOpenSettings={onOpenSettings}
          onAskPick={askPick}
          onAskReset={askReset}
          onEditSkill={onEditSkill}
          resolveMedia={resolveMedia}
        />
      </div>
    </>
  );
}

export default AgentChatView;
