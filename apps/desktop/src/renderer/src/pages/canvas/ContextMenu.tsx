/**
 * ContextMenu — 节点右键菜单(纯展示 + 轻量本地动作)
 *
 * 拆分自 CanvasPage 的 <div class="pop ctx"> 区块(原 2946–3031 行)。
 * 「另存为」是纯演示动作(读写 NODE_INFO_BASE),与 toast 一起收敛在本组件;
 * 「在 Finder 中显示」走 onReveal 回调(CanvasPage 解析节点真实产物路径 → 主进程 shell 定位);
 * 复制/删除/重命名走 CanvasPage 提供的回调。
 */
import React from 'react';
import type { CanvasNode } from './types';
import { NODE_INFO_BASE } from './constants';
import { isDesktopShell } from '../../api/shell';

interface ContextMenuProps {
  ctx: { x: number; y: number; id: string } | null;
  nodes: CanvasNode[];
  toastMsg: (msg: string) => void;
  onRename: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  /** 关闭菜单(CanvasPage 持有 ctx state) */
  onClose: () => void;
  /** asset 节点「更换资产…」(打开资产选择弹层) */
  onCtxChangeAsset?: (id: string) => void;
  /** 在 Finder 中显示节点产物(CanvasPage 解析真实路径 → IPC,toast 反馈) */
  onReveal: (id: string) => void;
  /** 添加到聊天窗口(设为 Agent 对话的关注节点;与画布选中态解耦;已添加时变为「从聊天窗口移除」) */
  onAddToChat?: (id: string) => void;
  /** 已在聊天窗口中的节点 id 列表(决定菜单项显示「添加」还是「移除」) */
  chatFocusIds?: string[];
}

/** 幽灵节点(尚无产物)在菜单里禁用导出类动作 */
function isCtxGhost(
  ctx: { x: number; y: number; id: string } | null,
  nodes: CanvasNode[],
): boolean {
  if (!ctx) return false;
  const n = nodes.find((x) => x.id === ctx.id);
  return !!n?.ghost;
}

export function ContextMenu({ ctx, nodes, toastMsg, onRename, onDuplicate, onDelete, onClose, onCtxChangeAsset, onReveal, onAddToChat, chatFocusIds }: ContextMenuProps) {
  const ctxNode = ctx ? nodes.find((x) => x.id === ctx.id) : undefined;
  const isAssetNode = ctxNode?.kind === 'asset';
  return (
    <div
      className={`pop ctx${ctx ? ' open' : ''}`}
      role="menu"
      data-od-id="node-context-menu"
      style={
        ctx
          ? {
              left: Math.max(8, Math.min(ctx.x, window.innerWidth - 212 - 8)),
              top: Math.max(8, Math.min(ctx.y, window.innerHeight - 260 - 8)),
            }
          : undefined
      }
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* 复制:与原行为一致 —— 复制后菜单保持打开(原 onCtxDuplicate 不关菜单) */}
      <button
        className="pop-it"
        data-od-id="ctx-duplicate"
        onClick={() => {
          if (!ctx) return;
          onDuplicate(ctx.id);
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        复制<span className="sc">⌘D</span>
      </button>
      <button
        className="pop-it"
        data-od-id="ctx-rename"
        onClick={() => {
          if (!ctx) return;
          const id = ctx.id;
          onClose();
          onRename(id);
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
        重命名…
      </button>
      <button
        className={`pop-it${isCtxGhost(ctx, nodes) ? ' dim' : ''}`}
        data-od-id="ctx-save-as"
        onClick={() => {
          if (!ctx || isCtxGhost(ctx, nodes)) return;
          const info = NODE_INFO_BASE[ctx.id];
          onClose();
          if (info?.img) {
            const name = info.img.split('/').pop() ?? 'output.png';
            const a = document.createElement('a');
            a.href = info.img;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            toastMsg(`已导出「${name}」· 演示使用本地素材`);
          } else {
            toastMsg('该节点暂无可导出的产物文件（演示）');
          }
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
          <path d="M12 3v11m0 0 4.2-4.2M12 14l-4.2-4.2" />
          <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
        </svg>
        另存为…
      </button>
      {isDesktopShell() ? (
      <button
        className={`pop-it${isCtxGhost(ctx, nodes) ? ' dim' : ''}`}
        data-od-id="ctx-reveal-finder"
        onClick={() => {
          if (!ctx || isCtxGhost(ctx, nodes)) return;
          const id = ctx.id;
          onClose();
          onReveal(id);
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        </svg>
        在 Finder 中显示
      </button>
      ) : null}
      <div className="ctx-sep"></div>
      {/* 添加到聊天窗口:设为 Agent 对话的关注节点(点按选中不再自动绑定,这里显式添加) */}
      {onAddToChat ? (
        <button
          className="pop-it"
          data-od-id="ctx-add-to-chat"
          onClick={() => {
            if (!ctx) return;
            const id = ctx.id;
            onClose();
            onAddToChat(id);
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
            <path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5Z" />
          </svg>
          {ctx && chatFocusIds?.includes(ctx.id) ? '从聊天窗口移除' : '添加到聊天窗口'}
        </button>
      ) : null}
      <div className="ctx-sep"></div>
      {isAssetNode && onCtxChangeAsset ? (
        <button
          className="pop-it"
          data-od-id="ctx-change-asset"
          onClick={() => {
            if (!ctx) return;
            const id = ctx.id;
            onClose();
            onCtxChangeAsset(id);
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
            <path d="M17 2l4 4-4 4" />
            <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
            <path d="M7 22l-4-4 4-4" />
            <path d="M21 13v1a4 4 0 0 1-4 4H3" />
          </svg>
          更换资产…
        </button>
      ) : null}
      <button
        className="pop-it danger"
        data-od-id="ctx-delete"
        onClick={() => {
          if (!ctx) return;
          const id = ctx.id;
          onClose();
          onDelete(id);
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
          <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0-1 13a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 7" />
        </svg>
        删除<span className="sc">⌫</span>
      </button>
    </div>
  );
}