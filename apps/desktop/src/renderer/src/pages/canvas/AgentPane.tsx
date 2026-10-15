/**
 * AgentPane — 右侧 Agent 面板(tabs + 对话页签 + 检查器插槽 + 输入区 + 宽度拖拽把手)
 *
 * 拆分自 CanvasPage 的 <aside class="agent"> 区块(含 agent-grip)。
 * 对话内容由 useAgentChat 提供(AgentChatView/AgentComposer 已是独立组件);
 * 检查器页签内容通过 inspector 插槽传入(InspectorPane),保持本组件薄。
 */
import React, { useRef } from 'react';
import type { AgentChatApi } from '../agent/useAgentChat';
import type { ChatMedia } from '../agent/types';
import { AgentChatView } from '../agent/AgentChatView';
import { AgentComposer } from '../agent/AgentComposer';

interface AgentPaneProps {
  chat: AgentChatApi;
  agentW: number;
  tab: 'chat' | 'insp';
  onTabChange: (t: 'chat' | 'insp') => void;
  onOpenSettings: () => void;
  onLocate: (nodeId: string) => void;
  /** 检查器页签内容(由 CanvasPage 组合 InspectorPane 传入) */
  inspector: React.ReactNode;
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
  tab,
  onTabChange,
  onOpenSettings,
  onLocate,
  inspector,
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
  /* 面板容器 ref(原 CanvasPage 的 agentRef;拆分后无外部读取,收到本组件本地管理) */
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
        <div className="agent-tabs">
          <button
            className={`atab${tab === 'chat' ? ' on' : ''}`}
            data-od-id="tab-chat"
            onClick={() => onTabChange('chat')}
          >
            Agent 对话
          </button>
          <button
            className={`atab${tab === 'insp' ? ' on' : ''}`}
            data-od-id="tab-inspector"
            onClick={() => onTabChange('insp')}
          >
            检查器
          </button>
          <span className="spacer"></span>
          <span className="row g6 mono mut" style={{ fontSize: '10.5px' }}>
            <span className="dot ok"></span>pi · 运行中
          </span>
        </div>
        {/* Agent 对话页签(pages/agent/AgentChatView);检查器 pane 由外层 InspectorPane 提供 */}
        <AgentChatView
          chat={chat}
          hidden={tab !== 'chat'}
          onLocate={onLocate}
          onOpenSettings={onOpenSettings}
          onEditSkill={onEditSkill}
          resolveMedia={resolveMedia}
        />
        {inspector}
        {/* 输入区(pages/agent/AgentComposer);focusNodes = 聊天关注节点(右键菜单累积设定),发送时随消息注入 Agent 上下文;mentionNodes = @ 提及候选 */}
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