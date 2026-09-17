/**
 * Provider 抽象 — 视频/图片引擎统一接口
 * 接口形状参考 H3Mise VideoProvider 设计(独立实现)。
 * 每个引擎实现:capabilities(能力声明)/ submit / status / result / cancel。
 */

import type { Asset, QualityTier } from './domain.js';

/** 引擎类型 */
export type ProviderId = 'h3c' | 'mlxgen' | 'comfyui' | 'mock';

/** 引擎支持的输入能力声明(前端据此禁用不支持的选项) */
export interface ProviderCapabilities {
  provider: ProviderId;
  /** 支持的任务域 */
  domains: ('video' | 'image-gen' | 'image-edit' | 'image-upscale' | 'llm')[];
  /** 视频:支持的生成模式 */
  videoModes?: H3ModeCap[];
  /** 图片:支持的编辑模式 */
  editModes?: ('instruction' | 'img2img' | 'inpaint' | 'outpaint')[];
  /** 支持的画幅(宽x高) */
  aspectRatios?: string[];
  /** 质量档位 */
  tiers?: QualityTier[];
  /** 支持的模型清单 */
  models?: string[];
  /** 资源提示(内存估算等,给前端防呆) */
  notes?: string[];
}

export interface H3ModeCap {
  mode: string;
  label: string;
  /** 该模式需要的参考角色 */
  refs?: ('first-frame' | 'last-frame' | 'ref-image' | 'ref-audio' | 'ref-video')[];
}

/** Provider 当前健康状态(引导向导用) */
export interface ProviderStatus {
  provider: ProviderId;
  /** installed=true 表示运行时/二进制存在 */
  installed: boolean;
  /** ready=true 表示链路可用(已探测成功) */
  ready: boolean;
  installedPath?: string;
  version?: string;
  error?: string;
  /** 兼容 detail:补充探测信息(供 UI 展示) */
  detail?: string;
  /** 引导向导需要的安装提示 */
  installHint?: string;
  capabilities?: ProviderCapabilities;
}

/** 业务提交意图(Provider 内部转成具体命令) */
export interface RenderRequest {
  /** 请求的引擎(未指定由主进程按槽位/就绪状态路由:优先 h3c/mlxgen,否则 mock) */
  provider?: ProviderId;
  nodeId: string;
  slot: 'video' | 'image';
  /** 归属项目/画布(队列完成后的连续性校验用) */
  projectId?: string;
  canvasId?: string;
  /** 关联的 Take id(由渲染层/主进程生成,任务完成后回写到 Take) */
  takeId?: string;
  /** 语义参数由 Provider 按其能力解释 */
  params: Record<string, unknown>;
  references?: { asset: Asset; role: string; localPath: string }[];
}

export interface RenderJobHandle {
  providerTaskId: string;
}

export interface RenderStatus {
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';
  progress?: number;
  stage?: string;
  error?: string;
  resultPath?: string;
  cost?: { credits?: number; unit?: string };
}

export interface RenderResult {
  path: string;
  meta?: Record<string, unknown>;
}

/** 统一引擎接口 */
export interface Provider {
  readonly id: ProviderId;
  readonly name: string;
  /** 能力/健康探测(不触发付费或重任务) */
  check(): Promise<ProviderStatus>;
  capabilities(): Promise<ProviderCapabilities>;
  submit(req: RenderRequest): Promise<RenderJobHandle>;
  status(handle: RenderJobHandle): Promise<RenderStatus>;
  cancel(handle: RenderJobHandle): Promise<void>;
}

/** 引擎注册表 — 唯一选择渲染后端的地方 */
export interface ProviderRegistry {
  list(): Provider[];
  get(id: ProviderId): Provider | undefined;
  checkAll(): Promise<Record<ProviderId, ProviderStatus>>;
}