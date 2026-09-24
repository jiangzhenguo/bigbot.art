/**
 * Electron 主进程 — 窗口 + IPC + 服务编排
 * M1 闭环:项目/画布持久化 · 渲染队列(槽位互斥) · 资产导入 · Skills · 时间线导出 · 设置(LLM/渲染模式)
 */
import { app, BrowserWindow, ipcMain, protocol, net, shell, nativeImage } from 'electron';
import { join, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRegistry } from '@bigbotart/providers';
import { AgentManager } from '@bigbotart/agent';
import { ProjectStore } from './store';
import { SettingsStore } from './settings';
import { AccelStore } from './lora';
import { AssetStore, OUTPUTS_DIR, ASSETS_DIR, outputSearchRoots, copyAttachmentsToProject, collectAssetRefs, listArchivableProducts, isUnderRoot, importAllowRoots } from './assets';
import { SkillStore } from './skills';
import { ExportService } from './export';
import { extractFrame, cropImage } from './frames';
import { stitchImages, splitImage } from './stitch';
import { RenderQueue } from './render-queue';
import { MemoryStore, COMPACT_KEEP_LAST, compactFallbackSummary } from './memory';
import { ToolHandlers } from './tool-handlers';
import { TakeStore } from './takes';
import { DebugLogger } from './logger';
import { mlxgenModelInfo, mlxgenDownload, mlxgenDownloadStatus, mlxgenDownloadActive, mlxgenDownloadCancel } from './mlxgen-models';
import { installRuntime } from './runtime-install';
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
} from './llm';
import type { RuntimeProbe, RenderRequest, LlmSource, RenderStatus, AgentChatRequest, AgentChatResponse, AgentEvent, RecallMessage, CanvasNode, CanvasEdge } from '@bigbotart/shared';
import { referenceMediaIssues } from '@bigbotart/shared';

const isDev = !app.isPackaged;

const DATA_DIR = process.env.BIGBOTART_HOME ?? join(homedir(), '.bigbotart');
/** 渲染产物根目录(h3c/mlxgen/mock 输出;bba-output:// 协议只读这里及子目录) */
const H3_OUTPUTS_DIR = process.env.BIGBOTART_H3_OUTPUTS ?? OUTPUTS_DIR;
// 让 packages/providers 内 mock/h3c 与主进程同一产物根
process.env.BIGBOTART_H3_OUTPUTS = H3_OUTPUTS_DIR;
process.env.BIGBOTART_MOCK_OUTPUTS ??= join(H3_OUTPUTS_DIR, 'mock');
process.env.BIGBOTART_MLXGEN_OUTPUTS ??= join(H3_OUTPUTS_DIR, 'images');

let win: BrowserWindow | null = null;

/**
 * 工具动作的人类可读摘要(成功后写入 role=system 的 recall,让下一轮对话感知画布变化)。
 * 与 role=tool 的机器记录(reply 卡回看用)并存:system 随最近消息注入 LLM,tool 仅留痕。
 */
function describeToolAction(name: string, args: Record<string, unknown>, nodeId?: string): string {
  const j = (v: unknown) => String(v ?? '');
  switch (name) {
    case 'canvas.create_node':
      return `已创建节点 ${nodeId ? `${nodeId} ` : ''}· ${j(args.kind)}「${j(args.label)}」`;
    case 'canvas.update_node':
      return `已更新节点 ${j(args.nodeId)}`;
    case 'canvas.delete_node':
      return `已删除节点 ${j(args.nodeId)} 及其连线`;
    case 'canvas.connect':
      return `已连线 ${j(args.from)} → ${j(args.to)}${args.label ? `(${j(args.label)})` : ''}`;
    case 'canvas.disconnect':
      return `已断开连线 ${j(args.from)} → ${j(args.to)}${args.label ? `(${j(args.label)})` : ''}`;
    case 'storyboard.plan':
      return `已生成分镜表${nodeId ? `(节点 ${nodeId})` : ''}`;
    case 'storyboard.materialize':
      return `已按分镜表 ${j(args.nodeId)} 铺出生成节点`;
    case 'engine.submit':
      return `已提交生成 ${j(args.nodeId)}`;
    case 'timeline.export':
      return `已发起时间线导出${args.outputName ? `(${j(args.outputName)})` : ''}`;
    case 'skills.activate':
      return `已激活技能「${j(args.skillId)}」`;
    case 'skills.deactivate':
      return '已停用当前技能';
    default:
      return `已执行 ${name}`;
  }
}

/** 选中节点详情摘要(附进本轮 user 消息,风格对齐 canvas.get_node 但只挑关键信息控制长度)。
 *  顶部带指令性说明:选中 = 用户指着它,是本轮默认操作对象——
 *  真实事故:用户选中 image-gen 节点说「编辑这个图片」,Agent 绕道 assets.import 复制产物
 *  新建资产节点再连线,没有直接把选中节点连为上游。 */
function describeSelectedNode(node: CanvasNode, edges: CanvasEdge[], nodes: CanvasNode[]): string {
  const idToLabel = new Map(nodes.map((n) => [n.id, n.label || n.id]));
  const ins = edges
    .filter((e) => e.target === node.id)
    .map((e) => `  ← ${idToLabel.get(e.source) ?? e.source}${e.label ? ` [${e.label}]` : ''}`);
  const outs = edges
    .filter((e) => e.source === node.id)
    .map((e) => `  → ${idToLabel.get(e.target) ?? e.target}${e.label ? ` [${e.label}]` : ''}`);
  const d = (node.data ?? {}) as Record<string, unknown>;
  let dataNote = '';
  if (node.kind === 'document' || node.kind === 'storyboard') {
    const md = String(d.markdown ?? '');
    if (md.trim()) dataNote = `\n内容摘要:${md.trim().slice(0, 300)}${md.length > 300 ? '…' : ''}`;
  } else if (node.kind === 'shot' && typeof d.prompt === 'string') {
    dataNote = `\n提示词:${d.prompt.slice(0, 200)}${d.prompt.length > 200 ? '…' : ''}`;
  } else {
    const j = JSON.stringify(d);
    if (j && j !== '{}') dataNote = `\ndata:${j.slice(0, 200)}${j.length > 200 ? '…' : ''}`;
  }
  return (
    `[当前选中节点]「${node.label}」 · ${node.kind} · id=${node.id}\n` +
    `⚠️ 用户正选中这个节点:除非用户明确指向别处,本轮操作对象就是它;` +
    `需要它的产物时直接用 canvas.connect 把它连为下游节点的上游,禁止绕道 assets.import 复制产物、另建资产节点。` +
    dataNote +
    (ins.length ? `\n入边:\n${ins.join('\n')}` : '') +
    (outs.length ? `\n出边:\n${outs.join('\n')}` : '')
  );
}

/**
 * 自定义协议 bba-asset:// —— 仅允许读取 ~/.bigbotart/assets/ 下的资产文件,
 * 供 renderer <img> 加载缩略图(无需把 webSecurity 关掉)。
 * 必须在 app.whenReady() 之前调用 registerSchemesAsPrivileged,声明 secure/standard/cors/BypassCSP,
 * 否则 fetch/Image 会拒载。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'bba-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
  {
    scheme: 'bba-output',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

// 引擎:BIGBOTART_DRYRUN=0 时真实 spawn h3;未设或非 0 则 dry-run 占位
// h3 开启 onLog:调试面板实时显示 h3 进度行
const logger = new DebugLogger();
const dryRun = process.env.BIGBOTART_DRYRUN !== '0';
logger.log(
  'info',
  `BigBotArt 启动 · BIGBOTART_DRYRUN=${process.env.BIGBOTART_DRYRUN ?? '(未设→dry-run)'} · dryRun=${dryRun} · outputs=${H3_OUTPUTS_DIR} · h3=${process.env.BIGBOTART_H3_BIN ?? '(默认)'}`,
);
const registry = createRegistry({
  h3c: {
    dryRun,
    binaryPath: process.env.BIGBOTART_H3_BIN,
    modelDir: process.env.BIGBOTART_H3_MODEL,
    onLog: (line) => logger.log('h3', line),
    outputDir: H3_OUTPUTS_DIR,
  },
  mlxgen: {
    dryRun,
    outputDir: process.env.BIGBOTART_MLXGEN_OUTPUTS ?? join(DATA_DIR, 'outputs', 'images'),
  },
});

const settings = new SettingsStore();
const accel = new AccelStore(settings);
const store = new ProjectStore();
/** 任何画布快照写盘(Agent 工具增量 / 渲染层整体保存)都广播给渲染层,
 *  画布页订阅后刷新本地状态 —— Agent 改的画布实时可见,并且渲染层保存不再带旧版本覆盖。 */
store.onCanvasSaved = (snap) => {
  if (win && !win.isDestroyed()) win.webContents.send('canvas-snapshot-updated', snap);
};
const assets = new AssetStore();
const skills = new SkillStore();
const takes = new TakeStore();
const exportSvc = new ExportService(takes);
const queue = new RenderQueue(registry, settings, logger);
const memory = new MemoryStore();
const tools = new ToolHandlers(store, assets, skills, exportSvc, queue, memory, {
  accel,
  takes, // engine.submit 本地图片节点(crop/stitch/split)执行后记 Take
  // 分镜表规划:工具调用(对话里让 Agent 出分镜表)→ agent.planStoryboard(真 LLM,失败回退确定性模板)
  // LLM 来源与 agent-plan 同口径:项目级覆盖 → 全局设置 → worker 默认
  planStoryboard: async (brief, opts) => {
    let llm: LlmSource | undefined;
    const project = opts?.projectId ? store.getProject(opts.projectId) : undefined;
    if (project?.llmOverride) llm = project.llmOverride;
    else if (settings.get().llm) llm = settings.get().llm;
    try {
      const ep = await resolveLlmEndpoint(settings.get(), llm);
      llm = { kind: 'openai-compatible', baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: ep.model };
    } catch (e) {
      console.warn(`[tool storyboard.plan] LLM 来源解析失败,回退确定性分镜表: ${(e as Error).message}`);
      llm = { kind: 'none' };
    }
    return agent.planStoryboard(brief, llm, {
      projectName: project?.name,
      basePrompt: opts?.basePrompt,
      autoMaterialize: opts?.autoMaterialize,
    });
  },
});

const agent = new AgentManager({
  // ✓ pi 以子进程隔离运行:worker 内嵌 pi-ai(远端 env 端点优先,否则本地 LM Studio)
  inline: false,
  defaultLlm: process.env.BIGBOTART_LLM_BASE_URL
    ? { kind: 'openai-compatible', baseUrl: process.env.BIGBOTART_LLM_BASE_URL, model: process.env.BIGBOTART_LLM_MODEL }
    : { kind: 'lmstudio' },
  llmBaseUrl: process.env.BIGBOTART_LLM_BASE_URL,
  // 不向 worker env 注入 API Key;云端 key 仅在单次 plan/chat RPC 的 LlmSource 中传递
  llmModel: process.env.BIGBOTART_LLM_MODEL,
  lmStudioUrl: process.env.BIGBOTART_LMSTUDIO_URL ?? 'http://127.0.0.1:1234/v1',
  lmStudioModel: settings.get().lmStudioModel ?? process.env.BIGBOTART_LMSTUDIO_MODEL ?? 'ornith-1.5-35b-a3b-abliterated-mlx',
});

/* Agent 工具执行桥:worker 反向 RPC → 主进程工具桥(ctx 来自 tool RPC,避免并发串写) */
agent.toolExecutor = async (req) => {
  const ctx = {
    projectId: req.params.projectId || currentToolCtx?.projectId || '',
    canvasId: req.params.canvasId || currentToolCtx?.canvasId || '',
  };
  const argsBrief = JSON.stringify(req.params.args ?? {}).slice(0, 120);
  logger.log('info', `agent.tool → ${req.params.tool}(${argsBrief})`);
  const res = await tools.call(req.params.tool, req.params.args, ctx);
  logger.log(res.ok ? 'info' : 'error', `agent.tool ${res.ok ? '✓' : '✕'} ${req.params.tool} → ${(res.result ?? '').slice(0, 160)}`);
  return { id: req.id, result: res };
};
/* Agent 实时事件 → 渲染层推送 + 日志总线 */
agent.onEvent = (ev: AgentEvent) => {
  if (ev.kind === 'continuity') {
    logger.log(ev.issues?.length ? 'warn' : 'info', `agent.continuity ${ev.issues?.length ? `发现 ${ev.issues.length} 处连续性问题` : '通过'}`);
  } else if (ev.kind === 'aborted') {
    logger.log('warn', 'agent.chat 已被用户打断');
  }
  win?.webContents.send('agent-event', {
    ...ev,
    projectId: ev.projectId || currentToolCtx?.projectId || '',
    canvasId: ev.canvasId || currentToolCtx?.canvasId || '',
  });
};

/** 队列任务完成 → 自动归档 Take(渲染层先建 takeId,这里写终态)+ 连续性校验 */
queue.onJobFinish = (job) => {
  // Take 归档:有 takeId 就 patch(渲染层创建),否则补一条
  if (job.takeId && job.projectId) {
    void takes.patch(job.projectId, job.takeId, {
      status: job.status,
      resultPath: job.resultPath,
      error: job.error,
    });
  } else if (job.projectId && (job.status === 'succeeded' || job.status === 'failed')) {
    takes.append(job.projectId, {
      shotNodeId: job.nodeId,
      status: job.status,
      providerTaskId: job.id,
      params: {},
      resultPath: job.resultPath,
      error: job.error,
    });
  }
  if (job.status !== 'succeeded' || !job.projectId || !job.canvasId) return;
  const ctx = { projectId: job.projectId, canvasId: job.canvasId };
  void tools.call('continuity.check', {}, ctx).then((res) => {
    const issues = res.result && res.result.includes('建议') ? [res.result] : [];
    win?.webContents.send('agent-event', {
      kind: 'continuity',
      projectId: job.projectId ?? '',
      canvasId: job.canvasId ?? '',
      issues,
      result: res.result,
    } satisfies AgentEvent);
  });
};

/** 队列变更 → 渲染层实时推送(精简视图,已剔除 req 大对象;窗口未建/已销毁时跳过) */
queue.onChange = (jobs) => {
  if (win && !win.isDestroyed()) win.webContents.send('render-queue-changed', jobs);
};

/** 当前活跃 chat 的工具上下文(按 chatKey 隔离,避免并发串写) */
const activeToolCtx = new Map<string, { projectId: string; canvasId: string }>();
/** 最近一次 chat 上下文(事件兜底;工具 RPC 已自带 projectId/canvasId) */
let currentToolCtx: { projectId: string; canvasId: string } | null = null;

/** 渲染层 console/报错转发到主进程 stdout(白屏排查用;dev 直连窗口难开 CDP) */
function wireConsole(win: BrowserWindow) {
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = level >= 3 ? 'ERROR' : level === 2 ? 'WARN' : 'INFO';
    console.error(`[renderer:${tag}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[renderer-gone] ${details.reason} exitCode=${details.exitCode}`);
  });
  win.webContents.on('preload-error', (_e, path, error) => {
    console.error(`[preload-error] ${path}: ${error.message}`);
  });
}

/** 调试日志 → 渲染层面板实时推送(窗口销毁自动退订) */
function wireDebugLog(win: BrowserWindow) {
  const unsub = logger.subscribe((entry) => {
    if (!win.isDestroyed()) win.webContents.send('debug-log', entry);
  });
  win.on('closed', () => unsub());
}

async function createWindow() {
  // 自定义应用图标(dev/unpacked 下 Electron 用默认图标;macOS 走 Dock,Windows/Linux 走窗口 icon。
  //  打包时需另配 electron-builder 的 icon/extraResources,目前仓库尚无打包配置)
  const iconPath = join(__dirname, '../../resources/icon.png');
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'BigBotArt',
    backgroundColor: '#14161a',
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    // 隐藏 macOS 原生标题栏:红绿灯悬浮内嵌,窗口拖拽由渲染层 .topbar/侧栏的 -webkit-app-region 承担
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox:true 与 ESM preload(.mjs) 不兼容(Cannot use import statement outside a module)
      sandbox: false,
      // 本地优先的创作工具:窗口被遮挡/后台时仍保持渲染与队列进度更新
      backgroundThrottling: false,
    },
  });
  wireConsole(win);
  wireDebugLog(win);

  // 外链/弹窗:仅允许 https 经系统浏览器打开,禁止应用内导航到任意 URL
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const allowed =
      url.startsWith('file://') ||
      (isDev && !!process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL));
    if (!allowed) {
      e.preventDefault();
      if (url.startsWith('https://')) void shell.openExternal(url);
    }
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

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
  // 🚀 加速 LoRA:开启且 real 模式时把蒸馏模型包解析成实际 modelDir(-d)+ steps(h3.c 不接受 --lora,见手册 §8)
  // demo 模式走 mock 占位,不解析(避免包缺失在演示路径误报)
  const accelReq = (params.accel ?? undefined) as { enabled?: boolean; packId?: string; steps?: number } | undefined;
  if (accelReq?.enabled && req.slot === 'video' && settings.get().renderMode === 'real') {
    const resolved = accel.resolveAccel(accelReq);
    if (!resolved) {
      throw new Error('加速 LoRA 开启但模型包不可用(未安装或目录缺失) · 请到设置页「加速 LoRA」检查');
    }
    params.modelDir = resolved.modelDir;
    params.steps = resolved.steps;
    logger.log('info', `submit-render accel: -d ${resolved.modelDir} --steps ${resolved.steps}`);
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
ipcMain.handle('set-project-llm', (_e, projectId: string, llm: LlmSource | null) => store.setProjectLlm(projectId, llm));
// 多画布
ipcMain.handle('load-project-canvases', (_e, projectId: string) => store.loadProjectCanvases(projectId));
ipcMain.handle('save-canvas-snapshot', (_e, snap) => store.saveCanvasSnapshot(snap));
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
  ipcMain.handle('delete-asset', (_e, id: string) => {
    const refs = collectAssetRefs(store, id);
    return { ...assets.delete(id), refs };
  });
  ipcMain.handle('update-asset', (_e, id: string, patch: { name?: string; categoryId?: string | null; projectId?: string | null; tags?: string[] }) =>
    assets.update(id, patch),
  );
  ipcMain.handle('list-asset-categories', () => assets.listCategories());
  ipcMain.handle('create-asset-category', (_e, name: string, projectId?: string) => assets.createCategory(name, projectId));
  ipcMain.handle('rename-asset-category', (_e, id: string, name: string) => assets.renameCategory(id, name));
  ipcMain.handle('delete-asset-category', (_e, id: string) => assets.deleteCategory(id));
  ipcMain.handle('asset-refs', (_e, assetId: string) => collectAssetRefs(store, assetId));
  ipcMain.handle('list-trash', () => assets.listTrash());
  ipcMain.handle('restore-asset', (_e, id: string) => assets.restore(id));
  ipcMain.handle('empty-trash', () => assets.emptyTrash());
  ipcMain.handle('archive-products', (_e, input: { projectId: string; items: Array<{ nodeId: string; path: string }>; categoryId?: string }) =>
    assets.archiveProducts(input.projectId, input.items, input.categoryId),
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
ipcMain.handle('apply-skill', (_e, skillId: string, projectName: string, activate = false) => {
  const project = skills.apply(skillId, projectName, store);
  if (activate) {
    const canvasId = project.activeCanvasId || 'main';
    memory.setActiveSkillId(project.id, canvasId, skillId);
  }
  return { project };
});
ipcMain.handle('delete-skill', (_e, id: string) => skills.delete(id));
ipcMain.handle('skill-read', (_e, skillId: string) => skills.get(skillId) ?? null);
ipcMain.handle('skill-update', (_e, skillId: string, patch: { name?: string; description?: string; instructions?: string | null; inject?: 'full' | 'summary' }) => skills.update(skillId, patch));
ipcMain.handle('skill-activate', (_e, projectId: string, canvasId: string, skillId: string) => {
  const skill = skills.get(skillId);
  if (!skill) return { ok: false as const, error: 'Skill 不存在' };
  memory.setActiveSkillId(projectId, canvasId, skillId);
  return { ok: true as const, preview: (skill.instructions ?? '').slice(0, 60), hasInstructions: !!skill.instructions };
});
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

// ---------- IPC:视频取帧(镜头接续尾帧归档 / 取帧编辑) ----------
ipcMain.handle('extract-frame', (_e, videoPath: string, mode: 'first' | 'last') => extractFrame(videoPath, mode));
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
ipcMain.handle('set-settings', (_e, patch) => settings.patch(patch));

// ---------- IPC:加速 LoRA(蒸馏模型包)管理 ----------
ipcMain.handle('accel-list', () => accel.list());
ipcMain.handle('accel-install', (_e, input: { name: string; path: string; steps?: number }) => accel.install(input));
ipcMain.handle('accel-remove', (_e, id: string) => accel.remove(id));
ipcMain.handle('accel-set-default', (_e, id: string | null) => accel.setDefault(id));

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
    llm = { kind: 'openai-compatible', baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: ep.model };
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
    llm = { kind: 'openai-compatible', baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: ep.model };
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

/* ---------- IPC:Agent 对话(多轮 + 工具 + 记忆) ---------- */
ipcMain.handle('agent-chat', async (_e, req: AgentChatRequest): Promise<AgentChatResponse> => {
  let llm: LlmSource | undefined;
  const project = store.getProject(req.projectId);
  if (project?.llmOverride) llm = project.llmOverride;
  else if (settings.get().llm) llm = settings.get().llm;
  try {
    const ep = await resolveLlmEndpoint(settings.get(), llm);
    llm = { kind: 'openai-compatible', baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: ep.model };
  } catch (e) {
    return { ok: false, error: `LLM 来源不可用:${(e as Error).message}` };
  }

  // 记忆上下文组装(skillResolver:激活技能经 SkillStore 解析,注入「【当前技能】」指令段;
  // canvas 快照:注入「【当前画布】」实时状态段,让 Agent 首轮就感知画布轮廓)
  const ctxSnap = store.loadProjectCanvases(req.projectId).canvases.find((c) => c.id === req.canvasId);
  const ctx = memory.buildContext(
    req.projectId,
    req.canvasId,
    req.text,
    (id) => skills.get(id),
    ctxSnap ? { name: ctxSnap.name, nodes: ctxSnap.nodes, edges: ctxSnap.edges } : undefined,
  );
  const chatKey = `${req.projectId}:${req.canvasId}:${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const toolCtx = { projectId: req.projectId, canvasId: req.canvasId };
  activeToolCtx.set(chatKey, toolCtx);
  currentToolCtx = toolCtx;

  // 记录用户消息到 recall(附件名 + 当轮关注节点一并留痕,渲染层据此回显「关注:节点」徽标)
  const atts = req.attachments ?? [];
  const visibleText = req.text + (atts.length ? ` 📎${atts.map((a) => a.name).join('、')}` : '');
  const selNode = req.selectedNodeId && ctxSnap ? ctxSnap.nodes.find((x) => x.id === req.selectedNodeId) : undefined;
  memory.addRecall(req.projectId, {
    canvasId: req.canvasId,
    role: 'user',
    content: visibleText,
    selectedNodeId: selNode?.id,
    selectedNodeTitle: selNode?.label,
  });
  logger.log('info', `agent.chat 开始 · "${req.text.slice(0, 60)}"${atts.length ? ` · 附件 ${atts.length} 个` : ''}`);

  // 附件先拷入项目文件夹(projects/<pid>/assets/),Agent 一律使用项目内副本——
  // 项目自包含、可迁移;路径在 DATA_DIR 白名单内,下游 headless 导入/引用均合法
  const projAtts = copyAttachmentsToProject(
    req.projectId,
    atts.map((a) => {
      const full = assets.get(a.id);
      return {
        ...a,
        localPath: full?.localPath ?? a.localPath,
        width: full?.width,
        height: full?.height,
        durationSec: full?.durationSec,
      };
    }),
  );
  // 附件自动登记为项目资源(source='attachment'):项目资源页可见;按 localPath 幂等,重复对话不重复登记
  for (const pa of projAtts) {
    if (pa.copied && pa.projectPath) await assets.registerAttachment(req.projectId, { id: pa.id, path: pa.projectPath });
  }
  // 附件注入:项目内路径 + 尺寸元数据直接给 LLM(免去 assets.get 往返,也避免"信息太简略看不出内容")
  const attNote = projAtts.length
    ? `\n\n[用户附件 · 已拷入项目文件夹,可直接作为参考图/素材使用(也可用 canvas.create_node(kind=asset) 引用到画布):\n${projAtts
        .map(
          (a) =>
            `- ${a.name}(${a.kind},assetId=${a.id}${a.width ? `,${a.width}×${a.height}` : ''}${a.durationSec ? `,${a.durationSec}s` : ''}) → ${a.projectPath}${a.copied ? '' : '(源文件缺失,未拷入项目)'}`,
        )
        .join('\n')}]`
    : '';

  // 选中节点注入:用户正在操作哪个节点 → 详情摘要附进本轮 user 消息(风格对齐 canvas.get_node)
  const selNote = selNode && ctxSnap ? `\n\n${describeSelectedNode(selNode, ctxSnap.edges, ctxSnap.nodes)}` : '';

  try {
    const result = await agent.chat({
      projectId: req.projectId,
      canvasId: req.canvasId,
      text: req.text + attNote + selNote,
      context: ctx,
      llm,
    });
    logger.log(
      'info',
      `agent.chat 完成 · 工具 ${result.toolCalls.length} 个${result.ask ? ' · 暂停待用户确认(ask.user)' : ''}${result.aborted ? ' · 已打断' : ''} · 回复 ${result.reply.length} 字`,
    );
    // assistant 回复记入 recall
    if (result.reply) {
      memory.addRecall(req.projectId, { canvasId: req.canvasId, role: 'assistant', content: result.reply });
    }
    // 工具调用记入 recall(role=tool,留痕回看)+ 成功动作记入 recall(role=system,注入下一轮上下文)
    for (const tc of result.toolCalls) {
      memory.addRecall(req.projectId, {
        canvasId: req.canvasId, role: 'tool',
        content: `${tc.name}(${JSON.stringify(tc.args).slice(0, 120)})`,
        toolName: tc.name, toolArgs: tc.args, toolResult: tc.result,
      });
      if (tc.ok) {
        memory.addRecall(req.projectId, {
          canvasId: req.canvasId, role: 'system',
          content: describeToolAction(tc.name, tc.args, tc.nodeId),
        });
      }
    }
    // ask.user 暂停卡也记入 recall(被 worker 拦截、不经工具桥):刷新/切换后恢复成可点选的确认卡,而不是丢成纯文本
    if (result.ask) {
      memory.addRecall(req.projectId, {
        canvasId: req.canvasId, role: 'tool',
        content: `ask.user(${result.ask.question.slice(0, 120)})`,
        toolName: 'ask.user',
        toolArgs: { question: result.ask.question, options: result.ask.options },
        toolResult: '(已暂停,等待用户选择)',
      });
    }
    return { ok: true, reply: result.reply, thinking: result.thinking, toolCalls: result.toolCalls, ask: result.ask, aborted: result.aborted };
  } catch (e) {
    logger.log('error', `agent.chat 失败:${(e as Error).message}`);
    return { ok: false, error: (e as Error).message };
  } finally {
    activeToolCtx.delete(chatKey);
    // 仅当仍指向本会话时清空,避免并发 chat 的 finally 互相踩掉
    if (currentToolCtx === toolCtx) {
      const remaining = [...activeToolCtx.values()].at(-1) ?? null;
      currentToolCtx = remaining;
    }
  }
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

/** 把 recall 消息组装成压缩用的 LLM 上下文(tool 记录转成带标记的 user 文本,便于模型理解"发生了什么") */
function compactContext(msgs: RecallMessage[]): { systemPrompt: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> } {
  return {
    systemPrompt: '你是 BigBotArt 的对话压缩助手。用户会给你一段创作对话,你的任务是把它们压缩成简洁的中文摘要。只输出摘要正文。',
    messages: msgs.map((r) => {
      if (r.role === 'assistant') return { role: 'assistant', content: r.content };
      if (r.role === 'tool') {
        return {
          role: 'user',
          content: `[工具调用] ${r.toolName ?? '?'}(${JSON.stringify(r.toolArgs ?? {}).slice(0, 100)}) → ${(r.toolResult ?? '').slice(0, 200)}`,
        };
      }
      if (r.role === 'system') {
        return { role: 'user', content: `[系统] ${r.content}` };
      }
      return { role: 'user', content: r.content };
    }),
  };
}

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
    llm = { kind: 'openai-compatible', baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: ep.model };
  } catch {
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

async function probeSimple(
  id: RuntimeProbe['id'],
  label: string,
  port: number,
): Promise<RuntimeProbe> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    return { id, label, detected: true, status: 'ready', port, version: `:${port}`, detail: `HTTP ${res.status}` };
  } catch {
    const hint: Record<RuntimeProbe['id'], string> = {
      lmstudio: '在 LM Studio 中开启 Local Server(端口 1234)',
      ollama: '运行 ollama serve',
      comfyui: '启动 ComfyUI 桌面端',
      h3c: '',
      mlxgen: '',
    };
    return { id, label, detected: false, status: 'missing', port, detail: hint[id] };
  }
}

app.whenReady().then(async () => {
  // macOS Dock 图标(dev 下默认是 Electron 图标,这里换成项目图标)
  const dockIcon = join(__dirname, '../../resources/icon.png');
  if (existsSync(dockIcon)) {
    const img = nativeImage.createFromPath(dockIcon);
    if (img.isEmpty()) {
      logger.log('warn', `Dock 图标加载失败(图片为空):${dockIcon}`);
    } else {
      app.dock?.setIcon(img);
      logger.log('info', `Dock 图标已设置:${dockIcon} (${img.getSize().width}×${img.getSize().height})`);
    }
  } else {
    logger.log('warn', `Dock 图标文件不存在:${dockIcon}`);
  }
  // 注册 bba-asset:// 协议:仅允许读取 ~/.bigbotart/assets/ 下的 asset-<id>.<ext> 文件
  // (renderer 用 <img src="bba-asset://<filename>"> 显示资产缩略图,无需 webSecurity:false)
  protocol.handle('bba-asset', async (req) => {
    try {
      const url = new URL(req.url);
      // 文件名在 url.host(因为 URL 形如 bba-asset://<filename>,没有路径段)
      const rawHost = url.host + url.pathname.replace(/\/+$/, '');
      const name = decodeURIComponent(rawHost).replace(/^\/+/, '');
      if (!/^asset-[A-Za-z0-9._-]+$/.test(name)) {
        return new Response(`bad asset name: ${name}`, { status: 400 });
      }
      const file = join(ASSETS_DIR, name);
      const { resolve } = await import('node:path');
      const real = resolve(file);
      if (!real.startsWith(resolve(ASSETS_DIR) + '/')) {
        return new Response('forbidden', { status: 403 });
      }
      return net.fetch(`file://${real}`);
    } catch (e) {
      return new Response(`error: ${(e as Error).message}`, { status: 500 });
    }
  });

  // 注册 bba-output:// 协议:读生成产物目录(含 mock/、images/ 子目录;多根目录兼容旧路径)
  protocol.handle('bba-output', async (req) => {
    try {
      const url = new URL(req.url);
      const rawHost = url.host + url.pathname.replace(/\/+$/, '');
      const name = decodeURIComponent(rawHost).replace(/^\/+/, '');
      // 允许相对路径段(mock/xxx.mp4);禁止 .. 与绝对盘符
      if (!name || name.includes('..') || name.startsWith('/') || !/^[A-Za-z0-9._/-]+$/.test(name)) {
        return new Response(`bad output name: ${name}`, { status: 400 });
      }
      for (const outRoot of outputSearchRoots()) {
        const real = resolve(join(outRoot, name));
        if (real !== outRoot && !real.startsWith(outRoot + '/')) continue;
        if (existsSync(real)) return net.fetch(`file://${real}`);
      }
      return new Response(`not found: ${name}`, { status: 404 });
    } catch (e) {
      return new Response(`error: ${(e as Error).message}`, { status: 500 });
    }
  });

  await store.init();
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  void agent.stop();
  if (process.platform !== 'darwin') app.quit();
});