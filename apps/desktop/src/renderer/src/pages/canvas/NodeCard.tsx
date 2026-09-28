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
import type { NodeGroup } from './selection';

/** 运行期标签的语义配色:排队中(黄)/ 失败(红)/ 进行中(强调色)。
 *  运行中(running=true)一律按「进行中」处理,忽略文案关键词。 */
function badgeTone(badge: string, running?: boolean): 'queued' | 'failed' | 'busy' {
  if (running) return badge.startsWith('排队') || badge.startsWith('已入队') ? 'queued' : 'busy';
  if (badge.startsWith('排队') || badge.startsWith('已入队')) return 'queued';
  if (badge.includes('失败')) return 'failed';
  return 'busy';
}

interface NodeCardProps {  node: CanvasNode;
  selected: boolean;
  flash: boolean;
  /** 此节点正在被拖动:挂 `dragging` 类,提前提升为独立合成层(见 design-pages.css) */
  dragging: boolean;
  /** 所属分组(null = 未分组);有组时头部显示组徽标 */
  group: NodeGroup | null;
  /** 当前 connectDrag 命中此节点(cur 是拖拽建边的目标) */
  isConnectTarget: boolean;
  connectHitOk: boolean;
  /** 当前画布全部节点(NodeBody 分镜表统计用) */
  nodes: CanvasNode[];
  /** nodeId → 最新成功 Take 产物路径(状态点 + 卡片内容回填) */
  takeResults: Record<string, string>;
  /** assetId → 资产展示元信息(分类/缩略图;asset 节点渲染用) */
  assetMeta: Record<string, { name: string; kind: string; categoryName?: string; src: string | null }>;
  /** 点选:带 pointerdown 事件,CanvasPage 据此决定「选中」还是「开始拖动整块选区」 */
  onSelect: (node: CanvasNode, e: React.PointerEvent) => void;
  onContextMenu: (e: React.MouseEvent, node: CanvasNode) => void;
  onHeaderPointerDown: (e: React.PointerEvent, node: CanvasNode) => void;
  onAddPointerDown: (e: React.PointerEvent, node: CanvasNode) => void;
  onAddClick: (e: React.MouseEvent, node: CanvasNode) => void;
  /** 注册/注销 DOM 节点(ResizeObserver 与拖拽定位用) */
  registerRef: (id: string, el: HTMLDivElement | null) => void;
}

function NodeCardInner({
  node: n,
  selected,
  flash,
  dragging,
  group,
  isConnectTarget,
  connectHitOk,
  nodes,
  takeResults,
  assetMeta,
  onSelect,
  onContextMenu,
  onHeaderPointerDown,
  onAddPointerDown,
  onAddClick,
  registerRef,
}: NodeCardProps) {
  const ameta = n.kind === 'asset'
    ? assetMeta[String((n.data as { assetId?: unknown } | undefined)?.assetId ?? '')]
    : undefined;
  const cls = [
    'node',
    n.ghost ? 'ghost' : '',
    n.stale ? 'stale' : '',
    n.agentOn ? 'agent-on' : '',
    selected ? 'sel' : '',
    flash ? 'flash' : '',
    dragging ? 'dragging' : '',
    group ? `grouped tone-${group.tone ?? 'neutral'}` : '',
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
      onPointerDown={(e) => {
        // 节点主体按下:启动「拖动整块选区」预备态(与头部同样走拖动);
        // 不 stopPropagation —— 让 CanvasPage 统一处理(它自己判断命中节点)
        onSelect(n, e);
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => onContextMenu(e, n)}
    >
      {/* 长任务进度条(视频增强:超分 + 合修脸)。
          确定态(pct)画填充条;不确定态(Real-ESRGAN/ffmpeg 不打印进度)走滚动动画,
          两者都显示实时文案 —— 分钟级任务必须让用户看见"在动"。 */}
      {n.progress ? (
        <span className="node-badge node-progress" data-od-id="node-progress">
          <span className="np-text">
            <span className="spin"></span>
            {n.progress.stage ? <b className="np-stage">{n.progress.stage}</b> : null}
            <span className="np-label">{n.progress.text}</span>
            {n.progress.pct !== undefined ? <b className="np-pct">{Math.round(n.progress.pct * 100)}%</b> : null}
          </span>
          {/* 整体百分比填充条;无细分进度的阶段用滚动动画表示「在跑」 */}
          <span className={`np-bar${n.progress.indet ? ' indet' : ''}`}>
            {n.progress.indet ? (
              <i></i>
            ) : (
              <i className="fill" style={{ width: `${Math.round((n.progress.pct ?? 0) * 100)}%` }}></i>
            )}
          </span>
        </span>
      ) : n.badge ? (
        /* 运行期标签配色按语义走(队列是唯一真源,见 CanvasPage 队列订阅):
           排队中 = 黄(还没轮到执行),失败 = 红,生成中 = 强调色 */
        <span
          className={`node-badge${badgeTone(n.badge, n.running) === 'queued' ? ' node-queued' : badgeTone(n.badge, n.running) === 'failed' ? ' node-failed' : ''}`}
          data-od-id="node-badge"
        >
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
        {/* 所属分组徽标(点按可选中整组) */}
        {group ? (
          <span className="st group-tag" data-od-id="node-group-tag" title={`属于「${group.name}」`}>
            {group.name}
          </span>
        ) : null}
        {/* asset 节点:节点头部显示资产分类 badge(设计稿 st badge) */}
        {ameta?.categoryName ? (
          <span className="st badge" data-od-id="node-asset-cat">{ameta.categoryName}</span>
        ) : null}
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
      <NodeBody node={n} nodes={nodes} takeResults={takeResults} assetMeta={assetMeta} />
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

/**
 * 包 memo(P1):视口平移/缩放只改 view,节点内容与选中态都没变 ——
 * 不加这层的话每次 setView 都会重跑全部卡片(含 NodeBody 里的分镜表统计、
 * 产物图 diff),节点一多就是整帧的 reconcile 开销。
 *
 * ⚠️ memo 生效的前提是 props 引用稳定,调用方(StageView / CanvasPage)必须:
 *   · 回调全部 useCallback(否则每帧都是新函数,浅比较永远为 false);
 *   · 别把「每次渲染都新建」的数组/对象传进来(如全量 nodes → 见 StageView
 *     的 refNodes 派生)。
 * 这里用默认浅比较即可 —— 所有 props 都是原始值、稳定引用或已派生的精简值。
 */
export const NodeCard = React.memo(NodeCardInner);