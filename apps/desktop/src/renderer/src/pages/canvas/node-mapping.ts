import type { NodeKind } from '@bigbotart/shared';
import { defaultStoryboardMarkdown } from '@bigbotart/shared';
import type { CanvasNode, NodeTag, Edge } from './types';
import { resolvePortOptions } from './connectors';

/** 推导边 label = **目标端口锚定**(连接器设计 §5.5):由连接器端口表解析
 *  - 例:shot→shot = `first-frame`(上游尾帧)、asset→shot = `first-frame`/`ref-image`/`ref-audio`、
 *        document→下游 = `prompt`、shot→timeline = `clip`、*→wf-output = `output`
 *  - 返回 undefined = 无可用连接器(该目标类型在「+」弹窗里不会列出)
 *  - `portOverride` 给定时在多端口组合(asset 图 → shot)里显式选角色;缺省用默认(首个)端口
 *  - 特例:`workflow-input` 作为源时,端口锚定的是**源槽位名**(`slot-<名称>`),
 *    这里能解析出具体槽位;而 asset/document → wf-input 时目标节点尚未创建,
 *    只能给占位 `slot-<名称>`,由 dispatch 按来源媒体类型匹配槽位 */
export function deriveEdgeLabel(src: CanvasNode, dstTag: NodeTag, portOverride?: string): string | undefined {
  const opts = resolvePortOptions(src, dstTag.id);
  if (opts.length === 0) return undefined;
  const r = (portOverride !== undefined ? opts.find((o) => o.port === portOverride) : undefined) ?? opts[0]!;
  if (r.port === 'slot-<名称>' && src.kind === 'workflow-input') {
    const slots = (src.data as { slots?: Array<{ name: string; accept: string[] }> })?.slots ?? [];
    const slot = slots.find((s) => {
      if (dstTag.kind === 'shot') return s.accept.includes('text') || s.accept.includes('image') || s.accept.includes('audio');
      if (dstTag.kind === 'image-gen') return s.accept.includes('text');
      if (dstTag.kind === 'image-edit') return s.accept.includes('image') || s.accept.includes('text');
      if (dstTag.kind === 'audio-ref') return s.accept.includes('audio');
      if (dstTag.kind === 'document') return s.accept.includes('text');
      return true;
    });
    return slot ? `slot-${slot.name}` : 'slot-默认';
  }
  return r.port;
}
export function makeInitialData(t: NodeTag): Record<string, unknown> {
  switch (t.kind) {
    case 'document':
      return { markdown: '' };
    case 'storyboard':
      return {
        markdown: defaultStoryboardMarkdown(),
        basePrompt: '',
        lastTable: '',
        aspect: '16:9',
        tier: 'default',
      };
    case 'asset':
      return { assetId: '', mediaType: 'image' };
    case 'image-gen':
      // 🆕 不写 model(2026-09-29 v1 工具模型):留给 runNode 缺省解析(工具模型 > 内置默认);
      // 写死会让设置页默认值永远不生效(审计 §4.1.1 🟥)
      return {
        engine: 'mlxgen',
        prompt: '',
        width: 1024,
        height: 1024,
        steps: 24,
        guidance: 1.0,
        seeds: [42],
      };
    case 'image-edit':
      // 不写 model,同上交由缺省解析(instruction 默认 2.1)
      return { engine: 'mlxgen', prompt: '', mode: 'instruction' };
    case 'image-upscale':
      return { scale: 2 };
    case 'video-upscale':
      // 默认 = POST_PROCESSING.md §9.1 标准配方(Real-ESRGAN ×2 真人模型 + GFPGAN 修脸强度 0.5)
      return {
        scale: 2,
        superRes: 'realesrgan',
        srModel: 'realesrgan-x4plus',
        faceModel: 'gfpgan',
        faceWeight: 0.5,
        device: 'mps',
      };
    case 'image-crop':
      return { aspect: '9:16', focus: 'center' };
    case 'image-stitch':
      return { mode: 'column', gridCols: 3, gap: 0, bg: 'white' };
    case 'image-split':
      return { mode: 'grid', gridCols: 3, gridRows: 3, count: 3 };
    case 'frame-grab':
      // 从视频截一帧导出为图片资源:默认取首帧(与 Agent frames.extract 的默认一致)
      return { mode: 'first' };
    case 'shot':
      return {
        engine: 'h3c',
        mode: 'text2video',
        prompt: '',
        width: 1280,
        height: 720,
        frames: 124,
        steps: 30,
        layers: 50,
        reuse: 1,
        tier: 'default',
        seed: 7,
        refs: [],
      };
    case 'director':
      return { prompt: '' };
    case 'timeline':
      return { shotNodeIds: [] };
    case 'audio-ref':
      return { assetId: '' };
    case 'workflow-input':
      return { slots: [{ name: '主提示词', accept: ['text'], required: true }] };
    case 'workflow-output':
      return { outputs: [{ name: '成片', kind: 'video', sourceNodeIds: [] }] };
    default:
      return {};
  }
}

/** shared → 本地渲染节点(kind 已对齐,直接透传;不写 ui 状态位,状态由卡片从 data 派生) */
export function fromSharedNode(cn: { id: string; kind: string; label?: string; position?: { x: number; y: number }; width?: number; data?: unknown; extra?: string }): CanvasNode {
  return {
    id: cn.id,
    title: cn.label ?? cn.id,
    w: cn.width ?? 236,
    x: cn.position?.x ?? 40,
    y: cn.position?.y ?? 40,
    kind: (cn.kind as NodeKind) ?? 'shot',
    data: (cn.data ?? {}) as Record<string, unknown>,
    // 完成提示行(「✓ 产物名」):随快照持久化,重启后仍在(2026-09-29)
    ...(cn.extra ? { extra: cn.extra } : {}),
  };
}

/** 本地 → shared */
export function toSharedNodes(ns: CanvasNode[]): Array<{ id: string; kind: string; label: string; position: { x: number; y: number }; width?: number; data: unknown; extra?: string; createdAt?: string; updatedAt?: string }> {
  return ns.map((n) => ({
    id: n.id,
    kind: n.kind ?? 'document',
    label: n.title,
    position: { x: n.x, y: n.y },
    width: n.w,
    data: n.data ?? defaultDataFor(n.kind ?? 'document'),
    // 完成提示行随快照持久化 —— 它参与 contentKey 比对,若不落盘会造成
    // 「回推后本地与基线不等 → 每次推送都整体替换」的抖动(2026-09-29 事故)
    ...(n.extra ? { extra: n.extra } : {}),
  }));
}

/**
 * 归一化「瞬态 UI 标记」用于**内容比对**(保存基线 / 自身回推识别)。
 *
 * UI 瞬态字段(badge / running / progress / ghost / stale / agentOn / h)不进快照,
 * 若直接参与比对,会出现两个方向的错判(2026-09 实测):
 *  - 正方向:「生成中文案变了」被当作内容改动 → 每 800ms 写盘一次,主进程写盘广播又把
 *    store 里的旧节点(没有 badge)整体推回来 → **节点上的「生成中」标签被抹掉**
 *  - 反方向:写盘推送回推后,内容与基线("含 badge"的旧串)不等 → 每次都 setNodes,
 *    自建节点的整棵子树反复重挂
 *
 * 归一化 = 剔除上述瞬态键后做 JSON 串,语义仍是「用户内容一致」。
 */
export function contentKey(nodes: CanvasNode[], edges: Edge[], groups: unknown): string {
  // ⚠️ 这些是**不进快照**的纯 UI 瞬态字段,必须从比对里剔除(badge/running/progress/ghost/stale/agentOn/h)。
  // `h` 是 ResizeObserver 的实测高度(纯 UI 测量值):快照还原的节点没有它(见 fromSharedNode),
  // 若不剔除,本地已测节点(有 h)与快照节点(无 h)的 contentKey 必然不等 → 每次写盘回推都判
  // 「内容变了」→ setNodes 整批替换 → h 全丢 → 连线端点退回兜底高度 = 跳到节点顶部;
  // 且 DOM 未换/尺寸未变,RO 不再触发,h 永久缺失(2026-10「进画布连线先在中间后跳到上边」事故)。
  // 注意 `extra` **不在**此列:它是节点卡上的「✓ 产物名」完成提示行,由 toSharedNodes 持久化,
  // 并**有意参与比对**(抹掉会丢反馈,见 node-mapping.test.ts)。曾因它「参与比对却不进快照」
  // 导致快照回推被判成内容变更、setNodes 整体替换把 resultPath 一并回退(2026-09-29 事故),
  // 修法是让它真正进快照(见 toSharedNodes/fromSharedNode),而非把它列为瞬态。
  const TRANSIENT = ['badge', 'running', 'progress', 'ghost', 'stale', 'agentOn', 'h'] as const;
  const norm = nodes.map((n) => {
    const clean: Record<string, unknown> = { ...n };
    for (const k of TRANSIENT) delete clean[k];
    return sortKeys(clean);
  });
  return JSON.stringify([norm, edges, groups]);
}

/**
 * 把当前画布已实测的节点高度 `h` 按 id 合并回「刚从快照还原」的节点数组。
 *
 * 背景(2026-10「连线跳到节点顶部」事故):`h` 是 ResizeObserver 的实测值,不进快照;
 * applyCanvasSnapshot / refreshCanvasFromStore / 画布加载用 fromSharedNode 整批重建节点时
 * `h` 全部丢失 → 连线端点退回兜底高度(y + 72/2 = 节点顶部);而整批替换后 DOM 元素
 * 复用、尺寸未变,ResizeObserver 不会再触发,`h` 永久缺失,连线一直钉在节点上边。
 *
 * 这里按 id 找回已有测量值;新出现的节点(换画布/外部新建)无旧值可合,
 * 交由 registerNodeRef 的 RO 首次回调补测,行为不变。
 */
export function preserveMeasuredSize(loaded: CanvasNode[], prev: CanvasNode[]): CanvasNode[] {
  if (loaded.length === 0 || prev.length === 0) return loaded;
  const hById = new Map<string, number>();
  for (const n of prev) {
    if (typeof n.h === 'number' && Number.isFinite(n.h)) hById.set(n.id, n.h);
  }
  if (hById.size === 0) return loaded;
  return loaded.map((n) => (n.h === undefined && hById.has(n.id) ? { ...n, h: hById.get(n.id)! } : n));
}

/**
 * 递归按键名排序后再序列化。
 *
 * **为什么需要**:`contentKey` 用 `JSON.stringify` 比对,而它**对键顺序敏感**。
 * 对象经过一轮「本地 → toSharedNodes → 快照 → fromSharedNode → 本地」往返后,
 * 字段集合相同但顺序可能变化(如 `extra` 从 `data` 前移到后),导致
 * `contentKey` 判不相等 → 推送被误判为「内容变了」→ `setNodes` 整体替换
 * → 把刚落盘的字段回退(2026-09-29 事故的最后一环)。
 * 排序后比对只反映「内容是否真的不同」,与构造顺序无关。
 */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeys(src[k]);
    return out;
  }
  return v;
}

export function toLocalEdges(ces: Array<{ id?: string; source: string; target: string; label?: string }>): Edge[] {
  return ces.map((e) => ({ from: e.source, to: e.target, cls: '', label: e.label }));
}

export function toSharedEdges(es: Edge[]): Array<{ id?: string; source: string; target: string; label?: string }> {
  return es.map((e) => ({ source: e.from, target: e.to, label: e.label }));
}

/** 快照节点没有业务数据时给默认参数(便于渲染与生成;与 makeInitialData 一致) */
export function defaultDataFor(kind: string): Record<string, unknown> {
  return makeInitialData({ id: '', kind: kind as NodeKind, name: '', sub: '' });
}

/**
 * 快照自愈:历史上 useRef 计数器重挂载归零,新建节点可能拿到与旧节点重复的 id
 * (如两个 `pal1`)。重复 id 会导致 React key 冲突、拖拽时同号节点一起动、
 * 新节点与旧节点坐标重合分不开。
 *
 * 这里保留首次出现的 id,给后续重号的节点重新分配 id(并顺手在完全重合时错开坐标),
 * 同时把指向老 id 的连线重定向到新 id。
 *
 * @returns nodes/edges 是否被改写(改写则需要回写持久化)
 */
export function dedupeNodeIds(
  nodes: CanvasNode[],
  edges: Edge[],
): { nodes: CanvasNode[]; edges: Edge[]; changed: boolean } {
  const seen = new Set<string>();
  const remap = new Map<string, string>(); // 旧 id → 新 id(仅重号的那一个)
  let changed = false;

  const salt = Math.random().toString(36).slice(2, 6);
  let seq = 0;
  const nextFree = (): string => {
    let id: string;
    do {
      id = `fix${++seq}-${salt}`;
    } while (seen.has(id));
    return id;
  };

  const out = nodes.map((n) => {
    let next = n;
    if (!n.id || seen.has(n.id)) {
      // 重号:保留首个,后续节点重新分配唯一 id,并把指向老 id 的连线重定向到新 id
      const nid = nextFree();
      if (n.id) remap.set(n.id, nid);
      seen.add(nid);
      changed = true;
      next = { ...n, id: nid };
    }
    // 完全重合(同 id 或历史遗留叠放)会表现为"粘在一起分不开":向右下错开
    const clash = nodes.some(
      (o) => o !== n && o.x === n.x && o.y === n.y && seen.has(o.id),
    );
    if (clash) {
      next = { ...next, x: n.x + 300, y: n.y + 60 };
      changed = true;
    }
    seen.add(next.id);
    return next;
  });

  const outEdges = changed
    ? edges.map((e) => ({
        ...e,
        from: remap.get(e.from) ?? e.from,
        to: remap.get(e.to) ?? e.to,
      }))
    : edges;

  return { nodes: out, edges: outEdges, changed };
}

/** 从节点集的 id 里推断下一个可用序号(挂载时给计数器播种,避免与历史 id 撞号) */
export function seedIdCounter(nodes: Array<{ id: string }>): number {
  let max = 0;
  for (const n of nodes) {
    const m = /^(?:pal|new|dup|fix)(\d+)/.exec(n.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}
