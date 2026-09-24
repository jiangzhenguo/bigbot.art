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
      return {
        engine: 'mlxgen',
        model: 'AbstractFramework/z-image-turbo-8bit',
        prompt: '',
        width: 1024,
        height: 1024,
        steps: 24,
        guidance: 1.0,
        seeds: [42],
      };
    case 'image-edit':
      // 默认 8bit 量化仓库(短别名 'qwen-image-edit' 会被 mlxgen 解析成全量 57.7GB 仓库 → 未下载 exit 1;
      // Provider 侧 MODEL_ALIASES 也为存量节点兜底归一化)
      return { engine: 'mlxgen', model: 'mlx-community/Qwen-Image-Edit-8bit', prompt: '', mode: 'instruction' };
    case 'image-upscale':
      return { model: 'AbstractFramework/seedvr2-3b-8bit', scale: 2 };
    case 'image-crop':
      return { aspect: '9:16', focus: 'center' };
    case 'image-stitch':
      return { mode: 'column', gridCols: 3, gap: 0, bg: 'white' };
    case 'image-split':
      return { mode: 'grid', gridCols: 3, gridRows: 3, count: 3 };
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
export function fromSharedNode(cn: { id: string; kind: string; label?: string; position?: { x: number; y: number }; width?: number; data?: unknown }): CanvasNode {
  return {
    id: cn.id,
    title: cn.label ?? cn.id,
    w: cn.width ?? 236,
    x: cn.position?.x ?? 40,
    y: cn.position?.y ?? 40,
    kind: (cn.kind as NodeKind) ?? 'shot',
    data: (cn.data ?? {}) as Record<string, unknown>,
  };
}

/** 本地 → shared */
export function toSharedNodes(ns: CanvasNode[]): Array<{ id: string; kind: string; label: string; position: { x: number; y: number }; width?: number; data: unknown; createdAt?: string; updatedAt?: string }> {
  return ns.map((n) => ({
    id: n.id,
    kind: n.kind ?? 'document',
    label: n.title,
    position: { x: n.x, y: n.y },
    width: n.w,
    data: n.data ?? defaultDataFor(n.kind ?? 'document'),
  }));
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
