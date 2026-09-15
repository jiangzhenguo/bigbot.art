/**
 * 工具桥 — Agent 可调用的工具 handler 集合
 * worker 通过反向 JSON-RPC 调主进程,主进程路由到这里执行,结果回传 worker
 *
 * 七域:canvas / engine / assets / skills / timeline / memory / continuity
 * 设计原则:每个工具返回 { ok, result(人读摘要), nodeId? } — 渲染层据此画工具卡
 */
import type { CanvasNode, CanvasEdge, CanvasSnapshot } from '@bigbotart/shared';
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

export class ToolHandlers {
  constructor(
    private store: ProjectStore,
    private assets: AssetStore,
    private skills: SkillStore,
    private exportSvc: ExportService,
    private queue: RenderQueue,
    private memory: MemoryStore,
  ) {}

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
          : this.assets.importFromPaths(paths);
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
      const shots = (cur?.nodes ?? []).filter((n) => n.kind === 'shot');
      if (shots.length < 2) return { ok: true, result: '镜头不足 2 个,无需连续性校验' };
      const issues: string[] = [];
      for (let i = 0; i < shots.length - 1; i++) {
        const sA = shots[i];
        const sB = shots[i + 1];
        if (!sA || !sB) continue;
        const a2 = sA.data as { resultPath?: string };
        const b2 = sB.data as { resultPath?: string };
        if (!a2.resultPath || !b2.resultPath) continue;
        // TODO: 真视觉比对(ffmpeg 抽尾帧/首帧 + 像素差异);骨架期基于文件存在性提示
        issues.push(`镜${i + 1}→镜${i + 2}:尾帧/首帧均已产出,建议人眼抽检或后续接入视觉比对`);
      }
      return { ok: true, result: issues.length ? issues.join('\n') : '连续性:所有相邻镜头的尾帧/首帧都齐备' };
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