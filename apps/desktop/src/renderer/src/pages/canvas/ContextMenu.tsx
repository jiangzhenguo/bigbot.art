/**
 * ContextMenu — 节点右键菜单(纯展示 + 轻量本地动作)
 *
 * 拆分自 CanvasPage 的 <div class="pop ctx"> 区块(原 2946–3031 行)。
 * 「另存为 / 在 Finder 中显示」是纯演示动作(读写 NODE_INFO_BASE / FINDER_PATH),
 * 与 toast 一起收敛在本组件;复制/删除走 CanvasPage 提供的回调。
 */
import React from 'react';
import type { CanvasNode } from './types';
import { NODE_INFO_BASE, FINDER_PATH } from './constants';

interface ContextMenuProps {
  ctx: { x: number; y: number; id: string } | null;
  nodes: CanvasNode[];
  toastMsg: (msg: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  /** 关闭菜单(CanvasPage 持有 ctx state) */
  onClose: () => void;
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

export function ContextMenu({ ctx, nodes, toastMsg, onDuplicate, onDelete, onClose }: ContextMenuProps) {
  return (
    <div
      className={`pop ctx${ctx ? ' open' : ''}`}
      role="menu"
      data-od-id="node-context-menu"
      style={
        ctx
          ? {
              left: Math.max(8, Math.min(ctx.x, window.innerWidth - 212 - 8)),
              top: Math.max(8, Math.min(ctx.y, window.innerHeight - 210 - 8)),
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
      <button
        className={`pop-it${isCtxGhost(ctx, nodes) ? ' dim' : ''}`}
        data-od-id="ctx-reveal-finder"
        onClick={() => {
          if (!ctx || isCtxGhost(ctx, nodes)) return;
          const id = ctx.id;
          onClose();
          toastMsg(
            `已在 Finder 中显示 · ~/BigBotArt/草原之河/${FINDER_PATH[id] ?? 'takes/'}（演示）`,
          );
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        </svg>
        在 Finder 中显示
      </button>
      <div className="ctx-sep"></div>
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