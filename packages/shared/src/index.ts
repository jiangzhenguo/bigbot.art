/**
 * 引擎/运行时探测状态(引导向导用)
 */

export interface RuntimeProbe {
  id: 'lmstudio' | 'ollama' | 'mlxgen' | 'h3c' | 'comfyui';
  label: string;
  detected: boolean;
  version?: string;
  path?: string;
  port?: number;
  status: 'ready' | 'missing' | 'error';
  detail?: string;
}

/** pi Agent 子进程健康状态 */
export interface AgentProcessState {
  running: boolean;
  pid?: number;
  startedAt?: string;
  lastHeartbeat?: string;
  version?: string;
  error?: string;
}

/** IPC 通道契约(主进程 ↔ 渲染进程) */
export interface BigBotArtApi {
  // 引擎引导
  probeRuntimes(): Promise<RuntimeProbe[]>;
  installRuntime(id: string): Promise<{ ok: boolean; message: string }>;
  // 图片引擎模型管理(mlxgen:已下载探测 / 真实下载 / 下载进度轮询)
  mlxgenModels(): Promise<Array<{ id: string; name: string; repoId: string; downloaded: boolean }>>;
  mlxgenDownload(repoId: string): Promise<{ ok: boolean; jobId?: string; error?: string }>;
  mlxgenDownloadStatus(jobId: string): Promise<{ status: 'running' | 'done' | 'failed' | 'cancelled'; pct?: number | null; error?: string }>;
  /** 进行中的下载任务清单(设置页进入时恢复进度轮询;id 为主进程已知模型 id) */
  mlxgenDownloadActive(): Promise<Array<{ id: string; jobId: string; pct: number | null }>>;
  /** 取消进行中的下载;保留 .part/.incomplete 支持断点续传,取消后任务释放、可重新下载 */
  mlxgenDownloadCancel(jobId: string): Promise<{ ok: boolean; error?: string }>;
  /** base64 dataURL PNG/JPEG/WebP → 资产库(检查器画遮罩生成 mask 用);返回新资产 id */
  savePngAsset(input: { name: string; dataUrl: string; projectId?: string; tags?: string[] }): Promise<{ ok: boolean; assetId?: string; error?: string }>;
  // Provider / 渲染任务
  checkProviders(): Promise<Record<string, import('./provider').ProviderStatus>>;
  submitRender(req: import('./provider').RenderRequest): Promise<import('./provider').RenderJobHandle>;
  renderStatus(provider: string, handle: { providerTaskId: string }): Promise<import('./provider').RenderStatus>;
  cancelRender(provider: string, handle: { providerTaskId: string }): Promise<void>;
  /** 渲染队列:当前全部任务(含排队位置/进度) */
  queueStatus(): Promise<import('./domain').RenderJob[]>;
  /** 渲染队列变更推送(主进程同 tick 去抖合并,推送精简视图;返回退订函数;首次全量用 queueStatus()) */
  onQueueChanged(cb: (jobs: import('./domain').RenderJob[]) => void): () => void;
  // 项目 / 画布
  listProjects(): Promise<import('./domain').Project[]>;
  createProject(name: string): Promise<import('./domain').Project>;
  deleteProject(id: string): Promise<{ ok: boolean; error?: string }>;
  renameProject(id: string, name: string): Promise<{ ok: boolean; error?: string }>;
  loadCanvas(projectId: string): Promise<import('./domain').CanvasSnapshot>;
  saveCanvas(snapshot: import('./domain').CanvasSnapshot): Promise<{ ok: boolean; stale?: boolean; current?: import('./domain').CanvasSnapshot }>;
  /** 项目级 LLM 覆盖(null 清除,回退全局) */
  setProjectLlm(projectId: string, llm: import('./domain').LlmSource | null): Promise<{ ok: boolean }>;
  /** 加载项目下所有画布 + 活动画布 id(一次拉完,前端切换无往返) */
  loadProjectCanvases(projectId: string): Promise<import('./domain').ProjectCanvases>;
  /** 保存单画布快照(自动写回项目容器)。
   *  版本防护:当 snap.version 落后于 store 当前版本(如 Agent 工具已增量写盘、渲染层状态未同步)时
   *  拒绝整体覆盖,返回 stale=true + 最新 current,由渲染层刷新后再保存,避免吞掉 Agent 的改动。 */
  saveCanvasSnapshot(snap: import('./domain').CanvasSnapshot): Promise<{ ok: boolean; stale?: boolean; current?: import('./domain').CanvasSnapshot }>;
  /** 画布快照更新推送(主进程任何写盘后广播,含 Agent 工具增量;渲染层据此刷新本地状态保持同步) */
  onCanvasSnapshotUpdated(cb: (snap: import('./domain').CanvasSnapshot) => void): () => void;
  /** 创建一个新画布(空白),返回画布;持久化并设为主画布(若项目无画布) */
  createCanvas(projectId: string, name?: string): Promise<import('./domain').CanvasSnapshot>;
  /** 重命名画布 */
  renameCanvas(projectId: string, canvasId: string, name: string): Promise<{ ok: boolean; error?: string }>;
  /** 删除画布(至少保留 1 个);若删的是 active,自动切换到剩余第一个 */
  deleteCanvas(projectId: string, canvasId: string): Promise<{ ok: boolean; error?: string }>;
  /** 切换活动画布;只改 active 指针,不返回画布内容(前端已持有完整列表) */
  switchActiveCanvas(projectId: string, canvasId: string): Promise<{ ok: boolean }>;
  // 资产中心
  /** 导入资产:paths 给定时走白名单 headless;缺省弹系统对话框。projectId 给定时归入项目视图 */
  importAssets(opts?: { paths?: string[]; projectId?: string }): Promise<import('./domain').AssetImportResult>;
  /** 列资产:projectId 给定 = 项目视图(该项目的资源);缺省 = 总资源库(全部) */
  listAssets(projectId?: string): Promise<import('./domain').Asset[]>;
  /** 软删除 → 回收站(文件移入 trash,7 天后清理);被画布引用时返回引用列表供前端展示警告 */
  deleteAsset(id: string): Promise<{ ok: boolean; error?: string; refs?: import('./domain').AssetRef[] }>;
  /** 资源更新:重命名 / 改分类(null=未分类) / 改归属(null=总资源库) / 改标签 */
  updateAsset(
    id: string,
    patch: { name?: string; categoryId?: string | null; projectId?: string | null; tags?: string[] },
  ): Promise<{ ok: boolean; error?: string }>;
  /** 分类字典(项目分类 + 全局分类;过滤由渲染层按 projectId 做) */
  listAssetCategories(): Promise<import('./domain').AssetCategory[]>;
  createAssetCategory(name: string, projectId?: string): Promise<import('./domain').AssetCategory>;
  renameAssetCategory(id: string, name: string): Promise<{ ok: boolean; error?: string }>;
  /** 删除分类:分类下资源转「未分类」,原资源文件保留 */
  deleteAssetCategory(id: string): Promise<{ ok: boolean; error?: string }>;
  /** 资源被画布引用位置(删除安全警告 / 「定位画布」) */
  assetRefs(assetId: string): Promise<import('./domain').AssetRef[]>;
  /** 回收站:软删资源列表(最新在前) */
  listTrash(): Promise<import('./domain').Asset[]>;
  restoreAsset(id: string): Promise<{ ok: boolean; error?: string }>;
  emptyTrash(): Promise<{ ok: boolean }>;
  /** 画布产物归档:复制产物文件进资产库并登记(source='product',归入 projectId) */
  archiveProducts(input: {
    projectId: string;
    items: Array<{ nodeId: string; path: string }>;
    categoryId?: string;
  }): Promise<{ ok: boolean; assets: import('./domain').Asset[]; error?: string }>;
  /** 列项目画布中「有产物」的节点(「从画布产物导入」弹层的候选项) */
  listArchivableProducts(projectId: string): Promise<Array<{ nodeId: string; name: string; path: string; meta: string }>>;
  // Skills 库(画布模板 + Agent 指令段双形态;激活状态持久化在 canvasMemory,见 docs/Agent技能-指令模板与对话自动加载-产品设计与技术方案.md)
  listSkills(): Promise<import('./domain').Skill[]>;
  saveSkill(input: { name: string; projectId: string; canvasId?: string; instructions?: string; inject?: 'full' | 'summary' }): Promise<import('./domain').Skill>;
  applySkill(skillId: string, projectName: string, activate?: boolean): Promise<{ project: import('./domain').Project }>;
  deleteSkill(id: string): Promise<{ ok: boolean; error?: string }>;
  /** 读单个技能完整定义(含操作指令段;summary 模式按需取全文) */
  skillRead(skillId: string): Promise<import('./domain').Skill | null>;
  /** 更新技能元信息/指令段(指令编辑器;不动画布模板) */
  skillUpdate(skillId: string, patch: { name?: string; description?: string; instructions?: string | null; inject?: 'full' | 'summary' }): Promise<{ ok: boolean; skill?: import('./domain').Skill; error?: string }>;
  /** 激活技能到指定画布(同一画布至多一个;激活后对话自动注入指令段) */
  skillActivate(projectId: string, canvasId: string, skillId: string): Promise<{ ok: boolean; preview?: string; hasInstructions?: boolean; error?: string }>;
  /** 停用画布技能 */
  skillDeactivate(projectId: string, canvasId: string): Promise<{ ok: boolean }>;
  /** 查询画布当前激活技能(进入页面恢复 chip/注入卡;未激活返回 null) */
  skillActive(projectId: string, canvasId: string): Promise<{ skillId: string; name: string; inject?: 'full' | 'summary' } | null>;
  // 时间线导出(FFmpeg)
  exportTimeline(req: import('./domain').TimelineExportRequest): Promise<{ ok: boolean; taskId?: string; error?: string }>;
  exportStatus(taskId: string): Promise<import('./domain').ExportTask>;
  /** 视频取帧:抽首/尾帧 PNG(镜头接续尾帧归档 / shot→image-edit 取帧源) */
  extractFrame(
    videoPath: string,
    mode: 'first' | 'last',
  ): Promise<{ ok: boolean; path?: string; error?: string }>;
  /** 图片裁切:按目标画幅(A:B)ffmpeg 裁剪原图(image-crop 节点用;产物落 outputs/crops/) */
  cropImage(input: {
    path: string;
    /** 目标画幅,如 '16:9' / '9:16' / '1:1';宽高比须 > 0 */
    aspect: string;
    /** 裁切锚点:center(默认)/ top / bottom / left / right */
    focus?: 'center' | 'top' | 'bottom' | 'left' | 'right';
  }): Promise<{ ok: boolean; path?: string; error?: string }>;
  // 系统 / 文件
  /** 在系统文件管理器中定位路径(Finder 显示;主进程校验白名单后 shell 打开,文件缺失时回退最近存在目录) */
  revealInFinder(target: { path: string }): Promise<{ ok: boolean; revealed: string; error?: string }>;
  // 设置
  getSettings(): Promise<import('./domain').AppSettings>;
  setSettings(patch: Partial<import('./domain').AppSettings>): Promise<import('./domain').AppSettings>;
  // LLM 来源(五档:lmstudio / ollama / pimlx / openai-compatible / cloud)
  /** 枚举本地运行时模型(仅支持工具调用的;含体积/显存预估/已加载标记) */
  llmLocalModels(kind: 'lmstudio' | 'ollama' | 'pimlx'): Promise<import('./domain').LocalRuntimeModels>;
  /** 加载(驻留)本地模型;pi-mlx 未安装的模型会按需从 HuggingFace 拉取 */
  llmLoadModel(kind: 'lmstudio' | 'ollama' | 'pimlx', modelId: string): Promise<{ ok: boolean; error?: string }>;
  /** 测试 OpenAI 兼容端点连接;providerId 给定则从钥匙串取凭据 */
  llmTestConnection(input: { baseUrl: string; apiKey?: string; providerId?: string }): Promise<import('./domain').LlmConnectionTest>;
  /** 枚举远端 /v1/models 全量清单(添加模型弹层);providerId 给定则从钥匙串取凭据 */
  llmListRemoteModels(input: { baseUrl: string; apiKey?: string; providerId?: string }): Promise<{ ok: boolean; models: string[]; error?: string }>;
  /** 保存供应商凭据到 macOS 钥匙串(不回传、不落盘) */
  credentialSet(providerId: string, apiKey: string): Promise<{ ok: boolean; error?: string }>;
  /** 删除供应商凭据 */
  credentialDelete(providerId: string): Promise<{ ok: boolean }>;
  // 加速 LoRA(蒸馏模型包)管理 —— h3.c 加速 = 蒸馏模型目录(-d)+ 4/8 步,非挂载 LoRA
  /** 列出已安装的加速模型包(主进程回填 exists 目录校验;设置页列表用) */
  accelList(): Promise<import('./domain').AccelPack[]>;
  /** 安装加速模型包:校验目录存在且含 FL2VA/ 后登记入 settings.accelPacks */
  accelInstall(input: { name: string; path: string; steps?: number }): Promise<{ ok: boolean; packs?: import('./domain').AccelPack[]; error?: string }>;
  /** 删除登记(只注销,不删磁盘) */
  accelRemove(id: string): Promise<{ ok: boolean; packs?: import('./domain').AccelPack[]; error?: string }>;
  /** 设默认包(id=null 清除默认);镜头开启加速未选包时用默认包 */
  accelSetDefault(id: string | null): Promise<{ ok: boolean; packs?: import('./domain').AccelPack[]; error?: string }>;
  // Agent 内核
  agentStatus(): Promise<AgentProcessState>;
  agentStart(modelSource?: import('./domain').LlmSource): Promise<AgentProcessState>;
  agentStop(): Promise<{ ok: boolean }>;
  /** 一句话起活:让 Agent 生成 Brief 并规划镜头(骨架期返回确定性规划) */
  agentPlan(
    brief: string,
    opts?: { projectId?: string; projectName?: string; existingNodeIds?: string[] },
  ): Promise<{
    document: import('./domain').CanvasNode;
    shots: import('./domain').CanvasNode[];
    edges: import('./domain').CanvasEdge[];
    report: string;
  }>;
  /** 分镜表规划:从文档/小说生成分镜表节点;默认分步只出表,autoMaterialize 同时铺节点 */
  agentPlanStoryboard(
    brief: string,
    opts?: { projectId?: string; projectName?: string; basePrompt?: string; autoMaterialize?: boolean },
  ): Promise<{
    storyboard: import('./domain').CanvasNode;
    images: import('./domain').CanvasNode[];
    shots: import('./domain').CanvasNode[];
    edges: import('./domain').CanvasEdge[];
    report: string;
  }>;
  /** 画布页多轮对话(带工具调用 + 记忆上下文 + AbortSignal 打断) */
  agentChat(req: import('./domain').AgentChatRequest): Promise<import('./domain').AgentChatResponse>;
  /** 真实打断当前对话(中止 LLM 请求) */
  agentCancel(projectId: string): Promise<{ ok: boolean }>;
  /** 订阅 Agent 实时事件(工具调用/校验)——渲染层注册回调,返回退订函数 */
  onAgentEvent(cb: (ev: import('./domain').AgentEvent) => void): () => void;
  /** 读取项目记忆(调试/设置页展示) */
  memoryGet(projectId: string): Promise<import('./domain').ProjectMemory>;
  /** /clear 命令:清空当前画布对话(移除该画布全部 recall + 对话压缩摘要;节点总结保留) */
  memoryClear(projectId: string, canvasId: string): Promise<{ ok: boolean; cleared: number; error?: string }>;
  /** /compact 命令:把当前画布旧对话压成摘要(LLM 总结,不可达时兜底),写入 canvasMemory.conversationSummary 并裁剪 recall(保留最近 N 条) */
  memoryCompact(projectId: string, canvasId: string): Promise<{
    ok: boolean;
    summary?: string;
    /** 被压缩裁掉的旧消息条数 */
    replaced?: number;
    /** 对话太短,无需压缩 */
    skipped?: boolean;
    /** LLM 不可达时使用确定性兜底摘要 */
    fallback?: boolean;
    error?: string;
  }>;
  // Take 历史(shot 节点生成归档)
  /** 列出项目下全部 Take(最新在前) */
  takesList(projectId: string): Promise<import('./domain').Take[]>;
  /** 列出指定 shot 节点的 Take 历史 */
  takesHistory(projectId: string, shotNodeId: string, currentTakeId?: string): Promise<import('./domain').ShotTakeHistory>;
  /** 创建一条 Take(渲染层提交任务前先建,拿 takeId 传给 submitRender) */
  takesCreate(projectId: string, partial: Partial<import('./domain').Take>): Promise<import('./domain').Take>;
  /** 打补丁(终态/resultPath/error 由主进程任务完成时自动写) */
  takesPatch(projectId: string, takeId: string, patch: Partial<import('./domain').Take>): Promise<import('./domain').Take | null>;
  /** 删除一条 Take(只删元数据,不删产物文件) */
  takesDelete(projectId: string, takeId: string): Promise<{ ok: boolean; error?: string }>;
  // 调试日志
  /** 拉取主进程日志总线(最近 500 条) */
  debugLogs(): Promise<import('./domain').DebugLogEntry[]>;
  /** 清空日志总线 */
  debugClear(): Promise<void>;
  /** 订阅实时日志(主进程 push);返回退订函数 */
  onDebugLog(cb: (e: import('./domain').DebugLogEntry) => void): () => void;
}

export * from './domain.js';
export * from './provider.js';
export * from './tool-defs.js';
export * from './table.js';
export * from './prompt.js';
export * from './connector-map.js';
export * from './edge-validate.js';
export * from './document.js';
