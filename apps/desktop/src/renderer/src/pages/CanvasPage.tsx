import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CanvasSnapshot, ProjectCanvases, RenderJob, LlmSource, Asset, NodeKind, ShotTakeHistory, Take, DebugLogEntry, TimelineData, PromptSource } from '@bigbotart/shared';
import {
  parseGfmTable,
  docMarkers,
  inferPromptSource,
  resolvePromptFromSource,
  assembleH3Prompt,
  assembleZImagePrompt,
  rowNeedsImage,
  rowSeconds,
  sbStats,
  tableToGfm,
} from '@bigbotart/shared';
import CanvasSwitcher from '../components/CanvasSwitcher';
import type { CanvasPageProps, EdgeClass, Edge, CanvasNode, NodeTag, NodeInfo } from './canvas/types';
import {
  FINDER_PATH,
  NODE_TYPES,
  RES,
  ETA,
  resLine,
  SHOT_ASPECTS,
  SHOT_TIERS,
  SHOT_SIZES,
  SHOT_TIER_PRESETS,
  SHOT_MODE_LABEL,
  SHOT_REF_ROLES,
  NODE_INFO_BASE,
  WAVE_BARS,
} from './canvas/constants';
import {
  ICON_DOC,
  ICON_DOC_S,
  ICON_IMAGE,
  ICON_EDIT,
  ICON_UPSCALE,
  ICON_SHOT,
  ICON_DIRECTOR,
  ICON_AUDIO,
  ICON_TIMELINE,
  ICON_COMFY,
  ICON_ASSET,
  ICON_WF_INPUT,
  ICON_WF_OUTPUT,
  PALETTE_ICONS,
  TYPE_ICON,
} from './canvas/icons';
import {
  deriveEdgeLabel,
  makeInitialData,
  fromSharedNode,
  toSharedNodes,
  toLocalEdges,
  toSharedEdges,
  defaultDataFor,
  dedupeNodeIds,
  seedIdCounter,
} from './canvas/node-mapping';
import { resolvePort, hasConnector, pickShotSpec, IMAGE_KINDS } from './canvas/connectors';
import { sbMaterializedRows, sbImgCount, sbTableOf, sbDirty, SB_SIZE } from './canvas/storyboard';
import { basenameOf, outputUrlOf, thumbSrc, clamp32, VideoThumb } from './canvas/media';
import { queueItem } from './canvas/queue';
import { InspectorBody } from './canvas/inspector/InspectorBody';
import { TimelineExportPreview } from './canvas/TimelineExportPreview';
import { useAgentChat } from './agent/useAgentChat';
import { AgentChatView } from './agent/AgentChatView';
import { AgentComposer } from './agent/AgentComposer';

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
   否则进画布时会看到测试数据、且自动保存会把演示数据写进真实项目。 */
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
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
  const assetCache = useRef<Record<string, string>>({}); // assetId → localPath
  const [assetsList, setAssetsList] = useState<Asset[]>([]);

  /* ── 「+」下游节点弹层 ── */
  const [apFrom, setApFrom] = useState<string | null>(null);
  const [apOpen, setApOpen] = useState(false);
  const [apSearch, setApSearch] = useState('');
  const [apSel, setApSel] = useState<string | null>(null);
  const [apAspect, setApAspect] = useState('16:9');
  const [apTier, setApTier] = useState('默认');

  /* ── 检查器:档位 × 画幅 ── */
  const [iAspect, setIAspect] = useState('16:9');
  const [iTier, setITier] = useState('默认');

  /* Agent 对话面板:全部状态/副作用在 pages/agent/useAgentChat(本组件只持有返回值) */
  const resHint = resLine(apAspect, apTier);
  const inspHint = `${resLine(iAspect, iTier)} · 改动将标 stale，仅重跑受影响节点`;
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

  /* ── 尺寸观测:连线端口 + 「+」弹层定位 ── */
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
    nodeRefs.current.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [nodes.length, measure]);

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
  type ConnectDrag = {
    sourceId: string;
    /** pointerdown 屏幕坐标(用于判断「未拖动」则走 onClick 弹层路径) */
    sx: number;
    sy: number;
    /** 当前屏幕坐标 */
    cx: number;
    cy: number;
    /** 当前命中节点 id(null = 空白) */
    hitId: string | null;
    /** 当前命中是否可连 */
    hitOk: boolean;
    /** 标记已开始拖动(>4px 才算;否则 onPointerUp 走原 click) */
    moved: boolean;
  };
  const connectDragRef = useRef<ConnectDrag | null>(null);
  /** 触发重渲染用的镜像 state(每帧由 raf 节流更新一次) */
  const [connectDrag, setConnectDrag] = useState<ConnectDrag | null>(null);

  /** 由源节点中心 + 当前屏幕坐标 → 临时预览线端点(world 坐标系;跟 edges SVG 一致) */
  const computeConnectPath = useCallback((srcId: string, cx: number, cy: number): string | null => {
    const src = nodesRef.current.find((n) => n.id === srcId);
    if (!src) return null;
    const v = viewRef.current;
    const sx = src.x + (src.w ?? 236);
    const sy = src.y + 36; // 节点头部中点近似
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

  /** 写边(命中可连节点) */
  const commitConnectEdge = useCallback((srcId: string, dstId: string) => {
    const src = nodesRef.current.find((n) => n.id === srcId);
    const dst = nodesRef.current.find((n) => n.id === dstId);
    if (!src || !dst) return;
    const tag: NodeTag = dst.tag ?? { id: dst.kind ?? 'plain', kind: (dst.kind ?? 'document') as NodeKind, name: dst.title, sub: '' };
    const edgeLabel = deriveEdgeLabel(src, tag);
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
        commitConnectEdge(d.sourceId, finalHit.id);
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
        version: activeCanvas.version,
        createdAt: activeCanvas.createdAt,
        updatedAt: new Date().toISOString(),
      };
    },
    [activeCanvas, nodes, edges],
  );

  /** 切换画布前先 flush 当前画布的未保存改动 */
  const flushSaveNow = useCallback(() => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const snap = buildActiveSnapshot();
    if (snap) void onSaveCanvas(snap);
  }, [buildActiveSnapshot, onSaveCanvas]);

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
    const snap = buildActiveSnapshot();
    if (snap) void onSaveCanvas(snap);
  };
  useEffect(() => () => saveFlushRef.current(), []);

  /* 挂载 / 切换画布 / 项目切换 / 画布列表就绪:把 active 快照装进本地 nodes/edges
     依赖带上 projectCanvases:若进入画布时列表尚未就绪(early return),就绪后补加载,
     避免停留在空画布/演示数据上。 */
  useEffect(() => {
    if (!projectCanvases || !activeCanvas) return;
    bootRef.current = true;
    // 自愈:历史上可能存了重复 id 的节点(两个 pal1 之类)——重号会导致重合、拖拽分不开。
    // 这里自动改 id + 错开坐标 + 修连线;有改写就先落盘,保证旧数据也能恢复。
    const loaded = activeCanvas.nodes.map((n) => fromSharedNode(n as never));
    const selfHeal = dedupeNodeIds(loaded, toLocalEdges(activeCanvas.edges as never));
    setNodes(selfHeal.nodes);
    setEdges(selfHeal.edges);
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

  /** 资产本地路径缓存(挂载时拉取) */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await window.bigbotart.listAssets();
        if (alive) {
          assetCache.current = Object.fromEntries(list.map((a) => [a.id, a.localPath]));
          setAssetsList(list);
        }
      } catch {
        /* 资产可为空 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);

  /** 工具改画布后:从 store 重新拉当前画布刷新节点 */
  const refreshCanvasFromStore = useCallback(async () => {
    if (!projectId || !activeCanvasId) return;
    try {
      const pc = await window.bigbotart.loadProjectCanvases(projectId);
      const cur = pc.canvases.find((c) => c.id === activeCanvasId);
      if (!cur) return;
      const loaded = cur.nodes.map((n) => fromSharedNode(n as never));
      const selfHeal = dedupeNodeIds(loaded, toLocalEdges(cur.edges as never[]));
      setNodes(selfHeal.nodes);
      setEdges(selfHeal.edges);
      if (selfHeal.changed) {
        const repaired = buildActiveSnapshot(selfHeal.nodes, selfHeal.edges);
        if (repaired) void onSaveCanvas(repaired);
      }
      nextId.current = seedIdCounter(selfHeal.nodes);
    } catch (e) {
      console.error('刷新画布失败', e);
    }
  }, [projectId, activeCanvasId]);

  /* Agent 对话面板:状态/副作用全部收敛到 useAgentChat(pages/agent/),这里只接线 */
  const chat = useAgentChat({
    projectId,
    canvasId: activeCanvasId,
    onCanvasMutated: () => void refreshCanvasFromStore(),
    toastMsg,
  });

  /* 画布自动持久化(防抖 800ms;只在 active canvas 有内容时写) */
  useEffect(() => {
    if (bootRef.current || !projectId || !activeCanvas) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const snap = buildActiveSnapshot();
      if (snap) void onSaveCanvas(snap);
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
  useEffect(() => {
    void refreshTakeResults();
  }, [refreshTakeResults]);

  /* 渲染队列轮询(1.2s)+ 任务完成时更新节点状态 */
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const list = await window.bigbotart.queueStatus();
        if (!alive) return;
        setJobs(list);
        // 完成/失败的任务回写节点:成功取 Take 缩略图,失败置 stale
        for (const j of list) {
          const prev = prevJobState.current[j.id];
          if (prev === j.status) continue;
          prevJobState.current[j.id] = j.status;
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
            // 注意:每次新产物都要重新抽(上游重跑后尾帧必须刷新),以 tailFrameFrom 记录来源产物
            const done = nodesRef.current.find((x) => x.id === j.nodeId);
            const doneData = (done?.data ?? {}) as Record<string, unknown>;
            if (done?.kind === 'shot' && j.resultPath && String(doneData.tailFrameFrom ?? '') !== j.resultPath) {
              void window.bigbotart
                .extractFrame(j.resultPath, 'last')
                .then((res) => {
                  if (!res.ok || !res.path) return;
                  setNodes((ns) =>
                    ns.map((x) =>
                      x.id === j.nodeId
                        ? { ...x, data: { ...(x.data ?? {}), tailFramePath: res.path, tailFrameFrom: j.resultPath } }
                        : x,
                    ),
                  );
                })
                .catch(() => undefined);
            }
          } else if (j.status === 'failed') {
            setNodes((ns) => ns.map((n) => (n.id === j.nodeId ? { ...n, badge: `失败 · ${j.error ?? '未知错误'}` } : n)));
          } else if (j.status === 'running') {
            setNodes((ns) => ns.map((n) => (n.id === j.nodeId ? { ...n, badge: j.stage ?? '生成中…' } : n)));
          }
        }
        // 任务状态变化后刷新镜头产物回填(完成后立即在节点卡显示视频)
        void refreshTakeResults();
      } catch {
        /* 轮询失败静默 */
      }
    };
    void poll();
    queueTimer.current = window.setInterval(poll, 1200);
    return () => {
      alive = false;
      if (queueTimer.current) window.clearInterval(queueTimer.current);
    };
  }, [refreshTakeResults]);

  /* ══ 统一边分派(P0 · docs/视频节点下游连接规划.md §3)══
     边 → 下游节点 data 自动填充,删除边时同步移除对应自动项(手动项保留):
     - asset → shot:refs[role=ref-audio/ref-image](沿用需求 7,auto 标记)
     - shot → shot:refs[role=first-frame] 指向上游尾帧 PNG(待上游 tailFramePath 就绪后注入)
     - shot / asset(video|audio) → timeline:shotNodeIds 入线(按边序去重)
     - 操作节点 → workflow-output:outputs[].sourceNodeIds(按 kind 匹配)
     - asset / document → workflow-input(label=slot-<name>):slots[name].value
     - shot → image-edit:inputFrameSource(取帧再编辑的帧源) */
  useEffect(() => {
    const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
    type RefEntry = { assetId?: string; path?: string; role: string; auto?: boolean };
    const refPatch = new Map<string, RefEntry[]>();
    const timelinePatch = new Map<string, string[]>();
    const outputPatch = new Map<string, Record<string, string[]>>();
    const slotPatch = new Map<string, Array<{ name: string; value: unknown }>>();
    const framePatch = new Map<string, { videoNodeId: string; at: 'first' | 'last' } | null>();
    const imageFromPatch = new Map<string, { nodeId: string } | null>();
    const promptFromPatch = new Map<string, { nodeId: string } | null>();
    /** 镜头画面规格继承(shot → shot):目标节点 → 要写入的规格键值 */
    const specPatch = new Map<string, Record<string, unknown>>();
    const specFromPatch = new Map<string, { nodeId: string } | null>();
    /** 接续/直通自动切换 mode(默认文生 → 首帧) */
    const modePatch = new Map<string, string>();
    /** 有「首帧端口」入边的 shot 节点(用于删边后把自动切换的 mode 收回) */
    const frameEdgeNodes = new Set<string>();

    for (const e of edges) {
      const src = byId.get(e.from);
      const dst = byId.get(e.to);
      if (!src || !dst) continue;
      const d = (dst.data ?? {}) as Record<string, unknown>;
      const s = (src.data ?? {}) as Record<string, unknown>;
      switch (dst.kind) {
        case 'shot': {
          const arr = refPatch.get(e.to) ?? [];
          const modeRaw = String(d.mode ?? 'text2video');
          const modeOverridden = d.modeOverride === true;
          const fromShot = src.kind === 'shot';
          const fromImage = IMAGE_KINDS.includes(src.kind ?? '');
          const hasFrameEdge = fromShot || fromImage || e.label === 'first-frame';
          // 只要存在「首帧端口」入边就登记(与是否需要切换 mode 无关),供删边后收回判断
          if (hasFrameEdge) {
            frameEdgeNodes.add(e.to);
            // 下游没显式选过模式(仍是默认文生)时,自动切「首帧」
            if (modeRaw === 'text2video' && !modeOverridden) modePatch.set(e.to, 'first-frame');
          }
          const effMode = modePatch.get(e.to) ?? modeRaw;
          const frameOk = effMode === 'first-frame' || effMode === 'first-last';
          /* 自动注入的让位规则(仅单值角色):
             - 用户已手动绑定同名角色 ⇒ 手动的优先,不再自动注入
             - 用户在该角色上点过 ×(refsSuppressed)⇒ 尊重停用 */
          const curRefs = Array.isArray(d.refs) ? (d.refs as Array<{ role?: string; auto?: boolean }>) : [];
          const suppressedRoles = Array.isArray(d.refsSuppressed) ? (d.refsSuppressed as string[]) : [];
          const SINGLE_ROLES = ['first-frame', 'last-frame', 'ref-audio', 'ref-video'];
          const autoBlocked = (role: string) =>
            SINGLE_ROLES.includes(role) &&
            (suppressedRoles.includes(role) || curRefs.some((r) => !r.auto && r.role === role));
          if (src.kind === 'asset') {
            const role = e.label === 'ref-audio' ? 'ref-audio' : e.label === 'ref-image' ? 'ref-image' : undefined;
            const assetId = String(s.assetId ?? '');
            if (role && assetId && !autoBlocked(role)) arr.push({ assetId, role, auto: true });
          } else if (fromShot) {
            // 镜头接续:上游尾帧 → 下游首帧
            if (frameOk && !autoBlocked('first-frame')) {
              const tail = String(s.tailFramePath ?? '');
              if (tail) arr.push({ path: tail, role: 'first-frame', auto: true });
            }
            // 画面规格继承:比例 + 档位(三件套)整组取自上游;下游手动改过则不再覆盖
            if (d.specOverride !== true) {
              const spec = pickShotSpec(s);
              if (Object.keys(spec).length) specPatch.set(e.to, spec);
            }
            specFromPatch.set(e.to, { nodeId: e.from });
          } else if (fromImage) {
            // 静帧直通:图片产物直接当首帧(端口 first-frame)
            if (frameOk && !autoBlocked('first-frame')) {
              const img = String(s.resultPath ?? '');
              if (img) arr.push({ path: img, role: 'first-frame', auto: true });
            }
          }
          if (arr.length) refPatch.set(e.to, arr);
          // 提示词端口 prompt:document → 下游 prompt(仅自身 prompt 为空时生效,运行期解析)
          if (src.kind === 'document' && String(s.markdown ?? '').trim()) {
            const cur = d.promptFrom as PromptSource | undefined;
            const next: PromptSource = { nodeId: e.from, ...inferPromptSource(String(s.markdown ?? '')) };
            if (!cur || cur.nodeId !== e.from || cur.mode !== next.mode || (cur.blockId ?? '') !== (next.blockId ?? '')) {
              promptFromPatch.set(e.to, next);
            }
          }
          break;
        }
        case 'timeline': {
          // 入线端口 clip / audio-track:视频、静帧、编排、音轨、音视频素材
          const asMedia = src.kind === 'asset' && ['video', 'audio'].includes(String(s.mediaType ?? ''));
          const isClip = src.kind === 'shot' || src.kind === 'director' || src.kind === 'audio-ref' || IMAGE_KINDS.includes(src.kind ?? '');
          if (isClip || asMedia) {
            const arr = timelinePatch.get(e.to) ?? [];
            if (!arr.includes(e.from)) arr.push(e.from);
            timelinePatch.set(e.to, arr);
          }
          break;
        }
        case 'workflow-output': {
          const kindOf: Record<string, string> = {
            shot: 'video',
            director: 'video',
            'image-gen': 'image',
            'image-edit': 'image',
            'image-upscale': 'image',
            'audio-ref': 'audio',
            asset: String(s.mediaType ?? ''),
          };
          const kind = kindOf[src.kind ?? ''];
          if (!kind || kind === 'document') break;
          const outputs = Array.isArray(d.outputs) ? (d.outputs as Array<{ name: string; kind: string }>) : [];
          const mp = outputPatch.get(e.to) ?? {};
          for (const o of outputs) {
            if (o.kind !== kind) continue;
            const arr = mp[o.name] ?? [];
            if (!arr.includes(e.from)) arr.push(e.from);
            mp[o.name] = arr;
          }
          outputPatch.set(e.to, mp);
          break;
        }
        case 'workflow-input': {
          if (!e.label?.startsWith('slot-')) break;
          const name = e.label.slice(5);
          const slots = Array.isArray(d.slots) ? (d.slots as Array<{ name: string; accept: string[] }>) : [];
          // 精确槽位名优先;占位 label(slot-<名称>,目标节点创建时尚不知槽位名)按来源类型匹配 accept
          const srcAccept =
            src.kind === 'document'
              ? 'text'
              : src.kind === 'asset'
                ? (String(s.mediaType ?? 'image') === 'image' ? 'image' : String(s.mediaType ?? 'image') === 'video' ? 'video' : String(s.mediaType ?? 'image') === 'audio' ? 'audio' : 'document')
                : undefined;
          const placeholder = name === '<名称>' || name === '默认';
          const slot = slots.find((x) => x.name === name)
            ?? (placeholder && srcAccept ? slots.find((x) => x.accept.includes(srcAccept)) : undefined)
            ?? (['image', 'video', 'audio', 'text', 'document'].includes(name) ? slots.find((x) => x.accept.includes(name)) : undefined);
          if (!slot) break;
          let value: unknown;
          if (src.kind === 'asset') {
            const assetId = String(s.assetId ?? '');
            if (!assetId) break;
            value = { kind: 'asset', assetId };
          } else if (src.kind === 'document') {
            const md = String(s.markdown ?? '');
            if (!md) break;
            value = { kind: 'inline-text', text: md };
          } else break;
          const arr = slotPatch.get(e.to) ?? [];
          arr.push({ name: slot.name, value });
          slotPatch.set(e.to, arr);
          break;
        }
        case 'image-edit': {
          if (src.kind === 'shot') {
            const cur = d.inputFrameSource as { videoNodeId?: string; at?: string } | undefined;
            const next = { videoNodeId: e.from, at: 'first' as const };
            if (!cur || cur.videoNodeId !== next.videoNodeId || cur.at !== next.at) framePatch.set(e.to, next);
          } else if (IMAGE_KINDS.includes(src.kind ?? '') || src.kind === 'asset') {
            // 输入图端口 input:静帧产物直通 / 素材引用;运行期解析(不覆盖手填 inputAssetId)
            const cur = d.inputImageFrom as { nodeId?: string } | undefined;
            if (!cur || cur.nodeId !== e.from) imageFromPatch.set(e.to, { nodeId: e.from });
          }
          if (src.kind === 'document' && String(s.markdown ?? '').trim()) {
            const cur = d.promptFrom as PromptSource | undefined;
            const next: PromptSource = { nodeId: e.from, ...inferPromptSource(String(s.markdown ?? '')) };
            if (!cur || cur.nodeId !== e.from || cur.mode !== next.mode || (cur.blockId ?? '') !== (next.blockId ?? '')) {
              promptFromPatch.set(e.to, next);
            }
          }
          break;
        }
        case 'image-gen':
        case 'director': {
          // 提示词端口 prompt:document → 下游 prompt
          if (src.kind === 'document' && String(s.markdown ?? '').trim()) {
            const cur = d.promptFrom as PromptSource | undefined;
            const next: PromptSource = { nodeId: e.from, ...inferPromptSource(String(s.markdown ?? '')) };
            if (!cur || cur.nodeId !== e.from || cur.mode !== next.mode || (cur.blockId ?? '') !== (next.blockId ?? '')) {
              promptFromPatch.set(e.to, next);
            }
          }
          break;
        }
        case 'image-upscale': {
          // 输入图端口 input(超分源):静帧产物直通 / 素材引用
          if (IMAGE_KINDS.includes(src.kind ?? '') || src.kind === 'asset') {
            const cur = d.inputImageFrom as { nodeId?: string } | undefined;
            if (!cur || cur.nodeId !== e.from) imageFromPatch.set(e.to, { nodeId: e.from });
          }
          break;
        }
      }
    }

    /* 写回:先把所有派生态**无条件**写进克隆的 data,最后用 JSON 内容比对决定是否 setState。
       这样做的目的:任何"引用不同但内容相同"的误判(曾导致 Maximum update depth 无限重渲染)
       都不会触发 setState —— 只有内容真的变了才写入。 */
    let dirty = false;
    const nextNodes = nodesRef.current.map((n) => {
      const data = { ...(n.data ?? {}) };
      const refKey = (r: RefEntry) => (r.assetId ? `${r.assetId}:${r.role}` : `path:${r.path}:${r.role}`);

      if (n.kind === 'shot') {
        const incoming = refPatch.get(n.id) ?? [];
        const cur = Array.isArray(data.refs) ? ((data.refs as unknown[]) as RefEntry[]) : [];
        const manual = cur.filter((r) => !r.auto);
        const merged = [...manual];
        for (const r of incoming) {
          const idx = merged.findIndex((m) => refKey(m) === refKey(r));
          if (idx >= 0) merged[idx] = r;
          else merged.push(r);
        }
        data.refs = merged;
        // 画面规格来源标记(检查器显示「继承自上游镜头 X」)
        const sf = specFromPatch.get(n.id) ?? null;
        if (sf) data.specFrom = sf;
        else delete data.specFrom;
        // 比例 + 档位继承(用户手动改过 ⇒ specOverride=true,不再覆盖)
        const spec = specPatch.get(n.id);
        if (spec && data.specOverride !== true) Object.assign(data, spec);
        // 模式:接续/直通时自动切「首帧」;手动选过模式(modeOverride)则不动
        if (data.modeOverride !== true) {
          const wantMode = modePatch.get(n.id);
          if (wantMode) data.mode = wantMode;
          else if (!frameEdgeNodes.has(n.id) && data.mode === 'first-frame') data.mode = 'text2video';
        }
      }
      if (n.kind === 'timeline') {
        // manualOrder=true(用户手动排序/删除过):尊重 data 里的 shotNodeIds,不被入边自动重排覆盖;
        // 否则仍由入边派生态全权维护(删边即撤销入线)。
        // 手动模式下仍把新入边追加到末尾,让后续连线依然能入线。
        const manual = (n.data as { manualOrder?: boolean })?.manualOrder === true;
        if (manual) {
          const cur = Array.isArray((n.data as { shotNodeIds?: unknown }).shotNodeIds)
            ? ((n.data as { shotNodeIds: string[] }).shotNodeIds ?? [])
            : [];
          const incoming = timelinePatch.get(n.id) ?? [];
          const merged = [...cur];
          for (const id of incoming) {
            if (!merged.includes(id)) merged.push(id);
          }
          data.shotNodeIds = merged;
        } else {
          data.shotNodeIds = timelinePatch.get(n.id) ?? [];
        }
      }
      if (n.kind === 'workflow-output') {
        const incomingMap = outputPatch.get(n.id);
        const curOut = Array.isArray(data.outputs) ? (data.outputs as Array<{ name: string; kind: string; sourceNodeIds: string[] }>) : [];
        // 边是 sourceNodeIds 的唯一来源:无入边即空(镜像派生态,删除边即撤销)
        data.outputs = curOut.map((o) => ({ ...o, sourceNodeIds: incomingMap?.[o.name] ?? [] }));
      }
      if (n.kind === 'workflow-input') {
        const byName = new Map((slotPatch.get(n.id) ?? []).map((x) => [x.name, x.value]));
        const curSlots = Array.isArray(data.slots) ? (data.slots as Array<{ name: string; accept: string[]; required?: boolean; value?: unknown }>) : [];
        // value 完全由 slot-<name> 边决定:边删除 → 清回未填充
        data.slots = curSlots.map((x2) => ({ ...x2, value: byName.has(x2.name) ? byName.get(x2.name) : undefined }));
      }
      if (n.kind === 'image-edit') {
        const target = framePatch.get(n.id) ?? null;
        if (target) data.inputFrameSource = target;
        else delete data.inputFrameSource;
      }
      // 输入图端口 input(静帧直通 / 素材):与边同步,删除边即撤销
      if (n.kind === 'image-edit' || n.kind === 'image-upscale') {
        const target = imageFromPatch.get(n.id) ?? null;
        if (target) data.inputImageFrom = target;
        else delete data.inputImageFrom;
      }
      // 提示词端口 prompt:与边同步(运行期「自身 prompt 为空才用文档全文」)
      if (['image-gen', 'image-edit', 'shot', 'director'].includes(n.kind ?? '')) {
        const target = promptFromPatch.get(n.id) ?? null;
        if (target) data.promptFrom = target;
        else delete data.promptFrom;
      }
      if (JSON.stringify(data) === JSON.stringify(n.data ?? {})) return n;
      dirty = true;
      return { ...n, data };
    });
    if (dirty) setNodes(nextNodes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edges, nodes]);

  /* ══ 「+」下游节点弹层 ══ */
  const openAddPop = useCallback(
    (nodeId: string) => {
      setApFrom(nodeId);
      setApSel(null);
      setApSearch('');
      setApOpen(true);
      const n = nodesRef.current.find((x) => x.id === nodeId);
      if (n) {
        const x = Math.min(n.x + (n.w ?? 236) + 18, 1600 - 290);
        const y = Math.max(10, Math.min(n.y - 10, 1000 - 360));
        setApPos({ x, y });
      }
    },
    [],
  );

  const [apPos, setApPos] = useState({ x: 0, y: 0 });
  const closeAddPop = useCallback(() => setApOpen(false), []);

  /* 创建并连线 */
  const createFromPop = useCallback(() => {
    if (!apSel || !apFrom) return;
    const src = nodesRef.current.find((n) => n.id === apFrom);
    const t = NODE_TYPES.find((x) => x.id === apSel);
    if (!src || !t) return;
    const id = makeNodeId('new');
    const meta =
      apSel === 'shot'
        ? `h3.c · ${apTier}档 · ${apAspect} ${(RES[apTier] ?? {})[apAspect] ?? ''} · 自动连线继承绑定`
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
    // 按手册 §9 边 label:brief→input-brief / asset→按角色 / wf-input→slot-<name> / 其他不标
    const edgeLabel = deriveEdgeLabel(src, t);
    setEdges((es) => [...es, { from: apFrom, to: id, cls: 'ghost', label: edgeLabel }]);
    setInfoMap((m) => ({ ...m, [id]: { t: t.name, img: null, meta: [['来源', meta]] } }));
    closeAddPop();
  }, [apAspect, apFrom, apSel, apTier, closeAddPop]);

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
    async (nodeId: string) => {
      const n = nodesRef.current.find((x) => x.id === nodeId);
      if (!n) {
        toastMsg('请先在画布上选中一个节点');
        return;
      }
      const d = (n.data ?? {}) as Record<string, unknown>;
      if (n.kind === 'timeline') {
        onNavigate('timeline');
        return;
      }
      if (n.kind === 'document') {
        toastMsg('文档节点无生成任务 · 可编辑后重新规划');
        return;
      }
      const isImage = n.kind === 'image-gen' || n.kind === 'image-edit' || n.kind === 'image-upscale';
      const slot: 'video' | 'image' = isImage ? 'image' : 'video';
      const engine = String(d.engine ?? (isImage ? 'mlxgen' : 'h3c'));

      // 参考绑定 → Provider references(首/尾帧、参考图、参考音频;shot 接续走 path 直链)
      const refs = (d.refs as Array<{ assetId?: string; path?: string; role: string }> | undefined) ?? [];
      const references = refs
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
        const hasFirst = refs.some((r) => r.role === 'first-frame');
        const shotMode = String(d.mode ?? 'text2video');
        const wantsFrameAnchor = shotMode === 'first-frame' || shotMode === 'first-last';
        const upShotId = edgesRef.current
          .filter((e) => e.to === nodeId)
          .map((e) => e.from)
          .find((id) => nodesRef.current.find((x) => x.id === id)?.kind === 'shot');
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
            seeds: d.seeds,
            inputPath,
            maskPath,
            scale: d.scale,
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
          };

      setNodes((ns) => ns.map((x) => (x.id === nodeId ? { ...x, badge: '已入队 · 等待槽位…', ghost: false } : x)));
      try {
        // 先建 Take(queued),再提交任务带 takeId(主进程完成时自动写终态)
        let takeId: string | undefined;
        if (projectId && !isImage) {
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
    [onNavigate, toastMsg, projectId, activeCanvasId],
  );

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
    const ids = nodesRef.current.filter((n) => n.kind === 'shot' || n.kind === 'image-gen' || n.kind === 'image-edit' || n.kind === 'image-upscale').map((n) => n.id);
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
        const y1 = a.y + (a.h ?? 0) / 2;
        const x2 = b.x;
        const y2 = b.y + (b.h ?? 0) / 2;
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
  const q = apSearch.trim().toLowerCase();
  const visibleTypes = apSrc
    ? NODE_TYPES.filter((t) => hasConnector(apSrc, t.id))
        .filter((t) => !q || t.name.toLowerCase().includes(q))
    : [];
  const apFromLabel = apSrc?.title ?? '—';
  const apSelPort = apSrc && apSel ? resolvePort(apSrc, apSel) : null;
  const apTip = apSel
    ? `自动连线：${apFromLabel} → ${NODE_TYPES.find((t) => t.id === apSel)?.name ?? ''}${apSelPort ? ` · 落 ${apSelPort.port} 端口` : ''}`
    : '选中后自动连线并继承绑定';

  /* 已连接下游:从边派生(连接器 D1:只见节点与端口语义,不见连接器) */
  const apOutgoing = apFrom
    ? edges
        .filter((e) => e.from === apFrom)
        .map((e) => ({ edge: e, node: nodes.find((n) => n.id === e.to) }))
        .filter((x): x is { edge: Edge; node: CanvasNode } => !!x.node)
    : [];

  const zoomPct = `${Math.round(view.z * 100)}%`;

  /* 节点内部渲染(按 kind)——**一律数据驱动**:
     卡片内容 = 节点 data 的投影,与检查器同源(不再有"演示节点写死文案"这条旁路,
     否则会出现「卡片写着首尾帧/默认档,检查器显示文生」这类脱节)。 */
  const renderBody = (n: CanvasNode) => {
    const d = (n.data ?? {}) as Record<string, unknown>;
    /** 产物路径:节点 data 优先,回退 Take 回填 */
    const productOf = (node: CanvasNode) =>
      String((node.data as Record<string, unknown> | undefined)?.resultPath ?? takeResults[node.id] ?? '');
    switch (n.kind) {
      case 'document': {
        const md = String(d.markdown ?? '');
        const tb = parseGfmTable(md);
        const mk = docMarkers(md);
        return (
          <div className="nb md-preview">
            {tb ? (
              <>
                <div style={{ overflowX: 'auto' }}>
                  <table className="tbl-mini">
                    <thead>
                      <tr>
                        {tb.head.slice(0, 3).map((h) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tb.rows.slice(0, 2).map((r, i) => (
                        <tr key={i}>
                          {tb.head.slice(0, 3).map((_, c) => (
                            <td key={c}>{r[c] ?? ''}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="rowsum">
                  <span className="badge">{tb.rows.length} 行 · {tb.head.length} 列</span>
                  {mk.prompt ? (
                    <span className="mkblock">```prompt 块 → 已命中</span>
                  ) : mk.shot ? (
                    <span className="mkblock">标题块 → 已命中</span>
                  ) : (
                    <span className="mkblock" style={{ borderStyle: 'dashed', background: 'transparent' }}>无标记 · 全文兜底</span>
                  )}
                </div>
              </>
            ) : md ? (
              <>
                <b style={{ display: 'block', marginBottom: 4 }}>{md.split('\n')[0]?.replace(/^#+\s*/, '') || '文档'}</b>
                <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>{md.slice(0, 120)}{md.length > 120 ? '…' : ''}</p>
              </>
            ) : (
              <div style={{ color: 'var(--meta)', fontSize: 11, padding: '8px 0' }}>空白文档 · 检查器里填写 Markdown</div>
            )}
          </div>
        );
      }
      case 'storyboard': {
        const md = String(d.markdown ?? '');
        const tb = parseGfmTable(md);
        const rows = tb?.rows ?? [];
        const head = tb?.head ?? [];
        const st = sbStats(head, rows);
        const matRows = sbMaterializedRows(n.id, nodes);
        const dirty = sbDirty(n, nodes);
        const base = String(d.basePrompt ?? '');
        const more = rows.length > 3 ? `+${rows.length - 3} 行未显示` : '';
        const stateLine = matRows.length
          ? `已铺 ${matRows.length} shot${sbImgCount(n.id, nodes) ? ` + ${sbImgCount(n.id, nodes)} image-gen` : ''} · 未触发运行${dirty ? ' · 表格已改' : ''}`
          : `待铺节点 · ${st.n} shot + ${st.imgs} image-gen`;
        return (
          <div className="nb">
            {tb ? (
              <>
                <div style={{ overflowX: 'auto' }}>
                  <table className="tbl-mini">
                    <thead>
                      <tr>
                        <th style={{ width: 26 }}>镜</th>
                        <th>画面描述</th>
                        <th style={{ width: 36 }}>时长</th>
                        <th style={{ width: 40 }}>配图</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, 3).map((r, i) => (
                        <tr key={i}>
                          <td className="n">{r[0] ?? i + 1}</td>
                          <td>{r[1] ?? ''}</td>
                          <td>{r[5] ?? ''}s</td>
                          <td>{rowNeedsImage(r, head) ? '是' : '否'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="rowsum">
                  <span className="badge">{st.n} 行</span>
                  <span className="badge">需配图 {st.imgs}</span>
                  <span className="more">合计 {st.secs}s</span>
                  <span className="more">{more}</span>
                </div>
                {base ? <div className="nparams">basePrompt · {base}</div> : null}
              </>
            ) : (
              <div style={{ color: 'var(--meta)', fontSize: 11, padding: '8px 0' }}>分镜表 · 检查器里编辑表格</div>
            )}
            <div className="nmeta mono">{stateLine}</div>
          </div>
        );
      }
      case 'asset': {
        const mediaType = String(d.mediaType ?? 'image');
        const assetId = String(d.assetId ?? '');
        const emoji = mediaType === 'image' ? '🖼' : mediaType === 'video' ? '🎬' : mediaType === 'audio' ? '🎵' : '📄';
        return (
          <div className="nb">
            <div
              className="nthumb"
              style={{
                aspectRatio: '16/9',
                display: 'grid',
                placeItems: 'center',
                background: 'var(--surface-warm)',
                border: assetId ? 'none' : '1.5px dashed var(--border)',
                fontSize: 22,
              }}
            >
              {assetId ? (
                <span style={{ opacity: 0.85 }}>{emoji}</span>
              ) : (
                <span style={{ opacity: 0.5 }}>{emoji}</span>
              )}
            </div>
            <div className="nmeta mono">{assetId ? `资产 ${assetId.slice(0, 14)}… · ${mediaType}` : '未绑定资产 · 检查器里选择'}</div>
          </div>
        );
      }
      case 'image-gen': {
        const prompt = String(d.prompt ?? '');
        const model = String(d.model ?? 'mlxgen');
        const w = Number(d.width ?? 1024);
        const h = Number(d.height ?? 1024);
        const seeds = (d.seeds as number[]) ?? [];
        const outImg = productOf(n);
        return (
          <div className="nb">
            {outImg ? (
              <div className="nthumb"><img src={outputUrlOf(outImg)} alt="图片产物" /></div>
            ) : (
            <div className="nthumb" style={{ aspectRatio: '1/1', display: 'grid', placeItems: 'center', background: 'var(--surface-warm)', border: '1.5px dashed var(--border)', color: 'var(--meta)', fontSize: 11 }}>
              待生成 · {w}×{h}
            </div>
            )}
            <div className="nmeta mono">
              {prompt ? `${prompt.slice(0, 30)}${prompt.length > 30 ? '…' : ''}` : '未填提示词'} · {model.split('/').pop()}
            </div>
            {seeds.length > 1 ? <div className="nmeta mono" style={{ marginTop: 2 }}>seed 批量 ×{seeds.length}</div> : null}
          </div>
        );
      }
      case 'image-edit': {
        const mode = String(d.mode ?? 'instruction');
        const modeLabel = ({ instruction: '指令编辑', img2img: 'I2I', inpaint: 'Inpaint', outpaint: 'Outpaint' } as Record<string, string>)[mode] ?? mode;
        const prompt = String(d.prompt ?? '');
        const outImg = productOf(n);
        // 输入图状态与检查器同源:手填资产 > 连线静帧 > 连线取帧
        const inputState = String(d.inputAssetId ?? '')
          ? `输入图 · 资产 ${String(d.inputAssetId).slice(0, 8)}`
          : (d.inputImageFrom as { nodeId?: string } | undefined)?.nodeId
            ? `输入图 · 节点 ${String((d.inputImageFrom as { nodeId?: string }).nodeId).slice(0, 8)}`
            : (d.inputFrameSource as { videoNodeId?: string } | undefined)?.videoNodeId
              ? `输入帧 · ${(d.inputFrameSource as { at?: string }).at === 'last' ? '尾帧' : '首帧'}`
              : '输入图待绑定';
        return (
          <div className="nb">
            {outImg ? (
              <div className="nthumb"><img src={outputUrlOf(outImg)} alt="编辑产物" /></div>
            ) : (
              <div className="nthumb" style={{ aspectRatio: '16/9', display: 'grid', placeItems: 'center', background: 'var(--surface-warm)', border: '1.5px dashed var(--border)', color: 'var(--meta)', fontSize: 11 }}>
                {modeLabel} · {inputState}
              </div>
            )}
            <div className="nmeta mono">{prompt ? `${prompt.slice(0, 30)}…` : '未填指令'}</div>
          </div>
        );
      }
      case 'image-upscale': {
        const scale = Number(d.scale ?? 2);
        const outImg = productOf(n);
        const inputState = String(d.inputAssetId ?? '')
          ? `输入 · 资产 ${String(d.inputAssetId).slice(0, 8)}`
          : (d.inputImageFrom as { nodeId?: string } | undefined)?.nodeId
            ? `输入 · 节点 ${String((d.inputImageFrom as { nodeId?: string }).nodeId).slice(0, 8)}`
            : '输入待绑定';
        return (
          <div className="nb">
            {outImg ? (
              <div className="nthumb"><img src={outputUrlOf(outImg)} alt="超分产物" /></div>
            ) : (
              <div className="nthumb" style={{ aspectRatio: '16/9', display: 'grid', placeItems: 'center', background: 'var(--surface-warm)', border: '1.5px dashed var(--border)', color: 'var(--meta)', fontSize: 11 }}>
                ×{scale} 超分 · {inputState}
              </div>
            )}
            <div className="nmeta mono">SeedVR2 · ×{scale}</div>
          </div>
        );
      }
      case 'shot': {
        const mode = String(d.mode ?? 'text2video');
        const tier = (String(d.tier ?? 'default')) as (typeof SHOT_TIERS)[number];
        const aspect = (String(d.aspect ?? '16:9')) as (typeof SHOT_ASPECTS)[number];
        const prompt = String(d.prompt ?? '');
        const modeLabel = SHOT_MODE_LABEL[mode] ?? mode;
        // 尺寸以**节点 data 为权威**(与检查器同一规则);缺失时才按 aspect × tier 推导
        const derivedSize = aspect === 'custom'
          ? { width: clamp32(Number(d.customWidth ?? 544)), height: clamp32(Number(d.customHeight ?? 544)) }
          : SHOT_SIZES[aspect as '16:9' | '9:16' | '1:1'][tier] ?? SHOT_SIZES['16:9'].default;
        const size = { width: Number(d.width ?? derivedSize.width), height: Number(d.height ?? derivedSize.height) };
        const tierLabel = (SHOT_TIER_PRESETS[tier] ?? SHOT_TIER_PRESETS.default).label;
        const resultPath = productOf(n);
        const refs = (d.refs as Array<{ role?: string; auto?: boolean }> | undefined) ?? [];
        const inherited = !!(d.specFrom as { nodeId?: string } | undefined)?.nodeId && d.specOverride !== true;
        return (
          <div className="nb">
            {resultPath ? (
              <VideoThumb src={outputUrlOf(resultPath)} badge={`✓ ${basenameOf(resultPath)}`} />
            ) : (
              <div className="nthumb" style={{ aspectRatio: '16/9', display: 'grid', placeItems: 'center', background: 'var(--surface-warm)', border: '1.5px dashed var(--border)', color: 'var(--meta)', fontSize: 11 }}>
                {modeLabel} · 待生成
              </div>
            )}
            <div className="nmeta mono">
              h3.c · {modeLabel} · {tierLabel} · {size.width}×{size.height}
              {refs.length ? ` · ${refs.length} 参考` : ''}
              {inherited ? ' · 继承上游规格' : ''}
            </div>
            <div className="nmeta mono" style={{ marginTop: 2 }}>
              {prompt ? `${prompt.slice(0, 20)}…` : '未填提示词'}
            </div>
          </div>
        );
      }
      case 'director': {
        const prompt = String(d.prompt ?? '');
        return (
          <div className="nb">
            <div className="nthumb" style={{ aspectRatio: '16/9', display: 'grid', placeItems: 'center', background: 'var(--surface-warm)', border: '1.5px dashed var(--border)', color: 'var(--meta)', fontSize: 11 }}>
              运镜参考小样
            </div>
            <div className="nmeta mono">{prompt ? `${prompt.slice(0, 40)}…` : '未填导演 prompt'}</div>
          </div>
        );
      }
      case 'timeline': {
        const shots = (d.shotNodeIds as string[]) ?? [];
        const lastExport = (d.lastExport as TimelineData['lastExport']) ?? undefined;
        return (
          <div className="nb">
            {lastExport?.path ? (
              <TimelineExportPreview lastExport={lastExport} />
            ) : null}
            <div className="clipstrip" style={lastExport?.path ? { marginTop: 7 } : undefined}>
              {shots.length === 0 ? (
                <span className="cs wait" style={{ flex: 1, textAlign: 'center', color: 'var(--meta)', fontSize: 11, padding: '16px 0' }}>
                  拖入镜头节点入线
                </span>
              ) : (
                shots.slice(0, 4).map((sid, i) => {
                  const cover = takeResults[sid];
                  if (!cover) {
                    return (
                      <span key={sid} className="cs wait" title={`镜${i + 1} · 待生成`} style={{ display: 'grid', placeItems: 'center', color: 'var(--meta)', fontSize: 10 }}>
                        {i + 1}
                      </span>
                    );
                  }
                  const src = outputUrlOf(cover);
                  const isVid = /\.(mp4|mov|webm|m4v)$/i.test(src);
                  return (
                    <span key={sid} className="cs" title={`镜${i + 1} · 已生成`}>
                      {isVid ? (
                        <video
                          src={src}
                          muted
                          loop
                          playsInline
                          preload="metadata"
                          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', background: '#000' }}
                        />
                      ) : (
                        <img src={src} alt={`镜${i + 1} 片段封面`} />
                      )}
                    </span>
                  );
                })
              )}
            </div>
            <div className="nmeta mono">
              {lastExport?.path
                ? `已生成成片 · ${shots.length} 片段 · ${lastExport.durationSec ? `${lastExport.durationSec.toFixed(1)}s` : ''} · 可预览`
                : `${shots.length} 个镜头入线 · FFmpeg 导出`}
            </div>
          </div>
        );
      }
      case 'audio-ref': {
        const assetId = String(d.assetId ?? '');
        return (
          <div className="nb">
            <div className="wave">
              {WAVE_BARS.map((h, i) => (
                <i key={i} style={{ height: h }} />
              ))}
            </div>
            <div className="nmeta mono">{assetId ? `资产 ${assetId.slice(0, 12)}… · --ref-audio` : '未绑定音频 · 检查器里选择'}</div>
          </div>
        );
      }
      case 'workflow-input': {
        const slots = (d.slots as Array<{ name: string; accept: string[]; required: boolean; value?: { kind: string } }>) ?? [];
        return (
          <div className="nb">
            <div className="nmeta mono" style={{ marginBottom: 6, color: 'var(--muted)' }}>输入槽位 ×{slots.length}</div>
            {slots.map((s, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', fontSize: 11 }}>
                <span style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                {s.accept.slice(0, 2).map((a) => (
                  <span key={a} className="badge" style={{ fontSize: 9, padding: '1px 5px' }}>{a}</span>
                ))}
                {s.required ? <span className="badge" style={{ fontSize: 9, padding: '1px 5px', background: 'color-mix(in oklab,var(--danger) 10%,transparent)', color: 'var(--danger)' }}>必填</span> : null}
                {s.value ? <span style={{ color: 'var(--success)', fontSize: 10 }}>✓</span> : <span style={{ color: 'var(--meta)', fontSize: 10 }}>—</span>}
              </div>
            ))}
          </div>
        );
      }
      case 'workflow-output': {
        const outputs = (d.outputs as Array<{ name: string; kind: string; sourceNodeIds: string[] }>) ?? [];
        return (
          <div className="nb">
            <div className="nmeta mono" style={{ marginBottom: 6, color: 'var(--muted)' }}>产物汇聚 ×{outputs.length}</div>
            {outputs.map((o, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', fontSize: 11 }}>
                <span style={{ fontWeight: 600, flex: 1 }}>{o.name}</span>
                <span className="badge" style={{ fontSize: 9, padding: '1px 5px' }}>{o.kind}</span>
                <span className="mono mut" style={{ fontSize: 9 }}>×{o.sourceNodeIds.length}</span>
              </div>
            ))}
          </div>
        );
      }
      default: {
        if (n.extra) {
          return (
            <div className="nb">
              <div
                className="nthumb"
                style={{
                  border: '1.5px dashed var(--border)',
                  background: 'var(--surface-warm)',
                  aspectRatio: '16/9',
                  display: 'grid',
                  placeItems: 'center',
                  color: 'var(--meta)',
                  fontSize: '11px',
                }}
              >
                待生成 · 排队中
              </div>
              <div className="nmeta mono">{n.extra}</div>
            </div>
          );
        }
        return (
          <div className="nb">
            <div className="nmeta mono">新节点 · 拖动画布标题栏调整位置，点「+」连接下游</div>
          </div>
        );
      }
    }
  };


  return (
    <div className={`pg-canvas${agentResizing ? ' agent-resizing' : ''}`}>
      <div className={`app${palCollapsed ? ' palette-collapsed' : ''}`} data-od-id="canvas-app">
        {/* 顶部工具条 */}
        <header className="topbar" data-od-id="canvas-toolbar">
          <button className="btn btn-g btn-sm" onClick={() => onNavigate('home')}>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
            >
              <path d="m14 6-6 6 6 6" />
            </svg>
            {projectName || '未命名项目'}
          </button>
          <CanvasSwitcher
            projectCanvases={projectCanvases}
            onSwitchCanvas={switchCanvas}
            onCreateCanvas={onCreateCanvas}
            onDeleteCanvas={onDeleteCanvas}
            onRenameCanvas={onRenameCanvas}
          />
          <span className="sep"></span>
          <button className="ibtn" title="撤销">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <path d="M8 5 3 10l5 5" />
              <path d="M3 10h11a7 7 0 0 1 0 14h-3" />
            </svg>
          </button>
          <button className="ibtn" title="重做">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <path d="m16 5 5 5-5 5" />
              <path d="M21 10H10a7 7 0 0 0 0 14h3" />
            </svg>
          </button>
          <span className="sep"></span>
          <button className="btn btn-g btn-sm">框选</button>
          <button className="btn btn-g btn-sm">连线</button>
          <span className="spacer"></span>
          <button
            className="chip"
            onClick={(e) => {
              e.stopPropagation();
              setOpenPop((p) => (p === 'branchPop' ? null : 'branchPop'));
            }}
          >
            分支：v2 实验
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          <div
            className={`pop${openPop === 'branchPop' ? ' open' : ''}`}
            style={{ top: 46, right: 210 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="pop-it">main · 主版本</div>
            <div className="pop-it">
              v2 实验 · 当前<span className="ck">✓</span>
            </div>
            <div className="pop-it dim">＋ 从当前画布新建分支…</div>
          </div>
          <button
            className="btn btn-s btn-sm"
            data-od-id="rerun-affected"
            disabled={rerunDone}
            style={rerunDone ? { opacity: 0.55 } : undefined}
            onClick={rerunAffected}
          >
            {rerunDone ? '重跑已排队 ✓' : `仅重跑受影响（${nodesRef.current.filter((n) => n.stale || n.agentOn).length}）`}
          </button>
          <button className="btn btn-s btn-sm" data-od-id="run-all" onClick={runAll}>
            运行全部
          </button>
          <button
            className="btn btn-s btn-sm"
            data-od-id="debug-toggle"
            style={dbgOpen ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
            onClick={() => setDbgOpen((v) => !v)}
          >
            {dbgOpen ? '调试面板 ▲' : '调试日志'}
          </button>
        </header>

        <div className="work">
          {/* 左:节点面板 */}
          <aside className="palette" data-od-id="canvas-palette">
            <div className="pal-head">
              <span className="lbl">节点面板 · 点击添加</span>
              <button
                className="pal-fold"
                title="收起节点面板"
                aria-label="收起节点面板"
                data-od-id="palette-collapse"
                onClick={(e) => {
                  e.stopPropagation();
                  setPalCollapsed(true);
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
                  <path d="m14 6-6 6 6 6" />
                </svg>
              </button>
            </div>
            {NODE_TYPES.map((t) => (
              <div
                className="pal-it"
                key={t.id}
                draggable
                title="双击添加到画布中心 · 或拖到画布内"
                onDoubleClick={() => addFromPaletteDbl(t.id)}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'copy';
                  e.dataTransfer.setData('application/x-bigbotart-palette', t.id);
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                  {PALETTE_ICONS[t.id]}
                </svg>
                <div>
                  <b>{t.name}</b>
                  <span>{t.sub}</span>
                </div>
                {t.p1 ? <span className="p1">P1</span> : t.wf ? <span className="p1">WF</span> : null}
              </div>
            ))}
          </aside>

          <button
            className="pal-expand"
            title="展开节点面板"
            aria-label="展开节点面板"
            data-od-id="palette-expand"
            onClick={() => setPalCollapsed(false)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
              <path d="m10 6 6 6-6 6" />
            </svg>
            节点面板
          </button>

          {/* 中:画布 */}
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
              beginPan(e);
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
            onClick={() => {
              setSelected(null);
              closeAddPop();
              setCtx(null);
            }}
          >
            <div
              className="world"
              ref={worldRef}
              style={{
                transform: `translate(${view.x}px,${view.y}px) scale(${view.z})`,
              }}
              onClick={(e) => {
                if (e.target === e.currentTarget) {
                  setSelected(null);
                  closeAddPop();
                }
              }}
            >
              <svg className="edges" ref={edgesSvgRef}>
                {edgePaths.map((p) => (
                  <path key={p.key} className={p.cls} d={p.d} />
                ))}
                {/* 「+」拖拽期间的临时预览线(连 source 节点 → 当前光标) */}
                {connectDrag && connectDrag.moved && (() => {
                  const d = computeConnectPath(connectDrag.sourceId, connectDrag.cx, connectDrag.cy);
                  if (!d) return null;
                  const cls = connectDrag.hitId
                    ? connectDrag.hitOk
                      ? 'connecting ok'
                      : 'connecting bad'
                    : 'connecting';
                  return <path key="__connecting" className={cls} d={d} />;
                })()}
              </svg>

              {nodes.map((n) => {
                const isConnectTarget = connectDrag?.hitId === n.id;
                const cls = [
                  'node',
                  n.ghost ? 'ghost' : '',
                  n.stale ? 'stale' : '',
                  n.agentOn ? 'agent-on' : '',
                  selected === n.id ? 'sel' : '',
                  flashId === n.id ? 'flash' : '',
                  isConnectTarget && connectDrag?.hitOk ? 'connecting-target-ok' : '',
                  isConnectTarget && !connectDrag?.hitOk ? 'connecting-target-bad' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <div
                    key={n.id}
                    className={cls}
                    data-node={n.id}
                    ref={(el) => {
                      if (el) nodeRefs.current.set(n.id, el);
                      else nodeRefs.current.delete(n.id);
                    }}
                    style={{ left: n.x, top: n.y, width: n.w }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      selectNode(n.id);
                      e.stopPropagation();
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      closeAddPop();
                      setOpenPop(null);
                      selectNode(n.id);
                      setCtx({ x: e.clientX, y: e.clientY, id: n.id });
                    }}
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
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        dragRef.current = {
                          id: n.id,
                          sx: e.clientX,
                          sy: e.clientY,
                          ox: n.x,
                          oy: n.y,
                        };
                        e.stopPropagation();
                      }}
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
                    {renderBody(n)}
                    <span className="port"></span>
                    <button
                      className="node-add"
                      data-add={n.id}
                      aria-label="添加下游节点"
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        // 启动拖拽预备态(未拖动仍走 click 弹层路径)
                        beginConnectDrag(n.id, e.clientX, e.clientY);
                        e.stopPropagation();
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        // 未拖动(<4px)才算 click,触发原弹层
                        const d = connectDragRef.current;
                        if (d && d.moved) return;
                        if (apOpen && apFrom === n.id) closeAddPop();
                        else openAddPop(n.id);
                        connectDragRef.current = null;
                        setConnectDrag(null);
                      }}
                    >
                      +
                    </button>
                  </div>
                );
              })}

              {/* 「+」下游节点弹层 */}
              <div
                className={`add-pop${apOpen ? ' open' : ''}`}
                data-od-id="node-add-popover"
                style={{ left: apPos.x, top: apPos.y }}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onWheel={(e) => e.stopPropagation()}
              >
                <div className="ap-h">
                  添加下游节点
                  <span
                    className="mono mut"
                    style={{ marginLeft: 'auto', fontSize: '10.5px', fontWeight: 400 }}
                  >
                    基于：{apFromLabel}
                  </span>
                </div>
                {/* 已连接下游:从边派生,点击定位(连接器 D1:只见节点与端口语义) */}
                <div className="ap-conn" hidden={apOutgoing.length === 0}>
                  <div className="ap-conn-h">
                    已连接下游 · <span>{apOutgoing.length}</span>
                  </div>
                  {apOutgoing.map(({ edge, node }) => (
                    <div
                      key={edge.to}
                      className="ap-conn-r"
                      onClick={(e) => {
                        e.stopPropagation();
                        locate(node.id);
                        selectNode(node.id);
                        closeAddPop();
                      }}
                    >
                      <span className="nm">{node.title}</span>
                      {edge.label ? <span className="lk">{edge.label}</span> : null}
                      {node.ghost ? (
                        <span className="cst">排队中</span>
                      ) : node.stale ? (
                        <span className="cst">
                          <span className="dot" style={{ background: 'var(--warn)' }}></span>待刷新
                        </span>
                      ) : null}
                      <span className="go">定位 →</span>
                    </div>
                  ))}
                </div>
                <div className="ap-s">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                  <input
                    placeholder="搜索节点类型…"
                    value={apSearch}
                    onChange={(e) => setApSearch(e.target.value)}
                  />
                </div>
                <div className="ap-list">
                  {visibleTypes.map((t) => {
                    const rp = apSrc ? resolvePort(apSrc, t.id) : null;
                    return (
                      <div
                        key={t.id}
                        className={`ap-row${apSel === t.id ? ' sel' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setApSel(t.id);
                        }}
                      >
                        <div className="grow">
                          <b>{t.name}</b>
                          <div className="sub">{t.sub}</div>
                          {rp ? (
                            <div className="conn">
                              <span className="lk">{rp.port}</span>
                              {rp.desc}
                            </div>
                          ) : null}
                        </div>
                        {t.id === 'shot' ? <span className="rec">推荐</span> : null}
                        {t.p1 ? <span className="p1">P1</span> : t.wf ? <span className="p1">WF</span> : null}
                      </div>
                    );
                  })}
                  {visibleTypes.length === 0 ? (
                    <div className="ap-empty">
                      {q ? '无匹配的兼容节点类型' : '当前输出没有可连接的节点类型'}
                    </div>
                  ) : null}
                </div>
                <div className="ap-params" hidden={apSel !== 'shot'}>
                  {apSrc?.kind === 'shot' ? (
                    /* 接续上游镜头:比例/档位由上游继承(下游可在检查器改并转为自定义),此处不再给选择 */
                    <div className="ap-res mono" style={{ borderTop: 'none', paddingTop: 2 }}>
                      接续上游：画面规格继承自「{apFromLabel}」（
                      {String(((apSrc.data ?? {}) as Record<string, unknown>).aspect ?? '16:9')} ·{' '}
                      {String(((apSrc.data ?? {}) as Record<string, unknown>).tier ?? 'default')}档 ·{' '}
                      {String(((apSrc.data ?? {}) as Record<string, unknown>).width ?? '')}×
                      {String(((apSrc.data ?? {}) as Record<string, unknown>).height ?? '')}）
                    </div>
                  ) : (
                    <>
                      <div className="ap-prow">
                        <span className="lbl">比例</span>
                        {['16:9', '9:16', '1:1'].map((a) => (
                          <span
                            key={a}
                            className={`chip${apAspect === a ? ' on' : ''}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setApAspect(a);
                              setApTier((t) =>
                                t !== '默认' && !((RES[t] ?? {})[a] ?? null) ? '默认' : t,
                              );
                            }}
                          >
                            {a}
                          </span>
                        ))}
                      </div>
                      <div className="ap-prow">
                        <span className="lbl">档位</span>
                        {['预览', '草稿', '默认', '参考'].map((t) => {
                          const ok = !!((RES[t] ?? {})[apAspect] ?? null);
                          return (
                            <span
                              key={t}
                              className={`chip${apTier === t && ok ? ' on' : ''}${ok ? '' : ' dis'}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!ok) return;
                                setApTier(t);
                              }}
                            >
                              {t}
                            </span>
                          );
                        })}
                      </div>
                      <div className="ap-res mono">{resHint}</div>
                    </>
                  )}
                </div>
                <div className="ap-f">
                  <span className="grow">{apTip}</span>
                  <button
                    className="btn btn-p btn-sm"
                    disabled={!apSel}
                    onClick={(e) => {
                      e.stopPropagation();
                      createFromPop();
                    }}
                  >
                    创建并连线
                  </button>
                </div>
              </div>
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
                  setView((v) => ({ ...v, z: Math.max(0.4, v.z - 0.1) }));
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
                  setView((v) => ({ ...v, x: 20, y: 10, z: 0.86 }));
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
                  setView((v) => ({ ...v, z: Math.min(1.3, v.z + 0.1) }));
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </div>
          </section>

          {/* 右:Agent 面板 */}
          <aside
            className="agent"
            data-od-id="agent-panel"
            ref={(el) => {
              agentRef.current = el;
            }}
            style={{ width: agentW }}
            onClick={() => setCtx(null)}
          >
            <div className="agent-tabs">
              <button
                className={`atab${tab === 'chat' ? ' on' : ''}`}
                data-od-id="tab-chat"
                onClick={() => setTab('chat')}
              >
                Agent 对话
              </button>
              <button
                className={`atab${tab === 'insp' ? ' on' : ''}`}
                data-od-id="tab-inspector"
                onClick={() => setTab('insp')}
              >
                检查器
              </button>
              <span className="spacer"></span>
              <span className="row g6 mono mut" style={{ fontSize: '10.5px' }}>
                <span className="dot ok"></span>pi · 运行中
              </span>
            </div>
            {/* Agent 对话页签(pages/agent/AgentChatView;检查器 pane 保持在本文件) */}
            <AgentChatView
              chat={chat}
              hidden={tab !== 'chat'}
              onLocate={locate}
              onOpenSettings={() => onNavigate('settings')}
            />

            {/* 检查器 pane:按 kind 渲染专属表单;未选节点时无任何组件 */}
            <div
              className={`insp${tab === 'insp' ? ' on' : ''}`}
              data-od-id="inspector"
            >
              {selected && selNode ? (
                <div>
                  <div className="lbl" style={{ marginBottom: 8 }}>
                    {inspectTitle}
                  </div>
                  {selInfo && selInfo.img ? (
                    <div className="preview">
                      <img src={selInfo.img} alt="选中节点预览" />
                    </div>
                  ) : null}
                </div>
              ) : null}
              {selected && selNode ? (
                <InspectorBody
                  node={selNode}
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
                />
              ) : null}
              {selected && (
                <button
                  className="btn btn-s"
                  style={{ width: '100%' }}
                  onClick={() => {
                    if (selected) {
                      void runNode(selected);
                      toastMsg(`已提交重跑 · ${inspectTitle}`);
                    }
                  }}
                >
                  仅重跑该节点
                </button>
              )}
            </div>

            {/* 输入区(pages/agent/AgentComposer) */}
            <AgentComposer chat={chat} toastMsg={toastMsg} />
          </aside>

          {/* Agent 面板宽度拖拽把手 */}
          <button
            className="agent-grip"
            aria-label="拖拽调整 Agent 面板宽度"
            title="拖拽调整面板宽度 · 双击复位"
            data-od-id="agent-resize-handle"
            ref={gripRef}
            style={{ right: 12 + agentW - 6 }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              agentDragRef.current = { sx: e.clientX, w: agentW };
              gripRef.current?.classList.add('on');
              setAgentResizing(true);
              e.preventDefault();
              e.stopPropagation();
            }}
            onDoubleClick={() => {
              setAgentWidth(344, true);
              toastMsg('面板宽度已重置为默认');
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') {
                e.preventDefault();
                setAgentWidth(agentW + 16, true);
              } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                setAgentWidth(agentW - 16, true);
              }
            }}
          ></button>
        </div>

        {/* 底部队列条(真实队列状态) */}
        <footer className="queue" data-od-id="canvas-queue">
          <span className="lbl">队列</span>
          {queueItem('video', jobs, nodes)}
          {queueItem('image', jobs, nodes)}
          <span className="spacer"></span>
          <span className="mono mut" style={{ fontSize: '11px' }}>
            {jobs.filter((j) => j.status === 'queued').length > 0
              ? `${jobs.filter((j) => j.status === 'queued').length} 个排队 · FIFO 串行执行`
              : 'FIFO · 预览档可插队（需确认）'}
          </span>
        </footer>
      </div>

      {/* 节点右键菜单 */}
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
        <button className="pop-it" data-od-id="ctx-duplicate" onClick={onCtxDuplicate(ctx, duplicateNode)}>
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
            setCtx(null);
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
            setCtx(null);
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
            setCtx(null);
            deleteNode(id);
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
            <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0-1 13a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 7" />
          </svg>
          删除<span className="sc">⌫</span>
        </button>
      </div>

      <div className={`toast${toast ? ' show' : ''}`} role="status" aria-live="polite">
        {toast?.msg ?? ''}
      </div>
      {/* projectId 目前仅用于数据落盘,画布演示数据固定 */}
      <span hidden data-project={projectId ?? ''}></span>

      {/* ── 调试面板(右下):主进程日志总线 ── */}
      {dbgOpen ? (
        <div className="dbg-panel" data-od-id="debug-panel">
          <div className="dbg-head">
            <span className="lbl">调试日志 · 实时(主进程)</span>
            <div className="dbg-acts">
              <button
                className="btn btn-s btn-xs"
                onClick={() => void window.bigbotart.debugClear().catch(() => undefined)}
              >
                清空
              </button>
              <button className="btn btn-s btn-xs" onClick={() => setDbgOpen(false)}>
                ✕
              </button>
            </div>
          </div>
          <div className="dbg-body mono" ref={dbgBodyRef}>
            {dbgLogs.length === 0 ? (
              <div className="mut">暂无日志 · 点「立即生成」后这里会实时显示队列 / h3 进度</div>
            ) : (
              dbgLogs.map((e, i) => (
                <div key={i} className={`dbg-line lv-${e.level}`}>
                  <span className="dbg-ts">{e.ts.slice(11, 23)}</span>
                  <span className="dbg-lv">{e.level}</span>
                  <span className="dbg-msg">{e.msg}</span>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 「复制」菜单项的处理(无选中节点时空操作) */
function onCtxDuplicate(
  ctx: { x: number; y: number; id: string } | null,
  fn: (id: string) => void,
) {
  return () => {
    if (!ctx) return;
    fn(ctx.id);
  };
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

