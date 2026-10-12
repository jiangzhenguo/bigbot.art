/**
 * 工具桥 — Agent 可调用的工具 handler 集合
 * worker 通过反向 JSON-RPC 调主进程,主进程路由到这里执行,结果回传 worker
 *
 * 七域:canvas / engine / assets / skills / timeline / memory / continuity
 * 设计原则:每个工具返回 { ok, result(人读摘要), nodeId? } — 渲染层据此画工具卡
 */
import type { CanvasNode, CanvasEdge, CanvasSnapshot } from '@bigbotart/shared';
import {
  connectorSummary,
  nodeKindGuide,
  isHiddenNodeKind,
  HIDDEN_NODE_REASONS,
  parseGfmTable,
  tableToGfm,
  assembleH3Prompt,
  assembleZImagePrompt,
  rowNeedsImage,
  rowSeconds,
  SB_SIZE,
  chunkText,
  chunkNav,
  validateEdge,
  PIECE_LABEL_RE,
  deriveShotRefsFromEdges,
  validateRefsForSubmit,
  referenceMediaIssues,
  capabilityOf,
  resolveImageModel,
  defaultShotAspectForRole,
  SHOT_SIZES,
  type VideoAspect,
  type DerivedRef,
  type PromptSource,
  type ToolModelBinding,
} from '@bigbotart/shared';
import type { ProjectStore } from './store';
import type { AssetStore } from './assets';
import type { SkillStore } from './skills';
import type { ExportService } from './export';
import { resolveExportFile } from './export';
import type { RenderQueue } from './render-queue';
import type { AccelStore } from './lora';
import type { MemoryStore } from './memory';
import type { TakeStore } from './takes';
import { cropImage, extractFrame, extractAudio } from './frames';
import { captionImage, type VisionRoute } from './vision';
import { stitchImages, splitImage } from './stitch';
import { videoUpscale, probeVideo, probeVideoPostTooling, normalizeVideoPost, checkToolingFor, planVideoPostStages, estimateVideoPostSeconds } from './video-post';
export { toolDefinitions } from '@bigbotart/shared';

export interface ToolContext {
  projectId: string;
  canvasId: string;
}

export interface ToolResult {
  ok: boolean;
  result: string;
  nodeId?: string;
}

type Handler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

const nid = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/** 从路径后缀推断媒体 kind(提交引用映射用;与 shared referenceMediaIssues 同口径) */
const kindFromPath = (p: string): 'image' | 'video' | 'audio' | undefined =>
  /\.(png|jpe?g|webp|gif|bmp)$/i.test(p) ? 'image'
  : /\.(mp4|mov|mkv)$/i.test(p) ? 'video'
  : /\.(mp3|wav|m4a|aac)$/i.test(p) ? 'audio'
  : undefined;

const basenameOf = (p: string) => (p.split(/[\\/]/).pop() ?? p);

/**
 * 节点 data 里的**布尔开关字段**清单。
 *
 * 为什么需要它(2026-10-09 事故):模型调 `canvas.update_node` 时把布尔值写成了
 * **字符串** `"true"`(`{"mode":"ref-image","modeOverride":"true"}`),而渲染层所有
 * 判定都是严格比较 `=== true` —— 字符串 `"true" === true` 为 **false**,
 * 于是「用户已手动选过模式,别再自动推导」这道闸**失效**,模式被入边推导顶掉,
 * 参考图连线随之在提交时丢失,用户看到的就是「人物根本没绑定上角色卡」。
 *
 * 这类 bug 的特点是**静默**:工具返回 ✓、节点上确实写着 "true"、界面看着也是开的,
 * 只有严格比较的那一行知道它是假的。所以统一在**写入端**归一化,而不是逐个判断点去放宽比较
 * (放宽比较要改十几处,还会把真正的 false 也放进来)。
 */
const BOOLEAN_DATA_FIELDS = [
  'modeOverride', // shot:用户手动选过生成模式
  'specOverride', // shot:用户手动改过画幅/档位
  'manualOrder', // timeline:用户手动排过序
  'refVideoSilent', // shot:参考视频只取画面(忽略音轨)
  'ssdStreaming', // shot:SSD 流式读权重
  'specFrom', // 仅作删除标记用,不参与布尔语义
] as const;

/**
 * 把 data 里的布尔字段从「字符串形式」归一化成真布尔。
 *
 * 接受:`true/false` 布尔本身、`"true"/"false"`(含大小写与空白)、`1/0`、`"1"/"0"`、`"yes"/"no"`。
 * 其余值(含 `undefined`)**原样保留**,不猜测 —— 宁可留着让后续逻辑按原值处理,
 * 也不要凭空造一个布尔出来(那会引入新的静默行为)。
 *
 * @returns 归一化后的新对象(不修改入参)
 */
export function normalizeBooleanFields(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const key of BOOLEAN_DATA_FIELDS) {
    if (!(key in out)) continue;
    const v = out[key];
    if (typeof v === 'boolean') continue;
    if (typeof v === 'number' && (v === 1 || v === 0)) {
      out[key] = v === 1;
      continue;
    }
    if (typeof v === 'string') {
      const t = v.trim().toLowerCase();
      if (t === 'true' || t === '1' || t === 'yes') out[key] = true;
      else if (t === 'false' || t === '0' || t === 'no') out[key] = false;
      // 其它字符串(如 "maybe")保持原样,不猜
    }
  }
  return out;
}

/**
 * 规整工具参数里的 `data` 字段为普通对象。
 *
 * 为什么需要:工具 schema 把 `data` 声明为 object,但**本地小模型(Ornith 等)常把它
 * 序列化成 JSON 字符串**再传(`"{\"prompt\": \"...\"}"`)。旧实现在 update_node 里用
 * `typeof a.data === 'object'` 判断,对字符串为 false → 整段 patch 被**静默跳过**,
 * 函数却返回「✓ 已更新节点」:模型写了几百字 prompt 而节点 prompt 长度仍为 0,
 * h3 在很远的地方才炸 `prompt must not be empty`(2026-09-28 真实事故)。
 *
 * 语义:对象直接用;字符串尝试 JSON.parse(必须是对象,不能是数组/标量);
 * 解析失败**明确报错**——绝不静默放行,因为「报告成功但没做」比直接失败更难查。
 */
export function normalizeDataArg(
  raw: unknown,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, data: {} };
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return { ok: true, data: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(s);
    } catch (e) {
      return {
        ok: false,
        error: `data 是字符串但不是合法 JSON,无法应用:${(e as Error).message}。请直接传对象(不要用字符串包裹)。`,
      };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        error: `data 解析后不是对象(收到 ${Array.isArray(parsed) ? '数组' : typeof parsed})。请传形如 {"prompt":"..."} 的对象。`,
      };
    }
    return { ok: true, data: parsed as Record<string, unknown> };
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ok: true, data: raw as Record<string, unknown> };
  return { ok: false, error: `data 必须是对象,收到 ${Array.isArray(raw) ? '数组' : typeof raw}。` };
}

/**
 * 按「id 优先、标题兜底」解析工具参数里的节点引用(nodeId / from / to 等)。
 *
 * 为什么需要:主对话 LLM 拿到的节点信息是「标题为主、id 在行尾」(`canvas.list_nodes` /
 * `get_node` 都这么排版,出自「对用户称呼用标题」的产品规则),模型很容易把**标题**当 id 回传。
 * 原实现只做 `n.id === nodeId` 严格匹配,于是必然报「节点 镜头 03 不存在」——
 * 白烧一整轮往返(本机单轮实测 78 秒),把静默看门狗推向超时。真实事故见 2026-09 主画布对话失败。
 *
 * 容错策略(保守,宁可报歧义也不猜):
 *   1. id 精确命中 → 直接用(零风险,绝不被标题同名干扰);
 *   2. 标题**去空白后**精确命中且**唯一** → 用;
 *   3. 命中多个 → 不猜,返回 candidates 让调用方报「歧义,请用 id」;
 *   4. 都没命中 → node undefined。
 *
 * 去空白是为了容忍模型排版差异(「镜头 03」vs「镜头03」)。
 */
export function resolveNodeRef(
  nodes: CanvasNode[],
  ref: string,
): { node: CanvasNode | undefined; ambiguous: CanvasNode[] } {
  const raw = String(ref ?? '').trim();
  if (!raw) return { node: undefined, ambiguous: [] };
  const byId = nodes.find((n) => n.id === raw);
  if (byId) return { node: byId, ambiguous: [] };
  const norm = (s: string) => s.replace(/\s+/g, '');
  const target = norm(raw);
  const hits = nodes.filter((n) => norm(String(n.label ?? '')) === target);
  if (hits.length === 1) return { node: hits[0], ambiguous: [] };
  if (hits.length > 1) return { node: undefined, ambiguous: hits };
  return { node: undefined, ambiguous: [] };
}

/**
 * resolveNodeRef 的「解析或给出友好报错」包装,供各工具入口统一使用。
 * 命中 id/唯一标题 → 返回节点;歧义/不存在 → 返回可直接当 result 用的错误文案。
 */
export function resolveNodeRefOrError(
  nodes: CanvasNode[],
  ref: string,
  role = '节点',
): { ok: true; node: CanvasNode } | { ok: false; error: string } {
  const hit = resolveNodeRef(nodes, ref);
  if (hit.node) return { ok: true, node: hit.node };
  if (hit.ambiguous.length > 0) {
    const list = hit.ambiguous.map((n) => `「${n.label || n.id}」 (id=${n.id})`).join('、');
    return { ok: false, error: `${role}「${ref}」匹配到多个节点:${list}。请改用 id 精确指定。` };
  }
  return { ok: false, error: `${role} ${ref} 不存在` };
}

/* ── ffmpeg 本地图片节点(image-crop / image-stitch / image-split)输入解析:纯函数,与渲染层
 * CanvasPage.upstreamImagePath 同口径,供 engine.submit 本地执行路径与单测复用 ── */

/** 解析上游节点的图片产物路径:asset → 资产本地路径;image-split + piece-N 边 → 第 N 片;其余 → data.resultPath */
export function resolveNodeImagePath(
  src: CanvasNode | undefined,
  edgeLabel: string | undefined,
  assetPath: (assetId: string) => string | undefined,
): string | undefined {
  if (!src) return undefined;
  const sd = (src.data ?? {}) as Record<string, unknown>;
  if (src.kind === 'asset') return assetPath(String(sd.assetId ?? ''));
  if (src.kind === 'image-split') {
    const m = PIECE_LABEL_RE.exec(edgeLabel ?? '');
    if (m) {
      const pieces = Array.isArray(sd.pieces) ? (sd.pieces as string[]) : [];
      return pieces[Number(m[1]) - 1] || undefined;
    }
  }
  const rp = String(sd.resultPath ?? '');
  return rp || undefined;
}

/** 裁切/拆分的单值输入图:连线(input / piece-N)> data.inputImageFrom(渲染层边派生)> data.inputAssetId(检查器手填) */
export function resolveSingleImageInput(
  canvas: Pick<CanvasSnapshot, 'nodes' | 'edges'>,
  node: CanvasNode,
  assetPath: (assetId: string) => string | undefined,
): string | undefined {
  const d = (node.data ?? {}) as Record<string, unknown>;
  for (const e of canvas.edges) {
    if (e.target !== node.id) continue;
    if (!(e.label === 'input' || PIECE_LABEL_RE.test(e.label ?? ''))) continue;
    const p = resolveNodeImagePath(canvas.nodes.find((n) => n.id === e.source), e.label, assetPath);
    if (p) return p;
  }
  const imgFrom = d.inputImageFrom as { nodeId?: string } | undefined;
  if (imgFrom?.nodeId) {
    const edge = canvas.edges.find((e) => e.source === imgFrom.nodeId && e.target === node.id);
    const p = resolveNodeImagePath(canvas.nodes.find((n) => n.id === imgFrom.nodeId), edge?.label, assetPath);
    if (p) return p;
  }
  const assetId = String(d.inputAssetId ?? '');
  return assetId ? assetPath(assetId) : undefined;
}

/**
 * 上游节点的**视频**产物路径解析(video-upscale 用):与 resolveNodeImagePath 同形状,但只认视频产物。
 *  - asset 节点 → 资产本地路径(须为视频)
 *  - shot / video-upscale 等视频产物节点 → data.resultPath
 *  - timeline 节点 → data.resultPath;缺失(旧数据,修复前导出的成片)时按
 *    lastExport.name 回退解析导出目录(resolveExportFile,白名单 + 必须存在)
 */
export function resolveNodeVideoPath(
  src: CanvasNode | undefined,
  assetPath: (assetId: string) => string | undefined,
): string | undefined {
  if (!src) return undefined;
  const sd = (src.data ?? {}) as Record<string, unknown>;
  if (src.kind === 'asset') return assetPath(String(sd.assetId ?? '')) || undefined;
  const p = String(sd.resultPath ?? '');
  if (p) return p;
  if (src.kind === 'timeline') {
    const name = (sd.lastExport as { name?: string } | undefined)?.name;
    return resolveExportFile(name) ?? undefined;
  }
  return undefined;
}

/**
 * 视频输入节点的单值视频输入:连线(input / input-video 端口)> data.inputVideoFrom(渲染层边派生)> data.inputAssetId(检查器手填)。
 * 与 resolveSingleImageInput 同口径(单值端口 + 逐级回退)。
 * 端口兼容两种:video-upscale 用 `input`,frame-grab(视频裁切取帧)用 `input-video`。
 */
export function resolveSingleVideoInput(
  canvas: Pick<CanvasSnapshot, 'nodes' | 'edges'>,
  node: CanvasNode,
  assetPath: (assetId: string) => string | undefined,
): string | undefined {
  const d = (node.data ?? {}) as Record<string, unknown>;
  for (const e of canvas.edges) {
    if (e.target !== node.id || (e.label !== 'input' && e.label !== 'input-video')) continue;
    const p = resolveNodeVideoPath(canvas.nodes.find((n) => n.id === e.source), assetPath);
    if (p) return p;
  }
  const from = d.inputVideoFrom as { nodeId?: string } | undefined;
  if (from?.nodeId) {
    const p = resolveNodeVideoPath(canvas.nodes.find((n) => n.id === from.nodeId), assetPath);
    if (p) return p;
  }
  const assetId = String(d.inputAssetId ?? '');
  return assetId ? assetPath(assetId) : undefined;
}

/** image-gen 的参考图输入:ref-image 入边 → 上游图片路径数组(资产节点取资产路径,产物节点取 resultPath)。 *  真实事故:Agent 连了两张参考图到 image-gen,提交时 references 只给 shot 推导,
 *  图片节点的 ref-image 边被静默丢弃,生成了纯文生图。 */
/**
 * 连线后同步 shot.mode(无 modeOverride 时)。
 * 2026-10-12「测试技能2」:Agent 连了 ref-image 却不改 mode → 节点一直显示「文生」。
 * 渲染层 edge-dispatch 会再推一遍;这里写盘即生效,避免 Agent 路径只见边不见模式。
 */
export function syncShotModeForEdgeLabel(
  data: Record<string, unknown>,
  label: string,
): Record<string, unknown> | null {
  if (data.modeOverride === true) return null;
  const mode = String(data.mode ?? 'text2video');
  if (label === 'first-frame' && (mode === 'text2video' || mode === 'ref-image')) {
    return { ...data, mode: 'first-frame' };
  }
  if (label === 'ref-image' && (mode === 'text2video' || mode === 'first-frame')) {
    // 仅当尚未有 first-frame 语义时切关联;connect 单次只知本条 label,
    // 若节点已有 first-frame 入边,调用方应先查边(见 applyShotModeSyncOnConnect)。
    return { ...data, mode: 'ref-image' };
  }
  return null;
}

/** 在 canvas.connect 成功后写回 shot.mode;有 first-frame 入边时优先首帧。 */
export function applyShotModeSyncOnConnect(
  node: CanvasNode,
  edges: CanvasEdge[],
  newLabel: string,
): boolean {
  if (node.kind !== 'shot') return false;
  const d = (node.data ?? {}) as Record<string, unknown>;
  if (d.modeOverride === true) return false;
  const hasFirst = edges.some((e) => e.target === node.id && e.label === 'first-frame');
  const hasRef = edges.some((e) => e.target === node.id && e.label === 'ref-image') || newLabel === 'ref-image';
  const mode = String(d.mode ?? 'text2video');
  let next: string | null = null;
  if (hasFirst || newLabel === 'first-frame') {
    if (mode === 'text2video' || mode === 'ref-image') next = 'first-frame';
  } else if (hasRef && (mode === 'text2video' || mode === 'first-frame')) {
    next = 'ref-image';
  }
  if (!next || next === mode) return false;
  node.data = { ...d, mode: next } as CanvasNode['data'];
  node.updatedAt = new Date().toISOString();
  return true;
}

/**
 * 提交前按已推导的 refs 愈合 shot.mode(无 modeOverride)。
 * 覆盖「边已在、mode 仍文生」的存量脏状态(测试技能2 画布)。
 */
export function healShotModeFromRefs(
  data: Record<string, unknown>,
  refs: Array<{ role: string }>,
): Record<string, unknown> | null {
  if (data.modeOverride === true) return null;
  const mode = String(data.mode ?? 'text2video');
  const hasFF = refs.some((r) => r.role === 'first-frame');
  const hasRI = refs.some((r) => r.role === 'ref-image');
  let next = mode;
  if (hasFF && (mode === 'text2video' || mode === 'ref-image')) next = 'first-frame';
  else if (!hasFF && hasRI && (mode === 'text2video' || mode === 'first-frame')) next = 'ref-image';
  if (next === mode) return null;
  return { ...data, mode: next };
}

export function resolveRefImagePaths(
  canvas: Pick<CanvasSnapshot, 'nodes' | 'edges'>,
  node: CanvasNode,
  assetPath: (assetId: string) => string | undefined,
): string[] {
  return canvas.edges
    .filter((e) => e.target === node.id && e.label === 'ref-image')
    .map((e) => resolveNodeImagePath(canvas.nodes.find((n) => n.id === e.source), e.label, assetPath))
    .filter((p): p is string => !!p);
}

/** image 类节点的提交参数(与渲染层 runNode 同口径,真实事故修复):
 *  - kind 从节点类型/编辑模式推导——node.data 里没有 kind 字段,直传 data 会让 Provider
 *    缺省成 'generate',image-edit 被当成纯文生图,input 连线的图被静默丢弃
 *  - image-edit / image-upscale 的 inputPath 从连线解析(input / piece-N 入边 > inputImageFrom > inputAssetId) */
export function buildImageSubmitParams(
  canvas: Pick<CanvasSnapshot, 'nodes' | 'edges'>,
  node: CanvasNode,
  assetPath: (assetId: string) => string | undefined,
  toolModels?: ToolModelBinding,
): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const params: Record<string, unknown> = { ...d };
  params.kind =
    node.kind === 'image-upscale' ? 'upscale' : node.kind === 'image-edit' ? String(d.mode ?? 'instruction') : 'generate';
  // 🆕 缺省模型解析(2026-09-29 v1):节点未显式选模型时按能力取「工具模型 > 内置默认」,
  // 与渲染层 runNode 同口径(显式值永远优先)
  if (!String(d.model ?? '').trim()) {
    const cap = capabilityOf(String(node.kind ?? ''), String(d.mode ?? 'instruction'),
      resolveRefImagePaths(canvas, node, assetPath).length > 0);
    const m = resolveImageModel(toolModels, cap);
    if (m) params.model = m;
  }
  if (node.kind === 'image-edit' || node.kind === 'image-upscale') {
    if (!params.inputPath) {
      const input = resolveSingleImageInput(canvas, node, assetPath);
      if (input) params.inputPath = input;
    }
    if (!params.inputPath) {
      /* 2026-09-29:Qwen-Image-2.1 的 qwen21.edit 允许「只有参考图、无底图」;
         其它模型必须给输入图,维持原拦截(与渲染层 runNode 同口径) */
      const model = String(d.model ?? '');
      const isQwen21 = /qwen.*2\.1/i.test(model);
      const hasRefs = node.kind === 'image-edit' && resolveRefImagePaths(canvas, node, assetPath).length > 0;
      if (node.kind === 'image-upscale' || !(isQwen21 && hasRefs)) {
        return {
          ok: false,
          error: `节点「${node.label || node.id}」没有输入图:请先用 canvas.connect 把图片/资产节点连到它的 input 端口(Qwen-Image-2.1 指令编辑可只连 ref-image 参考图)`,
        };
      }
    }
  }
  return { ok: true, params };
}

/** 拼接的多值输入:piece / piece-N 入边按源节点画布位置排序(row 按 x,column/grid 按 y)> data.piecesFrom 回退 */
export function resolveStitchInputs(
  canvas: Pick<CanvasSnapshot, 'nodes' | 'edges'>,
  node: CanvasNode,
  assetPath: (assetId: string) => string | undefined,
): string[] {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const mode = String(d.mode ?? 'column');
  const pieceEdges = canvas.edges.filter((e) => e.target === node.id && (e.label === 'piece' || PIECE_LABEL_RE.test(e.label ?? '')));
  if (pieceEdges.length > 0) {
    const sorted = pieceEdges
      .map((e) => ({ e, src: canvas.nodes.find((n) => n.id === e.source) }))
      .sort((a, b) => {
        const pa = a.src?.position ?? { x: 0, y: 0 };
        const pb = b.src?.position ?? { x: 0, y: 0 };
        return mode === 'row' ? pa.x - pb.x : pa.y - pb.y;
      });
    const paths = sorted
      .map(({ e, src }) => resolveNodeImagePath(src, e.label, assetPath))
      .filter((p): p is string => !!p);
    if (paths.length > 0) return paths;
  }
  const piecesFrom = Array.isArray(d.piecesFrom) ? (d.piecesFrom as Array<{ nodeId?: string }>) : [];
  const out: string[] = [];
  for (const pf of piecesFrom) {
    const edge = canvas.edges.find((e) => e.source === pf.nodeId && e.target === node.id);
    const p = resolveNodeImagePath(canvas.nodes.find((n) => n.id === pf.nodeId), edge?.label, assetPath);
    if (p) out.push(p);
  }
  return out;
}

/** 分镜表规划服务(由主进程注入,内部走 agent.planStoryboard → LLM / 确定性兜底) */
export interface StoryboardPlanFn {
  (
    brief: string,
    opts?: { projectId?: string; basePrompt?: string; autoMaterialize?: boolean },
  ): Promise<{
    storyboard: CanvasNode;
    images: CanvasNode[];
    shots: CanvasNode[];
    edges: CanvasEdge[];
    report: string;
  }>;
}

export class ToolHandlers {
  private planStoryboard?: StoryboardPlanFn;
  private accel?: AccelStore;
  private takes?: TakeStore;
  private getToolModels?: () => ToolModelBinding | undefined;
  private resolveVisionOverride?: () => Promise<VisionRoute | undefined>;

  constructor(
    private store: ProjectStore,
    private assets: AssetStore,
    private skills: SkillStore,
    private exportSvc: ExportService,
    private queue: RenderQueue,
    private memory: MemoryStore,
    opts: {
      planStoryboard?: StoryboardPlanFn;
      accel?: AccelStore;
      takes?: TakeStore;
      /** 🆕 工具模型设置(v1):图片节点缺省模型 / vision 端点覆盖,从 SettingsStore 实时读 */
      getToolModels?: () => ToolModelBinding | undefined;
      /** 🆕 看图通道覆盖(v1):settings.toolModels.{captionLocal,vision} → VisionRoute;未配置返回 undefined(走 auto/env 回退链) */
      resolveVisionOverride?: () => Promise<VisionRoute | undefined>;
    } = {},
  ) {
    this.planStoryboard = opts.planStoryboard;
    this.accel = opts.accel;
    this.takes = opts.takes;
    this.getToolModels = opts.getToolModels;
    this.resolveVisionOverride = opts.resolveVisionOverride;
  }

  /** 工具路由表 */
  private handlers: Record<string, Handler> = {
    /* ── canvas 域 ── */
    'canvas.list_nodes': async (_a, ctx) => {
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      if (!cur) return { ok: false, result: '画布不存在' };
      // 节点行附尺寸:asset 取资产库元数据宽高,图片/视频节点取 data.width/height ——
      // 让 Agent 建下游节点(如 shot)时能读到上游图片/视频尺寸并沿用
      const sizeOfNode = (n: CanvasNode): string => {
        const d = (n.data ?? {}) as Record<string, unknown>;
        if (n.kind === 'asset') {
          const a = this.assets.get(String(d.assetId ?? ''));
          if (a?.width && a?.height) return ` (${a.width}×${a.height})`;
          return '';
        }
        const w = Number(d.width ?? 0);
        const h = Number(d.height ?? 0);
        return w > 0 && h > 0 ? ` (${w}×${h})` : '';
      };
      // ⚡ 标记:已开启加速 LoRA 的 shot
      const accelMark = (n: CanvasNode): string => {
        const d = (n.data ?? {}) as Record<string, unknown>;
        const acc = (d.accel ?? {}) as { enabled?: boolean };
        return acc.enabled ? ' ⚡' : '';
      };
      const lines = cur.nodes.map((n) => `- 「${n.label || n.id}」 [${n.kind}]${sizeOfNode(n)}${accelMark(n)} (id=${n.id})`).join('\n');
      return { ok: true, result: `当前画布 ${cur.nodes.length} 个节点:\n${lines || '(空)'}` };
    },
    'canvas.get_node': async (a, ctx) => {
      const rawId = String(a.nodeId ?? '');
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      // 按 id 精确查;查不到再容错按「标题」查(见 resolveNodeRef 说明)。
      // 真实事故:模型拿到 list_nodes 的「镜头 03」后把它当 nodeId 传回来,原实现直接报
      // 「节点 镜头 03 不存在」,白烧一整轮往返(单轮实测 78 秒),把看门狗推向超时。
      const hit = cur ? resolveNodeRef(cur.nodes, rawId) : { node: undefined, ambiguous: [] };
      const node = hit.node;
      if (!node) {
        if (hit.ambiguous.length > 0) {
          const list = hit.ambiguous.map((n) => `「${n.label || n.id}」 (id=${n.id})`).join('、');
          return { ok: false, result: `标题「${rawId}」匹配到 ${hit.ambiguous.length} 个节点,无法确定:${list}。请改用 id 精确指定。` };
        }
        return { ok: false, result: `节点 ${rawId} 不存在` };
      }
      const nodeId = node.id;
      // 入/出边用对端标题展示(id 兜底),与「标题为主、id 为辅」的称呼规则一致
      const idToLabel = new Map((cur?.nodes ?? []).map((n) => [n.id, n.label || n.id]));
      const ins = (cur?.edges ?? [])
        .filter((e) => e.target === nodeId)
        .map((e) => `  ← 「${idToLabel.get(e.source) ?? e.source}」${e.label ? ` [${e.label}]` : ''}`)
        .join('\n');
      const outs = (cur?.edges ?? [])
        .filter((e) => e.source === nodeId)
        .map((e) => `  → 「${idToLabel.get(e.target) ?? e.target}」${e.label ? ` [${e.label}]` : ''}`)
        .join('\n');
      const dataJson = JSON.stringify(node.data ?? {}, null, 1);
      const dataTrunc =
        dataJson.length > 1600 ? `${dataJson.slice(0, 1600)}\n…(内容截断,完整内容在检查器/表格编辑)` : dataJson;
      return {
        ok: true,
        result:
          `节点「${node.label}」 [${node.kind}] (id=${nodeId})\n` +
          `位置 (${node.position.x}, ${node.position.y})\n入边:\n${ins || '  (无)'}\n出边:\n${outs || '  (无)'}\ndata:\n${dataTrunc}`,
      };
    },
    'canvas.connectors': async () => ({
      ok: true,
      result: `节点类型:\n${nodeKindGuide()}\n\n可连线关系与端口语义:\n${connectorSummary()}`,
    }),
    // 分段读取文档节点全文:先看 chunk=0 结构,再按需逐段读(长文档不一次性全量返回)
    'document.read': async (a, ctx) => {
      const nodeId = String(a.nodeId ?? '');
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      const node = cur?.nodes.find((n) => n.id === nodeId);
      if (!node) return { ok: false, result: `节点 ${nodeId} 不存在` };
      if (node.kind !== 'document' && node.kind !== 'storyboard') {
        return { ok: false, result: `节点 ${nodeId} 不是文档节点(${node.kind})· document.read 只读 document/storyboard 的 markdown` };
      }
      const md = String((node.data as { markdown?: unknown } | undefined)?.markdown ?? '');
      if (!md.trim()) return { ok: false, result: `文档节点「${node.label}」内容为空(markdown 未填写)` };
      const size = Number(a.size ?? 0) > 0 ? Number(a.size) : 4000;
      const { chunks, totalChars, totalLines } = chunkText(md, { maxChars: size });
      if (chunks.length === 0) return { ok: false, result: `文档节点「${node.label}」无内容可读` };
      let idx = Number.isInteger(a.chunk) ? Number(a.chunk) : 0;
      if (idx < 0) idx = 0;
      if (idx >= chunks.length) {
        return {
          ok: false,
          result: `块序号越界:chunk=${idx},该文档共 ${chunks.length} 块(0–${chunks.length - 1})· 已读完全部;如需重新分析可从 chunk=0 再读`,
        };
      }
      const c = chunks[idx]!;
      const nav = chunkNav(chunks, c);
      const tail =
        idx < chunks.length - 1
          ? `\n---\n[继续读下一段] document.read(nodeId=${nodeId}, chunk=${idx + 1})· 剩余 ${chunks.length - 1 - idx} 段`
          : '\n---\n[本块是最后一段 · 全文已读完]';
      return {
        ok: true,
        result:
          `文档「${node.label}」(${node.kind})· ${totalLines} 行 / ${totalChars} 字符 · ${nav}\n` +
          `===== 第 ${idx + 1} 段(行 ${c.startLine}–${c.endLine})=====\n${c.text}${tail}`,
        nodeId,
      };
    },
    'storyboard.plan': async (a, ctx) => {
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      if (!cur) return { ok: false, result: '画布不存在' };
      let brief = String(a.brief ?? '');
      const rawNodeId = String(a.nodeId ?? '');
      /* ⚠️ 必须走 resolveNodeRef(2026-10-09 补):此前是裸 find(n => n.id === nodeId),
         模型把标题当 id 传回来时(真实事故形态)会静默拿不到 brief,报「需要 brief 文本」
         —— 用户明明传了一个存在的 document 节点,却被告知没给内容,无从排查。
         与 canvas.get_node / engine.submit 等入口同口径(id 精确优先 → 标题唯一才采用)。 */
      let nodeId = '';
      if (rawNodeId) {
        const hit = resolveNodeRefOrError(cur.nodes, rawNodeId, '节点');
        if (!hit.ok) return { ok: false, result: hit.error };
        nodeId = hit.node.id;
      }
      if (!brief.trim() && nodeId) {
        const src = cur.nodes.find((n) => n.id === nodeId);
        brief = String((src?.data as { markdown?: string } | undefined)?.markdown ?? '');
      }
      if (!brief.trim()) {
        return { ok: false, result: '需要 brief 文本,或 nodeId 指向一个有 markdown 的 document 节点' };
      }
      if (!this.planStoryboard) return { ok: false, result: '分镜表规划服务未注入(主进程未接线)' };
      const res = await this.planStoryboard(brief, {
        projectId: ctx.projectId,
        basePrompt: a.basePrompt ? String(a.basePrompt) : undefined,
        autoMaterialize: a.autoMaterialize === true,
      });
      const now = new Date().toISOString();
      const sb = res.storyboard;
      cur.nodes.push(sb);
      if (nodeId && cur.nodes.some((n) => n.id === nodeId)) {
        cur.edges.push({ id: nid('edge'), source: nodeId, target: sb.id, label: 'prompt' });
      }
      for (const n of [...res.images, ...res.shots]) cur.nodes.push(n);
      // 方案 A:LLM/规划器产出的边同样强制过校验,非法边丢弃并注明(不给画布留脏)
      let droppedEdges = 0;
      const keptEdges: CanvasEdge[] = [];
      for (const e of res.edges) {
        const v = validateEdge(cur.nodes, cur.edges.concat(keptEdges), e, {
          resolveAssetMedia: (assetId) => this.assets.get(assetId)?.kind,
        });
        if (v.ok) keptEdges.push(e);
        else droppedEdges++;
      }
      for (const e of keptEdges) cur.edges.push(e);
      cur.updatedAt = now;
      cur.version += 1;
      this.store.saveCanvasSnapshot(cur);
      const extra =
        res.shots.length || res.images.length
          ? ` · 已铺 ${res.shots.length} shot + ${res.images.length} image-gen${droppedEdges ? ` · 已丢弃 ${droppedEdges} 条非法连线(端口/媒体不匹配)` : ''}`
          : '';
      return { ok: true, result: `${res.report}${extra}`, nodeId: sb.id };
    },
    'storyboard.materialize': async (a, ctx) => {
      const rawNodeId = String(a.nodeId ?? '');
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      if (!cur) return { ok: false, result: '画布不存在' };
      /* ⚠️ 两级解析(2026-10-09 事故修复,二合一):
         ① **标题容错**:与 canvas.get_node / engine.submit 等入口同口径,模型把标题当 id 传时能救回;
         ② **失败必须给候选**:本工具原先是裸 find + 一句「不是分镜表节点」,
            模型传了一个**幻觉 id**(真实事故:传 storyboard-1791532265048-7l8p,
            该 id 在画布上根本不存在,它是把「项目简报的时间戳」和「storyboard 前缀」拼出来的),
            报错既不说画布上有哪些分镜表,也不说 id 长什么样 → 模型下一轮只能继续猜,
            而它甚至直接宣布「12 个 shot 已铺出」骗过了用户。
            现在 id 不存在时,把画布上**真实的分镜表节点**列出来,让模型照着改。 */
      const sbList = cur.nodes.filter((n) => n.kind === 'storyboard');
      const hit = resolveNodeRef(cur.nodes, rawNodeId);
      let sb = hit.node?.kind === 'storyboard' ? hit.node : undefined;
      if (!sb && hit.node) {
        // 解析到了节点但不是分镜表(如传了 document 的 id)→ 说清它是什么,并给出真正的分镜表
        return {
          ok: false,
          result: `节点「${hit.node.label || hit.node.id}」(id=${hit.node.id})是 ${hit.node.kind} 节点,不是分镜表(storyboard)${sbList.length ? `。画布上的分镜表:${sbList.map((n) => `「${n.label || n.id}」(id=${n.id})`).join('、')}` : '(画布上没有分镜表节点,请先用 storyboard.plan 生成)'}`,
        };
      }
      if (!sb) {
        if (hit.ambiguous.length > 0) {
          return {
            ok: false,
            result: `「${rawNodeId}」匹配到多个节点:${hit.ambiguous.map((n) => `「${n.label || n.id}」(id=${n.id})`).join('、')}。请改用 id 精确指定。`,
          };
        }
        return {
          ok: false,
          result: `节点 ${rawNodeId} 不存在${sbList.length ? `。画布上的分镜表:${sbList.map((n) => `「${n.label || n.id}」(id=${n.id})`).join('、')} —— 请用其中一个 id 重试,或先 canvas.list_nodes 现拉最新 id(不要凭记忆拼 id)` : '(画布上没有分镜表节点,请先用 storyboard.plan 生成)'}`,
        };
      }
      const nodeId = sb.id;
      const sd = (sb.data ?? {}) as Record<string, unknown>;
      const tb = parseGfmTable(String(sd.markdown ?? ''));
      if (!tb) return { ok: false, result: '分镜表缺少表格块 · 无法铺节点' };
      // 已铺行:由下游节点 promptFrom(与渲染层同口径)派生
      const doneRows = new Set<number>();
      for (const n of cur.nodes) {
        const ps = (n.data as { promptFrom?: PromptSource }).promptFrom;
        if (ps?.nodeId === nodeId && ps.mode === 'row' && typeof ps.row === 'number') doneRows.add(ps.row);
      }
      const base = String(sd.basePrompt ?? '');
      const aspect = String(a.aspect ?? sd.aspect ?? '16:9');
      const tier = String(a.tier ?? sd.tier ?? 'default');
      const size = SB_SIZE[aspect] ?? SB_SIZE['16:9']!;
      const now = new Date().toISOString();
      const gfm = tableToGfm(tb.head, tb.rows);
      const anchorX = sb.position.x ?? 60;
      const anchorY = sb.position.y ?? 80;
      let created = 0;
      let imgs = 0;
      /* 🚀 加速默认(2026-10-09):用户在设置页开了「新建 shot 默认开启加速」时,
         铺出来的每个 shot 都带上同一份 accel。取一次、循环内复用 —— 保证同一批节点
         的 packId/steps 完全一致(逐行各取一次会在用户中途改设置时产出参数不齐的一批)。
         未开启/无可用包 → null,不写 accel(存量行为不变)。 */
      const defaultAccel = this.accel?.defaultShotAccel() ?? null;
      tb.rows.forEach((row, r) => {
        const rowNo = r + 1;
        if (doneRows.has(rowNo)) return;
        const shotId = nid('shot');
        const p = assembleH3Prompt(row, tb.head, base);
        cur.nodes.push({
          id: shotId, kind: 'shot', label: `镜头 ${String(rowNo).padStart(2, '0')}`,
          position: { x: anchorX + 560, y: anchorY + r * 186 }, width: 250,
          data: {
            /* ⚠️ engine 必须与渲染层「+」弹层建 shot 同口径(h3c)。这里曾长期写死 'mock',
               后果是「用分镜表铺节点」得到的永远是 ffmpeg 占位片 —— 2026-10-09「测试1」
               事故:8 个镜头全部落 outputs/mock/,用户以为在跑真模型,实际上没走 h3。
               演示态由 settings.renderMode 决定(mock 只在 demo 模式启用),节点不该自己写死。 */
            engine: 'h3c', mode: 'text2video', prompt: p.text,
            width: size.width, height: size.height,
            seconds: rowSeconds(row, tb.head) || undefined,
            steps: 30, layers: 50, reuse: 1, tier, seed: 42 + r, refs: [],
            ...(defaultAccel ? { accel: defaultAccel } : {}),
            promptFrom: { nodeId, mode: 'row', row: rowNo } as PromptSource,
          } as CanvasNode['data'],
          createdAt: now, updatedAt: now,
        });
        cur.edges.push({ id: nid('edge'), source: nodeId, target: shotId, label: 'prompt' });
        created++;
        if (rowNeedsImage(row, tb.head)) {
          imgs++;
          const imgId = nid('img');
          const z = assembleZImagePrompt(row, tb.head, base);
          cur.nodes.push({
            id: imgId, kind: 'image-gen', label: `图片生成 · 分镜静帧 ${String(rowNo).padStart(2, '0')}`,
            position: { x: anchorX + 300, y: anchorY + r * 186 }, width: 232,
            data: {
              // 🆕 不写 model(2026-09-29 v1 工具模型):留给提交时缺省解析
              engine: 'mlxgen', prompt: z.text,
              width: size.width, height: size.height, steps: 24, guidance: 1.0, seeds: [42],
              promptFrom: { nodeId, mode: 'row', row: rowNo } as PromptSource,
            } as CanvasNode['data'],
            createdAt: now, updatedAt: now,
          });
          cur.edges.push({ id: nid('edge'), source: nodeId, target: imgId, label: 'prompt' });
          cur.edges.push({ id: nid('edge'), source: imgId, target: shotId, label: 'first-frame' });
        }
      });
      if (!created && !imgs) return { ok: true, result: '当前行均已铺出 · 新增行后可追加铺' };
      sb.data = { ...sd, lastTable: gfm } as CanvasNode['data'];
      sb.updatedAt = now;
      cur.updatedAt = now;
      cur.version += 1;
      this.store.saveCanvasSnapshot(cur);
      return {
        ok: true,
        result: `已从分镜表铺出 ${created} shot${imgs ? ` + ${imgs} image-gen` : ''}(共 ${created + imgs} 节点)· 未触发运行 · 改表后需「重新同步」`,
      };
    },
    'canvas.create_node': async (a, ctx) => {
      const kind = String(a.kind ?? 'document');
      const label = String(a.label ?? '新节点');
      /*
       * ── 未实现节点:创建入口下架(2026-10-08)──
       *
       * `director` / `workflow-input` / `workflow-output` 在渲染层没有任何执行分支,
       * 建出来就是「连得起来、点运行没反应」的空壳。以前只把它们的**面板入口**去掉还不够:
       * Agent 手里有 `canvas.create_node`,而且 systemPrompt 的节点清单会主动告诉它有哪些 kind ——
       * 不在这里拦,模型换个入口照样能把空壳节点建回画布(用户看到的是「Agent 建了个没用的节点」)。
       *
       * 拒绝而不是静默忽略:给模型一句**可执行的替代方案**,它才知道该改用什么。
       */
      if (isHiddenNodeKind(kind)) {
        return {
          ok: false,
          result: `节点类型「${kind}」尚未实现,已下架不可创建:${HIDDEN_NODE_REASONS[kind] ?? '没有执行分支'}。请改用已实现的节点(document/storyboard/asset/image-gen/image-edit/image-upscale/image-crop/image-stitch/image-split/frame-grab/video-upscale/shot/timeline/audio-ref)。`,
        };
      }
      // data 同样容忍字符串化(本地小模型常见退化;旧实现在这里直接当对象用,
      // 传字符串会让 `'refs' in rawData` 抛错或把字符串当 data 存进节点)
      const normCreate = normalizeDataArg((a as { data?: unknown }).data);
      if (!normCreate.ok) return { ok: false, result: normCreate.error };
      const rawData = normCreate.data;
      // 方案 B:refs 由连线推导,创建时直写 refs 一律忽略
      let refsNote = '';
      let data = rawData;
      if ('refs' in rawData) {
        const { refs: _ignored, ...rest } = rawData;
        data = rest;
        refsNote = ` · refs 由连线推导已忽略(用 canvas.connect 管理参考)`;
      }
      // 图片节点默认 engine/model/mode(与检查器/渲染层默认同口径)——真实事故:Agent 建 image-edit
      // 只写了 prompt,缺省模型落到 z-image 纯文生图,提交时 CLI auto 路由 latent i2i 缺参数报错
      // 🆕 不写 model(2026-09-29 v1 工具模型):留给 buildImageSubmitParams 按能力缺省解析;
      // Agent 显式传 model 仍优先(...data 在后)
      if (kind === 'image-edit') {
        data = { engine: 'mlxgen', mode: 'instruction', ...data };
      } else if (kind === 'image-gen') {
        data = { engine: 'mlxgen', ...data };
      } else if (kind === 'image-upscale') {
        data = { engine: 'mlxgen', ...data };
      } else if (kind === 'video-upscale') {
        // 本地后处理节点(无 engine/模型),默认走 POST_PROCESSING.md §9.1 标准配方:
        // Real-ESRGAN ×2(真人模型 realesrgan-x4plus)+ GFPGAN 修脸(强度 0.5),去块默认关
        data = {
          scale: 2,
          superRes: 'realesrgan',
          srModel: 'realesrgan-x4plus',
          faceModel: 'gfpgan',
          faceWeight: 0.5,
          device: 'mps',
          ...data,
        };
      }
      // 布尔字段归一化(与 update_node 同口径):模型常把 true 写成 "true",
      // 而渲染层判定全是严格 `=== true`(见 BOOLEAN_DATA_FIELDS 注释)
      data = normalizeBooleanFields(data) as typeof data;
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      if (!cur) return { ok: false, result: '画布不存在' };

      /*
       * ── shot 画幅缺省(2026-10,与渲染层「+」弹层同口径)──
       *
       * ⚠️ **分辨率一律由档位决定,绝不用图片尺寸**(2026-10 修正):
       * 曾经这里会把上游图片的宽高直接当视频尺寸写进 data —— 那等于让 4K 参考图
       * 把「预览档」顶成 4K 出片,用户选的档位失效、耗时与显存失控。
       * 现在:本函数只补**比例**(aspect),像素值一律查 `SHOT_SIZES[aspect][tier]`。
       *
       * 只在 data **缺 width/height** 时补,且档位取 data.tier(缺省 default)。
       */
      if (kind === 'shot') {
        const dd = data as Record<string, unknown>;
        const explicitW = Number(dd.width ?? 0);
        const explicitH = Number(dd.height ?? 0);
        if (explicitW <= 0 || explicitH <= 0) {
          const tier = (String(dd.tier ?? 'default') || 'default') as 'preview' | 'draft' | 'default' | 'reference';
          // 角色:Agent 可能已表达首帧/参考意图(data.mode)或经 refs;拿不到就不干预
          const role = String(dd.mode ?? '');
          const upstreamSize = (() => {
            const upId = (a as { from?: string }).from;
            const up = upId ? cur.nodes.find((n) => n.id === upId) : undefined;
            if (!up) return undefined;
            const ud = (up.data ?? {}) as Record<string, unknown>;
            if (up.kind === 'asset') {
              const asset = this.assets.get(String(ud.assetId ?? ''));
              if (asset?.width && asset?.height) return { width: asset.width, height: asset.height };
            }
            const w = Number(ud.width ?? 0);
            const h = Number(ud.height ?? 0);
            return w > 0 && h > 0 ? { width: w, height: h } : undefined;
          })();
          const roleAspect = defaultShotAspectForRole(role, upstreamSize);
          const aspect = roleAspect ?? (String(dd.aspect ?? '') || '16:9');
          const size = SHOT_SIZES[aspect as VideoAspect]?.[tier];
          if (size) {
            data = { engine: 'h3c', aspect, width: size.width, height: size.height, tier, ...dd } as Record<string, unknown>;
          }
        }
      }

      const now = new Date().toISOString();
      const node: CanvasNode = {
        id: nid(kind), kind: kind as CanvasNode['kind'], label,
        position: { x: Number(a.x ?? 80 + cur.nodes.length * 60), y: Number(a.y ?? 80) },
        width: Number(a.width ?? 236),
        data: data as CanvasNode['data'],
        createdAt: now, updatedAt: now,
      };
      cur.nodes.push(node);
      cur.updatedAt = now;
      cur.version += 1;
      this.store.saveCanvasSnapshot(cur);
      return { ok: true, result: `已创建节点「${label}」(${kind})${refsNote}`, nodeId: node.id };
    },
    'canvas.update_node': async (a, ctx) => {
      const rawId = String(a.nodeId ?? '');
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      if (!cur) return { ok: false, result: '画布不存在' };
      const hit = resolveNodeRefOrError(cur.nodes, rawId);
      if (!hit.ok) return { ok: false, result: hit.error };
      const node = hit.node;
      const nodeId = node.id;
      if (a.label !== undefined) node.label = String(a.label);
      let refsNote = '';
      // 参数规整:本地小模型常把嵌套对象序列化成 JSON 字符串再传(见 normalizeDataArg)。
      // 原实现 `typeof a.data === 'object'` 对字符串为 false → 整段 patch 被**静默跳过**
      // 却仍返回「✓ 已更新节点」= 假成功(2026-09-28 模型写了几百字 prompt、节点仍为空)。
      const norm = normalizeDataArg((a as { data?: unknown }).data);
      if (!norm.ok) return { ok: false, result: norm.error };
      let patch: Record<string, unknown> | undefined = Object.keys(norm.data).length > 0 ? { ...norm.data } : undefined;
      // 顶层 prompt 参数(B 方案,2026-09-28):长文本走**独立字符串参数**,不走 data 对象。
      //
      // 为什么:`data` 是 object,本地小模型总想把整个对象**序列化成 JSON 字符串**再传
      // (`data:"{\"prompt\":\"…\"}"`),转义符 + 引号放大输出量;而模型在 thinking 里往往
      // 还把内容再"想"一遍 —— 两者叠加把 maxTokens 烧光,JSON 被腰斩成非法值(实测在
      // 552 字符处截断),下一轮重试又截断,最终 0 工具调用 / 0 字回复。
      // 顶层 `prompt` 是**纯字符串参数**,模型没有"要不要序列化"的歧义空间,直击根因。
      //
      // 兼容:旧的 `data.prompt` 写法**保留有效**(见下方合并顺序),但工具描述里标注为不推荐。
      const topPrompt = (a as { prompt?: unknown }).prompt;
      if (typeof topPrompt === 'string') {
        patch = { ...(patch ?? {}), prompt: topPrompt };
      } else if (topPrompt !== undefined) {
        return { ok: false, result: `prompt 必须是字符串,收到 ${Array.isArray(topPrompt) ? '数组' : typeof topPrompt}。` };
      }
      if (patch) {
        // 布尔字段归一化:模型常把 true 写成 "true",而渲染层全是严格 `=== true` 判定
        // (见 BOOLEAN_DATA_FIELDS 注释,2026-10-09 modeOverride 事故)
        const norm = normalizeBooleanFields({ ...(node.data as Record<string, unknown>), ...patch });
        const next = { ...norm };
        // 方案 B:refs 由连线推导,直写 refs 一律忽略(消除双写漂移)
        if ('refs' in patch) {
          delete next.refs;
          refsNote = ' · refs 由连线推导已忽略(用 canvas.connect/disconnect 管理参考)';
        }
        node.data = next as CanvasNode['data'];
      }
      node.updatedAt = new Date().toISOString();
      cur.updatedAt = node.updatedAt;
      this.store.saveCanvasSnapshot(cur);
      // 写入后**回读校验**:请求里要写的关键字段必须真的落进 node.data。
      // 防的是「patch 因某种原因没生效但函数照样返回成功」——一次假的 ✓ 会让模型
      // 以为已完成而继续 engine.submit,错误被推到很远的地方(空 prompt 的 h3 exit 1)。
      const missed = patch
        ? Object.keys(patch).filter((k) => {
            if (k === 'refs') return false; // 有意忽略,不算未生效
            /* ⚠️ 期望值必须取**归一化后**的 patch,不能拿原始 patch 比(2026-10-09)。
               布尔字段在写入前被 normalizeBooleanFields 转过:
               patch 里是 "true"(字符串)、节点里存的是 true(布尔),
               拿原始 patch 比会 JSON.stringify('true') !== JSON.stringify(true) → 误报「未生效」,
               而其实写入完全成功。这类误报会让模型以为失败而反复重试。 */
            const expected = normalizeBooleanFields(patch)[k];
            return JSON.stringify((node.data as Record<string, unknown>)[k]) !== JSON.stringify(expected);
          })
        : [];
      if (missed.length > 0) {
        return { ok: false, result: `更新未生效(写入后校验失败):${missed.join('、')} 没有落进节点。请重试或检查参数类型。` };
      }
      return { ok: true, result: `已更新节点「${node.label}」${refsNote}`, nodeId };
    },
    'canvas.delete_node': async (a, ctx) => {
      const rawId = String(a.nodeId ?? '');
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      if (!cur) return { ok: false, result: '画布不存在' };
      const hit = resolveNodeRefOrError(cur.nodes, rawId);
      if (!hit.ok) return { ok: false, result: hit.error };
      const nodeId = hit.node.id;
      const before = cur.nodes.length;
      cur.nodes = cur.nodes.filter((n) => n.id !== nodeId);
      cur.edges = cur.edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
      if (cur.nodes.length === before) return { ok: false, result: `节点 ${nodeId} 不存在` };
      cur.updatedAt = new Date().toISOString();
      cur.version += 1;
      this.store.saveCanvasSnapshot(cur);
      return { ok: true, result: `已删除节点 ${nodeId} 及其连线`, nodeId };
    },
    'canvas.connect': async (a, ctx) => {
      const rawFrom = String(a.from ?? '');
      const rawTo = String(a.to ?? '');
      const label = String(a.label ?? '');
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      if (!cur) return { ok: false, result: '画布不存在' };
      // id 优先、标题兜底(模型常把 list_nodes 的标题当 id 传回;见 resolveNodeRef)
      const srcHit = resolveNodeRefOrError(cur.nodes, rawFrom, '源节点');
      if (!srcHit.ok) return { ok: false, result: srcHit.error };
      const dstHit = resolveNodeRefOrError(cur.nodes, rawTo, '目标节点');
      if (!dstHit.ok) return { ok: false, result: dstHit.error };
      const from = srcHit.node.id;
      const to = dstHit.node.id;
      if (cur.edges.some((e) => e.source === from && e.target === to)) return { ok: true, result: '连线已存在' };
      // 方案 A:写入点强制校验(端口合法性 + 媒体匹配 + 单值端口基数)
      const v = validateEdge(
        cur.nodes,
        cur.edges,
        { source: from, target: to, label },
        { resolveAssetMedia: (assetId) => this.assets.get(assetId)?.kind },
      );
      if (!v.ok) {
        const replaced = v.errors.find((e) => e.replaceable)?.replacedEdge;
        if (replaced) {
          // 方案 B:单值端口冲突 ⇒ 替换语义(旧边让位,新边生效;下游失效标记由渲染层 stale 机制承担)
          cur.edges = cur.edges.filter(
            (e) => !(e.source === replaced.source && e.target === replaced.target && e.label === replaced.label),
          );
          cur.edges.push({ id: nid('edge'), source: from, target: to, label });
          const dstNode = cur.nodes.find((n) => n.id === to);
          const modeNote = dstNode && applyShotModeSyncOnConnect(dstNode, cur.edges, label)
            ? ` · 已同步 mode=${String((dstNode.data as { mode?: string }).mode)}`
            : '';
          cur.updatedAt = new Date().toISOString();
          cur.version += 1;
          this.store.saveCanvasSnapshot(cur);
          return {
            ok: true,
            result: `已连线 ${from} → ${to}[${label}] · ⚠️ 单值端口冲突,已自动替换旧边 ${replaced.source} → ${replaced.target}[${replaced.label ?? ''}](旧来源不再生效,下游受影响节点会标记 stale)${modeNote}`,
          };
        }
        return { ok: false, result: `连线被拒绝:${v.errors[0]!.message}` };
      }
      cur.edges.push({ id: nid('edge'), source: from, target: to, label });
      const dstNode = cur.nodes.find((n) => n.id === to);
      const modeNote = dstNode && applyShotModeSyncOnConnect(dstNode, cur.edges, label)
        ? ` · 已同步 mode=${String((dstNode.data as { mode?: string }).mode)}`
        : '';
      cur.updatedAt = new Date().toISOString();
      cur.version += 1;
      this.store.saveCanvasSnapshot(cur);
      return { ok: true, result: `已连线 ${from} → ${to}[${label}]${modeNote}` };
    },
    'canvas.disconnect': async (a, ctx) => {
      const from = String(a.from ?? '');
      const to = String(a.to ?? '');
      const label = String(a.label ?? '');
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      if (!cur) return { ok: false, result: '画布不存在' };
      const removed = label
        ? cur.edges.filter((e) => e.source === from && e.target === to && (e.label ?? '') === label)
        : cur.edges.filter((e) => e.source === from && e.target === to);
      if (removed.length === 0) {
        return { ok: false, result: `连线不存在:${from} → ${to}${label ? ` [${label}]` : ''}` };
      }
      cur.edges = cur.edges.filter((e) => !removed.includes(e));
      cur.updatedAt = new Date().toISOString();
      cur.version += 1;
      this.store.saveCanvasSnapshot(cur);
      return {
        ok: true,
        result: `已移除 ${removed.length} 条连线:${from} → ${to}${label ? ` [${label}]` : ''}`,
      };
    },

    /* ── engine 域 ── */
    'engine.submit': async (a, ctx) => {
      const rawSubmitId = String(a.nodeId ?? '');
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      if (!cur) return { ok: false, result: '画布不存在' };
      // id 优先、标题兜底(与 canvas.get_node 同口径)
      const submitHit = resolveNodeRefOrError(cur.nodes, rawSubmitId, '节点');
      if (!submitHit.ok) return { ok: false, result: submitHit.error };
      const node = submitHit.node;
      const nodeId = node.id;
      if (node.kind === 'image-crop' || node.kind === 'image-stitch' || node.kind === 'image-split' || node.kind === 'frame-grab' || node.kind === 'video-upscale') {
        // 本地处理节点:不进渲染队列,主进程同步执行(ffmpeg 秒级;video-upscale 是分钟级长任务),产物回写 + 记 Take
        return this.runLocalImageNode(ctx, cur, node);
      }
      const isImage = node.kind === 'image-gen' || node.kind === 'image-edit' || node.kind === 'image-upscale' || node.kind === 'asset';
      // 方案 B+D:shot 的参考引用由连线推导(不再信任 agent 直写的 data.refs),提交前防呆拦截
      const d = (node.data ?? {}) as Record<string, unknown>;
      let references: Array<{ asset: import('@bigbotart/shared').Asset; role: string; localPath: string }> = [];
      let warnNote = '';
      if (node.kind === 'shot') {
        const refs = deriveShotRefsFromEdges(
          cur.nodes,
          cur.edges,
          nodeId,
          Array.isArray(d.refs) ? (d.refs as DerivedRef[]) : undefined,
          Array.isArray(d.refsSuppressed) ? (d.refsSuppressed as string[]) : undefined,
        );
        // 愈合存量「有 ref-image 边但 mode 仍文生」(测试技能2);写回节点让 UI/Take 一致
        const healed = healShotModeFromRefs(d, refs);
        if (healed) {
          node.data = healed as CanvasNode['data'];
          node.updatedAt = new Date().toISOString();
          Object.assign(d, healed);
          cur.updatedAt = node.updatedAt;
          cur.version += 1;
          this.store.saveCanvasSnapshot(cur);
        }
        const issues = validateRefsForSubmit(nodeId, 'shot', refs, d);
        const errs = issues.filter((i) => i.severity === 'error');
        if (errs.length > 0) return { ok: false, result: `提交被拒绝:${errs.map((i) => i.message).join('; ')}` };
        const warns = issues.filter((i) => i.severity === 'warn');
        if (warns.length > 0) warnNote = ` · 警告:${warns.map((i) => i.message).join('; ')}`;
        const now = new Date().toISOString();
        const resolved: Array<{ asset: import('@bigbotart/shared').Asset; role: string; localPath: string }> = [];
        for (const r of refs) {
          /* 音频参考的视频源 → 现场抽音轨(「视频节点 → 音频参考」连接器,2026-10-08)。
             派生层登记的是**视频路径**(纯函数不能有 ffmpeg 副作用),提交这一步换成 wav;
             抽不出来就明确失败 —— 让 h3 拿到一个 mp4 当音轨用只会得到一句看不懂的报错。 */
          let refPath = r.path;
          if (r.role === 'ref-audio' && refPath && /\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(refPath)) {
            const ex = await extractAudio(refPath);
            if (!ex.ok || !ex.path) {
              return { ok: false, result: `音频参考抽取失败:${ex.error ?? '未知错误'}` };
            }
            refPath = ex.path;
          }
          if (r.assetId) {
            const as = this.assets.get(r.assetId);
            if (!as) continue;
            resolved.push({ asset: as, role: r.role, localPath: as.localPath });
          } else if (refPath) {
            resolved.push({
              asset: {
                id: `shot-frame:${nodeId}`,
                kind: kindFromPath(refPath) ?? 'image',
                name: basenameOf(refPath),
                localPath: refPath,
                tags: [],
                createdAt: now,
              },
              role: r.role,
              localPath: refPath,
            });
          }
        }
        references = resolved;
        const mediaIssues = referenceMediaIssues(resolved.map((x) => ({ role: x.role, kind: x.asset.kind, path: x.localPath })));
        if (mediaIssues.length > 0) {
          return { ok: false, result: `提交被拒绝:${mediaIssues.map((i) => i.message).join('; ')}` };
        }
      }
      // image-gen / image-edit:ref-image 连线 → 参考图(多参考生成 / 2.1 多参考编辑;
      // mlxgen 侧对不支持的模型给指引报错。2026-09-29:此前只认 image-gen,
      // Agent 连到 image-edit 的参考图被静默丢弃,2.1 的 qwen21.edit 永远只有 1 张图)
      if (node.kind === 'image-gen' || node.kind === 'image-edit') {
        const refPaths = resolveRefImagePaths(cur, node, (id) => this.assets.get(id)?.localPath);
        const now = new Date().toISOString();
        for (const p of refPaths) {
          references.push({
            asset: {
              id: `ref:${basenameOf(p)}`,
              kind: 'image',
              name: basenameOf(p),
              localPath: p,
              tags: [],
              createdAt: now,
            },
            role: 'ref-image',
            localPath: p,
          });
        }
      }
      // 提交前防呆:视频节点必须有提示词。h3 会以 `h3: prompt must not be empty` 退 1,
      // 但那时任务已入队、错误发生在很远的地方(2026-09-28 正是被 update_node 的假成功
      // 推到这里才炸)。在入口拦下并给出**可执行的下一步**。
      if (node.kind === 'shot' && !String((node.data as { prompt?: string }).prompt ?? '').trim()) {
        return {
          ok: false,
          result: `「${node.label || nodeId}」的提示词为空,无法提交(生成视频必须有 prompt)。请先用 canvas.update_node 写 data.prompt(注意 data 要传**对象**,不要传 JSON 字符串),再 engine.submit。`,
        };
      }
      // image 类节点:kind 推导 + input 连线解析(直传 node.data 会让 image-edit 缺省成 generate 丢输入图)
      let submitParams: Record<string, unknown> = (node.data as Record<string, unknown>) ?? {};
      if (node.kind === 'image-gen' || node.kind === 'image-edit' || node.kind === 'image-upscale') {
        const built = buildImageSubmitParams(cur, node, (id) => this.assets.get(id)?.localPath, this.getToolModels?.());
        if (!built.ok) return { ok: false, result: built.error };
        submitParams = built.params;
      }
      /* 🚀 加速 LoRA 解析(2026-10-09 事故修复)。
       *
       * 问题:本工具**直接** `queue.submit`,绕过了渲染层的 `submit-render` IPC ——
       * 而 accel → `modelDir`(-d)+ `steps` 的解析只写在那个 IPC 里。
       * 后果:Agent 提交的视频即使节点开着加速(h3c.ts 只认 `params.modelDir`),
       * 也**永远走默认模型 + 默认步数**,加速静默失效 —— 与检查器显示的状态不符。
       * 这里补齐,与 index.ts 的 submit-render 同口径、同报错文案。 */
      const accelReq = submitParams.accel as { enabled?: boolean; packId?: string; steps?: number } | undefined;
      if (accelReq?.enabled && !isImage) {
        const resolved = this.accel?.resolveAccel(accelReq) ?? null;
        if (!resolved) {
          return {
            ok: false,
            result: '加速 LoRA 开启但模型包不可用(未安装或目录缺失) · 请到设置页「加速 LoRA」检查,或先用 canvas.update_node 关闭该节点的 data.accel',
          };
        }
        submitParams.modelDir = resolved.modelDir;
        submitParams.steps = resolved.steps;
      }
      /* ⚠️ 提交必须带全 projectId/canvasId/takeId,缺一个就会「生成成功但画布上什么都没有」
         (2026-09-28 真实事故):Agent 侧此前只传 provider/nodeId/slot/params/references,
         takeId 缺失 ⇒ 队列完成时 index.ts 的 onJobFinish 两个分支全落空(有 takeId 才 patch、
         没有则按 projectId 补 append)——Take 历史里根本没有这条任务;projectId 缺失更糟,
         连失败任务都不归档,**看门狗超时后完全无从回查**。
         渲染层 runNode 早已是同口径(先 takesCreate(queued) 拿 takeId 再提交),这里补齐对齐。 */
      let takeId: string | undefined;
      if (this.takes && ctx.projectId) {
        takeId = this.takes.append(ctx.projectId, {
          shotNodeId: nodeId,
          status: 'queued',
          params: { ...submitParams, __refRoles: references.map((r) => r.role) },
        }).id;
      }
      const handle = this.queue.submit({
        provider: (node.data as { engine?: string }).engine === 'mlxgen' ? 'mlxgen' : isImage ? 'mlxgen' : 'h3c',
        nodeId,
        slot: isImage ? 'image' : 'video',
        projectId: ctx.projectId || undefined,
        canvasId: ctx.canvasId || undefined,
        takeId,
        /* 标记 Agent 来源(2026-10-10 自动续跑):任务成功后 onJobFinish 据此唤醒
           Agent 自动推进任务链;用户在画布手点的提交不带此标记,不触发。 */
        source: 'agent',
        params: submitParams,
        references,
      });
      return { ok: true, result: `已提交生成任务(${handle.providerTaskId})${warnNote}`, nodeId };
    },
    'engine.queue_status': async () => {
      const jobs = this.queue.list();
      const lines = jobs.slice(-8).map((j) => `- [${j.status}] ${j.slot} ${j.nodeId} ${j.stage ?? ''}`).join('\n');
      return { ok: true, result: jobs.length ? `队列 ${jobs.length} 个任务:\n${lines}` : '队列空闲' };
    },
    'engine.cancel': async (a) => {
      const jobId = String(a.jobId ?? '');
      this.queue.cancel({ providerTaskId: jobId });
      return { ok: true, result: `已取消任务 ${jobId}` };
    },

    /* ── 加速 LoRA 域 ── */
    'accel.list': async () => {
      const packs = this.accel?.list() ?? [];
      if (packs.length === 0) {
        return { ok: true, result: '未安装加速 LoRA 蒸馏模型包 · 请先到设置页「加速 LoRA」安装;未开启加速时用常规档位生成' };
      }
      const lines = packs.map((p) => {
        const parts = [`- ${p.id} [${p.name}]`, p.steps ? `steps=${p.steps}` : 'steps=默认'];
        if (p.default) parts.push('· 默认');
        if (p.exists === false) parts.push('· ⚠️ 目录缺失,不可用');
        return parts.join(' ');
      });
      return { ok: true, result: `已安装加速 LoRA 蒸馏模型包:\n${lines.join('\n')}\n(镜头 data.accel={enabled:true, packId, steps} 开启;packId 用上面 id)` };
    },

    /* ── assets 域 ── */
    'assets.list': async () => {
      const list = this.assets.list();
      const lines = list.slice(0, 20).map((a) => `- ${a.id} [${a.kind}] ${a.name} (${a.width ?? '?'}×${a.height ?? '?'})`).join('\n');
      return { ok: true, result: `资产库 ${list.length} 项:\n${lines || '(空)'}` };
    },
    'assets.get': async (a) => {
      const asset = this.assets.get(String(a.assetId ?? ''));
      if (!asset) return { ok: false, result: '资产不存在' };
      return { ok: true, result: `${asset.name}: ${asset.kind} · ${asset.localPath}` };
    },
    // 资产导入:headless paths 仅允许应用数据/产物目录;任意本机文件必须 openDialog=true
    'assets.import': async (a) => {
      const paths = Array.isArray(a.paths)
        ? (a.paths as unknown[]).filter((p): p is string => typeof p === 'string' && p.length > 0)
        : [];
      const openDialog = a.openDialog === true;
      if (paths.length === 0 && !openDialog) {
        return { ok: false, result: '需要传 paths 数组(仅应用数据/产物目录)或 openDialog=true 弹出系统对话框' };
      }
      let res;
      try {
        res = openDialog
          ? await this.assets.importFromDialog()
          : await this.assets.importFromPaths(paths);
      } catch (e) {
        return { ok: false, result: `导入失败: ${(e as Error).message}` };
      }
      if (res.canceled) return { ok: false, result: '用户取消文件选择' };
      // 组装给 Agent 的人读摘要
      if (res.assets.length === 0 && res.failed.length === 0) {
        return { ok: false, result: '未选中任何文件' };
      }
      const okLines = res.assets.map((x) =>
        `- ${x.id} [${x.kind}] ${x.name}` +
        (x.width ? ` ${x.width}×${x.height}` : '') +
        (x.durationSec ? ` ${x.durationSec}s` : '') +
        ` mime=${x.mime ?? '-'}`,
      );
      const failLines = res.failed.map((f) => `- ❌ ${f.name}: ${f.error}`);
      const summary = [
        `导入完成:${res.assets.length} 个成功,${res.failed.length} 个失败`,
        ...okLines,
        ...failLines,
      ].join('\n');
      return {
        ok: res.failed.length === 0,
        result: summary + (res.failed.length > 0 && res.assets.length > 0 ? '\n(部分失败但有资产已加入)' : ''),
      };
    },

    /* ── frames 域:从视频抽一帧存成图片资源节点(ffmpeg 秒级同步) ── */
    /* ── vision 域:看图反推提示词(主对话模型纯文本,这是唯一的读图通道) ── */
    'vision.caption': async (a, ctx) => {
      // 参数校验优先于来源解析:非法 style 不该被「资产/节点不存在」抢先掩盖(报错要指向真因)
      const style = String(a.style ?? 'prompt');
      if (!['prompt', 'prompt-en', 'zimage', 'h3', 'json'].includes(style)) {
        return { ok: false, result: `style 非法: ${style}(可选 prompt=中文详述(默认)/ prompt-en=英文 / zimage=中文六段 / h3=中文五段 / json=结构化)` };
      }
      const nodeId = String(a.nodeId ?? '');
      const assetIdArg = String(a.assetId ?? '');
      if (!nodeId && !assetIdArg) {
        return { ok: false, result: '需要给图片来源:nodeId(画布节点)或 assetId(资产库)' };
      }
      // 来源解析:assetId 直取;nodeId 走画布产物解析(asset 节点 → 资产路径;其余 → data.resultPath)
      let imagePath: string | undefined;
      let srcLabel = '';
      const assetPath = (id: string) => this.assets.get(id)?.localPath;
      // 报错要给出**可执行的下一步**:模型曾把节点 id 当 assetId 传 → 「资产不存在」后
      // 绕道 assets.list 翻全库找 id(47 项),白烧 2 轮。这里直接告诉它去哪查。
      if (assetIdArg) {
        const asset = this.assets.get(assetIdArg);
        if (!asset) {
          return {
            ok: false,
            result:
              `资产 ${assetIdArg} 不存在。若你手上的其实是**画布节点 id**,请改用参数 nodeId;` +
              `要查真实资产 id 用 assets.list(或用 canvas.list_nodes 拿节点 id 后传 nodeId)。`,
          };
        }
        imagePath = asset.localPath;
        srcLabel = asset.name ?? assetIdArg;
      } else {
        const pc = this.store.loadProjectCanvases(ctx.projectId);
        const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
        // id 优先、标题兜底(与 canvas.get_node 同口径;模型常把标题当 id)
        const srcHit = cur ? resolveNodeRefOrError(cur.nodes, nodeId, '节点') : { ok: false as const, error: '画布不存在' };
        if (!srcHit.ok) {
          return {
            ok: false,
            result:
              `${srcHit.error}(提示:先用 canvas.list_nodes 拉当前画布的最新节点 id,不要用标题拼 id;` +
              `本工具需要**图片**来源,视频请先用 frames.extract 取帧)`,
          };
        }
        const srcNode = srcHit.node;
        srcLabel = srcNode.label || srcNode.id;
        imagePath = resolveNodeImagePath(srcNode, undefined, assetPath);
        if (!imagePath) {
          return {
            ok: false,
            result:
              `「${srcLabel}」没有可读的图片产物:asset 节点请确认已绑定资产;图片节点请先 engine.submit 生成。` +
              `若它是**视频**(如 shot / 视频资产),本工具看不了视频,请先用 frames.extract 取一帧再调本工具。`,
          };
        }
      }
      // 🆕 设置页「工具模型 → 看图反推」绑定(本地 mlxgen-caption / 端点),未配置则走 auto/env 回退链
      const overrideRoute = this.resolveVisionOverride ? await this.resolveVisionOverride() : undefined;
      const res = await captionImage(imagePath, style, a.extra ? String(a.extra) : undefined, overrideRoute);
      if (!res.ok || !res.caption) {
        // 决策 7(§4.2.1):未单独配置看图模型时,报错必须给出可执行的下一步 ——
        // 最常见的失败就是「回退到了无视觉能力的主 LLM」,裸错误用户无从下手
        const hint = overrideRoute
          ? ''
          : `。当前未单独配置看图模型(可能回退到了无视觉能力的端点,如 LM Studio 没在跑);` +
            `可到「设置 → 工具模型 → 看图反推」选「本地 · mlxgen-caption」(免 LM Studio,留空即自动发现本机 MLX Qwen3-VL),` +
            `或选一个视觉端点 / 设 BIGBOTART_VL_MODEL`;
        return { ok: false, result: `反推失败:${res.error ?? '未知错误'}${hint}` };
      }
      const via = res.backend === 'mlxgen' ? '本地引擎 mlxgen-caption' : '视觉端点';
      return {
        ok: true,
        result:
          `已用${via}(${res.model})反推「${srcLabel}」:\n\n${res.caption}\n\n` +
          (res.note ? `(注意:${res.note})\n` : '') +
          `(说明:这是对图片内容的文字描述,可据此填写 shot/image-gen 的 prompt;` +
          `需要调整侧重可再调本工具并传 extra)`,
      };
    },
    'frames.extract': async (a, ctx) => {
      const nodeId = String(a.nodeId ?? '');
      const videoPathArg = String(a.videoPath ?? '');
      if (!nodeId && !videoPathArg) {
        return { ok: false, result: '需要给视频来源:nodeId(画布节点)或 videoPath(绝对路径)' };
      }
      // at:first(默认)/ last / 数字(秒)。字符串数字也接受(模型常把 3.5 写成 "3.5")
      const rawAt = a.at ?? 'first';
      let mode: 'first' | 'last' | 'at' = 'first';
      let seconds: number | undefined;
      let atLabel = '首帧';
      if (typeof rawAt === 'string' && rawAt === 'last') {
        mode = 'last';
        atLabel = '尾帧';
      } else if (typeof rawAt === 'string' && rawAt === 'first') {
        mode = 'first';
      } else {
        const n = typeof rawAt === 'number' ? rawAt : Number(rawAt);
        if (!Number.isFinite(n) || n < 0) {
          return { ok: false, result: `取帧位置非法: ${String(rawAt)}(只接受 first / last / 非负秒数)` };
        }
        mode = 'at';
        seconds = n;
        atLabel = `第 ${n}s 帧`;
      }
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      if (!cur) return { ok: false, result: '画布不存在' };
      // 来源解析:nodeId 优先(走画布产物解析,含 asset 节点);否则用 videoPath(白名单在 frames.ts 内校验)
      let videoPath = videoPathArg;
      let srcNode: CanvasNode | undefined;
      if (nodeId) {
        // id 优先、标题兜底(与 canvas.get_node 同口径)
        const srcHit = resolveNodeRefOrError(cur.nodes, nodeId, '节点');
        if (!srcHit.ok) return { ok: false, result: srcHit.error };
        srcNode = srcHit.node;
        const resolved = resolveNodeVideoPath(srcNode, (id) => this.assets.get(id)?.localPath);
        if (!resolved) {
          return {
            ok: false,
            result: `「${srcNode.label || srcNode.id}」还没有视频产物,无法取帧:先 engine.submit 把它生成出来(或改用 videoPath 指定文件)`,
          };
        }
        videoPath = resolved;
      }
      const res = await extractFrame(videoPath, mode, seconds);
      if (!res.ok || !res.path) return { ok: false, result: `取帧失败:${res.error ?? '未知错误'}` };
      // 抽出的 PNG → 导入资产库(项目归属,walk 白名单:产物目录在允许范围内)
      let assetId: string | undefined;
      try {
        const imported = await this.assets.importFromPaths([res.path], { projectId: ctx.projectId });
        if (imported.assets.length > 0) assetId = imported.assets[0]!.id;
        else if (imported.failed.length > 0) {
          // 帧已抽出但入资产库失败:不能静默吞(R6),但也不必让整次调用失败——回传路径让 Agent 可继续
          return {
            ok: false,
            result: `已抽出帧但导入资产库失败:${imported.failed[0]!.error}(帧文件:${basenameOf(res.path)})`,
          };
        }
      } catch (e) {
        return { ok: false, result: `已抽出帧但导入资产库异常:${(e as Error).message}(帧文件:${basenameOf(res.path)})` };
      }
      const srcName = srcNode ? srcNode.label || srcNode.id : basenameOf(videoPath);
      const label = String(a.label ?? '').trim() || `${srcName} · ${atLabel}`;
      const now = new Date().toISOString();
      const node: CanvasNode = {
        id: nid('asset'),
        kind: 'asset',
        label,
        position: {
          // 默认落在来源节点右侧(无来源则沿用 create_node 的排布规律)
          x: Number(a.x ?? (srcNode ? srcNode.position.x + 300 : 80 + cur.nodes.length * 60)),
          y: Number(a.y ?? (srcNode ? srcNode.position.y : 80)),
        },
        width: 236,
        data: {
          assetId,
          // 记下取帧来源,便于检查器回看与后续「重新取帧」
          frameSource: { fromNodeId: srcNode?.id ?? null, videoPath, mode, seconds },
        } as CanvasNode['data'],
        createdAt: now,
        updatedAt: now,
      };
      cur.nodes.push(node);
      cur.updatedAt = now;
      cur.version += 1;
      this.store.saveCanvasSnapshot(cur);
      // 返回文案必须把「节点 id」与「资产 id」分开写清:两者长的很像(都以 asset- 开头),
      // 模型曾把节点 id 当 assetId 传给 vision.caption → 「资产不存在」,再绕道 assets.list
      // 翻全库找 id。这里显式标注用途,并顺带给下一步可用的工具。
      return {
        ok: true,
        result:
          `已抽出「${srcName}」的${atLabel},建为画布资源节点「${label}」· ${basenameOf(res.path)}\n` +
          `- 节点 id:${node.id}(画布操作用它:canvas.get_node / canvas.connect)\n` +
          `- 资产 id:${assetId ?? '(导入失败,无)'}(资产库操作与 vision.caption 的 assetId 用这个)\n` +
          `若要看这一帧的画面/反推提示词:vision.caption(nodeId="${node.id}") 或 vision.caption(assetId="${assetId ?? ''}")${seconds !== undefined ? `;该帧是视频第 ${seconds}s 处` : ''}`,
        nodeId: node.id,
      };
    },

    /* ── skills 域(画布模板 + Agent 指令段双形态,见 docs/Agent技能-指令模板与对话自动加载-产品设计与技术方案.md) ── */
    'skills.list': async () => {
      const list = this.skills.list();
      const lines = list.map((s) => `- ${s.id} ${s.name}(${s.nodes.length} 节点${s.instructions ? ' · 有操作指令' : ''})`).join('\n');
      return { ok: true, result: `Skills 库 ${list.length} 个:\n${lines || '(空)'}` };
    },
    'skills.read': async (a) => {
      const skill = this.skills.get(String(a.skillId ?? ''));
      if (!skill) return { ok: false, result: 'Skill 不存在' };
      if (!skill.instructions) return { ok: true, result: `Skill「${skill.name}」仅画布模板,无操作指令段` };
      const injectNote = skill.inject === 'summary' ? '(summary 模式:上下文只注摘要,以下为全文)' : '';
      return { ok: true, result: `【${skill.name} 操作指令】${injectNote}\n${skill.instructions}` };
    },
    'skills.activate': async (a, ctx) => {
      const skillId = String(a.skillId ?? '');
      const skill = this.skills.get(skillId);
      if (!skill) return { ok: false, result: 'Skill 不存在' };
      if (!ctx.canvasId) return { ok: false, result: '当前无画布上下文,无法激活' };
      this.memory.setActiveSkillId(ctx.projectId, ctx.canvasId, skillId);
      const preview = (skill.instructions ?? '').slice(0, 60).replace(/\n/g, ' ');
      return {
        ok: true,
        result: skill.instructions
          ? `已激活技能「${skill.name}」,操作指令已注入当前画布上下文${skill.inject === 'summary' ? '(summary 模式,可 skills.read 读全文)' : ''} · ${preview}…`
          : `已激活技能「${skill.name}」,但该技能无操作指令(仅画布模板)`,
      };
    },
    'skills.deactivate': async (_a, ctx) => {
      if (!ctx.canvasId) return { ok: false, result: '当前无画布上下文' };
      this.memory.setActiveSkillId(ctx.projectId, ctx.canvasId, null);
      return { ok: true, result: '已停用当前画布技能,不再注入指令' };
    },
    'skills.apply': async (a, ctx) => {
      const skillId = String(a.skillId ?? '');
      const projectName = String(a.projectName ?? `Skill 应用 ${Date.now()}`);
      try {
        const project = this.skills.apply(skillId, projectName, this.store);
        // 可选:应用后直接在新项目主画布激活该技能(铺结构 + 载入操作指令)
        if (a.activate === true) {
          const canvasId = project.activeCanvasId || 'main';
          this.memory.setActiveSkillId(project.id, canvasId, skillId);
          return { ok: true, result: `已应用 Skill 到新项目「${project.name}」(${project.id})并激活该技能指令` };
        }
        return { ok: true, result: `已应用 Skill 到新项目「${project.name}」(${project.id})` };
      } catch (e) {
        return { ok: false, result: `应用失败: ${(e as Error).message}` };
      }
    },
    'skills.save': async (a, ctx) => {
      const name = String(a.name ?? `画布模板 ${Date.now()}`);
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      if (!cur) return { ok: false, result: '当前画布不存在' };
      const instructions = a.instructions != null ? String(a.instructions) : undefined;
      const inject = instructions != null ? (a.inject === 'summary' ? 'summary' : 'full') : undefined;
      const skill = this.skills.save(name, cur, { instructions, inject });
      return {
        ok: true,
        result: `已保存 Skill「${skill.name}」(${skill.nodes.length} 节点${skill.instructions ? ' · 含操作指令段' : ''})`,
      };
    },

    /* ── timeline 域 ── */
    'timeline.export': async (a, ctx) => {
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      // 收集画布上有产物的 shot 节点
      const shots = (cur?.nodes ?? []).filter((n) => n.kind === 'shot');
      const clips = shots
        .map((n) => {
          const rp = (n.data as { resultPath?: string }).resultPath;
          return rp ? { path: rp, label: n.label, nodeId: n.id } : null;
        })
        .filter(Boolean) as Array<{ path: string; label: string; nodeId: string }>;
      if (clips.length === 0) return { ok: false, result: '画布上还没有已生成的镜头产物' };
      const res = this.exportSvc.submit({ projectId: ctx.projectId, clips, outputName: String(a.outputName ?? 'timeline') });
      return { ok: true, result: `已发起导出(${res.taskId}),${clips.length} 个片段合成中` };
    },

    /* ── memory 域 ── */
    'memory.update_core': async (a, ctx) => {
      const section = String(a.section ?? '') as 'projectGoal' | 'styleGuide' | 'constraints' | 'userPreferences';
      if (!['projectGoal', 'styleGuide', 'constraints', 'userPreferences'].includes(section)) {
        return { ok: false, result: `无效 section:${section}(可选 projectGoal/styleGuide/constraints/userPreferences)` };
      }
      this.memory.updateCore(ctx.projectId, section, String(a.content ?? ''));
      return { ok: true, result: `核心记忆已更新:${section}` };
    },
    'memory.remember': async (a, ctx) => {
      const text = String(a.text ?? '');
      const tags = Array.isArray(a.tags) ? a.tags.map(String) : [];
      if (!text) return { ok: false, result: '内容为空' };
      this.memory.addArchival(ctx.projectId, text, tags, ctx.canvasId);
      return { ok: true, result: '已记入项目记忆' };
    },
    'memory.recall_search': async (a, ctx) => {
      const q = String(a.query ?? '');
      const hits = this.memory.searchArchival(ctx.projectId, q, 5);
      return { ok: true, result: hits.length ? hits.map((h) => `- ${h.text}`).join('\n') : '没有相关记忆' };
    },

    /* ── continuity 域 ── */
    'continuity.check': async (_a, ctx) => {
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      const nodes = cur?.nodes ?? [];
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const shots = nodes.filter((n) => n.kind === 'shot');
      if (shots.length < 2) return { ok: true, result: '镜头不足 2 个,无需连续性校验' };
      // 基于图边:shot→shot 的接续边才是连续性依据(不再按节点数组顺序推断)
      const edges = (cur?.edges ?? []).filter((e) => {
        const s = byId.get(e.source);
        const t = byId.get(e.target);
        return s?.kind === 'shot' && t?.kind === 'shot';
      });
      if (edges.length === 0) {
        return {
          ok: true,
          result: `存在 ${shots.length} 个镜头但无 shot→shot 接续边 · 建议把镜头连成链后重跑校验`,
        };
      }
      const issues: string[] = [];
      for (const e of edges) {
        const sA = byId.get(e.source);
        const sB = byId.get(e.target);
        const a2 = (sA?.data ?? {}) as { resultPath?: string; tailFramePath?: string };
        const b2 = (sB?.data ?? {}) as { resultPath?: string };
        const name = sB?.label?.slice(0, 12) || e.target;
        if (!a2.resultPath) {
          issues.push(`建议先重跑上游镜头(尾帧未产出),再校验「${name}」接续`);
          continue;
        }
        if (!a2.tailFramePath) {
          issues.push(`上游尾帧未归档(待抽帧),「${name}」首帧参考缺失`);
          continue;
        }
        if (!b2.resultPath) {
          issues.push(`「${name}」未生成,首帧参考已备(上游尾帧)但缺镜头本体`);
          continue;
        }
        issues.push(`尾帧 → 「${name}」首帧:均已产出 ✓(骨架期仅查文件,建议人眼抽检)`);
      }
      return { ok: true, result: issues.length ? issues.join('\n') : '连续性:所有 shot→shot 接续边尾帧/首帧齐备' };
    },
  };

  /** 执行工具 */
  async call(tool: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const h = this.handlers[tool];
    if (!h) return { ok: false, result: `未知工具:${tool}` };
    try {
      return await h(args, ctx);
    } catch (e) {
      return { ok: false, result: `工具执行异常:${(e as Error).message}` };
    }
  }

  /**
   * ffmpeg 本地图片节点(image-crop / image-stitch / image-split)的 engine.submit 执行路径:
   * 同步执行(秒级,不进渲染队列)→ 记一条 succeeded Take → 产物路径/分片回写节点 data →
   * saveCanvasSnapshot 落盘并广播(渲染层据 canvas-snapshot-updated 同步)。
   * 与渲染层 runNode 快路径同口径(输入解析、Take 参数形状、data 字段一致)。
   */
  private async runLocalImageNode(ctx: ToolContext, cur: CanvasSnapshot, node: CanvasNode): Promise<ToolResult> {
    const d = (node.data ?? {}) as Record<string, unknown>;
    const assetPath = (id: string): string | undefined => (id ? this.assets.get(id)?.localPath : undefined);
    /* 🧹 兜底:旧版本渲染层把「生成中/排队中」这类瞬态标签写进过节点(它们不属于快照字段,
       重新加载后渲染层读不出来 → 卡片上永远挂着一个假的「生成中」)。提交前显式清掉。 */
    const staleUi = node as unknown as { badge?: unknown; running?: unknown };
    if (staleUi.badge !== undefined || staleUi.running !== undefined) {
      delete staleUi.badge;
      delete staleUi.running;
      cur.version += 1;
      this.store.saveCanvasSnapshot(cur);
    }
    /** Take 归档 + 产物回写 + 落盘(saveCanvasSnapshot 自带版本防护与写盘广播) */
    const finish = (resultPath: string, params: Record<string, unknown>, extra?: Record<string, unknown>): void => {
      const takeId = this.takes?.append(ctx.projectId, {
        shotNodeId: node.id,
        status: 'succeeded',
        resultPath,
        params,
      }).id;
      node.data = {
        ...(node.data as Record<string, unknown>),
        resultPath,
        ...(extra ?? {}),
        ...(takeId ? { currentTakeId: takeId } : {}),
      } as unknown as CanvasNode['data'];
      cur.updatedAt = new Date().toISOString();
      cur.version += 1;
      this.store.saveCanvasSnapshot(cur);
    };
    try {
      if (node.kind === 'video-upscale') return await this.runVideoUpscale(ctx, cur, node, assetPath);
      if (node.kind === 'image-crop') {
        const srcPath = resolveSingleImageInput(cur, node, assetPath);
        if (!srcPath) return { ok: false, result: '图片裁切需要输入图:把图片节点/asset 连到本节点(input 端口),或在检查器填输入图 Asset ID' };
        const aspect = String(d.aspect ?? '9:16');
        const focus = String(d.focus ?? 'center') as 'center' | 'top' | 'bottom' | 'left' | 'right';
        const res = await cropImage(srcPath, aspect, focus);
        if (!res.ok || !res.path) return { ok: false, result: `裁切失败:${res.error ?? '未知错误'}` };
        finish(res.path, { kind: 'crop', aspect, focus, inputPath: srcPath });
        return { ok: true, result: `已裁切至 ${aspect}:${basenameOf(res.path)}`, nodeId: node.id };
      }
      if (node.kind === 'frame-grab') {
        // 视频裁切取帧:输入**视频**(镜头成片 / 视频增强产物 / 视频素材),产出 PNG 并导入资产库
        const srcVideo = resolveSingleVideoInput(cur, node, assetPath);
        if (!srcVideo) {
          return {
            ok: false,
            result: '视频裁切取帧需要视频输入:把 镜头 / 视频增强 / 视频素材(asset) 连到本节点(input-video 端口),或在检查器填输入视频 Asset ID',
          };
        }
        const mode = String(d.mode ?? 'first') as 'first' | 'last' | 'at';
        const rawSec = Number(d.seconds);
        if (mode === 'at' && (!Number.isFinite(rawSec) || rawSec < 0)) {
          return { ok: false, result: '指定时间点取帧需要一个非负秒数(如 3.5)' };
        }
        const res = await extractFrame(srcVideo, mode, mode === 'at' ? rawSec : undefined);
        if (!res.ok || !res.path) return { ok: false, result: `取帧失败:${res.error ?? '未知错误'}` };
        // 产物 PNG → 导入资产库(source='product',归本项目);失败不阻断产物可用性
        let resultAssetId: string | undefined;
        try {
          const imported = await this.assets.importFromPaths([res.path], { projectId: ctx.projectId });
          if (imported.assets.length > 0) resultAssetId = imported.assets[0]!.id;
        } catch {
          /* 入资产库失败不影响节点产物 */
        }
        finish(
          res.path,
          { kind: 'frame-grab', mode, seconds: mode === 'at' ? rawSec : undefined, inputPath: srcVideo },
          resultAssetId ? { resultAssetId } : undefined,
        );
        const atLabel = mode === 'last' ? '尾帧' : mode === 'at' ? `第 ${rawSec}s 帧` : '首帧';
        return {
          ok: true,
          result: `已裁切「${basenameOf(srcVideo)}」的${atLabel} → 图片资源 ${basenameOf(res.path)}${resultAssetId ? `(资产 ${resultAssetId})` : '(未入资产库)'};产物是**图片**,可连给 图片编辑 / 图片增强 的 input 端口`,
          nodeId: node.id,
        };
      }
      if (node.kind === 'image-stitch') {
        const paths = resolveStitchInputs(cur, node, assetPath);
        if (paths.length < 2) return { ok: false, result: `图片拼接需要 ≥2 张有产物的拼接件(已解析 ${paths.length} 张):把多个图片节点/asset 连到本节点(piece 端口)` };
        const mode = String(d.mode ?? 'column') as 'row' | 'column' | 'grid';
        const gridCols = Number(d.gridCols ?? 3);
        const gap = Number(d.gap ?? 0);
        const bg = String(d.bg ?? 'white');
        const res = await stitchImages(paths, { mode, gridCols, gap, bg });
        if (!res.ok || !res.path) return { ok: false, result: `拼接失败:${res.error ?? '未知错误'}` };
        finish(res.path, { kind: 'stitch', mode, gridCols, gap, bg, inputs: paths });
        return { ok: true, result: `已拼接 ${paths.length} 张图:${basenameOf(res.path)}`, nodeId: node.id };
      }
      // image-split
      const srcPath = resolveSingleImageInput(cur, node, assetPath);
      if (!srcPath) return { ok: false, result: '图片拆分需要输入图:把图片节点/asset 连到本节点(input 端口),或在检查器填输入图 Asset ID' };
      const mode = String(d.mode ?? 'grid') as 'rows' | 'cols' | 'grid';
      const count = Number(d.count ?? 3);
      const gridCols = Number(d.gridCols ?? 3);
      const gridRows = Number(d.gridRows ?? 3);
      const res = await splitImage(srcPath, { mode, count, gridCols, gridRows });
      if (!res.ok || !res.paths || res.paths.length === 0) return { ok: false, result: `拆分失败:${res.error ?? '未知错误'}` };
      // resultPath = 第 1 片(下游不选片时的默认);pieces = 全部切片(piece-N 端口按序号取)
      const first = res.paths[0]!; // 上面已保证 paths.length > 0
      finish(first, { kind: 'split', mode, count, gridCols, gridRows, inputPath: srcPath, pieces: res.paths }, { pieces: res.paths });
      return { ok: true, result: `已拆分 ${res.paths.length} 片:${basenameOf(first)} 等`, nodeId: node.id };
    } catch (e) {
      return { ok: false, result: `本地图像处理异常:${(e as Error).message}`, nodeId: node.id };
    }
  }

  /**
   * video-upscale 节点执行路径:去块 → Real-ESRGAN 超分 → GFPGAN/CodeFormer 合修脸。
   *
   * ⚠️ 与另外三个本地节点不同,这是**分钟级长任务**(每帧 1.2-1.5s,20s 片约 10-12 分钟),
   * 工具调用会同步阻塞到出片;失败信息带工具链缺失指引(不让用户白等)。
   * 与渲染层 runNode 同口径:同样调 video-post.ts 的 videoUpscale(单一实现,无分叉)。
   */
  private async runVideoUpscale(
    ctx: ToolContext,
    cur: CanvasSnapshot,
    node: CanvasNode,
    assetPath: (assetId: string) => string | undefined,
  ): Promise<ToolResult> {
    const d = (node.data ?? {}) as Record<string, unknown>;
    const srcPath = resolveSingleVideoInput(cur, node, assetPath);
    if (!srcPath) {
      return {
        ok: false,
        result: `视频增强需要输入视频:把镜头(shot)成片或视频 asset 连到「${node.label || node.id}」的 input 端口,或在检查器填输入视频 Asset ID`,
      };
    }
    const req = {
      inputPath: srcPath,
      scale: Number(d.scale ?? 2),
      superRes: (d.superRes as 'realesrgan' | 'none' | undefined) ?? 'realesrgan',
      srModel: d.srModel as never,
      faceModel: d.faceModel as never,
      faceWeight: d.faceWeight === undefined ? undefined : Number(d.faceWeight),
      fidelityWeight: d.fidelityWeight === undefined ? undefined : Number(d.fidelityWeight),
      deblock: d.deblock === true,
      deblockCrf: d.deblockCrf === undefined ? undefined : Number(d.deblockCrf),
      crf: d.crf === undefined ? undefined : Number(d.crf),
      device: (d.device as 'mps' | 'cpu' | undefined) ?? 'mps',
    };
    const n = normalizeVideoPost(req);
    const tooling = probeVideoPostTooling();
    const toolErr = checkToolingFor(n, tooling);
    if (toolErr) return { ok: false, result: `工具链未就绪:${toolErr}(见 POST_PROCESSING.md)` };
    const meta = probeVideo(srcPath);
    const eta = estimateVideoPostSeconds(meta.durationSec ?? 0, meta.fps ?? 24, n);
    const res = await videoUpscale(req);
    if (!res.ok || !res.path) return { ok: false, result: `视频增强失败:${res.error ?? '未知错误'}`, nodeId: node.id };
    const applied = res.stages ?? planVideoPostStages(n);
    const takeId = this.takes?.append(ctx.projectId, {
      shotNodeId: node.id,
      status: 'succeeded',
      resultPath: res.path,
      params: { kind: 'video-upscale', ...req, inputPath: srcPath, stages: applied },
      durationSec: res.durationSec,
      elapsedSec: res.elapsedSec,
    }).id;
    node.data = {
      ...(node.data as Record<string, unknown>),
      resultPath: res.path,
      appliedStages: applied,
      durationSec: res.durationSec,
      width: res.width,
      height: res.height,
      ...(takeId ? { currentTakeId: takeId } : {}),
    } as unknown as CanvasNode['data'];
    cur.updatedAt = new Date().toISOString();
    cur.version += 1;
    this.store.saveCanvasSnapshot(cur);
    const etaNote = eta > 0 ? `(预估 ${Math.round(eta / 60)} 分钟,实际 ${res.elapsedSec ?? '?'}s)` : '';
    return {
      ok: true,
      result:
        `视频增强完成${etaNote}:${basenameOf(res.path)}\n` +
        `执行阶段:${applied.join(' → ')}\n` +
        (res.width && res.height ? `输出 ${res.width}×${res.height} · ${res.durationSec ?? '?'}s` : ''),
      nodeId: node.id,
    };
  }

}