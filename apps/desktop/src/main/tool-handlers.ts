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
  type DerivedRef,
  type PromptSource,
} from '@bigbotart/shared';
import type { ProjectStore } from './store';
import type { AssetStore } from './assets';
import type { SkillStore } from './skills';
import type { ExportService } from './export';
import type { RenderQueue } from './render-queue';
import type { AccelStore } from './lora';
import type { MemoryStore } from './memory';
import type { TakeStore } from './takes';
import { cropImage } from './frames';
import { stitchImages, splitImage } from './stitch';
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

/** image-gen 的参考图输入:ref-image 入边 → 上游图片路径数组(资产节点取资产路径,产物节点取 resultPath)。
 *  真实事故:Agent 连了两张参考图到 image-gen,提交时 references 只给 shot 推导,
 *  图片节点的 ref-image 边被静默丢弃,生成了纯文生图。 */
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
): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const params: Record<string, unknown> = { ...d };
  params.kind =
    node.kind === 'image-upscale' ? 'upscale' : node.kind === 'image-edit' ? String(d.mode ?? 'instruction') : 'generate';
  if (node.kind === 'image-edit' || node.kind === 'image-upscale') {
    if (!params.inputPath) {
      const input = resolveSingleImageInput(canvas, node, assetPath);
      if (input) params.inputPath = input;
    }
    if (!params.inputPath) {
      return {
        ok: false,
        error: `节点「${node.label || node.id}」没有输入图:请先用 canvas.connect 把图片/资产节点连到它的 input 端口`,
      };
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

  constructor(
    private store: ProjectStore,
    private assets: AssetStore,
    private skills: SkillStore,
    private exportSvc: ExportService,
    private queue: RenderQueue,
    private memory: MemoryStore,
    opts: { planStoryboard?: StoryboardPlanFn; accel?: AccelStore; takes?: TakeStore } = {},
  ) {
    this.planStoryboard = opts.planStoryboard;
    this.accel = opts.accel;
    this.takes = opts.takes;
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
      const nodeId = String(a.nodeId ?? '');
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      const node = cur?.nodes.find((n) => n.id === nodeId);
      if (!node) return { ok: false, result: `节点 ${nodeId} 不存在` };
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
      const nodeId = String(a.nodeId ?? '');
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
      const nodeId = String(a.nodeId ?? '');
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      if (!cur) return { ok: false, result: '画布不存在' };
      const sb = cur.nodes.find((n) => n.id === nodeId && n.kind === 'storyboard');
      if (!sb) return { ok: false, result: `节点 ${nodeId} 不是分镜表(storyboard)节点` };
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
      tb.rows.forEach((row, r) => {
        const rowNo = r + 1;
        if (doneRows.has(rowNo)) return;
        const shotId = nid('shot');
        const p = assembleH3Prompt(row, tb.head, base);
        cur.nodes.push({
          id: shotId, kind: 'shot', label: `镜头 ${String(rowNo).padStart(2, '0')}`,
          position: { x: anchorX + 560, y: anchorY + r * 186 }, width: 250,
          data: {
            engine: 'mock', mode: 'text2video', prompt: p.text,
            width: size.width, height: size.height,
            seconds: rowSeconds(row, tb.head) || undefined,
            steps: 30, layers: 50, reuse: 1, tier, seed: 42 + r, refs: [],
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
              engine: 'mlxgen', model: 'AbstractFramework/z-image-turbo-8bit', prompt: z.text,
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
      const rawData = (a.data as Record<string, unknown>) ?? {};
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
      if (kind === 'image-edit') {
        data = { engine: 'mlxgen', model: 'mlx-community/Qwen-Image-Edit-8bit', mode: 'instruction', ...data };
      } else if (kind === 'image-gen') {
        data = { engine: 'mlxgen', model: 'AbstractFramework/z-image-turbo-8bit', ...data };
      } else if (kind === 'image-upscale') {
        data = { engine: 'mlxgen', model: 'AbstractFramework/seedvr2-3b-8bit', ...data };
      }
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      if (!cur) return { ok: false, result: '画布不存在' };
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
      const nodeId = String(a.nodeId ?? '');
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      const node = cur?.nodes.find((n) => n.id === nodeId);
      if (!node) return { ok: false, result: `节点 ${nodeId} 不存在` };
      if (a.label !== undefined) node.label = String(a.label);
      let refsNote = '';
      if (a.data && typeof a.data === 'object') {
        const patch = a.data as Record<string, unknown>;
        const next = { ...(node.data as Record<string, unknown>), ...patch };
        // 方案 B:refs 由连线推导,直写 refs 一律忽略(消除双写漂移)
        if ('refs' in patch) {
          delete next.refs;
          refsNote = ' · refs 由连线推导已忽略(用 canvas.connect/disconnect 管理参考)';
        }
        node.data = next as CanvasNode['data'];
      }
      node.updatedAt = new Date().toISOString();
      if (cur) { cur.updatedAt = node.updatedAt; this.store.saveCanvasSnapshot(cur); }
      return { ok: true, result: `已更新节点「${node.label}」${refsNote}`, nodeId };
    },
    'canvas.delete_node': async (a, ctx) => {
      const nodeId = String(a.nodeId ?? '');
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      if (!cur) return { ok: false, result: '画布不存在' };
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
      const from = String(a.from ?? '');
      const to = String(a.to ?? '');
      const label = String(a.label ?? '');
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      if (!cur) return { ok: false, result: '画布不存在' };
      if (!cur.nodes.some((n) => n.id === from)) return { ok: false, result: `源节点 ${from} 不存在` };
      if (!cur.nodes.some((n) => n.id === to)) return { ok: false, result: `目标节点 ${to} 不存在` };
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
          cur.updatedAt = new Date().toISOString();
          cur.version += 1;
          this.store.saveCanvasSnapshot(cur);
          return {
            ok: true,
            result: `已连线 ${from} → ${to}[${label}] · ⚠️ 单值端口冲突,已自动替换旧边 ${replaced.source} → ${replaced.target}[${replaced.label ?? ''}](旧来源不再生效,下游受影响节点会标记 stale)`,
          };
        }
        return { ok: false, result: `连线被拒绝:${v.errors[0]!.message}` };
      }
      cur.edges.push({ id: nid('edge'), source: from, target: to, label });
      cur.updatedAt = new Date().toISOString();
      cur.version += 1;
      this.store.saveCanvasSnapshot(cur);
      return { ok: true, result: `已连线 ${from} → ${to}[${label}]` };
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
      const nodeId = String(a.nodeId ?? '');
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      const node = cur?.nodes.find((n) => n.id === nodeId);
      if (!node) return { ok: false, result: `节点 ${nodeId} 不存在` };
      if (!cur) return { ok: false, result: '画布不存在' };
      if (node.kind === 'image-crop' || node.kind === 'image-stitch' || node.kind === 'image-split') {
        // ffmpeg 本地节点:不进渲染队列,主进程同步执行(秒级),输入由连线解析,产物回写 + 记 Take
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
        const issues = validateRefsForSubmit(nodeId, 'shot', refs, d);
        const errs = issues.filter((i) => i.severity === 'error');
        if (errs.length > 0) return { ok: false, result: `提交被拒绝:${errs.map((i) => i.message).join('; ')}` };
        const warns = issues.filter((i) => i.severity === 'warn');
        if (warns.length > 0) warnNote = ` · 警告:${warns.map((i) => i.message).join('; ')}`;
        const now = new Date().toISOString();
        const resolved: Array<{ asset: import('@bigbotart/shared').Asset; role: string; localPath: string }> = [];
        for (const r of refs) {
          if (r.assetId) {
            const as = this.assets.get(r.assetId);
            if (!as) continue;
            resolved.push({ asset: as, role: r.role, localPath: as.localPath });
          } else if (r.path) {
            resolved.push({
              asset: {
                id: `shot-frame:${nodeId}`,
                kind: kindFromPath(r.path) ?? 'image',
                name: basenameOf(r.path),
                localPath: r.path,
                tags: [],
                createdAt: now,
              },
              role: r.role,
              localPath: r.path,
            });
          }
        }
        references = resolved;
        const mediaIssues = referenceMediaIssues(resolved.map((x) => ({ role: x.role, kind: x.asset.kind, path: x.localPath })));
        if (mediaIssues.length > 0) {
          return { ok: false, result: `提交被拒绝:${mediaIssues.map((i) => i.message).join('; ')}` };
        }
      }
      // image-gen:ref-image 连线 → 参考图(多参考生成;mlxgen 侧对不支持的模型给指引报错)
      if (node.kind === 'image-gen') {
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
      // image 类节点:kind 推导 + input 连线解析(直传 node.data 会让 image-edit 缺省成 generate 丢输入图)
      let submitParams: Record<string, unknown> = (node.data as Record<string, unknown>) ?? {};
      if (node.kind === 'image-gen' || node.kind === 'image-edit' || node.kind === 'image-upscale') {
        const built = buildImageSubmitParams(cur, node, (id) => this.assets.get(id)?.localPath);
        if (!built.ok) return { ok: false, result: built.error };
        submitParams = built.params;
      }
      const handle = this.queue.submit({
        provider: (node.data as { engine?: string }).engine === 'mlxgen' ? 'mlxgen' : isImage ? 'mlxgen' : 'h3c',
        nodeId,
        slot: isImage ? 'image' : 'video',
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

}