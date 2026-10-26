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
  | 'image-stitch' // 🆕 图片拼接:多张图按横排/竖排/网格拼成一张(纯 ffmpeg,不推理)
  | 'image-split' // 🆕 图片拆分:一张图等分成多片(长图切片/九宫格切图,纯 ffmpeg)
  | 'frame-grab' // 🆕 视频裁切取帧:从视频截取一帧导出为**图片资源**(ffmpeg,不推理;产物是图片)
  | 'video-upscale' // 🆕 视频增强(超分 + 合修脸):Real-ESRGAN 超分 + GFPGAN/CodeFormer 修脸 + ffmpeg 去块,不走推理队列
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

/**
 * LLM 对话协议(决定打哪个端点、用哪套报文形状)。
 * - `chat`      = `/v1/chat/completions`(2022 经典接口,绝大多数 OpenAI 兼容端点都实现它)
 * - `responses` = `/v1/responses`(OpenAI 新接口:类型化 output item、可 stateful;部分模型/供应商只开这一个口子)
 * 详见 docs/LLM协议-ChatCompletions与Responses.md。
 */
export type LlmProtocol = 'chat' | 'responses';

/** LLM 来源(全局默认 + 项目级覆盖两档;设置页五档单选) */
export type LlmSource =
  | { kind: 'cloud'; provider: string; model?: string; protocol?: LlmProtocol } // provider = CloudProviderEntry.id
  | { kind: 'lmstudio'; model?: string }
  | { kind: 'ollama'; model?: string }
  | { kind: 'mlx-provider'; model: string }
  | { kind: 'openai-compatible'; baseUrl: string; apiKey?: string; model?: string; protocol?: LlmProtocol }
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
  /**
   * 该供应商默认对话协议(缺省 `'chat'`)。同一个供应商可能混用协议
   * (OpenCode Go:deepseek/glm 走 chat,grok/gpt-luna 走 responses),
   * 单模型例外写在 `modelProtocols` 里。
   */
  protocol?: LlmProtocol;
  /** 单模型协议覆盖:model id → 协议(优先级高于 `protocol` 与内置知识表) */
  modelProtocols?: Record<string, LlmProtocol>;
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
  'image-stitch': ImageStitchParams;
  'image-split': ImageSplitParams;
  /** 🆕 视频裁切取帧:从视频截一帧导出为图片资源(ffmpeg,产物是图片) */
  'frame-grab': FrameGrabParams;
  /** 🆕 视频增强(超分 + 合修脸):Real-ESRGAN + GFPGAN/CodeFormer + ffmpeg 去块 */
  'video-upscale': VideoUpscaleParams;
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
  /**
   * 🆕 最近一次导出成片的**绝对路径**(与 lastExport 同一次导出,导出成功时一并回写)。
   *
   * 为什么需要它:timeline 作为「视频产物源」连下游(frame-grab 取帧 / video-upscale 再增强 /
   * shot 参考视频 / audio-ref 抽音轨 / 另一条时间线入轨)时,下游解析器统一读
   * `data.resultPath`(与 shot / video-upscale 同口径)——lastExport.path 是 bba-output://
   * 展示 URL,ffmpeg 用不了。两字段同源同写,只用其一的读取方各取所需。
   */
  resultPath?: string;
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
  /**
   * 🆕 参考图来源(ref-image 入边,多值,渲染层写入;删除边即撤销)。
   * 有参考图时缺省模型走 `image.instruction`(Qwen-Image-2.1 edit-reference),
   * 不是 Klein 的 multi-reference;显式选 flux.2-klein 才走多参考生成。
   */
  refImageFrom?: Array<{ nodeId: string }>;
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
  /**
   * 🆕 **像素面积预算**(→ `--output-resolution`,默认 1024;仅 Qwen-Image-2.1 参考编辑用)。
   *
   * 参考图会被缩放到该预算内,**未显式给 width/height 时**输出尺寸也据此推导:
   * `w = √(res² × ratio)` 取 32 的倍数,其中 `ratio` 取自**最后一张**参考图
   * (不是第一张,见 providers/mlxgen.ts 的 isQwen21Edit 注释)。
   * 给了显式 `width`/`height` 后,它只影响参考图缩放,不再决定输出尺寸。
   */
  outputResolution?: number;
  /**
   * 🆕 **显式输出宽高**(→ `--width` / `--height`;仅 Qwen-Image-2.1 参考编辑用)。
   *
   * 编辑**可以**指定任意尺寸,宽高比不受参考图约束(实测:参考图 3:4 也能输出 16:9)。
   * 硬约束:`≥32` **且必须是 32 的倍数**,否则 CLI 直接 exit
   * (`Qwen-Image-2.1 dimensions must be positive multiples of 32.`)。
   *
   * ⚠️ **必须成对给**:只给一个时另一个会走「按最后一张参考图比例推导」的默认路径,
   * 拼出用户没预期的比例 —— provider 侧因此只在两个都有效时才传。
   */
  width?: number;
  height?: number;
  outpaintSides?: { top: number; bottom: number; left: number; right: number };
  /** 🆕 提示词来源追溯 */
  promptFrom?: PromptSource;
  /** 输入帧源(由 shot 连线自动取帧,渲染层写入) */
  inputFrameSource?: { videoNodeId: string; at: 'first' | 'last' };
  /** 输入图来源(由图片产物/素材连线直通,渲染层写入;运行期与 inputAssetId 同优先级) */
  inputImageFrom?: { nodeId: string };
  /**
   * 🆕 参考图来源(ref-image 入边,多值,渲染层写入;删除边即撤销)。
   * 供 Qwen-Image-2.1 的 `qwen21.edit` 多参考编辑(1-10 张)使用;
   * 提交时解析为 RenderRequest.references(role='ref-image')。
   */
  refImageFrom?: Array<{ nodeId: string }>;
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

/** 图片拼接参数(image-stitch 节点:不推理,ffmpeg 把多张图按行/列/网格拼成一张) */
export interface ImageStitchParams {
  /** 拼接方式:row=横排 / column=竖排(长图)/ grid=网格(九宫格等) */
  mode: 'row' | 'column' | 'grid';
  /** grid 模式列数(行数 = ceil(片数/列数)),默认 3 */
  gridCols?: number;
  /** 图片间距 px,默认 0 */
  gap?: number;
  /** 间距/留白底色(ffmpeg 色名或 #hex),默认 white */
  bg?: string;
  /** 拼接件来源(piece 多值端口连线派生,渲染层按源节点画布位置排序写入:横排按 x、竖排/网格按 y) */
  piecesFrom?: Array<{ nodeId: string }>;
  /** 🆕 提示词来源追溯(占位,保持结构一致) */
  promptFrom?: PromptSource;
}

/** 图片拆分参数(image-split 节点:不推理,ffmpeg 把一张图等分成多片) */
export interface ImageSplitParams {
  /** 拆分方式:rows=横切 N 段(水平条)/ cols=竖切 N 段(竖条)/ grid=gridCols×gridRows 网格 */
  mode: 'rows' | 'cols' | 'grid';
  /** rows/cols 模式份数,默认 3 */
  count?: number;
  /** grid 模式列数/行数,默认 3×3(九宫格) */
  gridCols?: number;
  gridRows?: number;
  /** 输入图来源(素材连线直通,渲染层写入) */
  inputImageFrom?: { nodeId: string };
  /** 输入图 Asset id(手动绑定,与连线二选一) */
  inputAssetId?: string;
  /** 最近一次运行的全部切片产物路径(第 1 片同步写 resultPath;下游 piece-N 端口按序号取片) */
  pieces?: string[];
  /** 🆕 提示词来源追溯(占位,保持结构一致) */
  promptFrom?: PromptSource;
}

/**
 * 视频裁切取帧参数(frame-grab 节点:不推理,ffmpeg 从视频截一帧导出为图片资源)。
 *
 * 与 image-crop 的区别:image-crop 是「按画幅裁剪一张**已有的图**」;
 * 本节点是「从一段**视频**里截取某一时刻的画面,产出一张图片」——
 * 产物是图片(可继续接 image-edit / image-upscale / 参考图端口),
 * 因此不得把视频产物直连图片编辑(需先经本节点落成静帧)。
 */
export interface FrameGrabParams {
  /** 取帧位置:first=首帧(默认)/ last=尾帧 / at=指定时间点(seconds 必填) */
  mode: 'first' | 'last' | 'at';
  /** mode='at' 时的取帧时间点(秒,非负有限数) */
  seconds?: number;
  /** 输入视频来源(镜头/视频增强/视频素材连线派生,渲染层写入) */
  inputVideoFrom?: { nodeId: string };
  /** 输入视频 Asset id(手动绑定,与连线二选一) */
  inputAssetId?: string;
  /** 抽出并导入资产库后的 asset id(产物本身也是一条资产) */
  resultAssetId?: string;
  /** 成片产物路径(抽出的 PNG;交给引擎一律用它,不要用 assetCache) */
  resultPath?: string;
  /** 最近一次运行的耗时(秒,仅展示) */
  elapsedSec?: number;
  /** 当前绑定 Take(覆盖历史回看用) */
  currentTakeId?: string;
  /** 🆕 提示词来源追溯(占位,保持结构一致) */
  promptFrom?: PromptSource;
}

/**
 * 视频增强参数(video-upscale 节点:纯本地后处理,不进推理队列)。
 *
 * 对应 POST_PROCESSING.md 的「超分 + 合修脸」流水线,三个阶段可独立开关:
 *   ① 去块(deblock)— ffmpeg,消灭 h264 压缩块(超分前做,否则块被放大成方格)
 *   ② 超分(upscale)— Real-ESRGAN 逐帧或整段(GFPGAN 内置超分时自动跳过,避免二次放大)
 *   ③ 修脸(faceFix)— GFPGAN/CodeFormer 逐帧人脸修复
 *
 * 字段全部可选,缺省走 POST_PROCESSING.md §9 的「标准(无方格问题)」配方。
 */
export interface VideoUpscaleParams {
  /** 放大倍数:1=只修脸不放大(方案 C)/ 2=2x(默认)/ 3 / 4。SeedVR2 下 1=原分辨率修复 */
  scale?: number;
  /**
   * 超分引擎:
   * realesrgan=PyTorch Real-ESRGAN(默认) /
   * seedvr2=mlxgen SeedVR2 视频超分(MLX,默认 3B 8bit) /
   * none=不超分(仅修脸,等价 scale=1)
   */
  superRes?: 'realesrgan' | 'seedvr2' | 'none';
  /** SeedVR2 模型(superRes=seedvr2 时;缺省 AbstractFramework/seedvr2-3b-8bit) */
  seedvrModel?: string;
  /** Real-ESRGAN 模型(见 POST_PROCESSING.md §2.1):
   *  realesrgan-x4plus=真人/照片(默认,anim evideov3 对真人会产生方格)
   *  realesr-animevideov3=动漫/插画 / realesrgan-x4plus-anime=动漫插画 */
  srModel?: 'realesrgan-x4plus' | 'realesr-animevideov3' | 'realesrgan-x4plus-anime';
  /** 修脸模型:gfpgan(默认)/ codeformer(保真度可调,更保留身份)/ none=仅超分不修脸 */
  faceModel?: 'gfpgan' | 'codeformer' | 'none';
  /** 修脸强度 0-1(GFPGAN weight,默认 0.5):0.3 轻修保留特征 / 0.7 强修 / 1.0 完全生成 */
  faceWeight?: number;
  /** CodeFormer 保真度 0-1(默认 0.7):0.5 偏修复 / 0.9 偏保真(仅 faceModel=codeformer 生效) */
  fidelityWeight?: number;
  /** 去块(deblock)开关:默认关;开 = 超分前先跑 ffmpeg deblock + 高码率重编码(方案 B 第 1 步) */
  deblock?: boolean;
  /** 高码率重编码 CRF(去块阶段用,默认 14;越低码率越高) */
  deblockCrf?: number;
  /** 输出编码 CRF(默认 18,与 face_fix_video.py 一致) */
  crf?: number;
  /** 计算设备:mps(默认,Apple Silicon GPU)/ cpu */
  device?: 'mps' | 'cpu';
  /** 输入视频来源(素材/镜头产物连线直通,渲染层写入) */
  inputVideoFrom?: { nodeId: string };
  /** 输入视频 Asset id(手动绑定,与连线二选一) */
  inputAssetId?: string;
  /** 最近一次运行的产物时长(秒;ffprobe 探测回写,时间线/回看用) */
  durationSec?: number;
  /** 最近一次运行的产物宽高(ffprobe 探测回写) */
  width?: number;
  height?: number;
  /** 上次运行实际执行的阶段摘要(检查器/工具卡展示「做了哪几步」) */
  appliedStages?: string[];
  /** 🆕 提示词来源追溯(占位,保持结构一致) */
  promptFrom?: PromptSource;
}

/** 视频增强请求(video-upscale IPC / video-upscale 节点提交;与 VideoUpscaleParams 同口径) */
export interface VideoUpscaleRequest {
  /** 输入视频绝对路径(须在允许目录内:产物/资产/项目目录) */
  inputPath: string;
  /** 发起该任务的节点 id(进度事件按此关联到画布节点;缺省不影响执行) */
  nodeId?: string;
  /** 放大倍数(缺省 2) */
  scale?: number;
  superRes?: VideoUpscaleParams['superRes'];
  /** SeedVR2 仓库 id / 别名(缺省 3B 8bit) */
  seedvrModel?: string;
  srModel?: VideoUpscaleParams['srModel'];
  faceModel?: VideoUpscaleParams['faceModel'];
  faceWeight?: number;
  fidelityWeight?: number;
  deblock?: boolean;
  deblockCrf?: number;
  crf?: number;
  device?: 'mps' | 'cpu';
  /** 输出文件名前缀(缺省取输入文件基名);实际文件名 = <前缀>-post-<时间戳>.mp4 */
  outputName?: string;
}

/** 视频增强结果 */
export interface VideoUpscaleResult {
  ok: boolean;
  path?: string;
  error?: string;
  /** 实际执行的阶段摘要(如 ['去块', 'Real-ESRGAN ×2', 'GFPGAN 修脸']) */
  stages?: string[];
  /** 产物元数据(ffprobe 探测) */
  width?: number;
  height?: number;
  durationSec?: number;
  /** 处理耗时(秒,墙钟) */
  elapsedSec?: number;
}

/** 视频增强阶段进度事件(主进程 → 渲染层 push;长任务期间驱动 badge/进度条) */
export interface VideoPostProgressEvent {
  /** 节点 id(渲染层据此定位到具体节点;同一时刻全局只有一个后处理任务) */
  nodeId: string;
  /** 当前阶段名(人读,如「修脸」「超分」「去块」) */
  stageLabel: string;
  /** 阶段内细节(如「40/124 帧(32%)· 已 52s / 预计剩 1min50s」);无则为空串 */
  detail?: string;
  /** **整体**进度 0-1(按各阶段预估耗时加权,跨阶段单调递增,不会从 100% 退回 0) */
  overall: number;
  /** 当前阶段进度 0-1;不确定(不打印进度的阶段)时为 undefined → UI 用滚动动画 */
  stageProgress?: number;
  /** 已执行/计划执行的阶段清单(UI 可展示 N/M) */
  stagesDone: number;
  stagesTotal: number;
}

/** 正在运行的视频增强任务(主进程真源)。
 *  渲染层用它恢复「运行中」UI 状态 —— 否则退出画布再进入时本地 state 丢失,
 *  会错误地允许对正在跑的节点重复发起(真实反馈)。 */
export interface VideoPostRun {
  nodeId: string;
  startedAt: string;
  /** 最近一次进度阶段(给人读) */
  stage?: string;
}

/** 视频增强工具链就绪状态(检查器提示 / 提交前防呆) */
export interface VideoPostTooling {
  /** Real-ESRGAN 入口可执行(~/.bin/realesrgan 或 realesrgan-ncnn-vulkan) */
  realesrgan: boolean;
  /** Real-ESRGAN 入口路径(探测到的) */
  realesrganPath?: string;
  /** face_fix_video.py 脚本存在 */
  faceFixScript: boolean;
  faceFixPath?: string;
  /** 修脸用 Python 解释器(venv)存在 */
  python: boolean;
  pythonPath?: string;
  /** GFPGAN 主权重存在 */
  gfpganWeight: boolean;
  /** CodeFormer 权重存在 */
  codeformerWeight: boolean;
  /** ffmpeg / ffprobe 可用 */
  ffmpeg: boolean;
  /** mlxgen CLI 可执行(SeedVR2 视频超分) */
  mlxgen?: boolean;
  mlxgenPath?: string;
  /** 默认 SeedVR2 3B 8bit 权重已在 HF 缓存 */
  seedvr2?: boolean;
  /** 缺失项人读摘要(空数组 = 全部就绪) */
  missing: string[];
}

/**
 * 镜头模型包配置(加速 / 风格,二者互斥 —— 都是替换 `h3 -d` 的模型目录,一个镜头只能用一个包)。
 * h3.c CLI 不接受 --lora;「LoRA」一律离线融合成完整模型目录后换 -d:
 *  - 加速包 = 蒸馏模型目录(turbo)+ 少步数(4/8 步),见 docs/MiniMax-H3-加速-LoRA-使用手册.md §8;
 *  - 风格包 = 风格 LoRA 融合目录(如 MiniMax-H3-mystic)+ 正常步数(20/30),**不省时间**。
 */
export interface ShotAccel {
  /** 本镜头是否启用模型包 */
  enabled?: boolean;
  /** 使用的模型包 id(设置页 accelPacks);缺省 = 默认包 */
  packId?: string;
  /** 步数:加速包 4(边缘略糊)/ 8(质量甜点,推荐);风格包 20/30(融合权重需正常步数) */
  steps?: number;
}

/** h3 模型包类型:accel=蒸馏加速包(turbo,4/8 步) / style=风格 LoRA 融合包(mystic 等,正常步数) / style-accel=风格+加速双融合包(mystic-turbo,4/8 步提速且带画风) */
export type AccelPackKind = 'accel' | 'style' | 'style-accel';

/** h3 模型包(设置页安装/管理;仅登记,不删磁盘)。`kind` 缺省 = 'accel'(兼容存量数据) */
export interface AccelPack {
  id: string;
  name: string;
  /** 可传给 `h3 -d` 的模型目录(至少含 FL2VA/ 或 Ref2VA/ 变体) */
  path: string;
  /** 推荐步数档(accel:4|8;style:20|30) */
  steps?: number;
  /** 包类型;缺省(老数据无此字段)= 'accel' */
  kind?: AccelPackKind;
  /** 是否默认包(镜头启用模型包未选包时用) */
  default?: boolean;
  installedAt?: string;
  /** 列表时主进程回填:目录当前是否存在且含至少一个 h3 变体(存在但无变体视为 invalid) */
  exists?: boolean;
  /** 目录实际可用的 transformer 变体;旧版根目录 model_index.json 无法判定时缺省 */
  targets?: Array<import('./style-model').H3TransformerTarget>;
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
  /** 🚀 模型包:开启则提交时换用所选包目录(-d)+ 包步数(见 ShotAccel;accel 加速 / style 风格互斥) */
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
  /** 视频帧率(fps)—— 导入时 ffprobe 探测,历史资产缺省(检查器按需补探) */
  fps?: number;
  /** 视频内嵌音轨采样率(Hz) */
  sampleRate?: number;
  /** 视频内嵌音轨声道数 */
  channels?: number;
  /** 归属项目;缺省 = 总资源库(全局共享) */
  projectId?: string;
  /** 分类 id(资产库分类字典);缺省 = 未分类 */
  categoryId?: string;
  /** 入库来源:手动导入 / 对话附件 / 画布产物归档 */
  source?: 'import' | 'attachment' | 'product';
  /** 来源节点 id(仅 source='product',用于反查画布引用与定位) */
  originNodeId?: string;
  tags: string[];
  /**
   * 资源文案:用户手写提示词,或 vision.caption 反推落盘的描述。
   * 画布资源节点经 canvas.get_node / assets.get 可读;Agent 据此理解画面而不必每轮重看图。
   */
  caption?: string;
  /** 软删除标记(进回收站);list / list(projectId) 不再返回 */
  deletedAt?: string;
  createdAt: string;
}

/** 资源更新补丁(重命名 / 文案 / 分类 / 归属 / 标签) */
export type AssetUpdatePatch = {
  name?: string;
  /** 传空字符串 = 清空文案 */
  caption?: string | null;
  categoryId?: string | null;
  projectId?: string | null;
  tags?: string[];
};

/** 媒体类型(资源节点检查器「媒体信息」面板据此决定显示哪些字段) */
export type MediaKind = 'image' | 'video' | 'audio' | 'document';

/**
 * 媒体基本信息探测结果(主进程 ffprobe → 资源节点检查器)。
 *
 * 为什么是**按需探测**而不是直接读资产字段:历史资产(2026-09 之前导入)的
 * assets.json 里根本没有 fps / 采样率这些字段,改代码不会让它们长出来;
 * 检查器选中节点时现探一次,新旧资产一视同仁。
 *
 * `ok:false` 时只有 `error` 有意义 —— 调用方应把它显示出来,而不是假装「无信息」
 * (「文件不存在」和「ffprobe 没装」必须能被区分)。
 */
export interface MediaInfo {
  ok: boolean;
  /** 文件名(探测结果的展示标题;调用方也可忽略改用自己的标题) */
  name?: string;
  /** 真实媒体类型:以容器里实际存在的流为准,可能覆盖调用方按扩展名的推断 */
  kind?: MediaKind;
  /** 失败原因(ok=false 时有值) */
  error?: string;

  /* ── 通用 ── */
  /** 文件大小(字节) */
  sizeBytes?: number;
  /** 时长(秒)—— 视频/音频 */
  durationSec?: number;
  /** 码率(kbps) */
  bitrateKbps?: number;
  /** 容器格式(ffprobe format_name,如 `mov,mp4,m4a,3gp,3g2,mj2`) */
  container?: string;

  /* ── 画面(图片 / 视频) ── */
  width?: number;
  height?: number;
  /** 帧率(视频);图片为 undefined */
  fps?: number;
  /** 总帧数(容器未记录时为 undefined) */
  frameCount?: number;
  /** 视频编码(如 h264 / hevc);图片为 ffprobe 报的图片编码(如 png) */
  videoCodec?: string;
  /** 旋转角(竖拍视频为 90/270;展示用宽高已按此互换) */
  rotation?: number;

  /* ── 声音(音频资源 / 视频内嵌音轨) ── */
  /** 视频是否带音轨(false 时下游参考视频不会带声音) */
  hasAudio?: boolean;
  audioCodec?: string;
  /** 采样率(Hz) */
  sampleRate?: number;
  /** 声道数 */
  channels?: number;
  /** 声道布局(mono / stereo / 5.1 …) */
  channelLayout?: string;
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
  /**
   * 封面来源:
   *  - `'auto'`(缺省)= 自动跟随「画布第一个产图节点」的产物(图片优先,视频抽首帧兜底)
   *  - `'manual'` = 用户手动上传的封面,存 `coverAssetId`;新生成产物不再改封面
   *
   * 缺省(老项目文件无此字段)一律按 `'auto'` 处理 —— 历史项目升级后立刻拿到真封面,
   * 而不是继续显示占位图。
   */
  coverMode?: 'auto' | 'manual';
  /**
   * 手动封面的**资产 id**(仅 `coverMode='manual'` 时有意义)。
   *
   * 为什么不直接存路径:本应用的图片要经 `bba-asset://` 协议显示,而该协议只认资产库
   * 文件名(`asset-*.<ext>`,见 main/index.ts 的协议白名单)。上传的封面照常登记为一条
   * **项目资源**,渲染层用现成的 `thumbSrc(asset.localPath)` 就能显示,零新增协议白名单。
   */
  coverAssetId?: string;
  createdAt: string;
  updatedAt: string;
  /** 项目下的画布 id 列表(新模型:一个项目可有多画布,M1+;空数组表示还没画布) */
  canvasIds: string[];
  /** 当前活动画布 id(进入项目时默认打开的画布) */
  activeCanvasId: string;
}

/**
 * 项目封面解析结果 —— **主进程算好给渲染层**(谁也别在前端拼路径判存在性)。
 *
 * 主进程才有磁盘视野(`existsSync`)与画布快照,渲染层只需按 `path` + `isVideo` 渲染。
 */
export interface ProjectCover {
  projectId: string;
  mode: 'auto' | 'manual';
  /** 绝对本地路径;null = 该项目还没有任何可用封面(渲染层显示占位图) */
  path: string | null;
  /** 是否视频(渲染层要抽首帧,不能直接塞 <img>) */
  isVideo: boolean;
  /** 自动封面取自哪个节点(UI 提示用;手动封面为 null) */
  sourceNodeId: string | null;
  /** 手动封面失效等异常说明;正常为 null */
  error?: string | null;
}

/** 画布视口(平移 + 缩放):随画布快照持久化,退出/重进恢复上次看到的位置 */
export interface CanvasViewport {
  /** 世界坐标原点在舞台内的屏幕偏移(px) */
  x: number;
  y: number;
  /** 缩放比例(1 = 100%;UI 钳制在 0.4–1.3) */
  z: number;
}

/**
 * 画布节点分组 —— 一组被命名的节点,整体拖动/删除/复制。
 *
 * 与「多选」的区别:多选是一次性临时集合(松手即散),组是**持久化**的整体。
 * 组不写进 CanvasNode 而是独立成数组,单点真源 = members:
 * 节点增删不必维护反向索引,删节点后由渲染层 pruneGroups 统一清脏 id。
 */
export interface CanvasNodeGroup {
  id: string;
  name: string;
  /** 成员节点 id(顺序 = 入组顺序;拖动整组时按此算包围盒) */
  members: string[];
  /** 组色(设计 token 语义名;缺省 neutral) */
  tone?: 'neutral' | 'accent' | 'success' | 'warn';
  createdAt: string;
}

/** 单个画布的快照(节点 + 连线);持久化在 canvases-${projectId}.json 中 */
/**
 * 画布快照保存选项(`BigBotArtApi.saveCanvasSnapshot` 第二参数)。
 *
 * 为什么需要:`ProjectStore.saveCanvasSnapshot` 有「0 节点不许覆盖有节点的画布」这条最后防线
 * (2026-09-22 未装填 flush 抹掉整张画布的事故)。但**用户删掉最后一个节点**时 0 节点是合法结果,
 * 必须由调用方显式声明 —— 于是有了这个开关。渲染层只在「本地已装填该画布且是内容改动触发」时传 true。
 */
export interface CanvasSaveOptions {
  /** 明确「这次清空是用户编辑的合法结果」,放行 0 节点快照 */
  allowEmpty?: boolean;
}

export interface CanvasSnapshot {
  /** 画布 id,全局唯一;通过 projectId 字段归属项目 */
  id: string;
  projectId: string;
  name: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /**
   * 节点分组(旧项目文件缺省 = 空数组;读入时剔除脏成员 id 与空组)。
   * 可选字段,老渲染层忽略它也能正常打开画布。
   */
  groups?: CanvasNodeGroup[];
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
  /** 提交来源(RenderRequest.source 透传):'agent' 提交的任务完成后可触发 Agent 自动续跑 */
  source?: 'agent' | 'user';
  /** 🆕 Agent 会话 id(RenderRequest.threadId 透传;自动续跑用) */
  threadId?: string;
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
  /**
   * 🆕 内置技能的**出厂正文指纹**(仅 builtin 技能有;用户自建技能为空)。
   *
   * 用途:区分「用户改过正文」与「出厂内容已升级」——这两者从正文本身看不出来。
   * 启动时的种子合并据此决定要不要把新版出厂正文写回:
   *   - 当前 instructions 与 fingerprint 一致 ⇒ 用户没动过 ⇒ **安全升级**为新版出厂正文;
   *   - 不一致 ⇒ 用户编辑过 ⇒ **尊重用户,一律不覆盖**。
   *
   * 为什么必须引入它(2026-10-09 事故):此前合并器只补缺失技能、从不更新已有技能,
   * 于是修好内置技能正文(如 3D 短片的 h3 能力表)对**老用户完全无效** ——
   * 源文件改对了、应用重启了,skills.json 里还是旧内容,改了等于没改。
   * 用「与出厂逐字比对」硬判「是否被编辑过」也不可靠:出厂内容一升级,比对必然不等,
   * 会把所有老用户误判成「编辑过」而永远失去更新。
   */
  builtinFingerprint?: string;
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

/** 外观主题偏好(设置页「通用 › 外观」;缺省 system=跟随系统) */
export type ThemePref = 'system' | 'light' | 'dark';

/** 应用设置(全局,持久化 ~/.bigbotart/settings.json) */
export interface AppSettings {
  /** 全局默认 LLM 来源(设置页),项目级覆盖优先 */
  llm?: LlmSource;
  /** 渲染模式:demo=始终 mock 占位;real=引擎就绪则真实推理 */
  renderMode: 'demo' | 'real';
  /** 界面语言(默认 zh-CN;en 为增量覆盖,缺译回退中文) */
  language?: 'zh-CN' | 'en';
  /**
   * 外观主题:system=跟随 OS / light / dark。
   * 主进程经 `nativeTheme.themeSource` 生效;渲染层 CSS 只认 `prefers-color-scheme`。
   * 缺省或非法值按 system(老 settings.json 无此字段无需迁移)。
   */
  theme?: ThemePref;
  /** h3 视频生成:SSD 流式读权重(--ssd-streaming)。省 RAM(峰值≈6GB)但慢约 30%;64GB+ 默认关更快 */
  ssdStreaming?: boolean;
  lmStudioModel?: string;
  /** 默认档位:时间线/生成默认 tier */
  defaultTier?: QualityTier;
  /** 🚀 h3 模型包库(设置页安装/管理;h3.c -d 用的模型目录,非 .safetensors;kind=accel 加速 / style 风格) */
  accelPacks?: AccelPack[];
  /**
   * 预置包 v2 迁移标记(2026-10):v2 起 PRESEED 新增 style 包(MiniMax-H3-mystic)。
   * 老库的 accelPacks 已存在 ⇒ ensureSeeded 不会重跑,需要一次性把 v2 新预置**追加**进去;
   * 此标记为 true 表示迁移已做过 —— 用户之后删除 mystic 不会被复活(只迁一次)。
   */
  accelPreseedV2?: boolean;
  /**
   * 预置包 v3 迁移标记(2026-10-13):v3 起 PRESEED 新增 style-accel 双融合包
   * (MiniMax-H3-mystic-turbo = mystic 画风 + turbo 提速融进同一目录,推荐 8 步)。
   * 与 v2 同口径:只迁一次,用户删除不复活。
   */
  accelPreseedV3?: boolean;
  /**
   * 🚀 新建 shot 是否默认开启加速 LoRA(设置页「加速 LoRA › 默认开启」)。
   *
   * 与 accelPacks[].default 的区别(两者容易混):
   *   - `accelPacks[].default` = **用哪个包**(packId 缺省时的选择);
   *   - `accelDefaultEnabled`  = **开不开加速**(决定 shot.data.accel 是否被写入)。
   * 缺省/未设置 = false(存量行为不变:不主动开,由用户或 Agent 逐镜开启)。
   *
   * 写入点只有两处,口径必须一致:渲染层「+」弹层建 shot 与 Agent storyboard.materialize。
   */
  accelDefaultEnabled?: boolean;
  /** 云端供应商目录(凭据存钥匙串,这里只有 hasKey 标记) */
  cloudProviders?: CloudProviderEntry[];
  /** 🆕 工具模型绑定(设置页「工具模型」;缺省走 DEFAULT_TOOL_MODELS / vision env 回退链) */
  toolModels?: ToolModelBinding;
  /**
   * 网页远程访问。缺省视为关闭;老 settings.json 无此字段,不需要迁移。
   * 只放开关、端口和中继地址。口令哈希在 remote-access.json,配对密钥另存,都不进 getSettings()。
   */
  remoteAccess?: RemoteAccessSettings;
}

/** 远程访问默认端口(设置页未填时) */
export const DEFAULT_REMOTE_PORT = 47321;

/** 远程访问的非秘密设置。enabled 缺省 = 关。配对密钥不在这里。 */
export interface RemoteAccessSettings {
  enabled?: boolean;
  port?: number;
  /** 自建中继。开启后即使没有 Tailscale 也在 127.0.0.1 监听,供隧道回连。 */
  relayEnabled?: boolean;
  /** 例如 https://art.example.com ,不要带路径。 */
  relayUrl?: string;
}

/** 中继隧道状态。只有 hasPairingKey,没有密钥本身。 */
export interface RelayTunnelStatus {
  enabled: boolean;
  url: string;
  connected: boolean;
  hasPairingKey: boolean;
  error?: string;
}

/** 桌面设置页展示的监听状态。永不包含口令明文、哈希或配对密钥。 */
export interface RemoteAccessStatus {
  enabled: boolean;
  port: number;
  listening: boolean;
  urls: string[];
  hasPassphrase: boolean;
  /** out/renderer 是否存在。没有构建产物时页面打不开,RPC 仍可按开关监听。 */
  pageReady: boolean;
  /** 未在监听时的原因(未开启 / 未设口令 / 未检测到 Tailscale / 端口被占用) */
  error?: string;
  relay: RelayTunnelStatus;
}

/**
 * 工具模型绑定 —— 按能力指定默认模型(2026-09-29 v1)。
 * 解析逻辑与兜底表在 packages/shared/src/tool-models.ts。
 */
export interface ToolModelBinding {
  /** 生成类能力的模型(repoId / 本地目录路径 / 别名);不填 = DEFAULT_TOOL_MODELS */
  image?: Partial<Record<string, string>>;
  /**
   * 看图反推(vision.caption)的模型来源。
   * 不填 = 既有回退链:BIGBOTART_VL_* env → 主 LLM env → 本地默认。
   * ⚠️ 不是「继承 settings.llm」——主 LLM 往往无视觉能力,静默继承会把看图
   *    指向一个看不懂图的端点(设计见方案文档 §3.1 / §4.2.1)。
   */
  vision?: LlmSource;
  /**
   * 看图反推的**本地引擎通道**(2026-10,mlx-gen 新增 `mlxgen-caption`)。
   *
   * 与 `vision`(OpenAI 兼容端点,要 LM Studio 之类 server 在跑)**二选一**;
   * 同时存在时本地通道优先。不填 = 走 auto:本机有 MLX 格式 Qwen3-VL checkpoint
   * 且命令可用时优先本地,否则回退端点链(存量行为不变)。
   * 解析与执行见 apps/desktop/src/main/mlxgen-caption.ts。
   */
  captionLocal?: CaptionLocalBinding;
}

/**
 * 本地看图通道绑定(mlxgen-caption)。
 * `model` 留空 = 主进程自动发现(LM Studio 模型库 / ~/ai/models 下的 MLX Qwen3-VL)。
 */
export interface CaptionLocalBinding {
  /** 本地 checkpoint 目录绝对路径,或已下载的 HF repo id */
  model?: string;
  /** 图片 token 预算上限(引擎 `--max-pixels`,默认 640000 ≈ 800x800) */
  maxPixels?: number;
  /** 生成长度上限(引擎 `--max-tokens`,默认 1024) */
  maxTokens?: number;
}

/** 资产导入结果 */
export interface AssetImportResult {
  assets: Asset[];
  failed: Array<{ name: string; error: string }>;
  /** 用户在系统对话框里取消选择 */
  canceled?: boolean;
}

/* ═══ Agent 会话 / 记忆体系(画布页 Agent 对话) ═══ */

/**
 * Agent 会话(同一画布可有多条;活跃指针在 CanvasMemory.activeThreadId)。
 * 会话只隔离对话记忆,画布节点/技能仍共用 —— 详见 docs/Agent历史聊天-产品设计与技术方案.md。
 */
export interface ChatThread {
  id: string;
  canvasId: string;
  /** 展示名;空则 UI 用首条用户消息生成 */
  title: string;
  /** 可选:从哪次会话派生而来 */
  parentThreadId?: string;
  /** /compact 结果(会话级;取代画布级 conversationSummary) */
  conversationSummary?: string;
  createdAt: string;
  updatedAt: string;
  /** 软删时间;有值则列表默认隐藏 */
  archivedAt?: string;
}

/** 会话列表项(list IPC 返回;含预览等派生字段,不落盘) */
export interface ChatThreadListItem extends ChatThread {
  /** 最近一条 user/assistant 正文截断 */
  preview?: string;
  /** 是否有压缩摘要 */
  hasCompact?: boolean;
  /** 是否当前活跃 */
  active?: boolean;
}

/** 对话 Agent 的一项任务(整表替换;同时至多一项 in_progress) */
export type AgentTodoStatus = 'pending' | 'in_progress' | 'completed';

export interface AgentTodoItem {
  content: string;
  status: AgentTodoStatus;
}

/** 已交给用户、尚未点头的多镜计划 */
export interface PendingShotPlan {
  /** 提交计划时的未出片镜头 id(已排序) */
  shotIds: string[];
  markdown: string;
}

/** 单画布记忆:节点总结(切换画布时写入)+ 对话压缩摘要(/compact 生成,注入当前会话上下文) */
export interface CanvasMemory {
  summary: string;
  nodeCount: number;
  lastActive: string;
  keyDecisions: string[];
  /**
   * @deprecated 迁移后读 ChatThread.conversationSummary;存量兼容只读兜底
   * /compact 生成的对话压缩摘要(注入当前画布上下文,压缩后仍保留全局脉络)
   */
  conversationSummary?: string;
  /** 🆕 当前画布激活的 Agent 技能 id(对话自动注入该技能指令段;同一画布至多一个) */
  activeSkillId?: string;
  /**
   * 激活技能时用户在 Skills 页填入的参数值(键为 `{name}` 或裸名)。
   * buildContext 注入指令前替换占位;停用技能时一并清除。
   */
  activeSkillParams?: Record<string, string>;
  /** 🆕 当前活跃会话 id;缺省则用该画布唯一/默认 thread */
  activeThreadId?: string;
  /** 当前画布的任务清单(todo.write 整表替换;每轮注入系统提示) */
  todos?: AgentTodoItem[];
  /** 多镜真跑前交给用户确认的计划;点头后清空 */
  pendingShotPlan?: PendingShotPlan;
  /** 用户已点「按此执行」的未出片镜头 id */
  approvedShotIds?: string[];
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
  /** 🆕 会话清单(按 id);消息仍在 recall 扁平数组里用 threadId 归属 */
  threads?: Record<string, ChatThread>;
  /** 全部对话消息(可检索) */
  recall: RecallMessage[];
  /** 归档记忆(长期事实:生成产物/关键决定/资产备注) */
  archival: ArchivalEntry[];
  /** 会话迁移标记(chatThreadsV1);有则不再重跑迁移 */
  migration?: { chatThreadsV1?: boolean };
}

export interface RecallMessage {
  id: string;
  canvasId: string;
  /** 🆕 所属会话;缺省 = 迁移前的「画布默认会话」 */
  threadId?: string;
  /** system = 工具成功后的动作记录(人类可读,随最近消息注入下一轮上下文) */
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  /** role=tool 时的工具名与参数 */
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  /** 工具执行结果摘要(role=tool) */
  toolResult?: string;
  /** role=user 时,本轮随消息附带的画布选中节点(渲染层回显「关注节点」徽标;可选,旧记录无此字段) */
  selectedNodeId?: string;
  selectedNodeTitle?: string;
  /** role=user 时,本轮随消息附带的**多个**关注/引用节点(2026-10 多引用;与上面单值字段并存,旧记录无此字段) */
  selectedNodeIds?: string[];
  selectedNodeTitles?: string[];
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
  /** 本轮引用的多个节点 id(2026-10:右键「添加到聊天窗口」+ 输入框 @ 提及,可多个并存;
   *  与 selectedNodeId 并存兼容旧调用方;两者都给时合并去重) */
  selectedNodeIds?: string[];
  /** 🆕 目标会话;缺省用画布 activeThreadId(渲染层应显式传入,避免竞态) */
  threadId?: string;
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
  /**
   * 批次1 任务化:主进程收到请求即返回 `accepted: true`(此时本轮尚未跑完),
   * 真正的结果经 AgentEvent `done` / `failed` 推送。
   * 渲染层据此把「发送中」切成「执行中」,而不是继续 await。
   */
  accepted?: boolean;
  /** 执行体已推送 done/failed;调用方收到该回执时不得再次 settle,避免旧轮终局误伤新一轮 */
  settledByEvent?: boolean;
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
  /**
   * `done` / `failed` 是**终局事件**(批次1 任务化):agent-chat 不再 await 到底,
   * 收到请求即返回 {ok:true, accepted:true},真正的结果经事件推送。
   * 这样长任务(反推提示词等 11 轮 / 5 分钟以上的链路)不再被请求超时误杀成「假失败」。
   */
  kind: 'tool-start' | 'tool-end' | 'thinking' | 'aborted' | 'continuity' | 'done' | 'failed' | 'auto-start' | 'round-start' | 'text-delta' | 'thinking-delta';
  /** worker 流式通知的稳定 id(requestId:seq);渲染层据此精确去重,不按内容猜重复 token */
  eventId?: string;
  projectId: string;
  canvasId: string;
  /** 🆕 所属会话;渲染层过滤「事件属于当前展示的会话」,避免切走后旧 done 污染新会话 UI */
  threadId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  ok?: boolean;
  result?: string;
  nodeId?: string;
  issues?: string[];
  /** 自动续跑(auto-start):渲染层据此把面板切入「执行中」并展示说明(如「生成完成 · Agent 自动推进中…」) */
  note?: string;
  /** 流式模型轮次(round-start)与正文/思考增量(text-delta/thinking-delta) */
  round?: number;
  /** 增量所属的 assistant content 块;不同块可交错,渲染层按此序号有序聚合 */
  contentIndex?: number;
  delta?: string;
  /** 终局(done):本轮最终结果,字段语义与 AgentChatResponse 一致 */
  final?: AgentChatResponse;
  /** 终局(failed):失败原因(带已完成工具摘要,便于判断画布改动是否已生效) */
  error?: string;
}