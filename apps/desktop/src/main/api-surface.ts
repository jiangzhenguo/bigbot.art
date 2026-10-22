/**
 * 桌面 IPC 业务面。
 *
 * 从 index.ts 原样搬出:handler 体不改行为,闭包依赖收成 ctx。
 * 模块级窗口不能在注册时按值解构(那时还是 null),发送当时用 getWin() 再读。
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
} from 'electron';
import {
  join,
  resolve,
  basename,
} from 'node:path';
import {
  existsSync,
  statSync,
  copyFileSync,
} from 'node:fs';
import { createRegistry } from '@bigbotart/providers';
import type { AgentManager } from '@bigbotart/agent';
import type { ProjectStore } from './store';
import type { SettingsStore } from './settings';
import type { AccelStore } from './lora';
import type { H3StyleModelBuilder } from './h3-style-model';
import {
  OUTPUTS_DIR,
  collectAssetRefs,
  syncAssetNodeLabels,
  listArchivableProducts,
  isUnderRoot,
  importAllowRoots,
  ffmpegReadRoots,
} from './assets';
import type { AssetStore } from './assets';
import { probeMediaInfo } from './media-probe';
import type { SkillStore } from './skills';
import { loadSkillPackage } from './skill-import';
import { resolveExportFile } from './export';
import type { ExportService } from './export';
import {
  exportProject,
  importProjectFromFile,
} from './project-package';
import {
  coverOf,
  listProjectCovers,
  setCoverAsset,
  clearCover,
  isUsableCoverFile,
} from './project-cover';
import {
  extractFrame,
  extractAudio,
  cropImage,
} from './frames';
import {
  stitchImages,
  splitImage,
} from './stitch';
import {
  videoUpscale,
  probeVideoPostTooling,
  cancelVideoPost,
  listRunningVideoPost,
  lastVideoPostProgress,
} from './video-post';
import type { RenderQueue } from './render-queue';
import type { AutoContinueController } from './auto-continue';
import {
  COMPACT_KEEP_LAST,
  compactFallbackSummary,
} from './memory';
import type { MemoryStore } from './memory';
import type { TakeStore } from './takes';
import { DATA_DIR } from './workspace-paths';
import type { DebugLogger } from './logger';
import {
  applyThemeSource,
  normalizeTheme,
  syncWindowBackground,
} from './theme';
import {
  mlxgenModelInfo,
  mlxgenDownload,
  mlxgenDownloadStatus,
  mlxgenDownloadActive,
  mlxgenDownloadCancel,
} from './mlxgen-models';
import { installRuntime } from './runtime-install';
import { runSelfCheck } from './selfcheck';
import {
  credentialDelete,
  credentialGet,
  credentialSet,
  listLmStudio,
  listOllama,
  listPiMlx,
  listRemoteModels,
  loadLmStudio,
  loadOllama,
  loadPiMlx,
  resolveLlmEndpoint,
  testConnection,
  toChatLlm,
} from './llm';
import type {
  RuntimeProbe,
  RenderRequest,
  LlmSource,
  RenderStatus,
  AgentChatRequest,
  AgentChatResponse,
  RecallMessage,
  VideoUpscaleRequest,
  VideoPostProgressEvent,
  MediaInfo,
  MediaKind,
  ProjectExportRequest,
  ProjectExportResult,
  ProjectImportResult,
  ProjectCover,
} from '@bigbotart/shared';
import {
  referenceMediaIssues,
  referenceAnchorConflictIssues,
} from '@bigbotart/shared';

export interface DesktopIpcDeps {
  logger: DebugLogger;
  registry: ReturnType<typeof createRegistry>;
  queue: RenderQueue;
  store: ProjectStore;
  assets: AssetStore;
  skills: SkillStore;
  memory: MemoryStore;
  takes: TakeStore;
  exportSvc: ExportService;
  settings: SettingsStore;
  accel: AccelStore;
  styleModels: H3StyleModelBuilder;
  agent: AgentManager;
  autoContinue: AutoContinueController;
  /** 注册当时窗口还没建;推送时再读 index.ts 里的那一个 live binding */
  getWin: () => BrowserWindow | null;
  /** 进程内扇出(EventHub.publish)。进度类事件不要再只推给一个窗口。 */
  publish: (channel: string, payload: unknown) => void;
  probeSimple: (id: RuntimeProbe['id'], label: string, port: number) => Promise<RuntimeProbe>;
  executeAgentChat: (opts: {
    projectId: string;
    canvasId: string;
    text: string;
    attachments?: AgentChatRequest['attachments'];
    selectedNodeId?: string;
    selectedNodeIds?: string[];
    threadId?: string;
    auto?: boolean;
  }) => Promise<AgentChatResponse>;
  compactContext: (msgs: RecallMessage[]) => {
    systemPrompt: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  };
}

export function registerDesktopIpc(ctx: DesktopIpcDeps): void {
  const {
    logger,
    registry,
    queue,
    store,
    assets,
    skills,
    memory,
    takes,
    exportSvc,
    settings,
    accel,
    styleModels,
    agent,
    autoContinue,
    getWin,
    publish,
    probeSimple,
    executeAgentChat,
    compactContext,
  } = ctx;

// ---------- IPC:引擎引导 ----------
ipcMain.handle('probe-runtimes', async (): Promise<RuntimeProbe[]> => {
  const probes: RuntimeProbe[] = [];
  probes.push(await probeSimple('lmstudio', 'LM Studio', 1234));
  probes.push(await probeSimple('ollama', 'Ollama', 11434));
  probes.push(await probeSimple('comfyui', 'ComfyUI', 8188));
  const providerStatus = await registry.checkAll();
  const h3c = providerStatus.h3c;
  probes.push({
    id: 'h3c',
    label: 'h3.c (MiniMax-H3)',
    detected: h3c.installed,
    status: h3c.ready ? 'ready' : h3c.installed ? 'error' : 'missing',
    version: h3c.version,
    path: h3c.installedPath,
    detail: h3c.detail ?? h3c.error,
  });
  const mlx = providerStatus.mlxgen;
  probes.push({
    id: 'mlxgen',
    label: 'mlxgen (MLX 图片)',
    detected: mlx.installed,
    status: mlx.ready ? 'ready' : mlx.installed ? 'error' : 'missing',
    version: mlx.version,
    path: mlx.installedPath,
    detail: mlx.error ?? mlx.installHint,
  });
  return probes;
});

ipcMain.handle('install-runtime', (_e, id: string) => installRuntime(id, logger));
// 引擎自检(引导向导第 4 步):轻量真探测,不加载大模型、不触发真实推理
ipcMain.handle('run-selfcheck', () => runSelfCheck(logger));

// ---------- IPC:mlxgen 图片模型(已下载探测 / 真实下载 / 进度轮询 / 取消) ----------
ipcMain.handle('mlxgen-models', () => mlxgenModelInfo(logger));
ipcMain.handle('mlxgen-download', (_e, repoId: string) => mlxgenDownload(repoId, logger));
ipcMain.handle('mlxgen-download-status', (_e, jobId: string) => mlxgenDownloadStatus(jobId));
ipcMain.handle('mlxgen-download-active', () => mlxgenDownloadActive());
ipcMain.handle('mlxgen-download-cancel', (_e, jobId: string) => mlxgenDownloadCancel(jobId, logger));
// base64 PNG/JPEG/WebP → 资产库(检查器画遮罩生成 mask 用)
ipcMain.handle('save-png-asset', (_e, input: { name: string; dataUrl: string; projectId?: string; tags?: string[] }) => {
  const r = assets.importFromDataUrl(input);
  return { ok: r.ok, assetId: r.asset?.id, error: r.error };
});

// ---------- IPC:渲染任务(经队列,槽位互斥) ----------
ipcMain.handle('check-providers', () => registry.checkAll());
ipcMain.handle('submit-render', (_e, req: RenderRequest) => {
  const params = req.params as Record<string, unknown>;
  logger.log('info', `submit-render node=${req.nodeId} slot=${req.slot} provider=${req.provider} takeId=${req.takeId ?? '—'} mode=${String(params.mode ?? '?')} tier=${String(params.tier ?? '?')} w=${String(params.width ?? '?')} h=${String(params.height ?? '?')}`);
  // 方案 D:提交前防呆 —— 单值参考端口(first-frame/last-frame/ref-audio/ref-video)多源 + 媒体匹配。
  // 之前 h3c 对 refs 静默 `find(role)` 取第一个,多源时首帧来源不确定;这里入队前显式拒绝。
  const refs = (req.references ?? []) as Array<{ role?: string; kind?: string; localPath?: string }>;
  const byRole = new Map<string, number>();
  for (const r of refs) {
    if (!r.role) continue;
    byRole.set(r.role, (byRole.get(r.role) ?? 0) + 1);
  }
  for (const role of ['first-frame', 'last-frame', 'ref-audio', 'ref-video']) {
    const cnt = byRole.get(role);
    if (cnt && cnt > 1) {
      throw new Error(
        `提交被拒绝:${req.nodeId} 的 ${role} 端口有 ${cnt} 个来源(单值端口,只能一个)。请移除多余连线后重试`,
      );
    }
  }
  const mediaIssues = referenceMediaIssues(refs as Array<{ role: string; kind?: string; path?: string }>);
  if (mediaIssues.length > 0) {
    throw new Error(`提交被拒绝:${mediaIssues.map((i) => i.message).join('; ')}`);
  }
  // h3 互斥:references(--ref-image/--ref-video)不能与 frame anchors(--first-frame/--last-frame)共存。
  // 入队前拦下,避免 h3 在很久之后才 exit 1 且错误信息看不出画布上的真因(2026-09 真实事故)。
  const anchorIssues = referenceAnchorConflictIssues(refs as Array<{ role?: string }>);
  if (anchorIssues.length > 0) {
    throw new Error(`提交被拒绝:${anchorIssues.map((i) => i.message).join('; ')}`);
  }
  // 🚀 模型包(加速/风格):开启且 real 模式时把所选包解析成实际 modelDir(-d)+ steps(h3.c 不接受 --lora,见手册 §8)
  // demo 模式走 mock 占位,不解析(避免包缺失在演示路径误报)
  const accelReq = (params.accel ?? undefined) as { enabled?: boolean; packId?: string; steps?: number } | undefined;
  if (accelReq?.enabled && req.slot === 'video' && settings.get().renderMode === 'real') {
    const resolved = accel.resolveAccel(accelReq);
    if (!resolved) {
      throw new Error('模型包已启用但不可用(未安装或目录缺失) · 请到设置页「h3 模型包」检查,或在镜头检查器里关闭模型包');
    }
    params.modelDir = resolved.modelDir;
    params.steps = resolved.steps;
    // kind 透传给 provider:风格包 ETA 不打加速折扣(它换的是画风不是速度)
    params.accel = { ...accelReq, kind: resolved.kind };
    logger.log('info', `submit-render 模型包[${resolved.kind}]: -d ${resolved.modelDir} --steps ${resolved.steps}`);
  }
  /* ⚠️ 把解析结果**回写 Take**(2026-10-09 事故修复)。
   *
   * 为什么必须回写:Take 是渲染层在调本 IPC **之前**建的
   * (CanvasPage.runNode 先 takesCreate(params) 再 submitRender),
   * 那时 accel 还没解析 —— 所以 Take 里存的是 `steps:30 / 无 modelDir`。
   * 后果:检查器回看历史时显示「30 步、未加速」,**与真实执行不符**。
   * 实测踩中:用户据此以为「加速没生效」而重复排查一个并不存在的问题
   * (日志里明明是 `-d .../turbo-T8test --steps 8`)。
   *
   * 这里在解析后立即用**最终参数**覆盖 Take,让历史记录与实际执行一致。
   * 失败不阻断提交 —— Take 记录失真不该让渲染任务失败,只记日志。
   * 异步不 await:本 IPC 要尽快返回任务句柄,写盘不该拖慢提交。 */
  if (req.takeId && req.projectId && (params.modelDir || accelReq?.enabled)) {
    void takes
      .patch(req.projectId, req.takeId, { params })
      .catch((e) => logger.log('warn', `take params 回写失败(不影响渲染): ${(e as Error).message}`));
  }
  return queue.submit(req);
});

// ---------- IPC:调试日志 ----------
ipcMain.handle('debug-logs', () => logger.list());
ipcMain.handle('debug-clear', () => logger.clear());
ipcMain.handle('queue-status', () => queue.slimList());
ipcMain.handle('render-status', async (_e, provider: string, handle: { providerTaskId: string }): Promise<RenderStatus> => {
  // 优先查队列任务(demo/real 统一由队列驱动)
  const job = queue.getJob(handle.providerTaskId);
  if (job) {
    return {
      status: job.status === 'running' ? 'RUNNING' : job.status === 'succeeded' ? 'SUCCEEDED' : job.status === 'failed' ? 'FAILED' : 'QUEUED',
      progress: job.progress,
      stage: job.stage,
      error: job.error,
      resultPath: job.resultPath,
    };
  }
  const p = registry.get(provider as never);
  if (!p) throw new Error(`未知 provider: ${provider}`);
  return p.status(handle);
});
ipcMain.handle('cancel-render', async (_e, provider: string, handle: { providerTaskId: string }) => {
  // 队列侧负责杀真实子进程并归档(等其完成,避免下一个任务与残留进程重叠)
  await queue.cancel(handle).catch(() => undefined);
  const p = registry.get(provider as never);
  return p?.cancel(handle).catch(() => undefined) ?? undefined;
});

// ---------- IPC:Take 历史 ----------
ipcMain.handle('takes-list', (_e, projectId: string) => takes.list(projectId));
ipcMain.handle('takes-history', (_e, projectId: string, shotNodeId: string, currentTakeId?: string) =>
  takes.history(projectId, shotNodeId, currentTakeId));
ipcMain.handle('takes-create', (_e, projectId: string, partial: Parameters<TakeStore['append']>[1]) =>
  takes.append(projectId, partial));
ipcMain.handle('takes-patch', (_e, projectId: string, takeId: string, patch: Partial<import('@bigbotart/shared').Take>) =>
  takes.patch(projectId, takeId, patch));
ipcMain.handle('takes-delete', (_e, projectId: string, takeId: string) => takes.delete(projectId, takeId));

// ---------- IPC:项目/画布 ----------
ipcMain.handle('list-projects', () => store.listProjects());
ipcMain.handle('create-project', (_e, name: string) => store.createProject(name));
ipcMain.handle('delete-project', (_e, id: string) => store.deleteProject(id));
ipcMain.handle('rename-project', (_e, id: string, name: string) => store.renameProject(id, name));

/* ── 项目封面(首页/项目页卡片;取代写死的静态占位图) ── */
const coverDeps = { store, assets };
ipcMain.handle('project-cover', (_e, projectId: string): ProjectCover => {
  const p = store.getProject(projectId);
  if (!p) return { projectId, mode: 'auto', path: null, isVideo: false, sourceNodeId: null, error: '项目不存在' };
  return coverOf(p, coverDeps);
});
ipcMain.handle('project-covers', (): ProjectCover[] => listProjectCovers(coverDeps));
ipcMain.handle('upload-project-cover', async (_e, projectId: string) => {
  const win = BrowserWindow.getAllWindows()[0];
  const opts = {
    title: '选择项目封面',
    properties: ['openFile' as const],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] }],
  };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (r.canceled || r.filePaths.length === 0) return { ok: false, canceled: true };
  const src = r.filePaths[0]!;
  // 先验格式再拷贝:省得把一个 .mp4/空文件拷进资产库才发现不能用
  const usable = isUsableCoverFile(src);
  if (!usable.ok) return { ok: false, error: usable.error };
  // 用户显式选了文件 → unrestricted 导入(与「导入资产」同口径),登记为**项目资源**
  const imported = await assets.importFromPaths([src], { unrestricted: true, projectId });
  const asset = imported.assets[0];
  if (!asset) {
    return { ok: false, error: imported.failed[0]?.error ?? '封面导入失败' };
  }
  const res = setCoverAsset(coverDeps, projectId, asset.id);
  logger.log(
    res.ok ? 'info' : 'warn',
    `[project-cover] 上传封面 ${projectId} → ${res.ok ? asset.localPath : res.error}`,
  );
  return res;
});
ipcMain.handle('clear-project-cover', (_e, projectId: string) => {
  const res = clearCover(coverDeps, projectId);
  logger.log(res.ok ? 'info' : 'warn', `[project-cover] 清除手动封面 ${projectId} → ${res.ok ? '回到自动' : res.error}`);
  return res;
});
ipcMain.handle('set-project-llm', (_e, projectId: string, llm: LlmSource | null) => store.setProjectLlm(projectId, llm));
// 多画布
ipcMain.handle('load-project-canvases', (_e, projectId: string) => store.loadProjectCanvases(projectId));
ipcMain.handle('save-canvas-snapshot', (_e, snap, opts) => store.saveCanvasSnapshot(snap, opts));
ipcMain.handle('create-canvas', (_e, projectId: string, name?: string) => store.createCanvas(projectId, name));
ipcMain.handle('rename-canvas', (_e, projectId: string, canvasId: string, name: string) => store.renameCanvas(projectId, canvasId, name));
ipcMain.handle('delete-canvas', (_e, projectId: string, canvasId: string) => store.deleteCanvas(projectId, canvasId));
ipcMain.handle('switch-active-canvas', (_e, projectId: string, canvasId: string) => store.switchActiveCanvas(projectId, canvasId));
// 向后兼容:旧 loadCanvas/saveCanvas 路由到项目当前活动画布
ipcMain.handle('load-canvas', (_e, projectId: string) => {
  const pc = store.loadProjectCanvases(projectId);
  const cur = pc.canvases.find((c) => c.id === pc.activeCanvasId) ?? pc.canvases[0];
  if (!cur) {
    const now = new Date().toISOString();
    return { id: 'main', projectId, name: '主画布', nodes: [], edges: [], version: 0, createdAt: now, updatedAt: now };
  }
  return cur;
});
ipcMain.handle('save-canvas', (_e, snapshot) => {
  // 旧 API 只传 projectId/nodes/edges/version,补齐 id/name/时间戳
  const snap = snapshot as Partial<import('@bigbotart/shared').CanvasSnapshot>;
  const projectId = snap.projectId ?? '';
  const pc = store.loadProjectCanvases(projectId);
  const cur = pc.canvases.find((c) => c.id === pc.activeCanvasId) ?? pc.canvases[0];
  if (!cur) return { ok: false };
  return store.saveCanvasSnapshot({
    id: cur.id,
    projectId: cur.projectId,
    name: cur.name,
    nodes: (snap.nodes ?? []) as never,
    edges: (snap.edges ?? []) as never,
    // 用渲染层快照的 version(save-canvas-snapshot 同口径),落后于 store 时由 saveCanvasSnapshot 版本防护拒绝覆盖
    version: snap.version ?? 0,
    createdAt: cur.createdAt,
    updatedAt: new Date().toISOString(),
  });
});

  // ---------- IPC:资产中心(v2:项目视图/分类/标签/产物归档/回收站) ----------
  ipcMain.handle('import-assets', (_e, opts?: { paths?: string[]; projectId?: string }) => {
    // paths 给定时走 headless(白名单目录);否则弹系统对话框(用户显式选择,不受限)
    // projectId 给定时成功资产直接归属该项目(原子完成,避免渲染层导入后再逐条 update)
    if (opts?.paths?.length) return assets.importFromPaths(opts.paths, { projectId: opts.projectId });
    return assets.importFromDialog(opts?.projectId);
  });
  ipcMain.handle('list-assets', (_e, projectId?: string) => assets.list(projectId));
  /**
   * 媒体信息按需探测(资源节点检查器「媒体信息」面板)。
   *
   * 只读、无副作用(不回写资产库)——所以白名单比导入更宽:产物/导出/资产库/项目文件夹
   * 全都能读(与 frames / vision 同口径的 ffmpegReadRoots)。
   * 越界路径明确返回 `ok:false` 而不是静默给空结果(否则 UI 上「读不到」和「不支持」分不清)。
   */
  ipcMain.handle('probe-media', async (_e, rawPath: string, kind?: MediaKind): Promise<MediaInfo> => {
    const roots = ffmpegReadRoots();
    if (!rawPath || !roots.some((r) => isUnderRoot(rawPath, r))) {
      return { ok: false, error: '路径不在允许目录(仅可探测应用数据 / 产物 / 导出目录内的媒体)', name: rawPath ?? '' };
    }
    return await probeMediaInfo(rawPath, kind);
  });
  ipcMain.handle('delete-asset', (_e, id: string) => {
    const refs = collectAssetRefs(store, id);
    return { ...assets.delete(id), refs };
  });
  ipcMain.handle(
    'update-asset',
    (
      _e,
      id: string,
      patch: {
        name?: string;
        caption?: string | null;
        categoryId?: string | null;
        projectId?: string | null;
        tags?: string[];
      },
    ) => {
      const res = assets.update(id, patch);
      // 改名后把绑定该资产的画布资源节点标题同步成新名(Agent 称呼规则靠标题)
      if (res.ok && typeof patch.name === 'string' && patch.name.trim()) {
        syncAssetNodeLabels(store, id, patch.name.trim());
      }
      return res;
    },
  );
  ipcMain.handle('list-asset-categories', () => assets.listCategories());
  ipcMain.handle('create-asset-category', (_e, name: string, projectId?: string) => assets.createCategory(name, projectId));
  ipcMain.handle('rename-asset-category', (_e, id: string, name: string) => assets.renameCategory(id, name));
  ipcMain.handle('delete-asset-category', (_e, id: string) => assets.deleteCategory(id));
  ipcMain.handle('asset-refs', (_e, assetId: string) => collectAssetRefs(store, assetId));
  ipcMain.handle('list-trash', () => assets.listTrash());
  ipcMain.handle('restore-asset', (_e, id: string) => assets.restore(id));
  ipcMain.handle('empty-trash', () => assets.emptyTrash());
  ipcMain.handle(
    'archive-products',
    (
      _e,
      input: {
        projectId: string;
        items: Array<{ nodeId: string; path: string; name?: string; caption?: string }>;
        categoryId?: string;
      },
    ) => assets.archiveProducts(input.projectId, input.items, input.categoryId),
  );
  ipcMain.handle('list-archivable-products', (_e, projectId: string) => listArchivableProducts(store, projectId));

// ---------- IPC:Skills(画布模板 + Agent 指令段双形态,激活状态持久化在 canvasMemory) ----------
ipcMain.handle('list-skills', () => skills.list());
ipcMain.handle('save-skill', (_e, input: { name: string; projectId: string; canvasId?: string; instructions?: string; inject?: 'full' | 'summary' }) => {
  const pc = store.loadProjectCanvases(input.projectId);
  const cur = input.canvasId
    ? pc.canvases.find((c) => c.id === input.canvasId)
    : pc.canvases.find((c) => c.id === pc.activeCanvasId) ?? pc.canvases[0];
  if (!cur) throw new Error('项目下没有任何画布可保存');
  const instructions = input.instructions?.trim() ? input.instructions.trim() : undefined;
  return skills.save(input.name, cur, {
    instructions,
    inject: instructions ? (input.inject === 'summary' ? 'summary' : 'full') : undefined,
  });
});
ipcMain.handle('import-skill', async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const opts = {
    title: '选择技能文件夹或 zip 包',
    properties: ['openFile' as const, 'openDirectory' as const],
    filters: [{ name: '技能包', extensions: ['zip'] }],
  };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (r.canceled || r.filePaths.length === 0) return { ok: false as const, canceled: true as const };
  const target = r.filePaths[0]!;
  const loaded = await loadSkillPackage(target);
  if (!loaded.ok) return { ok: false as const, error: loaded.error };
  const imported = loaded.drafts.map((draft) => skills.importDraft(draft));
  const first = imported[0];
  if (!first) return { ok: false as const, error: '没有导入任何技能' };
  logger.log('info', `[skills] 从本地导入 ${imported.map((s) => `「${s.name}」`).join('、')} ← ${basename(target)}`);
  return { ok: true as const, skill: first, skills: imported };
});
ipcMain.handle(
  'apply-skill',
  (_e, skillId: string, projectName: string, activate = false, paramValues?: Record<string, string>) => {
    const project = skills.apply(skillId, projectName, store, paramValues);
    if (activate) {
      const canvasId = project.activeCanvasId || 'main';
      memory.setActiveSkillId(project.id, canvasId, skillId, paramValues);
    }
    return { project };
  },
);
ipcMain.handle('delete-skill', (_e, id: string) => skills.delete(id));
ipcMain.handle('skill-read', (_e, skillId: string) => skills.get(skillId) ?? null);
ipcMain.handle('skill-update', (_e, skillId: string, patch: { name?: string; description?: string; instructions?: string | null; inject?: 'full' | 'summary' }) => skills.update(skillId, patch));
ipcMain.handle(
  'skill-activate',
  (_e, projectId: string, canvasId: string, skillId: string, paramValues?: Record<string, string>) => {
    const skill = skills.get(skillId);
    if (!skill) return { ok: false as const, error: 'Skill 不存在' };
    memory.setActiveSkillId(projectId, canvasId, skillId, paramValues);
    return { ok: true as const, preview: (skill.instructions ?? '').slice(0, 60), hasInstructions: !!skill.instructions };
  },
);
ipcMain.handle('skill-deactivate', (_e, projectId: string, canvasId: string) => {
  memory.setActiveSkillId(projectId, canvasId, null);
  return { ok: true as const };
});
ipcMain.handle('skill-active', (_e, projectId: string, canvasId: string) => {
  const skillId = memory.getActiveSkillId(projectId, canvasId);
  if (!skillId) return null;
  const skill = skills.get(skillId);
  if (!skill) return null;
  return { skillId: skill.id, name: skill.name, inject: skill.inject };
});

// ---------- IPC:时间线导出 ----------
ipcMain.handle('export-timeline', (_e, req) => {
  try {
    return { ok: true, taskId: exportSvc.submit(req).taskId } as const;
  } catch (e) {
    return { ok: false, error: (e as Error).message } as const;
  }
});
ipcMain.handle('export-status', (_e, taskId: string) => exportSvc.status(taskId));
/** 按文件名解析导出目录内成片的**绝对路径**(timeline 旧数据愈合:只有 lastExport 没有 resultPath 的节点,
 *  下游视频解析(取帧/增强/参考视频)需要真实路径;bba-output:// URL 只是展示层) */
ipcMain.handle('export-file-path', (_e, input: { name?: string }) => {
  const p = resolveExportFile(input?.name);
  return p ? { ok: true as const, path: p } : { ok: false as const };
});

/* ---------- IPC:时间线成片的「另存为…」与「存入资源库」(2026-10) ----------
   渲染层只有 bba-output:// URL + 文件名(lastExport.name),绝对路径一律由
   resolveExportFile 在主进程按 EXPORT_DIR 重建(白名单 + 必须存在)。 */
/** 另存为:系统保存对话框选位置 → 复制成片过去(取消 = canceled,不是失败) */
ipcMain.handle('save-export-as', async (_e, input: { name?: string }) => {
  const src = resolveExportFile(input?.name);
  if (!src) return { ok: false as const, error: '成片文件不存在(可能已被移动或清理)' };
  const target = BrowserWindow.getAllWindows()[0];
  const opts = {
    title: '成片另存为',
    defaultPath: basename(src),
    filters: [{ name: '视频', extensions: ['mp4', 'mov'] }],
  };
  const r = target ? await dialog.showSaveDialog(target, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return { ok: false as const, canceled: true };
  try {
    copyFileSync(src, r.filePath);
    logger.log('info', `[export] 成片另存为 ${basename(src)} → ${r.filePath}`);
    return { ok: true as const, path: r.filePath };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
});
/** 存入资源库:导出目录内成片 → 复制进资产库并登记(source='product',归项目) */
ipcMain.handle('archive-export', async (_e, input: { projectId: string; nodeId: string; name?: string }) => {
  const src = resolveExportFile(input?.name);
  if (!src) return { ok: false as const, assets: [], error: '成片文件不存在(可能已被移动或清理)' };
  const res = await assets.archiveProducts(input.projectId, [{ nodeId: input.nodeId, path: src }]);
  if (res.ok) logger.log('info', `[export] 成片入库 ${basename(src)}(${res.assets.length} 项,项目 ${input.projectId})`);
  return res;
});

// ---------- IPC:项目包导入/导出(.bba;取代原「H3Mise 项目导入」入口) ----------
/** 导出:不传 path 则弹保存对话框(取消 = canceled,不是失败) */
ipcMain.handle('export-project-package', async (_e, req: ProjectExportRequest): Promise<ProjectExportResult> => {
  const res = await exportProject(req, {
    store,
    assets,
    takes,
    memory,
    appVersion: app.getVersion(),
    dataRoot: DATA_DIR,
    showSaveDialog: async (defaultName) => {
      const target = BrowserWindow.getAllWindows()[0];
      const r = target
        ? await dialog.showSaveDialog(target, {
            title: '导出项目包',
            defaultPath: defaultName,
            filters: [{ name: 'BigBotArt 项目包', extensions: ['bba'] }],
          })
        : await dialog.showSaveDialog({
            title: '导出项目包',
            defaultPath: defaultName,
            filters: [{ name: 'BigBotArt 项目包', extensions: ['bba'] }],
          });
      return r.canceled || !r.filePath ? null : r.filePath;
    },
  });
  logger.log(
    res.ok ? 'info' : res.canceled ? 'info' : 'warn',
    `[project-package] 导出 ${req.projectId} → ${res.ok ? res.path : res.canceled ? '用户取消保存' : res.error}`,
  );
  return res;
});
/** 导入:不传 path 则弹打开对话框;一律建**新项目**,绝不覆盖既有项目 */
ipcMain.handle('import-project-package', async (_e, input?: { path?: string }): Promise<ProjectImportResult> => {
  let filePath = input?.path;
  if (!filePath) {
    const target = BrowserWindow.getAllWindows()[0];
    const opts = {
      title: '导入 BigBotArt 项目包',
      properties: ['openFile' as const],
      filters: [{ name: 'BigBotArt 项目包', extensions: ['bba'] }],
    };
    const r = target ? await dialog.showOpenDialog(target, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || r.filePaths.length === 0) return { ok: false, canceled: true };
    filePath = r.filePaths[0]!;
  }
  const res = importProjectFromFile(filePath, { store, assets, takes, memory });
  logger.log(
    res.ok ? 'info' : 'error',
    `[project-package] 导入 ${filePath} → ${res.ok ? `新项目 ${res.project?.name}(${res.project?.id})` : res.error}` +
      (res.warnings?.length ? ` · ${res.warnings.length} 条提醒` : ''),
  );
  return res;
});

// ---------- IPC:视频取帧(镜头接续尾帧归档 / 取帧编辑 / Agent 指定时间点取帧) ----------
ipcMain.handle('extract-frame', (_e, videoPath: string, mode: 'first' | 'last' | 'at', seconds?: number) =>
  extractFrame(videoPath, mode, seconds));
// 音轨抽取(「视频节点 → 音频参考」连接器):视频 → wav,作 shot 的 --ref-audio
ipcMain.handle('extract-audio', (_e, videoPath: string) => extractAudio(videoPath));
// 图片裁切(image-crop 节点):按目标画幅裁剪原图
ipcMain.handle('crop-image', (_e, input: { path: string; aspect: string; focus?: 'center' | 'top' | 'bottom' | 'left' | 'right' }) =>
  cropImage(input.path, input.aspect, input.focus));
// 图片拼接(image-stitch 节点):多图横排/竖排/网格拼成一张
ipcMain.handle(
  'stitch-images',
  (_e, input: { paths: string[]; mode: 'row' | 'column' | 'grid'; gridCols?: number; gap?: number; bg?: string }) =>
    stitchImages(input.paths, { mode: input.mode, gridCols: input.gridCols, gap: input.gap, bg: input.bg }),
);
// 图片拆分(image-split 节点):一张图等分多片(长图切片/九宫格)
ipcMain.handle(
  'split-image',
  (_e, input: { path: string; mode: 'rows' | 'cols' | 'grid'; count?: number; gridCols?: number; gridRows?: number }) =>
    splitImage(input.path, { mode: input.mode, count: input.count, gridCols: input.gridCols, gridRows: input.gridRows }),
);
// 视频增强(video-upscale 节点):去块 → Real-ESRGAN 超分 → GFPGAN/CodeFormer 合修脸(分钟级长任务)
ipcMain.handle('video-upscale', (_e, input: VideoUpscaleRequest) =>
  // 长任务(分钟级):把主进程阶段回调实时推给渲染层,否则 invoke 期间的 UI 完全没有反馈
  videoUpscale(input, {
    onProgress: (p) => {
      publish('video-post-progress', {
        ...p,
        nodeId: input?.nodeId ?? '',
      } satisfies VideoPostProgressEvent);
    },
  }));
// 视频增强工具链探测(检查器防呆:realesrgan / 修脸脚本 / venv / 权重是否就绪)
ipcMain.handle('video-post-probe', () => probeVideoPostTooling());
// 运行中的后处理任务(渲染层挂载时恢复运行态用 —— 只靠组件 state 会因退出画布而丢失)
ipcMain.handle('video-post-running', () => listRunningVideoPost());
ipcMain.handle('video-post-last-progress', () => lastVideoPostProgress());
// 检查器「取消」:按节点中止排队或运行中的增强(去块 / SeedVR2 / 修脸子进程一起停)
ipcMain.handle('video-post-cancel', (_e, input?: { nodeId?: string }) =>
  cancelVideoPost(typeof input?.nodeId === 'string' && input.nodeId ? input.nodeId : undefined));

// ---------- IPC:在系统文件管理器中显示(Finder) ----------
// 右键「在 Finder 中显示」:renderer 解析节点真实产物路径 → 主进程校验白名单后 shell 定位;
// 文件缺失时逐级向上回退到最近存在的目录打开,保证点击必有真实跳转
ipcMain.handle(
  'reveal-in-finder',
  async (_e, target: { path?: unknown }): Promise<{ ok: boolean; revealed: string; error?: string }> => {
    const raw = typeof target?.path === 'string' ? target.path : '';
    const p = resolve(raw || DATA_DIR);
    const roots = [DATA_DIR, OUTPUTS_DIR, join(DATA_DIR, 'exports'), ...importAllowRoots()];
    if (!raw || !roots.some((r) => isUnderRoot(p, r))) {
      return { ok: false, revealed: p, error: '路径不在允许目录' };
    }
    try {
      // 目标存在:文件 → Finder 选中该文件;目录 → 直接打开
      if (existsSync(p)) {
        const st = statSync(p);
        if (st.isFile()) shell.showItemInFolder(p);
        else shell.openPath(p);
        return { ok: true, revealed: p };
      }
      // 目标缺失:向上找最近存在的目录打开(Finder 至少能落在产物附近)
      let d = resolve(p, '..');
      let hit: string | null = null;
      while (true) {
        if (existsSync(d) && statSync(d).isDirectory()) {
          hit = d;
          break;
        }
        const parent = resolve(d, '..');
        if (parent === d) break;
        d = parent;
      }
      if (!hit) return { ok: false, revealed: p, error: '路径不存在' };
      shell.openPath(hit);
      return { ok: true, revealed: hit };
    } catch (e) {
      return { ok: false, revealed: p, error: (e as Error).message };
    }
  },
);

// ---------- IPC:设置 ----------
ipcMain.handle('get-settings', async () => {
  const s = settings.get();
  // 钥匙串凭据状态实时回填(只回传 hasKey 标记,key 不出主进程)
  if (s.cloudProviders?.length) {
    s.cloudProviders = await Promise.all(
      s.cloudProviders.map(async (p) => ({ ...p, hasKey: !!(await credentialGet(p.id)) })),
    );
  }
  return s;
});
ipcMain.handle('set-settings', (_e, patch: Partial<import('@bigbotart/shared').AppSettings>) => {
  const nextPatch = { ...patch };
  if ('theme' in nextPatch) {
    nextPatch.theme = normalizeTheme(nextPatch.theme, (m) => logger.log('warn', m));
  }
  const next = settings.patch(nextPatch);
  if ('theme' in (patch ?? {})) {
    applyThemeSource(normalizeTheme(next.theme));
    syncWindowBackground(getWin());
  }
  return next;
});

// ---------- IPC:h3 模型包(加速 / 风格)管理 ----------
ipcMain.handle('accel-list', () => accel.list());
ipcMain.handle('accel-install', (_e, input: { name: string; path: string; steps?: number; kind?: 'accel' | 'style' }) => accel.install(input));
ipcMain.handle('accel-remove', (_e, id: string) => accel.remove(id));
ipcMain.handle('accel-set-default', (_e, id: string | null) => accel.setDefault(id));
ipcMain.handle('accel-set-default-enabled', (_e, enabled: boolean) => accel.setDefaultEnabled(enabled));
ipcMain.handle('accel-get-default-enabled', () => accel.isDefaultEnabled());
ipcMain.handle('accel-default-shot-config', () => accel.defaultShotAccel());
// 风格模型包(mystic 等):下载 LoRA + 离线融合构建(分钟~小时级长任务,进度事件 style-model-progress)
ipcMain.handle('style-model-status', (_e, packId: string) => styleModels.status(packId));
ipcMain.handle('style-model-build', (_e, packId: string) => styleModels.build(packId));
ipcMain.handle('style-model-cancel', () => styleModels.cancel());

// ---------- IPC:LLM 来源(五档) ----------
ipcMain.handle('llm-local-models', (_e, kind: 'lmstudio' | 'ollama' | 'pimlx') => {
  if (kind === 'lmstudio') return listLmStudio();
  if (kind === 'ollama') return listOllama();
  return listPiMlx();
});
ipcMain.handle('llm-load-model', (_e, kind: 'lmstudio' | 'ollama' | 'pimlx', modelId: string) => {
  if (kind === 'lmstudio') return loadLmStudio(modelId);
  if (kind === 'ollama') return loadOllama(modelId);
  return loadPiMlx(modelId);
});
ipcMain.handle('llm-test-connection', (_e, input: { baseUrl: string; apiKey?: string; providerId?: string }) =>
  testConnection(input));
ipcMain.handle('llm-list-remote-models', (_e, input: { baseUrl: string; apiKey?: string; providerId?: string }) =>
  listRemoteModels(input));
ipcMain.handle('credential-set', async (_e, providerId: string, apiKey: string) => {
  const res = await credentialSet(providerId, apiKey);
  if (res.ok) {
    // 回填 hasKey 标记
    const s = settings.get();
    if (s.cloudProviders?.some((p) => p.id === providerId)) {
      settings.patch({
        cloudProviders: s.cloudProviders.map((p) => (p.id === providerId ? { ...p, hasKey: true } : p)),
      });
    }
  }
  return res;
});
ipcMain.handle('credential-delete', (_e, providerId: string) => credentialDelete(providerId));

// ---------- IPC:Agent 内核 ----------
ipcMain.handle('agent-status', () => agent.status());
ipcMain.handle('agent-start', async (_e, modelSource?: LlmSource) => {
  await agent.start();
  return agent.status();
});
ipcMain.handle('agent-stop', () => agent.stop());
ipcMain.handle('agent-plan', async (_e, brief: string, opts?: { projectId?: string; projectName?: string; existingNodeIds?: string[] }) => {
  // LLM 来源优先级:项目级覆盖 → 全局设置 → AgentManager 默认(env/本地)
  // 钥匙串取出的 key 仅经本次 RPC 的 LlmSource 传给 worker,不写入 worker 环境变量
  let llm: LlmSource | undefined;
  const project = opts?.projectId ? store.getProject(opts.projectId) : undefined;
  if (project?.llmOverride) llm = project.llmOverride;
  else if (settings.get().llm) llm = settings.get().llm;
  try {
    const ep = await resolveLlmEndpoint(settings.get(), llm);
    llm = toChatLlm(ep);
  } catch (e) {
    console.warn(`[agent-plan] LLM 来源解析失败,回退确定性规划: ${(e as Error).message}`);
    llm = { kind: 'none' };
  }
  const { document, shots, edges, report } = await agent.plan(
    brief,
    llm,
    { projectName: opts?.projectName ?? project?.name, existingNodeIds: opts?.existingNodeIds },
  );
  return { document, shots, edges, report };
});
ipcMain.handle('agent-plan-storyboard', async (_e, brief: string, opts?: { projectId?: string; projectName?: string; basePrompt?: string; autoMaterialize?: boolean }) => {
  let llm: LlmSource | undefined;
  const project = opts?.projectId ? store.getProject(opts.projectId) : undefined;
  if (project?.llmOverride) llm = project.llmOverride;
  else if (settings.get().llm) llm = settings.get().llm;
  try {
    const ep = await resolveLlmEndpoint(settings.get(), llm);
    llm = toChatLlm(ep);
  } catch (e) {
    console.warn(`[agent-plan-storyboard] LLM 来源解析失败,回退确定性分镜表: ${(e as Error).message}`);
    llm = { kind: 'none' };
  }
  const result = await agent.planStoryboard(brief, llm, {
    projectName: opts?.projectName ?? project?.name,
    basePrompt: opts?.basePrompt,
    autoMaterialize: opts?.autoMaterialize,
  });
  return result;
});

ipcMain.handle('agent-chat', async (_e, req: AgentChatRequest): Promise<AgentChatResponse> => {
  // 用户发消息 = 接管任务链:重置该画布的连续自动轮计数,并取消待触发的防抖唤醒
  autoContinue.resetOnUserMessage(req.projectId, req.canvasId);
  return executeAgentChat({
    projectId: req.projectId,
    canvasId: req.canvasId,
    threadId: req.threadId,
    text: req.text,
    attachments: req.attachments,
    selectedNodeId: req.selectedNodeId,
    selectedNodeIds: req.selectedNodeIds,
  });
});

ipcMain.handle('agent-cancel', async (_e, projectId: string) => {
  void projectId;
  return agent.cancel();
});

ipcMain.handle('memory-get', (_e, projectId: string) => memory.get(projectId));

/* ---------- IPC:对话命令(/clear 清空 · /compact 压缩) ---------- */
ipcMain.handle('memory-clear', (_e, projectId: string, canvasId: string) => {
  const res = memory.clearConversation(projectId, canvasId);
  logger.log('info', `memory.clear ${projectId}:${canvasId} · 清除 ${res.cleared} 条对话记录`);
  return { ok: true, ...res };
});

/* ---------- IPC:Agent 历史会话(ChatThread) ---------- */
ipcMain.handle('chat-threads-list', (_e, projectId: string, canvasId: string) =>
  memory.listThreads(projectId, canvasId),
);
ipcMain.handle(
  'chat-thread-create',
  (_e, projectId: string, canvasId: string, opts?: { title?: string; parentThreadId?: string }) => {
    try {
      const thread = memory.createThread(projectId, canvasId, opts);
      return { ok: true, thread };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
);
ipcMain.handle('chat-thread-switch', (_e, projectId: string, canvasId: string, threadId: string) => {
  try {
    const thread = memory.switchThread(projectId, canvasId, threadId);
    return { ok: true, thread };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});
ipcMain.handle('chat-thread-rename', (_e, projectId: string, threadId: string, title: string) => {
  try {
    const thread = memory.renameThread(projectId, threadId, title);
    return { ok: true, thread };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});
ipcMain.handle('chat-thread-delete', (_e, projectId: string, threadId: string) => {
  try {
    const res = memory.deleteThread(projectId, threadId);
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});
ipcMain.handle('chat-thread-messages', (_e, projectId: string, threadId: string) =>
  memory.threadMessages(projectId, threadId),
);
ipcMain.handle('chat-thread-active', (_e, projectId: string, canvasId: string) => ({
  threadId: memory.ensureActiveThread(projectId, canvasId),
}));

/* /compact:把当前画布旧对话交给 LLM 压成摘要,裁剪 recall(保留最近 COMPACT_KEEP_LAST 条);
   LLM 不可达/失败时用确定性兜底摘要,压缩流程照常完成(不阻塞用户) */
ipcMain.handle('memory-compact', async (_e, projectId: string, canvasId: string) => {
  const msgs = memory.get(projectId).recall.filter((r) => r.canvasId === canvasId);
  const target = msgs.slice(0, Math.max(0, msgs.length - COMPACT_KEEP_LAST));
  if (target.length === 0) return { ok: true, skipped: true, replaced: 0 };
  logger.log('info', `memory.compact 开始 ${projectId}:${canvasId} · 压缩 ${target.length} 条(保留最近 ${COMPACT_KEEP_LAST} 条)`);

  // LLM 来源优先级与 agent-chat 同口径:项目级覆盖 → 全局设置
  let llm: LlmSource | undefined;
  const project = store.getProject(projectId);
  if (project?.llmOverride) llm = project.llmOverride;
  else if (settings.get().llm) llm = settings.get().llm;
  try {
    const ep = await resolveLlmEndpoint(settings.get(), llm);
    llm = toChatLlm(ep);
  } catch (e) {
    // 不静默吞错(R6):压缩摘要回退确定性兜底,但把真实原因写进日志总线
    console.warn(`[compact] LLM 来源解析失败,回退确定性摘要: ${(e as Error).message}`);
    llm = undefined;
  }

  if (llm) {
    try {
      const result = await agent.chat({
        projectId,
        canvasId,
        text: '请把以上对话压缩为简洁的中文摘要。保留:项目目标、已确定的风格与约束、画布节点的创建/修改/删除情况、待办事项、关键决定与产物内容。直接输出摘要正文,不要寒暄,不要输出其他内容。',
        context: compactContext(target),
        llm,
      });
      if (result.aborted) return { ok: false, error: '已打断' };
      const summary = result.reply.trim();
      if (summary) {
        const res = memory.compactConversation(projectId, canvasId, summary);
        logger.log('info', `memory.compact 完成 · 摘要 ${summary.length} 字 · 裁剪 ${res.replaced} 条`);
        return { ok: true, summary, replaced: res.replaced };
      }
    } catch (e) {
      logger.log('warn', `memory.compact LLM 失败,使用兜底摘要: ${(e as Error).message}`);
    }
  } else {
    logger.log('warn', 'memory.compact LLM 不可达,使用兜底摘要');
  }
  const fallback = compactFallbackSummary(target);
  const res = memory.compactConversation(projectId, canvasId, fallback);
  return { ok: true, summary: fallback, replaced: res.replaced, fallback: true };
});

}
