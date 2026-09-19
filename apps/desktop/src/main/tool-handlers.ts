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
  type PromptSource,
} from '@bigbotart/shared';
import type { ProjectStore } from './store';
import type { AssetStore } from './assets';
import type { SkillStore } from './skills';
import type { ExportService } from './export';
import type { RenderQueue } from './render-queue';
import type { MemoryStore } from './memory';
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

  constructor(
    private store: ProjectStore,
    private assets: AssetStore,
    private skills: SkillStore,
    private exportSvc: ExportService,
    private queue: RenderQueue,
    private memory: MemoryStore,
    opts: { planStoryboard?: StoryboardPlanFn } = {},
  ) {
    this.planStoryboard = opts.planStoryboard;
  }

  /** 工具路由表 */
  private handlers: Record<string, Handler> = {
    /* ── canvas 域 ── */
    'canvas.list_nodes': async (_a, ctx) => {
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      if (!cur) return { ok: false, result: '画布不存在' };
      const lines = cur.nodes.map((n) => `- ${n.id} [${n.kind}] ${n.label}`).join('\n');
      return { ok: true, result: `当前画布 ${cur.nodes.length} 个节点:\n${lines || '(空)'}` };
    },
    'canvas.get_node': async (a, ctx) => {
      const nodeId = String(a.nodeId ?? '');
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      const node = cur?.nodes.find((n) => n.id === nodeId);
      if (!node) return { ok: false, result: `节点 ${nodeId} 不存在` };
      const ins = (cur?.edges ?? [])
        .filter((e) => e.target === nodeId)
        .map((e) => `  ← ${e.source}${e.label ? ` [${e.label}]` : ''}`)
        .join('\n');
      const outs = (cur?.edges ?? [])
        .filter((e) => e.source === nodeId)
        .map((e) => `  → ${e.target}${e.label ? ` [${e.label}]` : ''}`)
        .join('\n');
      const dataJson = JSON.stringify(node.data ?? {}, null, 1);
      const dataTrunc =
        dataJson.length > 1600 ? `${dataJson.slice(0, 1600)}\n…(内容截断,完整内容在检查器/表格编辑)` : dataJson;
      return {
        ok: true,
        result:
          `节点 ${nodeId}\n[${node.kind}] ${node.label}\n` +
          `位置 (${node.position.x}, ${node.position.y})\n入边:\n${ins || '  (无)'}\n出边:\n${outs || '  (无)'}\ndata:\n${dataTrunc}`,
      };
    },
    'canvas.connectors': async () => ({
      ok: true,
      result: `节点类型:\n${nodeKindGuide()}\n\n可连线关系与端口语义:\n${connectorSummary()}`,
    }),
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
      for (const e of res.edges) cur.edges.push(e);
      cur.updatedAt = now;
      cur.version += 1;
      this.store.saveCanvasSnapshot(cur);
      const extra =
        res.shots.length || res.images.length
          ? ` · 已铺 ${res.shots.length} shot + ${res.images.length} image-gen`
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
      const data = (a.data as Record<string, unknown>) ?? {};
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
      return { ok: true, result: `已创建节点「${label}」(${kind})`, nodeId: node.id };
    },
    'canvas.update_node': async (a, ctx) => {
      const nodeId = String(a.nodeId ?? '');
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      const node = cur?.nodes.find((n) => n.id === nodeId);
      if (!node) return { ok: false, result: `节点 ${nodeId} 不存在` };
      if (a.label !== undefined) node.label = String(a.label);
      if (a.data && typeof a.data === 'object') {
        node.data = { ...(node.data as Record<string, unknown>), ...(a.data as Record<string, unknown>) } as CanvasNode['data'];
      }
      node.updatedAt = new Date().toISOString();
      if (cur) { cur.updatedAt = node.updatedAt; this.store.saveCanvasSnapshot(cur); }
      return { ok: true, result: `已更新节点「${node.label}」`, nodeId };
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
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      if (!cur) return { ok: false, result: '画布不存在' };
      if (!cur.nodes.some((n) => n.id === from)) return { ok: false, result: `源节点 ${from} 不存在` };
      if (!cur.nodes.some((n) => n.id === to)) return { ok: false, result: `目标节点 ${to} 不存在` };
      if (cur.edges.some((e) => e.source === from && e.target === to)) return { ok: true, result: '连线已存在' };
      cur.edges.push({ id: nid('edge'), source: from, target: to, label: String(a.label ?? '') });
      cur.updatedAt = new Date().toISOString();
      cur.version += 1;
      this.store.saveCanvasSnapshot(cur);
      return { ok: true, result: `已连线 ${from} → ${to}` };
    },

    /* ── engine 域 ── */
    'engine.submit': async (a, ctx) => {
      const nodeId = String(a.nodeId ?? '');
      const pc = this.store.loadProjectCanvases(ctx.projectId);
      const cur = pc.canvases.find((c) => c.id === ctx.canvasId);
      const node = cur?.nodes.find((n) => n.id === nodeId);
      if (!node) return { ok: false, result: `节点 ${nodeId} 不存在` };
      const isImage = node.kind === 'image-gen' || node.kind === 'image-edit' || node.kind === 'image-upscale' || node.kind === 'asset';
      const handle = this.queue.submit({
        provider: (node.data as { engine?: string }).engine === 'mlxgen' ? 'mlxgen' : isImage ? 'mlxgen' : 'h3c',
        nodeId,
        slot: isImage ? 'image' : 'video',
        params: (node.data as Record<string, unknown>) ?? {},
        references: [],
      });
      return { ok: true, result: `已提交生成任务(${handle.providerTaskId})`, nodeId };
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

    /* ── skills 域 ── */
    'skills.list': async () => {
      const list = this.skills.list();
      const lines = list.map((s) => `- ${s.id} ${s.name}(${s.nodes.length} 节点)`).join('\n');
      return { ok: true, result: `Skills 库 ${list.length} 个:\n${lines || '(空)'}` };
    },
    'skills.apply': async (a, ctx) => {
      const skillId = String(a.skillId ?? '');
      const projectName = String(a.projectName ?? `Skill 应用 ${Date.now()}`);
      try {
        const project = this.skills.apply(skillId, projectName, this.store);
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
      const skill = this.skills.save(name, cur);
      return { ok: true, result: `已保存 Skill「${skill.name}」(${skill.nodes.length} 节点)` };
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

}