/**
 * 边校验 + 端到端引用推导 — 画布连接正确性的唯一强制点(A/B/D 三层共用)
 *
 * 背景(n f s w 事故):`canvas.connect` 曾只查节点存在与边重复,导致
 * 「shot 的 first-frame 单值端口被连成双入边(asset + 裁切节点)」而无人拦截,
 * refs 数据被 agent 直写、与边双写漂移,提交层又静默取第一个 first-frame。
 *
 * 本模块以 `CONNECTOR_MAP`(谁可连谁 + 端口 label)+ 媒体类型矩阵 + 端口基数(单值/多值)
 * 为唯一规则源,给三个写入/执行点复用:
 *   1. A — 写入点校验:工具 `canvas.connect` / 物化铺边处调 `validateEdge`,不合法直接拒绝;
 *   2. B — 引用单一事实源:`deriveShotRefsFromEdges` 从边推导 shot refs(agent 不再直写 refs);
 *   3. D — 提交前防呆:`validateRefsForSubmit` / `referenceMediaIssues` 在入队前兜底,
 *           把 h3c 的「静默 first-wins」改成显式报错,渲染不会带病运行。
 */

import { CONNECTOR_MAP, CONNECTOR_OUTPUT_TARGET, PORT_SEMANTICS, SINGLE_VALUE_PORTS } from './connector-map.js';

/** 最小节点结构(与 CanvasNode 兼容,便于在 shared 层独立单测) */
export interface EdgeNodeMin {
  id: string;
  kind: string;
  data?: unknown;
}

/** 最小边结构(与 CanvasEdge 兼容) */
export interface EdgeMin {
  id?: string;
  source: string;
  target: string;
  label?: string;
}

export type EdgeSeverity = 'error' | 'warn';

export interface EdgeViolation {
  code:
    | 'self-loop'
    | 'port-unknown'
    | 'port-not-allowed'
    | 'media-mismatch'
    | 'single-port-conflict'
    | 'duplicate-edge'
    | 'ref-multi-source'
    | 'ref-missing';
  message: string;
  severity: EdgeSeverity;
  /** 单值端口冲突时指向被顶掉的旧边(供调用方做「替换语义」) */
  replaceable?: boolean;
  replacedEdge?: EdgeMin;
}

export interface ValidateEdgeOptions {
  /** 资产节点 → 媒体类型(主进程可传 AssetStore 解析;缺省用节点 data.mediaType,再兜底 image) */
  resolveAssetMedia?: (assetId: string) => 'image' | 'video' | 'audio' | 'document' | undefined;
}

/** 图片产物类节点(静帧直通;与渲染层 IMAGE_KINDS 同口径) */
export const IMAGE_KINDS = ['image-gen', 'image-edit', 'image-upscale', 'image-crop'];

/** 非 asset 节点的输出媒体(asset 按资产元数据动态判定) */
export const NODE_OUTPUT_MEDIA: Record<string, 'image' | 'video' | 'audio' | 'text'> = {
  shot: 'video',
  director: 'video', // 运镜小样
  timeline: 'video',
  'audio-ref': 'audio',
  'image-gen': 'image',
  'image-edit': 'image',
  'image-upscale': 'image',
  'image-crop': 'image',
  document: 'text',
  storyboard: 'text',
};

/** 端口(label)要求的来源媒体;undefined = 不限(取帧/入轨/提示词/收口等) */
export const PORT_REQUIRED_MEDIA: Record<string, 'image' | 'video' | 'audio' | undefined> = {
  'first-frame': 'image',
  'last-frame': 'image',
  'ref-image': 'image',
  'ref-video': 'video',
  'ref-audio': 'audio',
  'audio-track': 'audio',
  input: undefined, // edit/upscale/crop 输入:图片直通或视频取帧皆可
  clip: undefined, // 静帧/视频皆可入轨
  sequence: undefined,
  prompt: undefined,
  output: undefined,
};

/** 《单值端口集合 SINGLE_VALUE_PORTS 定义在 ./connector-map.js(规则表文件)》 */

/** 可收口到 workflow-output 的源 kind(与渲染层 COLLECTABLE_KINDS 同口径) */
export const OUTPUT_COLLECTABLE_KINDS = ['shot', 'director', 'audio-ref', 'asset', ...IMAGE_KINDS];

/** (CONNECTOR_MAP 里 asset 一行的)组合端口串 → 候选 label 列表 */
function splitPorts(v: string): string[] {
  return v.split('/').map((x) => x.trim()).filter(Boolean);
}

function assetMediaOf(node: EdgeNodeMin, opts?: ValidateEdgeOptions): string {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const assetId = String(d.assetId ?? '');
  if (assetId && opts?.resolveAssetMedia) {
    const m = opts.resolveAssetMedia(assetId);
    if (m) return m;
  }
  return String(d.mediaType ?? 'image');
}

function sourceMedia(node: EdgeNodeMin, opts?: ValidateEdgeOptions): string | undefined {
  if (node.kind === 'asset') return assetMediaOf(node, opts);
  return NODE_OUTPUT_MEDIA[node.kind];
}

/**
 * 该源节点在指定端口上实际提供的「载荷媒体」(而非节点主输出媒体)。
 * 特例:shot 的 first-frame 端口消费的是其「尾帧 PNG」(图片),不是视频本体 ——
 * 镜头接续语义(deriveShotRefsFromEdges 以 tailFramePath 注入;尾帧未就绪也允许建边,
 * 提交期 W004 兜底),与渲染层 connectors.ts(BY_KIND shot→shot 恒提供 first-frame)同口径。
 */
function portPayloadMedia(node: EdgeNodeMin, label: string, opts?: ValidateEdgeOptions): string | undefined {
  if (node.kind === 'shot' && label === 'first-frame') return 'image';
  return sourceMedia(node, opts);
}

/**
 * 该源 → 该目标上「当前媒体类型下可选」的端口 label 列表。
 * 纯规则函数:渲染层 / 工具层 / 物化层共用同一份能力表。
 */
export function allowedPortLabels(
  source: EdgeNodeMin,
  targetKind: string,
  opts?: ValidateEdgeOptions,
): string[] {
  if (targetKind === 'workflow-input') return ['slot-<名称>'];
  if (targetKind === 'workflow-output') {
    return OUTPUT_COLLECTABLE_KINDS.includes(source.kind) ? ['output'] : [];
  }
  if (source.kind === 'workflow-input') return [];
  const raw = CONNECTOR_MAP[source.kind]?.[targetKind];
  if (!raw) return [];
  return splitPorts(raw).filter((label) => {
    const need = PORT_REQUIRED_MEDIA[label];
    if (!need) return true;
    const pm = portPayloadMedia(source, label, opts);
    return pm === undefined || pm === need;
  });
}

function describeAllowed(source: EdgeNodeMin, targetKind: string, opts?: ValidateEdgeOptions): string {
  const labels = allowedPortLabels(source, targetKind, opts);
  if (labels.length === 0) return `该组合没有可用端口`;
  const desc = labels
    .map((l) => `${l}(${PORT_SEMANTICS[l] ?? l})`)
    .join(' / ');
  return `可用端口:${desc}`;
}

export interface ValidateEdgeResult {
  ok: boolean;
  errors: EdgeViolation[];
}

/**
 * 校验一条待写入的边(from → to, label)。
 * 只校验「连接本身」;调用方负责节点是否存在等画布层前置校验(见 tool-handlers)。
 * 单值端口冲突以 `replaceable` 标记返回,由写入层决定「拒绝」还是「替换旧边」(替换语义)。
 */
export function validateEdge(
  nodes: EdgeNodeMin[],
  edges: EdgeMin[],
  edge: EdgeMin,
  opts?: ValidateEdgeOptions,
): ValidateEdgeResult {
  const errors: EdgeViolation[] = [];
  const { source, target, label } = edge;
  const src = nodes.find((n) => n.id === source);
  const dst = nodes.find((n) => n.id === target);

  if (source === target) {
    errors.push({ code: 'self-loop', severity: 'error', message: '不能自连:from 与 to 是同一个节点' });
    return { ok: false, errors };
  }
  if (!src || !dst) {
    errors.push({ code: 'port-not-allowed', severity: 'error', message: '源/目标节点不存在(画布层前置校验应已拦截)' });
    return { ok: false, errors };
  }

  const lbl = String(label ?? '').trim();
  if (!lbl) {
    errors.push({
      code: 'port-unknown',
      severity: 'error',
      message: `连线缺少 label(端口语义)。${describeAllowed(src, dst.kind, opts)}`,
    });
    return { ok: false, errors };
  }

  // 重复边(同 from/to,任意 label)
  if (edges.some((e) => e.source === source && e.target === target)) {
    errors.push({ code: 'duplicate-edge', severity: 'error', message: `重复连线:${source} → ${target} 已存在` });
    return { ok: false, errors };
  }

  // 端口存在性 + 媒体匹配
  const allowed = allowedPortLabels(src, dst.kind, opts);
  if (dst.kind === 'workflow-input') {
    if (!/^slot-/.test(lbl)) {
      errors.push({
        code: 'port-not-allowed',
        severity: 'error',
        message: `工作流入口槽位 label 必须以 slot- 开头(如 slot-<名称>),收到「${lbl}」`,
      });
      return { ok: false, errors };
    }
  } else if (dst.kind === 'workflow-output') {
    if (lbl !== 'output') {
      errors.push({
        code: 'port-not-allowed',
        severity: 'error',
        message: `工作流出口端口 label 固定为 output,收到「${lbl}」`,
      });
      return { ok: false, errors };
    }
  } else if (!allowed.includes(lbl)) {
    const sm = sourceMedia(src, opts);
    const need = PORT_REQUIRED_MEDIA[lbl];
    const mediaPart = need
      ? `;该 label 要求来源媒体为 ${need}(源节点媒体=${sm ?? '未知'})`
      : '';
    errors.push({
      code: 'port-not-allowed',
      severity: 'error',
      message: `连线不合法:${src.kind}(${src.id}) → ${dst.kind}(${dst.id}) 端口 label「${lbl}」不被允许${mediaPart}。${describeAllowed(src, dst.kind, opts)}`,
    });
    return { ok: false, errors };
  }

  // 单值端口基数:同目标、同 label 已有入边(不同源)⇒ 冲突(可替换)
  if (SINGLE_VALUE_PORTS.has(lbl)) {
    const conflict = edges.find((e) => e.target === target && e.label === lbl && e.source !== source);
    if (conflict) {
      errors.push({
        code: 'single-port-conflict',
        severity: 'error',
        replaceable: true,
        replacedEdge: conflict,
        message: `端口冲突:${dst.kind}(${target}) 的${lbl}(${PORT_SEMANTICS[lbl] ?? lbl})是单值端口,已有入边 ${conflict.source} → ${target};新边 ${source} → ${target} 会顶掉旧边(替换语义)`,
      });
      return { ok: false, errors };
    }
  }

  return { ok: true, errors: [] };
}

/* ───────────────────────── B:refs 单一事实源 ───────────────────────── */

export interface DerivedRef {
  assetId?: string;
  path?: string;
  role: string;
  auto?: boolean;
}

/** 由 (nodes, edges) 推导 shot 的参考引用;existingRefs 里非 auto 的手动项保留优先(与渲染层 edge-dispatch 同口径) */
export function deriveShotRefsFromEdges(
  nodes: EdgeNodeMin[],
  edges: EdgeMin[],
  nodeId: string,
  existingRefs?: DerivedRef[],
  suppressedRoles?: string[],
): DerivedRef[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const derived: DerivedRef[] = [];
  for (const e of edges) {
    if (e.target !== nodeId) continue;
    const lbl = e.label ?? '';
    const src = byId.get(e.source);
    if (!src) continue;
    const sd = (src.data ?? {}) as Record<string, unknown>;
    if (src.kind === 'asset') {
      const assetId = String(sd.assetId ?? '');
      const role =
        lbl === 'first-frame' ? 'first-frame'
        : lbl === 'ref-image' ? 'ref-image'
        : lbl === 'ref-audio' ? 'ref-audio'
        : lbl === 'ref-video' ? 'ref-video'
        : undefined;
      if (role && assetId) derived.push({ assetId, role, auto: true });
    } else if (src.kind === 'shot') {
      // 镜头接续:上游尾帧 → 下游首帧(tailFramePath 就绪后注入;未就绪留待提交期兜底)
      if (lbl === 'first-frame') {
        const tail = String(sd.tailFramePath ?? '');
        if (tail) derived.push({ path: tail, role: 'first-frame', auto: true });
      }
    } else if (IMAGE_KINDS.includes(src.kind)) {
      // 图片产物 → 镜头:first-frame 静帧直通首帧 / ref-image 参考图注入(图生视频双端口,与资产图行为一致)
      if (lbl === 'first-frame') {
        const img = String(sd.resultPath ?? '');
        if (img) derived.push({ path: img, role: 'first-frame', auto: true });
      } else if (lbl === 'ref-image') {
        const img = String(sd.resultPath ?? '');
        if (img) derived.push({ path: img, role: 'ref-image', auto: true });
      }
    }
  }

  const cur = Array.isArray(existingRefs) ? existingRefs : [];
  const suppressed = new Set(Array.isArray(suppressedRoles) ? suppressedRoles : []);
  const manual = cur.filter((r) => r.auto !== true);
  const key = (r: DerivedRef) => (r.assetId ? `${r.assetId}:${r.role}` : `path:${r.path}:${r.role}`);

  const merged = [...manual];
  for (const r of derived) {
    if (SINGLE_VALUE_PORTS.has(r.role) && (suppressed.has(r.role) || manual.some((m) => m.role === r.role))) continue;
    const idx = merged.findIndex((m) => key(m) === key(r));
    if (idx >= 0) merged[idx] = r;
    else merged.push(r);
  }
  return merged;
}

/* ───────────────────────── D:提交前防呆 ───────────────────────── */

/** 提交前校验 refs 引用列表:单值端口多源冲突 / 模式一致性(W004) */
export function validateRefsForSubmit(
  nodeId: string,
  kind: string,
  refs: DerivedRef[],
  nodeData?: Record<string, unknown>,
): EdgeViolation[] {
  const out: EdgeViolation[] = [];
  const byRole = new Map<string, DerivedRef[]>();
  for (const r of refs) {
    const arr = byRole.get(r.role) ?? [];
    arr.push(r);
    byRole.set(r.role, arr);
  }
  const listOf = (arr: DerivedRef[]) =>
    arr.map((r) => `「${r.assetId ?? r.path ?? '?'}」`).join(' + ');

  for (const role of ['first-frame', 'last-frame', 'ref-audio', 'ref-video']) {
    const arr = byRole.get(role);
    if (arr && arr.length > 1) {
      out.push({
        code: 'ref-multi-source',
        severity: 'error',
        message: `${kind}(${nodeId}) 的${role}端口出现 ${arr.length} 个来源:${listOf(arr)}。${role}是单值端口(设置第一帧/尾帧/单个参考),请移除多余连线或改用 ref-image(可多张)`,
      });
    }
  }

  if (kind === 'shot') {
    const d = nodeData ?? {};
    const mode = String(d.mode ?? 'text2video');
    const has = (role: string) => (byRole.get(role)?.length ?? 0) > 0;
    if ((mode === 'first-frame' || mode === 'first-last') && !has('first-frame')) {
      out.push({
        code: 'ref-missing',
        severity: 'warn',
        message: `${nodeId} mode=${mode} 但缺少 first-frame 参考(W004):请连一条 first-frame 入边(asset/图片产物/上游镜头),否则将退化为文生视频`,
      });
    }
    if (mode === 'first-last' && !has('last-frame')) {
      out.push({
        code: 'ref-missing',
        severity: 'warn',
        message: `${nodeId} mode=first-last 但缺少 last-frame 参考:请补连一条 last-frame 入边`,
      });
    }
    if (mode === 'ref-image' && !has('ref-image')) {
      out.push({
        code: 'ref-missing',
        severity: 'warn',
        message: `${nodeId} mode=ref-image 但缺少 ref-image 参考`,
      });
    }
  }
  return out;
}

/** 提交前校验 provider 引用(已解析成路径的条目):角色媒体类型必须匹配 */
export function referenceMediaIssues(
  refs: Array<{ role: string; kind?: string; path?: string }>,
): EdgeViolation[] {
  const out: EdgeViolation[] = [];
  const needOf: Record<string, string> = {
    'first-frame': 'image',
    'last-frame': 'image',
    'ref-image': 'image',
    'ref-video': 'video',
    'ref-audio': 'audio',
  };
  for (const r of refs) {
    const need = needOf[r.role];
    if (!need) continue;
    let kind = r.kind;
    if (!kind && r.path) kind = /\.(png|jpe?g|webp|gif|bmp)$/i.test(r.path) ? 'image' : /\.(mp4|mov|mkv)$/i.test(r.path) ? 'video' : /\.(mp3|wav|m4a|aac)$/i.test(r.path) ? 'audio' : undefined;
    if (kind && kind !== need) {
      out.push({
        code: 'media-mismatch',
        severity: 'error',
        message: `引用 ${r.path ?? r.role} 媒体为 ${kind},但端口 ${r.role} 需要 ${need}`,
      });
    }
  }
  return out;
}