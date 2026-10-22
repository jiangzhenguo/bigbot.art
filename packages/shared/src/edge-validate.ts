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
  /** 展示用标题(pendingImageUpstreamLabels 点名未出图上游) */
  label?: string;
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
    | 'ref-missing'
    | 'anchor-reference-conflict';
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

/** 图片产物类节点(静帧直通;与渲染层 IMAGE_KINDS 同口径)。
 *  frame-grab 产出的就是 PNG,故与其它图片产物同类 —— 它正是「视频 → 图片」的合法转换点。 */
export const IMAGE_KINDS = ['image-gen', 'image-edit', 'image-upscale', 'image-crop', 'image-stitch', 'image-split', 'frame-grab'];

/** 视频产物类节点(视频直通:产物是 mp4,不是静帧)。
 *  timeline 在导出成功后 data.resultPath = 成片绝对路径(2026-10 起由渲染层两处回写),
 *  与其它视频产物节点同口径:可作 ref-video / ref-audio / input-video / input 的源。 */
export const VIDEO_KINDS = ['video-upscale', 'timeline'];

/**
 * **带内嵌音轨的视频产物类节点** —— 它们的产物可作 `ref-audio` 的音源
 * (2026-10-08「视频节点 → 音频参考」连接器)。
 *
 * 为什么单独一张表而不是复用 VIDEO_KINDS:`shot` 的产物同样是带音轨的 mp4,
 * 但它**不在** VIDEO_KINDS 里(VIDEO_KINDS 的语义是「视频直通、不能当静帧用」,
 * shot 由各自的 first-frame/ref-video 分支单独处理)。这里要的是「产物里有没有声音」,
 * 与那张表正交,混用会让两个语义互相绑架。
 */
export const AUDIO_BEARING_VIDEO_KINDS = ['shot', ...VIDEO_KINDS];

/** 非 asset 节点的输出媒体(asset 按资产元数据动态判定) */
export const NODE_OUTPUT_MEDIA: Record<string, 'image' | 'video' | 'audio' | 'text'> = {
  shot: 'video',
  director: 'video', // 运镜小样
  timeline: 'video',
  'video-upscale': 'video', // 超分/修脸产物是视频
  'audio-ref': 'audio',
  'image-gen': 'image',
  'image-edit': 'image',
  'image-upscale': 'image',
  'image-crop': 'image',
  'image-stitch': 'image',
  'image-split': 'image',
  'frame-grab': 'image', // 取帧产物是 PNG(静帧)
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
  input: undefined, // edit/upscale/crop/split 输入:图片直通或视频取帧皆可;video-upscale 输入:视频
  /** 视频裁切取帧的输入端口:必须是视频(mp4),不能把静帧塞进来 */
  'input-video': 'video',
  /** 视频 → audio-ref 的输入端口:载荷是从视频抽出的音轨,故按 audio 判定 */
  'input-audio': 'audio',
  piece: 'image', // stitch 拼接件:仅图片
  'piece-N': 'image', // split 产物按序号取片(piece-1/piece-2/…;替代 input/piece 端口)
  clip: undefined, // 静帧/视频皆可入轨
  sequence: undefined,
  prompt: undefined,
  output: undefined,
};

/** 《单值端口集合 SINGLE_VALUE_PORTS 定义在 ./connector-map.js(规则表文件)》 */

/** 拆分产物取片 label:piece-1 / piece-2 / …(1-based) */
export const PIECE_LABEL_RE = /^piece-([1-9]\d*)$/;

/**
 * CONNECTOR_MAP 的目标键沿用渲染层短 id(edit/crop/image/…),而画布节点 kind 是长名
 * (image-edit/…)。直连查不到时按本表回退,让 Agent 侧 canvas.connect 校验与渲染层同口径。
 */
const TARGET_KIND_ALIAS: Record<string, string> = {
  'image-gen': 'image',
  'image-edit': 'edit',
  'image-upscale': 'upscale',
  'image-crop': 'crop',
  'image-stitch': 'stitch',
  'image-split': 'split',
  'frame-grab': 'grab',
  document: 'doc',
};

/** 可收口到 workflow-output 的源 kind(与渲染层 COLLECTABLE_KINDS 同口径) */
export const OUTPUT_COLLECTABLE_KINDS = ['shot', 'director', 'audio-ref', 'asset', ...IMAGE_KINDS, ...VIDEO_KINDS];

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
 * 特例:
 * - shot 的 first-frame 端口消费的是其「尾帧 PNG」(图片),不是视频本体 ——
 *   镜头接续语义(deriveShotRefsFromEdges 以 tailFramePath 注入;尾帧未就绪也允许建边,
 *   提交期 W004 兜底),与渲染层 connectors.ts(BY_KIND shot→shot 恒提供 first-frame)同口径。
 * - **视频产物 → ref-audio(2026-10-08)**:视频源在该端口上提供的是它的**内嵌音轨**,
 *   不是视频本体。提交期由 `extractAudio` 抽出 wav 再走 h3 `--ref-audio`,
 *   故这里按 'audio' 判定 —— 否则 PORT_REQUIRED_MEDIA 会以「源媒体=video」为由
 *   把这条完全合法的边拒掉。
 *   ⚠️ 只对**视频产物类**节点开这个口子:音频 asset 走的是 asset 分支(本来就是 audio),
 *   图片产物没有音轨,不该被放进来。
 */
function portPayloadMedia(node: EdgeNodeMin, label: string, opts?: ValidateEdgeOptions): string | undefined {
  if (node.kind === 'shot' && label === 'first-frame') return 'image';
  // 带音轨的视频产物在这两个端口上提供的是**音轨**而非视频本体:
  //   - ref-audio  → shot 的声音参考(提交期抽 wav)
  //   - input-audio → audio-ref 节点(抽出来后导入资产库并绑定)
  if (
    (label === 'ref-audio' || label === 'input-audio') &&
    AUDIO_BEARING_VIDEO_KINDS.includes(node.kind)
  ) {
    return 'audio';
  }
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
  const raw = CONNECTOR_MAP[source.kind]?.[targetKind]
    ?? CONNECTOR_MAP[source.kind]?.[TARGET_KIND_ALIAS[targetKind] ?? ''];
  if (!raw) return [];
  const labels = splitPorts(raw).filter((label) => {
    const need = PORT_REQUIRED_MEDIA[label];
    if (!need) return true;
    const pm = portPayloadMedia(source, label, opts);
    return pm === undefined || pm === need;
  });
  // 拆分产物 → 图片处理目标(input/piece 端口):追加 piece-N 取片模板(替代 input/piece 直连整图)
  if (source.kind === 'image-split' && labels.some((l) => l === 'input' || l === 'piece')) {
    labels.push('piece-N');
  }
  return labels;
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
  } else if (!allowed.includes(lbl) && !(allowed.includes('piece-N') && PIECE_LABEL_RE.test(lbl))) {
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

  // h3 互斥:shot 上 first/last-frame 与 ref-image/ref-video 不能同时存在。
  // 2026-10-13「技能4」:Agent 把环境图连成首帧、角色卡连成 ref-image,mode 被切成首帧,
  // 入队后 h3 才报 full references cannot be combined with frame anchors。
  if (dst.kind === 'shot') {
    const conflict = anchorReferenceConnectIssue(edges, target, lbl);
    if (conflict) {
      errors.push(conflict);
      return { ok: false, errors };
    }
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
      } else if (lbl === 'ref-video') {
        // 整段成片作参考视频(h3 --ref-video):与「首帧接续」是两个独立端口,可同时用
        const mp4 = String(sd.resultPath ?? '');
        if (mp4) derived.push({ path: mp4, role: 'ref-video', auto: true });
      } else if (lbl === 'ref-audio') {
        // 上游成片的**内嵌音轨**作声音参考(2026-10-08):这里只登记视频文件路径,
        // 真正抽音轨发生在提交期(渲染层 runNode / 主进程 engine.submit 调 frames.extractAudio)
        // —— 派发是纯函数,不该有 ffmpeg 副作用。
        const mp4 = String(sd.resultPath ?? '');
        if (mp4) derived.push({ path: mp4, role: 'ref-audio', auto: true });
      }
    } else if (VIDEO_KINDS.includes(src.kind)) {
      // 视频产物 → 镜头:ref-video 参考视频(video-upscale 增强成片等);
      // first-frame 端口消费的是静帧,这里不注入(需经 frames 取帧后再连);
      // ref-audio 同理只登记视频路径,提交期抽音轨
      if (lbl === 'ref-video') {
        const mp4 = String(sd.resultPath ?? '');
        if (mp4) derived.push({ path: mp4, role: 'ref-video', auto: true });
      } else if (lbl === 'ref-audio') {
        const mp4 = String(sd.resultPath ?? '');
        if (mp4) derived.push({ path: mp4, role: 'ref-audio', auto: true });
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

/**
 * 镜头入边里「图片上游还没产物」的节点标题列表。
 * deriveShotRefsFromEdges 对无 resultPath 是静默跳过的,提交前必须用本函数拦住。
 */
export function pendingImageUpstreamLabels(
  nodes: EdgeNodeMin[],
  edges: EdgeMin[],
  shotId: string,
): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  for (const e of edges) {
    if (e.target !== shotId) continue;
    if (e.label !== 'ref-image' && e.label !== 'first-frame') continue;
    const src = byId.get(e.source);
    if (!src || !IMAGE_KINDS.includes(src.kind)) continue;
    const rp = String((src.data as Record<string, unknown> | undefined)?.resultPath ?? '');
    if (!rp) out.push(src.label || src.id);
  }
  return out;
}

/* ─────────────── audio-ref 节点的输入来源(视频 → 音频参考) ─────────────── */

/**
 * 从入边推导 `audio-ref`(音频参考节点)的**视频来源**。
 *
 * 语义(2026-10-08):`shot` / `video-upscale` 的产物是带音轨的 mp4,
 * 连到 audio-ref 上时,由渲染层用 ffmpeg 把音轨抽出来 → 导入资产库 →
 * 自动绑定为该节点的 `data.assetId`,节点从此就是一个**可见、可复用**的音频产物
 * (同一个音频参考节点可以再连给多个镜头)。
 *
 * 为什么单独一个函数而不是塞进 `deriveShotRefsFromEdges`:
 * 那个函数的输出形状是「shot 的 refs[](assetId 或 path)」,而这里要的是
 * 「audio-ref 节点的来源视频路径 + 抽取状态」。两者的消费方与生命周期都不同,
 * 硬塞会造出一个既要管 refs 又要管 assetId 的混合结构。
 *
 * @returns 来源视频路径;无合法入边时 undefined
 */
export function deriveAudioRefSource(
  nodes: EdgeNodeMin[],
  edges: EdgeMin[],
  nodeId: string,
): string | undefined {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    if (e.target !== nodeId) continue;
    if ((e.label ?? '') !== 'input-audio') continue;
    const src = byId.get(e.source);
    if (!src) continue;
    // 只有带音轨的视频产物能作来源(与 allowedPortLabels 的媒体门禁同口径)
    if (!AUDIO_BEARING_VIDEO_KINDS.includes(src.kind)) continue;
    const mp4 = String(((src.data ?? {}) as Record<string, unknown>).resultPath ?? '');
    if (mp4) return mp4;
  }
  return undefined;
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
    if (mode === 'ref-video' && !has('ref-video')) {
      out.push({
        code: 'ref-missing',
        severity: 'warn',
        message: `${nodeId} mode=ref-video 但缺少 ref-video 参考(W004):请连一条 ref-video 入边(视频 asset / 上游镜头成片 / 视频增强产物),否则将退化为文生视频`,
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

const FRAME_ANCHOR_LABELS = new Set(['first-frame', 'last-frame']);
const FULL_REFERENCE_LABELS = new Set(['ref-image', 'ref-video']);

/**
 * 连线前互斥:shot 已有首/尾帧时拒绝再连参考图/参考视频,反之亦然。
 * ref-audio 不参与(它和帧锚定可以共存)。
 */
export function anchorReferenceConnectIssue(
  edges: EdgeMin[],
  targetId: string,
  newLabel: string,
): EdgeViolation | null {
  const inbound = edges.filter((e) => e.target === targetId);
  const anchor = inbound.find((e) => FRAME_ANCHOR_LABELS.has(String(e.label ?? '')));
  const reference = inbound.find((e) => FULL_REFERENCE_LABELS.has(String(e.label ?? '')));
  if (FULL_REFERENCE_LABELS.has(newLabel) && anchor) {
    return {
      code: 'anchor-reference-conflict',
      severity: 'error',
      message:
        `参考图/参考视频(${newLabel})与已有的首/尾帧锚定(${anchor.label},来自 ${anchor.source})互斥,h3 不能同时提交` +
        `(full references cannot be combined with frame anchors)。` +
        `关联生成请 canvas.disconnect 去掉「${anchor.source} → ${targetId}[${anchor.label}]」,再把环境图、角色卡、手部参考全部以 label="ref-image" 连上;` +
        `若只要首帧生成,则不要连 ${newLabel}。`,
    };
  }
  if (FRAME_ANCHOR_LABELS.has(newLabel) && reference) {
    return {
      code: 'anchor-reference-conflict',
      severity: 'error',
      message:
        `首/尾帧锚定(${newLabel})与已有的参考(${reference.label},来自 ${reference.source})互斥,h3 不能同时提交` +
        `(full references cannot be combined with frame anchors)。` +
        `关联生成请继续用 ref-image,不要改连 ${newLabel};` +
        `若确实要首帧模式,请先 canvas.disconnect 去掉全部 ref-image/ref-video 边(含「${reference.source} → ${targetId}[${reference.label}]」)。`,
    };
  }
  return null;
}

/**
 * h3.c 的 Ref2VA/FL2VA 互斥规则(提交前兜底)。
 *
 * h3.c 硬性校验(`h3.c:591`):
 *     if (params->reference_count && (params->first_frame || params->last_frame))
 *         h3_set_error(ctx, "full references cannot be combined with frame anchors");
 * 即 `--ref-image` / `--ref-video`(references)**不能**与 `--first-frame` / `--last-frame`(frame anchors)共存。
 *
 * 为什么要在提交前拦:这条规则一旦违反,h3 是**入队后**才 exit 1 的,错误信息只有一句英文,
 * 画布上看不出问题(用户只连了两条边,是渲染层的「镜头接续兜底」偷偷多注入了 first-frame)。
 * 2026-09 真实事故:mode=ref-video 的镜头被自动抽上游尾帧当首帧 → h3 拒绝。
 * 这里提前拒绝并**指明原因与修法**,不让错误跑到引擎里才暴露。
 */
export function referenceAnchorConflictIssues(
  refs: Array<{ role?: string }>,
): EdgeViolation[] {
  const hasReference = refs.some((r) => r.role === 'ref-image' || r.role === 'ref-video');
  const anchor = refs.find((r) => r.role === 'first-frame' || r.role === 'last-frame');
  if (!hasReference || !anchor) return [];
  return [
    {
      code: 'media-mismatch',
      severity: 'error',
      message:
        `参考图/参考视频(--ref-image/--ref-video)与首/尾帧锁定(--first-frame/--last-frame)在 h3 中互斥,不能同时提交` +
        `(当前同时存在 ${anchor.role})。请二选一:要么去掉首/尾帧锚定(参考类模式不需要它),要么去掉参考图/参考视频。`,
    },
  ];
}