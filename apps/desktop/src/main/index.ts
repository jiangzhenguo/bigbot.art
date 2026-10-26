/**
 * Electron 主进程 — 窗口 + IPC + 服务编排
 * M1 闭环:项目/画布持久化 · 渲染队列(槽位互斥) · 资产导入 · Skills · 时间线导出 · 设置(LLM/渲染模式)
 */
import { registerDesktopIpc } from './api-surface';
import { createRemoteServer, type RemoteControl } from './remote/server';
import { connectTunnel } from './remote/tunnel-client';
import { readPairingKey, writePairingKey } from './remote/relay-secret';
import { DEFAULT_REMOTE_PORT, type AppSettings, type RelayTunnelStatus, type RemoteAccessStatus } from '@bigbotart/shared';
import { randomBytes } from 'node:crypto';
import {
  app,
  BrowserWindow,
  protocol,
  shell,
  nativeImage,
  nativeTheme,
} from 'electron';
import {
  join,
  resolve,
} from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRegistry } from '@bigbotart/providers';
import { AgentManager } from '@bigbotart/agent';
import { ProjectStore } from './store';
import { SettingsStore } from './settings';
import { AccelStore } from './lora';
import { H3StyleModelBuilder } from './h3-style-model';
import {
  AssetStore,
  OUTPUTS_DIR,
  ASSETS_DIR,
  outputSearchRoots,
  rangeFileResponse,
  copyAttachmentsToProject,
  formatAssetBrief,
  isValidOutputRelName,
} from './assets';
import { SkillStore } from './skills';
import { ExportService } from './export';
import { RenderQueue } from './render-queue';
import {
  AutoContinueController,
  buildAutoContinueText,
  buildAutoRecallNote,
} from './auto-continue';
import { waitUntilFlightFree } from './flight-turn';
import { MemoryStore } from './memory';
import { ToolHandlers } from './tool-handlers';
import { requestH3PromptCompletion } from './h3-prompt';
import { TakeStore } from './takes';
import { runDataMigration } from './migrate';
import { DATA_DIR } from './workspace-paths';
import { DebugLogger } from './logger';
import { EventHub } from './event-hub';
import { installCrashGuard } from './crash-guard';
import { packagedToolPath } from './tool-path';
import {
  applyThemeSource,
  normalizeTheme,
  windowBackgroundColor,
} from './theme';
import { buildMlxgenRoute } from './vision';
import {
  resolveLlmEndpoint,
  probeLoadedContextTokens,
  toChatLlm,
} from './llm';
import {
  placementOf,
  planContext,
} from './context-budget';
import type {
  RuntimeProbe,
  LlmSource,
  AgentChatRequest,
  AgentChatResponse,
  AgentEvent,
  RecallMessage,
  CanvasNode,
  CanvasEdge,
} from '@bigbotart/shared';
import {
  PLAN_APPROVE_LABEL,
  openShots,
} from '@bigbotart/shared';

const isDev = !app.isPackaged;

// 打包版从 Finder/Dock 启动时 PATH 只有系统目录(/usr/bin:/bin…)。
// ffmpeg 多在 Homebrew;uv 把 mlxgen 放在 ~/.local/bin。缺后者时 spawn('mlxgen') 直接 ENOENT。
// dev 从终端启动自带用户 PATH,不动。
if (!isDev) {
  process.env.PATH = packagedToolPath(process.env.PATH, homedir());
}

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
    case 'h3.write_prompt':
      return `已按 H3 规范写回镜头提示词 ${j(args.nodeId)}`;
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
    case 'todo.write': {
      const n = Array.isArray(args.todos) ? args.todos.length : 0;
      return n ? `已更新任务清单(${n} 项)` : '已清空任务清单';
    }
    case 'plan.present':
      return '已提交多镜计划,等待用户确认';
    default:
      return `已执行 ${name}`;
  }
}

/** 选中/引用节点详情摘要(附进本轮 user 消息,风格对齐 canvas.get_node 但只挑关键信息控制长度)。
 *  顶部带指令性说明:引用 = 用户指着它,是本轮默认操作对象——
 *  真实事故:用户选中 image-gen 节点说「编辑这个图片」,Agent 绕道 assets.import 复制产物
 *  新建资产节点再连线,没有直接把选中节点连为上游。
 *  2026-10 起支持多节点(右键「添加到聊天窗口」+ 输入框 @ 提及),index/total 用于标注序号。 */
function describeSelectedNode(
  node: CanvasNode,
  edges: CanvasEdge[],
  nodes: CanvasNode[],
  index?: number,
  total?: number,
  resolveAsset?: (assetId: string) => import('@bigbotart/shared').Asset | undefined,
): string {
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
  } else if (node.kind === 'asset') {
    const aid = String(d.assetId ?? '').trim();
    const as = aid && resolveAsset ? resolveAsset(aid) : undefined;
    if (as) dataNote = `\n${formatAssetBrief(as, { captionMax: 300 })}`;
    else if (aid) dataNote = `\n资产未加载 assetId=${aid}`;
  } else {
    const j = JSON.stringify(d);
    if (j && j !== '{}') dataNote = `\ndata:${j.slice(0, 200)}${j.length > 200 ? '…' : ''}`;
  }
  const multi = total !== undefined && total > 1;
  const header = multi ? `[用户引用的节点 ${index! + 1}/${total}]` : '[当前选中节点]';
  const directive = multi
    ? `⚠️ 用户在本轮消息里引用了 ${total} 个节点,这是其中之一:除非用户明确指向别处,本轮操作对象就在它们之中;`
    : `⚠️ 用户正选中这个节点:除非用户明确指向别处,本轮操作对象就是它;`;
  return (
    `${header}「${node.label}」 · ${node.kind} · id=${node.id}\n` +
    directive +
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

// 安装包从访达启动,没有 pnpm dev 注入的 BIGBOTART_DRYRUN=0。
// 判定式不改(仍是 !== '0')。这里只在「已打包且环境没写这个变量」时补上 0,
// 与 pnpm start 相同。设置里的 renderMode 默认仍是 demo,真实推理还要用户打开。
if (app.isPackaged && process.env.BIGBOTART_DRYRUN == null) {
  process.env.BIGBOTART_DRYRUN = '0';
}
// 引擎:BIGBOTART_DRYRUN=0 时真实 spawn h3;未设或非 0 则 dry-run 占位
// h3 开启 onLog:调试面板实时显示 h3 进度行
const logger = new DebugLogger();
// 崩溃兜底:尽早挂上(业务代码之前)。Electron 默认会把主进程未捕获异常/未处理拒绝弹成
// 原生错误框(「A JavaScript error occurred in the main process」)——有我们自己的监听后它不再弹,
// 异常改走日志总线(调试面板 + 终端),进程继续运行。详见 crash-guard.ts
installCrashGuard(logger);
/** 桌面窗口与远程 WebSocket 共用的事件总线。Electron 侧在这里扇出到所有窗口。 */
const hub = new EventHub();
let hubBroadcasting = false;
hub.subscribe((channel, payload) => {
  if (hubBroadcasting) return;
  hubBroadcasting = true;
  try {
    for (const target of BrowserWindow.getAllWindows()) {
      if (target.isDestroyed()) continue;
      try {
        target.webContents.send(channel, payload);
      } catch (e) {
        logger.log('error', `窗口事件发送失败 ${channel}: ${(e as Error).message}`);
      }
    }
  } finally {
    hubBroadcasting = false;
  }
});
logger.subscribe((entry) => hub.publish('debug-log', entry));
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

const settings = new SettingsStore({ onWarn: (m) => logger.log('warn', m) });
const accel = new AccelStore(settings);
/** 风格模型包(mystic 等)下载 + 融合构建;进度推送到渲染层设置页 */
const styleModels = new H3StyleModelBuilder((ev) => {
  hub.publish('style-model-progress', ev);
  logger.log(ev.stage === 'error' ? 'error' : 'info', `[style-model] ${ev.packId} ${ev.stage}: ${ev.message}`);
});

/* ── 数据迁移:平铺文件 → workspaces/<pid>/ 子目录(2026-09-29) ──
 * ⚠️ 必须在**任何 Store 构造之前**执行:ProjectStore 的构造函数就会读画布文件,
 * 晚于它调用会读到旧路径的空容器。幂等,重复启动秒返回。 */
const migration = runDataMigration();
if (migration.ran) {
  logger.log(
    'info',
    `[migrate] 数据目录已按工作空间收拢:${migration.projectsHandled} 个项目 / ${migration.movedFiles} 个文件` +
      (migration.failures.length ? ` · ⚠️ ${migration.failures.length} 项失败:${JSON.stringify(migration.failures)}` : '') +
      (migration.backupDir ? ` · 备份 ${migration.backupDir}` : ''),
  );
}

const store = new ProjectStore();
/** 任何画布快照写盘(Agent 工具增量 / 渲染层整体保存)都广播给渲染层,
 *  画布页订阅后刷新本地状态 —— Agent 改的画布实时可见,并且渲染层保存不再带旧版本覆盖。 */
store.onCanvasSaved = (snap) => {
  hub.publish('canvas-snapshot-updated', snap);
};
const assets = new AssetStore();
const skills = new SkillStore();
const takes = new TakeStore();
/* 清理「孤儿 Take」:RenderQueue 的 jobs 是内存态,应用退出后队列丢失但 Take 留在磁盘,
 * 这些 queued/running 记录会永久显示成「排队中」(用户以为还在跑)。启动时统一标为 failed。 */
try {
  const orphans = takes.reconcileOrphaned(store.listProjects().map((p) => p.id));
  if (orphans.cleaned > 0) {
    logger.log(
      'warn',
      `[takes] 清理 ${orphans.cleaned} 条重启前残留的未完成 Take(标记为失败):` +
        orphans.details.map((d) => `${d.projectId}/${d.takeId}(${d.from})`).join(', '),
    );
  }
} catch (e) {
  logger.log('warn', `[takes] 孤儿 Take 清理失败(不影响启动):${(e as Error).message}`);
}
const exportSvc = new ExportService(takes, (pid, nid) => {
  // timeline 成片等「节点产物型」入线条目没有 Take:从画布快照读节点 data.resultPath
  const pc = store.loadProjectCanvases(pid);
  for (const c of pc.canvases) {
    const n = c.nodes.find((x) => x.id === nid);
    const p = String((n?.data as Record<string, unknown> | undefined)?.resultPath ?? '');
    if (p) return p;
  }
  return undefined;
});
const queue = new RenderQueue(registry, settings, logger);
const memory = new MemoryStore();
const tools = new ToolHandlers(store, assets, skills, exportSvc, queue, memory, {
  accel,
  takes, // engine.submit 本地图片节点(crop/stitch/split)执行后记 Take
  // 🆕 工具模型(v1):图片节点缺省模型 + 看图通道,实时从 SettingsStore 读(改设置即生效,免重启)
  getToolModels: () => settings.get().toolModels,
  completeH3Prompt: async (projectId, messages) => {
    try {
      const project = store.getProject(projectId);
      const llm = project?.llmOverride ?? settings.get().llm;
      const ep = await resolveLlmEndpoint(settings.get(), llm);
      const result = await requestH3PromptCompletion(
        { baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: ep.model, protocol: ep.protocol },
        messages,
      );
      if (!result.ok) logger.log('warn', `[h3.write_prompt] ${result.error}`);
      return result;
    } catch (e) {
      const error = `写提示词的模型不可用:${(e as Error).message}`;
      logger.log('warn', `[h3.write_prompt] ${error}`);
      return { ok: false, error };
    }
  },
  resolveVisionOverride: async () => {
    const tm = settings.get().toolModels;
    // ① 本地引擎通道(mlx-gen `mlxgen-caption`,2026-10):不需要任何 server 在跑,优先于端点绑定
    if (tm?.captionLocal) {
      const route = await buildMlxgenRoute(process.env, tm.captionLocal);
      if (route.kind === 'mlxgen' && route.config) return route;
      // 显式绑定但本机不可用 → 把原因带回上层报出来(不偷偷换端点;用户要的就是这条通道)
      console.warn(`[toolModels] 本地看图通道不可用: ${route.kind === 'mlxgen' ? route.reason : ''}`);
      return route;
    }
    // ② 端点通道(存量行为):settings.toolModels.vision → OpenAI 兼容端点
    const v = tm?.vision;
    if (!v) return undefined;
    try {
      const ep = await resolveLlmEndpoint(settings.get(), v);
      return { kind: 'endpoint' as const, endpoint: { baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: ep.model, protocol: ep.protocol } };
    } catch (e) {
      console.warn(`[toolModels] 看图端点解析失败,回退 env 链: ${(e as Error).message}`);
      return undefined;
    }
  },
  // 分镜表规划:工具调用(对话里让 Agent 出分镜表)→ agent.planStoryboard(真 LLM,失败回退确定性模板)
  // LLM 来源与 agent-plan 同口径:项目级覆盖 → 全局设置 → worker 默认
  planStoryboard: async (brief, opts) => {
    let llm: LlmSource | undefined;
    const project = opts?.projectId ? store.getProject(opts.projectId) : undefined;
    if (project?.llmOverride) llm = project.llmOverride;
    else if (settings.get().llm) llm = settings.get().llm;
    try {
      const ep = await resolveLlmEndpoint(settings.get(), llm);
      llm = toChatLlm(ep);
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
    threadId: req.params.threadId || currentToolCtx?.threadId,
    selectedNodeId: currentToolCtx?.selectedNodeId,
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
  // 记录「已成功完成的工具」:长任务失败/超时时用它说明画布改动是否已生效
  if (ev.kind === 'tool-end' && ev.ok) {
    const key = `${ev.projectId}:${ev.canvasId}`;
    const list = toolActivity.get(key) ?? [];
    list.push(describeToolAction(ev.toolName ?? '', ev.toolArgs ?? {}, ev.nodeId));
    toolActivity.set(key, list.slice(-20));
  }
  hub.publish('agent-event', {
    ...ev,
    projectId: ev.projectId || currentToolCtx?.projectId || '',
    canvasId: ev.canvasId || currentToolCtx?.canvasId || '',
    threadId: ev.threadId || currentToolCtx?.threadId,
  });
};

/**
 * 队列任务完成 → 自动归档 Take(渲染层先建 takeId,这里写终态)+ 连续性校验。
 *
 * ⚠️ 这里是 async,且 RenderQueue.finishJob 会 **await 本回调落盘后**才 notify 渲染层。
 * 原因:takes.patch 内部要 await ffprobe 探测媒体时长,若不等它 save 完就推送队列变更,
 * 渲染层重拉 Take 历史会读到仍是 queued 的旧记录 → 检查器 chip 停在「排队中」,
 * 必须用户再点一下才刷新(2026-09-29 真实事故)。
 */
queue.onJobFinish = async (job) => {
  // Take 归档:有 takeId 就 patch(提交方创建),否则补一条
  if (job.takeId && job.projectId) {
    await takes.patch(job.projectId, job.takeId, {
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
  } else if (job.status === 'succeeded' || job.status === 'failed') {
    /* ⚠️ 兜底留痕(红线 R6:禁止静默吞错)。任务结局明确却没有 projectId 时,上面两个分支
       全落空 → 这条任务在 Take 历史里**完全不存在**,用户看到「生成成功但画布上什么都没有」,
       失败任务更是连错误都无处回查(2026-09-28 真实事故:Agent 提交漏传 projectId/canvasId,
       17:10 出的片 18:09 才在产物目录里被人工发现)。工具侧已补齐字段,这里再兜一层日志,
       让任何**未来新增的提交方**漏传字段时立刻在日志总线暴露,而不是静默丢归档。 */
    logger.log(
      'warn',
      `[queue] job=${job.id} node=${job.nodeId} → ${job.status} 但缺少 projectId,Take 未归档` +
        `(提交方漏传 projectId/canvasId;产物=${job.resultPath ?? '无'}${job.error ? ` err=${job.error}` : ''})`,
    );
  }
  if (job.status !== 'succeeded' || !job.projectId || !job.canvasId) return;
  const ctx = { projectId: job.projectId, canvasId: job.canvasId };
  void tools.call('continuity.check', {}, ctx).then((res) => {
    const issues = res.result && res.result.includes('建议') ? [res.result] : [];
    hub.publish('agent-event', {
      kind: 'continuity',
      projectId: job.projectId ?? '',
      canvasId: job.canvasId ?? '',
      issues,
      result: res.result,
    } satisfies AgentEvent);
  });
  /* 自动续跑(2026-10-10):Agent 提交的任务成功后唤醒 Agent 推进任务链。
     闸门/防抖/上限全在 controller 内;不 await —— 归档与 notify 时序不受 LLM 轮次影响。 */
  autoContinue.notifyJobFinished(job);
};

/** 队列变更 → 渲染层实时推送(精简视图,已剔除 req 大对象)。
 *  ⚠️ 必须广播到**所有窗口**:模块级 win 只指向 createWindow 建的那个窗口,
 *  画布若在另一个窗口打开,队列事件就永远到不了它的 CanvasPage →
 *  节点上的「排队中/生成中」不刷新,只能等 8s 兜底轮询(实测:dur 里半天没状态)。 */
queue.onChange = (jobs) => {
  hub.publish('render-queue-changed', jobs);
};

/** 当前活跃 chat 的工具上下文(按 chatKey 隔离,避免并发串写) */
const activeToolCtx = new Map<string, { projectId: string; canvasId: string; threadId?: string; selectedNodeId?: string }>();
/** 最近一次 chat 上下文(事件兜底;工具 RPC 已自带 projectId/canvasId) */
let currentToolCtx: { projectId: string; canvasId: string; threadId?: string; selectedNodeId?: string } | null = null;
/**
 * 本会话已成功完成的工具动作(按 project:canvas 归集)。
 * 用途:长任务失败/超时时说明「哪些改动其实已经生效」——旧实现在收尾超时时只回一句
 * 「agent 无响应」,让用户以为整轮白干,而画布改动其实早已落盘(真实事故 2026-09-28)。
 */
const toolActivity = new Map<string, string[]>();

/* ── 自动续跑(2026-10-10):Agent 提交的生成完成后,自动唤醒 Agent 推进任务链 ──
   背景:「飞机1」项目实测,Agent 按【提交即收尾】结束本轮后,角色卡图 2 分钟就出好了,
   但没有任何机制触发下一轮 —— 多步流程停在原地等用户说「继续」。
   闸门与防抖见 auto-continue.ts 头部注释;runAutoContinueRound / executeAgentChat
   是函数声明,此处引用靠提升,定义在下方 agent-chat IPC 附近。 */
/** 正在进行中的对话轮次(`${projectId}:${canvasId}`;手动与自动同口径,防并发串写) */
const inFlightChats = new Set<string>();
/** 占坑那一轮的收尾承诺:用户新消息要抢占时 await 它,等放锁后再开下一轮 */
const inFlightTails = new Map<string, Promise<void>>();
const autoContinue = new AutoContinueController({
  enabled: process.env.BIGBOTART_AGENT_AUTO_CONTINUE !== '0',
  maxRounds: Number(process.env.BIGBOTART_AGENT_AUTO_CONTINUE_MAX ?? '') || undefined,
  logger,
  isInFlight: (key) => inFlightChats.has(key),
  trigger: (projectId, canvasId, notices) => {
    void runAutoContinueRound(projectId, canvasId, notices);
  },
  onCapReached: (projectId, canvasId) => {
    // 达上限必须让用户可见(不是静默停住):推一张连续性卡说明现状与怎么继续
    hub.publish('agent-event', {
      kind: 'continuity',
      projectId,
      canvasId,
      issues: [],
      result: `ℹ️ 自动推进已连续进行,达到上限后暂停。生成均已完成,如需继续推进,在对话里发消息(如「继续」)即可。`,
    } satisfies AgentEvent);
  },
});

/**
 * 安全写 stderr —— 防「管道断裂把主进程写崩」(真实事故 2026-09)。
 *
 * 场景:`pnpm dev 2>&1 | head -N`、`| tee`、终端被关、日志被 CI/Harness 管道回收时,
 * 下游读端先退出 → 管道关闭 → 下一条 console.error 抛 `Error: write EPIPE`
 * (栈顶在 node:internal/stream_base_commons,表现为 Electron 的 Uncaught Exception 弹窗,
 *  整个 App 挂掉)。渲染层每条 console 都会经 wireConsole 转发到这里,属于高频路径,
 * 一旦管道断开必然命中,所以必须有兜底。
 *
 * 兜底策略:EPIPE/ERR_STREAM_DESTROYED 时把 stderr 标记为不可用并静默后续写入
 * (不是吞错:首条失败会尝试走 logger 总线留痕,且日志本身已经写不到任何地方了)。
 */
let stderrBroken = false;

/** 标记 stderr 不可用并留痕(只记一次,避免刷屏) */
function markStderrBroken(code: string): void {
  if (stderrBroken) return;
  stderrBroken = true;
  try {
    logger.log('warn', `stderr 管道已关闭(${code}),后续主进程日志仅走日志总线(不再写终端)`);
  } catch {
    /* 日志总线也写不进去时无处可记,按不可用处理 */
  }
}

/**
 * 管道断裂的两条路径都要堵:
 *  1. 同步抛出(EPIPE 在 write 返回 false / 已 destroy 时可能同步抛)→ try/catch
 *  2. 异步 'error' 事件(内核 EPIPE 回执晚于 write 返回,Node 在 stream 上 emit 'error')
 *     → 必须挂监听,否则同样是 Uncaught Exception
 * 这是真实事故的完整成因:只 try/catch 挡不住第 2 条。
 */
function installStderrGuard(): void {
  const onErr = (e: NodeJS.ErrnoException): void => {
    if (e?.code === 'EPIPE' || e?.code === 'ERR_STREAM_DESTROYED') markStderrBroken(String(e.code));
    else {
      try {
        logger.log('error', `stderr 流错误: ${e?.message ?? String(e)}`);
      } catch {
        /* 无处可记 */
      }
    }
  };
  process.stderr.on('error', onErr);
}

function safeErr(line: string): void {
  if (stderrBroken) return;
  try {
    process.stderr.write(line + '\n');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
      markStderrBroken(String(code));
      return;
    }
    // 其他错误不静默:走日志总线(但这里不能再抛,否则又是未捕获异常)
    try {
      logger.log('error', `写 stderr 失败: ${(e as Error).message}`);
    } catch {
      /* 同上 */
    }
  }
}

/** 渲染层 console/报错转发到主进程 stderr(白屏排查用;dev 直连窗口难开 CDP) */
function wireConsole(win: BrowserWindow) {
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = level >= 3 ? 'ERROR' : level === 2 ? 'WARN' : 'INFO';
    safeErr(`[renderer:${tag}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    safeErr(`[renderer-gone] ${details.reason} exitCode=${details.exitCode}`);
  });
  win.webContents.on('preload-error', (_e, path, error) => {
    safeErr(`[preload-error] ${path}: ${error.message}`);
  });
}

async function createWindow() {
  // 自定义应用图标。macOS 安装包的 Dock 图标由 electron-builder 的 mac.icon 写入。
  const iconPath = join(__dirname, '../../resources/icon.png');
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'BigBotArt',
    // 与 --bg 深浅值对齐,避免启动闪反色底(见 theme.ts)
    backgroundColor: windowBackgroundColor(nativeTheme.shouldUseDarkColors),
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

// ---------- IPC:业务面在 api-surface.ts(原样搬出,行为不变) ----------
const remoteSlot: { current: RemoteControl | null } = { current: null };
const tunnelSecret = randomBytes(32).toString('base64url');
const relayLive: RelayTunnelStatus = { enabled: false, url: '', connected: false, hasPairingKey: false };
let tunnelStop: (() => void) | null = null;
const remoteStatusFallback = (): RemoteAccessStatus => ({
  enabled: false,
  port: DEFAULT_REMOTE_PORT,
  listening: false,
  urls: [],
  hasPassphrase: false,
  pageReady: false,
  relay: { enabled: false, url: '', connected: false, hasPairingKey: false },
});

function syncTunnel(next: AppSettings): void {
  tunnelStop?.();
  tunnelStop = null;
  const remote = next.remoteAccess;
  const key = readPairingKey(DATA_DIR);
  relayLive.enabled = remote?.relayEnabled === true;
  relayLive.url = (remote?.relayUrl ?? '').trim();
  relayLive.hasPairingKey = !!key;
  relayLive.connected = false;
  const current = remoteSlot.current?.status();
  if (!relayLive.enabled) {
    relayLive.error = undefined;
    return;
  }
  if (!key) {
    relayLive.error = '还没有配对密钥';
    return;
  }
  if (!relayLive.url) {
    relayLive.error = '还没有中继地址';
    return;
  }
  if (!current?.listening) {
    relayLive.error = '本机远程服务还没在听,隧道未连接';
    return;
  }
  relayLive.error = undefined;
  tunnelStop = connectTunnel({
    relayUrl: relayLive.url,
    pairingKey: key,
    localPort: current.port,
    tunnelSecret,
    logger,
    onStatus: (s) => {
      relayLive.connected = s.connected;
      relayLive.error = s.error;
    },
  }).stop;
}

const ipcHandlers = registerDesktopIpc({
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
  getWin: () => win,
  publish: (channel, payload) => hub.publish(channel, payload),
  onRemoteSettings: (next) => {
    void remoteSlot.current?.apply(next).then(() => syncTunnel(next));
  },
  remoteStatus: () => remoteSlot.current?.status() ?? remoteStatusFallback(),
  rotatePassphrase: () => remoteSlot.current?.rotatePassphrase() ?? { ok: false, error: '远程访问未初始化' },
  setRelayPairingKey: (key) => {
    const saved = writePairingKey(DATA_DIR, key);
    if (saved.ok && key && !saved.encrypted) {
      logger.log('warn', '系统钥匙串不可用,中继配对密钥以 0600 文件保存在数据目录');
    }
    syncTunnel(settings.get());
    return saved.ok ? { ok: true } : { ok: false, error: saved.error };
  },
  probeSimple,
  executeAgentChat,
  tidyCanvas: (input) => tools.tidyCanvas(input),
  compactContext,
});
remoteSlot.current = createRemoteServer({
  hub,
  handlers: ipcHandlers,
  logger,
  staticDir: process.env.BIGBOTART_REMOTE_STATIC
    ? resolve(process.env.BIGBOTART_REMOTE_STATIC)
    : join(__dirname, '../renderer'),
  tunnelSecret,
  getRelayStatus: () => ({ ...relayLive }),
});
void remoteSlot.current.apply(settings.get()).then(() => syncTunnel(settings.get())).catch((e) => {
  logger.log('error', `远程访问启动失败: ${(e as Error).message}`);
});


/* ---------- IPC:Agent 对话(多轮 + 工具 + 记忆) ---------- */

/**
 * 一轮 Agent 对话的完整执行体(用户消息与自动续跑共用)。
 * 自动轮(auto=true)差异:无附件/无关注节点注入;用户消息 recall 由调用方以 system 角色
 * 另行留痕(防止合成通知被 pinnedInstruction 误当「任务链首条用户指令」);
 * 开始前推送 auto-start 事件让渲染层把面板切入「执行中」。
 */
async function executeAgentChat(opts: {
  projectId: string;
  canvasId: string;
  text: string;
  attachments?: AgentChatRequest['attachments'];
  selectedNodeId?: string;
  /** 本轮引用的多个节点(右键「添加到聊天窗口」+ @ 提及);与 selectedNodeId 合并去重 */
  selectedNodeIds?: string[];
  /** 目标会话;缺省用画布活跃会话 */
  threadId?: string;
  auto?: boolean;
}): Promise<AgentChatResponse> {
  const flightKey = `${opts.projectId}:${opts.canvasId}`;
  if (inFlightChats.has(flightKey)) {
    // 同画布并发对话会串写工具上下文与 recall 顺序。
    // 自动轮被拒时必须留日志:fire() 已经把连续轮计数加上,这里再静默 return,
    // 这一轮就从用户视角凭空消失。
    // 用户消息则抢占:打断当前轮,等它放锁后再开(输入区「打断并发送」)。
    if (opts.auto) {
      logger.log('warn', `[auto-continue] 自动推进放弃:该画布有对话正在进行 ${flightKey}`);
      return { ok: false, error: '该画布有对话正在进行,请等它收尾后再发' };
    }
    await waitUntilFlightFree({
      isInFlight: () => inFlightChats.has(flightKey),
      cancel: () => {
        void agent.cancel();
      },
      currentTail: () => inFlightTails.get(flightKey),
    });
  }
  // 占坑必须紧挨在 resolveLlmEndpoint 的 await 之前(空闲路径不能先无条件 await,
  // 否则两条消息都会通过检查)。上面的等待只在「已经有人占坑」时发生。
  inFlightChats.add(flightKey);
  let releaseTail = () => {};
  const tailPromise = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  inFlightTails.set(flightKey, tailPromise);
  let chatKey: string | undefined;
  let toolCtx: { projectId: string; canvasId: string; threadId?: string; selectedNodeId?: string } | undefined;
  try {
  let llm: LlmSource | undefined;
  const project = store.getProject(opts.projectId);
  if (project?.llmOverride) llm = project.llmOverride;
  else if (settings.get().llm) llm = settings.get().llm;
  const source = llm;
  let contextWindow = 100_000;
  let historyTokenBudget: number | undefined;
  try {
    const ep = await resolveLlmEndpoint(settings.get(), llm);
    llm = toChatLlm(ep);
    const placement = placementOf(source, ep.baseUrl);
    const loaded = placement === 'local' ? await probeLoadedContextTokens(ep.baseUrl, ep.model) : undefined;
    const plan = planContext({ placement, model: ep.model, loadedContextTokens: loaded });
    contextWindow = plan.windowTokens;
    historyTokenBudget = plan.compactAt;
    logger.log(
      'info',
      `[agent.context] ${placement} · 模型 ${ep.model} · 协议 ${ep.protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions'} · 窗口 ${plan.windowTokens} · 本轮工作集 ${plan.compactAt}${loaded ? ` · 已加载 ${loaded}` : ''}`,
    );
  } catch (e) {
    if (opts.auto) {
      // 自动轮 LLM 不可达:不推 failed 事件(面板没进「执行中」,推了会留一张突兀的错误卡),日志留痕即可
      logger.log('warn', `[auto-continue] 自动推进放弃:LLM 来源不可用:${(e as Error).message}`);
    }
    return { ok: false, error: `LLM 来源不可用:${(e as Error).message}` };
  }

  // 会话:显式 threadId 优先;否则确保画布有活跃会话并切过去
  const threadId =
    opts.threadId || memory.ensureActiveThread(opts.projectId, opts.canvasId);
  if (opts.threadId) {
    try {
      memory.switchThread(opts.projectId, opts.canvasId, opts.threadId);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  if (historyTokenBudget != null) {
    const folded = memory.autoCompact(opts.projectId, opts.canvasId, historyTokenBudget);
    if (folded.compacted) {
      logger.log(
        'info',
        `[agent.context] 自动压缩 ${folded.replaced} 条旧对话 · 窗口 ${contextWindow} · 压缩线 ${historyTokenBudget}`,
      );
    }
  }

  // 记忆上下文组装(skillResolver:激活技能经 SkillStore 解析,注入「【当前技能】」指令段;
  // canvas 快照:注入「【当前画布】」实时状态段,让 Agent 首轮就感知画布轮廓)
  const ctxSnap = store.loadProjectCanvases(opts.projectId).canvases.find((c) => c.id === opts.canvasId);
  let textForModel = opts.text;
  if (!opts.auto && opts.text.trim() === PLAN_APPROVE_LABEL && ctxSnap) {
    const openIds = openShots(ctxSnap.nodes).map((s) => s.id);
    const decision = memory.tryApproveShotPlan(opts.projectId, opts.canvasId, openIds);
    if (decision.ok) {
      logger.log('info', `[shot-plan] 已批准 ${openIds.length} 个未出片镜头`);
    } else if (!decision.silent) {
      textForModel = `${opts.text}\n\n(系统:${decision.reason})`;
      logger.log('warn', `[shot-plan] 点头未生效:${decision.reason}`);
    }
  }
  const ctx = memory.buildContext(
    opts.projectId,
    opts.canvasId,
    textForModel,
    (id) => skills.get(id),
    ctxSnap ? { name: ctxSnap.name, nodes: ctxSnap.nodes, edges: ctxSnap.edges } : undefined,
    historyTokenBudget != null ? { historyTokenBudget } : undefined,
  );
  chatKey = `${opts.projectId}:${opts.canvasId}:${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  /** 已完成工具摘要的归集键(与 chatKey 不同:按画布归集,跨轮次可累积) */
  const activityKey = `${opts.projectId}:${opts.canvasId}`;
  toolCtx = { projectId: opts.projectId, canvasId: opts.canvasId, threadId, selectedNodeId: undefined };
  activeToolCtx.set(chatKey, toolCtx);
  currentToolCtx = toolCtx;

  let attNote = '';
  let selNote = '';
  if (!opts.auto) {
    // 记录用户消息到 recall(附件名 + 当轮关注/引用节点一并留痕,渲染层据此回显「关注:节点」徽标)
    const atts = opts.attachments ?? [];
    const visibleText = opts.text + (atts.length ? ` 📎${atts.map((a) => a.name).join('、')}` : '');
    // 多引用合并去重:selectedNodeIds(新)优先,selectedNodeId(旧契约)兜底
    const selIds = [...new Set([...(opts.selectedNodeIds ?? []), ...(opts.selectedNodeId ? [opts.selectedNodeId] : [])])];
    const selNodes = ctxSnap ? selIds.map((id) => ctxSnap.nodes.find((x) => x.id === id)).filter((n): n is CanvasNode => !!n) : [];
    // 新建节点没给坐标时,放在用户本轮指着的节点右侧
    if (selNodes[0]) toolCtx.selectedNodeId = selNodes[0].id;
    memory.addRecall(opts.projectId, {
      canvasId: opts.canvasId,
      threadId,
      role: 'user',
      content: visibleText,
      // 单值字段保留(旧渲染层/旧读取方兼容);数组字段是 2026-10 多引用的真源
      selectedNodeId: selNodes[0]?.id,
      selectedNodeTitle: selNodes[0]?.label,
      selectedNodeIds: selNodes.length ? selNodes.map((n) => n.id) : undefined,
      selectedNodeTitles: selNodes.length ? selNodes.map((n) => n.label) : undefined,
    });
    logger.log('info', `agent.chat 开始 · "${opts.text.slice(0, 60)}"${atts.length ? ` · 附件 ${atts.length} 个` : ''}`);

    // 附件先拷入项目文件夹(projects/<pid>/assets/),Agent 一律使用项目内副本——
    // 项目自包含、可迁移;路径在 DATA_DIR 白名单内,下游 headless 导入/引用均合法
    const projAtts = copyAttachmentsToProject(
      opts.projectId,
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
      if (pa.copied && pa.projectPath) await assets.registerAttachment(opts.projectId, { id: pa.id, path: pa.projectPath });
    }
    // 附件注入:项目内路径 + 尺寸元数据直接给 LLM(免去 assets.get 往返,也避免"信息太简略看不出内容")
    attNote = projAtts.length
      ? `\n\n[用户附件 · 已拷入项目文件夹,可直接作为参考图/素材使用(也可用 canvas.create_node(kind=asset) 引用到画布):\n${projAtts
          .map(
            (a) =>
              `- ${a.name}(${a.kind},assetId=${a.id}${a.width ? `,${a.width}×${a.height}` : ''}${a.durationSec ? `,${a.durationSec}s` : ''}) → ${a.projectPath}${a.copied ? '' : '(源文件缺失,未拷入项目)'}`,
          )
          .join('\n')}]`
      : '';

    // 引用节点注入:用户本轮指着哪些节点 → 详情摘要附进本轮 user 消息(风格对齐 canvas.get_node)
    selNote = selNodes.length && ctxSnap
      ? `\n\n${selNodes.map((n, i) => describeSelectedNode(n, ctxSnap.edges, ctxSnap.nodes, i, selNodes.length, (id) => assets.get(id))).join('\n\n')}`
      : '';
  } else {
    logger.log('info', `[auto-continue] 自动推进轮开始 · "${opts.text.slice(0, 60).replace(/\n/g, ' ')}"`);
    // 通知渲染层切入「执行中」(loading 气泡 + 输入锁定);done/failed 终局事件照旧收尾
    hub.publish('agent-event', {
      kind: 'auto-start',
      projectId: opts.projectId,
      canvasId: opts.canvasId,
      threadId,
      note: '⚙️ 生成完成 · Agent 自动推进任务链…',
    } satisfies AgentEvent);
  }

  try {
    const result = await agent.chat({
      projectId: opts.projectId,
      canvasId: opts.canvasId,
      threadId,
      text: textForModel + attNote + selNote,
      context: ctx,
      contextWindow,
      llm,
    });
    logger.log(
      'info',
      `agent.chat 完成${opts.auto ? '(自动推进)' : ''} · 工具 ${result.toolCalls.length} 个${result.ask ? ' · 暂停待用户确认(ask.user)' : ''}${result.aborted ? ' · 已打断' : ''} · 回复 ${result.reply.length} 字`,
    );
    // assistant 回复记入 recall
    if (result.reply) {
      memory.addRecall(opts.projectId, {
        canvasId: opts.canvasId,
        threadId,
        role: 'assistant',
        content: result.reply,
      });
    }
    // 工具调用记入 recall(role=tool,留痕回看)+ 成功动作记入 recall(role=system,注入下一轮上下文)
    for (const tc of result.toolCalls) {
      /* ask.user 是 worker 侧拦截的「结构化提问」,正常路径下不会出现在 result.toolCalls 里
         (拦截即 return,见 pi-chat.ts)。一旦出现,说明这次调用没被拦截、落到了工具桥报
         「未知工具:ask.user」——这是旧版本 / 异常分支的脏记录,写进 recall 后渲染层会
         留一条 `ask.user({...` 的裸文本气泡,看着像调用失败。真正的提问卡由下方 result.ask
         分支负责记录,这里直接跳过。 */
      if (tc.name === 'ask.user') continue;
      memory.addRecall(opts.projectId, {
        canvasId: opts.canvasId, threadId, role: 'tool',
        content: `${tc.name}(${JSON.stringify(tc.args).slice(0, 120)})`,
        toolName: tc.name, toolArgs: tc.args, toolResult: tc.result,
      });
      if (tc.ok) {
        memory.addRecall(opts.projectId, {
          canvasId: opts.canvasId, threadId, role: 'system',
          content: describeToolAction(tc.name, tc.args, tc.nodeId),
        });
      }
    }
    // ask.user 暂停卡也记入 recall(被 worker 拦截、不经工具桥):刷新/切换后恢复成可点选的确认卡,而不是丢成纯文本
    if (result.ask) {
      memory.addRecall(opts.projectId, {
        canvasId: opts.canvasId, threadId, role: 'tool',
        content: `ask.user(${result.ask.question.slice(0, 120)})`,
        toolName: 'ask.user',
        toolArgs: { question: result.ask.question, options: result.ask.options },
        toolResult: '(已暂停,等待用户选择)',
      });
    }
    const final: AgentChatResponse = {
      ok: true, reply: result.reply, thinking: result.thinking,
      toolCalls: result.toolCalls, ask: result.ask, aborted: result.aborted,
    };
    hub.publish('agent-event', {
      kind: 'done', projectId: opts.projectId, canvasId: opts.canvasId, threadId, final,
    } satisfies AgentEvent);
    // done 已承担终局;IPC 回执只用于调用方取结果,渲染层不得用它再次 settle。
    return { ...final, settledByEvent: true };
  } catch (e) {
    // 失败也要带上「已完成的工具」摘要:长任务常在收尾阶段超时,而画布改动其实已落盘,
    // 只报一句「无响应」会让用户以为全丢了
    const done = toolActivity.get(activityKey) ?? [];
    const summary = done.length
      ? `\n已完成 ${done.length} 个操作(${done.slice(-4).join('、')}${done.length > 4 ? ' 等' : ''}),画布改动已生效。`
      : '';
    const msg = `${(e as Error).message}${summary}`;
    logger.log('error', `agent.chat 失败${opts.auto ? '(自动推进)' : ''}:${msg}`);
    hub.publish('agent-event', {
      kind: 'failed', projectId: opts.projectId, canvasId: opts.canvasId, threadId, error: msg,
    } satisfies AgentEvent);
    return { ok: false, error: msg, settledByEvent: true };
  }
  } finally { // 占坑覆盖解析端点到对话结束;LLM 不可用的提前 return 也走这里放锁
    inFlightChats.delete(flightKey);
    releaseTail();
    if (inFlightTails.get(flightKey) === tailPromise) inFlightTails.delete(flightKey);
    if (chatKey) activeToolCtx.delete(chatKey);
    // 仅当仍指向本会话时清空,避免并发 chat 的 finally 互相踩掉。
    // LLM 解析失败时 toolCtx 还没建立,不能拿 undefined 去比。
    if (toolCtx && currentToolCtx === toolCtx) {
      const remaining = [...activeToolCtx.values()].at(-1) ?? null;
      currentToolCtx = remaining;
    }
    /* 对话收尾后补跑延后的生成完成通知(技能4:同轮双提交,第二张在飞完成不能丢)。
       必须在 inFlightChats.delete 之后,否则 onChatSettled 立刻 fire 又会判在飞。 */
    autoContinue.onChatSettled(opts.projectId, opts.canvasId);
  }
}

/** 自动续跑入口(AutoContinueController.trigger):补节点标题 → 合成唤醒文本 → 跑一轮 chat */
async function runAutoContinueRound(
  projectId: string,
  canvasId: string,
  notices: Array<{ nodeId: string; resultPath?: string; threadId?: string }>,
): Promise<void> {
  const snap = store.loadProjectCanvases(projectId).canvases.find((c) => c.id === canvasId);
  const enriched = notices.map((n) => ({
    ...n,
    label: snap?.nodes.find((x) => x.id === n.nodeId)?.label,
  }));
  // 回到提交时的会话(多会话:用户可能已切到别的历史聊天)
  const threadId =
    notices.map((n) => n.threadId).find(Boolean) || memory.ensureActiveThread(projectId, canvasId);
  try {
    memory.switchThread(projectId, canvasId, threadId);
  } catch {
    /* 会话已被删 → ensureActive 兜底 */
  }
  logger.log(
    'info',
    `[auto-continue] 触发自动推进 ${projectId}:${canvasId}:${threadId} · ${enriched.map((n) => `「${n.label || n.nodeId}」`).join('、')}`,
  );
  /* recall 留痕用 system 角色而非 user:合成通知绝不能被 pinnedInstruction 当成
     「任务链首条用户指令」钉进 systemPrompt(那会永久顶掉用户真正的原始指令)。 */
  memory.addRecall(projectId, {
    canvasId,
    threadId,
    role: 'system',
    content: buildAutoRecallNote(enriched),
  });
  await executeAgentChat({
    projectId,
    canvasId,
    threadId,
    text: buildAutoContinueText(enriched),
    auto: true,
  });
}


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
  // 尽早挂 stderr 管道保护:dev 下 `pnpm dev | head/tee`、终端关闭都会断开管道,
  // 渲染层 console 又高频转发到 stderr,不挡会以 Uncaught Exception 崩掉整个 App
  installStderrGuard();
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
  // 走 rangeFileResponse:资产里可能有 100MB+ 的视频,必须支持 Range 才能拖动进度条
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
      return rangeFileResponse(real, req.headers.get('range'));
    } catch (e) {
      return new Response(`error: ${(e as Error).message}`, { status: 500 });
    }
  });

  // 注册 bba-output:// 协议:读生成产物目录(含 mock/、images/ 子目录;多根目录兼容旧路径)
  // 同样支持 Range:产物多为视频,检查器/预览器需要能 seek
  protocol.handle('bba-output', async (req) => {
    try {
      const url = new URL(req.url);
      const rawHost = url.host + url.pathname.replace(/\/+$/, '');
      const name = decodeURIComponent(rawHost).replace(/^\/+/, '');
      // 允许相对路径段(mock/xxx.mp4)与中文等 Unicode 文件名(导出成片名由项目名派生);
      // 拒绝 .. 穿越 / 绝对路径 / 控制字符(见 isValidOutputRelName,2026-10 中文名黑屏事故)
      if (!isValidOutputRelName(name)) {
        return new Response(`bad output name: ${name}`, { status: 400 });
      }
      for (const outRoot of outputSearchRoots()) {
        const real = resolve(join(outRoot, name));
        if (real !== outRoot && !real.startsWith(outRoot + '/')) continue;
        if (existsSync(real)) return rangeFileResponse(real, req.headers.get('range'));
      }
      return new Response(`not found: ${name}`, { status: 404 });
    } catch (e) {
      return new Response(`error: ${(e as Error).message}`, { status: 500 });
    }
  });

  await store.init();
  // 创建窗口前设好 themeSource,渲染层 prefers-color-scheme 首帧即正确(无闪屏)
  applyThemeSource(normalizeTheme(settings.get().theme, (m) => logger.log('warn', m)));
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  void agent.stop();
  if (process.platform !== 'darwin') app.quit();
});