/**
 * Electron 主进程 — 窗口 + IPC + 服务编排
 * M1 闭环:项目/画布持久化 · 渲染队列(槽位互斥) · 资产导入 · Skills · 时间线导出 · 设置(LLM/渲染模式)
 */
import { app, BrowserWindow, ipcMain, protocol, net, shell } from 'electron';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRegistry } from '@bigbotart/providers';
import { AgentManager } from '@bigbotart/agent';
import { ProjectStore } from './store';
import { SettingsStore } from './settings';
import { AssetStore, OUTPUTS_DIR, ASSETS_DIR, outputSearchRoots } from './assets';
import { SkillStore } from './skills';
import { ExportService } from './export';
import { extractFrame } from './frames';
import { RenderQueue } from './render-queue';
import { MemoryStore } from './memory';
import { ToolHandlers } from './tool-handlers';
import { TakeStore } from './takes';
import { DebugLogger } from './logger';
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
import type { RuntimeProbe, RenderRequest, LlmSource, RenderStatus, AgentChatRequest, AgentChatResponse, AgentEvent } from '@bigbotart/shared';

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
const store = new ProjectStore();
const assets = new AssetStore();
const skills = new SkillStore();
const takes = new TakeStore();
const exportSvc = new ExportService(takes);
const queue = new RenderQueue(registry, settings, logger);
const memory = new MemoryStore();
const tools = new ToolHandlers(store, assets, skills, exportSvc, queue, memory, {
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
    takes.patch(job.projectId, job.takeId, {
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
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'BigBotArt',
    backgroundColor: '#14161a',
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

ipcMain.handle('install-runtime', async (_e, id: string) => {
  const cmds: Record<string, string> = {
    lmstudio: 'open -a "LM Studio" 或官网 https://lmstudio.ai 下载',
    ollama: 'brew install ollama',
    mlxgen: 'uv tool install --upgrade mlx-gen',
    comfyui: '请从 https://github.com/comfyanonymous/ComfyUI 安装',
  };
  return { ok: false, message: cmds[id] ?? `未知运行时 ${id}`, manual: true };
});

// ---------- IPC:渲染任务(经队列,槽位互斥) ----------
ipcMain.handle('check-providers', () => registry.checkAll());
ipcMain.handle('submit-render', (_e, req: RenderRequest) => {
  logger.log('info', `submit-render node=${req.nodeId} slot=${req.slot} provider=${req.provider} takeId=${req.takeId ?? '—'} mode=${String((req.params as Record<string, unknown>).mode ?? '?')} tier=${String((req.params as Record<string, unknown>).tier ?? '?')} w=${String((req.params as Record<string, unknown>).width ?? '?')} h=${String((req.params as Record<string, unknown>).height ?? '?')}`);
  return queue.submit(req);
});

// ---------- IPC:调试日志 ----------
ipcMain.handle('debug-logs', () => logger.list());
ipcMain.handle('debug-clear', () => logger.clear());
ipcMain.handle('queue-status', () => queue.list());
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
ipcMain.handle('cancel-render', (_e, provider: string, handle: { providerTaskId: string }) => {
  queue.cancel(handle);
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
    version: snap.version ?? cur.version,
    createdAt: cur.createdAt,
    updatedAt: new Date().toISOString(),
  });
});

  // ---------- IPC:资产中心 ----------
  ipcMain.handle('import-assets', (_e, opts?: { paths?: string[] }) => {
    // paths 给定时走 headless(白名单目录);否则弹系统对话框(用户显式选择,不受限)
    if (opts?.paths?.length) return assets.importFromPaths(opts.paths);
    return assets.importFromDialog();
  });
ipcMain.handle('list-assets', () => assets.list());
ipcMain.handle('delete-asset', (_e, id: string) => assets.delete(id));

// ---------- IPC:Skills ----------
ipcMain.handle('list-skills', () => skills.list());
ipcMain.handle('save-skill', (_e, input: { name: string; projectId: string; canvasId?: string }) => {
  const pc = store.loadProjectCanvases(input.projectId);
  const cur = input.canvasId
    ? pc.canvases.find((c) => c.id === input.canvasId)
    : pc.canvases.find((c) => c.id === pc.activeCanvasId) ?? pc.canvases[0];
  if (!cur) throw new Error('项目下没有任何画布可保存');
  return skills.save(input.name, cur);
});
ipcMain.handle('apply-skill', (_e, skillId: string, projectName: string) => {
  const project = skills.apply(skillId, projectName, store);
  return { project };
});
ipcMain.handle('delete-skill', (_e, id: string) => skills.delete(id));

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

  // 记忆上下文组装
  const ctx = memory.buildContext(req.projectId, req.canvasId, req.text);
  const chatKey = `${req.projectId}:${req.canvasId}:${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const toolCtx = { projectId: req.projectId, canvasId: req.canvasId };
  activeToolCtx.set(chatKey, toolCtx);
  currentToolCtx = toolCtx;

  // 记录用户消息到 recall(附件名一并留痕)
  const atts = req.attachments ?? [];
  const visibleText = req.text + (atts.length ? ` 📎${atts.map((a) => a.name).join('、')}` : '');
  memory.addRecall(req.projectId, { canvasId: req.canvasId, role: 'user', content: visibleText });
  logger.log('info', `agent.chat 开始 · "${req.text.slice(0, 60)}"${atts.length ? ` · 附件 ${atts.length} 个` : ''}`);

  // 附件注入:资产 id 告诉 LLM,Agent 可用 assets.get 查详情 / canvas.create_node 引用
  const attNote = atts.length
    ? `\n\n[用户附件 · 已在资产库,可用 assets.get 查看详情,或用 canvas.create_node(kind=asset) 引用到画布:\n${atts.map((a) => `- ${a.name}(${a.kind},assetId=${a.id})`).join('\n')}]`
    : '';

  try {
    const result = await agent.chat({
      projectId: req.projectId,
      canvasId: req.canvasId,
      text: req.text + attNote,
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
    // 工具调用记入 recall(role=tool)
    for (const tc of result.toolCalls) {
      memory.addRecall(req.projectId, {
        canvasId: req.canvasId, role: 'tool',
        content: `${tc.name}(${JSON.stringify(tc.args).slice(0, 120)})`,
        toolName: tc.name, toolArgs: tc.args, toolResult: tc.result,
      });
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