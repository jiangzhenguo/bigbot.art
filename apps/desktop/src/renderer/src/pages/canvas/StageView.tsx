/**
 * StageView — 画布主体区域(纯展示 + 事件透传)
 *
 * 拆分自 CanvasPage 的 <section class="stage"> 区块(原 2420–2797 行),
 * 含 .world 容器(edges SVG + 节点列表 + 弹层插槽)+ minimap + zoomctl。
 * 全局滚轮缩放 / 拖拽平移由 CanvasPage 通过 refs + 回调接线,本组件不持有画布状态。
 */
import React from 'react';
import type { CanvasNode, ConnectDrag, EdgeClass } from './types';
import { NodeCard } from './NodeCard';

export interface EdgePathRender {
  key: string;
  cls: EdgeClass;
  d: string;
}

interface StageViewProps {
  view: { x: number; y: number; z: number };
  panning: boolean;
  nodes: CanvasNode[];
  edgePaths: EdgePathRender[];
  selected: string | null;
  flashId: string | null;
  connectDrag: ConnectDrag | null;
  takeResults: Record<string, string>;
  /** 临时连线路径(「+」拖拽跟手的虚线;由 CanvasPage 的 computeConnectPath 提供) */
  connectPath: (srcId: string, cx: number, cy: number) => string | null;
  zoomPct: string;
  onZoomBy: (delta: number) => void;
  onZoomReset: () => void;
  /* refs(CanvasPage 的 effect 依赖这些 DOM 节点:滚轮缩放/连线重绘/面板宽度定位) */
  stageRef: React.MutableRefObject<HTMLElement | null>;
  edgesSvgRef: React.MutableRefObject<SVGSVGElement | null>;
  minimapRef: React.MutableRefObject<HTMLDivElement | null>;
  worldRef: React.MutableRefObject<HTMLDivElement | null>;
  /* 事件(CanvasPage 实现) */
  onStagePointerDown: (e: React.PointerEvent) => void;
  onStageClick: () => void;
  onWorldClick: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onBeginPan: (e: React.PointerEvent) => void;
  onNodeSelect: (n: CanvasNode) => void;
  onNodeContextMenu: (e: React.MouseEvent, n: CanvasNode) => void;
  onNodeHeaderPointerDown: (e: React.PointerEvent, n: CanvasNode) => void;
  onNodeAddPointerDown: (e: React.PointerEvent, n: CanvasNode) => void;
  onNodeAddClick: (e: React.MouseEvent, n: CanvasNode) => void;
  registerNodeRef: (id: string, el: HTMLDivElement | null) => void;
  /** 「+」弹层(CanvasPage 组合 AddNodePopover 后置入 world 容器) */
  popover: React.ReactNode;
}

export function StageView({
  view,
  panning,
  nodes,
  edgePaths,
  selected,
  flashId,
  connectDrag,
  takeResults,
  connectPath,
  zoomPct,
  onZoomBy,
  onZoomReset,
  stageRef,
  edgesSvgRef,
  minimapRef,
  worldRef,
  onStagePointerDown,
  onStageClick,
  onWorldClick,
  onDragOver,
  onDrop,
  onBeginPan,
  onNodeSelect,
  onNodeContextMenu,
  onNodeHeaderPointerDown,
  onNodeAddPointerDown,
  onNodeAddClick,
  registerNodeRef,
  popover,
}: StageViewProps) {
  return (
    <section
      className={`stage${panning ? ' panning' : ''}`}
      data-od-id="canvas-stage"
      ref={(el) => {
        stageRef.current = el;
      }}
      onPointerDown={(e) => {
        const t = e.target as HTMLElement;
        if (t !== e.currentTarget && !t.classList.contains('world') && t.tagName !== 'svg')
          return;
        onBeginPan(e);
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={onStageClick}
    >
      <div
        className="world"
        ref={worldRef}
        style={{
          transform: `translate(${view.x}px,${view.y}px) scale(${view.z})`,
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onWorldClick();
        }}
      >
        <svg className="edges" ref={edgesSvgRef}>
          {edgePaths.map((p) => (
            <path key={p.key} className={p.cls} d={p.d} />
          ))}
          {/* 「+」拖拽期间的临时预览线(连 source 节点 → 当前光标) */}
          {connectDrag && connectDrag.moved && (() => {
            const d = connectPath(connectDrag.sourceId, connectDrag.cx, connectDrag.cy);
            if (!d) return null;
            const cls = connectDrag.hitId
              ? connectDrag.hitOk
                ? 'connecting ok'
                : 'connecting bad'
              : 'connecting';
            return <path key="__connecting" className={cls} d={d} />;
          })()}
        </svg>

        {nodes.map((n) => (
          <NodeCard
            key={n.id}
            node={n}
            nodes={nodes}
            selected={selected === n.id}
            flash={flashId === n.id}
            isConnectTarget={connectDrag?.hitId === n.id}
            connectHitOk={connectDrag?.hitOk === true}
            takeResults={takeResults}
            onSelect={onNodeSelect}
            onContextMenu={onNodeContextMenu}
            onHeaderPointerDown={onNodeHeaderPointerDown}
            onAddPointerDown={onNodeAddPointerDown}
            onAddClick={onNodeAddClick}
            registerRef={registerNodeRef}
          />
        ))}

        {popover}
      </div>

      <div className="minimap" aria-hidden="true" ref={minimapRef}>
        <i style={{ left: 8, top: 34, width: 18, height: 12 }}></i>
        <i style={{ left: 32, top: 10, width: 20, height: 14 }}></i>
        <i style={{ left: 32, top: 48, width: 20, height: 12 }}></i>
        <i style={{ left: 62, top: 8, width: 22, height: 16 }}></i>
        <i style={{ left: 62, top: 36, width: 22, height: 16 }}></i>
        <i style={{ left: 62, top: 66, width: 22, height: 14 }}></i>
        <i style={{ left: 96, top: 28, width: 22, height: 14 }}></i>
        <span className="view" style={{ left: 24, top: 14, width: 76, height: 56 }}></span>
      </div>
      <div className="zoomctl">
        <button
          className="ibtn"
          style={{ width: 26, height: 26 }}
          onClick={(e) => {
            e.stopPropagation();
            onZoomBy(-0.1);
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M5 12h14" />
          </svg>
        </button>
        <span
          className="zv mono mut"
          onClick={(e) => {
            e.stopPropagation();
            onZoomReset();
          }}
          title="复位视图"
        >
          {zoomPct}
        </span>
        <button
          className="ibtn"
          style={{ width: 26, height: 26 }}
          onClick={(e) => {
            e.stopPropagation();
            onZoomBy(0.1);
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
    </section>
  );
}