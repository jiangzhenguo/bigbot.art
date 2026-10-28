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
  | 'image.multiReference' // Klein 多参考生成(flux2.multi-reference · 首图定构图;仅节点显式选 Klein 时走)
  | 'image.img2img' // 图生图(image-edit mode=img2img,latent)
  | 'image.instruction' // 指令/参考编辑(edit-reference;image-edit 默认,也是 image-gen 带 ref-image 的默认路径)
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
  'image.multiReference': 'AbstractFramework/flux.2-klein-9b-8bit', // 唯一无上限 multi-reference(首图定构图);非「连参考图」默认
  'image.img2img': 'AbstractFramework/z-image-turbo-8bit',
  'image.instruction': 'Qwen/Qwen-Image-2.1', // qwen21.edit 1-10 张;image-gen 带 ref-image 默认也用这条
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
  // Qwen-Image-2.1 Uncensored(社区 8bit,mlx-gen 本地转换包,2026-10 接入):
  // text_encoder 为纯语言塔(0 个 visual.* 张量,转换时刻意丢弃 vision tower 省体积),
  // 能力与历史 8bit 导出同档:qwen21.text + qwen21.latent,**没有** qwen21.edit 参考编辑。
  // 故只有文生图 + latent 图生图;多参考/指令编辑/inpaint/outpaint 全部没有。
  'Qwen-Image-2.1-Uncensored-MLX': ['image.generate', 'image.img2img'],
  // Qwen-Image-2.1-Turbo(2026-10 接入):2.1 的 8 步蒸馏版,采样表内置于 checkpoint
  // (model_index.json 的 sample_sigmas,引擎原样使用,--steps 被锁成 8)。
  // 全量 checkpoint 带 vision tower(text_encoder 750 张量含 351 个 visual.*)→ 参考编辑可做,
  // 能力面与 bf16 相同;与 Uncensored(纯语言塔)截然相反。
  'Qwen/Qwen-Image-2.1-Turbo': ['image.generate', 'image.img2img', 'image.instruction'],
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
  // Uncensored 本地包:repoId 即目录名(自映射);本地绝对路径按 basename 命中此条
  'qwen-image-2.1-uncensored': 'Qwen-Image-2.1-Uncensored-MLX',
  'Qwen-Image-2.1-Uncensored-MLX': 'Qwen-Image-2.1-Uncensored-MLX',
  // Turbo(2.1 的 8 步蒸馏):短别名与本地目录名 → 官方 repoId
  'qwen-image-2.1-turbo': 'Qwen/Qwen-Image-2.1-Turbo',
  'qwen-2.1-turbo': 'Qwen/Qwen-Image-2.1-Turbo',
  'qwen-image-21-turbo': 'Qwen/Qwen-Image-2.1-Turbo',
  'Qwen-Image-2.1-Turbo': 'Qwen/Qwen-Image-2.1-Turbo',
};

/** 该模型是否支持某能力(查询前先归一化;未知模型一律 false,由提交层防呆兜底) */
export function supportsCapability(model: string, cap: ImageCapability): boolean {
  const id = normalizeModelId(model);
  return (MODEL_CAPABILITIES[id] ?? []).includes(cap);
}

/**
 * 节点 kind + 可选编辑 mode → 能力 key(纯函数;三方共用的关键接缝)。
 * - image-gen:无参考图 → 文生图;有 ref-image → **参考编辑**(image.instruction → 默认 2.1)
 *   ⚠️ 不是 image.multiReference。引擎里 multi-reference = Klein「首图定构图」,
 *   与 2.1 的 edit-reference(指令驱动多图)是两条能力行;连参考图的常见意图是后者
 *   (2026-10-22 口径纠正)。要走 Klein multi-reference 须节点显式选 flux.2-klein。
 * - image-edit:按 mode 细分;未知 mode 回退 instruction(与 Provider 缺省同口径)
 * - 纯 ffmpeg 节点 / 视频节点:undefined(无模型可选)
 */
export function capabilityOf(kind: NodeKind | string, mode?: string, hasRefImages = false): ImageCapability | undefined {
  switch (kind) {
    case 'image-gen':
      return hasRefImages ? 'image.instruction' : 'image.generate';
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

/**
 * 带参考图时纠正不兼容模型(2026-10-28「静帧 05」事故)。
 *
 * 背景:设置页 `image.generate` 常绑 Uncensored(纯文生图、无 vision tower)。
 * image-gen 节点若被显式写下该模型(或曾按无参考图解析后粘住),再连上 ref-image
 * 仍会原样提交 → provider 入队后才拒「纯文生图不能带参考图」。Agent 只看到
 * 「已提交」,失败后不会改模型、只会重复 engine.submit → 白烧队列。
 *
 * 规则:有参考图时,模型必须支持 `image.instruction`(2.1 edit)或
 * `image.multiReference`(Klein);否则换成 instruction 缺省(工具模型 > 内置 2.1)。
 * 调用方应把纠正后的 model 写回节点,清掉粘住的坏值。
 */
export function healModelForRefImages(
  model: string | undefined,
  hasRefImages: boolean,
  toolModels?: ToolModelBinding,
): { model: string | undefined; healed: boolean; from?: string } {
  const cur = String(model ?? '').trim();
  if (!hasRefImages) return { model: cur || undefined, healed: false };
  if (
    cur &&
    (supportsCapability(cur, 'image.instruction') || supportsCapability(cur, 'image.multiReference'))
  ) {
    return { model: cur, healed: false };
  }
  const next = resolveImageModel(toolModels, 'image.instruction');
  if (!next || next === cur) return { model: cur || next, healed: false };
  return { model: next, healed: true, from: cur || '(空)' };
}

/**
 * 文生图的缺省采样步数(按模型;2026-10-14「Turbo 默认步数应为 8」修复)。
 *
 * 背景:节点创建时曾把 `steps: 24` 写死进 data(审计 §4.1.1 同款错误)——
 * 于是「节点没显式选步数」与「用户就是要 24 步」无法区分,Turbo(8 步蒸馏,
 * 采样表内置于 checkpoint、引擎锁 8 步)拿到的永远是 24,UI 与日志都在说谎。
 * 现在节点创建**不写 steps**,缺省值全部走这里:
 *  - Qwen-Image-2.1-Turbo → 8(引擎反正锁 8,UI 必须说真话)
 *  - Qwen-Image-2.1 其余(bf16 等)→ 40(官方推荐)
 *  - 其它(z-image-turbo 等)→ 24(既有默认,存量行为不变)
 *
 * ⚠️ 判定用与 provider `mlxgen.ts` 相同的正则(本地目录路径也能命中,
 * 如 ~/ai/models/Qwen-Image-2.1-Turbo);provider 的 generate 分支也调本函数,
 * 禁止再抄出第三份表。
 */
export function defaultGenerateSteps(model: string | undefined): number {
  const m = String(model ?? '');
  if (/qwen.*2\.1.*turbo/i.test(m)) return 8;
  if (/qwen.*2\.1/i.test(m)) return 40;
  return 24;
}
