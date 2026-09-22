import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { CanvasSnapshot, ProjectCanvases, RenderJob, Asset, AssetCategory, NodeKind, Take, DebugLogEntry, PromptSource } from '@bigbotart/shared';
import {
  parseGfmTable,
  resolvePromptFromSource,
  assembleH3Prompt,
  assembleZImagePrompt,
  rowNeedsImage,
  rowSeconds,
  tableToGfm,
} from '@bigbotart/shared';
import type { CanvasPageProps, EdgeClass, Edge, CanvasNode, NodeTag, NodeInfo, ConnectDrag } from './canvas/types';
import {
  NODE_TYPES,
  RES,
  NODE_INFO_BASE,
} from './canvas/constants';
import {
  deriveEdgeLabel,
  makeInitialData,
  fromSharedNode,
  toSharedNodes,
  toLocalEdges,
  toSharedEdges,
  dedupeNodeIds,
  seedIdCounter,
} from './canvas/node-mapping';
import { resolvePort, resolvePortOptions, type PortResolution } from './canvas/connectors';
import { CASCADE_KINDS, allDownstreamGenIds, pickCascadeTargets } from './canvas/cascade';
import { sbMaterializedRows, sbImgCount, sbTableOf, sbDirty, SB_SIZE } from './canvas/storyboard';
import { basenameOf, thumbSrc } from './canvas/media';
import { nodesReducer } from './canvas/edge-dispatch';
import { Toolbar } from './canvas/Toolbar';
import { Palette } from './canvas/Palette';
import { StageView } from './canvas/StageView';
import { AddNodePopover } from './canvas/AddNodePopover';
import { usePrompt } from '../components/usePrompt';
import { PortPickPop } from './canvas/PortPickPop';
import { AgentPane } from './canvas/AgentPane';
import { InspectorPane } from './canvas/InspectorPane';
import { ContextMenu } from './canvas/ContextMenu';
import { DebugPanel } from './canvas/DebugPanel';
import { QueueBar } from './canvas/QueueBar';
import { AssetPickerPop } from './canvas/AssetPickerPop';
import { useAgentChat } from './agent/useAgentChat';

/** 节点尚未测得高度时的估算兜底(px):连线端点/预览线首帧用,实测后立即被替换 */
const UNMEASURED_NODE_H = 72;

export default function CanvasPage({
  onNavigate,
  projectId,
  projectName,
  projectCanvases,
  onSaveCanvas,
  onSwitchCanvas,
  onCreateCanvas,
  onDeleteCanvas,
  onRenameCanvas,
}: CanvasPageProps) {
  const stageRef = useRef<HTMLElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const edgesSvgRef = useRef<SVGSVGElement | null>(null);
  const nodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  /** 节点尺寸观测器(连线端口/弹层定位用):注册回调即时 observe,不依赖 nodes.length 重建 —
     整数组替换且数量不变时旧 observer 会盯住已卸载 DOM,新节点 h 缺失 → 连线端点到节点顶部 */
  const roRef = useRef<ResizeObserver | null>(null);
  const gripRef = useRef<HTMLButtonElement | null>(null);
  const agentRef = useRef<HTMLElement | null>(null);
  const minimapRef = useRef<HTMLDivElement | null>(null);
  const toastTimer = useRef<number | null>(null);
  const queueTimer = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);

  /* ── 视图:平移 / 缩放(以指针为中心滚轮缩放) ── */
  const [view, setView] = useState({ x: 20, y: 10, z: 0.86 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [panning, setPanning] = useState(false);

  /* ── 画布数据 ──
   初始为空画布(不播种设计稿演示数据):真实节点一律来自已存盘画布快照。
   演示节点/连线(initialNodes/initialEdges)仅作 constants 保留,不再作为 state 初始值,
   否则进画布时会看到测试数据、且自动保存会把演示数据写进真实项目。

   nodes 走 useReducer(单一数据源,全部写入经 nodesReducer):
   - 普通写入 → { type: 'set', updater }(updater 必须纯,StrictMode 下 reducer 双跑)
   - 边分派 → { type: 'derive-from-edges', edges }(见 edge-dispatch.ts)
   对外 setNodes 保持 React.Dispatch<SetStateAction> 签名,内部转 dispatch,
   所有既有调用点与 InspectorBody 等子组件 props 无需改动。 */
  const [nodes, dispatchNodes] = useReducer(nodesReducer, []);
  const setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>> = useCallback(
    (arg: CanvasNode[] | ((prev: CanvasNode[]) => CanvasNode[])) => {
      dispatchNodes({
        type: 'set',
        updater: typeof arg === 'function' ? arg : () => arg,
      });
    },
    [],
  );
  const [edges, setEdges] = useState<Edge[]>([]);
  /** store 侧已知快照版本(挂载/刷新/推送时更新;保存用它,避免旧版本整体覆盖 Agent 的增量写盘) */
  const [knownVersion, setKnownVersion] = useState(0);
  const knownVersionRef = useRef(0);
  knownVersionRef.current = knownVersion;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const [selected, setSelected] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [infoMap, setInfoMap] = useState<Record<string, NodeInfo>>(() => ({
    ...NODE_INFO_BASE,
  }));

  /* ── 面板 / 弹层 / 底部状态 ── */
  const [palCollapsed, setPalCollapsed] = useState(false);
  const [agentW, setAgentW] = useState(344);
  const [agentResizing, setAgentResizing] = useState(false);
  const [tab, setTab] = useState<'chat' | 'insp'>('chat');
  const [openPop, setOpenPop] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string } | null>(null);
  /** 正在重命名的节点 id(null = 无;节点头部显示内联输入框,Electron 不支持 window.prompt) */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; n: number } | null>(null);
  const [inspectTitle, setInspectTitle] = useState('镜头 02 · 男主踱步');

  /* ── 自增 id / 演示附件轮换 ──
     id 必须全局唯一:重复 id 会让 React key 冲突、拖拽时同号节点一起动、
     findFreeSpot 去重失效(表现为新节点与旧节点完全重合、分不开)。
     useRef 在组件重挂载时会归零,所以这里既扫描已有节点做种子,
     又保留一个随机后缀兜底(跨卸载重挂载也不会再撞号)。 */
  const nextId = useRef(0);
  const idSalt = useRef(Math.random().toString(36).slice(2, 6));
  /** 生成唯一节点 id;已占用的 id 会自动跳过 */
  const makeNodeId = useCallback((prefix: string): string => {
    for (let i = 0; i < 200; i++) {
      const id = `${prefix}${++nextId.current}-${idSalt.current}`;
      if (!nodesRef.current.some((n) => n.id === id)) return id;
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }, []);
  /* ── M1:渲染队列(真实任务) + 画布持久化 ── */
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const bootRef = useRef(true); // 挂载期跳过首轮保存(等加载/规划落地)
  const prevJobState = useRef<Record<string, string>>({});
  /** 接力轮次中已提交、仍存活的任务(去重防重复入队;终态后移除) */
  const cascadePendingRef = useRef<Set<string>>(new Set());
  /** 最新接力触发函数(渲染时重绑,引用最新 runNode,避免 effect 闭包拿到旧版本) */
  const cascadeKickRef = useRef<(nodeId: string, jobs: RenderJob[], freshTail?: string) => void>(() => {});
  const assetCache = useRef<Record<string, string>>({}); // assetId → localPath
  const [assetsList, setAssetsList] = useState<Asset[]>([]);
  const [categories, setCategories] = useState<AssetCategory[]>([]);
  /** 资产选择弹层(「更换资产…」/检查器选资产):null = 关闭,值 = 目标 asset 节点 id */
  const [assetPickFor, setAssetPickFor] = useState<string | null>(null);
  const [assetPopPos, setAssetPopPos] = useState<{ x: number; y: number } | null>(null);

  /* ── 「+」下游节点弹层 ── */
  const [apFrom, setApFrom] = useState<string | null>(null);
  const [apOpen, setApOpen] = useState(false);
  /** 「+」弹层打开计数:每次打开 +1(AddNodePopover 用它重置内部搜索/选中) */
  const [apOpenCount, setApOpenCount] = useState(0);

  /* Agent 对话面板:全部状态/副作用在 pages/agent/useAgentChat(本组件只持有返回值) */
  const selInfo = selected ? infoMap[selected] : undefined;
  const selNode = selected ? nodes.find((n) => n.id === selected) : undefined;

  const toastMsg = useCallback((msg: string) => {
    setToast({ msg, n: Date.now() });
  }, []);

  useEffect(() => {
    if (!toast) return;
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    const msg = toast.msg;
    toastTimer.current = window.setTimeout(() => {
      setToast((cur) => (cur && cur.msg === msg ? null : cur));
    }, 2400);
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, [toast]);

  /* ── 尺寸观测:连线端口 + 「+」弹层定位 ──
     RO 只创建一次,由 registerNodeRef 在 DOM 挂载时即时 observe/unobserve:
     修复「整数组替换(切画布/刷新/快照推送)且节点数不变时,effect 不重建、
     新节点 DOM 从未被测量 → n.h 缺失 → 连线端点到节点顶部(位置错误)」 */
  const measure = useCallback((id: string, h: number) => {
    const el = nodeRefs.current.get(id);
    if (!el) return;
    const w = el.offsetWidth;
    setNodes((ns) =>
      ns.some((n) => n.id === id && n.h === h && n.w === w)
        ? ns
        : ns.map((n) => (n.id === id ? { ...n, h, w } : n)),
    );
  }, []);

  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.node;
        if (!id) continue;
        measure(id, (e.target as HTMLElement).offsetHeight);
      }
    });
    roRef.current = ro;
    // 首屏节点在 effect 前已由 ref 回调注册,这里补齐观察(observe 幂等)
    nodeRefs.current.forEach((el) => ro.observe(el));
    return () => {
      ro.disconnect();
      roRef.current = null;
    };
  }, [measure]);

  /* ── 节点定位 + 拖拽(scale 校正,和 canvas.js 一致) ── */
  const dragRef = useRef<{
    id: string;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
  } | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const z = viewRef.current.z;
      setNodes((ns) =>
        ns.map((n) =>
          n.id === d.id
            ? { ...n, x: d.ox + (e.clientX - d.sx) / z, y: d.oy + (e.clientY - d.sy) / z }
            : n,
        ),
      );
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  /* ── 「+」按钮 → 拖拽连接到已有节点(松开命中目标即建边)──
   * 拖动期间:跟手画临时虚线 + 命中节点高亮(可连=绿,不可连=红);
   * 命中空白 / 不可连 → 保持原弹层行为;命中可连 → 写边 + 关闭弹层。
   * 详见 docs/节点手册.md §3 + 连接器设计.md §5。 */
  const connectDragRef = useRef<ConnectDrag | null>(null);
  /** 触发重渲染用的镜像 state(每帧由 raf 节流更新一次) */
  const [connectDrag, setConnectDrag] = useState<ConnectDrag | null>(null);

  /** 由源节点中心 + 当前屏幕坐标 → 临时预览线端点(world 坐标系;跟 edges SVG 一致) */
  const computeConnectPath = useCallback((srcId: string, cx: number, cy: number): string | null => {
    const src = nodesRef.current.find((n) => n.id === srcId);
    if (!src) return null;
    const v = viewRef.current;
    const sx = src.x + (src.w ?? 236);
    const sy = src.y + (src.h ?? UNMEASURED_NODE_H) / 2; // 右缘垂直中点(与定稿线 edgePaths 同口径)
    const wx = (cx - v.x) / v.z;
    const wy = (cy - v.y) / v.z;
    // 中点加一个小弧度让连接线有方向感
    const mx = (sx + wx) / 2;
    return `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${wy}, ${wx} ${wy}`;
  }, []);

  /** 「+」按下 → 进入 connectDrag 预备态(moved=false) */
  const beginConnectDrag = useCallback((sourceId: string, sx: number, sy: number) => {
    const init: ConnectDrag = { sourceId, sx, sy, cx: sx, cy: sy, hitId: null, hitOk: false, moved: false };
    connectDragRef.current = init;
    setConnectDrag(init);
  }, []);

  /** 命中检测:屏幕坐标 → 节点 id */
  const hitTestNode = useCallback((clientX: number, clientY: number): { id: string; ok: boolean } | null => {
    const el = document.elementFromPoint(clientX, clientY);
    if (!el) return null;
    const nodeEl = (el as HTMLElement).closest('[data-node]') as HTMLElement | null;
    if (!nodeEl) return null;
    const id = nodeEl.dataset.node;
    if (!id || id === connectDragRef.current?.sourceId) return null;
    const src = nodesRef.current.find((n) => n.id === connectDragRef.current?.sourceId);
    if (!src) return null;
    const dst = nodesRef.current.find((n) => n.id === id);
    if (!dst) return null;
    const tag: NodeTag = dst.tag ?? { id: dst.kind ?? 'plain', kind: (dst.kind ?? 'document') as NodeKind, name: dst.title, sub: '' };
    const port = resolvePort(src, tag.id);
    return { id, ok: port !== null };
  }, []);

  /** 写边(命中可连节点);port 给定时显式指定端口角色(多端口组合,如 asset 图 → shot) */
  const commitConnectEdge = useCallback((srcId: string, dstId: string, port?: string) => {
    const src = nodesRef.current.find((n) => n.id === srcId);
    const dst = nodesRef.current.find((n) => n.id === dstId);
    if (!src || !dst) return;
    const tag: NodeTag = dst.tag ?? { id: dst.kind ?? 'plain', kind: (dst.kind ?? 'document') as NodeKind, name: dst.title, sub: '' };
    const edgeLabel = deriveEdgeLabel(src, tag, port);
    if (edgeLabel === undefined) return; // 无连接器(双重保险)
    setEdges((es) => {
      // 完全相同边不去重:允许同 src→dst 重复(shot→timeline 多条入线本就支持)
      // 但若「label 也一样」则跳过,避免无意义的 dup
      if (es.some((e) => e.from === srcId && e.to === dstId && e.label === edgeLabel)) {
        toastMsg(`已存在相同连线:${src.title} → ${dst.title}${edgeLabel ? ` · ${edgeLabel}` : ''}`);
        return es;
      }
      // commitConnectEdge 是拖拽连到**已有节点**,边立即可用 → 实线(cls: ''),不用幽灵虚线
      return [...es, { from: srcId, to: dstId, cls: '', label: edgeLabel }];
    });
    toastMsg(`已连线:${src.title} → ${dst.title}${edgeLabel ? ` · ${edgeLabel}` : ''}`);
    setApOpen(false);
  }, [toastMsg]);

  /** 全局 pointermove/up/keydown 处理 connectDrag */
  useEffect(() => {
    let rafId = 0;
    let pending: { cx: number; cy: number } | null = null;

    const flush = () => {
      rafId = 0;
      const d = connectDragRef.current;
      const p = pending;
      pending = null;
      if (!d || !p) return;
      const dx = p.cx - d.sx;
      const dy = p.cy - d.sy;
      const moved = d.moved || Math.hypot(dx, dy) > 4;
      const hit = hitTestNode(p.cx, p.cy);
      const next: ConnectDrag = {
        ...d,
        cx: p.cx,
        cy: p.cy,
        hitId: hit?.id ?? null,
        hitOk: hit?.ok ?? false,
        moved,
      };
      connectDragRef.current = next;
      setConnectDrag({ ...next });
    };

    const onMove = (e: PointerEvent) => {
      const d = connectDragRef.current;
      if (!d) return;
      pending = { cx: e.clientX, cy: e.clientY };
      if (!rafId) rafId = requestAnimationFrame(flush);
    };

    const onUp = (e: PointerEvent) => {
      const d = connectDragRef.current;
      if (!d) return;
      const wasDragging = d.moved;
      const finalHit = hitTestNode(e.clientX, e.clientY);
      connectDragRef.current = null;
      setConnectDrag(null);
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      pending = null;
      // 仅在「真的拖动过」+ 「命中可连节点」时建边
      if (wasDragging && finalHit?.ok && finalHit.id) {
        const srcN = nodesRef.current.find((n) => n.id === d.sourceId);
        const dstN = nodesRef.current.find((n) => n.id === finalHit.id);
        const tag: NodeTag = dstN?.tag ?? {
          id: dstN?.kind ?? 'plain',
          kind: (dstN?.kind ?? 'document') as NodeKind,
          name: dstN?.title ?? '',
          sub: '',
        };
        const opts = srcN ? resolvePortOptions(srcN, tag.id) : [];
        // 多端口组合(asset 图 → shot 首帧/参考图):先弹角色选择,选定后写边;单端口直接连
        if (opts.length > 1) {
          setPortPick({ from: d.sourceId, to: finalHit.id, x: e.clientX, y: e.clientY, options: opts });
        } else {
          commitConnectEdge(d.sourceId, finalHit.id);
        }
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && connectDragRef.current) {
        connectDragRef.current = null;
        setConnectDrag(null);
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        pending = null;
        setApOpen(false);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [hitTestNode, commitConnectEdge]);

  /* ── 空白处拖拽平移 ── */
  const panStartRef = useRef({ sx: 0, sy: 0, vx: 0, vy: 0 });
  const beginPan = (e: React.PointerEvent) => {
    panStartRef.current = {
      sx: e.clientX,
      sy: e.clientY,
      vx: viewRef.current.x,
      vy: viewRef.current.y,
    };
    setPanning(true);
  };
  useEffect(() => {
    if (!panning) return;
    const onMove = (e: PointerEvent) => {
      const s = panStartRef.current;
      setView((v) => ({ ...v, x: s.vx + (e.clientX - s.sx), y: s.vy + (e.clientY - s.sy) }));
    };
    const onUp = () => setPanning(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [panning]);

  /* ── 滚轮:以指针为中心缩放 ── */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      // 弹窗/菜单内的滚轮用于滚动它自己的内容(如「+」弹窗的类型列表),不缩放画布
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('.add-pop, .pop, .ctx, .ap-list, .ap-conn')) return;
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0016);
        const nz = Math.min(1.3, Math.max(0.4, v.z * factor));
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const k = nz / v.z;
        return { z: nz, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k };
      });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  /* ── Agent 面板宽度 ── */
  const agentMax = useCallback(
    () => Math.min(620, Math.round(window.innerWidth * 0.5)),
    [],
  );

  const setAgentWidth = useCallback(
    (w: number, commit: boolean) => {
      const nw = Math.max(344, Math.min(agentMax(), Math.round(w)));
      setAgentW(nw);
      if (gripRef.current) gripRef.current.style.right = `${12 + nw - 6}px`;
      if (minimapRef.current) minimapRef.current.style.right = `${nw + 26}px`;
      if (commit) {
        try {
          localStorage.setItem('bba-agent-w', String(nw));
        } catch {
          /* 忽略存储异常 */
        }
      }
      return nw;
    },
    [agentMax],
  );

  useEffect(() => {
    let saved = 344;
    try {
      const raw = parseInt(localStorage.getItem('bba-agent-w') ?? '', 10);
      if (!Number.isNaN(raw)) saved = raw;
    } catch {
      /* 忽略存储异常 */
    }
    setAgentWidth(saved, false);
    const onResize = () => setAgentWidth(agentWRef.current, false);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [setAgentWidth]);

  const agentWRef = useRef(agentW);
  agentWRef.current = agentW;

  const agentDragRef = useRef<{ sx: number; w: number } | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = agentDragRef.current;
      if (!d) return;
      setAgentWidth(d.w + (d.sx - e.clientX), false);
    };
    const onUp = () => {
      if (!agentDragRef.current) return;
      agentDragRef.current = null;
      setAgentWidth(agentWRef.current, true);
      setAgentResizing(false);
      gripRef.current?.classList.remove('on');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [setAgentWidth]);

  /* ── 定位到节点(闪一下) ── */
  const locate = useCallback((id: string) => {
    setFlashId(id);
    window.setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), 1200);
  }, []);

  /* ══ 选择节点 → 检查器 ══ */
  const selectNode = useCallback((id: string | null) => {
    setSelected(id);
    if (!id) {
      // 未选任何节点:检查器不应残留上一节点的标题
      setInspectTitle('未选择节点');
      return;
    }
    const info = NODE_INFO_BASE[id];
    setInfoMap((m) => {
      if (m[id] || !info) return m;
      return { ...m, [id]: info };
    });
    // 演示节点用 NODE_INFO_BASE 标题;新节点用自身 title
    const node = nodesRef.current.find((n) => n.id === id);
    setInspectTitle(info?.t ?? node?.title ?? id);
    setTab('insp');
  }, []);

  /* 当前活动画布 id(派生自 props) */
  const activeCanvasId = projectCanvases?.activeCanvasId ?? '';
  const activeCanvas = projectCanvases?.canvases.find((c) => c.id === activeCanvasId);

  /** 构建当前画布快照(节点+边)——给保存/切换前 flush-save 用;可传覆盖(自愈回写) */
  const buildActiveSnapshot = useCallback(
    (ns?: CanvasNode[], es?: Edge[]): CanvasSnapshot | null => {
      if (!activeCanvas) return null;
      return {
        id: activeCanvas.id,
        projectId: activeCanvas.projectId,
        name: activeCanvas.name,
        nodes: toSharedNodes(ns ?? nodes) as never,
        edges: toSharedEdges(es ?? edges) as never,
        // 用已知版本(随推送/刷新前进),保证不落后于 store —— 落后会导致 saveCanvasSnapshot 版本防护拒绝覆盖
        version: knownVersion || activeCanvas.version,
        createdAt: activeCanvas.createdAt,
        updatedAt: new Date().toISOString(),
      };
    },
    [activeCanvas, nodes, edges, knownVersion],
  );

  /** 最近一次确认与 store 一致的内容基线(JSON)—— 卸载/防抖保存前比对,无变化不写盘。
   *  防止「version 对齐但内容为空/旧」的崩溃/重挂场景覆盖 store(与主进程版本防护双保险)。 */
  const lastSavedRef = useRef('');
  /** 标记内容基线为「与 store 一致」(加载/推送/保存成功后调用) */
  const markBaseline = useCallback((ns: CanvasNode[], es: Edge[]) => {
    lastSavedRef.current = JSON.stringify([ns, es]);
  }, []);
  /** 保存当前快照:内容相对基线有真实变化才写盘;写盘后把基线推进到已保存内容。
   *  opts.allowEmpty = true 仅 auto-save 使用(用户清空画布是合法编辑);
   *  卸载/切画布 flush 默认禁止空快照覆盖 —— 崩溃时内存 state 可能为空,不得覆盖 store 有内容的画布。 */
  const maybePersist = useCallback(
    (snap: CanvasSnapshot | null, opts?: { allowEmpty?: boolean }) => {
      if (!snap) return;
      const local = JSON.stringify([snap.nodes, snap.edges]);
      if (local === lastSavedRef.current) return;
      if (opts?.allowEmpty !== true) {
        const hasContent = (snap.nodes?.length ?? 0) > 0 || (snap.edges?.length ?? 0) > 0;
        const baselineHasContent = lastSavedRef.current !== '' && lastSavedRef.current !== '[[],[]]';
        if (!hasContent && baselineHasContent) return;
      }
      lastSavedRef.current = local;
      void onSaveCanvas(snap);
    },
    [onSaveCanvas],
  );

  /** 切换画布前先 flush 当前画布的未保存改动 */
  const flushSaveNow = useCallback(() => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    maybePersist(buildActiveSnapshot());
  }, [buildActiveSnapshot, maybePersist]);

  /** 切画布包装:先 flush-save 再走 onSwitchCanvas */
  const switchCanvas = useCallback(
    async (id: string): Promise<CanvasSnapshot | null> => {
      if (id === activeCanvasId) return activeCanvas ?? null;
      flushSaveNow();
      return onSwitchCanvas(id);
    },
    [activeCanvasId, activeCanvas, flushSaveNow, onSwitchCanvas],
  );

  /* ⚠️ 卸载前把待写的防抖保存强制落盘。
     自动保存是 800ms 防抖;组件卸载时 effect cleanup 会 clearTimeout,
     于是"刚编辑过、还没到 800ms"的内容会被整段丢弃 —— 导航离开、热更新重挂载
     (开发期改代码)都会命中,表现为「刚填的提示词/参数不见了」。
     这里用空依赖 effect 的 cleanup 做兜底 flush,保证内存里的最后状态一定写盘。 */
  const saveFlushRef = useRef<() => void>(() => {});
  saveFlushRef.current = () => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    maybePersist(buildActiveSnapshot());
  };
  useEffect(() => () => saveFlushRef.current(), []);

  /* 挂载 / 切换画布 / 项目切换 / 画布列表就绪:把 active 快照装进本地 nodes/edges
     依赖带上 projectCanvases:若进入画布时列表尚未就绪(early return),就绪后补加载,
     避免停留在空画布/演示数据上。 */
  useEffect(() => {
    if (!projectCanvases || !activeCanvas) return;
    bootRef.current = true;
    setKnownVersion(activeCanvas.version ?? 0);
    // 自愈:历史上可能存了重复 id 的节点(两个 pal1 之类)——重号会导致重合、拖拽分不开。
    // 这里自动改 id + 错开坐标 + 修连线;有改写就先落盘,保证旧数据也能恢复。
    const loaded = activeCanvas.nodes.map((n) => fromSharedNode(n as never));
    const selfHeal = dedupeNodeIds(loaded, toLocalEdges(activeCanvas.edges as never));
    setNodes(selfHeal.nodes);
    setEdges(selfHeal.edges);
    markBaseline(selfHeal.nodes, selfHeal.edges);
    if (selfHeal.changed) {
      const repaired = buildActiveSnapshot(selfHeal.nodes, selfHeal.edges);
      if (repaired) void onSaveCanvas(repaired);
    }
    nextId.current = seedIdCounter(selfHeal.nodes);
    setSelected(null);
    setFlashId(null);
    requestAnimationFrame(() => {
      bootRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCanvasId, projectId, projectCanvases]);

  /** 物化 sessionStorage 里的 Agent 规划(从首页跳到画布时;支持新模式分镜表与旧模式 Brief 两种结构) */
  useEffect(() => {
    const raw = sessionStorage.getItem('bba.plan');
    if (!raw) return;
    sessionStorage.removeItem('bba.plan');
    try {
      const plan = JSON.parse(raw) as {
        document?: unknown;
        shots?: unknown[];
        images?: unknown[];
        storyboard?: unknown;
        edges: Array<{ source: string; target: string }>;
        report?: string;
      };
      if (plan.storyboard) {
        // 新模式:Agent 先出分镜表(分步) → 落 storyboard 节点(+自动档铺出的节点)
        const sbNode = fromSharedNode(plan.storyboard as never);
        const shotNodes = (plan.shots ?? []).map((s) => fromSharedNode(s as never));
        const imgNodes = (plan.images ?? []).map((s) => fromSharedNode(s as never));
        setNodes([sbNode, ...imgNodes, ...shotNodes]);
        setEdges(toLocalEdges(plan.edges ?? []));
        setSelected(shotNodes[0]?.id ?? sbNode.id);
        chat.pushMsg({
          kind: 'sys',
          text: `Agent 已生成分镜表 · ${plan.report ?? ''} · 选中分镜表可在检查器改表后一键铺节点`,
        });
      } else {
        // 旧模式(Brief):document + shots
        const docNode = fromSharedNode(plan.document as never);
        const shotNodes = (plan.shots ?? []).map((s) => fromSharedNode(s as never));
        setNodes([docNode, ...shotNodes]);
        setEdges(toLocalEdges(plan.edges ?? []));
        setSelected(shotNodes[0]?.id ?? docNode.id);
        chat.pushMsg({ kind: 'agent', odId: 'agent-plan', plan: plan as never });
      }
    } catch (e) {
      console.error('规划落地失败', e);
    }
  }, []);

  /** 资产本地路径缓存 + 分类字典(挂载时拉取) */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [list, cats] = await Promise.all([
          window.bigbotart.listAssets(),
          window.bigbotart.listAssetCategories(),
        ]);
        if (alive) {
          assetCache.current = Object.fromEntries(list.map((a) => [a.id, a.localPath]));
          setAssetsList(list);
          setCategories(cats);
        }
      } catch {
        /* 资产可为空 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);

  /** assetId → 展示元信息(asset 节点渲染:缩略图/分类/媒体) */
  const assetMeta = useMemo(() => {
    const m: Record<string, { name: string; kind: string; categoryName?: string; src: string | null }> = {};
    for (const a of assetsList) {
      const cat = categories.find((c) => c.id === a.categoryId);
      m[a.id] = { name: a.name, kind: a.kind, categoryName: cat?.name, src: thumbSrc(a.localPath) };
    }
    return m;
  }, [assetsList, categories]);

  /** 本项目资源计数(顶栏「资源」入口角标) */
  const assetCount = useMemo(
    () => assetsList.filter((a) => a.projectId === projectId).length,
    [assetsList, projectId],
  );

  /** 资产选择弹层候选:项目资源在前,后补全局共享 */
  const pickerAssets = useMemo(() => {
    const proj = assetsList.filter((a) => a.projectId === projectId);
    const rest = assetsList.filter((a) => a.projectId !== projectId);
    return [...proj, ...rest];
  }, [assetsList, projectId]);

  /** 打开资产选择弹层(锚定到节点右上) */
  const openAssetPicker = useCallback((nodeId: string) => {
    const el = nodeRefs.current.get(nodeId);
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAssetPopPos({ x: Math.round(r.right + 8), y: Math.round(r.top) });
    setAssetPickFor(nodeId);
  }, []);

  /** 换绑资产到节点:更新 assetId + mediaType 锁定为资产 kind(「不可自变」) */
  const bindAssetToNode = useCallback(
    (nodeId: string, asset: Asset) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...(n.data ?? {}), assetId: asset.id, mediaType: asset.kind } }
            : n,
        ),
      );
      toastMsg(`已更换为「${asset.name}」 · 下游绑定同步更新`);
      setAssetPickFor(null);
    },
    [setNodes, toastMsg],
  );

  /** 工具改画布后:从 store 重新拉当前画布刷新节点(Agent 工具增量写盘后主进程会推送快照,这里兜底双保险) */
  const refreshCanvasFromStore = useCallback(async () => {
    if (!projectId || !activeCanvasId) return;
    try {
      const pc = await window.bigbotart.loadProjectCanvases(projectId);
      const cur = pc.canvases.find((c) => c.id === activeCanvasId);
      if (!cur) return;
      setKnownVersion(cur.version ?? 0);
      const loaded = cur.nodes.map((n) => fromSharedNode(n as never));
      const selfHeal = dedupeNodeIds(loaded, toLocalEdges(cur.edges as never[]));
      setNodes(selfHeal.nodes);
      setEdges(selfHeal.edges);
      markBaseline(selfHeal.nodes, selfHeal.edges);
      if (selfHeal.changed) {
        const repaired = buildActiveSnapshot(selfHeal.nodes, selfHeal.edges);
        if (repaired) void onSaveCanvas(repaired);
      }
      nextId.current = seedIdCounter(selfHeal.nodes);
    } catch (e) {
      console.error('刷新画布失败', e);
    }
  }, [projectId, activeCanvasId]);

  /** 画布内容同步(推送的快照或 store 拉取结果)→ 本地 nodes/edges + knownVersion。
   *  内容与版本都没变化时跳过 setState——推送可能来自渲染层自身的保存,重设会触发
   *  auto-save 依赖的 effect 再保存,造成 version 无限增长的写盘循环。 */
  const applyCanvasSnapshot = useCallback((cur: Pick<CanvasSnapshot, 'nodes' | 'edges' | 'version'>) => {
    const loaded = cur.nodes.map((n) => fromSharedNode(n as never));
    const selfHeal = dedupeNodeIds(loaded, toLocalEdges(cur.edges as never[]));
    const version = cur.version ?? 0;
    const sameContent =
      JSON.stringify(selfHeal.nodes) === JSON.stringify(nodesRef.current) &&
      JSON.stringify(selfHeal.edges) === JSON.stringify(edgesRef.current);
    if (sameContent) {
      // 内容没变:只前进 knownVersion(不 setNodes → 不触发 auto-save 再保存 → 避免 version 循环写盘)
      knownVersionRef.current = version;
      setKnownVersion(version);
      markBaseline(selfHeal.nodes, selfHeal.edges);
      return selfHeal;
    }
    setKnownVersion(version);
    setNodes(selfHeal.nodes);
    setEdges(selfHeal.edges);
    markBaseline(selfHeal.nodes, selfHeal.edges);
    nextId.current = seedIdCounter(selfHeal.nodes);
    return selfHeal;
  }, []);

  /* 主进程任何画布写盘(Agent 工具增量 / 自身保存)都会推送快照:
     匹配当前画布则同步本地状态 —— Agent 操作实时可见,且后续保存不再用旧版本覆盖。 */
  useEffect(() => {
    const off = window.bigbotart.onCanvasSnapshotUpdated((snap) => {
      if (!projectId || snap.projectId !== projectId) return;
      if (activeCanvasId && snap.id !== activeCanvasId) return;
      applyCanvasSnapshot(snap);
    });
    return off;
  }, [projectId, activeCanvasId, applyCanvasSnapshot]);

  /* Agent 对话面板:状态/副作用全部收敛到 useAgentChat(pages/agent/),这里只接线 */
  /* 选中节点 ref(随对话请求注入,让 Agent 感知用户正在操作谁;渲染期同步保持稳定引用) */
  const selectedNodeRef = useRef<string | null>(null);
  selectedNodeRef.current = selected;
  const chat = useAgentChat({
    projectId,
    canvasId: activeCanvasId,
    onCanvasMutated: () => void refreshCanvasFromStore(),
    toastMsg,
    selectedNodeRef,
  });

  /* 画布自动持久化(防抖 800ms;只在 active canvas 有内容时写) */
  useEffect(() => {
    if (bootRef.current || !projectId || !activeCanvas) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      maybePersist(buildActiveSnapshot(), { allowEmpty: true });
    }, 800);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, projectId, activeCanvasId]);

  /* 镜头产物回填:nodeId → 最新成功 Take resultPath(画布加载 + 任务完成后刷新)
     (历史 Take 只在 takes json,节点 data 可能缺 resultPath → 渲染时两层回退) */
  const [takeResults, setTakeResults] = useState<Record<string, string>>({});
  const refreshTakeResults = useCallback(async () => {
    if (!projectId) return;
    const shotIds = nodesRef.current.filter((x) => x.kind === 'shot').map((x) => x.id);
    if (shotIds.length === 0) return;
    const out: Record<string, string> = {};
    await Promise.all(
      shotIds.map(async (id) => {
        try {
          const h = await window.bigbotart.takesHistory(projectId, id);
          const ok = h?.takes?.find((t) => t.status === 'succeeded' && t.resultPath);
          if (ok?.resultPath) out[id] = ok.resultPath;
        } catch {
          /* 单个节点失败不影响其它 */
        }
      }),
    );
    setTakeResults(out);
  }, [projectId]);

  /** 重生成某节点 ⇒ 全部下游生成节点标 stale(依赖过期;接力跑完逐个刷新,成功即清) */
  const markDownstreamStale = useCallback((nodeId: string) => {
    const affected = allDownstreamGenIds([nodeId], nodesRef.current, edgesRef.current);
    if (affected.length === 0) return;
    setNodes((ns) => ns.map((x) => (affected.includes(x.id) ? { ...x, stale: true } : x)));
  }, []);
  useEffect(() => {
    void refreshTakeResults();
  }, [refreshTakeResults]);

  /* 渲染队列订阅:主进程变更推送(节流合并)+ 8s 兜底轮询(事件丢包/窗口重载恢复);
     无实质变化(签名相同)时跳过 setJobs,避免 1.2s 全量轮询带来的无谓整树重渲染 */
  useEffect(() => {
    let alive = true;
    let lastSig = '';
    const apply = async (list: RenderJob[]) => {
      const sig = list.map((j) => `${j.id}:${j.status}:${j.progress ?? ''}:${j.stage ?? ''}:${j.resultPath ?? ''}`).join('|');
      if (sig === lastSig) return;
      lastSig = sig;
      setJobs(list);
      // 完成/失败的任务回写节点:成功取 Take 缩略图,失败置 stale
      for (const j of list) {
        const prev = prevJobState.current[j.id];
        if (prev === j.status) continue;
        prevJobState.current[j.id] = j.status;
        // 接力任务终态:从「本接力轮存活集」移除,后续重跑不再被占位挡住
        if (j.status === 'succeeded' || j.status === 'failed' || j.status === 'cancelled') {
          cascadePendingRef.current.delete(j.nodeId);
        }
        if (j.status === 'succeeded') {
          setNodes((ns) =>
            ns.map((n) =>
              n.id === j.nodeId
                ? {
                    ...n,
                    ghost: false,
                    stale: false,
                    badge: undefined,
                    extra: j.resultPath ? `✓ ${basenameOf(j.resultPath)}` : '✓ 生成完成',
                    // 产物路径存进节点 data(节点卡/检查器渲染视频用)
                    data: { ...(n.data ?? {}), resultPath: j.resultPath ?? (n.data as Record<string, unknown>)?.resultPath },
                  }
                : n,
            ),
          );
          // 节点产出 → 连到它的 ghost 边转正为实线(幽灵边语义:目标有产物即生效)
          setEdges((es) =>
            es.map((e) => (e.to === j.nodeId && e.cls === 'ghost' ? { ...e, cls: '' as const } : e)),
          );
          // 连续性:上游 shot 跑完 → 自动抽尾帧归档(下游镜头 first-frame 的帧源)
          // 注意:每次新产物都要重新抽(上游重跑后尾帧必须刷新),以 tailFrameFrom 记录来源产物;
          // 这里**等待**抽取完成并把最新尾帧显式传给接力下游(见下),避免读 ref 拿到旧尾帧
          const done = nodesRef.current.find((x) => x.id === j.nodeId);
          const doneData = (done?.data ?? {}) as Record<string, unknown>;
          let freshTail: string | undefined;
          if (done?.kind === 'shot' && j.resultPath && String(doneData.tailFrameFrom ?? '') !== j.resultPath) {
            const res = await window.bigbotart.extractFrame(j.resultPath, 'last');
            if (res.ok && res.path) {
              freshTail = res.path;
              setNodes((ns) =>
                ns.map((x) =>
                  x.id === j.nodeId
                    ? { ...x, data: { ...(x.data ?? {}), tailFramePath: res.path, tailFrameFrom: j.resultPath } }
                    : x,
                ),
              );
            }
          }
          // 接力:上游成功后,直接下游生成节点(无产物/已 stale)依次送入队列,整条链递归跑到尾
          cascadeKickRef.current?.(j.nodeId, list, freshTail);
        } else if (j.status === 'failed') {
          setNodes((ns) => ns.map((n) => (n.id === j.nodeId ? { ...n, badge: `失败 · ${j.error ?? '未知错误'}` } : n)));
        } else if (j.status === 'running') {
          setNodes((ns) => ns.map((n) => (n.id === j.nodeId ? { ...n, badge: j.stage ?? '生成中…' } : n)));
        }
      }
      // 任务状态变化后刷新镜头产物回填(完成后立即在节点卡显示视频)
      void refreshTakeResults();
    };
    const poll = async () => {
      try {
        const list = await window.bigbotart.queueStatus();
        if (alive) apply(list);
      } catch {
        /* 轮询失败静默 */
      }
    };
    const unsub = window.bigbotart.onQueueChanged((list) => {
      if (alive) apply(list);
    });
    void poll();
    queueTimer.current = window.setInterval(poll, 8000);
    return () => {
      alive = false;
      unsub();
      if (queueTimer.current) window.clearInterval(queueTimer.current);
    };
  }, [refreshTakeResults]);

  /* ══ 统一边分派(P0 · docs/视频节点下游连接规划.md §3)══
     === 计算移入 canvas/edge-dispatch.ts(computeEdgeDerivations 纯函数,可单测) ===
     这里只负责「触发」:nodes/edges 任一变化 → dispatch derive-from-edges action,
     nodesReducer 调 computeEdgeDerivations 计算派生态,JSON 内容比对后决定是否写回。
     语义不变:边 → 下游 data 自动填充/删除边撤销自动项(手动项保留)。 */
  useEffect(() => {
    dispatchNodes({ type: 'derive-from-edges', edges });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edges, nodes]);

  /* ══ 「+」下游节点弹层 ══ */
  const openAddPop = useCallback(
    (nodeId: string) => {
      setApFrom(nodeId);
      setApOpen(true);
      setApOpenCount((c) => c + 1);
      const n = nodesRef.current.find((x) => x.id === nodeId);
      const stage = stageRef.current;
      if (n) {
        const v = viewRef.current;
        // 基准:节点右侧 18px、顶部上移 10px(对齐「+」按钮)
        let x = n.x + (n.w ?? 236) + 18;
        let y = n.y - 10;
        // 在舞台视口内钳制,而不是写死的世界盒(1600×1000):
        // 节点可摆在世界盒外(无限画布),旧写法会把弹层钳到盒子边缘,远离节点
        if (stage) {
          const popW = 272; // .add-pop 固定宽度
          const popH = 360; // 弹层高度估算(仅用于上下钳制;超出自身可滚动)
          // 世界坐标 → 屏幕坐标(与 .world 的 translate/scale 一致)
          const sx = v.x + x * v.z;
          const sy = v.y + y * v.z;
          const minX = 8;
          const minY = 8;
          const maxX = Math.max(minX, stage.clientWidth - popW - 8);
          const maxY = Math.max(minY, stage.clientHeight - popH - 8);
          // 屏幕坐标 → 世界坐标
          x = (Math.min(maxX, Math.max(minX, sx)) - v.x) / v.z;
          y = (Math.min(maxY, Math.max(minY, sy)) - v.y) / v.z;
        }
        setApPos({ x, y });
      }
    },
    [],
  );

  const [apPos, setApPos] = useState({ x: 0, y: 0 });
  const closeAddPop = useCallback(() => setApOpen(false), []);

  /** 拖拽连线命中多端口组合(asset 图 → shot)时的角色选择:指针位置 + 候选端口 */
  const [portPick, setPortPick] = useState<{ from: string; to: string; x: number; y: number; options: PortResolution[] } | null>(null);

  /* 创建并连线(类型/画幅/档位/端口角色由 AddNodePopover 回传) */
  const createFromPop = useCallback(
    (typeId: string, aspect: string, tier: string, port?: string) => {
      if (!apFrom) return;
      const src = nodesRef.current.find((n) => n.id === apFrom);
      const t = NODE_TYPES.find((x) => x.id === typeId);
      if (!src || !t) return;
      const id = makeNodeId('new');
      const meta =
        typeId === 'shot'
          ? `h3.c · ${tier}档 · ${aspect} ${(RES[tier] ?? {})[aspect] ?? ''} · 自动连线继承绑定`
          : t.sub;
      // 按 kind 初始化 data(写入 CanvasSnapshot;生成时走 RenderQueue)
      const initData = makeInitialData(t);
      setNodes((ns) => [
        ...ns,
        {
          id,
          title: t.name,
          w: 224,
          x: src.x + (src.w ?? 236) + 90,
          y: src.y + 40,
          ghost: true,
          kind: t.kind,
          tag: t,
          extra: meta,
          data: initData,
        } as CanvasNode,
      ]);
      // 按手册 §9 边 label:brief→input-brief / asset→按角色(可显式选首帧/参考图) / wf-input→slot-<name> / 其他不标
      const edgeLabel = deriveEdgeLabel(src, t, port);
      setEdges((es) => [...es, { from: apFrom, to: id, cls: 'ghost', label: edgeLabel }]);
      setInfoMap((m) => ({ ...m, [id]: { t: t.name, img: null, meta: [['来源', meta]] } }));
      closeAddPop();
    },
    [apFrom, closeAddPop],
  );

  /* 左侧面板:双击添加 + 拖拽添加
     双击:添加到当前画布视口中心附近、不与现有节点重叠;
     拖拽:鼠标松开时,以松开的屏幕坐标(经 view 变换)为节点中心放置。 */
  /** 取节点高度(渲染节点上有实测 h,否则按经验值估) */
  const nodeH = useCallback((n: CanvasNode) => n.h ?? 200, []);

  /** 找一个不与现有节点重叠的落点
   * - 默认锚点是 (cx, cy)(视口中心)
   * - 若重叠则围绕中心按螺旋向外搜索
   */
  const findFreeSpot = useCallback(
    (cx: number, cy: number, w: number, h: number, ignoreId?: string): { x: number; y: number } => {
      const PAD = 28;
      const nodes = nodesRef.current;
      const overlap = (x: number, y: number) =>
        nodes.some((n) => {
          if (n.id === ignoreId) return false; // 排除自身(同一节点不算挡路)
          const nw = n.w ?? 224;
          const nh = nodeH(n);
          // AABB 相交(留 PAD 间隙)
          return !(
            x + w + PAD < n.x ||
            x - PAD > n.x + nw ||
            y + h + PAD < n.y ||
            y - PAD > n.y + nh
          );
        });
      let x = cx - w / 2;
      let y = cy - h / 2;
      if (!overlap(x, y)) return { x, y };
      // 螺旋扫描:右上右下左下左上依次外扩
      const step = 48;
      for (let ring = 1; ring <= 24; ring++) {
        for (let k = 0; k < ring * 8; k++) {
          const a = (k / (ring * 8)) * Math.PI * 2;
          x = cx - w / 2 + Math.round(Math.cos(a) * ring * step);
          y = cy - h / 2 + Math.round(Math.sin(a) * ring * step);
          if (!overlap(x, y)) return { x, y };
        }
      }
      // 兜底:在第一个节点右侧 24px 偏移
      const first = nodes[0];
      if (first) {
        return { x: first.x + (first.w ?? 224) + 24, y: first.y };
      }
      return { x: cx - w / 2, y: cy - h / 2 };
    },
    [nodeH],
  );

  /** 屏幕坐标 → 画布世界坐标(去掉 view 平移 + 缩放) */
  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const rect = stage.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: (clientX - rect.left - v.x) / v.z,
      y: (clientY - rect.top - v.y) / v.z,
    };
  }, []);

  /** 以视口中心为锚点双击添加 */
  const addFromPaletteDbl = useCallback(
    (typeId: string) => {
      const t = NODE_TYPES.find((x) => x.id === typeId);
      if (!t) return;
      const id = makeNodeId('pal');
      const w = t.kind === 'storyboard' ? 318 : 224;
      const h = 200;
      // 画布视口中心 → 世界坐标
      const stage = stageRef.current;
      const cw = stage ? stage.clientWidth / 2 : 480;
      const ch = stage ? stage.clientHeight / 2 : 320;
      const v = viewRef.current;
      const cx = (cw - v.x) / v.z;
      const cy = (ch - v.y) / v.z;
      const spot = findFreeSpot(cx, cy, w, h);
      setNodes((ns) => [
        ...ns,
        {
          id,
          title: t.name,
          w,
          x: spot.x,
          y: spot.y,
          ghost: true,
          kind: t.kind,
          tag: t,
          data: makeInitialData(t),
        } as CanvasNode,
      ]);
    },
    [findFreeSpot],
  );

  /** 拖拽添加(鼠标松开时落到世界坐标,不与现有节点重叠) */
  const dropFromPalette = useCallback(
    (typeId: string, clientX: number, clientY: number) => {
      const t = NODE_TYPES.find((x) => x.id === typeId);
      if (!t) return;
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      // 检查落点是否在 stage 范围内
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return;
      const w = t.kind === 'storyboard' ? 318 : 224;
      const h = 200;
      const world = screenToWorld(clientX, clientY);
      const spot = findFreeSpot(world.x, world.y, w, h);
      const id = makeNodeId('pal');
      setNodes((ns) => [
        ...ns,
        {
          id,
          title: t.name,
          w,
          x: spot.x,
          y: spot.y,
          ghost: true,
          kind: t.kind,
          tag: t,
          data: makeInitialData(t),
        } as CanvasNode,
      ]);
    },
    [findFreeSpot, screenToWorld],
  );

  /* ══ 右键菜单 ══ */
  const duplicateNode = useCallback(
    (id: string) => {
      const src = nodesRef.current.find((n) => n.id === id);
      if (!src) return;
      const nid = makeNodeId('dup');
      setNodes((ns) => [
        ...ns,
        {
          ...src,
          id: nid,
          title: `${src.title} · 副本`,
          x: src.x + 30,
          y: src.y + 30,
          ghost: false,
          stale: false,
          agentOn: false,
          badge: undefined,
          flash: false,
        } as CanvasNode,
      ]);
      const info = NODE_INFO_BASE[id];
      if (info) {
        setInfoMap((m) => {
          const meta: Array<[string, string]> = [
            ['来源', `复制自「${info.t}」`],
            ['状态', '未运行 · 修改参数后可入队'],
            ...info.meta.slice(0, 1),
          ];
          return {
            ...m,
            [nid]: { t: `${info.t} · 副本`, img: info.img, meta },
          };
        });
      }
      selectNode(nid);
      toastMsg('已复制节点 · 副本不携带连线与运行状态');
    },
    [selectNode, toastMsg],
  );

  const { ask: askPrompt, dialog: promptDialog } = usePrompt();

  /** 右键「重命名…」:改节点标题(唯一的持久化字段 label;不动 kind/data,不触发下游 stale) */
  const renameNode = useCallback(
    async (id: string) => {
      const n = nodesRef.current.find((x) => x.id === id);
      if (!n) return;
      const next = await askPrompt({ title: '重命名节点', initial: n.title });
      if (!next || next === n.title) return;
      setNodes((ns) => ns.map((x) => (x.id === id ? { ...x, title: next } : x)));
      // 同步检查器条目与当前检查器标题(若正显示该节点)
      setInfoMap((m) => {
        const cur = m[id];
        if (!cur) return m;
        return { ...m, [id]: { ...cur, t: next } };
      });
      setInspectTitle((cur) => (cur === n.title ? next : cur));
      toastMsg(`已重命名为「${next}」`);
    },
    [toastMsg, askPrompt],
  );

  /** 右键「在 Finder 中显示」:解析节点真实产物路径 → 主进程 shell 定位(文件缺失回退最近目录) */
  const revealNodeInFinder = useCallback(
    async (nodeId: string) => {
      const n = nodesRef.current.find((x) => x.id === nodeId);
      if (!n) return;
      const d = (n.data ?? {}) as Record<string, unknown>;
      let path: string | undefined;
      // 1) 节点 data 里任务完成时回填的产物路径(shot / image 通用)
      if (typeof d.resultPath === 'string' && d.resultPath) path = d.resultPath;
      // 2) asset 节点:绑定资产的本地文件
      if (!path && n.kind === 'asset') {
        const assetId = typeof d.assetId === 'string' ? d.assetId : undefined;
        if (assetId) path = assetCache.current[assetId];
      }
      // 3) shot 节点:Take 历史里最新成功产物的 resultPath(节点 data 可能缺)
      if (!path && n.kind === 'shot') path = takeResults[nodeId];
      if (!path) {
        toastMsg('该节点还没有产物文件 · 运行生成后再试');
        return;
      }
      try {
        const r = await window.bigbotart.revealInFinder({ path });
        if (r.ok) toastMsg(`已在 Finder 中显示 · ${basenameOf(r.revealed)}`);
        else toastMsg(`无法在 Finder 中显示:${r.error ?? '未知错误'}`);
      } catch (e) {
        toastMsg(`无法在 Finder 中显示:${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [takeResults, toastMsg],
  );

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) => es.filter((e) => e.from !== id && e.to !== id));
      setInfoMap((m) => {
        const next = { ...m };
        delete next[id];
        return next;
      });
      setSelected((s) => (s === id ? null : s));
      toastMsg('已删除节点 · 相关连线已一并移除');
    },
    [toastMsg],
  );

  /* ── 全局点按:关闭工具行弹层(模型/技能/分支) ── */
  useEffect(() => {
    const closePops = () => setOpenPop(null);
    document.addEventListener('click', closePops);
    return () => document.removeEventListener('click', closePops);
  }, []);

  /* ══ 全局键盘 ══ */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const typing = !!active && /^(INPUT|TEXTAREA)$/.test(active.tagName);
      if (e.key === 'Escape') {
        closeAddPop();
        setOpenPop(null);
        setCtx(null);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd' && selected) {
        e.preventDefault();
        duplicateNode(selected);
        return;
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && selected && !typing) {
        e.preventDefault();
        deleteNode(selected);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeAddPop, deleteNode, duplicateNode, selected]);

  /* ══ 真实渲染:提交节点到主进程队列(槽位互斥) ══ */
  const runNode = useCallback(
    async (nodeId: string, opts?: { freshTailFrame?: string; freshTailFrom?: string }) => {
      const n = nodesRef.current.find((x) => x.id === nodeId);
      if (!n) {
        toastMsg('请先在画布上选中一个节点');
        return;
      }
      const d = (n.data ?? {}) as Record<string, unknown>;
      // 重生成(节点已有旧产物)⇒ 下游依赖过期:传递闭包标 stale(接力跑完逐个刷新,成功即清)
      if (CASCADE_KINDS.has(n.kind ?? '') && Boolean(d.resultPath)) markDownstreamStale(nodeId);
      if (n.kind === 'timeline') {
        onNavigate('timeline');
        return;
      }
      if (n.kind === 'document') {
        toastMsg('文档节点无生成任务 · 可编辑后重新规划');
        return;
      }
      // 图片裁切节点(image-crop):不推理,ffmpeg 按目标画幅裁剪 → 直接出产物 + 记 Take
      if (n.kind === 'image-crop') {
        let srcPath: string | undefined;
        if (d.inputAssetId) srcPath = assetCache.current[String(d.inputAssetId)];
        const cropFrom = d.inputImageFrom as { nodeId?: string } | undefined;
        if (!srcPath && cropFrom?.nodeId) {
          const up = nodesRef.current.find((x) => x.id === cropFrom.nodeId);
          const upData = (up?.data ?? {}) as Record<string, unknown>;
          srcPath = up?.kind === 'asset'
            ? assetCache.current[String(upData.assetId ?? '')]
            : String(upData.resultPath ?? '') || undefined;
        }
        if (!srcPath) {
          toastMsg('图片裁切需要输入图:连一个 图片生成/编辑/增强 节点或 asset,或在检查器填 Asset ID');
          return;
        }
        const aspect = String(d.aspect ?? '9:16');
        const focus = (String(d.focus ?? 'center') as 'center' | 'top' | 'bottom' | 'left' | 'right');
        setNodes((ns) => ns.map((x) => (x.id === nodeId ? { ...x, badge: '裁切中…', ghost: false } : x)));
        const res = await window.bigbotart.cropImage({ path: srcPath, aspect, focus });
        if (!res.ok || !res.path) {
          setNodes((ns) => ns.map((x) => (x.id === nodeId ? { ...x, badge: `裁切失败 · ${res.error ?? '未知错误'}` } : x)));
          toastMsg(`裁切失败:${res.error ?? '未知错误'}`);
          return;
        }
        // Take 归档(succeeded 一次写入):产物路径 + 源图 + 参数
        let takeId: string | undefined;
        if (projectId) {
          const t = await window.bigbotart.takesCreate(projectId, {
            shotNodeId: nodeId,
            status: 'succeeded',
            resultPath: res.path,
            params: { kind: 'crop', aspect, focus, inputPath: srcPath },
          });
          takeId = t.id;
        }
        setNodes((ns) =>
          ns.map((x) =>
            x.id === nodeId
              ? {
                  ...x,
                  ghost: false,
                  stale: false,
                  badge: undefined,
                  extra: `✓ ${basenameOf(res.path as string)}`,
                  data: { ...(x.data ?? {}), resultPath: res.path, currentTakeId: takeId },
                }
              : x,
          ),
        );
        // 下游 ghost 边转正(裁切绕过渲染队列,补一次与队列完成相同的边状态刷新)
        setEdges((es) => es.map((e) => (e.to === nodeId && e.cls === 'ghost' ? { ...e, cls: '' as const } : e)));
        toastMsg(`已裁切至 ${aspect} · ${n.title}`);
        return;
      }
      const isImage = n.kind === 'image-gen' || n.kind === 'image-edit' || n.kind === 'image-upscale';
      const slot: 'video' | 'image' = isImage ? 'image' : 'video';
      const engine = String(d.engine ?? (isImage ? 'mlxgen' : 'h3c'));

      // 参考绑定 → Provider references(首/尾帧、参考图、参考音频;shot 接续走 path 直链)
      const refs = (d.refs as Array<{ assetId?: string; path?: string; role: string; auto?: boolean }> | undefined) ?? [];
      let references = refs
        .map((r) => {
          const localPath = r.path ?? assetCache.current[r.assetId ?? ''];
          if (!localPath) return null;
          return {
            asset: {
              id: r.assetId ?? `shot-frame:${localPath.split('/').pop() ?? ''}`,
              kind: 'image',
              name: r.assetId ?? (localPath.split(/[\\/]/).pop() ?? localPath),
              localPath,
              tags: [],
              createdAt: new Date().toISOString(),
            },
            role: r.role,
            localPath,
          };
        })
        .filter(Boolean) as never[];

      /* 镜头接续兜底:入边来自上游 shot 但尾帧尚未归档时(旧数据 / 应用重启后),
         现场抽一次上游产物尾帧,保证「上一段的最后一帧 = 本段首帧」永远成立。
         已显式绑定首帧(手动或连线派发)时不覆盖用户意图。 */
      let inheritedFrom: string | null = null;
      if (n.kind === 'shot') {
        const shotMode = String(d.mode ?? 'text2video');
        const wantsFrameAnchor = shotMode === 'first-frame' || shotMode === 'first-last';
        const upShotId = edgesRef.current
          .filter((e) => e.to === nodeId)
          .map((e) => e.from)
          .find((id) => nodesRef.current.find((x) => x.id === id)?.kind === 'shot');
        // 接力注入:上游刚跑完,把最新尾帧显式覆盖到自动首帧引用 —— nodesRef 在 setState 后
        // 尚未刷新,直接读 data.refs 可能拿到旧尾帧;手动绑定的首帧(非 auto)保持优先,不覆盖
        if (opts?.freshTailFrame && upShotId && opts.freshTailFrom === upShotId) {
          const manualFirst = refs.some((r) => r.role === 'first-frame' && r.auto !== true);
          if (!manualFirst) {
            references = references.filter((r) => (r as { role?: string }).role !== 'first-frame');
            references.push({
              asset: {
                id: `shot-tail:${nodeId}`,
                kind: 'image',
                name: `上游 ${opts.freshTailFrom} · 尾帧`,
                localPath: opts.freshTailFrame,
                tags: [],
                createdAt: new Date().toISOString(),
              },
              role: 'first-frame',
              localPath: opts.freshTailFrame,
            } as never);
            inheritedFrom = nodesRef.current.find((x) => x.id === upShotId)?.title ?? null;
          }
        }
        const hasFirst = references.some((r) => (r as { role?: string }).role === 'first-frame');
        if (!hasFirst && (wantsFrameAnchor || !['ref-image', 'last-frame'].includes(shotMode))) {
          const upId = upShotId;
          const up = upId ? nodesRef.current.find((x) => x.id === upId) : undefined;
          const upData = (up?.data ?? {}) as Record<string, unknown>;
          let tail = String(upData.tailFramePath ?? '');
          if (!tail && upData.resultPath) {
            const res = await window.bigbotart.extractFrame(String(upData.resultPath), 'last');
            if (res.ok && res.path) {
              tail = res.path;
              // 顺手归档到上游节点:检查器可见,后续连线派发也会复用
              setNodes((ns) =>
                ns.map((x) =>
                  x.id === upId
                    ? { ...x, data: { ...(x.data ?? {}), tailFramePath: res.path, tailFrameFrom: String(upData.resultPath) } }
                    : x,
                ),
              );
            }
          }
          if (tail) {
            references.push({
              asset: {
                id: `shot-tail:${upId}`,
                kind: 'image',
                name: `${up?.title ?? upId} · 尾帧`,
                localPath: tail,
                tags: [],
                createdAt: new Date().toISOString(),
              },
              role: 'first-frame',
              localPath: tail,
            } as never);
            inheritedFrom = up?.title ?? upId ?? null;
          }
        }
        // 接续意图明确(首帧/首尾帧模式)但拿不到首帧 ⇒ 明确报错,不退化成文生
        const firstResolved = references.some((r) => (r as { role?: string })?.role === 'first-frame');
        if (wantsFrameAnchor && !hasFirst && !firstResolved) {
          toastMsg(
            upShotId
              ? '上游镜头还没有产物,取不到首帧:先把上游镜头跑出来,再生成这一段'
              : '当前是首帧模式但首帧参考未就绪(检查「参考绑定」或上游节点是否已生成)',
          );
          return;
        }
      }

      /* P0 #3:图片编辑/超分的输入桥接(手册 362 行 TODO)
         - shot → image-edit(inputFrameSource):从上游视频产物抽帧当输入图
         - asset 输入图(inputAssetId)/ 遮罩(maskAssetId):走资产库路径 */
      let inputPath: string | undefined;
      let maskPath: string | undefined;
      if (n.kind === 'image-edit' || n.kind === 'image-upscale') {
        const frameSrc = d.inputFrameSource as { videoNodeId?: string; at?: 'first' | 'last' } | undefined;
        if (frameSrc?.videoNodeId) {
          const vn = nodesRef.current.find((x) => x.id === frameSrc.videoNodeId);
          const vp = String((vn?.data as Record<string, unknown>)?.resultPath ?? '');
          if (vp) {
            const res = await window.bigbotart.extractFrame(vp, frameSrc.at === 'last' ? 'last' : 'first');
            if (res.ok && res.path) inputPath = res.path;
          }
        }
        if (!inputPath && d.inputAssetId) inputPath = assetCache.current[String(d.inputAssetId)];
        // 输入图端口 input 的连线来源(静帧直通 / 素材)——手填 inputAssetId 优先
        const imgFrom = d.inputImageFrom as { nodeId?: string } | undefined;
        if (!inputPath && imgFrom?.nodeId) {
          const up = nodesRef.current.find((x) => x.id === imgFrom.nodeId);
          const upData = (up?.data ?? {}) as Record<string, unknown>;
          inputPath = up?.kind === 'asset'
            ? assetCache.current[String(upData.assetId ?? '')]
            : String(upData.resultPath ?? '') || undefined;
        }
        const maskAssetId = String(d.maskAssetId ?? '');
        if (maskAssetId) maskPath = assetCache.current[maskAssetId];
      }
      if (n.kind === 'image-edit' && !inputPath) {
        toastMsg('图片编辑需要输入图:连一个 shot / 图片节点 / asset,或在检查器填 Asset ID');
        return;
      }

      // 提示词端口 prompt:连线注入(自身 prompt 为空时才用,不覆盖用户输入)
      // 来源解析:document 支持标记选段(```prompt / #shot-N)+ 全文兜底;storyboard 按行组装
      let promptValue = String(d.prompt ?? '');
      const promptFrom = d.promptFrom as PromptSource | undefined;
      if (promptFrom?.nodeId && !promptValue.trim()) {
        const dn = nodesRef.current.find((x) => x.id === promptFrom.nodeId);
        if (dn?.kind === 'document') {
          const md = String((dn.data as Record<string, unknown>)?.markdown ?? '');
          if (md) promptValue = resolvePromptFromSource(md, promptFrom);
        } else if (dn?.kind === 'storyboard' && promptFrom.mode === 'row' && typeof promptFrom.row === 'number') {
          const sd = dn.data as Record<string, unknown>;
          const tb = parseGfmTable(String(sd.markdown ?? ''));
          if (tb) {
            const base = String(sd.basePrompt ?? '');
            const p = assembleH3Prompt(tb.rows[promptFrom.row - 1], tb.head, base);
            promptValue = p.text;
          }
        }
      }

      const params = isImage
        ? {
            kind: n.kind === 'image-upscale' ? 'upscale' : n.kind === 'image-edit' ? String(d.mode ?? 'instruction') : 'generate',
            model: d.model,
            prompt: promptValue,
            width: d.width,
            height: d.height,
            steps: d.steps,
            guidance: d.guidance,
            negativePrompt: d.negativePrompt,
            seeds: d.seeds,
            inputPath,
            maskPath,
            scale: d.scale,
            imageStrength: d.imageStrength,
            outpaintSides: d.outpaintSides,
          }
        : {
            kind: 'video',
            prompt: promptValue,
            mode: d.mode,
            width: d.width,
            height: d.height,
            seconds: Number(d.seconds ?? 0) > 0 ? Number(d.seconds) : undefined,
            frames: Number(d.frames ?? 124),
            steps: Number(d.steps ?? 20),
            layers: Number(d.layers ?? 50),
            reuse: Number(d.reuse ?? 1),
            tier: d.tier,
            seed: d.seed,
            // 🚀 加速 LoRA:传给主进程,提交时解析为 modelDir(-d)+ steps
            accel: d.accel,
          };

      setNodes((ns) => ns.map((x) => (x.id === nodeId ? { ...x, badge: '已入队 · 等待槽位…', ghost: false } : x)));
      try {
        // 先建 Take(queued),再提交任务带 takeId(主进程完成时自动写终态)· shot 与图片类节点(image-gen/edit/upscale)统一记录历史
        let takeId: string | undefined;
        if (projectId) {
          const t = await window.bigbotart.takesCreate(projectId, {
            shotNodeId: nodeId,
            status: 'queued',
            params,
          });
          takeId = t.id;
        }
        await window.bigbotart.submitRender({
          provider: engine as never,
          nodeId,
          slot,
          projectId: projectId ?? undefined,
          canvasId: activeCanvasId || undefined,
          takeId,
          params,
          references,
        });
        toastMsg(`已提交 ${engine} 任务 · ${n.title}${inheritedFrom ? ` · 已继承「${inheritedFrom}」尾帧作首帧` : ''}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setNodes((ns) => ns.map((x) => (x.id === nodeId ? { ...x, badge: `提交失败 · ${msg}` } : x)));
        toastMsg(`提交失败:${msg}`);
      }
    },
    [onNavigate, toastMsg, projectId, activeCanvasId, markDownstreamStale],
  );

  /* 接力触发(渲染时重绑,引用最新 runNode):上游成功后,把直接下游中「该跑」的依次送入队列。
     递归由「下游成功后再次走成功分支 → 再接力再下游」自然完成,整条链跑到尾。 */
  cascadeKickRef.current = (nodeId, jobs, freshTail) => {
    const runnable = pickCascadeTargets(nodeId, nodesRef.current, edgesRef.current, {
      isBusy: (id) =>
        cascadePendingRef.current.has(id) ||
        jobs.some((j) => j.nodeId === id && (j.status === 'queued' || j.status === 'running')),
    });
    if (runnable.length === 0) return;
    for (const id of runnable) {
      cascadePendingRef.current.add(id);
      void runNode(id, { freshTailFrame: freshTail, freshTailFrom: nodeId });
    }
    toastMsg(`已接力 ${runnable.length} 个下游节点 · 依次生成`);
  };

  /* ══ 顶部动作 ══ */
  const [rerunDone, setRerunDone] = useState(false);
  const rerunAffected = () => {
    const ids = nodesRef.current.filter((n) => n.stale || n.agentOn).map((n) => n.id);
    if (ids.length === 0) {
      toastMsg('没有 stale 节点需要重跑');
      return;
    }
    ids.forEach((id) => void runNode(id));
    setRerunDone(true);
    toastMsg(`已提交 ${ids.length} 个受影响节点`);
  };

  const [agentRunText, setAgentRunText] = useState('Agent 已规划参数 · 等视频槽位 · 可提前改参');
  const runAll = () => {
    const ids = nodesRef.current.filter((n) => n.kind === 'shot' || n.kind === 'image-gen' || n.kind === 'image-edit' || n.kind === 'image-upscale' || n.kind === 'image-crop').map((n) => n.id);
    if (ids.length === 0) {
      toastMsg('画布上没有可运行的生成节点');
      return;
    }
    ids.forEach((id) => void runNode(id));
    setAgentRunText(`已入队 ${ids.length} 个任务 · FIFO 依次执行`);
  };

  /* ══ 分镜表(storyboard)铺节点 / 撤销 / 重新同步 / Agent 生成(文档 §6.3 §7.4) ══ */
  /* 派生工具 sbMaterializedRows / sbImgCount / sbTableOf / sbDirty / SB_SIZE 见 ./canvas/storyboard.ts */

  const pad2 = (n: number) => String(n).padStart(2, '0');

  /** 从分镜表铺节点:每行一个 shot(需配图=是 的行再建 image-gen 并 first-frame 直通) */
  const materializeStoryboard = useCallback(
    (sbNode: CanvasNode, aspect: string, tier: string) => {
      const tb = sbTableOf(sbNode);
      if (!tb) {
        toastMsg('分镜表缺少表格块 · 无法铺节点');
        return;
      }
      const done = sbMaterializedRows(sbNode.id, nodesRef.current);
      const pending = tb.rows.map((_, i) => i).filter((r) => !done.includes(r));
      if (!pending.length) {
        toastMsg('当前行均已铺出 · 新增行后可追加铺');
        return;
      }
      const base = String((sbNode.data ?? {}).basePrompt ?? '');
      const anchorX = sbNode.x ?? 60;
      const anchorY = sbNode.y ?? 80;
      const IMG_X = anchorX + 300;
      const SHOT_X = anchorX + 560;
      const ROW_STEP = 186;
      const size = SB_SIZE[aspect] ?? SB_SIZE['16:9']!;
      const gfm = tableToGfm(tb.head, tb.rows);
      const created: CanvasNode[] = [];
      const newEdges: Edge[] = [];
      let imgs = 0;
      pending.forEach((r) => {
        const row = tb.rows[r] ?? [];
        const rowNo = r + 1;
        const shotId = makeNodeId('shot');
        const p = assembleH3Prompt(row, tb.head, base);
        created.push({
          id: shotId,
          title: `镜头 ${pad2(rowNo)}`,
          w: 250,
          x: SHOT_X,
          y: anchorY + r * ROW_STEP,
          ghost: true,
          kind: 'shot',
          tag: NODE_TYPES.find((t) => t.id === 'shot'),
          data: {
            engine: 'mock', // 骨架期 mock;引导向导就绪后切 h3c
            mode: 'text2video',
            prompt: p.text,
            width: size.width,
            height: size.height,
            seconds: rowSeconds(row, tb.head) || undefined,
            steps: 30,
            layers: 50,
            reuse: 1,
            tier,
            seed: 42 + r,
            refs: [],
            promptFrom: { nodeId: sbNode.id, mode: 'row', row: rowNo } as PromptSource,
          },
        } as CanvasNode);
        newEdges.push({ from: sbNode.id, to: shotId, cls: '', label: 'prompt' });
        if (rowNeedsImage(row, tb.head)) {
          imgs++;
          const imgId = makeNodeId('img');
          const z = assembleZImagePrompt(row, tb.head, base);
          created.push({
            id: imgId,
            title: `图片生成 · 分镜静帧 ${pad2(rowNo)}`,
            w: 232,
            x: IMG_X,
            y: anchorY + r * ROW_STEP,
            ghost: true,
            kind: 'image-gen',
            tag: NODE_TYPES.find((t) => t.id === 'image'),
            data: {
              engine: 'mlxgen',
              model: 'AbstractFramework/z-image-turbo-8bit',
              prompt: z.text,
              width: size.width,
              height: size.height,
              steps: 24,
              guidance: 1.0,
              seeds: [42],
              promptFrom: { nodeId: sbNode.id, mode: 'row', row: rowNo } as PromptSource,
            },
          } as CanvasNode);
          newEdges.push({ from: sbNode.id, to: imgId, cls: '', label: 'prompt' });
          newEdges.push({ from: imgId, to: shotId, cls: '', label: 'first-frame' });
        }
      });
      const ids = created.map((c) => c.id);
      setNodes((ns) => [
        ...ns.map((n) => (n.id === sbNode.id ? { ...n, data: { ...(n.data ?? {}), lastTable: gfm } } : n)),
        ...created,
      ]);
      setEdges((es) => [...es, ...newEdges]);
      if (ids[0]) setSelected(ids[0]);
      toastMsg(`已铺 ${pending.length} shot${imgs ? ` + ${imgs} image-gen` : ''} · ${pending.length + imgs} 个节点 · 未触发运行 · ⌘Z 可整体撤销`);
    },
    [makeNodeId, sbMaterializedRows, sbTableOf, setNodes, setEdges, setSelected, toastMsg],
  );

  /** 整体撤销铺节点:移除该分镜表铺出的全部节点与对应边 */
  const undoStoryboard = useCallback(
    (sbNode: CanvasNode) => {
      const ids = new Set(
        nodesRef.current
          .filter((n) => {
            const ps = (n.data ?? {}).promptFrom as PromptSource | undefined;
            return ps?.nodeId === sbNode.id && ps.mode === 'row';
          })
          .map((n) => n.id),
      );
      if (!ids.size) {
        toastMsg('还没有铺出的节点');
        return;
      }
      const n = ids.size;
      setNodes((ns) =>
        ns
          .filter((x) => !ids.has(x.id))
          .map((x) => (x.id === sbNode.id ? { ...x, data: { ...(x.data ?? {}), lastTable: '' } } : x)),
      );
      setEdges((es) => es.filter((e) => !ids.has(e.from) && !ids.has(e.to)));
      toastMsg(`已整体撤销 ${n} 个铺出节点 · 分镜表回到待铺状态`);
    },
    [setNodes, setEdges, toastMsg],
  );

  /** 重新同步:按当前表重组提示词写回已铺节点(不重建、不删除、不自动重跑) */
  const resyncStoryboard = useCallback(
    (sbNode: CanvasNode) => {
      const tb = sbTableOf(sbNode);
      if (!tb) {
        toastMsg('分镜表缺少表格块 · 无法同步');
        return;
      }
      const base = String((sbNode.data ?? {}).basePrompt ?? '');
      const gfm = tableToGfm(tb.head, tb.rows);
      const ids = new Set(
        nodesRef.current
          .filter((n) => {
            const ps = (n.data ?? {}).promptFrom as PromptSource | undefined;
            return ps?.nodeId === sbNode.id && ps.mode === 'row';
          })
          .map((n) => n.id),
      );
      if (!ids.size) {
        toastMsg('尚未铺节点 · 无需同步');
        return;
      }
      setNodes((ns) =>
        ns.map((n) => {
          if (n.id === sbNode.id) return { ...n, stale: false, data: { ...(n.data ?? {}), lastTable: gfm } };
          const ps = (n.data ?? {}).promptFrom as PromptSource | undefined;
          if (!ps || ps.nodeId !== sbNode.id || ps.mode !== 'row' || typeof ps.row !== 'number') return n;
          const idx = ps.row - 1;
          const row = tb.rows[idx] ?? [];
          const data = { ...(n.data ?? {}) };
          if (n.kind === 'shot') {
            const p = assembleH3Prompt(row, tb.head, base);
            data.prompt = p.text;
          } else if (n.kind === 'image-gen') {
            const p = assembleZImagePrompt(row, tb.head, base);
            data.prompt = p.text;
          }
          data.promptFrom = { nodeId: sbNode.id, mode: 'row', row: ps.row } as PromptSource;
          return { ...n, stale: false, data };
        }),
      );
      toastMsg(`已按当前表重组提示词写回 ${ids.size} 个节点 · 未重建未删除`);
    },
    [sbTableOf, setNodes, toastMsg],
  );

  /** Agent 生成分镜表(document 节点 → plan-storyboard → 落画布,分步模式:只出表不铺节点) */
  const onPlanStoryboard = useCallback(
    async (docNode: CanvasNode) => {
      const brief = String((docNode.data ?? {}).markdown ?? '');
      if (!brief.trim()) {
        toastMsg('文档为空 · 先写内容再生成分镜');
        return;
      }
      try {
        const st = await window.bigbotart.agentStart();
        if (!st.running) throw new Error('Agent 启动失败');
        toastMsg('Agent 生成分镜表中…');
        const plan = await window.bigbotart.agentPlanStoryboard(brief, { projectId: projectId ?? undefined });
        const sb = fromSharedNode(plan.storyboard as never);
        setNodes((ns) => [...ns, sb]);
        setEdges((es) => [...es, { from: docNode.id, to: sb.id, cls: '', label: 'prompt' }]);
        setSelected(sb.id);
        chat.pushMsg({ kind: 'sys', text: `Agent 已生成分镜表 · ${plan.report}` });
        toastMsg(`已生成分镜表 · ${plan.report}`);
      } catch (e) {
        console.error('生成分镜表失败', e);
        toastMsg(`生成分镜表失败:${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [projectId, setNodes, setEdges, setSelected, chat, toastMsg],
  );

  /* 调试面板:主进程日志总线(拉历史 + 订阅实时) */
  const [dbgOpen, setDbgOpen] = useState(false);
  const [dbgLogs, setDbgLogs] = useState<DebugLogEntry[]>([]);
  const dbgBodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!dbgOpen) return;
    let alive = true;
    void window.bigbotart.debugLogs().then((list) => {
      if (alive) setDbgLogs(list);
    }).catch(() => undefined);
    const off = window.bigbotart.onDebugLog((e) => {
      if (!alive) return;
      setDbgLogs((ls) => [...ls.slice(-499), e]);
    });
    return () => {
      alive = false;
      off();
    };
  }, [dbgOpen]);
  useEffect(() => {
    const el = dbgBodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [dbgLogs]);

  /* ══ 连线渲染 ══ */
  const edgePaths = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return edges
      .map((e) => {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (!a || !b) return null;
        const x1 = a.x + (a.w ?? 236);
        const y1 = a.y + (a.h ?? UNMEASURED_NODE_H) / 2;
        const x2 = b.x;
        const y2 = b.y + (b.h ?? UNMEASURED_NODE_H) / 2;
        const dx = Math.max(50, Math.abs(x2 - x1) / 2);
        return {
          key: `${e.from}-${e.to}`,
          cls: e.cls,
          d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
        };
      })
      .filter((p): p is { key: string; cls: EdgeClass; d: string } => p !== null);
  }, [edges, nodes]);

  useEffect(() => {
    // 尺寸变化后重绘连线(设计稿 drawEdges 的等价物)
    if (edgesSvgRef.current) edgesSvgRef.current.dataset.ready = '1';
  }, [edgePaths]);

  /* ══ 弹层里的可选类型 ══
     连接器设计 §10:只列出**有可用连接器**的类型(无连接器 ⇒ 不展示),
     每行预告「这条边落在哪个目标端口」;不再有「展开全部(含不兼容)」一档 */
  const apSrc = apFrom ? nodes.find((n) => n.id === apFrom) : undefined;
  /* 已连接下游:从边派生(连接器 D1:只见节点与端口语义,不见连接器) */
  const apOutgoing = apFrom
    ? edges
        .filter((e) => e.from === apFrom)
        .map((e) => ({ edge: e, node: nodes.find((n) => n.id === e.to) }))
        .filter((x): x is { edge: Edge; node: CanvasNode } => !!x.node)
    : [];

  const zoomPct = `${Math.round(view.z * 100)}%`;
  return (
    <div className={`pg-canvas${agentResizing ? ' agent-resizing' : ''}`}>
      <div className={`app${palCollapsed ? ' palette-collapsed' : ''}`} data-od-id="canvas-app">
        <Toolbar
          projectName={projectName}
          onNavigate={onNavigate}
          projectCanvases={projectCanvases}
          onSwitchCanvas={switchCanvas}
          onCreateCanvas={onCreateCanvas}
          onDeleteCanvas={onDeleteCanvas}
          onRenameCanvas={onRenameCanvas}
          openPop={openPop}
          setOpenPop={setOpenPop}
          rerunDone={rerunDone}
          staleCount={nodesRef.current.filter((n) => n.stale || n.agentOn).length}
          assetCount={assetCount}
          onRerunAffected={rerunAffected}
          onRunAll={runAll}
          dbgOpen={dbgOpen}
          onToggleDebug={() => setDbgOpen((v) => !v)}
        />

        <div className="work">
          {/* 左:节点面板 */}
          <Palette
            collapsed={palCollapsed}
            onCollapse={() => setPalCollapsed(true)}
            onExpand={() => setPalCollapsed(false)}
            onAddByDoubleClick={addFromPaletteDbl}
          />

          {/* 中:画布 */}
          <StageView
            view={view}
            panning={panning}
            nodes={nodes}
            edgePaths={edgePaths}
            selected={selected}
            flashId={flashId}
            connectDrag={connectDrag}
            takeResults={takeResults}
            assetMeta={assetMeta}
            connectPath={computeConnectPath}
            zoomPct={zoomPct}
            onZoomBy={(d) =>
              setView((v) => ({ ...v, z: Math.min(1.3, Math.max(0.4, v.z + d)) }))
            }
            onZoomReset={() => setView((v) => ({ ...v, x: 20, y: 10, z: 0.86 }))}
            stageRef={stageRef}
            edgesSvgRef={edgesSvgRef}
            minimapRef={minimapRef}
            worldRef={worldRef}
            onStagePointerDown={() => undefined}
            onStageClick={() => {
              setSelected(null);
              closeAddPop();
              setCtx(null);
            }}
            onWorldClick={() => {
              setSelected(null);
              closeAddPop();
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/x-bigbotart-palette')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }
            }}
            onDrop={(e) => {
              const typeId = e.dataTransfer.getData('application/x-bigbotart-palette');
              if (!typeId) return;
              e.preventDefault();
              dropFromPalette(typeId, e.clientX, e.clientY);
            }}
            onBeginPan={beginPan}
            onNodeSelect={(n) => selectNode(n.id)}
            onNodeContextMenu={(e, n) => {
              e.preventDefault();
              e.stopPropagation();
              closeAddPop();
              setOpenPop(null);
              selectNode(n.id);
              setCtx({ x: e.clientX, y: e.clientY, id: n.id });
            }}
            onNodeHeaderPointerDown={(e, n) => {
              if (e.button !== 0) return;
              dragRef.current = { id: n.id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y };
              e.stopPropagation();
            }}
            onNodeAddPointerDown={(e, n) => {
              if (e.button !== 0) return;
              // 启动拖拽预备态(未拖动仍走 click 弹层路径)
              beginConnectDrag(n.id, e.clientX, e.clientY);
              e.stopPropagation();
            }}
            onNodeAddClick={(e, n) => {
              e.stopPropagation();
              // 未拖动(<4px)才算 click,触发原弹层
              const d2 = connectDragRef.current;
              if (d2 && d2.moved) return;
              if (apOpen && apFrom === n.id) closeAddPop();
              else openAddPop(n.id);
              connectDragRef.current = null;
              setConnectDrag(null);
            }}
            registerNodeRef={(id, el) => {
              if (el) {
                nodeRefs.current.set(id, el);
                // 新 DOM 挂载即测量(observe 幂等,重复调用无副作用)
                roRef.current?.observe(el);
              } else {
                nodeRefs.current.delete(id);
              }
            }}
            popover={
              /* 「+」下游节点弹层 */
              <AddNodePopover
                open={apOpen}
                pos={apPos}
                src={apSrc}
                srcLabel={apSrc?.title ?? '—'}
                outgoing={apOutgoing}
                openCount={apOpenCount}
                onLocate={locate}
                onSelectNode={selectNode}
                onClose={closeAddPop}
                onCreate={createFromPop}
              />
            }
          />

          {/* 右:Agent 面板 + 检查器 */}
          <AgentPane
            chat={chat}
            agentW={agentW}
            tab={tab}
            onTabChange={setTab}
            onOpenSettings={() => onNavigate('settings')}
            onLocate={locate}
            toastMsg={toastMsg}
            onBackgroundClick={() => setCtx(null)}
            gripRef={gripRef}
            onGripPointerDown={(e) => {
              if (e.button !== 0) return;
              agentDragRef.current = { sx: e.clientX, w: agentW };
              gripRef.current?.classList.add('on');
              setAgentResizing(true);
              e.preventDefault();
              e.stopPropagation();
            }}
            onGripDoubleClick={() => {
              setAgentWidth(344, true);
              toastMsg('面板宽度已重置为默认');
            }}
            onGripKeyDown={(e) => {
              if (e.key === 'ArrowLeft') {
                e.preventDefault();
                setAgentWidth(agentW + 16, true);
              } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                setAgentWidth(agentW - 16, true);
              }
            }}
            onEditSkill={() => onNavigate('skills')}
            inspector={
              <InspectorPane
                tab={tab}
                selected={selected}
                selNode={selNode}
                inspectTitle={inspectTitle}
                selInfo={selInfo}
                infoMap={infoMap}
                setInfoMap={setInfoMap}
                setNodes={setNodes}
                toastMsg={toastMsg}
                projectId={projectId}
                activeCanvasId={activeCanvasId}
                jobs={jobs}
                assetsList={assetsList}
                assetCache={assetCache.current}
                runNode={(id) => void runNode(id)}
                nodes={nodes}
                onMaterializeStoryboard={(sbNode, aspect, tier) => materializeStoryboard(sbNode, aspect, tier)}
                onUndoStoryboard={(sbNode) => undoStoryboard(sbNode)}
                onResyncStoryboard={(sbNode) => resyncStoryboard(sbNode)}
                onPlanStoryboard={(docNode) => void onPlanStoryboard(docNode)}
                onOpenTimelinePage={() => onNavigate('timeline')}
                onRemoveEdge={(srcId, dstId) =>
                  setEdges((es) => es.filter((e) => !(e.from === srcId && e.to === dstId)))
                }
                onRerunSelected={() => {
                  if (!selected) return;
                  void runNode(selected);
                  toastMsg(`已提交重跑 · ${inspectTitle}`);
                }}
                onOpenAssetPicker={openAssetPicker}
              />
            }
          />
        </div>

        {/* 底部队列条(真实队列状态) */}
        <QueueBar jobs={jobs} nodes={nodes} />
      </div>

      {/* 节点右键菜单 */}
      <ContextMenu
        ctx={ctx}
        nodes={nodes}
        toastMsg={toastMsg}
        onRename={renameNode}
        onDuplicate={duplicateNode}
        onDelete={deleteNode}
        onClose={() => setCtx(null)}
        onCtxChangeAsset={openAssetPicker}
        onReveal={revealNodeInFinder}
      />

      {/* 连线角色选择(拖拽命中多端口组合:asset 图 → shot 首帧/参考图) */}
      <PortPickPop
        pos={portPick ? { x: portPick.x, y: portPick.y } : null}
        options={portPick?.options ?? []}
        onPick={(port) => {
          if (portPick) commitConnectEdge(portPick.from, portPick.to, port);
        }}
        onClose={() => setPortPick(null)}
      />

      {/* 资产选择弹层(asset 节点「更换资产…」/ 检查器选资产) */}
      <AssetPickerPop
        open={!!assetPickFor}
        pos={assetPopPos}
        assets={pickerAssets}
        categories={categories}
        projectId={projectId}
        onPick={(a) => {
          if (assetPickFor) bindAssetToNode(assetPickFor, a);
        }}
        onManage={() => onNavigate('assets')}
        onClose={() => setAssetPickFor(null)}
      />

      <div className={`toast${toast ? ' show' : ''}`} role="status" aria-live="polite">
        {toast?.msg ?? ''}
      </div>
      {/* projectId 目前仅用于数据落盘,画布演示数据固定 */}
      <span hidden data-project={projectId ?? ''}></span>

      {/* ── 调试面板(右下):主进程日志总线 ── */}
      <DebugPanel
        open={dbgOpen}
        logs={dbgLogs}
        bodyRef={dbgBodyRef}
        onClear={() => void window.bigbotart.debugClear().catch(() => undefined)}
        onClose={() => setDbgOpen(false)}
      />
      {promptDialog}
    </div>
  );
}
