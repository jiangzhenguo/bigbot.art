/**
 * StageView — 画布主体区域(纯展示 + 事件透传)
 *
 * 拆分自 CanvasPage 的 <section class="stage"> 区块(原 2420–2797 行),
 * 含 .world 容器(edges SVG + 节点列表 + 弹层插槽)+ minimap + zoomctl。
 * 全局滚轮缩放 / 拖拽平移由 CanvasPage 通过 refs + 回调接线,本组件不持有画布状态。
 * 小地图是真实实现:节点/视口按 minimapLayout 投影,点击或拖拽经 onMinimapNavigate 跳转视角。
 */
import React, { useMemo, useRef } from 'react';
import type { CanvasNode, ConnectDrag, EdgeClass } from './types';
import { NodeCard } from './NodeCard';
import { minimapLayout, minimapToWorld } from './minimap';

export interface EdgePathRender {
  key: string;
  cls: EdgeClass;
  d: string;
}

/** 小地图容器尺寸(px,与 design-pages.css 的 .pg-canvas .minimap 保持同步) */
const MINIMAP_SIZE = { w: 140, h: 90 };

interface StageViewProps {
  view: { x: number; y: number; z: number };
  panning: boolean;
  nodes: CanvasNode[];
  edgePaths: EdgePathRender[];
  selected: string | null;
  flashId: string | null;
  connectDrag: ConnectDrag | null;
  takeResults: Record<string, string>;
  /** assetId → 资产展示元信息(asset 节点渲染用) */
  assetMeta: Record<string, { name: string; kind: string; categoryName?: string; src: string | null }>;
  /** 临时连线路径(「+」拖拽跟手的虚线;由 CanvasPage 的 computeConnectPath 提供) */
  connectPath: (srcId: string, cx: number, cy: number) => string | null;
  zoomPct: string;
  /** 舞台可视区尺寸(px,CanvasPage 经 ResizeObserver 测量后传入) */
  stageSize: { w: number; h: number };
  onZoomBy: (delta: number) => void;
  onZoomReset: () => void;
  /** 小地图跳转:目标世界坐标 → 视图中心对准该点(CanvasPage 实现) */
  onMinimapNavigate: (world: { x: number; y: number }) => void;
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
  assetMeta,
  connectPath,
  zoomPct,
  stageSize,
  onZoomBy,
  onZoomReset,
  onMinimapNavigate,
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
  /* 小地图布局:节点包围盒 + 视口的投影(view/nodes/stageSize 任一变化即重算) */
  const mmLayout = useMemo(
    () => minimapLayout(nodes, view, stageSize, MINIMAP_SIZE),
    [nodes, view, stageSize],
  );
  /** 小地图拖拽中(pointer capture 期间持续跳转视图) */
  const mmDragging = useRef(false);
  /** 小地图指针位置 → 世界坐标 → 通知 CanvasPage 中心对准 */
  const mmNavigate = (clientX: number, clientY: number) => {
    const el = minimapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const world = minimapToWorld(clientX - rect.left, clientY - rect.top, mmLayout);
    if (world) onMinimapNavigate(world);
  };

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
            assetMeta={assetMeta}
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

      {/* 小地图:真实节点缩略图 + 视口框;点击/拖拽跳转视角 */}
      <div
        className="minimap"
        ref={minimapRef}
        data-od-id="canvas-minimap"
        onPointerDown={(e) => {
          e.stopPropagation();
          mmDragging.current = true;
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* 指针已失效时忽略(罕见) */
          }
          mmNavigate(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (!mmDragging.current) return;
          e.stopPropagation();
          mmNavigate(e.clientX, e.clientY);
        }}
        onPointerUp={(e) => {
          mmDragging.current = false;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
        }}
        onPointerCancel={() => {
          mmDragging.current = false;
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {mmLayout.nodes.map((r) => (
          <i
            key={r.id}
            style={{
              left: r.x,
              top: r.y,
              width: Math.max(r.w, 2),
              height: Math.max(r.h, 2),
            }}
          />
        ))}
        {mmLayout.viewport ? (
          <span
            className="view"
            style={{
              left: mmLayout.viewport.x,
              top: mmLayout.viewport.y,
              width: mmLayout.viewport.w,
              height: mmLayout.viewport.h,
            }}
          />
        ) : null}
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