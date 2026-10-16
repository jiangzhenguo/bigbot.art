/**
 * AgentPane — 右侧 Agent 对话面板(常驻 · 无检查器页签)
 *
 * 对齐 Open Design canvas.html:Agent 对话独立占右侧,检查器拆到左侧 insp-panel。
 * 对话内容由 useAgentChat 提供(AgentChatView/AgentComposer);历史会话抽屉叠在消息区上。
 */
import React, { useRef } from 'react';
import type { AgentChatApi } from '../agent/useAgentChat';
import type { ChatMedia } from '../agent/types';
import { AgentChatView } from '../agent/AgentChatView';
import { AgentComposer } from '../agent/AgentComposer';
import { AgentChatHistory } from '../agent/AgentChatHistory';

interface AgentPaneProps {
  chat: AgentChatApi;
  agentW: number;
  onOpenSettings: () => void;
  onLocate: (nodeId: string) => void;
  toastMsg: (msg: string) => void;
  /** 点击面板空白处关闭右键菜单 */
  onBackgroundClick: () => void;
  gripRef: React.MutableRefObject<HTMLButtonElement | null>;
  onGripPointerDown: (e: React.PointerEvent) => void;
  onGripDoubleClick: () => void;
  onGripKeyDown: (e: React.KeyboardEvent) => void;
  /** 技能注入卡「查看 / 编辑指令 →」:跳转技能页 */
  onEditSkill?: () => void;
  /** Agent 对话的「关注节点」列表(右键「添加到聊天窗口」累积设定,与画布选中态解耦;空 = 未关注) */
  focusNodes?: Array<{ id: string; title: string }>;
  /** chip 上的 × :移除某一个关注节点 */
  onRemoveFocus?: (nodeId: string) => void;
  /** 输入框 @ 提及的候选节点(当前画布全部节点) */
  mentionNodes?: Array<{ id: string; title: string; kind: string }>;
  /** 节点 → 产物媒体(聊天工具卡内联显示生成结果) */
  resolveMedia?: (nodeId: string) => ChatMedia | null;
}

export function AgentPane({
  chat,
  agentW,
  onOpenSettings,
  onLocate,
  toastMsg,
  onBackgroundClick,
  gripRef,
  onGripPointerDown,
  onGripDoubleClick,
  onGripKeyDown,
  onEditSkill,
  focusNodes,
  onRemoveFocus,
  mentionNodes,
  resolveMedia,
}: AgentPaneProps) {
  const agentRef = useRef<HTMLElement | null>(null);
  const {
    historyOpen,
    setHistoryOpen,
    threads,
    activeThreadId,
    activeThreadTitle,
    switchThread,
    newThread,
    renameThread,
    deleteThread,
  } = chat;

  return (
    <>
      <aside
        className={`agent${historyOpen ? ' thread-hist-open' : ''}`}
        data-od-id="agent-panel"
        ref={(el) => {
          agentRef.current = el;
        }}
        style={{ width: agentW }}
        onClick={onBackgroundClick}
      >
        <div className="agent-head">
          <button
            type="button"
            className="thread-title-btn"
            title="点击重命名当前对话"
            data-od-id="agent-thread-title"
            onClick={(e) => {
              e.stopPropagation();
              if (!activeThreadId) return;
              const next = window.prompt('会话标题', activeThreadTitle === '新对话' ? '' : activeThreadTitle);
              if (next == null) return;
              void renameThread(activeThreadId, next);
            }}
          >
            {activeThreadTitle}
          </button>
          <div className="agent-head-actions">
            <button
              type="button"
              className="agent-text-btn"
              title="新对话 · 归档当前会话"
              data-od-id="agent-new-thread"
              onClick={(e) => {
                e.stopPropagation();
                void newThread();
              }}
            >
              新对话
            </button>
            <button
              type="button"
              className="agent-icon-btn"
              title="本画布的历史聊天"
              aria-expanded={historyOpen}
              aria-controls="threadDrawer"
              data-od-id="agent-history-toggle"
              onClick={(e) => {
                e.stopPropagation();
                setHistoryOpen(!historyOpen);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
                <path d="M4 6h16M4 12h10M4 18h14" />
                <circle cx="18" cy="17" r="3" />
              </svg>
            </button>
          </div>
          <span className="row g6" style={{ flex: 'none' }} title="pi · 运行中" aria-label="pi · 运行中">
            <span className="dot ok"></span>
          </span>
        </div>

        <div className="agent-body">
          <AgentChatHistory
            open={historyOpen}
            threads={threads}
            activeThreadId={activeThreadId}
            onClose={() => setHistoryOpen(false)}
            onSwitch={(id) => void switchThread(id)}
            onRename={(id, title) => void renameThread(id, title)}
            onDelete={(id) => void deleteThread(id)}
            onDerive={(parentId) => void newThread({ parentThreadId: parentId })}
          />
          <div className="agent-chat-stack">
            <AgentChatView
              chat={chat}
              onLocate={onLocate}
              onOpenSettings={onOpenSettings}
              onEditSkill={onEditSkill}
              resolveMedia={resolveMedia}
            />
          </div>
        </div>
        <AgentComposer
          chat={chat}
          toastMsg={toastMsg}
          focusNodes={focusNodes}
          onLocate={onLocate}
          onRemoveFocus={onRemoveFocus}
          mentionNodes={mentionNodes}
        />
      </aside>

      {/* Agent 面板宽度拖拽把手 */}
      <button
        className="agent-grip"
        aria-label="拖拽调整 Agent 面板宽度"
        title="拖拽调整面板宽度 · 双击复位"
        data-od-id="agent-resize-handle"
        ref={gripRef}
        style={{ right: 12 + agentW - 6 }}
        onPointerDown={onGripPointerDown}
        onDoubleClick={onGripDoubleClick}
        onKeyDown={onGripKeyDown}
      />
    </>
  );
}

export default AgentPane;
