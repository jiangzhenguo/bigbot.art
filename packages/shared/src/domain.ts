/**
 * BigBotArt 领域实体类型 — 画布、节点、资产、镜头、项目
 * 领域设计参考 H3Mise(story/shot/take/continuity/timeline),独立实现。
 */
import type { PromptSource } from './prompt.js';

/** 画布节点类型(节点-连线工作流图) */
export type NodeKind =
  | 'document' // Markdown Brief / 提示词
  | 'asset' // 图片/视频/音频/参考图
  | 'image-gen' // Text→Image
  | 'image-edit' // I2I / 指令编辑 / Inpaint / Outpaint
  | 'image-upscale' // 超分修复
  | 'image-crop' // 图片裁切:按目标画幅裁剪原图,供下游节点使用(如 1:1 → 9:16)
  | 'shot' // 视频镜头(h3.c)
  | 'director' // 运镜调度小样(占位)
  | 'timeline' // 时间线/剪辑
  | 'audio-ref' // 音频参考(--ref-audio)
  | 'storyboard' // 🆕 分镜表(脚本)节点:Markdown 表格为数据载体,一行 = 一个分镜
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
  'image-crop': ImageCropParams;
  shot: ShotParams;
  director: { prompt: string };
  timeline: TimelineData;
  'audio-ref': { assetId: string };
  /** 🆕 分镜表(脚本)节点:markdown 为唯一真源(标题+说明+GFM 表格块) */
  storyboard: StoryboardData;
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

/**
 * 分镜表(脚本)节点数据 — 文档 §4.2
 *
 * 设计要点:
 * - markdown 是唯一真源:标题 + 说明 + 一个 GFM 表格块(表格编辑原位回写表格块)
 * - lastTable = 上次铺节点/重新同步时的表格 GFM 快照;当前表 ≠ lastTable 且已铺节点 → stale
 * - aspect / tier 为铺节点默认值(可随节点持久化)
 */
export interface StoryboardData {
  markdown: string;
  /** 全局质感段:铺节点时注入每一行 prompt 组装 */
  basePrompt?: string;
  /** 上次铺节点/重新同步时的表格 GFM 快照(dirty 判定) */
  lastTable?: string;
  /** 铺节点默认画幅 */
  aspect?: '16:9' | '9:16' | '1:1';
  /** 铺节点默认档位 */
  tier?: QualityTier;
}

/**
 * 时间线 / 剪辑节点数据 — P0 完成版
 *
 * 设计要点:
 * - shotNodeIds 是入边派生态唯一来源,Inspector 可手动 override 顺序(manualOrder=true)
 * - picks / trim / transitions / audio / exportPreset 全可选,缺省走合理默认
 * - 旧快照(只有 shotNodeIds)零迁移成本
 */
export interface TimelineData {
  /** 入线镜头节点 id 列表(按时间线顺序;渲染层按边派生态自动写入) */
  shotNodeIds: string[];
  /** 用户手动调过顺序时为 true(不再被入边自动重排覆盖) */
  manualOrder?: boolean;
  /** 每个镜头被选中的 Take:shotNodeId → takeId;未设 = 该镜头 currentTakeId */
  picks?: Record<string, string>;
  /** 每个镜头的入出点裁切(秒);未设 = 整段 */
  trim?: Record<string, { inSec: number; outSec: number }>;
  /** 镜头间转场,长度 = shotNodeIds.length - 1 */
  transitions?: TimelineTransition[];
  /** 音轨与响度 */
  audio?: TimelineAudio;
  /** 导出预设 */
  exportPreset?: TimelineExportPreset;
  /** 🆕 最近一次导出成片(画布 timeline 节点体内嵌预览用;导出成功后由渲染层回写) */
  lastExport?: {
    path: string; // 成片文件路径(bba-output:// 可解析)
    name?: string; // 导出文件名
    format?: TimelineExportPreset['format'];
    resolution?: string; // 如 1920×1080 / 素材原始
    durationSec?: number;
    createdAt: string;
  };
}

/** 镜头间转场(在 #i 与 #i+1 镜头之间,0-indexed) */
export interface TimelineTransition {
  afterIndex: number;
  kind: 'cut' | 'crossfade' | 'fade-black';
  /** 仅 crossfade / fade-black 生效;cut 忽略 */
  durationMs?: number;
}

/** 时间线音轨 */
export interface TimelineAudio {
  /** 单段独立音量 0~2,默认 1;key = shotNodeId */
  perClipVolume?: Record<string, number>;
  /** 响度统一 −14 LUFS(默认开) */
  loudnessNormalize?: boolean;
}

/** 时间线导出预设 */
export interface TimelineExportPreset {
  format?: 'mp4-h264' | 'prores';
  resolution?: '1920x1080' | '1280x720' | 'source';
  /** P2 多平台版本(裁切/缩放/去字幕),目前仅记录 */
  platforms?: Array<'9:16' | '1:1' | 'no-subtitle'>;
}

/** 图片生成参数(mlxgen) */
export interface ImageGenParams {
  engine: 'mlxgen' | 'comfyui' | 'mock';
  model: string; // e.g. AbstractFramework/z-image-turbo-8bit
  prompt: string;
  /** 🆕 负向提示词(mlxgen `--negative-prompt`,非空才传;蒸馏模型不支持时 CLI 会报错) */
  negativePrompt?: string;
  width: number;
  height: number;
  steps?: number;
  guidance?: number;
  /** 多 seed 批量 */
  seeds: number[];
  /** 🆕 提示词来源追溯(文档标记选段 / 分镜表某行) */
  promptFrom?: PromptSource;
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
  /** 🆕 图像强度(0-1,img2img latent 用;→ `--image-strength`,0 不传/忽略) */
  imageStrength?: number;
  outpaintSides?: { top: number; bottom: number; left: number; right: number };
  /** 🆕 提示词来源追溯 */
  promptFrom?: PromptSource;
  /** 输入帧源(由 shot 连线自动取帧,渲染层写入) */
  inputFrameSource?: { videoNodeId: string; at: 'first' | 'last' };
  /** 输入图来源(由图片产物/素材连线直通,渲染层写入;运行期与 inputAssetId 同优先级) */
  inputImageFrom?: { nodeId: string };
}

/** 图片裁切参数(image-crop 节点:不推理,按目标画幅 ffmpeg 居中/锚点裁剪) */
export interface ImageCropParams {
  /** 目标画幅(A:B,如 1:1 → '9:16' 裁两边) */
  aspect: string;
  /** 裁切锚点:center=居中(默认)/ top / bottom / left / right(压缩轴按锚点取)
   *  例 1:1 → 9:16 横向裁切时 left/right 决定保留左半还是右半 */
  focus?: 'center' | 'top' | 'bottom' | 'left' | 'right';
  /** 输入图来源(素材连线直通,渲染层写入) */
  inputImageFrom?: { nodeId: string };
  /** 输入图 Asset id(手动绑定,与连线二选一) */
  inputAssetId?: string;
  /** 🆕 提示词来源追溯(占位,保持结构一致) */
  promptFrom?: PromptSource;
}

/**
 * 镜头加速档(🚀 加速 LoRA)。
 * h3.c CLI 不接受 --lora;加速 = 换蒸馏模型包目录(-d)+ 少步数(4/8 步),
 * 见 docs/MiniMax-H3-加速-LoRA-使用手册.md §8。提交时由主进程解析成实际 modelDir + steps。
 */
export interface ShotAccel {
  /** 本镜头是否开启加速 */
  enabled?: boolean;
  /** 使用的蒸馏模型包 id(设置页 accelPacks);缺省 = 默认包 */
  packId?: string;
  /** 加速步数档:4(边缘略糊) / 8(质量甜点,推荐) */
  steps?: 4 | 8;
}

/** 加速 LoRA 蒸馏模型包(设置页安装/管理;仅登记,不删磁盘) */
export interface AccelPack {
  id: string;
  name: string;
  /** 可传给 `h3 -d` 的模型目录(含 FL2VA/) */
  path: string;
  /** 推荐步数档 */
  steps?: 4 | 8;
  /** 是否默认包(镜头开启加速未选包时用) */
  default?: boolean;
  installedAt?: string;
  /** 列表时主进程回填:目录当前是否存在(存在但缺 FL2VA/ 视为 invalid) */
  exists?: boolean;
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
  /** 🚀 加速 LoRA:开启则提交时用蒸馏模型包 + 4/8 步(见 ShotAccel) */
  accel?: ShotAccel;
  /** 引用绑定:资产 id 或直连文件路径 → 角色(映射 --ref-image / --first-frame / --ref-video 等)
   *  - assetId:资产中心的引用(由连线自动注入或手动添加)
   *  - path:直连文件路径(如上游 shot 抽出的尾帧 PNG),优先于 assetId 解析 */
  refs: {
    assetId?: string;
    path?: string;
    role: 'first-frame' | 'last-frame' | 'ref-image' | 'ref-audio' | 'ref-video';
  }[];
  promptTemplate?: string;
  /** 🆕 提示词来源追溯(分镜表某行 mode=row) */
  promptFrom?: PromptSource;
}

/** 一次生成结果 = Take(保留历史,不覆盖;shotNodeId 字段语义为「节点 id」,shot/image-gen/image-edit/image-crop 通用) */
export interface Take {
  id: string;
  shotNodeId: string;
  attempt: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  providerTaskId?: string;
  params: Record<string, unknown>;
  resultPath?: string;
  /** 媒体时长(秒,成功产物的视频/音频长度;时间线与剪辑用) */
  durationSec?: number;
  /** 生成耗时(秒,墙钟:从提交到完成;与媒体时长 durationSec 区分,检查器「耗时」用) */
  elapsedSec?: number;
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
  /** 归属项目;缺省 = 总资源库(全局共享) */
  projectId?: string;
  /** 分类 id(资产库分类字典);缺省 = 未分类 */
  categoryId?: string;
  /** 入库来源:手动导入 / 对话附件 / 画布产物归档 */
  source?: 'import' | 'attachment' | 'product';
  /** 来源节点 id(仅 source='product',用于反查画布引用与定位) */
  originNodeId?: string;
  tags: string[];
  /** 软删除标记(进回收站);list / list(projectId) 不再返回 */
  deletedAt?: string;
  createdAt: string;
}

/** 资源分类(项目级或全局;删除时分类下资源转「未分类」,文件保留) */
export interface AssetCategory {
  id: string;
  name: string;
  /** 分类归属:项目分类带 projectId;全局分类缺省 */
  projectId?: string;
  createdAt: string;
}

/** 资源被画布引用的位置(删除安全警告 / 「定位画布」跳转) */
export interface AssetRef {
  assetId: string;
  projectId: string;
  canvasId: string;
  canvasName: string;
  nodeId: string;
  /** 引用节点类型:asset / shot / image-edit / image-upscale / audio-ref / workflow-input */
  kind: string;
  /** 人读描述,如「主画布 · 镜头 01 · Ref2VA」 */
  where: string;
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

/** 画布视口(平移 + 缩放):随画布快照持久化,退出/重进恢复上次看到的位置 */
export interface CanvasViewport {
  /** 世界坐标原点在舞台内的屏幕偏移(px) */
  x: number;
  y: number;
  /** 缩放比例(1 = 100%;UI 钳制在 0.4–1.3) */
  z: number;
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
  /** 画布视口(旧项目文件缺省;读入时做有限性 + 范围校验,非法值回退默认视图) */
  viewport?: CanvasViewport;
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

/** Skill — 画布工作流模板(节点结构 + 参数 + 提示词模板),可保存/套用
 *  双形态:画布模板(nodes/edges 克隆实体化)+ Agent 指令段(instructions 对话自动注入) */
export interface Skill {
  id: string;
  name: string;
  /** 模板画布快照(保存时深拷贝,应用时换新 id 实体化;纯指令技能可空) */
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** 占位参数(如 {主题} {旁白} {时长}),应用时可替换 */
  params: string[];
  description?: string;
  /** 🆕 Agent 操作指令段:Markdown 操作手册/提示词,激活后注入 buildContext 的 systemPrompt */
  instructions?: string;
  /** 🆕 注入模式:full=全量注入(缺省) / summary=上下文只放摘要,按需用 skills.read 取全文 */
  inject?: 'full' | 'summary';
  /** 🆕 官方精选出厂技能(首次启动 seed,可删除;区别于「我的 Skill」) */
  builtin?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 时间线导出请求 */
export interface TimelineExportRequest {
  projectId: string;
  /** 简化路径清单(老接口,无编排时使用,纯 concat) */
  clips: Array<{
    path: string;
    label?: string;
    /** 来自哪个 shot 节点的 Take */
    nodeId?: string;
    takeId?: string;
  }>;
  /** 🆕 编排序列(与 timeline 节点 data 一一对应);提供时优先于 clips 解析路径 */
  sequence?: Array<{
    shotNodeId: string;
    /** 缺省 = shot 的 currentTakeId */
    takeId?: string;
    trim?: { inSec: number; outSec: number };
    /** 0~2,默认 1 */
    volume?: number;
  }>;
  /** 🆕 转场表(长度 = sequence.length - 1);未提供则全部硬切 */
  transitions?: TimelineTransition[];
  /** 🆕 音轨与响度统一 */
  audio?: TimelineAudio;
  /** 🆕 导出预设 */
  exportPreset?: TimelineExportPreset;
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
  /** h3 视频生成:SSD 流式读权重(--ssd-streaming)。省 RAM(峰值≈6GB)但慢约 30%;64GB+ 默认关更快 */
  ssdStreaming?: boolean;
  lmStudioModel?: string;
  /** 默认档位:时间线/生成默认 tier */
  defaultTier?: QualityTier;
  /** 🚀 加速 LoRA 蒸馏模型包库(设置页安装/管理;h3.c -d 用的 turbo 目录,非 .safetensors) */
  accelPacks?: AccelPack[];
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

/** 单画布记忆:节点总结(切换画布时写入)+ 对话压缩摘要(/compact 生成,注入当前会话上下文) */
export interface CanvasMemory {
  summary: string;
  nodeCount: number;
  lastActive: string;
  keyDecisions: string[];
  /** /compact 生成的对话压缩摘要(注入当前画布上下文,压缩后仍保留全局脉络) */
  conversationSummary?: string;
  /** 🆕 当前画布激活的 Agent 技能 id(对话自动注入该技能指令段;同一画布至多一个) */
  activeSkillId?: string;
}

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
  canvasMemory: Record<string, CanvasMemory>;
  /** 全部对话消息(可检索) */
  recall: RecallMessage[];
  /** 归档记忆(长期事实:生成产物/关键决定/资产备注) */
  archival: ArchivalEntry[];
}

export interface RecallMessage {
  id: string;
  canvasId: string;
  /** system = 工具成功后的动作记录(人类可读,随最近消息注入下一轮上下文) */
  role: 'user' | 'assistant' | 'tool' | 'system';
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
  /** 用户从资产库挑选的附件(已在资产库,Agent 可按 id 引用/连线) */
  attachments?: Array<{ id: string; name: string; kind: string; localPath: string }>;
  /** 画布当前选中节点 id(可选;主进程把节点详情摘要附进本轮 user 消息,让 Agent 感知用户在操作谁) */
  selectedNodeId?: string;
}
/** ask.user 结构化提问选项(🆕 支持副说明与推荐徽标;worker 已把字符串归一化为对象) */
export interface AskOption {
  /** 选项主文案(点选后作为用户消息回传) */
  label: string;
  /** 灰色补充说明行(可选) */
  sub?: string;
  /** 推荐徽标(可选,至多一个) */
  recommended?: boolean;
}

export interface AgentChatResponse {
  ok: boolean;
  /** assistant 最终回复文本 */
  reply?: string;
  /** 模型思考内容(渲染层折叠展示;不进 recall 记忆) */
  thinking?: string;
  /** 本轮执行的工具调用(渲染层据此画工具卡) */
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; ok: boolean; result: string; nodeId?: string }>;
  /** 🆕 结构化提问(Agent 调用 ask.user 暂停,等待用户在确认卡片选择) */
  ask?: { question: string; options: AskOption[] };
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