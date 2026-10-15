/**
 * AgentPane — 右侧 Agent 对话面板(常驻 · 无检查器页签)
 *
 * 对齐 Open Design canvas.html:Agent 对话独立占右侧,检查器拆到左侧 insp-panel。
 * 对话内容由 useAgentChat 提供(AgentChatView/AgentComposer)。
 */
import React, { useRef } from 'react';
import type { AgentChatApi } from '../agent/useAgentChat';
import type { ChatMedia } from '../agent/types';
import { AgentChatView } from '../agent/AgentChatView';
import { AgentComposer } from '../agent/AgentComposer';

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
  return (
    <>
      <aside
        className="agent"
        data-od-id="agent-panel"
        ref={(el) => {
          agentRef.current = el;
        }}
        style={{ width: agentW }}
        onClick={onBackgroundClick}
      >
        <div className="agent-head">
          <span className="lbl" data-od-id="agent-panel-title">
            Agent 对话
          </span>
          <span className="spacer"></span>
          <span className="row g6 mono mut" style={{ fontSize: '10.5px' }}>
            <span className="dot ok"></span>pi · 运行中
          </span>
        </div>
        <AgentChatView
          chat={chat}
          onLocate={onLocate}
          onOpenSettings={onOpenSettings}
          onEditSkill={onEditSkill}
          resolveMedia={resolveMedia}
        />
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
      ></button>
    </>
  );
}
