/**
 * 工具模型 —— 按能力指定默认模型的**唯一真源**(2026-09-29,v1)
 *
 * 背景:「缺省用哪个模型」此前散在 5 处硬编码(Provider DEFAULT_MODEL_BY_KIND /
 * 检查器兜底 / ModelCombo 清单 / node-mapping 建节点 / 分镜铺节点),口径互不一致。
 * 本模块把它们收敛为一张能力表 + 一张能力矩阵,渲染层 / 主进程 / Agent 三方共用。
 * 设计与实测依据:docs/工具模型选择-产品设计与技术方案.md(矩阵来自
 * docs/evidence/mlxgen-capabilities-*.json 实测)。
 */

import type { NodeKind, ToolModelBinding } from './domain.js';

/** 图片能力 key(按能力而非节点类型:一个节点类型可对应多种能力,一个模型可覆盖多种能力) */
export type ImageCapability =
  | 'image.generate' // 文生图(image-gen 无参考图)
  | 'image.multiReference' // 多参考生成(image-gen 带 ref-image 连线)
  | 'image.img2img' // 图生图(image-edit mode=img2img,latent)
  | 'image.instruction' // 指令编辑(image-edit mode=instruction;2.1 支持 1-10 张参考图)
  | 'image.inpaint' // 局部重绘(image-edit mode=inpaint,需 mask)
  | 'image.outpaint' // 扩图(image-edit mode=outpaint)
  | 'image.upscale'; // 图片超分(image-upscale)

/**
 * 各能力的内置默认模型(决策 2026-09-29)。
 * 读取顺序:节点 data.model(显式)> settings.toolModels.image[cap] > 本表。
 * 老 settings.json 无 toolModels 字段 → 全部走本表 = 存量行为不变。
 */
export const DEFAULT_TOOL_MODELS: Record<ImageCapability, string> = {
  'image.generate': 'AbstractFramework/z-image-turbo-8bit', // 快 · ~11GB(决策 4:保持 turbo)
  'image.multiReference': 'AbstractFramework/flux.2-klein-9b-8bit', // 唯一支持无上限多参考(实测 flux2.multi-reference)
  'image.img2img': 'AbstractFramework/z-image-turbo-8bit',
  'image.instruction': 'Qwen/Qwen-Image-2.1', // 决策 1:qwen21.edit 支持 1-10 张参考图
  'image.inpaint': 'mlx-community/Qwen-Image-Edit-8bit', // 2.1 实测无 mask 能力
  'image.outpaint': 'mlx-community/Qwen-Image-Edit-8bit', // 2.1 实测无 outpaint 能力
  'image.upscale': 'AbstractFramework/seedvr2-3b-8bit',
};

/**
 * 模型 × 能力矩阵(实测填实 2026-09-29,证据 docs/evidence/mlxgen-capabilities-*.json)。
 * 用途:UI 下拉按能力过滤、提交前防呆;**不要**再手工维护第四份同构表。
 */
export const MODEL_CAPABILITIES: Record<string, ImageCapability[]> = {
  'AbstractFramework/z-image-turbo-8bit': ['image.generate', 'image.img2img', 'image.inpaint'],
  'Qwen/Qwen-Image-2.1': ['image.generate', 'image.img2img', 'image.instruction'],
  'mlx-community/Qwen-Image-Edit-8bit': ['image.instruction', 'image.inpaint', 'image.outpaint'],
  'AbstractFramework/flux.2-klein-9b-8bit': [
    'image.generate',
    'image.multiReference',
    'image.img2img',
    'image.instruction',
    'image.inpaint',
    'image.outpaint',
  ],
  'AbstractFramework/seedvr2-3b-8bit': ['image.upscale'],
};

/**
 * 模型标识归一化:repoId / 短别名 / 本地目录路径 → 同一 repoId。
 * 缺陷 A 的根因就是「同一模型三种写法走了不同分支」,所有能力判定必须先过这里。
 * 查不到归一化规则时原样返回(自定义 repoId 由用户自行负责)。
 */
export function normalizeModelId(model: string): string {
  const m = String(model ?? '').trim();
  if (!m) return m;
  if (MODEL_ID_ALIASES[m]) return MODEL_ID_ALIASES[m];
  // 本地目录路径:取末段目录名再查一次(如 /Users/x/ai/models/Qwen-Image-2.1-bf16)
  if (m.includes('/') || m.includes('\\')) {
    const base = m.split(/[\\/]/).filter(Boolean).pop() ?? m;
    if (MODEL_ID_ALIASES[base]) return MODEL_ID_ALIASES[base];
  }
  return m;
}

/** 短别名 / 本地目录名 → repoId(与 providers MODEL_ALIASES / 主进程 KNOWN_MODELS 同批标识) */
const MODEL_ID_ALIASES: Record<string, string> = {
  'z-image-turbo': 'AbstractFramework/z-image-turbo-8bit',
  'qwen-image-2.1': 'Qwen/Qwen-Image-2.1',
  'qwen-2.1': 'Qwen/Qwen-Image-2.1',
  'qwen-image-21': 'Qwen/Qwen-Image-2.1',
  'Qwen-Image-2.1-bf16': 'Qwen/Qwen-Image-2.1',
  'JoyFusionAI/Qwen-Image-2.1-MLX-8bit': 'Qwen/Qwen-Image-2.1', // 历史 8bit 标识,收敛到 bf16
  'qwen-image-edit': 'mlx-community/Qwen-Image-Edit-8bit',
  'Qwen-Image-Edit-8bit': 'mlx-community/Qwen-Image-Edit-8bit',
  'flux2-klein-9b': 'AbstractFramework/flux.2-klein-9b-8bit',
  'flux2-klein-9b-8bit': 'AbstractFramework/flux.2-klein-9b-8bit',
  'seedvr2-3b': 'AbstractFramework/seedvr2-3b-8bit',
};

/** 该模型是否支持某能力(查询前先归一化;未知模型一律 false,由提交层防呆兜底) */
export function supportsCapability(model: string, cap: ImageCapability): boolean {
  const id = normalizeModelId(model);
  return (MODEL_CAPABILITIES[id] ?? []).includes(cap);
}

/**
 * 节点 kind + 可选编辑 mode → 能力 key(纯函数;三方共用的关键接缝)。
 * - image-gen:带 ref-image 连线时是「多参考生成」,否则「文生图」
 * - image-edit:按 mode 细分;未知 mode 回退 instruction(与 Provider 缺省同口径)
 * - 纯 ffmpeg 节点 / 视频节点:undefined(无模型可选)
 */
export function capabilityOf(kind: NodeKind | string, mode?: string, hasRefImages = false): ImageCapability | undefined {
  switch (kind) {
    case 'image-gen':
      return hasRefImages ? 'image.multiReference' : 'image.generate';
    case 'image-edit': {
      const m = String(mode ?? 'instruction');
      if (m === 'img2img' || m === 'inpaint' || m === 'outpaint') return `image.${m}` as ImageCapability;
      return 'image.instruction';
    }
    case 'image-upscale':
      return 'image.upscale';
    default:
      return undefined;
  }
}

/**
 * 缺省模型解析(三级优先级的后两级;节点显式值由调用方先判):
 * settings.toolModels.image[cap] > DEFAULT_TOOL_MODELS[cap]。
 * cap 为 undefined(无模型节点)时返回 undefined。
 */
export function resolveImageModel(
  toolModels: ToolModelBinding | undefined,
  cap: ImageCapability | undefined,
): string | undefined {
  if (!cap) return undefined;
  const v = toolModels?.image?.[cap];
  return v && v.trim() ? v : DEFAULT_TOOL_MODELS[cap];
}
