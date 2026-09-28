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
import { boundingRect, type NodeGroup, type Rect } from './selection';

export interface EdgePathRender {
  key: string;
  cls: EdgeClass;
  d: string;
}

/** 小地图容器尺寸(px,与 design-pages.css 的 .pg-canvas .minimap 保持同步) */
const MINIMAP_SIZE = { w: 140, h: 90 };

/** 组框外扩留白(px,world 坐标):让组框包住节点而不贴边 */
const GROUP_PAD = 14;

interface StageViewProps {
  view: { x: number; y: number; z: number };
  panning: boolean;
  nodes: CanvasNode[];
  edgePaths: EdgePathRender[];
  /** 当前选中节点 id 集合(空数组 = 未选中;顺序 = 点选顺序,末位为「主选中」) */
  selectedIds: string[];
  /** 正在拖拽的框选矩形(world 坐标;null = 未在框选) */
  selectionRect: Rect | null;
  /** 节点分组(绘制组框 + 组徽标) */
  groups: NodeGroup[];
  /** 框选模式开关开启时,空白处拖拽走框选(否则平移) */
  marqueeMode: boolean;
  /** 取消进行中的框选(清 selRectRef + 隐藏矩形);返回 true = 确实取消了一次进行中的框选。
   *  用于把「清空选区」的时机从 click 提前到 pointerdown(见下方注释) */
  onCancelMarquee: () => boolean;
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
  /** 节点主体按下(拖动整块选区;Shift = 切换选中) */
  onNodeSelect: (n: CanvasNode, e: React.PointerEvent) => void;
  onNodeContextMenu: (e: React.MouseEvent, n: CanvasNode) => void;
  onNodeHeaderPointerDown: (e: React.PointerEvent, n: CanvasNode) => void;
  onNodeAddPointerDown: (e: React.PointerEvent, n: CanvasNode) => void;
  onNodeAddClick: (e: React.MouseEvent, n: CanvasNode) => void;
  registerNodeRef: (id: string, el: HTMLDivElement | null) => void;
  /** 点组徽标/组框的操作(CanvasPage 实现) */
  onSelectGroup: (groupId: string) => void;
  /** 「+」弹层(CanvasPage 组合 AddNodePopover 后置入 world 容器) */
  popover: React.ReactNode;
}

export function StageView({
  view,
  panning,
  nodes,
  edgePaths,
  selectedIds,
  selectionRect,
  groups,
  marqueeMode,
  onCancelMarquee,
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
  onSelectGroup,
  popover,
}: StageViewProps) {
  /* 小地图布局:节点包围盒 + 视口的投影(view/nodes/stageSize 任一变化即重算) */
  const mmLayout = useMemo(
    () => minimapLayout(nodes, view, stageSize, MINIMAP_SIZE),
    [nodes, view, stageSize],
  );

  /** 取消进行中的框选:返回 true = 确实取消了一次(调用方据此跳过「清空选区」) */
  const cancelMarquee = (): boolean => {
    if (!selectionRect) return false;
    onCancelMarquee();
    return true;
  };
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

  /** 选中集合(用于 O(1) 判断节点是否高亮) */
  const selSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  /** 有分组的节点 → 组色(节点卡片显示组徽标) */
  const groupOfNodeId = useMemo(() => {
    const m = new Map<string, NodeGroup>();
    for (const g of groups) for (const id of g.members) m.set(id, g);
    return m;
  }, [groups]);
  /** 每个组的包围盒(组框;与节点同处 world 坐标系,自动跟随缩放/平移) */
  const groupBoxes = useMemo(
    () =>
      groups
        .map((g) => ({ g, box: boundingRect(nodes, g.members) }))
        .filter((x): x is { g: NodeGroup; box: Rect } => x.box !== null),
    [groups, nodes],
  );

  return (
    <section
      className={`stage${panning ? ' panning' : ''}${marqueeMode ? ' marquee' : ''}`}
      data-od-id="canvas-stage"
      ref={(el) => {
        stageRef.current = el;
      }}
      onPointerDown={(e) => {
        // 任何按下先结束「上一轮」残留的框选状态(见下方清选区注释)
        cancelMarquee();
        const t = e.target as HTMLElement;
        if (t !== e.currentTarget && !t.classList.contains('world') && t.tagName !== 'svg')
          return;
        onStagePointerDown(e);
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
        onPointerDown={(e) => {
          // 点在世界容器自身 = 点了空白(**注意不是 drag 事件**):
          //  · 控件(节点 / 组框标题 / 弹层 / 框选矩形)的 pointerdown 都会 stopPropagation,
          //    所以能冒泡到这里的只有空白;
          //  · 选区清空放在 pointerdown 而不是 click —— React 的 click 在整套
          //    pointerdown → pointerup → click 之后才触发,而框选结束就在 pointerup,
          //    在 click 里清选区会把**刚框出来的选区**一起清掉(真实事故)。
          if (e.target !== e.currentTarget) return;
          if (cancelMarquee()) return;
          onWorldClick();
        }}
      >
        {/* 组框:画在节点下方(z-index 由 CSS 控制);只有标题条可点(避免挡住节点拖动) */}
        {groupBoxes.map(({ g, box }) => (
          <div
            key={g.id}
            className={`group-box tone-${g.tone ?? 'neutral'}`}
            data-od-id="canvas-group-box"
            data-group={g.id}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              left: box.x - GROUP_PAD,
              top: box.y - GROUP_PAD,
              width: box.w + GROUP_PAD * 2,
              height: box.h + GROUP_PAD * 2,
            }}
          >
            <span
              className="gname"
              role="button"
              tabIndex={-1}
              title={`选中整组「${g.name}」`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onSelectGroup(g.id);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                onSelectGroup(g.id);
              }}
            >
              {g.name}
            </span>
          </div>
        ))}

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
            selected={selSet.has(n.id)}
            flash={flashId === n.id}
            group={groupOfNodeId.get(n.id) ?? null}
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

        {/* 框选矩形:最上层,pointer-events:none 不参与命中 */}
        {selectionRect && selectionRect.w > 0 && selectionRect.h > 0 ? (
          <div
            className="sel-rect"
            data-od-id="canvas-selection-rect"
            style={{
              left: selectionRect.x,
              top: selectionRect.y,
              width: selectionRect.w,
              height: selectionRect.h,
            }}
          />
        ) : null}

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