/**
 * NodeCard — 单个画布节点的外壳(纯展示 + 事件透传)
 *
 * 拆分自 CanvasPage 节点循环内 `{nodes.map(...)}` 的单节点 div(原 2480–2590 行):
 * badge / 标题栏 / 状态点 / 内容区(NodeBody)/ add 按钮。
 * 事件回调(选择/右键/拖拽/建边)由 CanvasPage 实现,经 props 传入。
 */
import React from 'react';
import type { CanvasNode } from './types';
import { TYPE_ICON } from './icons';
import { NodeBody } from './nodes/NodeBody';

interface NodeCardProps {
  node: CanvasNode;
  selected: boolean;
  flash: boolean;
  /** 当前 connectDrag 命中此节点(cur 是拖拽建边的目标) */
  isConnectTarget: boolean;
  connectHitOk: boolean;
  /** 当前画布全部节点(NodeBody 分镜表统计用) */
  nodes: CanvasNode[];
  /** nodeId → 最新成功 Take 产物路径(状态点 + 卡片内容回填) */
  takeResults: Record<string, string>;
  onSelect: (node: CanvasNode) => void;
  onContextMenu: (e: React.MouseEvent, node: CanvasNode) => void;
  onHeaderPointerDown: (e: React.PointerEvent, node: CanvasNode) => void;
  onAddPointerDown: (e: React.PointerEvent, node: CanvasNode) => void;
  onAddClick: (e: React.MouseEvent, node: CanvasNode) => void;
  /** 注册/注销 DOM 节点(ResizeObserver 与拖拽定位用) */
  registerRef: (id: string, el: HTMLDivElement | null) => void;
}

export function NodeCard({
  node: n,
  selected,
  flash,
  isConnectTarget,
  connectHitOk,
  nodes,
  takeResults,
  onSelect,
  onContextMenu,
  onHeaderPointerDown,
  onAddPointerDown,
  onAddClick,
  registerRef,
}: NodeCardProps) {
  const cls = [
    'node',
    n.ghost ? 'ghost' : '',
    n.stale ? 'stale' : '',
    n.agentOn ? 'agent-on' : '',
    selected ? 'sel' : '',
    flash ? 'flash' : '',
    isConnectTarget && connectHitOk ? 'connecting-target-ok' : '',
    isConnectTarget && !connectHitOk ? 'connecting-target-bad' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cls}
      data-node={n.id}
      ref={(el) => registerRef(n.id, el)}
      style={{ left: n.x, top: n.y, width: n.w }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        onSelect(n);
        e.stopPropagation();
      }}
      onContextMenu={(e) => onContextMenu(e, n)}
    >
      {n.badge ? (
        <span className="node-badge">
          <span className="spin"></span>
          {n.badge}
        </span>
      ) : null}
      <div
        className="nh"
        style={n.headBg ? { background: n.headBg } : undefined}
        onPointerDown={(e) => onHeaderPointerDown(e, n)}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
        >
          {TYPE_ICON[n.kind ?? 'plain']}
        </svg>
        {n.title}
        {/* 状态点从**真实产物**派生(不再用节点上存的 st —— 它在加载时被写死为 ok):
           排队/生成中/失效 = 黄;有产物 = 绿;未生成 = 不显示 */}
        {(() => {
          const nd = (n.data ?? {}) as Record<string, unknown>;
          const hasProduct = !!String(nd.resultPath ?? '') || !!takeResults[n.id];
          const st = n.badge || n.stale ? 'warn' : hasProduct ? 'ok' : null;
          if (!st) return null;
          return (
            <span
              className={`st dot${st === 'ok' ? ' ok' : ''}`}
              style={st === 'warn' ? { background: 'var(--warn)' } : undefined}
            ></span>
          );
        })()}
      </div>
      <NodeBody node={n} nodes={nodes} takeResults={takeResults} />
      <span className="port"></span>
      <button
        className="node-add"
        data-add={n.id}
        aria-label="添加下游节点"
        onPointerDown={(e) => onAddPointerDown(e, n)}
        onClick={(e) => onAddClick(e, n)}
      >
        +
      </button>
    </div>
  );
}