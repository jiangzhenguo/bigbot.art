/**
 * BigBotArt 领域实体类型 — 画布、节点、资产、镜头、项目
 * 领域设计参考 H3Mise(story/shot/take/continuity/timeline),独立实现。
 */

/** 画布节点类型(节点-连线工作流图) */
export type NodeKind =
  | 'document' // Markdown Brief / 提示词
  | 'asset' // 图片/视频/音频/参考图
  | 'image-gen' // Text→Image
  | 'image-edit' // I2I / 指令编辑 / Inpaint / Outpaint
  | 'image-upscale' // 超分修复
  | 'shot' // 视频镜头(h3.c)
  | 'director' // 运镜调度小样(占位)
  | 'timeline' // 时间线/剪辑
  | 'audio-ref' // 音频参考(--ref-audio)
  | 'workflow-input' // 🆕 v2 工作流入口(资源容器,声明输入槽位)
  | 'workflow-output'; // 🆕 v2 工作流出口(产物汇聚,运行收口)

/** 画布上一个节点的实例 */
export interface CanvasNode {
  id: string;
  kind: NodeKind;
  /** 画布坐标与尺寸 */
  position: { x: number; y: number };
  width?: number;
  height?: number;
  /** 用户可见标题 */
  label: string;
  /** 节点业务数据(kind 相关) */
  data: NodeData;
  /** 前端渲染状态 */
  ui?: { selected?: boolean; stale?: boolean; running?: boolean };
  createdAt: string;
  updatedAt: string;
}

/** 节点间数据流/依赖边 */
export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  /** 语义标签,如 ref-image / first-frame / input-brief */
  label?: string;
}

/** 一次生成任务的档位预置(对应 h3.c 质量套餐) */
export type QualityTier = 'preview' | 'draft' | 'default' | 'reference';

/** 视频镜头生成模式(对接 h3.c 条件控制) */
export type H3Mode =
  | 'text2video' // -p only
  | 'first-frame' // --first-frame
  | 'last-frame' // --last-frame
  | 'first-last' // --first-frame + --last-frame (FL2VA)
  | 'ref-image'; // --ref-image (Ref2VA)

/** LLM 来源(全局默认 + 项目级覆盖两档;设置页五档单选) */
export type LlmSource =
  | { kind: 'cloud'; provider: string; model?: string } // provider = CloudProviderEntry.id
  | { kind: 'lmstudio'; model?: string }
  | { kind: 'ollama'; model?: string }
  | { kind: 'mlx-provider'; model: string }
  | { kind: 'openai-compatible'; baseUrl: string; apiKey?: string; model?: string }
  | { kind: 'none' };

/** 本地运行时发现的模型条目(仅列支持工具调用的) */
export interface LocalModelInfo {
  /** 运行时内模型 id(直接传给 chat.completions 的 model 字段) */
  id: string;
  /** 展示名(如 "Ornith-1.5-35B-A3B · 4bit") */
  displayName?: string;
  /** 文件体积(字节) */
  sizeBytes?: number;
  /** 显存预估 GB(权重 + KV cache + Metal 开销 ≈ 体积 × 1.13) */
  vramGb?: number;
  supportsTools: boolean;
  /** 当前已加载/驻留显存 */
  loaded?: boolean;
  /** 备注:推荐 / 识图 等 */
  note?: string;
  /** true=本机未安装,选中后按需下载(pi-mlx / Ollama) */
  needsDownload?: boolean;
}

/** 一个本地运行时的探测结果(LM Studio / Ollama / pi-mlx) */
export interface LocalRuntimeModels {
  kind: 'lmstudio' | 'ollama' | 'pimlx';
  available: boolean;
  endpoint?: string;
  models: LocalModelInfo[];
  /** 不可用原因(如 "未检测到 LM Studio(127.0.0.1:1234)") */
  detail?: string;
  /** 统一内存总量 GB(显存仪表条分母) */
  memTotalGb: number;
}

/** 云端供应商目录条目(API Key 存 macOS 钥匙串,绝不落盘/回传) */
export interface CloudProviderEntry {
  /** 预设 id(deepseek 等)或 custom-<时间戳> */
  id: string;
  name: string;
  /** 字母标(头像) */
  avatar: string;
  sub?: string;
  host: string;
  models: string[];
  enabled: boolean;
  /** 钥匙串里是否已有凭据 */
  hasKey: boolean;
}

/** 连接检查结果(GET {baseUrl}/models) */
export interface LlmConnectionTest {
  ok: boolean;
  latencyMs?: number;
  modelCount?: number;
  detail?: string;
}

export interface NodeDataMap {
  document: { markdown: string };
  asset: { assetId: string; mediaType: 'image' | 'video' | 'audio' | 'document' };
  'image-gen': ImageGenParams;
  'image-edit': ImageEditParams;
  'image-upscale': { model: string; scale: number };
  shot: ShotParams;
  director: { prompt: string };
  timeline: { shotNodeIds: string[] };
  'audio-ref': { assetId: string };
  /** 🆕 v2 工作流入口:声明输入槽位,值由用户填充(资产/文件/内联文本) */
  'workflow-input': {
    slots: Array<{
      /** 槽位名,如 "主提示词" / "参考图-A" / "背景音乐" */
      name: string;
      /** 允许的媒体类型,空数组 = 任意 */
      accept: Array<'image' | 'video' | 'audio' | 'document' | 'text'>;
      /** 必填;运行时尚未填 → 拒绝执行 */
      required: boolean;
      /** 当前填充的资源 */
      value?:
        | { kind: 'asset'; assetId: string }
        | { kind: 'file'; path: string }
        | { kind: 'inline-text'; text: string };
    }>;
  };
  /** 🆕 v2 工作流出口:产物汇聚,运行收口 */
  'workflow-output': {
    outputs: Array<{
      /** 产物名,如 "成片" / "海报" / "字幕" */
      name: string;
      kind: 'image' | 'video' | 'audio' | 'document';
      /** 该 output 接收哪些上游节点的产物(类型必须与 kind 一致) */
      sourceNodeIds: string[];
      /** output 文件名后缀,如 "mp4" / "png" / "srt";缺省按 kind 推断 */
      ext?: string;
    }>;
  };
}

/** union helper */
export type NodeData = NodeDataMap[NodeKind];

/** 图片生成参数(mlxgen) */
export interface ImageGenParams {
  engine: 'mlxgen' | 'comfyui' | 'mock';
  model: string; // e.g. AbstractFramework/z-image-turbo-8bit
  prompt: string;
  width: number;
  height: number;
  steps?: number;
  guidance?: number;
  /** 多 seed 批量 */
  seeds: number[];
}

/** 图片编辑参数(mlxgen:指令编辑 / I2I / Inpaint / Outpaint) */
export interface ImageEditParams {
  engine: 'mlxgen' | 'comfyui' | 'mock';
  model: string;
  prompt: string;
  mode:
    | 'instruction' // Qwen Edit 指令编辑
    | 'img2img' // latent I2I
    | 'inpaint' // 遮罩编辑(--mask-path)
    | 'outpaint'; // 扩图
  inputAssetId?: string;
  maskAssetId?: string;
  outpaintSides?: { top: number; bottom: number; left: number; right: number };
}

/** 视频镜头参数(h3.c) */
export interface ShotParams {
  engine: 'h3c' | 'comfyui' | 'mock';
  mode: H3Mode;
  /** text2video 的提示词(H3 五段式) */
  prompt: string;
  modeText?: string;
  /** 目标画幅比例;custom 时用 customWidth/customHeight */
  aspect?: '16:9' | '9:16' | '1:1' | 'custom';
  width: number;
  height: number;
  /** 自定义画幅时的宽高(必须 32 倍数,clamp 时按 32 倍数对齐) */
  customWidth?: number;
  customHeight?: number;
  /** 时长(秒,24fps);给定时优先于 frames */
  seconds?: number;
  frames: number;
  steps: number;
  layers: number;
  reuse: number;
  tier: QualityTier;
  seed: number;
  /** 引用绑定:资产 id → 角色(映射 --ref-image / --first-frame 等) */
  refs: { assetId: string; role: 'first-frame' | 'last-frame' | 'ref-image' | 'ref-audio' }[];
  promptTemplate?: string;
}

/** 一次生成结果 = Take(保留历史,不覆盖) */
export interface Take {
  id: string;
  shotNodeId: string;
  attempt: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  providerTaskId?: string;
  params: Record<string, unknown>;
  resultPath?: string;
  /** 耗时(秒,从提交到完成) */
  durationSec?: number;
  /** h3.c 命令行(dry-run 调试 / 失败诊断用) */
  cmdline?: string;
  cost?: { credits?: number; unit?: string };
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

/** shot 节点的 Take 历史(按 attempt 排序,最新在前) */
export interface ShotTakeHistory {
  shotNodeId: string;
  takes: Take[];
  /** 当前选中的 Take id(用户切换显示用) */
  currentTakeId?: string;
}

/** 调试日志条目(主进程总线 → 渲染层面板) */
export interface DebugLogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error' | 'h3';
  msg: string;
}

/** 资产(媒体库条目) */
export interface Asset {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'document';
  name: string;
  localPath: string;
  mime?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  tags: string[];
  createdAt: string;
}

/** 项目(SQLite 持久化) */
export interface Project {
  id: string;
  name: string;
  description?: string;
  story?: string;
  /** 项目级 LLM 覆盖 */
  llmOverride?: LlmSource;
  createdAt: string;
  updatedAt: string;
  /** 项目下的画布 id 列表(新模型:一个项目可有多画布,M1+;空数组表示还没画布) */
  canvasIds: string[];
  /** 当前活动画布 id(进入项目时默认打开的画布) */
  activeCanvasId: string;
}

/** 单个画布的快照(节点 + 连线);持久化在 canvases-${projectId}.json 中 */
export interface CanvasSnapshot {
  /** 画布 id,全局唯一;通过 projectId 字段归属项目 */
  id: string;
  projectId: string;
  name: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** 项目下所有画布的容器(一次 IPC 拉完) */
export interface ProjectCanvases {
  projectId: string;
  canvases: CanvasSnapshot[];
  activeCanvasId: string;
}

/** 渲染任务队列条目 */
export interface RenderJob {
  id: string;
  nodeId: string;
  provider: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  /** 引擎槽位(视频独占 / 图片) */
  slot: 'video' | 'image' | 'llm';
  /** 归属(连续性校验/事件推送用) */
  projectId?: string;
  canvasId?: string;
  progress?: number;
  stage?: string;
  error?: string;
  takeId?: string;
  resultPath?: string;
  createdAt: string;
  updatedAt: string;
}

/** Skill — 画布工作流模板(节点结构 + 参数 + 提示词模板),可保存/套用 */
export interface Skill {
  id: string;
  name: string;
  /** 模板画布快照(保存时深拷贝,应用时换新 id 实体化) */
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** 占位参数(如 {主题} {旁白} {时长}),应用时可替换 */
  params: string[];
  description?: string;
  createdAt: string;
  updatedAt: string;
}

/** 时间线导出请求 */
export interface TimelineExportRequest {
  projectId: string;
  /** 按时间线顺序的媒体片段 */
  clips: Array<{
    path: string;
    label?: string;
    /** 来自哪个 shot 节点的 Take */
    nodeId?: string;
    takeId?: string;
  }>;
  outputName?: string;
}

/** 导出任务(后台 ffmpeg) */
export interface ExportTask {
  id: string;
  projectId: string;
  status: 'running' | 'succeeded' | 'failed';
  progress?: number;
  stage?: string;
  error?: string;
  outputPath?: string;
  createdAt: string;
}

/** 应用设置(全局,持久化 ~/.bigbotart/settings.json) */
export interface AppSettings {
  /** 全局默认 LLM 来源(设置页),项目级覆盖优先 */
  llm?: LlmSource;
  /** 渲染模式:demo=始终 mock 占位;real=引擎就绪则真实推理 */
  renderMode: 'demo' | 'real';
  lmStudioModel?: string;
  /** 默认档位:时间线/生成默认 tier */
  defaultTier?: QualityTier;
  /** 云端供应商目录(凭据存钥匙串,这里只有 hasKey 标记) */
  cloudProviders?: CloudProviderEntry[];
}

/** 资产导入结果 */
export interface AssetImportResult {
  assets: Asset[];
  failed: Array<{ name: string; error: string }>;
  /** 用户在系统对话框里取消选择 */
  canceled?: boolean;
}

/* ═══ Agent 会话 / 记忆体系(画布页 Agent 对话) ═══ */

/** 分层记忆(MemGPT 式):core 核心记忆 + 画布总结 + recall 对话流 + archival 归档 */
export interface ProjectMemory {
  projectId: string;
  /** 核心记忆(始终全量注入 system prompt) */
  core: {
    projectGoal: string;
    styleGuide: string;
    constraints: string;
    userPreferences: string;
  };
  /** 每个画布的总结记忆(切换画布时写入;其他画布以 summary 注入当前会话) */
  canvasMemory: Record<string, {
    summary: string;
    nodeCount: number;
    lastActive: string;
    keyDecisions: string[];
  }>;
  /** 全部对话消息(可检索) */
  recall: RecallMessage[];
  /** 归档记忆(长期事实:生成产物/关键决定/资产备注) */
  archival: ArchivalEntry[];
}

export interface RecallMessage {
  id: string;
  canvasId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** role=tool 时的工具名与参数 */
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  /** 工具执行结果摘要(role=tool) */
  toolResult?: string;
  createdAt: string;
}

export interface ArchivalEntry {
  id: string;
  text: string;
  tags: string[];
  sourceCanvasId?: string;
  createdAt: string;
}

/** Agent 对话消息(渲染层展示用) */
export interface AgentChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  /** 工具调用卡数据 */
  toolCall?: { name: string; args: Record<string, unknown>; status: 'running' | 'success' | 'error'; result?: string; nodeId?: string };
  createdAt: string;
}

/** chat 请求/响应 */
export interface AgentChatRequest {
  projectId: string;
  canvasId: string;
  text: string;
}
export interface AgentChatResponse {
  ok: boolean;
  /** assistant 最终回复文本 */
  reply?: string;
  /** 本轮执行的工具调用(渲染层据此画工具卡) */
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; ok: boolean; result: string; nodeId?: string }>;
  /** 连续性校验结果(引擎任务完成后自动触发) */
  continuity?: { checked: boolean; issues: string[] };
  error?: string;
  aborted?: boolean;
}

/** Agent 实时事件(主进程 → 渲染层推送) */
export interface AgentEvent {
  kind: 'tool-start' | 'tool-end' | 'thinking' | 'aborted' | 'continuity';
  projectId: string;
  canvasId: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  ok?: boolean;
  result?: string;
  nodeId?: string;
  issues?: string[];
}