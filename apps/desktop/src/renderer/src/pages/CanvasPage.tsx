import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { CanvasSnapshot, ProjectCanvases, RenderJob, Asset, AssetCategory, NodeKind, Take, DebugLogEntry, PromptSource, TimelineData } from '@bigbotart/shared';
import {
  parseGfmTable,
  resolvePromptFromSource,
  assembleH3Prompt,
  assembleZImagePrompt,
  rowSeconds,
  rowCell,
  resolveMaterializeSeconds,
  planStoryboardMaterializeRows,
  keyframeEdgeLabel,
  existingShotByRow,
  summarizeMaterializePlans,
  tableToGfm,
  capabilityOf,
  resolveImageModel,
  fitImageSizeToGrid,
  classifyAspect,
  normalizeShotDuration,
  validateShotSubmitParams,
} from '@bigbotart/shared';
import type { VideoAspect } from '@bigbotart/shared';
import type { CanvasPageProps, EdgeClass, Edge, CanvasNode, NodeTag, NodeInfo, ConnectDrag } from './canvas/types';
import { shouldBlockEmptySave } from './canvas/empty-save-guard';
import {
  NODE_TYPES,
  SHOT_SIZES,
  SHOT_TIERS,
  tierKeyOf,
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
  contentKey,
  preserveMeasuredSize,
} from './canvas/node-mapping';
import { resolvePort, resolvePortOptions, guardEdge, type PortResolution } from './canvas/connectors';
import { ensureToolModels, fetchAccelDefaultShotConfig } from './canvas/tool-models-store';
import { CASCADE_KINDS, allDownstreamGenIds, pickCascadeTargets, shouldKickCascade } from './canvas/cascade';
import { sbMaterializedRows, sbImgCount, sbTableOf, sbDirty, SB_SIZE } from './canvas/storyboard';
import { basenameOf, thumbSrc, previewUrlOf, isVideoPath, isAudioPath } from './canvas/media';
import { latestTakeResultByNode } from './canvas/inspector/useTakeResult';
import { computeEdgeDerivations, nodesReducer } from './canvas/edge-dispatch';
import { HistoryStack, type HistoryContent } from './canvas/canvas-history';
import {
  UNMEASURED_NODE_H as SEL_UNMEASURED_H,
  rectFromPoints,
  nodesInRect,
  nodeRect,
  clientPointOf,
  createGroup,
  dissolveGroups,
  pruneGroups,
  expandSelectionToGroups,
  selectionIsWholeGroup,
  normalizeGroups,
  type NodeGroup,
  type Rect,
} from './canvas/selection';
import { panOffset, wheelIntent, zoomFactorFor } from './canvas/wheel-intent';
import {
  clampInspWidth,
  DEFAULT_INSP_W,
  ensureWorldBoxVisible,
  leftChromeWidth,
  lerpView,
  PANEL_EDGE,
  PANEL_TOP,
  REVEAL_ANIM_MS,
  rightChromeWidth,
} from './canvas/viewport-ensure';
import { Toolbar } from './canvas/Toolbar';
import { Palette } from './canvas/Palette';
import { StageView } from './canvas/StageView';
import { AddNodePopover } from './canvas/AddNodePopover';
import { usePrompt } from '../components/usePrompt';
import { PortPickPop } from './canvas/PortPickPop';
import { AgentPane } from './canvas/AgentPane';
import { InspectorPane } from './canvas/InspectorPane';
import { ContextMenu } from './canvas/ContextMenu';
import { DebugPanel, type DebugTab } from './canvas/DebugPanel';
import { usePerfMonitor } from './canvas/usePerfMonitor';
import { QueueBar } from './canvas/QueueBar';
import { AssetPickerPop } from './canvas/AssetPickerPop';
import { useAgentChat } from './agent/useAgentChat';

/** 节点尚未测得高度时的估算兜底(px):连线端点/预览线首帧用,实测后立即被替换 */
const UNMEASURED_NODE_H = 72;

/** 拆分节点取片 label(piece-1 / piece-2 / …,1-based;与 shared edge-validate PIECE_LABEL_RE 同口径) */
const PIECE_LABEL_RE = /^piece-([1-9]\d*)$/;

/**
 * 解析上游节点的图片产物路径(运行时统一入口):
 * - asset 节点 → 资产本地路径
 * - image-split 且边 label 为 piece-N → 取第 N 片(无该片 = undefined,不静默回退)
 * - 其余图片产物节点 → data.resultPath
 */
function upstreamImagePath(
  up: CanvasNode | undefined,
  edgeLabel: string | undefined,
  assetCache: Record<string, string>,
): string | undefined {
  if (!up) return undefined;
  const upData = (up.data ?? {}) as Record<string, unknown>;
  if (up.kind === 'asset') return assetCache[String(upData.assetId ?? '')] || undefined;
  if (up.kind === 'image-split') {
    const m = PIECE_LABEL_RE.exec(edgeLabel ?? '');
    if (m) {
      const pieces = Array.isArray(upData.pieces) ? (upData.pieces as string[]) : [];
      return pieces[Number(m[1]) - 1] || undefined;
    }
  }
  return String(upData.resultPath ?? '') || undefined;
}

/**
 * 解析上游节点的**视频**产物路径(video-upscale 运行时入口):
 * - asset 节点 → 资产缓存本地路径
 * - shot / video-upscale 等视频产物节点 → data.resultPath
 * 与 upstreamImagePath 同形状,但语义上是视频(不处理 piece-N)。
 */
function upstreamVideoPath(
  up: CanvasNode | undefined,
  assetCache: Record<string, string>,
): string | undefined {
  if (!up) return undefined;
  const upData = (up.data ?? {}) as Record<string, unknown>;
  if (up.kind === 'asset') return assetCache[String(upData.assetId ?? '')] || undefined;
  return String(upData.resultPath ?? '') || undefined;
}

/** 默认视图(无持久化 viewport 的画布:新画布 / 旧项目文件) */
const DEFAULT_VIEW = { x: 20, y: 10, z: 0.86 };

/** 画布视口合法化:非有限值 / 越界缩放一律回退默认视图(旧项目文件与手改 JSON 都走这里) */
function normalizeView(raw?: { x?: unknown; y?: unknown; z?: unknown } | null): { x: number; y: number; z: number } {
  const x = Number(raw?.x);
  const y = Number(raw?.y);
  const z = Number(raw?.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return { ...DEFAULT_VIEW };
  if (z < 0.4 || z > 1.3) return { ...DEFAULT_VIEW };
  return { x, y, z };
}

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
  const inspGripRef = useRef<HTMLButtonElement | null>(null);
  const agentRef = useRef<HTMLElement | null>(null);
  const minimapRef = useRef<HTMLDivElement | null>(null);
  /** 选中避让(revealNode)的稳定入口;拖拽 pointerup 比 revealNode 定义更早,故提前占位 */
  const revealNodeRef = useRef<(id: string) => void>(() => {});
  const toastTimer = useRef<number | null>(null);
  const queueTimer = useRef<number | null>(null);
  /** 队列状态补种入口(挂载/重载画布后把「正在生成」重新标回节点;订阅 effect 里赋值) */
  const queueReseedRef = useRef<(() => Promise<void>) | null>(null);
  const saveTimer = useRef<number | null>(null);
  /** 视口(平移/缩放)落盘防抖计时器 */
  const viewTimer = useRef<number | null>(null);

  /* ── 视图:平移 / 缩放(以指针为中心滚轮缩放) ──
     初值 = 默认视图;挂载/切画布时由画布快照的 viewport 覆盖(见下方加载 effect)。

     ⚠️ P3:视口更新**不再走 React 渲染路径**。
     平移/缩放只调 applyView(直写 .world 的 CSS 变量)并同步 viewRef,
     完全不 setState —— 这正是「拖动时整棵树重渲染」的根治。
     `view` 这个 state 只在**离散时点**更新:挂载/切画布/恢复快照/点小地图跳转,
     它的作用是让「首帧与快照恢复」这类需要 React 参与的场景有单一真源。

     🚨 viewRef 是命令式路径的**唯一真源,绝不能在渲染期回写**(2026-09 真实事故:
     「滚轮缩放闪烁不动」)。曾经的写法是渲染期无条件 `viewRef.current = view;`,
     而注释里说的「只在离散时点 setState」并不成立 —— applyViewLive 为更新底部百分比
     会 setZoomPctLive,于是滚轮的每一次 setState 都伴随一次渲染,渲染又把
     viewRef 拽回那个还没被 commitView 推进的旧 view。结果:

       滚轮事件 → 写 ref(新值) → 渲染 → ref 被旧 state 覆盖 → 下一次滚轮
       又从同一个旧起点重算 → 帧间在两个值之间来回跳 = 「闪烁不动」

     为什么只有滚轮中招、平移正常:平移在 pointerdown 时**快照** vx/vy 一次,
     之后每帧只用快照 + 指针位移,ref 被回写也不影响;滚轮则是**每个事件都读
     live ref**,ref 不前进就等于原地打转。

     修法:ref 只在构造时初始化,之后一律由 commitView / applyViewLive 推进。 */
  const [view, setView] = useState({ ...DEFAULT_VIEW });
  const viewRef = useRef(view);
  // ⛔ 禁止在此处写 viewRef.current = view —— 会把命令式更新抹掉(见上)。

  /**
   * 把视口写进 `.world` 的 CSS 变量(命令式,不触发 React 渲染)。
   * CSS 侧 `transform: translate(var(--vx),var(--vy)) scale(var(--vz))`。
   */
  const applyView = useCallback((v: { x: number; y: number; z: number }) => {
    const el = worldRef.current;
    if (!el) return;
    el.style.setProperty('--vx', `${v.x}px`);
    el.style.setProperty('--vy', `${v.y}px`);
    el.style.setProperty('--vz', String(v.z));
  }, []);

  /**
   * 视口动画中(平移/缩放/拖动节点):期间给根容器挂 `animating` 类,
   * CSS 侧据此摘掉毛玻璃(backdrop-filter)并恢复不透明底色。
   *
   * 为什么需要:毛玻璃元素每帧都要重新读取并模糊它下面的像素,而 .world 正在
   * 它们下面移动 → 逐帧重采样,是「节点不多却很卡」的主要来源。
   * 停止操作 150ms 后自动摘掉,静态时视觉完全不变。
   */
  const [viewportAnimating, setViewportAnimating] = useState(false);
  const animatingTimer = useRef<number | null>(null);
  /** 打上动画标记并续期:操作期间持续调用,停手 150ms 后自动降级回毛玻璃 */
  const markViewportAnimating = useCallback(() => {
    setViewportAnimating(true);
    if (animatingTimer.current !== null) window.clearTimeout(animatingTimer.current);
    animatingTimer.current = window.setTimeout(() => {
      animatingTimer.current = null;
      setViewportAnimating(false);
    }, 150);
  }, []);
  useEffect(
    () => () => {
      if (animatingTimer.current !== null) window.clearTimeout(animatingTimer.current);
    },
    [],
  );

  /**
   * 拖拽/缩放期间的高频视口更新:写 DOM + 同步 ref,并标记动画态。
   * 不 setState —— 这是 P3 的核心。
   *
   * ⚠️ 但缩放百分比(zoomPct)是**显示值**,必须跟着变,否则滚轮缩放时
   * 底部「86%」会卡住不动(视觉 bug)。所以这里额外维护一个**只含整数百分比**
   * 的轻量 state:它对同一整数不重复 setState(拖一次滚轮通常只触发几次渲染),
   * 且因为 StageView 已 memo 化节点、百分比只传给 zoomctl 那一小块,
   * 代价远小于「每帧重渲染整棵树」。
   */
  const [zoomPctLive, setZoomPctLive] = useState(() => Math.round(DEFAULT_VIEW.z * 100));
  const applyViewLive = useCallback(
    (v: { x: number; y: number; z: number }) => {
      viewRef.current = v;
      applyView(v);
      markViewportAnimating();
      const pct = Math.round(v.z * 100);
      setZoomPctLive((prev) => (prev === pct ? prev : pct)); // 同值不触发渲染
    },
    [applyView, markViewportAnimating],
  );

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
  const [edges, setEdgesState] = useState<Edge[]>([]);
  /** 节点/边 ref:必须**同步**跟上每一次写入(不能只在渲染期赋值)。
   *  原因:commitEdit 在 setNodes/setEdges 之后同一 tick 内读它来决定历史条目,若 ref 还是旧值,
   *  历史会认为「结构没变」而不记录 —— 表现就是「新建的节点撤销不掉」(2026-09-22 实测事故)。 */
  const nodesRef = useRef<CanvasNode[]>(nodes);
  const edgesRef = useRef<Edge[]>(edges);
  const setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>> = useCallback(
    (arg: CanvasNode[] | ((prev: CanvasNode[]) => CanvasNode[])) => {
      // 同步推进 ref(与 reducer 相同的纯 updater 语义;StrictMode 下 reducer 仍会双跑,但 ref 只推进一次)
      nodesRef.current = typeof arg === 'function' ? arg(nodesRef.current) : arg;
      dispatchNodes({
        type: 'set',
        updater: typeof arg === 'function' ? arg : () => arg,
      });
    },
    [],
  );
  /** setEdges 包装:同样写入即同步 ref */
  const setEdges: React.Dispatch<React.SetStateAction<Edge[]>> = useCallback(
    (arg: Edge[] | ((prev: Edge[]) => Edge[])) => {
      edgesRef.current = typeof arg === 'function' ? arg(edgesRef.current) : arg;
      setEdgesState(arg);
    },
    [],
  );
  /** store 侧已知快照版本(挂载/刷新/推送时更新;保存用它,避免旧版本整体覆盖 Agent 的增量写盘) */
  const [knownVersion, setKnownVersion] = useState(0);
  const knownVersionRef = useRef(0);
  knownVersionRef.current = knownVersion;
  /**
   * 选中节点 id 集合(框选/多选的核心状态)。
   *
   * 顺序语义:末位 = 「主选中」—— 检查器/Agent 关注节点取它;
   * 空数组 = 未选中。单选用 `selectNode(id)` 写 `[id]`。
   * 之所以用数组而非 Set:插入顺序要稳定(主选中 = 最后点的那个),且可直接序列化比对。
   */
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** 派生:单选时为主选中 id,多选/空选为 null(下游检查器/Agent 契约不变) */
  const selected = selectedIds.length === 1 ? selectedIds[0]! : null;
  const selectedIdsRef = useRef<string[]>([]);
  selectedIdsRef.current = selectedIds;
  /** 「框选」模式开关:开 = 拖空白框选;关 = 拖空白无动作(平移走双指滑动/中键/空格) */
  const [marqueeMode, setMarqueeMode] = useState(false);
  /** 正在拖拽的框选矩形(world 坐标;ref 供每帧读取,state 供渲染) */
  const [selectionRect, setSelectionRect] = useState<Rect | null>(null);
  const selRectRef = useRef<{
    /** 起始点(world 坐标;pointerdown 当场拍下) */
    ax: number;
    ay: number;
    /** 起始点的**屏幕坐标**(后续 pointermove 事件可能被 React 回收,不能回头读 e) */
    sx: number;
    sy: number;
    additive: boolean;
    /** 指针是否已移动过(区分「框选」与「点击空白清空选区」) */
    moved: boolean;
  } | null>(null);
  /** 节点分组(随快照持久化;组内节点整体拖动/删除/复制) */
  const [groups, setGroups] = useState<NodeGroup[]>([]);
  const groupsRef = useRef<NodeGroup[]>([]);
  groupsRef.current = groups;
  const [flashId, setFlashId] = useState<string | null>(null);
  const [infoMap, setInfoMap] = useState<Record<string, NodeInfo>>(() => ({
    ...NODE_INFO_BASE,
  }));

  /* ── 面板 / 弹层 / 底部状态 ── */
  const [palCollapsed, setPalCollapsed] = useState(false);
  const [agentW, setAgentW] = useState(344);
  const [agentResizing, setAgentResizing] = useState(false);
  const [inspW, setInspW] = useState(DEFAULT_INSP_W);
  const [inspResizing, setInspResizing] = useState(false);
  const [openPop, setOpenPop] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string } | null>(null);
  /** 正在重命名的节点 id(null = 无;节点头部显示内联输入框,Electron 不支持 window.prompt) */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; n: number } | null>(null);

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
  /** 最近一次发起视频增强的节点 id(null = 无):主进程进度事件据此定位到节点。
   *  用 ref 而非 state —— 进度回调在 effect 闭包里读,state 会拿到过期值。 */
  const videoPostRef = useRef<string | null>(null);
  /** 正在跑视频增强的节点集合(防重入闩;全局后处理串行,通常至多 1 个) */
  const videoPostRunningRef = useRef<Set<string>>(new Set());
  /** 运行标记走 state 同步一份,供按钮置灰(仅 ref 改动不会触发重渲染) */
  const [videoPostRunning, setVideoPostRunning] = useState<string[]>([]);
  const bootRef = useRef(true); // 挂载期跳过首轮保存(等加载/规划落地)
  /** 本地 nodes/edges 当前代表的画布 id —— 「合法清空」只对已装填的那张画布成立(见 empty-save-guard) */
  const hydratedCanvasRef = useRef<string | null>(null);
  /** 用户是否**确实**用删除操作把这张画布删空了(唯一允许「0 节点落盘」的凭证;
   *  换画布/加载时复位 —— 见 canvas/empty-save-guard)。2026-10-20 事故:只凭 allowEmpty 放行,
   *  渲染层窗口期的「空 nodes + 旧 edges」快照把两个项目的画布抹空。 */
  const userClearedRef = useRef(false);
  /** 从 store 重新拉当前画布(在 refreshCanvasFromStore 定义后注入)。
   *  maybePersist 拒绝可疑快照后用它把屏幕内容恢复成 store 的真值 —— 不能只拒绝不修,
   *  否则用户会盯着一个「屏幕上空了但磁盘还在」的画布。 */
  const refreshFromStoreRef = useRef<() => void>(() => {});
  const prevJobState = useRef<Record<string, string>>({});
  /** 接力轮次中已提交、仍存活的任务(去重防重复入队;终态后移除) */
  const cascadePendingRef = useRef<Set<string>>(new Set());
  /** 最新接力触发函数(渲染时重绑,引用最新 runNode,避免 effect 闭包拿到旧版本) */
  const cascadeKickRef = useRef<(nodeId: string, jobs: RenderJob[], freshTail?: string) => void>(() => {});
  /** 资产 id → 本地路径(assetId → localPath)。
   *  ⚠️ 必须是**从 assetsList 派生的 state**,不能是 `useRef`(2026-10 事故修复):
   *  用 ref 时「缓存已更新」不会触发重渲染,而下游读的却是 `assetCache` ——
   *  两者一旦不同步,表现就是「清单刷新了、节点缩略图/检查器输入图还是空的」,
   *  且没有任何重渲染能把它纠正回来。派生值天然与清单同源,这类 bug 整类消失。 */
  const [assetsList, setAssetsList] = useState<Asset[]>([]);
  const assetCache = useMemo(
    () => Object.fromEntries(assetsList.map((a) => [a.id, a.localPath])),
    [assetsList],
  );
  const [categories, setCategories] = useState<AssetCategory[]>([]);
  /** 资产选择弹层(「更换资产…」/检查器选资产):null = 关闭,值 = 目标 asset 节点 id */
  const [assetPickFor, setAssetPickFor] = useState<string | null>(null);
  const [assetPopPos, setAssetPopPos] = useState<{ x: number; y: number } | null>(null);

  /* ── 「+」下游节点弹层 ── */
  const [apFrom, setApFrom] = useState<string | null>(null);
  const [apOpen, setApOpen] = useState(false);
  /** 「+」弹层打开计数:每次打开 +1(AddNodePopover 用它重置内部搜索/选中) */
  const [apOpenCount, setApOpenCount] = useState(0);
  /** apFrom/apOpen 的镜像 ref:供「节点级回调」读取而不必进依赖数组(P1)。
   *  回调若直接依赖这两个 state,每次开关弹层都会重建 → NodeCard 的 memo 失效。 */
  const apOpenRef = useRef(apOpen);
  apOpenRef.current = apOpen;
  const apFromRef = useRef(apFrom);
  apFromRef.current = apFrom;

  /* Agent 对话面板:全部状态/副作用在 pages/agent/useAgentChat(本组件只持有返回值) */
  const selInfo = selected ? infoMap[selected] : undefined;
  const selNode = selected ? nodes.find((n) => n.id === selected) : undefined;
  /** 检查器标题 = 当前选中节点的名字 + ID(派生值,跟随选中/重命名实时更新,不再写死) */
  const inspectTitle = selNode ? `${selInfo?.t ?? selNode.title} · ${selNode.id}` : '未选择节点';

  const toastMsg = useCallback((msg: string) => {
    setToast({ msg, n: Date.now() });
  }, []);

  /* ── Agent 聊天「关注节点」列表(与画布选中态解耦,可多选)──
     点按节点只选中(检查器),不绑给聊天窗口;关注节点由右键菜单「添加到聊天窗口」
     累积设定(再点一次同一节点 = 移除),发送时还可叠输入框的 @ 提及(按消息级)。
     取消关注走 chip 上的 ×(点按空白只清画布选区,不再动聊天关注)。 */
  const [focusNodes, setFocusNodes] = useState<Array<{ id: string; title: string }>>([]);
  const focusNodesRef = useRef<Array<{ id: string; title: string }>>([]);
  focusNodesRef.current = focusNodes;
  /** 右键「添加到聊天窗口」:切换式累积(已存在则移除);标题展示时随画布实时重取(见 focusNodes prop) */
  const toggleChatFocus = useCallback(
    (id: string) => {
      const n = nodesRef.current.find((x) => x.id === id);
      if (!n) return;
      const exists = focusNodesRef.current.some((x) => x.id === id);
      setFocusNodes((cur) => (exists ? cur.filter((x) => x.id !== id) : [...cur, { id: n.id, title: n.title }]));
      toastMsg(exists ? `已从聊天窗口移除 · 「${n.title}」` : `已添加到聊天窗口 · 关注「${n.title}」`);
    },
    [toastMsg],
  );

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

  /**
   * 节点 DOM 注册(ResizeObserver 与拖拽定位用)。
   *
   * ⚠️ 必须是稳定引用(P1):它作为 `registerRef` 透传到每个 NodeCard,
   * 而卡片包了 React.memo —— 若这里写成 JSX 内联箭头,每次渲染都是新函数,
   * 浅比较必然失败,memo 直接失效(视口平移时全部卡片照样重渲染)。
   * 实现里只用 ref(roRef/nodeRefs),无闭包依赖,故依赖数组为空。
   */
  const registerNodeRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) {
      nodeRefs.current.set(id, el);
      // 新 DOM 挂载即测量(observe 幂等,重复调用无副作用)
      roRef.current?.observe(el);
    } else {
      nodeRefs.current.delete(id);
    }
  }, []);

  /* ══ 撤销 / 重做(真正的实现:见 canvas/canvas-history.ts)══
     提交时机 = 离散编辑动作完成时(不是 state 每次变化):
     - 拖动节点结束 / 参数改写 / 建删节点与连线 / 分镜表铺节点 …
     - view(平移缩放)不进历史;Agent 工具写盘不经这里(由推送 refresh 换基线)
     历史里只存「节点 + 连线」的可序列化内容。 */
  const historyRef = useRef(new HistoryStack());
  const [histVer, setHistVer] = useState(0);
  /** 取当前内容(节点 + 连线)的引用快照:数组本身不可变(每次写入都是新数组),故浅拷贝即快照 */
  const contentSnapshot = useCallback(
    (): HistoryContent => ({
      nodes: nodesRef.current,
      edges: edgesRef.current,
      groups: groupsRef.current,
    }),
    [],
  );
  /** 记录一次编辑:label 是动作名(撤销提示与按钮 tooltip 用)。
   *  调用时机:在对应 setState/setEdges **之后**立即调用(此时 ref 已是编辑后内容)。
   *  「编辑前」状态由 HistoryStack 自己在基线里保存,所以这里不需要传 prev,
   *  也就不会踩「prev/next 必须同一渲染周期成对给出」的时序陷阱。 */
  const commitEdit = useCallback((label: string) => {
    historyRef.current.commit(contentSnapshot(), label);
    setHistVer((v) => v + 1);
  }, [contentSnapshot]);
  /** 工具条的按钮态:必须**读** histVer,否则 setHistVer 不会触发重渲染 ——
   *  历史栈在 ref 里,React 看不见它的变化,按钮会永远停在初始的置灰状态。 */
  const canUndo = useMemo(() => historyRef.current.canUndo(), [histVer]);
  const canRedo = useMemo(() => historyRef.current.canRedo(), [histVer]);

  /** 应用历史内容到画布(节点 + 连线一次 setState,避免中间态触发连线派生)。
   *  回放期间(下一帧之前)所有 commitEdit 被 HistoryStack 的闸门忽略,保证撤销本身不进历史。 */
  const applyHistoryContent = useCallback(
    (content: HistoryContent) => {
      historyRef.current.beginReplay();
      setNodes(content.nodes as CanvasNode[]);
      setEdges(content.edges as Edge[]);
      // 分组一并回放(否则「撤销建组」后组框还留在画布上)
      if (content.groups) setGroups(content.groups as NodeGroup[]);
      const settle = () => {
        historyRef.current.endReplay({
          nodes: nodesRef.current,
          edges: edgesRef.current,
          groups: groupsRef.current,
        });
        setHistVer((v) => v + 1);
      };
      // 等两个渲染帧:连线派生 effect(derive-from-edges)可能再写一次 state,之后才建立基线
      requestAnimationFrame(() => requestAnimationFrame(settle));
    },
    [setNodes, setEdges, setGroups],
  );

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (!h.canUndo()) {
      toastMsg('没有可撤销的操作');
      return;
    }
    const entry = h.stepUndo(contentSnapshot());
    if (!entry) return;
    applyHistoryContent(entry.content);
    toastMsg(`已撤销:${entry.label}${h.canRedo() ? ' · ⌘⇧Z 重做' : ''}`);
  }, [applyHistoryContent, contentSnapshot, toastMsg]);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (!h.canRedo()) {
      toastMsg('没有可重做的操作');
      return;
    }
    const entry = h.stepRedo(contentSnapshot());
    if (!entry) return;
    applyHistoryContent(entry.content);
    toastMsg(`已重做:${entry.label}`);
  }, [applyHistoryContent, contentSnapshot, toastMsg]);

  /* ── 舞台可视区尺寸(小地图视口框/跳转中心需要;窗口变化与面板拖宽时实时更新) ── */
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => setStageSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** 小地图跳转:把目标世界坐标对准舞台中心(保持当前缩放不变) */
  const onMinimapNavigate = useCallback(
    (world: { x: number; y: number }) => {
      const stage = stageRef.current;
      if (!stage) return;
      const v = viewRef.current;
      /* 小地图可拖拽 → 高频更新,同样走命令式(不 setState)。
         松手后由 minimap 的 up 事件触发一次 setView 收尾(见 StageView)。 */
      applyViewLive({
        ...v,
        x: stage.clientWidth / 2 - world.x * v.z,
        y: stage.clientHeight / 2 - world.y * v.z,
      });
    },
    [applyViewLive],
  );

  /**
   * 离散时点的视口提交(切画布 / 恢复快照 / 外部推送 / 缩放按钮 / 各拖动收尾)。
   * 统一在这里做三件事,避免漏掉任何一处导致「state 与显示不一致」:
   *   ① 写 view state(持久化与快照以它为真源);
   *   ② 同步 viewRef(命令式路径随后读到的是最新值);
   *   ③ 同步缩放百分比显示。
   */
  const commitView = useCallback((v: { x: number; y: number; z: number }) => {
    viewRef.current = v;
    setView(v);
    setZoomPctLive(Math.round(v.z * 100));
  }, []);

  /** 程序化避让动画的 rAF id;用户手势(平移/缩放/拖节点)必须取消,避免抢控制权 */
  const viewAnimRef = useRef<number | null>(null);
  const cancelViewAnim = useCallback(() => {
    if (viewAnimRef.current == null) return;
    cancelAnimationFrame(viewAnimRef.current);
    viewAnimRef.current = null;
  }, []);

  /**
   * 平滑过渡到目标视口(选中避让用)。走 applyViewLive 逐帧,收尾 commitView 落盘。
   * 不用 CSS transition:--vx/--vy 未 @property 注册时 transform 不会插值,只会瞬移。
   */
  const animateViewTo = useCallback(
    (target: { x: number; y: number; z: number }, durationMs: number = REVEAL_ANIM_MS) => {
      cancelViewAnim();
      const from = { ...viewRef.current };
      if (from.x === target.x && from.y === target.y && from.z === target.z) {
        commitView(target);
        return;
      }
      const t0 = performance.now();
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / durationMs);
        applyViewLive(lerpView(from, target, p));
        if (p < 1) {
          viewAnimRef.current = requestAnimationFrame(step);
        } else {
          viewAnimRef.current = null;
          commitView(target);
        }
      };
      viewAnimRef.current = requestAnimationFrame(step);
    },
    [applyViewLive, cancelViewAnim, commitView],
  );

  /**
   * 小地图拖动结束:把命令式写入的视口同步回 state(P3 收尾)。
   * 必要性:持久化 effect 依赖 view 分量,若不同步则「用小地图拖过的视角」
   * 不会落盘,下次进画布会回到拖动前的视角。
   */
  const onMinimapCommit = useCallback(() => {
    commitView({ ...viewRef.current });
  }, [commitView]);

  /* ── 节点定位 + 拖拽(scale 校正,和 canvas.js 一致) ──
   * 多选/整组拖动:按下时冻结**每个被拖节点各自的起点坐标**(origins),
   * 移动时统一加同一个位移 —— 绝不在 setState updater 里读前一帧或算增量:
   * StrictMode 下 updater 会双跑,累加式增量会翻倍(AGENTS.md §5.1 的真实事故类型)。 */
  const dragRef = useRef<{
    ids: string[];
    sx: number;
    sy: number;
    /** 拖动前各节点的原始坐标(按下时冻结;缺席的节点不动) */
    origins: Map<string, { x: number; y: number }>;
    moved: boolean;
    /**
     * 本次按下是否新建立了单选 —— pointerup 且未拖动时触发检查器避让。
     * 主路径是 beginNodeDrag(不经 selectNode),必须在这里记一笔,否则避让永远不跑。
     */
    revealOnUp: boolean;
  } | null>(null);
  /** 拖动开始时的内容(撤销要回到的位置):拖拽过程中每帧 setState 只写状态,不动历史 */
  const dragPrevRef = useRef<HistoryContent | null>(null);
  /**
   * 正在被拖动的节点 id 集合(空集合 = 没在拖)。
   * 用途只有一个:给这些节点挂 `dragging` 类 → CSS 提前提升为独立合成层
   * (`will-change:transform`),拖动时只做合成器位移、不重绘节点内容。
   * ⚠️ 必须随拖动结束立刻清空 —— 常驻 will-change 会让每个节点独占一层显存。
   */
  const [draggingIds, setDraggingIds] = useState<string[]>([]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const z = viewRef.current.z;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) {
        d.moved = true;
        // 用户在拖节点 → 取消避让动画,避免和手势抢视口
        cancelViewAnim();
      }
      markViewportAnimating();
      const dx = (e.clientX - d.sx) / z;
      const dy = (e.clientY - d.sy) / z;
      const ids = new Set(d.ids);
      setNodes((ns) =>
        ns.map((n) => {
          if (!ids.has(n.id)) return n;
          const o = d.origins.get(n.id);
          if (!o) return n;
          return { ...n, x: o.x + dx, y: o.y + dy };
        }),
      );
    };
    const onUp = () => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      setDraggingIds([]);
      perfMonitor.endPhase();
      // 拖动结束 = 一次离散编辑 ✓ 提交历史(未真正移动过则不记)
      if (d.moved && dragPrevRef.current) {
        // 拖动是唯一「跨越很长时间、起点状态必须显式记下」的编辑:直接把拖动前内容当撤销目标
        const label = d.ids.length > 1 ? `移动 ${d.ids.length} 个节点` : '移动节点';
        historyRef.current.commitFrom(
          dragPrevRef.current,
          { nodes: nodesRef.current, edges: edgesRef.current, groups: groupsRef.current },
          label,
        );
        setHistVer((v) => v + 1);
      }
      dragPrevRef.current = null;
      // 点选(未拖动)且本次建立了单选 → 避让检查器;经 beginNodeDrag 的主路径靠这里触发
      if (!d.moved && d.revealOnUp && d.ids.length >= 1) {
        const id = selectedIdsRef.current.length === 1 ? selectedIdsRef.current[0]! : d.ids[0]!;
        requestAnimationFrame(() => revealNodeRef.current(id));
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [cancelViewAnim, markViewportAnimating]);

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
    // 🛡️ 权威校验闸:渲染层 BY_KIND 与 shared CONNECTOR_MAP 是两份表,可能分叉
    //(事故:video-upscale → image-edit 建出裸边 ⇒ 派生态与写盘广播对拉 ⇒ 节点不停闪烁)。
    // 这里直接复用 shared validateEdge,让两份表共用同一套规则,不在渲染层复制判断。
    const guard = guardEdge(src, dst, edgeLabel, nodesRef.current, edgesRef.current);
    if (!guard.ok) {
      toastMsg(`无法连线:${guard.message}`);
      return;
    }
    const before = { nodes: nodesRef.current, edges: edgesRef.current };
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
      // 拖拽建边同样每帧触发重渲染且临时预览线在动 → 一并走毛玻璃降级
      markViewportAnimating();
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
  }, [hitTestNode, commitConnectEdge, markViewportAnimating]);

  /* ── 空白处拖拽:框选(marqueeMode)──
   * 2026-10 改:开关**只**管框选 —— 关闭时拖空白不再平移画布(左键拖空白太容易误操作),
   * 平移统一走「触控板双指滑动」(见 onWheelPan);鼠标用户另有两条保底通道:
   * 中键拖动 / 空格+拖动(见下方 onStagePointerDown),没有触控板也不憋屈。 */
  const panStartRef = useRef({ sx: 0, sy: 0, vx: 0, vy: 0 });
  /** 空格按下中(临时切换为平移:与 Photoshop/Figma 一致,空格是通用抓手) */
  const spaceDownRef = useRef(false);
  /** 空格按下的**渲染态**(仅用于把光标切成抓手;平移判定仍以 spaceDownRef 为准) */
  const [spacePanning, setSpacePanning] = useState(false);
  const beginPan = (e: React.PointerEvent) => {
    cancelViewAnim();
    panStartRef.current = {
      sx: e.clientX,
      sy: e.clientY,
      vx: viewRef.current.x,
      vy: viewRef.current.y,
    };
    perfMonitor.beginPhase('pan');
    setPanning(true);
  };
  useEffect(() => {
    if (!panning) return;
    const onMove = (e: PointerEvent) => {
      const s = panStartRef.current;
      /* P3:拖动中**不 setState** —— 只写 CSS 变量。
         原先每次 pointermove 都 setView,导致整棵画布树(含全部节点卡片)
         每帧重渲染;memo 能挡掉大部分,但根节点与 StageView 仍要 reconcile。 */
      applyViewLive({ ...viewRef.current, x: s.vx + (e.clientX - s.sx), y: s.vy + (e.clientY - s.sy) });
    };
    const onUp = () => {
      setPanning(false);
      perfMonitor.endPhase();
      // 松手时把最终视口同步回 state:持久化 effect 依赖 view 分量,
      // 且切画布/快照比对都以 state 为真源(拖动期间只活在 ref/DOM 里)
      commitView({ ...viewRef.current });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [panning, applyViewLive]);

  /* ── 框选(marquee)──
   * ⚠️ 坐标必须在 **pointerdown / pointermove 当场**取出(`clientPointOf`):
   * React 合成事件在处理器返回后会被回收,任何「先存 e、稍后再读 clientX」的写法
   * 都会拿到 undefined → NaN 矩形 → 框选永远框不中(真实事故,见 selection.ts 注释)。
   * 起止两点都用屏幕坐标存,计算时统一换算 world,不再依赖事件对象。 */
  const applyMarquee = useCallback((sx: number, sy: number, cx: number, cy: number, additive: boolean) => {
    const a = screenToWorld(sx, sy);
    const b = screenToWorld(cx, cy);
    const rect = rectFromPoints(a.x, a.y, b.x, b.y);
    const hit = nodesInRect(nodesRef.current, rect);
    // 命中组内任一节点 → 整组一起选中(组概念的核心手感)
    const expanded = expandSelectionToGroups(groupsRef.current, hit);
    if (additive) {
      const cur = new Set(selectedIdsRef.current);
      for (const id of expanded) cur.add(id);
      setSelectedIds([...cur]);
    } else {
      setSelectedIds(expanded);
    }
  }, []);

  const beginMarquee = useCallback((e: React.PointerEvent) => {
    const p = clientPointOf(e);
    const w = screenToWorld(p.x, p.y);
    selRectRef.current = {
      ax: w.x,
      ay: w.y,
      sx: p.x,
      sy: p.y,
      // Shift = 并入现有选区(不清空),与 Figma 一致
      additive: e.shiftKey,
      moved: false,
    };
    if (!e.shiftKey) setSelectedIds([]);
    setSelectionRect({ x: w.x, y: w.y, w: 0, h: 0 });
  }, []);

  useEffect(() => {
    if (!selectionRect) return;
    const onMove = (e: PointerEvent) => {
      const s = selRectRef.current;
      if (!s) return;
      // 坐标当场取出(原生事件同样不能跨帧留用)
      const p = clientPointOf(e);
      const b = screenToWorld(p.x, p.y);
      if (!s.moved && Math.hypot(p.x - s.sx, p.y - s.sy) > 3) s.moved = true;
      const r = rectFromPoints(s.ax, s.ay, b.x, b.y);
      setSelectionRect(r);
      applyMarquee(s.sx, s.sy, p.x, p.y, s.additive);
    };
    const onUp = (e: PointerEvent) => {
      const s = selRectRef.current;
      selRectRef.current = null;
      setSelectionRect(null);
      // 纯点击空白(未移动):清空选区 —— 原 `onStageClick` 的职责搬到这里,
      // 因为它依赖「此刻 selRectRef 还在」,在 React 的 onClick 里读到时已被置空。
      if (s && !s.moved && !s.additive) {
        const p = clientPointOf(e);
        const w = screenToWorld(p.x, p.y);
        if (nodesInRect(nodesRef.current, { x: w.x, y: w.y, w: 0, h: 0 }).length === 0) {
          setSelectedIds([]);
        }
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [selectionRect, applyMarquee]);

  /** 空白处按下:决定走框选还是平移(中键/空格永远是平移,保底通道) */
  const onStagePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const spacePan = spaceDownRef.current;
      if (e.button === 1 || spacePan) {
        e.preventDefault();
        beginPan(e);
        return;
      }
      if (e.button !== 0) return;
      if (marqueeMode) {
        // 框选期间禁止拖出文本选择,否则会框出一片蓝色高亮
        e.preventDefault();
        beginMarquee(e);
        return;
      }
      /* 默认(框选开关关闭):**拖空白不再平移画布**(2026-10 改)。
         平移改由「触控板双指滑动」承担;左键拖空白保留给未来的框选/套索,
         也避免用户想框选时不小心把画布甩走。需要鼠标平移时有两条保底通道:
         中键拖动 / 空格+拖动(见上方分支)。 */
    },
    [marqueeMode, beginMarquee],
  );

  /* ── 滚轮 / 触控板双指滑动(2026-10 改)──
   * 语义:
   *   · **触控板双指滑动** → 平移画布(与 Figma / 浏览器一致),这是本次改动的核心;
   *   · **Ctrl/⌘ + 滑动** → 缩放 —— Chromium 把触控板「捏合」直接合成成 ctrl+wheel,
   *     所以捏合缩放天然落在这条分支上,不必额外做多指手势;
   *   · **鼠标滚轮** → 缩放 —— 鼠标没有第二根手指,滚轮若不缩放,鼠标用户就再也缩不了了;
   *     StageView 用 `deltaMode !== 0`(行/页模式 = 传统滚轮)把它与触控板的像素滚动区分开。
   *
   * 两条分支都**只写 DOM 不 setState**(P3):触控板滑动是高频连续事件,setState 会逐帧
   * 触发整树 reconcile;拖动期间视口只活在 viewRef/DOM 里,停手后才 commitView 回 state。
   */
  /** 视口落盘防抖定时器(平移/缩放共用) */
  const wheelSyncTimer = useRef<number | null>(null);
  /** 缩放阶段收尾定时器(性能面板归因用;与 wheelSyncTimer 同节奏) */
  const zoomPhaseTimer = useRef<number | null>(null);
  /** 平移阶段收尾定时器(与 wheelSyncTimer / zoomPhaseTimer 同节奏) */
  const panWheelTimer = useRef<number | null>(null);
  /** 最近一次指针屏幕坐标(缩放锚点用;触控板滑动不产生 pointermove,故只能是「最近记录」) */
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const onWheelPan = useCallback(
    (deltaX: number, deltaY: number, zoomable: boolean) => {
      const stage = stageRef.current;
      if (!stage) return;
      cancelViewAnim();

      if (!zoomable) {
        /* 双指滑动 = 平移:偏移量与缩放无关(视口变换是 translate(x,y) scale(z),
           平移量在 scale 之前,故 1px 滑动就是 1px 位移 —— 不要再除以 z)。 */
        perfMonitor.holdPhase('pan');
        if (panWheelTimer.current !== null) window.clearTimeout(panWheelTimer.current);
        panWheelTimer.current = window.setTimeout(() => {
          panWheelTimer.current = null;
          perfMonitor.releasePhase();
        }, 220);
        const v = viewRef.current;
        const { dx, dy } = panOffset(deltaX, deltaY);
        applyViewLive({ ...v, x: v.x + dx, y: v.y + dy });
        if (wheelSyncTimer.current !== null) window.clearTimeout(wheelSyncTimer.current);
        wheelSyncTimer.current = window.setTimeout(() => {
          wheelSyncTimer.current = null;
          commitView({ ...viewRef.current });
        }, 200);
        return;
      }

      /* 缩放分支:滚轮是离散事件流(没有干净的 end),用幂等占位 + 防抖释放,
         不能跟 beginPhase 混用 —— 那个是压栈语义,每次滚轮都 push 会算错 */
      perfMonitor.holdPhase('zoom');
      if (zoomPhaseTimer.current !== null) window.clearTimeout(zoomPhaseTimer.current);
      zoomPhaseTimer.current = window.setTimeout(() => {
        zoomPhaseTimer.current = null;
        perfMonitor.releasePhase();
      }, 220);
      // 指针位置:优先用最近一次 pointermove 记录的光标(触控板滑动不更新光标),
      // 没记录过则回落到舞台中心,避免「以 (0,0) 为锚点缩放」把画布甩飞
      const rect = stage.getBoundingClientRect();
      const last = lastPointerRef.current;
      const mx = last ? last.x - rect.left : rect.width / 2;
      const my = last ? last.y - rect.top : rect.height / 2;
      const v = viewRef.current;
      const factor = zoomFactorFor(deltaY);
      const nz = Math.min(1.3, Math.max(0.4, v.z * factor));
      const k = nz / v.z;
      // 缩放同样只写 DOM —— 滚轮是高频连续事件,setState 会逐帧触发整树 reconcile
      applyViewLive({ z: nz, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k });
      /* 停止滚动后才同步回 state。用 ref 上的定时器而非 state:
         若依赖 viewportAnimating 之类的 state 变化来收尾,又会引入渲染。 */
      if (wheelSyncTimer.current !== null) window.clearTimeout(wheelSyncTimer.current);
      wheelSyncTimer.current = window.setTimeout(() => {
        wheelSyncTimer.current = null;
        commitView({ ...viewRef.current });
      }, 200);
    },
    [applyViewLive, cancelViewAnim, commitView],
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    /* 记录最近一次指针位置(缩放锚点)。用 pointermove 而非 wheel 的 clientX:
       触控板双指滑动不移动光标,wheel 事件的 clientX 会停在旧位置甚至为 0。 */
    const onPointerMove = (e: PointerEvent) => {
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
    };
    /* 兜底:落在弹窗/菜单内的滚轮仍交给它们自己滚动(如「+」弹窗的类型列表)。
       正常情况下弹层的 wheel 已被 stopPropagation 拦在 StageView 之外,
       这里再挡一道,防止以后新增弹层忘了拦。 */
    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('.add-pop, .pop, .ctx, .ap-list, .ap-conn')) return;
      e.preventDefault();
      const zoomable = wheelIntent(e) === 'zoom';
      onWheelPan(e.deltaX, e.deltaY, zoomable);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('pointermove', onPointerMove);
    return () => {
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('pointermove', onPointerMove);
      if (wheelSyncTimer.current !== null) window.clearTimeout(wheelSyncTimer.current);
      if (panWheelTimer.current !== null) window.clearTimeout(panWheelTimer.current);
      if (zoomPhaseTimer.current !== null) window.clearTimeout(zoomPhaseTimer.current);
    };
  }, [onWheelPan]);

  /* ── Agent / 检查器面板宽度 ── */
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

  const setInspWidth = useCallback((w: number, commit: boolean) => {
    const nw = clampInspWidth(w);
    setInspW(nw);
    if (inspGripRef.current) inspGripRef.current.style.left = `${12 + nw - 6}px`;
    if (commit) {
      try {
        localStorage.setItem('bba-insp-w', String(nw));
      } catch {
        /* 忽略存储异常 */
      }
    }
    return nw;
  }, []);

  useEffect(() => {
    let savedAgent = 344;
    let savedInsp = DEFAULT_INSP_W;
    try {
      const rawA = parseInt(localStorage.getItem('bba-agent-w') ?? '', 10);
      if (!Number.isNaN(rawA)) savedAgent = rawA;
      const rawI = parseInt(localStorage.getItem('bba-insp-w') ?? '', 10);
      if (!Number.isNaN(rawI)) savedInsp = rawI;
    } catch {
      /* 忽略存储异常 */
    }
    setAgentWidth(savedAgent, false);
    setInspWidth(savedInsp, false);
    const onResize = () => {
      setAgentWidth(agentWRef.current, false);
      setInspWidth(inspWRef.current, false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [setAgentWidth, setInspWidth]);

  const agentWRef = useRef(agentW);
  agentWRef.current = agentW;
  const inspWRef = useRef(inspW);
  inspWRef.current = inspW;
  const palCollapsedRef = useRef(palCollapsed);
  palCollapsedRef.current = palCollapsed;

  const agentDragRef = useRef<{ sx: number; w: number } | null>(null);
  const inspDragRef = useRef<{ sx: number; w: number } | null>(null);

  /**
   * 把节点平移进「不被检查器/节点面板/Agent 挡住」的安全区。
   * 选中节点、拖宽检查器、展开节点面板后调用。
   */
  const revealNode = useCallback(
    (id: string) => {
      const n = nodesRef.current.find((x) => x.id === id);
      const stage = stageRef.current;
      if (!n || !stage) return;
      const next = ensureWorldBoxVisible({
        box: { x: n.x, y: n.y, w: n.w, h: n.h ?? SEL_UNMEASURED_H },
        view: viewRef.current,
        stage: { w: stage.clientWidth, h: stage.clientHeight },
        insets: {
          left: leftChromeWidth({
            inspOpen: true,
            inspW: inspWRef.current,
            palCollapsed: palCollapsedRef.current,
          }),
          top: PANEL_TOP,
          right: rightChromeWidth(agentWRef.current),
          bottom: PANEL_EDGE,
        },
      });
      if (!next) return;
      animateViewTo(next);
    },
    [animateViewTo],
  );
  revealNodeRef.current = revealNode;

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const ad = agentDragRef.current;
      if (ad) setAgentWidth(ad.w + (ad.sx - e.clientX), false);
      const id = inspDragRef.current;
      if (id) setInspWidth(id.w + (e.clientX - id.sx), false);
    };
    const onUp = () => {
      if (agentDragRef.current) {
        agentDragRef.current = null;
        setAgentWidth(agentWRef.current, true);
        setAgentResizing(false);
        gripRef.current?.classList.remove('on');
      }
      if (inspDragRef.current) {
        inspDragRef.current = null;
        setInspWidth(inspWRef.current, true);
        setInspResizing(false);
        inspGripRef.current?.classList.remove('on');
        // 拖宽后检查器可能盖住选中节点 → 再避让一次
        const sel = selectedIdsRef.current.length === 1 ? selectedIdsRef.current[0]! : null;
        if (sel) revealNodeRef.current(sel);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [setAgentWidth, setInspWidth]);

  /* ── 定位到节点(闪一下) ── */
  const locate = useCallback((id: string) => {
    setFlashId(id);
    window.setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), 1200);
  }, []);

  /* ══ 选择节点 → 检查器 ══ */
  /**
   * 单选(点节点 / 程序化定位):写单选选区。
   *
   * 注意**不做组扩张** —— 点节点只选中它自己(检查器要能看单个节点的参数),
   * 组的整体性体现在拖动/删除/复制这些「批量动作」上(见 beginNodeDrag / deleteSelection)。
   * 想选整组:双击组框或点节点上的组徽标 → selectGroup()。
   * 选中后平移视口,避免左侧检查器遮住该节点。
   */
  const selectNode = useCallback((id: string | null) => {
    setSelectedIds(id ? [id] : []);
    if (!id) return;
    const info = NODE_INFO_BASE[id];
    setInfoMap((m) => {
      if (m[id] || !info) return m;
      return { ...m, [id]: info };
    });
    // rAF:等 insp-open / 面板布局进一帧后再量 stage,避让更准
    requestAnimationFrame(() => revealNodeRef.current?.(id));
  }, []);

  /** 选中整组(点组徽标 / 双击组框 / 右键组操作) */
  const selectGroup = useCallback(
    (groupId: string) => {
      const g = groupsRef.current.find((x) => x.id === groupId);
      if (!g) return;
      setSelectedIds([...g.members]);
    },
    [],
  );

  /**
   * 节点主体按下:启动「拖动整块选区」预备态。
   *
   * 语义(与 Figma 一致):
   *  - 按在**已选中**的节点上 → 拖动整个选区(多选/整组一起走);
   *  - 按在**未选中**的节点上 → 先选中它(Shift = 并入选区,否则替换),再拖动;
   *  - 组内节点:自动扩张为整个组一起拖动。
   */
  const beginNodeDrag = useCallback(
    (node: CanvasNode, e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const additive = e.shiftKey;
      const prevSel = selectedIdsRef.current;
      let nextSel: string[];
      if (additive) {
        const cur = prevSel;
        nextSel = cur.includes(node.id) ? cur.filter((x) => x !== node.id) : [...cur, node.id];
        setSelectedIds(nextSel);
      } else if (prevSel.includes(node.id)) {
        // 已选中:保持选区不变,准备整体拖动
        nextSel = prevSel;
      } else {
        nextSel = [node.id];
        setSelectedIds(nextSel);
      }
      // 新建立的单选 → pointerup 未拖动时做检查器避让(主路径不经 selectNode)
      const revealOnUp =
        !additive &&
        nextSel.length === 1 &&
        (prevSel.length !== 1 || prevSel[0] !== nextSel[0]);
      // 拖动前把选区扩张到整组(组内任一成员参与拖动 = 整组动)
      const dragIds = expandSelectionToGroups(groupsRef.current, nextSel);
      if (additive) {
        // Shift 加选/减选时不启动拖动,避免「想多选却把节点拖走」
        return;
      }
      const origins = new Map<string, { x: number; y: number }>();
      for (const n of nodesRef.current) {
        if (dragIds.includes(n.id)) origins.set(n.id, { x: n.x, y: n.y });
      }
      dragRef.current = {
        ids: dragIds,
        sx: e.clientX,
        sy: e.clientY,
        origins,
        moved: false,
        revealOnUp,
      };
      dragPrevRef.current = { nodes: nodesRef.current, edges: edgesRef.current };
      // 挂 dragging 类(合成层提升);即使未真正移动也会在 pointerup 清空
      setDraggingIds(dragIds);
      perfMonitor.beginPhase('drag-node');
      e.stopPropagation();
    },
    [],
  );

  /** 组操作:建组(把当前选区收成一个组) */
  const groupSelection = useCallback(() => {
    const members = selectedIdsRef.current;
    if (members.length < 2) {
      toastMsg('至少选中 2 个节点才能建组');
      return;
    }
    const { groups: next, group } = createGroup(groupsRef.current, members);
    setGroups(next);
    commitEdit('建组');
    toastMsg(`已建「${group.name}」· ${members.length} 个节点`);
  }, [commitEdit, toastMsg]);

  /** 组操作:解组(选中恰好等于整组时可用) */
  const ungroupSelection = useCallback(() => {
    const g = selectionIsWholeGroup(groupsRef.current, selectedIdsRef.current);
    if (!g) {
      toastMsg('请先选中整个组');
      return;
    }
    setGroups(dissolveGroups(groupsRef.current, [g.id]));
    commitEdit('解组');
    toastMsg(`已解组「${g.name}」· 节点保留`);
  }, [commitEdit, toastMsg]);

  /** 当前选区是否恰好是一个完整组(工具栏「解组」可用态) */
  const wholeGroupOfSelection = useMemo(
    () => selectionIsWholeGroup(groups, selectedIds),
    [groups, selectedIds],
  );

  /* 当前活动画布 id(派生自 props) */
  const activeCanvasId = projectCanvases?.activeCanvasId ?? '';
  const activeCanvas = projectCanvases?.canvases.find((c) => c.id === activeCanvasId);

  /** 构建当前画布快照(节点+边+视口+分组)——给保存/切换前 flush-save 用;可传覆盖(自愈回写)
   *  ⚠️ 节点/边/版本必须读 ref 而非闭包 state(2026-10-08 「删除的节点复活」事故):
   *  本函数会被 800ms 内容防抖、400ms 视口防抖、卸载 flush 等**延迟/并发**调用,
   *  闭包捕获的是「调度那一刻」的旧 nodes/edges/knownVersion —— 延迟保存把删除前的旧内容
   *  写回 store(等版本可通过防护、后到者赢),写盘广播再把旧快照推回本地 ⇒
   *  已删节点+连线复活、提示词回滚丢失。groups/viewport 早已走 ref(见下),这里对齐同口径。 */
  const buildActiveSnapshot = useCallback(
    (ns?: CanvasNode[], es?: Edge[]): CanvasSnapshot | null => {
      if (!activeCanvas) return null;
      return {
        id: activeCanvas.id,
        projectId: activeCanvas.projectId,
        name: activeCanvas.name,
        nodes: toSharedNodes(ns ?? nodesRef.current) as never,
        edges: toSharedEdges(es ?? edgesRef.current) as never,
        // 分组:随快照持久化(取 ref,保证建组/解组后立刻写盘,不等下一次渲染)
        groups: groupsRef.current.map((g) => ({ ...g, members: [...g.members] })),
        // 用已知版本(随推送/刷新前进,取 ref 防延迟调用持旧版本),保证不落后于 store
        // —— 落后会导致 saveCanvasSnapshot 版本防护拒绝覆盖
        version: knownVersionRef.current || activeCanvas.version,
        // 画布视口:退出/重进恢复上次看到的位置与缩放(取 ref,保证拖拽/滚轮进行中也写最新值)
        viewport: { ...viewRef.current },
        createdAt: activeCanvas.createdAt,
        updatedAt: new Date().toISOString(),
      };
    },
    // 内容/版本全部走 ref,依赖只需 activeCanvas —— 不再随 nodes/edges 每次编辑重建闭包
    [activeCanvas],
  );

  /** 最近一次确认与 store 一致的内容基线(JSON)—— 卸载/防抖保存前比对,无变化不写盘。
   *  防止「version 对齐但内容为空/旧」的崩溃/重挂场景覆盖 store(与主进程版本防护双保险)。 */
  const lastSavedRef = useRef('');
  /** 最近一次落盘的视口(内容没变但视口变了也要写盘,见 maybePersist) */
  const lastViewRef = useRef<{ x: number; y: number; z: number } | null>(null);
  /** 标记内容基线为「与 store 一致」(加载/推送/保存成功后调用)。
   *  含 groups —— 只比对 nodes/edges 的话,「仅改分组」会被判成无变化而不写盘。
   *  用 contentKey 归一化瞬态 UI 字段(badge/running/progress…),否则「生成中文案变化」
   *  会被当成内容改动而反复写盘,写盘广播又把 store 的旧节点推回来抹掉标签。 */
  const markBaseline = useCallback(
    (ns: CanvasNode[], es: Edge[], gs?: NodeGroup[]) => {
      lastSavedRef.current = contentKey(ns, es, gs ?? groupsRef.current);
    },
    [],
  );
  /** 保存当前快照:内容相对基线有真实变化才写盘;写盘后把基线推进到已保存内容。
   *  opts.allowEmpty = true 仅 auto-save 使用(用户清空画布是合法编辑);
   *  卸载/切画布 flush 默认禁止空快照覆盖 —— 崩溃时内存 state 可能为空,不得覆盖 store 有内容的画布。 */
  const maybePersist = useCallback(
    (snap: CanvasSnapshot | null, opts?: { allowEmpty?: boolean }) => {
      if (!snap) return;
      const local = contentKey(snap.nodes as unknown as CanvasNode[], snap.edges as unknown as Edge[], snap.groups ?? []);
      // 🛡️ 防「空快照覆盖有内容画布」:本地内存为空,但 store 里这份画布有节点时一律不写盘。
      // 事故背景(2026-09-22):启动瞬间/切画布时若 nodes 尚未装填,一次 flush 就会把有内容的画布写成空,
      // 而基线比对只看「本地内容是否变过」,挡不住「本地是空、基线也是空」的首次写盘。
      // 🛡️ 防「空快照覆盖有内容画布」:本地内存为空,但 store 里这份画布有节点时一律不写盘。
      // 事故背景(2026-09-22):启动瞬间/切画布时若 nodes 尚未装填,一次 flush 就会把有内容的画布写成空,
      // 而基线比对只看「本地内容是否变过」,挡不住「本地是空、基线也是空」的首次写盘。
      // ⚠️ 2026-10-11「美女项目画布全空」事故:判空只看 nodes —— 「0 节点 + 1 悬空边」是坏快照
      // (边引用的节点不存在),旧判定要求 nodes 与 edges 同时为空,把它放行了(store 侧同口径收紧)。
      const localEmpty = (snap.nodes?.length ?? 0) === 0;
      const storeHasNodes = (activeCanvas?.nodes?.length ?? 0) > 0;
      // 空快照闸:用户删掉最后一个节点是**合法编辑**,必须能落盘(否则节点被广播推回来 = 删不掉)。
      // 但只对「已装填这张画布 + 调用方声明 allowEmpty」放行,未装填 flush 继续拦(2026-09-22 事故)。
      if (
        shouldBlockEmptySave({
          localEmpty,
          localEdges: snap.edges?.length ?? 0,
          storeHasNodes,
          allowEmpty: !!opts?.allowEmpty,
          hydrated: hydratedCanvasRef.current === activeCanvas?.id,
          userCleared: userClearedRef.current,
        })
      ) {
        // 留痕必须带调用栈:这两类快照一旦出现,说明上游有个「把 nodes 清空但留着 edges」的窗口,
        // 光拒绝只能保住数据,指认不出是谁(2026-10-20 两个画布被抹空就是这么丢的溯源机会)。
        console.error(
          `[canvas] 拒绝落盘可疑快照:${localEmpty ? '0 节点' : `${snap.nodes?.length} 节点`}/${snap.edges?.length ?? 0} 边 · ` +
            `store ${activeCanvas?.nodes?.length ?? 0} 节点 · userCleared=${userClearedRef.current}`,
          new Error('empty-save-guard').stack,
        );
        // 屏幕内容与 store 不一致(本地空 / 有悬空边)→ 立刻用真值自愈,而不是让用户盯着空画布
        if (localEmpty) refreshFromStoreRef.current();
        return;
      }
      if (local === lastSavedRef.current) {
        // 内容没变:视口(平移/缩放)变了也要落盘,否则重进画布会回到上次内容改动时的位置
        const last = lastViewRef.current;
        const vp = snap.viewport;
        if (vp && last && last.x === vp.x && last.y === vp.y && last.z === vp.z) return;
        lastViewRef.current = vp ? { ...vp } : last;
        void onSaveCanvas(snap, { allowEmpty: !!opts?.allowEmpty });
        return;
      }

      lastSavedRef.current = local;
      lastViewRef.current = snap.viewport ? { ...snap.viewport } : lastViewRef.current;
      void onSaveCanvas(snap, { allowEmpty: !!opts?.allowEmpty });
    },
    [onSaveCanvas, activeCanvas],
  );

  /** 切换画布前先 flush 当前画布的未保存改动(含视口) */
  const flushSaveNow = useCallback(() => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (viewTimer.current) {
      window.clearTimeout(viewTimer.current);
      viewTimer.current = null;
    }
    maybePersist(buildActiveSnapshot(), { allowEmpty: true });
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

  /** 删除画布:取消待写盘定时器且**不 flush**(flush 会把已删 id 写回并复活) */
  const deleteCanvasSafe = useCallback(
    async (canvasId: string): Promise<string | null> => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      if (viewTimer.current) {
        window.clearTimeout(viewTimer.current);
        viewTimer.current = null;
      }
      return onDeleteCanvas(canvasId);
    },
    [onDeleteCanvas],
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
    if (viewTimer.current) {
      window.clearTimeout(viewTimer.current);
      viewTimer.current = null;
    }
    maybePersist(buildActiveSnapshot(), { allowEmpty: true });
  };
  useEffect(() => () => saveFlushRef.current(), []);

  /* 挂载 / 切换画布 / 项目切换 / 画布列表就绪:把 active 快照装进本地 nodes/edges
     依赖带上 projectCanvases:若进入画布时列表尚未就绪(early return),就绪后补加载,
     避免停留在空画布/演示数据上。 */
  useEffect(() => {
    if (!projectCanvases || !activeCanvas) return;
    bootRef.current = true;
    hydratedCanvasRef.current = activeCanvas.id;
    userClearedRef.current = false;
    setKnownVersion(activeCanvas.version ?? 0);
    // 自愈:历史上可能存了重复 id 的节点(两个 pal1 之类)——重号会导致重合、拖拽分不开。
    // 这里自动改 id + 错开坐标 + 修连线;有改写就先落盘,保证旧数据也能恢复。
    const loaded = activeCanvas.nodes.map((n) => fromSharedNode(n as never));
    // 快照还原不带实测高度 h(纯 UI 测量值):按 id 合回当前已测值,
    // 否则连线端点退回兜底高度(跳到节点顶部)且 RO 不重测(2026-10 事故修复)
    const selfHeal = dedupeNodeIds(preserveMeasuredSize(loaded, nodesRef.current), toLocalEdges(activeCanvas.edges as never));
    setNodes(selfHeal.nodes);
    setEdges(selfHeal.edges);
    // 分组:旧项目文件无 groups → 空数组;脏 id/空组在这里一次性规整
    const loadedGroups = normalizeGroups(activeCanvas.groups, selfHeal.nodes.map((n) => n.id));
    setGroups(loadedGroups);
    markBaseline(selfHeal.nodes, selfHeal.edges, loadedGroups);
    // 画布视口:恢复上次退出时的平移/缩放(旧项目文件无 viewport → 默认视图)
    const restored = normalizeView(activeCanvas.viewport);
    commitView(restored);
    lastViewRef.current = { ...restored };
    // 换画布 = 换编辑对象:清空撤销/重做历史并重建基线
    historyRef.current.clear();
    historyRef.current.reset({ nodes: selfHeal.nodes, edges: selfHeal.edges, groups: loadedGroups });
    setHistVer((v) => v + 1);
    if (selfHeal.changed) {
      const repaired = buildActiveSnapshot(selfHeal.nodes, selfHeal.edges);
      if (repaired) void onSaveCanvas(repaired);
    }
    nextId.current = seedIdCounter(selfHeal.nodes);
    setSelectedIds([]);
    setFocusNodes([]); // 换画布 = 换编辑对象:聊天关注节点属于上一张画布,一并解除
    setFlashId(null);
    requestAnimationFrame(() => {
      bootRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCanvasId, projectId, projectCanvases]);

  /** 物化 sessionStorage 里的 Agent 规划(从首页跳到画布时;支持新模式分镜表与旧模式 Brief 两种结构)。
   *  首页「生成」先跳转后异步规划:挂载时先消费一次(已就绪的情况),再监听 bba-plan-ready 事件(后就绪的情况) */
  useEffect(() => {
    const consumePlan = () => {
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
          setSelectedIds([shotNodes[0]?.id ?? sbNode.id]);
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
          setSelectedIds([shotNodes[0]?.id ?? docNode.id]);
          chat.pushMsg({ kind: 'agent', odId: 'agent-plan', plan: plan as never });
        }
      } catch (e) {
        console.error('规划落地失败', e);
      }
    };
    consumePlan();
    window.addEventListener('bba-plan-ready', consumePlan);
    return () => window.removeEventListener('bba-plan-ready', consumePlan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 首页「生成」带入的对话:把首页 brief(含附件)作为画布 Agent 的首条消息自动发送,
   *  附件经 agent-chat 流程拷入项目文件夹并登记为项目资源(与手动发送同链路)。
   *  同样「挂载消费一次 + bba-newchat-ready 事件」双通道,覆盖先跳转后播种的时序 */
  useEffect(() => {
    const consumeSeed = () => {
      const raw = sessionStorage.getItem('bba.newChat');
      if (!raw) return;
      sessionStorage.removeItem('bba.newChat');
      try {
        const seed = JSON.parse(raw) as { text?: string; attachments?: Asset[] };
        if (seed.text) chat.send(seed.text, seed.attachments ?? []);
      } catch (e) {
        console.error('播种首页对话失败', e);
      }
    };
    consumeSeed();
    window.addEventListener('bba-newchat-ready', consumeSeed);
    return () => window.removeEventListener('bba-newchat-ready', consumeSeed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 资产清单 + 分类字典(挂载/切项目时拉取;Agent 对话中注册的新附件由快照推送触发刷新)。
   *  assetCache 已改为从 assetsList 派生(见其声明处),这里只需写 state。 */
  const refreshAssets = useCallback(async () => {
    try {
      const [list, cats] = await Promise.all([
        window.bigbotart.listAssets(),
        window.bigbotart.listAssetCategories(),
      ]);
      setAssetsList(list);
      setCategories(cats);
    } catch {
      /* 资产可为空 */
    }
  }, []);

  useEffect(() => {
    /* 切项目瞬间先清空清单:否则在新项目数据返回前,画布会用**上一个项目的资产**
       去解析 asset 节点与检查器输入图,表现为「刚打开项目时图是错的/空的,过一会自己好了」。
       清空是同步的、且必然触发一次重渲染,不会把旧数据留在屏上。 */
    setAssetsList([]);
    setCategories([]);
    void refreshAssets();
  }, [projectId, refreshAssets]);

  /** assetId → 展示元信息(asset 节点渲染:缩略图/分类/媒体) */
  const assetMeta = useMemo(() => {
    const m: Record<string, { name: string; kind: string; categoryName?: string; src: string | null }> = {};
    for (const a of assetsList) {
      const cat = categories.find((c) => c.id === a.categoryId);
      m[a.id] = {
        name: a.name,
        kind: a.kind,
        categoryName: cat?.name,
        // 视频资产要给 <video> 能播的 URL(封面/playsInline 预览都用它);
        // 旧实现一律 thumbSrc → 视频资产恒为 null,<VideoThumb src=""> 只能渲染出一个空框
        src: (a.kind === 'video' ? previewUrlOf(a.localPath) : thumbSrc(a.localPath)) ?? null,
      };
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

  /** 换绑资产到节点:更新 assetId + mediaType 锁定为资产 kind;节点标题跟资产名 */
  const bindAssetToNode = useCallback(
    (nodeId: string, asset: Asset) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                title: asset.name || n.title,
                data: { ...(n.data ?? {}), assetId: asset.id, mediaType: asset.kind },
              }
            : n,
        ),
      );
      commitEdit('更换绑定资产');
      toastMsg(`已更换为「${asset.name}」 · 下游绑定同步更新`);
      setAssetPickFor(null);
    },
    [setNodes, toastMsg, commitEdit],
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
      // 同挂载加载:合并已测高度 h,防连线端点跳节点顶部(见 preserveMeasuredSize)
      const selfHeal = dedupeNodeIds(preserveMeasuredSize(loaded, nodesRef.current), toLocalEdges(cur.edges as never[]));
      setNodes(selfHeal.nodes);
      setEdges(selfHeal.edges);
      const nextGroups = normalizeGroups(cur.groups, selfHeal.nodes.map((n) => n.id));
      setGroups(nextGroups);
      markBaseline(selfHeal.nodes, selfHeal.edges, nextGroups);
      // Agent 工具改了画布:换基线并清空历史(历史坐标已不可用,撤销会与 Agent 改动打架)
      historyRef.current.clear();
      historyRef.current.reset({ nodes: selfHeal.nodes, edges: selfHeal.edges, groups: nextGroups });
      setHistVer((v) => v + 1);
      if (selfHeal.changed) {
        const repaired = buildActiveSnapshot(selfHeal.nodes, selfHeal.edges);
        if (repaired) void onSaveCanvas(repaired);
      }
      nextId.current = seedIdCounter(selfHeal.nodes);
    } catch (e) {
      console.error('刷新画布失败', e);
    }
  }, [projectId, activeCanvasId]);

  refreshFromStoreRef.current = () => {
    void refreshCanvasFromStore();
  };

  /** 画布内容同步(推送的快照或 store 拉取结果)→ 本地 nodes/edges + knownVersion。
   *  内容与版本都没变化时跳过 setState——推送可能来自渲染层自身的保存,重设会触发
   *  auto-save 依赖的 effect 再保存,造成 version 无限增长的写盘循环。 */
  const applyCanvasSnapshot = useCallback((cur: Pick<CanvasSnapshot, 'nodes' | 'edges' | 'version'> & { viewport?: CanvasSnapshot['viewport']; groups?: CanvasSnapshot['groups'] }) => {
    const loaded = cur.nodes.map((n) => fromSharedNode(n as never));
    // 合并已测高度 h:快照推送整批替换节点时 h 会丢,连线端点跳到节点顶部(2026-10 事故修复)
    const selfHeal = dedupeNodeIds(preserveMeasuredSize(loaded, nodesRef.current), toLocalEdges(cur.edges as never[]));
    const version = cur.version ?? 0;
    // 分组:按**自愈后的**节点 id 规整(剔除已删节点/空组/重复归属)
    const nextGroups = normalizeGroups(cur.groups, selfHeal.nodes.map((n) => n.id));
    /* ⚠️ 比对必须走 contentKey 归一化(2026-09-29 修复):此前用裸 JSON.stringify,
       而本地节点带 badge/running/extra 等**不进快照**的瞬态字段,快照还原出的节点没有它们
       → 每次推送都判「内容变了」→ setNodes 整体替换 → 把刚写入的 data.resultPath 一并回退
       (表现为「生成成功但节点不显示产物」)。与 markBaseline / maybePersist 同口径。 */
    const sameContent =
      contentKey(selfHeal.nodes as unknown as CanvasNode[], selfHeal.edges as unknown as Edge[], nextGroups) ===
      contentKey(nodesRef.current, edgesRef.current, groupsRef.current);
    // 内容确实变了(外部写入:Agent 工具 / 另一个窗口):连视口一起同步,
    // 并换历史基线 —— 历史里的节点引用已失效,撤销会回到与 store 不一致的旧内容
    if (!sameContent && cur.viewport) {
      const v = normalizeView(cur.viewport);
      commitView(v);
      lastViewRef.current = { ...v };
    }
    if (sameContent) {
      // 内容没变:只前进 knownVersion(不 setNodes → 不触发 auto-save 再保存 → 避免 version 循环写盘)
      knownVersionRef.current = version;
      setKnownVersion(version);
      markBaseline(selfHeal.nodes, selfHeal.edges, nextGroups);
      return selfHeal;
    }
    // 选区:剔除已不存在的节点(Agent 删了节点后本地选区不能残留脏 id)
    setSelectedIds((sel) => {
      const live = new Set(selfHeal.nodes.map((n) => n.id));
      const next = sel.filter((id) => live.has(id));
      return next.length === sel.length ? sel : next;
    });
    setKnownVersion(version);
    setNodes(selfHeal.nodes);
    setEdges(selfHeal.edges);
    setGroups(nextGroups);
    // 快照推送分两种:
    // ① 我方 auto-save 的回推(内容 == 刚保存的 lastSavedRef)→ 不能清历史!
    //    否则「新建节点 → 800ms 后自动保存 → 回推清空历史 → 撤销永远置灰」(2026-09-22 实测事故)
    // ② 外部写入(Agent 工具 / 另一窗口)→ 历史里的节点引用已失效,换基线清历史,
    //    避免撤销回到与 store 不一致的旧内容
    const isOwnSave =
      contentKey(
        selfHeal.nodes as unknown as CanvasNode[],
        selfHeal.edges as unknown as Edge[],
        nextGroups,
      ) === lastSavedRef.current;
    if (!isOwnSave) {
      historyRef.current.clear();
      historyRef.current.reset({ nodes: selfHeal.nodes, edges: selfHeal.edges, groups: nextGroups });
      setHistVer((v) => v + 1);
    }
    markBaseline(selfHeal.nodes, selfHeal.edges, nextGroups);
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
      // Agent 对话中可能刚注册了新附件资产(参考图等),刷新资产缓存,
      // 否则 asset 节点显示「资产未加载」占位(真实事故:Agent 建了参考图节点但缩略图空白)
      void refreshAssets();
    });
    return off;
  }, [projectId, activeCanvasId, applyCanvasSnapshot, refreshAssets]);

  /* Agent 对话面板:状态/副作用全部收敛到 useAgentChat(pages/agent/),这里只接线 */
  /* 聊天关注节点列表经 focusNodesRef 注入(随对话请求带走,让 Agent 感知用户指定的操作对象;
     与画布选中态解耦:右键「添加到聊天窗口」累积设定 + 输入框 @ 提及,点按选中不再注入) */
  /* ⚠️ 必须 useCallback 稳定引用:useAgentChat 里订阅 agent-event 的 effect 依赖它,
     内联箭头每次渲染都换新引用 → effect 反复清理重订;dev StrictMode 双挂载下会出现
     同一事件被两个监听器各收一次,导致收尾卡重复(真实事故:识别提示词显示 2 次)。 */
  const handleCanvasMutated = useCallback(() => {
    void refreshCanvasFromStore();
  }, [refreshCanvasFromStore]);
  const chat = useAgentChat({
    projectId,
    canvasId: activeCanvasId,
    onCanvasMutated: handleCanvasMutated,
    toastMsg,
    focusNodesRef,
  });

  /* 视口自动持久化(防抖 400ms):平移/缩放停止后把 viewport 写回快照 ——
     与内容保存同一个函数,内容没变时只在视口变化时写盘(见 maybePersist)。
     切画布/离开页面由 flushSaveNow / 卸载 flush 兜底,所以这里不需要更短的延迟。 */
  useEffect(() => {
    if (bootRef.current || !projectId || !activeCanvas) return;
    if (viewTimer.current) window.clearTimeout(viewTimer.current);
    viewTimer.current = window.setTimeout(() => {
      maybePersist(buildActiveSnapshot(), { allowEmpty: true });
    }, 400);
    return () => {
      if (viewTimer.current) window.clearTimeout(viewTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.x, view.y, view.z, projectId, activeCanvasId]);

  /* 画布内容自动持久化(防抖 800ms;只在 active canvas 有内容时写) */
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

  /* 产物回填:nodeId → 最新成功 Take resultPath(画布加载 + 任务完成后刷新)
     (历史 Take 只在 takes json,节点 data 可能缺 resultPath → 渲染时两层回退)
     ⚠️ 2026-10 起**覆盖全部产物类节点**(此前只查 shot):一次 `takesList` 单次 IPC,
     比逐节点 takesHistory 更省;video-upscale / 图片类节点的产物同样有兜底
     (真实事故:new1-gta1 视频增强跑 82 分钟,用户中途离开画布页 → 节点 data 回写落空,
      磁盘上有产物、Take 里 resultPath 完整,节点卡与检查器却什么都不显示)。 */
  const [takeResults, setTakeResults] = useState<Record<string, string>>({});
  const refreshTakeResults = useCallback(async () => {
    if (!projectId) return;
    try {
      const list = await window.bigbotart.takesList(projectId);
      setTakeResults(latestTakeResultByNode(list));
    } catch {
      /* 拉取失败保持旧值(不静默清空,否则节点上的产物会「闪一下又没了」) */
    }
  }, [projectId]);

  /** 聊天工具卡的产物媒体解析:节点 → 可显示媒体(bba-output/bba-asset)。
   *  解析在渲染期进行(读 nodesRef + takeResults):提交成功那一刻产物可能还没跑完,
   *  队列完成后 takeResults/nodes 更新,工具卡随重渲染自动补上媒体。 */
  const resolveChatMedia = useCallback(
    (nodeId: string): { url: string; kind: 'image' | 'video' | 'audio' } | null => {
      const n = nodesRef.current.find((x) => x.id === nodeId);
      if (!n) return null;
      const d = (n.data ?? {}) as Record<string, unknown>;
      let p = typeof d.resultPath === 'string' && d.resultPath ? d.resultPath : undefined;
      // asset 节点:绑定资产的本地文件(与 revealNodeInFinder 同口径)
      if (!p && n.kind === 'asset') {
        const assetId = typeof d.assetId === 'string' ? d.assetId : '';
        if (assetId) p = assetCache[assetId];
      }
      // Take 回填兜底(节点 data 缺 resultPath 时,如 Agent 提交的产物)
      if (!p) p = takeResults[nodeId];
      if (!p) return null;
      const url = previewUrlOf(p);
      if (!url) return null;
      return { url, kind: isVideoPath(p) ? 'video' : isAudioPath(p) ? 'audio' : 'image' };
    },
    [assetCache, takeResults],
  );

  /** 重生成某节点 ⇒ 全部下游生成节点标 stale(依赖过期;接力跑完逐个刷新,成功即清) */
  const markDownstreamStale = useCallback((nodeId: string) => {
    const affected = allDownstreamGenIds([nodeId], nodesRef.current, edgesRef.current);
    if (affected.length === 0) return;
    setNodes((ns) => ns.map((x) => (affected.includes(x.id) ? { ...x, stale: true } : x)));
  }, []);
  useEffect(() => {
    void refreshTakeResults();
  }, [refreshTakeResults]);

  /* ── timeline 成片路径愈合(2026-10)──
     背景:「timeline 作为视频源」接线前的旧数据里,timeline 节点只有 lastExport(展示用
     bba-output:// URL),没有 resultPath(下游视频解析的统一读取点)——于是「时间线成片 →
     视频增强/取帧」的连线建得出来,运行却报「需要输入视频」(真实反馈:new1-gta1)。
     这里扫一遍:缺 resultPath 但有 lastExport.name 的 timeline 节点,按文件名向主进程解析
     导出目录内的绝对路径并回写 —— 愈合一次,之后 dispatch / runNode / Agent 全部走通。
     防重入:healTriedRef 按 id:name 记录(重新导出了新文件名会再试一次)。 */
  const healTriedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const pending = nodes.filter((n) => {
      if (n.kind !== 'timeline') return false;
      const d = (n.data ?? {}) as Partial<TimelineData>;
      const name = d.lastExport?.name;
      return !d.resultPath && !!name && !healTriedRef.current.has(`${n.id}:${name}`);
    });
    if (pending.length === 0) return;
    for (const n of pending) {
      const name = ((n.data ?? {}) as Partial<TimelineData>).lastExport?.name ?? '';
      healTriedRef.current.add(`${n.id}:${name}`);
    }
    void (async () => {
      const fixes: Array<{ id: string; path: string }> = [];
      for (const n of pending) {
        const name = ((n.data ?? {}) as Partial<TimelineData>).lastExport?.name;
        if (!name) continue;
        try {
          const r = await window.bigbotart.exportFilePath({ name });
          if (r.ok && r.path) fixes.push({ id: n.id, path: r.path });
        } catch {
          /* 单个失败不影响其它;文件名对不上就不愈合(下次导出会正规回写) */
        }
      }
      if (fixes.length === 0) return;
      setNodes((ns) =>
        ns.map((x) => {
          const f = fixes.find((y) => y.id === x.id);
          return f ? { ...x, data: { ...(x.data ?? {}), resultPath: f.path } } : x;
        }),
      );
    })();
  }, [nodes, setNodes]);

  /* ── Take 产物愈合(2026-10)──
     背景:产物类节点(shot / video-upscale / 图片类)的 `data.resultPath` 由**任务完成时
     渲染层 setNodes 回写**,而长任务期间离开画布页会让这次回写落在已卸载组件上被丢弃
     (Take 已在主进程落盘:磁盘有产物、Take 里 resultPath 完整,节点 data 却为空)。
     真实事故:飞机1 · new1-gta1 视频增强跑了 82 分钟(22:54→00:16),节点卡与检查器
     都不显示增强结果 —— 用户视角就是「视频不显示」。

     愈合口径与检查器 useTakeResult **完全一致**(最新 succeeded + 有 resultPath),
     只是把结果**持久化回节点 data**:愈合一次之后,下游(runNode 的 upstreamVideoPath /
     Agent 的 resolveNodeVideoPath / 时间线导出 / 项目封面)全部按 resultPath 走通。
     防重入:同一个「节点:路径」只补一次;节点若真没有 Take 就不写(等下轮生成正规回写)。 */
  const healTakeTriedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fixes: Array<{ id: string; path: string }> = [];
    for (const n of nodes) {
      const d = (n.data ?? {}) as Record<string, unknown>;
      if (typeof d.resultPath === 'string' && d.resultPath) continue;
      const p = takeResults[n.id];
      if (!p) continue;
      const key = `${n.id}:${p}`;
      if (healTakeTriedRef.current.has(key)) continue;
      healTakeTriedRef.current.add(key);
      fixes.push({ id: n.id, path: p });
    }
    if (fixes.length === 0) return;
    setNodes((ns) =>
      ns.map((x) => {
        const f = fixes.find((y) => y.id === x.id);
        return f ? { ...x, data: { ...(x.data ?? {}), resultPath: f.path } } : x;
      }),
    );
  }, [nodes, takeResults, setNodes]);

  /* 视频增强进度订阅:分钟级长任务(video-upscale)期间把主进程阶段/帧号写进节点 badge。
     没有这个订阅时,`videoUpscale` 的 invoke 会一直阻塞且界面毫无反馈 —— 看起来像「瞬间完成/没启动」。 */
  useEffect(() => {
    // ⚠️ 挂载时先从**主进程**恢复运行态:本地 state 会在退出画布时丢失,
    //    若只靠本地标记,重进画布后就能对**正在跑**的节点重复发起(真实反馈)。
    //    (长任务分钟级,用户极易在跑的时候切走再切回)
    void (async () => {
      try {
        const runs = await window.bigbotart.videoPostRunning();
        if (runs.length > 0) {
          videoPostRunningRef.current = new Set(runs.map((r) => r.nodeId));
          setVideoPostRunning(runs.map((r) => r.nodeId));
          videoPostRef.current = runs[runs.length - 1]!.nodeId;
          // 进度文案也一并恢复(否则重进时进度条是空的,只有个灰按钮)
          const last = await window.bigbotart.videoPostLastProgress();
          if (last?.nodeId) {
            setNodes((ns) =>
              ns.map((n) =>
                n.id === last.nodeId
                  ? {
                      ...n,
                      badge: undefined,
                      progress: {
                        pct: undefined,
                        text: last.detail ? `${last.stageLabel} · ${last.detail}` : last.stageLabel,
                        indet: true,
                      },
                      ghost: false,
                    }
                  : n,
              ),
            );
          }
        }
      } catch {
        /* 主进程不可用/未实现:退回本地态(不影响正常流程) */
      }
    })();
    const unsub = window.bigbotart.onVideoPostProgress((p) => {
      // 只处理当前正在跑的那个节点(全局后处理任务串行,同一时刻至多一个)
      if (!p?.stageLabel) return;
      const target = p.nodeId || videoPostRef.current;
      if (!target) return;
      // 进度条用**整体百分比**(跨阶段单调递增);阶段内部无细分时 pct 用小节标表示
      const text = p.detail ? `${p.stageLabel} · ${p.detail}` : p.stageLabel;
      setNodes((ns) =>
        ns.map((n) =>
          n.id === target
            ? {
                ...n,
                badge: undefined,
                progress: {
                  pct: p.overall,
                  text,
                  stage: `${p.stagesDone + 1}/${p.stagesTotal}`,
                  indet: p.stageProgress === undefined,
                },
                ghost: false,
              }
            : n,
        ),
      );
    });
    return unsub;
  }, [setNodes]);

  /* 渲染队列订阅:主进程变更推送(节流合并)+ 8s 兜底轮询(事件丢包/窗口重载恢复);
     无实质变化(签名相同)时跳过 setJobs,避免 1.2s 全量轮询带来的无谓整树重渲染。
     ⚠️ 队列是「进行中」状态的唯一真源:节点的排队/生成中标签**必须**在这里按队列回填,
     否则下方快照写盘推送(store 里没有 badge 这种 UI 瞬态字段)会把标签整体抹掉 →
     用户看到「明明在生成,节点上没状态」。 */
  useEffect(() => {
    let alive = true;
    let lastSig = '';
    const apply = async (list: RenderJob[]) => {
      /* 进行中标签回填(先于签名去重):queued/running 的节点一定带队列文案。
         - queued:文案含队列位次(多任务 FIFO 时要让用户看见「还没轮到我」)
         - running:优先用引擎上报的 stage,否则回退默认文案
         仅当文案真的变了才写 nodes,避免每轮 setNodes 触发整树重渲染。 */
      const busyLabel = (j: RenderJob): string | null => {
        if (j.status === 'queued') {
          const queued = list
            .filter((x) => x.status === 'queued')
            .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
          const pos = queued.findIndex((x) => x.id === j.id) + 1;
          return pos > 0 && queued.length > 1 ? `排队中 · 第 ${pos} 位` : '已入队 · 等待槽位…';
        }
        if (j.status === 'running') return j.stage ?? (j.slot === 'video' ? '生成中…' : '采样中…');
        return null;
      };
      const busyById = new Map<string, string>();
      for (const j of list) {
        const label = busyLabel(j);
        if (j.nodeId && label) busyById.set(j.nodeId, label);
      }
      setNodes((ns) => {
        let changed = false;
        const next = ns.map((n) => {
          const want = busyById.get(n.id);
          if (want === undefined) {
            // 队列里查不到 = 任务已结束(终态由下面的状态迁移分支处理);清掉运行期标签,
            // 但保留提交/裁切等失败文案(不由队列派生,只在下次提交时覆盖)
            if (n.badge && (n.running || n.badge.startsWith('已入队') || n.badge.startsWith('排队中'))) {
              changed = true;
              return { ...n, badge: undefined, running: false };
            }
            return n;
          }
          if (n.badge === want && n.running) return n;
          changed = true;
          return { ...n, badge: want, running: true };
        });
        return changed ? next : ns;
      });
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
                    running: false,
                    extra: j.resultPath ? `✓ ${basenameOf(j.resultPath)}` : '✓ 生成完成',
                    // 产物路径存进节点 data(节点卡/检查器渲染视频用)
                    // + currentTakeId 绑定本次 Take:检查器的 attempt 列表 / Take 切换 / 时间线导出
                    //   全靠它定位「当前生效的是哪一条」(2026-09-28:Agent 提交的任务此前只落
                    //   resultPath 不落 currentTakeId,历史里那一栏永远是空的)
                    data: {
                      ...(n.data ?? {}),
                      resultPath: j.resultPath ?? (n.data as Record<string, unknown>)?.resultPath,
                      ...(j.takeId ? { currentTakeId: j.takeId } : {}),
                    },
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
          // 接力:只认「在途 → 成功」的真实迁移。进画布/回首页再进会重挂本组件,
          // prevJobState 清空后首次 poll 会把历史 succeeded 当成刚完成 —— 若不拦,
          // 下游无产物镜头会被自动入队(2026-10-22 猫侠传:点开项目就开跑视频)。
          if (shouldKickCascade(prev, j.status)) {
            cascadeKickRef.current?.(j.nodeId, list, freshTail);
          }
        } else if (j.status === 'failed') {
          setNodes((ns) => ns.map((n) => (n.id === j.nodeId ? { ...n, badge: `失败 · ${j.error ?? '未知错误'}`, running: false } : n)));
        } else if (j.status === 'running') {
          setNodes((ns) => ns.map((n) => (n.id === j.nodeId ? { ...n, badge: j.stage ?? '生成中…', running: true } : n)));
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
    /* 补种:队列推送只在主进程的窗口引用上发,重载/多窗口场景可能收不到 ——
       监听器注册后立刻取一次快照并注册完成后再取一次,保证挂载瞬间就能看到进行中的任务。
       (主进程侧同样把推送改为广播到所有窗口,这里是对「事件丢失」的兜底) */
    queueReseedRef.current = poll;
    return () => {
      alive = false;
      unsub();
      queueReseedRef.current = null;
      if (queueTimer.current) window.clearInterval(queueTimer.current);
    };
  }, [refreshTakeResults]);

  /* 画布从 store 重新加载(切画布 / Agent 写盘后刷新)时补种一次队列状态:
     新挂载的节点没有运行期标签,靠这次补种把「正在生成」重新标上 */
  useEffect(() => {
    void queueReseedRef.current?.();
  }, [activeCanvasId, knownVersion]);

  /* ══ 统一边分派(P0 · docs/视频节点下游连接规划.md §3)══
     === 计算移入 canvas/edge-dispatch.ts(computeEdgeDerivations 纯函数,可单测) ===
     这里只负责「触发」:nodes/edges 任一变化 → dispatch derive-from-edges action,
     nodesReducer 调 computeEdgeDerivations 计算派生态,JSON 内容比对后决定是否写回。
     语义不变:边 → 下游 data 自动填充/删除边撤销自动项(手动项保留)。

     ⚠️⚠️ 派生结果必须同步进 nodesRef(2026-10-11「图片编辑无法运行」事故):
     dispatchNodes 走 reducer 直达 nodes state,**不经过 setNodes 包装**(ref 同步在包装里),
     于是派生态(inputImageFrom / refs / promptFrom …)只进 state、不进 ref ——
     而 runNode / buildActiveSnapshot / 连线校验全都读 nodesRef:
     检查器(读 state)显示输入图已绑定,点「运行」却因 ref 里 inputImageFrom=null
     报「需要输入图」,派生态也永远存不进快照。事故源于 9f80e2f 引入 ref 同步包装时
     只覆盖了 'set' 分支,derive 分支成了旁路。 */
  useEffect(() => {
    // 先在同一批数据上算出派生结果;ref 永远与「含派生态的最新内容」对齐 —
    // 即使 state 早已含派生态(changed=false)也要同步,否则历史遗留的 ref 裂口永远合不上
    // (reducer 侧对同一份 state 重算一次,幂等;此处多读一次纯函数只为拿结果同步 ref)
    const r = computeEdgeDerivations(nodes, edges);
    // ⚠️ 回写 ref **不能无条件用 state**:ref 与 state 是双轨,而 effect 里读到的 `nodes` 可能还是
    // **上一次渲染的旧值**(挂载首帧 = 初始空数组;React StrictMode 还会 mount→unmount→mount 重放一遍)。
    // 2026-10-20 画布被抹空事故真因就在这一行:加载 effect 刚把 7 个节点写进 nodesRef(同步),
    // 紧接着本 effect 用「旧渲染的空 state」把 ref 清成 [],而 edgesRef 还是 11 ——
    // 随后 StrictMode 的模拟卸载 flush(saveFlushRef)就把「0 节点 + 11 悬空边」写进了 store,
    // 用户重新进项目看到的就是空画布(只能从 .bak 抢回)。
    // 现在的规则:派生态有变化就用算出来的结果;**没有变化时,只有 state 真的是这一轮内容
    // (非空,或 ref 本来就是空)才拿它回写** —— 空 state 永远不许覆盖非空 ref。
    if (r.changed) nodesRef.current = r.nextNodes;
    else if (nodes.length > 0 || nodesRef.current.length === 0) nodesRef.current = nodes;
    dispatchNodes({ type: 'derive-from-edges', edges });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edges, nodes]);

  /* ══ 视频 → 音频参考节点:连上即抽音轨(2026-10-08) ══
   *
   * 「视频节点 →「+」→ 音频参考」连上以后,把来源视频的音轨用 ffmpeg 抽出来、
   * 导入资产库、绑定为 audio-ref 节点的 `data.assetId` —— 之后它就是一个普通音频参考节点,
   * 可以再连给任意多个镜头(`--ref-audio`)。
   *
   * 为什么放在 effect 而不是派发里:派发(`computeEdgeDerivations`)是**纯函数**,
   * 不能有 ffmpeg 副作用(它在 reducer 里被调用,StrictMode 下还会双跑)。
   *
   * 防重入靠 `data.sourceVideoPath` 记录「已为哪个视频抽过」:
   *  - 同一个视频 → 不重复抽
   *  - 上游换了产物(重新生成)→ 路径变了 → 自动重抽
   *  - 删边 → 派发清掉 inputAudioFrom/sourceVideoPath → 下次连上会重抽
   * 加 in-flight 集合防止同一节点在一次抽取完成前被重复触发(StrictMode 双跑 / 快速抖动)。 */
  const audioExtractInflightRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const n of nodes) {
      if (n.kind !== 'audio-ref') continue;
      const d = (n.data ?? {}) as Record<string, unknown>;
      const from = (d.inputAudioFrom as { nodeId?: string } | undefined)?.nodeId;
      if (!from) continue;
      const up = nodes.find((x) => x.id === from);
      const srcVideo = String((up?.data as Record<string, unknown> | undefined)?.resultPath ?? '');
      if (!srcVideo) continue; // 上游还没产物 → 等它跑出来再抽(不报错,连线先立着)
      if (String(d.sourceVideoPath ?? '') === srcVideo) continue; // 已为这个视频抽过
      if (audioExtractInflightRef.current.has(n.id)) continue;
      audioExtractInflightRef.current.add(n.id);
      void (async () => {
        try {
          const ex = await window.bigbotart.extractAudio(srcVideo);
          if (!ex.ok || !ex.path) {
            // 明确告知,不静默(红线 R6):上游成片可能本来就没有音轨
            toastMsg(`抽取音轨失败:${ex.error ?? '未知错误'}`);
            return;
          }
          const imported = await window.bigbotart.importAssets({
            paths: [ex.path],
            ...(projectId ? { projectId } : {}),
          });
          const assetId = imported.assets[0]?.id;
          if (!assetId) {
            toastMsg('音轨已抽出,但导入资产库失败(音频文件在产物目录)');
            return;
          }
          setNodes((ns) =>
            ns.map((x) =>
              x.id === n.id
                ? {
                    ...x,
                    extra: `✓ ${ex.path!.split(/[\\/]/).pop()}`,
                    data: {
                      ...(x.data ?? {}),
                      // 绑定抽出来的音频资产 —— 音频参考节点的既有语义(data.assetId)不变
                      assetId,
                      sourceVideoPath: srcVideo,
                    },
                  }
                : x,
            ),
          );
          toastMsg(`已从视频抽取音轨并绑定 · ${n.title}`);
        } catch (e) {
          toastMsg(`抽取音轨失败:${(e as Error).message}`);
        } finally {
          audioExtractInflightRef.current.delete(n.id);
        }
      })();
    }
  }, [nodes, projectId, toastMsg]);

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

  /* 创建并连线(类型/画幅/档位/端口角色由 AddNodePopover 回传)
     async:shot 需先取「默认加速配置」再落节点(见下方 accel 段),避免建出未加速的中间态 */
  const createFromPop = useCallback(
    async (typeId: string, aspect: string, tier: string, port?: string) => {
      if (!apFrom) return;
      const src = nodesRef.current.find((n) => n.id === apFrom);
      const t = NODE_TYPES.find((x) => x.id === typeId);
      if (!src || !t) return;
      const id = makeNodeId('new');
      // 按 kind 初始化 data(写入 CanvasSnapshot;生成时走 RenderQueue)
      const initData = makeInitialData(t);

      /*
       * ── shot 的画幅:把弹层的选择**真正写进 data**(2026-10 P0 修复)──
       *
       * 旧实现(缺陷):弹层里选的「比例 × 档位」只被拼进 meta 提示字符串,
       * 节点 data 拿的始终是 `makeInitialData` 里硬编码的 1280×720/default ——
       * 于是「显示 9:16 预览档」而「实际 16:9 默认档」,用户看到的与跑的不是一回事。
       *
       * ⚠️ **分辨率一律由「档位」决定**(2026-10 修正):
       * 弹层的「档位」(预览/草稿/默认/参考)是用户显式选的分辨率档,
       * 它**始终**从 `SHOT_SIZES[比例][档位]` 取像素值 —— 任何"沿用上游图片分辨率"的
       * 做法都是错的:那会让 4K 参考图把 5 秒预览档顶成 4K 出片,耗时与显存完全失控。
       *
       * 连接角色只影响**比例**(aspect),不影响档位分辨率:
       *  - **首帧**(first-frame / first-last):比例沿用上游图片(首帧即视频第一帧,
       *    比例不一致会被拉伸/裁切),但**像素数仍按所选档位**取该比例下的合法档;
       *  - **参考图**(ref-image / Ref2VA):比例默认 4:3(参考图素材多为该比例,不锚定几何);
       *  - 其余(text2video 等):用弹层选的比例。
       * 三条路径最终都落到 `SHOT_SIZES` 的同一格,保证与检查器/引擎同表。
       */
      let specAspect: string = aspect;
      if (t.kind === 'shot') {
        // 上游尺寸:asset 节点取资产元数据宽高,其余图片节点取 data.width/height
        const upstreamSize = (() => {
          const sd = (src.data ?? {}) as Record<string, unknown>;
          if (src.kind === 'asset') {
            const aid = String(sd.assetId ?? '');
            const a = aid ? assetsList.find((x) => x.id === aid) : undefined;
            if (a?.width && a?.height) return { width: a.width, height: a.height };
          }
          const w = Number(sd.width ?? 0);
          const h = Number(sd.height ?? 0);
          return w > 0 && h > 0 ? { width: w, height: h } : undefined;
        })();
        // 连接角色 → 只决定 aspect(不碰分辨率)
        const roleAspect = (() => {
          if (port === 'first-frame') {
            // 首帧:按上游图片比例归类到已知档;拿不到上游就保持弹层所选
            const up = upstreamSize;
            if (!up) return undefined;
            const fit = fitImageSizeToGrid(up.width!, up.height!);
            return classifyAspect(fit.width, fit.height);
          }
          if (port === 'ref-image') return '4:3';
          return undefined;
        })();
        if (roleAspect && roleAspect !== 'custom') specAspect = roleAspect;
      }
      // 分辨率:统一按「比例 × 档位」取档位值(用户显式选的档位永远优先于任何图片尺寸)
      // ⚠️ 档位必须经 tierKeyOf 归一:弹层传的是中文标签「默认」,而 SHOT_SIZES 的键是
      // 英文 'default' —— 直接查会得 undefined 并**静默**退回旧硬编码尺寸(2026-10 事故)
      const specTier = tierKeyOf(tier);
      const specSize = t.kind === 'shot' ? SHOT_SIZES[specAspect as VideoAspect]?.[specTier] : undefined;

      const meta =
        typeId === 'shot'
          ? `h3.c · ${tier}档 · ${specAspect} ${specSize ? `${specSize.width}×${specSize.height}` : ''} · 自动连线继承绑定`
          : t.sub;
      // shot 的画幅/尺寸真正落进 data(其余 kind 保持原样)
      const dataWithSpec =
        t.kind === 'shot'
          ? {
              ...initData,
              aspect: specAspect,
              ...(specSize ? { width: specSize.width, height: specSize.height } : {}),
              tier: specTier,
            }
          : initData;

      /* 🚀 加速默认(2026-10-09):设置页开了「新建 shot 默认开启加速」时,
         新建的 shot 直接带上 accel —— 与 Agent storyboard.materialize 同口径。
         必须在**建节点之前**取到(节点一旦建出来再补,就会出现「刚建好还没加速」的中间态,
         用户若此时点运行就是未加速的一次生成)。
         取不到 / 开关关闭 → null → 不写 accel(存量行为不变)。 */
      if (t.kind === 'shot') {
        const accelCfg = await fetchAccelDefaultShotConfig();
        if (accelCfg) (dataWithSpec as Record<string, unknown>).accel = accelCfg;
      }

      // 按手册 §9 边 label:brief→input-brief / asset→按角色(可显式选首帧/参考图) / wf-input→slot-<name> / 其他不标
      const edgeLabel = deriveEdgeLabel(src, t, port);
      /* 🛡️ 与拖拽建边同口径的权威校验:「+」弹层只列出 resolvePortOptions 认为可连的类型,
         但那仍是渲染层那份表 —— shared 的 validateEdge 可能判它非法(两份表分叉)。
         这里在建节点**之前**拦下,避免留下一个「已新建但连不上」的孤儿节点。 */
      const dstStub = { id, kind: t.kind, data: dataWithSpec } as CanvasNode;
      const guard = guardEdge(src, dstStub, edgeLabel, [...nodesRef.current, dstStub], edgesRef.current);
      if (!guard.ok) {
        toastMsg(`无法创建连线:${guard.message}`);
        return;
      }
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
          data: dataWithSpec,
        } as CanvasNode,
      ]);
      setEdges((es) => [...es, { from: apFrom, to: id, cls: 'ghost', label: edgeLabel }]);
      commitEdit(`新增「${t.name}」并连线`);
      setInfoMap((m) => ({ ...m, [id]: { t: t.name, img: null, meta: [['来源', meta]] } }));
      closeAddPop();
    },
    // assetsList 参与依赖:首帧模式要按 assetId 查资产宽高,清单更新后需拿到新引用
    [apFrom, closeAddPop, commitEdit, assetsList],
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
      commitEdit('从节点库添加节点');
    },
    [findFreeSpot, commitEdit],
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
      commitEdit('从节点库拖入节点');
    },
    [findFreeSpot, screenToWorld, commitEdit],
  );

  /* ══ 右键菜单 ══ */
  /**
   * 复制节点(单个或整块选区)。
   *
   * 选区复制要点:
   *  - **组内复制**:若选区恰好等于某个组,副本会重新组成一个同名新组(带上「· 副本」后缀),
   *    否则副本之间会丢掉分组关系,用户还得手动重建;
   *  - 偏移量固定 (+30,+30),与单击复制一致 —— 不做「自动找空位」,避免副本散落到远处;
   *  - 副本不带连线(与单击复制语义一致),运行状态一律清空。
   */
  const duplicateNodes = useCallback(
    (ids: string[]) => {
      const set = new Set(ids);
      const srcs = nodesRef.current.filter((n) => set.has(n.id));
      if (srcs.length === 0) return;
      const idMap = new Map<string, string>();
      const copies = srcs.map((src) => {
        const nid = makeNodeId('dup');
        idMap.set(src.id, nid);
        return {
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
        } as CanvasNode;
      });
      setNodes((ns) => [...ns, ...copies]);
      // 选区恰好是整组 → 副本同样成组(组 id 重映射到新节点)
      const srcGroup = selectionIsWholeGroup(groupsRef.current, srcs.map((s) => s.id));
      if (srcGroup) {
        const newMembers = srcGroup.members.map((m) => idMap.get(m)).filter((x): x is string => !!x);
        setGroups((gs) => createGroup(gs, newMembers, { name: `${srcGroup.name} · 副本` }).groups);
      }
      commitEdit(copies.length > 1 ? `复制 ${copies.length} 个节点` : '复制节点');
      setSelectedIds(copies.map((c) => c.id));
      toastMsg(
        copies.length > 1
          ? `已复制 ${copies.length} 个节点 · 副本不携带连线与运行状态`
          : '已复制节点 · 副本不携带连线与运行状态',
      );
    },
    [makeNodeId, setNodes, commitEdit, toastMsg],
  );

  /** 保留原单击签名(右键菜单/快捷键用) */
  const duplicateNode = useCallback((id: string) => duplicateNodes([id]), [duplicateNodes]);

  const { ask: askPrompt, dialog: promptDialog } = usePrompt();

  /** 右键「重命名…」:改节点标题(唯一的持久化字段 label;不动 kind/data,不触发下游 stale) */
  const renameNode = useCallback(
    async (id: string) => {
      const n = nodesRef.current.find((x) => x.id === id);
      if (!n) return;
      const next = await askPrompt({ title: '重命名节点', initial: n.title });
      if (!next || next === n.title) return;
      setNodes((ns) => ns.map((x) => (x.id === id ? { ...x, title: next } : x)));
      commitEdit('重命名节点');
      // 同步检查器条目与当前检查器标题(若正显示该节点)
      setInfoMap((m) => {
        const cur = m[id];
        if (!cur) return m;
        return { ...m, [id]: { ...cur, t: next } };
      });
      toastMsg(`已重命名为「${next}」`);
    },
    [toastMsg, askPrompt, commitEdit],
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
        if (assetId) path = assetCache[assetId];
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
    [takeResults, toastMsg, assetCache],
  );

  /**
   * 删除节点(单个或整块选区)。
   *
   * 组清理:删掉的节点若属于某组,必须从 members 剔除 —— 否则残留脏 id
   * 会让组框按不存在的节点算包围盒(画到错误位置),或点组框时找不到节点。
   * `pruneGroups` 顺带丢弃变空的组。
   */
  const deleteNodes = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      const set = new Set(ids);
      const remaining = nodesRef.current.filter((n) => !set.has(n.id));
      // 删空画布 = 用户确实要清空:这是唯一允许 0 节点落盘的凭证(见 empty-save-guard)
      if (remaining.length === 0) userClearedRef.current = true;
      setNodes((ns) => ns.filter((n) => !set.has(n.id)));
      setEdges((es) => es.filter((e) => !set.has(e.from) && !set.has(e.to)));
      commitEdit(ids.length > 1 ? `删除 ${ids.length} 个节点` : '删除节点');
      setInfoMap((m) => {
        const next = { ...m };
        for (const id of ids) delete next[id];
        return next;
      });
      setGroups((gs) => pruneGroups(gs, nodesRef.current.filter((n) => !set.has(n.id)).map((n) => n.id)));
      setSelectedIds((cur) => cur.filter((s) => !set.has(s)));
      // 聊天关注节点被删 → 一并解除(否则 chip 指向不存在的节点,发送时主进程按 id 查不到)
      setFocusNodes((cur) => cur.filter((x) => !set.has(x.id)));
      toastMsg(
        ids.length > 1
          ? `已删除 ${ids.length} 个节点 · 相关连线已一并移除`
          : '已删除节点 · 相关连线已一并移除',
      );
    },
    [toastMsg, commitEdit, setNodes, setEdges],
  );

  /** 保留原单击签名(右键菜单/其他调用点用) */
  const deleteNode = useCallback((id: string) => deleteNodes([id]), [deleteNodes]);

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
      const typing =
        !!active && (/^(INPUT|TEXTAREA)$/.test(active.tagName) || active.isContentEditable);
      // 空格按下 = 临时抓手(平移);输入框内不抢(空格要打出来)
      if (e.code === 'Space' && !typing && !e.metaKey && !e.ctrlKey) {
        if (!spaceDownRef.current) {
          spaceDownRef.current = true;
          // 光标反馈:空格是鼠标用户的唯一「随时可用」平移通道(另一个是中键),
          // 不给出抓手光标的话用户根本不知道按下去有用
          setSpacePanning(true);
        }
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        closeAddPop();
        setOpenPop(null);
        setCtx(null);
        // 框选进行中:取消本次框选(不清已有选区)
        if (selRectRef.current) {
          selRectRef.current = null;
          setSelectionRect(null);
        }
        return;
      }
      // ⌘A 全选画布节点
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && !typing) {
        e.preventDefault();
        setSelectedIds(nodesRef.current.map((n) => n.id));
        return;
      }
      // ⌘G 建组 / ⌘⇧G 解组(与设计工具一致)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g' && !typing) {
        e.preventDefault();
        if (e.shiftKey) ungroupSelection();
        else groupSelection();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd' && selectedIds.length > 0) {
        e.preventDefault();
        duplicateNodes(selectedIdsRef.current);
        return;
      }
      // ⌘Z 撤销 / ⌘⇧Z(或 ⌘Y)重做:输入框内保留系统文本撤销,不抢
      if ((e.metaKey || e.ctrlKey) && !typing) {
        const k = e.key.toLowerCase();
        if (k === 'z') {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
          return;
        }
        if (k === 'y') {
          e.preventDefault();
          redo();
          return;
        }
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && selectedIds.length > 0 && !typing) {
        e.preventDefault();
        deleteNodes(selectedIdsRef.current);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceDownRef.current = false;
        setSpacePanning(false);
      }
    };
    // 失焦时清空格状态(否则切窗口回来以为自己还按着空格 → 拖拽全变平移)
    const onBlur = () => {
      spaceDownRef.current = false;
      setSpacePanning(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [
    closeAddPop,
    deleteNodes,
    duplicateNodes,
    groupSelection,
    ungroupSelection,
    selectedIds,
    undo,
    redo,
  ]);

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
        if (d.inputAssetId) srcPath = assetCache[String(d.inputAssetId)];
        const cropFrom = d.inputImageFrom as { nodeId?: string } | undefined;
        if (!srcPath && cropFrom?.nodeId) {
          const up = nodesRef.current.find((x) => x.id === cropFrom.nodeId);
          const inEdge = edgesRef.current.find((e) => e.from === cropFrom.nodeId && e.to === nodeId);
          srcPath = upstreamImagePath(up, inEdge?.label, assetCache);
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
      // 视频裁切取帧节点(frame-grab):不推理,ffmpeg 从视频截一帧 → 导入资产库 + 产物是图片
      if (n.kind === 'frame-grab') {
        // 视频源:资产直取 / 连线上游产物(与 video-upscale 同口径,只收视频)
        let srcPath: string | undefined;
        if (d.inputAssetId) srcPath = assetCache[String(d.inputAssetId)];
        const vFrom = d.inputVideoFrom as { nodeId?: string } | undefined;
        if (!srcPath && vFrom?.nodeId) {
          const up = nodesRef.current.find((x) => x.id === vFrom.nodeId);
          srcPath = upstreamVideoPath(up, assetCache);
        }
        if (!srcPath) {
          toastMsg('视频裁切取帧需要视频输入:连一个 镜头 / 视频增强 / 视频素材(asset),或在检查器填 Asset ID');
          return;
        }
        const mode = String(d.mode ?? 'first') as 'first' | 'last' | 'at';
        // mode='at' 时秒数必须是非负有限数(与主进程 parseAtSeconds 同口径,提前拦下不白跑 ffmpeg)
        const rawSec = Number(d.seconds);
        if (mode === 'at' && (!Number.isFinite(rawSec) || rawSec < 0)) {
          toastMsg('指定时间点取帧需要填一个非负秒数(如 3.5)');
          return;
        }
        setNodes((ns) => ns.map((x) => (x.id === nodeId ? { ...x, badge: '取帧中…', ghost: false } : x)));
        const res = await window.bigbotart.extractFrame(
          srcPath,
          mode,
          mode === 'at' ? rawSec : undefined,
        );
        if (!res.ok || !res.path) {
          setNodes((ns) => ns.map((x) => (x.id === nodeId ? { ...x, badge: `取帧失败 · ${res.error ?? '未知错误'}` } : x)));
          toastMsg(`取帧失败:${res.error ?? '未知错误'}`);
          return;
        }
        // 抽出的 PNG → 导入资产库(产物本身也是资源;失败不静默吞,但帧已在磁盘上,提示后可继续)
        let resultAssetId: string | undefined;
        try {
          const imported = await window.bigbotart.importAssets({
            paths: [res.path],
            ...(projectId ? { projectId } : {}),
          });
          if (imported.assets.length > 0) resultAssetId = imported.assets[0]!.id;
        } catch {
          /* 入资产库失败不影响节点产物可用性;下面 toast 里说明 */
        }
        let takeId: string | undefined;
        if (projectId) {
          const t = await window.bigbotart.takesCreate(projectId, {
            shotNodeId: nodeId,
            status: 'succeeded',
            resultPath: res.path,
            params: { kind: 'frame-grab', mode, seconds: mode === 'at' ? rawSec : undefined, inputPath: srcPath },
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
                  data: { ...(x.data ?? {}), resultPath: res.path, resultAssetId, currentTakeId: takeId },
                }
              : x,
          ),
        );
        setEdges((es) => es.map((e) => (e.to === nodeId && e.cls === 'ghost' ? { ...e, cls: '' as const } : e)));
        toastMsg(
          resultAssetId
            ? `已取帧并导入资产库 · ${n.title}`
            : `已取帧 · ${n.title}(入资产库失败,帧文件已在产物目录)`,
        );
        return;
      }
      // 图片拼接节点(image-stitch):不推理,ffmpeg 把多张图按行/列/网格拼成一张 → 直接出产物 + 记 Take
      if (n.kind === 'image-stitch') {
        const mode = String(d.mode ?? 'column') as 'row' | 'column' | 'grid';
        const piecesFrom = (d.piecesFrom as Array<{ nodeId?: string }> | undefined) ?? [];
        // 按 piecesFrom 顺序(边派生时已按源节点位置排好)解析各拼接件路径;piece-N 边取拆分片
        const paths: string[] = [];
        for (const p of piecesFrom) {
          const up = nodesRef.current.find((x) => x.id === p.nodeId);
          const inEdge = edgesRef.current.find((e) => e.from === p.nodeId && e.to === nodeId);
          const path = upstreamImagePath(up, inEdge?.label, assetCache);
          if (path) paths.push(path);
        }
        if (paths.length < 2) {
          toastMsg(`图片拼接需要 ≥2 张有产物的拼接件(已解析 ${paths.length} 张):连多个 图片节点 / asset 到本节点(piece 端口)`);
          return;
        }
        const gridCols = Number(d.gridCols ?? 3);
        const gap = Number(d.gap ?? 0);
        const bg = String(d.bg ?? 'white');
        setNodes((ns) => ns.map((x) => (x.id === nodeId ? { ...x, badge: '拼接中…', ghost: false } : x)));
        const res = await window.bigbotart.stitchImages({ paths, mode, gridCols, gap, bg });
        if (!res.ok || !res.path) {
          setNodes((ns) => ns.map((x) => (x.id === nodeId ? { ...x, badge: `拼接失败 · ${res.error ?? '未知错误'}` } : x)));
          toastMsg(`拼接失败:${res.error ?? '未知错误'}`);
          return;
        }
        let takeId: string | undefined;
        if (projectId) {
          const t = await window.bigbotart.takesCreate(projectId, {
            shotNodeId: nodeId,
            status: 'succeeded',
            resultPath: res.path,
            params: { kind: 'stitch', mode, gridCols, gap, bg, inputs: paths },
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
        setEdges((es) => es.map((e) => (e.to === nodeId && e.cls === 'ghost' ? { ...e, cls: '' as const } : e)));
        toastMsg(`已拼接 ${paths.length} 张图 · ${n.title}`);
        return;
      }
      // 图片拆分节点(image-split):不推理,ffmpeg 把一张图等分多片 → 产物组 + 记 Take(一次运行一条 Take,pieces 记全部)
      if (n.kind === 'image-split') {
        let srcPath: string | undefined;
        if (d.inputAssetId) srcPath = assetCache[String(d.inputAssetId)];
        const splitFrom = d.inputImageFrom as { nodeId?: string } | undefined;
        if (!srcPath && splitFrom?.nodeId) {
          const up = nodesRef.current.find((x) => x.id === splitFrom.nodeId);
          const inEdge = edgesRef.current.find((e) => e.from === splitFrom.nodeId && e.to === nodeId);
          srcPath = upstreamImagePath(up, inEdge?.label, assetCache);
        }
        if (!srcPath) {
          toastMsg('图片拆分需要输入图:连一个 图片节点 / asset,或在检查器填 Asset ID');
          return;
        }
        const mode = String(d.mode ?? 'grid') as 'rows' | 'cols' | 'grid';
        const count = Number(d.count ?? 3);
        const gridCols = Number(d.gridCols ?? 3);
        const gridRows = Number(d.gridRows ?? 3);
        setNodes((ns) => ns.map((x) => (x.id === nodeId ? { ...x, badge: '拆分中…', ghost: false } : x)));
        const res = await window.bigbotart.splitImage({ path: srcPath, mode, count, gridCols, gridRows });
        if (!res.ok || !res.paths || res.paths.length === 0) {
          setNodes((ns) => ns.map((x) => (x.id === nodeId ? { ...x, badge: `拆分失败 · ${res.error ?? '未知错误'}` } : x)));
          toastMsg(`拆分失败:${res.error ?? '未知错误'}`);
          return;
        }
        const pieces = res.paths;
        let takeId: string | undefined;
        if (projectId) {
          const t = await window.bigbotart.takesCreate(projectId, {
            shotNodeId: nodeId,
            status: 'succeeded',
            resultPath: pieces[0],
            params: { kind: 'split', mode, count, gridCols, gridRows, inputPath: srcPath, pieces },
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
                  extra: `✓ ${pieces.length} 片`,
                  // resultPath = 第 1 片(下游不选片时的默认);pieces = 全部切片(piece-N 端口按序号取)
                  data: { ...(x.data ?? {}), resultPath: pieces[0], pieces, currentTakeId: takeId },
                }
              : x,
          ),
        );
        setEdges((es) => es.map((e) => (e.to === nodeId && e.cls === 'ghost' ? { ...e, cls: '' as const } : e)));
        toastMsg(`已拆分 ${pieces.length} 片 · ${n.title}`);
        return;
      }
      // 视频增强节点(video-upscale):本地后处理(去块 → Real-ESRGAN 超分 → GFPGAN/CodeFormer 合修脸),
      // 不走推理队列;分钟级长任务(每帧 1.2-1.5s),运行中给阶段 badge,完成记一条 Take
      if (n.kind === 'video-upscale') {
        // 防重入:本节点已在跑时直接拒绝(否则重复点「仅重跑该节点」会并行起多个后处理,
        // 抢 CPU/GPU 且互相覆盖产物 —— 用户实测反馈"过程还能继续触发")。
        if (videoPostRunningRef.current.has(nodeId)) {
          toastMsg('该节点正在增强中,请等待当前任务完成');
          return;
        }
        let srcPath: string | undefined;
        if (d.inputAssetId) srcPath = assetCache[String(d.inputAssetId)];
        const vidFrom = d.inputVideoFrom as { nodeId?: string } | undefined;
        if (!srcPath && vidFrom?.nodeId) {
          const up = nodesRef.current.find((x) => x.id === vidFrom.nodeId);
          srcPath = upstreamVideoPath(up, assetCache);
        }
        if (!srcPath) {
          // 兜底:直接找 input 入边(旧数据可能缺派生态)
          const inEdge = edgesRef.current.find((e) => e.to === nodeId && (e.label ?? '') === 'input');
          if (inEdge) {
            const up = nodesRef.current.find((x) => x.id === inEdge.from);
            srcPath = upstreamVideoPath(up, assetCache);
          }
        }
        if (!srcPath) {
          toastMsg('视频增强需要输入视频:连一个 镜头(shot) 或 视频 asset 到本节点(input 端口),或在检查器填 Asset ID');
          return;
        }
        const cfg = {
          scale: Number(d.scale ?? 2),
          superRes: (d.superRes as 'realesrgan' | 'seedvr2' | 'none' | undefined) ?? 'realesrgan',
          seedvrModel: typeof d.seedvrModel === 'string' ? d.seedvrModel : undefined,
          srModel: d.srModel as never,
          faceModel: d.faceModel as never,
          faceWeight: d.faceWeight === undefined ? undefined : Number(d.faceWeight),
          fidelityWeight: d.fidelityWeight === undefined ? undefined : Number(d.fidelityWeight),
          deblock: d.deblock === true,
          deblockCrf: d.deblockCrf === undefined ? undefined : Number(d.deblockCrf),
          crf: d.crf === undefined ? undefined : Number(d.crf),
          device: (d.device as 'mps' | 'cpu' | undefined) ?? 'mps',
        };
        setNodes((ns) =>
          ns.map((x) =>
            x.id === nodeId
              ? { ...x, badge: undefined, progress: { text: '准备中…', pct: 0, indet: true }, ghost: false }
              : x,
          ),
        );
        // 进度:主进程按阶段/帧号 push(见 video-post.ts),这里仅更新 badge。
        // 没有它的话,分钟级任务期间 UI 毫无反馈 → 看起来像「瞬间完成/没启动」(真实反馈)。
        videoPostRef.current = nodeId;
        videoPostRunningRef.current.add(nodeId);
        setVideoPostRunning([...videoPostRunningRef.current]);
        toastMsg('视频增强已开始(分钟级长任务,进度显示在节点与检查器上)');
        let res: Awaited<ReturnType<typeof window.bigbotart.videoUpscale>>;
        try {
          res = await window.bigbotart.videoUpscale({ inputPath: srcPath, nodeId, ...cfg });
        } finally {
          videoPostRef.current = null;
          videoPostRunningRef.current.delete(nodeId);
          setVideoPostRunning([...videoPostRunningRef.current]);
        }
        if (!res.ok || !res.path) {
          const cancelled = (res.error ?? '').includes('已取消');
          setNodes((ns) =>
            ns.map((x) =>
              x.id === nodeId
                ? { ...x, progress: undefined, badge: cancelled ? '已取消' : `增强失败 · ${res.error ?? '未知错误'}` }
                : x,
            ),
          );
          toastMsg(cancelled ? '已取消视频增强' : `视频增强失败:${res.error ?? '未知错误'}`);
          return;
        }
        const applied = res.stages ?? [];
        let takeId: string | undefined;
        if (projectId) {
          const t = await window.bigbotart.takesCreate(projectId, {
            shotNodeId: nodeId,
            status: 'succeeded',
            resultPath: res.path,
            params: { kind: 'video-upscale', ...cfg, inputPath: srcPath, stages: applied },
            durationSec: res.durationSec,
            elapsedSec: res.elapsedSec,
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
                  progress: undefined,
                  extra: `✓ ${basenameOf(res.path as string)}`,
                  data: {
                    ...(x.data ?? {}),
                    resultPath: res.path,
                    appliedStages: applied,
                    durationSec: res.durationSec,
                    width: res.width,
                    height: res.height,
                    currentTakeId: takeId,
                  },
                }
              : x,
          ),
        );
        setEdges((es) => es.map((e) => (e.to === nodeId && e.cls === 'ghost' ? { ...e, cls: '' as const } : e)));
        toastMsg(`视频增强完成(${res.elapsedSec ?? '?'}s) · ${n.title}`);
        return;
      }
      const isImage = n.kind === 'image-gen' || n.kind === 'image-edit' || n.kind === 'image-upscale';
      const slot: 'video' | 'image' = isImage ? 'image' : 'video';
      const engine = String(d.engine ?? (isImage ? 'mlxgen' : 'h3c'));

      // 参考绑定 → Provider references(首/尾帧、参考图、参考音频;shot 接续走 path 直链)
      // ⚠️ 这里必须给出**具体类型**而不是 `as never[]`:下面 ref-audio 的抽音轨分支要读改
      // `asset.kind` / `localPath`,退化成 never 后每次访问都得强转,类型检查就形同虚设。
      type RenderRef = {
        asset: { id: string; kind: Asset['kind']; name: string; localPath: string; tags: string[]; createdAt: string };
        role: string;
        localPath: string;
      };
      /* ⚠️ shot 的引用必须按「此刻」的 nodes/edges 重新推导,不能直接读 d.refs(2026-10-12「技能2测试」):
         接力(cascade)在上游 setNodes 写入新 resultPath 的同一 tick 就调 runNode,
         而派生 effect 要等下一次渲染才跑 —— d.refs 里还是上一版产物路径,
         于是上游重生成后,下游镜头仍用第一次生成的图作首帧。 */
      const liveData =
        n.kind === 'shot'
          ? ((computeEdgeDerivations(nodesRef.current, edgesRef.current).nextNodes.find((x) => x.id === nodeId)?.data ??
              d) as Record<string, unknown>)
          : d;
      const refs = (liveData.refs as Array<{ assetId?: string; path?: string; role: string; auto?: boolean }> | undefined) ?? [];
      let references: RenderRef[] = refs
        .map((r): RenderRef | null => {
          const localPath = r.path ?? assetCache[r.assetId ?? ''];
          if (!localPath) return null;
          return {
            asset: {
              id: r.assetId ?? `shot-frame:${localPath.split('/').pop() ?? ''}`,
              // 音频参考的源是音轨(资产库里的音频、或下面抽出来的 wav),
              // 写成 image 会让 referenceMediaIssues 误判媒体不匹配
              kind: r.role === 'ref-audio' ? 'audio' : 'image',
              name: r.assetId ?? (localPath.split(/[\\/]/).pop() ?? localPath),
              localPath,
              tags: [],
              createdAt: new Date().toISOString(),
            },
            role: r.role,
            localPath,
          };
        })
        .filter((x): x is RenderRef => x !== null);

      /* 音频参考端口 ref-audio 的视频源 → 现场抽音轨(2026-10-08「视频节点 → 音频参考」)。
       *
       * 背景:`ref-audio` 过去只接受音频资产,于是「拿上游镜头的声音当这一段的声音参考」
       * 走不通 —— 视频节点产物是 mp4,连得上去但提交时 h3 需要的是音轨。
       * 现在派发层登记的是**视频路径**(派发是纯函数,不能有 ffmpeg 副作用),
       * 由提交这一步把它换成抽出来的 wav。
       *
       * ⚠️ 抽音轨失败必须**明确报错**,不能让 h3 拿到一个 mp4 当音轨用(它只会在
       * 入队后报一句看不懂的错);这正是本项目反复出现的「假成功」形态。 */
      const audioRefIdx = references.findIndex(
        (r) =>
          r.role === 'ref-audio' &&
          /\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(String(r.localPath ?? '')),
      );
      if (audioRefIdx >= 0) {
        const srcVideo = String(references[audioRefIdx]!.localPath ?? '');
        const ex = await window.bigbotart.extractAudio(srcVideo);
        if (!ex.ok || !ex.path) {
          toastMsg(`音频参考抽取失败:${ex.error ?? '未知错误'}`);
          return;
        }
        const prev = references[audioRefIdx]!;
        references[audioRefIdx] = {
          ...prev,
          // 抽出的就是音轨:kind 必须跟着改成 audio,否则 referenceMediaIssues
          // 会以「ref-audio 需要 audio,实际是 video」把提交拒掉(白连一场)
          asset: { ...prev.asset, kind: 'audio', localPath: ex.path, name: ex.path.split(/[\\/]/).pop() ?? ex.path },
          localPath: ex.path,
        };
      }

      /* image-gen / image-edit 的参考图:ref-image 入边 → references。
         - image-gen:参考图默认走 2.1 参考编辑(缺省模型 image.instruction);显式选 Klein 才 multi-reference。
           真实事故:连线在画布上可见但提交时被丢弃,参考图没进生成命令
         - image-edit:参考编辑(Qwen-Image-2.1 `qwen21.edit`,1-10 张;2026-09-29 接线,
           此前该分支只认 image-gen,image-edit 的参考图恒为空 → 2.1 被压成单图编辑) */
      if (n.kind === 'image-gen' || n.kind === 'image-edit') {
        /* 2026-10-14「测试技能5」事故:资源节点绑了不存在的资产 id 时,旧 `if (p)` 把这条
           ref-image 边**静默跳过**,references 为空照样提交 → 纯文生图假成功(用户视角:
           连线画了、参考没用上)。现改为:任何一条边解析不到图就中止运行并指名原因,
           与 Agent 侧 engine.submit 的拦截同口径。 */
        const failedRefEdges: string[] = [];
        for (const e of edgesRef.current.filter((x) => x.to === nodeId && x.label === 'ref-image')) {
          const up = nodesRef.current.find((x) => x.id === e.from);
          const p = upstreamImagePath(up, e.label, assetCache);
          if (p) {
            references.push({
              asset: {
                id: `ref:${p.split(/[\\/]/).pop() ?? p}`,
                kind: 'image',
                name: p.split(/[\\/]/).pop() ?? p,
                localPath: p,
                tags: [],
                createdAt: new Date().toISOString(),
              },
              role: 'ref-image',
              localPath: p,
            } as never);
          } else {
            failedRefEdges.push(up?.title ?? up?.id ?? e.from);
          }
        }
        if (failedRefEdges.length > 0) {
          toastMsg(
            `参考图未生效:${failedRefEdges.join('、')} 解析不到图片(资源节点未绑定有效资产,或上游还没生成),已取消本次运行——请修复连线或先让上游出图`,
          );
          return;
        }
      }

      /* 镜头接续兜底:入边来自上游 shot 但尾帧尚未归档时(旧数据 / 应用重启后),
         现场抽一次上游产物尾帧,保证「上一段的最后一帧 = 本段首帧」永远成立。
         已显式绑定首帧(手动或连线派发)时不覆盖用户意图。 */
      let inheritedFrom: string | null = null;
      if (n.kind === 'shot') {
        const shotMode = String(liveData.mode ?? 'text2video');
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
        // 自动抽上游尾帧当首帧 —— 但**参考类模式必须豁免**:
        // h3.c 硬性规定 references(--ref-image/--ref-video)不能与 frame anchors(--first-frame/--last-frame)
        // 同时给(`full references cannot be combined with frame anchors`,h3.c:591),
        // 兜底若在参考模式下塞首帧,提交必被 h3 拒绝。
        // ref-image / last-frame 一直是豁免的;ref-video 是 2026-09 新增模式,漏同步过名单,
        // 导致「ref-video + ref-image」的镜头被偷偷多注入一个 first-frame → h3 exit 1(真实事故)。
        const REF_MODES_NO_FRAME_ANCHOR = ['ref-image', 'ref-video', 'last-frame'];
        if (!hasFirst && (wantsFrameAnchor || !REF_MODES_NO_FRAME_ANCHOR.includes(shotMode))) {
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
        if (!inputPath && d.inputAssetId) inputPath = assetCache[String(d.inputAssetId)];
        // 输入图端口 input 的连线来源(静帧直通 / 素材)——手填 inputAssetId 优先
        const imgFrom = d.inputImageFrom as { nodeId?: string } | undefined;
        if (!inputPath && imgFrom?.nodeId) {
          const up = nodesRef.current.find((x) => x.id === imgFrom.nodeId);
          const inEdge = edgesRef.current.find((e) => e.from === imgFrom.nodeId && e.to === nodeId);
          inputPath = upstreamImagePath(up, inEdge?.label, assetCache);
        }
        const maskAssetId = String(d.maskAssetId ?? '');
        if (maskAssetId) maskPath = assetCache[maskAssetId];
      }
      /* 缺省模型必须先算出来,下面的「无底图」闸和提交参数共用同一份。
         create_node 不写 model,真正的模型在提交期按能力解析(指令编辑缺省 Qwen-Image-2.1)。
         若只看 data.model,「只有 ref-image」的 2.1 编辑会被误拦成「没有输入图」。 */
      const toolModels = isImage ? await ensureToolModels() : undefined;
      const hasRefImages = references.some((r) => (r as { role?: string }).role === 'ref-image');
      const resolvedModel = isImage
        ? String(d.model ?? '').trim() ||
          resolveImageModel(toolModels, capabilityOf(String(n.kind ?? ''), String(d.mode ?? 'instruction'), hasRefImages))
        : undefined;

      if (n.kind === 'image-edit' && !inputPath) {
        /* 2026-09-29:Qwen-Image-2.1 的 qwen21.edit 允许「只有参考图、无底图」
           (Provider 侧 qwen21Refs = inputPath + ref-image 参考图,≥1 张即可);
           其它模型(qwen.edit / flux2.edit)CLI 层面必须给 --image-path,维持原拦截。 */
        const isQwen21 = /qwen.*2\.1/i.test(String(resolvedModel ?? ''));
        if (!(isQwen21 && hasRefImages)) {
          toastMsg('图片编辑需要输入图:连一个 shot / 图片节点 / asset,或在检查器填 Asset ID;(Qwen-Image-2.1 指令编辑可只连参考图)');
          return;
        }
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

      /* 镜头:提交前愈合时长 + 校验尺寸/时长(与 Agent engine.submit 同口径)。
         非法参数在入队前拦下,避免 h3 在很远的地方 exit 1。 */
      let shotData = d;
      if (n.kind === 'shot') {
        const dur = normalizeShotDuration(
          { ...d, prompt: promptValue },
          { label: n.title },
        );
        if (dur.changed) {
          shotData = { ...d, ...dur.data };
          setNodes((ns) =>
            ns.map((x) =>
              x.id === nodeId ? { ...x, data: { ...(x.data ?? {}), ...dur.data } } : x,
            ),
          );
        }
        const geom = validateShotSubmitParams({
          width: shotData.width,
          height: shotData.height,
          seconds: shotData.seconds,
          frames: shotData.frames,
        });
        if (geom.length > 0) {
          toastMsg(`无法提交:${geom[0]}`);
          return;
        }
      }

      const params = isImage
        ? {
            kind: n.kind === 'image-upscale' ? 'upscale' : n.kind === 'image-edit' ? String(d.mode ?? 'instruction') : 'generate',
            model: resolvedModel,
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
            /* 像素面积预算(仅 Qwen-Image-2.1 参考编辑用 → `--output-resolution`)。
               必须在这里显式列出:本对象是**白名单**,不在其中的 data 字段到不了 provider
               (2026-10 加检查器控件时才发现的漏点 —— 只写 data 不列这里 = 控件看起来生效、
               实际参数根本没传)。 */
            outputResolution: d.outputResolution,
            outpaintSides: d.outpaintSides,
          }
        : {
            kind: 'video',
            prompt: promptValue,
            mode: liveData.mode,
            width: shotData.width,
            height: shotData.height,
            seconds: Number(shotData.seconds ?? 0) > 0 ? Number(shotData.seconds) : undefined,
            frames: Number(shotData.frames ?? 124),
            steps: Number(shotData.steps ?? 20),
            layers: Number(shotData.layers ?? 50),
            reuse: Number(shotData.reuse ?? 1),
            tier: shotData.tier,
            seed: shotData.seed,
            // 参考视频音轨:true → h3 --ref-silent-video(只取画面),否则 --ref-video 连内嵌音轨一起注入
            refVideoSilent: shotData.refVideoSilent === true,
            // 🚀 加速 LoRA:传给主进程,提交时解析为 modelDir(-d)+ steps
            accel: shotData.accel,
          };

      setNodes((ns) => ns.map((x) => (x.id === nodeId ? { ...x, badge: '已入队 · 等待槽位…', running: true, ghost: false } : x)));
      /* takeId 提到 try 外:catch 里要把「提交被拒」的 queued Take 改判 failed(去重闸,2026-10-14) */
      let takeId: string | undefined;
      try {
        // 先建 Take(queued),再提交任务带 takeId(主进程完成时自动写终态)· shot 与图片类节点(image-gen/edit/upscale)统一记录历史
        if (projectId) {
          const t = await window.bigbotart.takesCreate(projectId, {
            shotNodeId: nodeId,
            status: 'queued',
            // ⚠️ `__refRoles` 必须一并留痕(2026-10-09 补):它记录本次提交**实际带了哪些参考角色**,
            // 是排查「参考图到底有没有进 h3 命令」的**唯一**事后证据。
            // 此前只有 Agent 路径写了它,渲染层路径没写 → 出片人不像角色卡时,
            // 完全无法从 Take 判断是「参考没传」还是「传了但模型没跟」,只能靠猜。
            // 与 tool-handlers.ts 的 engine.submit 同口径。
            params: { ...params, __refRoles: references.map((r) => r.role) },
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
        /* 提交被拒(如同节点已有在途任务的去重闸,2026-10-14)时,上面已建的 queued Take
           不能留着 —— 它永远等不到终态(孤儿记录)。就地改判 failed,检查器里可查原因。 */
        if (takeId && projectId) {
          void window.bigbotart.takesPatch(projectId, takeId, { status: 'failed', error: `提交被拒绝:${msg}` });
        }
        setNodes((ns) => ns.map((x) => (x.id === nodeId ? { ...x, badge: `提交失败 · ${msg}`, running: false } : x)));
        toastMsg(`提交失败:${msg}`);
      }
    },
    /* ⚠️ assetCache 必须进依赖:它现在是 state 派生值,**每次资产清单变化都是新对象**。
       漏掉它 → runNode 闭包捕获旧缓存 → 「刚导入资产就点运行」会报「需要输入图」
       (旧实现用 ref 读当前值,天然没有这个问题;改成 state 后必须显式声明)。 */
    [onNavigate, toastMsg, projectId, activeCanvasId, markDownstreamStale, assetCache],
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
  /**
   * 「受影响节点」计数 —— stale(依赖过期)或 agentOn(Agent 正在此节点重跑)。
   *
   * ⚠️ 必须用 **state 派生值**而不是像以前那样在两处各写一遍
   * `nodesRef.current.filter(...)`:那一版有两个后果 ——
   * ① 计数只在渲染时算,`setNodes` 改了 stale 但没触发重渲染时按钮上的数字会停旧;
   * ② `rerunDone` 的复位判据拿不到「当时的条数」,只能拍脑袋定,见下。
   */
  const staleCount = useMemo(
    () => nodes.filter((n) => n.stale || n.agentOn).length,
    [nodes],
  );

  /**
   * 复位「重跑已排队」。
   *
   * 事故形态(2026-10-08 用户反馈「跑一次后按钮永久置灰」):`setRerunDone(true)` 之后
   * **没有任何地方复位**,`disabled={rerunDone}` 于是永久生效 —— 切画布、改上游重新标出
   * stale、甚至 Agent 又标了一批,按钮都还是灰的且停留在旧数字,刷新页面才能恢复。
   *
   * 复位判据 = **受影响集合被清空**(`staleCount` 回到 0):此刻"已排队 ✓"已经没有意义
   * (它描述的正是这批节点),清掉后按钮重新显示「仅重跑受影响（0）」的可用态。
   * 不能用「排队后延时 N 秒」复位 —— 节点跑完才清 stale,而跑完耗时不可预测
   * (h3 单条实测数分钟到数十分钟),任何定长延时都必然过早或过晚。
   *
   * 这里刻意只在「归零」这一个方向复位:staleCount 从 0 变正(新一轮编辑标出新 stale)
   * 时**不复位**是安全的 —— 那种情况下它本就该是 false(上一轮归零时已清)。
   */
  useEffect(() => {
    if (staleCount === 0) setRerunDone(false);
  }, [staleCount]);

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
    const ids = nodesRef.current.filter((n) => n.kind === 'shot' || n.kind === 'image-gen' || n.kind === 'image-edit' || n.kind === 'image-upscale' || n.kind === 'image-crop' || n.kind === 'image-stitch' || n.kind === 'image-split').map((n) => n.id);
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
      /* sbMaterializedRows = promptFrom.row 集合,与 Agent 同口径为 1-based */
      const done = sbMaterializedRows(sbNode.id, nodesRef.current);
      const plans = planStoryboardMaterializeRows({
        head: tb.head,
        rows: tb.rows,
        doneRows: done,
        canvasNodes: nodesRef.current.map((n) => ({
          id: n.id,
          kind: n.kind,
          label: n.title,
          title: n.title,
          data: (n.data ?? {}) as Record<string, unknown>,
        })),
      });
      if (!plans.length) {
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
      const shotIdByRow = existingShotByRow(
        nodesRef.current.map((n) => ({
          id: n.id,
          kind: n.kind,
          data: (n.data ?? {}) as Record<string, unknown>,
        })),
        sbNode.id,
      );
      for (const plan of plans) {
        const r = plan.rowNo - 1;
        const row = tb.rows[r] ?? [];
        const shotId = makeNodeId('shot');
        const p = assembleH3Prompt(row, tb.head, base, plan.subjects);
        const sec = resolveMaterializeSeconds(
          rowSeconds(row, tb.head),
          rowCell(row, tb.head, '画面描述'),
          rowCell(row, tb.head, '提示词(可选)'),
          p.text,
        );
        const dur = normalizeShotDuration(
          { prompt: p.text, seconds: sec || undefined },
          { label: `镜头 ${pad2(plan.rowNo)}`, prompt: p.text },
        );
        created.push({
          id: shotId,
          title: `镜头 ${pad2(plan.rowNo)}`,
          w: 250,
          x: SHOT_X,
          y: anchorY + r * ROW_STEP,
          ghost: true,
          kind: 'shot',
          tag: NODE_TYPES.find((t) => t.id === 'shot'),
          data: {
            engine: 'mock', // 骨架期 mock;引导向导就绪后切 h3c
            mode: plan.shotMode,
            ...(plan.modeOverride ? { modeOverride: true } : {}),
            prompt: p.text,
            width: size.width,
            height: size.height,
            seconds: dur.data.seconds,
            frames: dur.data.frames,
            steps: 30,
            layers: 50,
            reuse: 1,
            tier,
            seed: 42 + r,
            refs: [],
            promptFrom: { nodeId: sbNode.id, mode: 'row', row: plan.rowNo } as PromptSource,
          },
        } as CanvasNode);
        newEdges.push({ from: sbNode.id, to: shotId, cls: '', label: 'prompt' });
        shotIdByRow.set(plan.rowNo, shotId);

        if (plan.strategy === 'continue' && plan.continueFromRow != null) {
          const prevId = shotIdByRow.get(plan.continueFromRow);
          if (prevId) newEdges.push({ from: prevId, to: shotId, cls: '', label: 'first-frame' });
        }
        for (const refId of plan.refNodeIds) {
          if (nodesRef.current.some((n) => n.id === refId) || created.some((n) => n.id === refId)) {
            newEdges.push({ from: refId, to: shotId, cls: '', label: 'ref-image' });
          }
        }
        if (plan.createKeyframe) {
          imgs++;
          const imgId = makeNodeId('img');
          const z = assembleZImagePrompt(row, tb.head, base);
          created.push({
            id: imgId,
            title: `图片生成 · 分镜静帧 ${pad2(plan.rowNo)}`,
            w: 232,
            x: IMG_X,
            y: anchorY + r * ROW_STEP,
            ghost: true,
            kind: 'image-gen',
            tag: NODE_TYPES.find((t) => t.id === 'image'),
            data: {
              engine: 'mlxgen',
              // 🆕 不写 model(2026-09-29 v1):留给 runNode 按「工具模型 > 内置默认」缺省解析,
              // 否则批量铺出的节点全被写死,设置页默认值永远不生效
              // 🆕 不写 steps(2026-10-14):缺省按模型走 defaultGenerateSteps(Turbo=8)
              prompt: z.text,
              width: size.width,
              height: size.height,
              guidance: 1.0,
              seeds: [42],
              promptFrom: { nodeId: sbNode.id, mode: 'row', row: plan.rowNo } as PromptSource,
            },
          } as CanvasNode);
          const port = keyframeEdgeLabel(plan);
          newEdges.push({ from: sbNode.id, to: imgId, cls: '', label: 'prompt' });
          newEdges.push({ from: imgId, to: shotId, cls: '', label: port });
          if (port === 'ref-image') {
            for (const refId of plan.refNodeIds) {
              newEdges.push({ from: refId, to: imgId, cls: '', label: 'ref-image' });
            }
          }
        }
      }
      const ids = created.map((c) => c.id);
      setNodes((ns) => [
        ...ns.map((n) => (n.id === sbNode.id ? { ...n, data: { ...(n.data ?? {}), lastTable: gfm } } : n)),
        ...created,
      ]);
      setEdges((es) => [...es, ...newEdges]);
      commitEdit('分镜表铺节点');
      if (ids[0]) setSelectedIds([ids[0]]);
      toastMsg(
        `已铺 ${summarizeMaterializePlans(plans)} · ${plans.length + imgs} 个节点 · 未触发运行 · ⌘Z 可整体撤销`,
      );
    },
    [makeNodeId, sbMaterializedRows, sbTableOf, setNodes, setEdges, setSelectedIds, toastMsg, commitEdit],
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
      commitEdit('整体撤销铺节点');
      toastMsg(`已整体撤销 ${n} 个铺出节点 · 分镜表回到待铺状态`);
    },
    [setNodes, setEdges, toastMsg, commitEdit],
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
            const sec = resolveMaterializeSeconds(
              rowSeconds(row, tb.head),
              rowCell(row, tb.head, '画面描述'),
              rowCell(row, tb.head, '提示词(可选)'),
              p.text,
            );
            const dur = normalizeShotDuration(
              { ...data, prompt: p.text, seconds: sec || data.seconds },
              { label: n.title, prompt: p.text },
            );
            data.seconds = dur.data.seconds;
            data.frames = dur.data.frames;
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
        commitEdit('生成分镜表节点');
        setSelectedIds([sb.id]);
        chat.pushMsg({ kind: 'sys', text: `Agent 已生成分镜表 · ${plan.report}` });
        toastMsg(`已生成分镜表 · ${plan.report}`);
      } catch (e) {
        console.error('生成分镜表失败', e);
        toastMsg(`生成分镜表失败:${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [projectId, setNodes, setEdges, setSelectedIds, chat, toastMsg],
  );

  /* 调试面板:主进程日志总线(拉历史 + 订阅实时)+ 渲染性能采集 */
  const [dbgOpen, setDbgOpen] = useState(false);
  const [dbgTab, setDbgTab] = useState<DebugTab>('perf');
  const [dbgLogs, setDbgLogs] = useState<DebugLogEntry[]>([]);
  const dbgBodyRef = useRef<HTMLDivElement | null>(null);
  /* 性能采集:只在面板打开且停在「性能」页签时跑 —— 采集本身也有成本,
     而且没人看的时候采一堆数字没有意义(数据只在看的那一刻才需要新鲜)。 */
  const perfMonitor = usePerfMonitor(dbgOpen && dbgTab === 'perf');
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

  /* ── 节点级回调(P1:全部 useCallback) ──
     这些回调经 StageView 透传给每个 NodeCard,而卡片包了 React.memo。
     写成 JSX 内联箭头会导致每次渲染都是新函数 → 浅比较失败 → memo 失效,
     视口平移时全部卡片照样重渲染。实现一律只读 ref 或调用已稳定的回调,
     故依赖数组里不出现 nodes/view,拖动与缩放期间引用保持不变。 */
  const handleNodeSelect = useCallback(
    (n: CanvasNode, e: React.PointerEvent) => beginNodeDrag(n, e),
    [beginNodeDrag],
  );
  const handleNodeContextMenu = useCallback(
    (e: React.MouseEvent, n: CanvasNode) => {
      e.preventDefault();
      e.stopPropagation();
      closeAddPop();
      setOpenPop(null);
      // 右键未选中的节点 → 先选中它;已在选区内的 → 保留整块选区(右键可对多选操作)
      if (!selectedIdsRef.current.includes(n.id)) selectNode(n.id);
      setCtx({ x: e.clientX, y: e.clientY, id: n.id });
    },
    [closeAddPop, selectNode],
  );
  /**
   * 空白处右键 = **取消选择**。
   *
   * 为什么不是「右键弹空白菜单」:空白菜单在本应用没有任何条目 ——
   * 节点菜单(复制/重命名/另存为/在 Finder 中显示/删除)全部依赖具体节点;
   * 画布级动作(分组/全选/复位视图)已有 ⌘G ⌘A 与工具栏按钮。弹一个空菜单
   * 只会挡住画布。所以右键空白走「取消选择」这条最有用的语义(与 Figma 一致):
   * 用户不必为了取消选中再左键点一下空白(那还会顺带关掉「+」弹层)。
   *
   * 只清选区,不动历史栈 —— 选中态不是编辑内容,不进撤销/重做。
   * 清空后左侧检查器随选区关闭(与「点空白清空选区」同口径)。
   */
  const handleWorldContextMenu = useCallback((e: React.MouseEvent) => {
    /* 先禁掉 Chromium 默认菜单,再判空选区 —— 顺序不能反:空选区时也要拦默认菜单,
       否则「没选中任何东西时右键空白」会弹出浏览器自带的「重新加载 / 检查」菜单。
       把它排在最前面,后面的 early return 就不可能绕过去。 */
    e.preventDefault();
    if (selectedIdsRef.current.length !== 0) {
      setSelectedIds([]);
      closeAddPop();
      setCtx(null);
    }
  }, [closeAddPop]);

  const handleNodeHeaderPointerDown = useCallback(
    // 头部拖动与主体一致:都走「拖动整块选区」
    (e: React.PointerEvent, n: CanvasNode) => beginNodeDrag(n, e),
    [beginNodeDrag],
  );
  const handleNodeAddPointerDown = useCallback(
    (e: React.PointerEvent, n: CanvasNode) => {
      if (e.button !== 0) return;
      // 启动拖拽预备态(未拖动仍走 click 弹层路径)
      beginConnectDrag(n.id, e.clientX, e.clientY);
      e.stopPropagation();
    },
    [beginConnectDrag],
  );
  const handleNodeAddClick = useCallback(
    (e: React.MouseEvent, n: CanvasNode) => {
      e.stopPropagation();
      // 未拖动(<4px)才算 click,触发原弹层
      const d2 = connectDragRef.current;
      if (d2 && d2.moved) return;
      if (apOpenRef.current && apFromRef.current === n.id) closeAddPop();
      else openAddPop(n.id);
      connectDragRef.current = null;
      setConnectDrag(null);
    },
    [closeAddPop, openAddPop],
  );

  /* 缩放百分比显示(P3):用 applyViewLive 维护的轻量 state,
     而不是 view.z —— 滚轮缩放期间 view 是**不更新**的(刻意如此),
     用它会让百分比卡住。 */
  const zoomPct = `${zoomPctLive}%`;
  return (
    <div
      className={`pg-canvas${agentResizing ? ' agent-resizing' : ''}${inspResizing ? ' insp-resizing' : ''}${viewportAnimating ? ' animating' : ''}`}
    >
      <div
        className={`app${palCollapsed ? ' palette-collapsed' : ''}${selected ? ' insp-open' : ''}`}
        data-od-id="canvas-app"
        style={{ ['--insp-w' as string]: `${inspW}px` }}
      >
        <Toolbar
          projectName={projectName}
          onNavigate={onNavigate}
          projectCanvases={projectCanvases}
          onSwitchCanvas={switchCanvas}
          onCreateCanvas={onCreateCanvas}
          onDeleteCanvas={deleteCanvasSafe}
          onRenameCanvas={onRenameCanvas}
          openPop={openPop}
          setOpenPop={setOpenPop}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={undo}
          onRedo={redo}
          marqueeMode={marqueeMode}
          onToggleMarquee={() => {
            setMarqueeMode((v) => {
              toastMsg(
                v
                  ? '框选模式已关闭 · 双指滑动平移画布(空格/中键拖动亦可)'
                  : '框选模式已开启 · 在空白处拖拽即可框选节点',
              );
              return !v;
            });
          }}
          selectedCount={selectedIds.length}
          wholeGroup={wholeGroupOfSelection}
          groupCount={groups.length}
          onGroupSelection={groupSelection}
          onUngroupSelection={ungroupSelection}
          rerunDone={rerunDone}
          staleCount={staleCount}
          assetCount={assetCount}
          onRerunAffected={rerunAffected}
          onRunAll={runAll}
          dbgOpen={dbgOpen}
          onToggleDebug={() => setDbgOpen((v) => !v)}
        />

        <div className="work">
          {/* 左:检查器(选中节点时在节点面板左侧弹出) */}
          <InspectorPane
            open={!!selected}
            inspW={inspW}
            selected={selected}
            selNode={selNode}
            inspectTitle={inspectTitle}
            selInfo={selInfo}
            onClose={() => selectNode(null)}
            gripRef={inspGripRef}
            onGripPointerDown={(e) => {
              if (e.button !== 0 || !selected) return;
              inspDragRef.current = { sx: e.clientX, w: inspW };
              inspGripRef.current?.classList.add('on');
              setInspResizing(true);
              e.preventDefault();
              e.stopPropagation();
            }}
            onGripDoubleClick={() => {
              setInspWidth(DEFAULT_INSP_W, true);
              toastMsg('检查器宽度已重置为默认');
              if (selected) requestAnimationFrame(() => revealNodeRef.current?.(selected));
            }}
            onGripKeyDown={(e) => {
              if (e.key === 'ArrowRight') {
                e.preventDefault();
                setInspWidth(inspW + 16, true);
                if (selected) requestAnimationFrame(() => revealNodeRef.current?.(selected));
              } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                setInspWidth(inspW - 16, true);
              }
            }}
            infoMap={infoMap}
            setInfoMap={setInfoMap}
            setNodes={setNodes}
            onCommitEdit={commitEdit}
            toastMsg={toastMsg}
            projectId={projectId}
            activeCanvasId={activeCanvasId}
            jobs={jobs}
            assetsList={assetsList}
            assetCache={assetCache}
            runNode={(id) => void runNode(id)}
            nodes={nodes}
            takeResults={takeResults}
            onMaterializeStoryboard={(sbNode, aspect, tier) => materializeStoryboard(sbNode, aspect, tier)}
            onUndoStoryboard={(sbNode) => undoStoryboard(sbNode)}
            onResyncStoryboard={(sbNode) => resyncStoryboard(sbNode)}
            onPlanStoryboard={(docNode) => void onPlanStoryboard(docNode)}
            onOpenTimelinePage={() => onNavigate('timeline')}
            edges={edges}
            onRemoveEdge={(srcId, dstId) => {
              // commitEdit 必须在 setEdges 之前(此刻 ref 仍是编辑前内容 = 撤销目标)
              commitEdit('移除连线');
              setEdges((es) => es.filter((e) => !(e.from === srcId && e.to === dstId)));
            }}
            running={!!selected && videoPostRunning.includes(selected)}
            onRerunSelected={() => {
              if (!selected) return;
              if (videoPostRunningRef.current.has(selected)) {
                toastMsg('该节点正在增强中,请等待当前任务完成');
                return;
              }
              // 长任务(视频增强)自带「已开始 + 节点进度」提示,这里不再抢着报「已提交重跑」
              const selKind = nodes.find((x) => x.id === selected)?.kind;
              const isLongTask = selKind === 'video-upscale';
              void runNode(selected);
              if (!isLongTask) toastMsg(`已提交重跑 · ${inspectTitle}`);
            }}
            onOpenAssetPicker={openAssetPicker}
            onRefreshAssets={() => void refreshAssets()}
          />

          {/* 左:节点面板 */}
          <Palette
            collapsed={palCollapsed}
            onCollapse={() => {
              setPalCollapsed(true);
              // 面板收起后左侧变窄,一般不必避让;展开才可能挡节点
            }}
            onExpand={() => {
              setPalCollapsed(false);
              const sel = selectedIdsRef.current.length === 1 ? selectedIdsRef.current[0]! : null;
              if (sel) requestAnimationFrame(() => revealNodeRef.current?.(sel));
            }}
            onAddByDoubleClick={addFromPaletteDbl}
          />

          {/* 中:画布 */}
          <StageView
            view={view}
            applyView={applyView}
            panning={panning}
            nodes={nodes}
            edgePaths={edgePaths}
            selectedIds={selectedIds}
            selectionRect={selectionRect}
            groups={groups}
            marqueeMode={marqueeMode}
            spacePanning={spacePanning}
            onCancelMarquee={() => {
              if (!selRectRef.current) return false;
              selRectRef.current = null;
              setSelectionRect(null);
              return true;
            }}
            flashId={flashId}
            draggingIds={draggingIds}
            connectDrag={connectDrag}
            takeResults={takeResults}
            assetMeta={assetMeta}
            connectPath={computeConnectPath}
            zoomPct={zoomPct}
            stageSize={stageSize}
            onMinimapNavigate={onMinimapNavigate}
            onMinimapCommit={onMinimapCommit}
            onZoomBy={(d) =>
              commitView({ ...viewRef.current, z: Math.min(1.3, Math.max(0.4, viewRef.current.z + d)) })
            }
            onZoomReset={() => commitView({ ...DEFAULT_VIEW })}
            stageRef={stageRef}
            edgesSvgRef={edgesSvgRef}
            minimapRef={minimapRef}
            worldRef={worldRef}
            onStagePointerDown={onStagePointerDown}
            onStageClick={() => {
              // 选区清空一律在 onClick **之前**由「节点 pointerdown / 框选 pointerup」
              // 处理完 —— React 合成事件的冒泡顺序是 pointerup → click,
              // 在 click 里读 selRectRef 永远是 null(真实事故:框选刚框出的选区被立刻清掉)。
              closeAddPop();
              setCtx(null);
            }}
            onWorldClick={() => {
              // 同上:清选区不在这里做(见 onStageClick 注释)
              closeAddPop();
            }}
            onWorldContextMenu={handleWorldContextMenu}
            onWorldDoubleClick={() => commitView({ ...DEFAULT_VIEW })}
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
            onWheelPan={onWheelPan}
            onNodeSelect={handleNodeSelect}
            onNodeContextMenu={handleNodeContextMenu}
            onNodeHeaderPointerDown={handleNodeHeaderPointerDown}
            onNodeAddPointerDown={handleNodeAddPointerDown}
            onNodeAddClick={handleNodeAddClick}
            onSelectGroup={selectGroup}
            registerNodeRef={registerNodeRef}
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

          {/* 右:Agent 对话(常驻) */}
          <AgentPane
            chat={chat}
            agentW={agentW}
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
            focusNodes={focusNodes.map((f) => ({
              id: f.id,
              // 标题实时重取(重命名后 chip 同步更新);节点已被外部(Agent)删除时回退存量标题
              title: nodes.find((n) => n.id === f.id)?.title ?? f.title,
            }))}
            onRemoveFocus={(id) => setFocusNodes((cur) => cur.filter((x) => x.id !== id))}
            mentionNodes={nodes.map((n) => ({ id: n.id, title: n.title, kind: n.kind ?? '' }))}
            resolveMedia={resolveChatMedia}
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
        onAddToChat={toggleChatFocus}
        chatFocusIds={focusNodes.map((f) => f.id)}
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
        tab={dbgTab}
        onTab={setDbgTab}
        logs={dbgLogs}
        bodyRef={dbgBodyRef}
        perf={perfMonitor.snapshot}
        onPerfReset={perfMonitor.reset}
        onClear={() => void window.bigbotart.debugClear().catch(() => undefined)}
        onClose={() => setDbgOpen(false)}
      />
      {promptDialog}
    </div>
  );
}
