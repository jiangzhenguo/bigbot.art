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
  // Provider / 渲染任务
  checkProviders(): Promise<Record<string, import('./provider').ProviderStatus>>;
  submitRender(req: import('./provider').RenderRequest): Promise<import('./provider').RenderJobHandle>;
  renderStatus(provider: string, handle: { providerTaskId: string }): Promise<import('./provider').RenderStatus>;
  cancelRender(provider: string, handle: { providerTaskId: string }): Promise<void>;
  /** 渲染队列:当前全部任务(含排队位置/进度) */
  queueStatus(): Promise<import('./domain').RenderJob[]>;
  // 项目 / 画布
  listProjects(): Promise<import('./domain').Project[]>;
  createProject(name: string): Promise<import('./domain').Project>;
  deleteProject(id: string): Promise<{ ok: boolean; error?: string }>;
  renameProject(id: string, name: string): Promise<{ ok: boolean; error?: string }>;
  loadCanvas(projectId: string): Promise<import('./domain').CanvasSnapshot>;
  saveCanvas(snapshot: import('./domain').CanvasSnapshot): Promise<{ ok: boolean }>;
  /** 项目级 LLM 覆盖(null 清除,回退全局) */
  setProjectLlm(projectId: string, llm: import('./domain').LlmSource | null): Promise<{ ok: boolean }>;
  /** 加载项目下所有画布 + 活动画布 id(一次拉完,前端切换无往返) */
  loadProjectCanvases(projectId: string): Promise<import('./domain').ProjectCanvases>;
  /** 保存单画布快照(自动写回项目容器) */
  saveCanvasSnapshot(snap: import('./domain').CanvasSnapshot): Promise<{ ok: boolean }>;
  /** 创建一个新画布(空白),返回画布;持久化并设为主画布(若项目无画布) */
  createCanvas(projectId: string, name?: string): Promise<import('./domain').CanvasSnapshot>;
  /** 重命名画布 */
  renameCanvas(projectId: string, canvasId: string, name: string): Promise<{ ok: boolean; error?: string }>;
  /** 删除画布(至少保留 1 个);若删的是 active,自动切换到剩余第一个 */
  deleteCanvas(projectId: string, canvasId: string): Promise<{ ok: boolean; error?: string }>;
  /** 切换活动画布;只改 active 指针,不返回画布内容(前端已持有完整列表) */
  switchActiveCanvas(projectId: string, canvasId: string): Promise<{ ok: boolean }>;
  // 资产中心
  importAssets(opts?: { paths?: string[] }): Promise<import('./domain').AssetImportResult>;
  listAssets(): Promise<import('./domain').Asset[]>;
  deleteAsset(id: string): Promise<{ ok: boolean; error?: string }>;
  // Skills 库
  listSkills(): Promise<import('./domain').Skill[]>;
  saveSkill(input: { name: string; projectId: string }): Promise<import('./domain').Skill>;
  applySkill(skillId: string, projectName: string): Promise<{ project: import('./domain').Project }>;
  deleteSkill(id: string): Promise<{ ok: boolean; error?: string }>;
  // 时间线导出(FFmpeg)
  exportTimeline(req: import('./domain').TimelineExportRequest): Promise<{ ok: boolean; taskId?: string; error?: string }>;
  exportStatus(taskId: string): Promise<import('./domain').ExportTask>;
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
  /** 画布页多轮对话(带工具调用 + 记忆上下文 + AbortSignal 打断) */
  agentChat(req: import('./domain').AgentChatRequest): Promise<import('./domain').AgentChatResponse>;
  /** 真实打断当前对话(中止 LLM 请求) */
  agentCancel(projectId: string): Promise<{ ok: boolean }>;
  /** 订阅 Agent 实时事件(工具调用/校验)——渲染层注册回调,返回退订函数 */
  onAgentEvent(cb: (ev: import('./domain').AgentEvent) => void): () => void;
  /** 读取项目记忆(调试/设置页展示) */
  memoryGet(projectId: string): Promise<import('./domain').ProjectMemory>;
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
