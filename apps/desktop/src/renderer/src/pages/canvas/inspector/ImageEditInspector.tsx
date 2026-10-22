/**
 * ImageEditInspector — 图片编辑节点检查器(对齐设计稿 ④/⑤/⑥/⑦/⑩)
 * 模式 chips(instruction / img2img / inpaint / outpaint)+ 各自专属参数区:
 *   img2img → 图像强度滑块(→ --i2i-mode latent + --image-strength)
 *   inpaint → 可视化遮罩(拖入 PNG / 框选生成 → 保存为遮罩资产 → --mask-path)
 *   outpaint → 四边 padding(→ --outpaint-padding top,right,bottom,left)
 */
import React, { useEffect, useRef, useState } from 'react';
import type { RenderJob } from '@bigbotart/shared';
import type { CanvasNode } from '../types';
import { ImageTakeSection } from './ImageTakeSection';
import { useTakeResult } from './useTakeResult';
import { ImagePreview } from './ImagePreview';
import { KVSection } from './fields';
import { ModelCombo, matchModel } from './ModelCombo';
import { capabilityOf, resolveImageModel } from '@bigbotart/shared';
import { useToolModels } from '../tool-models-store';
import { GenStatePanel } from './GenState';
import { UpstreamCard, RefImagesCard, resolveRefImages, ImageStrengthField, OutputResolutionField, OutputSizeField, OutpaintPads, MaskField, ActionBar } from './image-ui';
import { previewUrlOf } from '../media';
import { SaveToLibraryButton } from './SaveToLibraryButton';

export interface ImageEditInspectorProps {
  node: CanvasNode;
  setData: (patch: Record<string, unknown>) => void;
  jobs: RenderJob[];
  projectId: string | null;
  nodes: CanvasNode[];
  assetCache: Record<string, string>;
  /** 全量资产清单(校验手填 Asset ID 是否真实存在;缺省 = 跳过敏校验) */
  assetsList?: Array<{ id: string }>;
  runNode: (nodeId: string) => void;
  toastMsg: (m: string) => void;
  onSelectTake?: (t: { id: string; attempt: number; status: string; resultPath?: string }) => void;
  /** 入库后刷新画布侧资产清单 */
  onSaved?: () => void;
}

const MODE_META: Array<{ key: string; label: string; mono: string }> = [
  { key: 'instruction', label: '指令', mono: 'instruction' },
  { key: 'img2img', label: 'I2I', mono: 'img2img' },
  { key: 'inpaint', label: '局部重绘', mono: 'inpaint' },
  { key: 'outpaint', label: '扩图', mono: 'outpaint' },
];

/**
 * 图片编辑默认采样步数。
 *
 * ⚠️ 根因记录(2026-09-29 真实事故「图片编辑不改 step 直接就是 40 步」):
 *   此前这里默认 4,且注释明写「仅作滑块初始值展示——不写回 data」;
 *   而 provider `mlxgen.ts` 的 Qwen-Image-2.1 参考编辑分支又硬兜底 `p.steps ?? 40`。
 *   两套默认互不认识 → **滑块显示 4、实跑 40**,提交参数里压根没有 `steps` 键
 *   (实测 take 存档确认),用户完全无从察觉。2.1 bf16 上 40 步约 4 分钟,
 *   是 6 步版(54-92s)的 6-7 倍耗时。
 *
 * 修法(A 方案,用户 2026-09-29 指定):默认值改 30,且**未设置时显式写回 data**。
 * 硬约束:「滑块显示几步 = 实际跑几步」。provider 侧的 `?? 30` 降级为安全网
 * (历史节点 / Agent 直传 data 未带 steps 时),不再是一套隐藏默认值。
 *
 * ⚠️ 改动本值时必须同步 `packages/providers/src/mlxgen.ts` 参考编辑分支的兜底值
 * (renderer 不能 import providers —— 包边界)。单测 `__tests__/edit-steps-default.test.ts` 锁一致性。
 */
export const DEFAULT_EDIT_STEPS = 30;

/**
 * 按当前模型返回「图片编辑」的缺省采样步数(纯函数,供单测)。
 *
 * Qwen-Image-2.1-Turbo(2026-10 接入):8 步蒸馏,采样表内置于 checkpoint
 * (`model_index.json` 的 `sample_sigmas`,8 项),引擎 `Config` 里
 * `len(sigmas)` 覆盖 `num_inference_steps`、**锁步数=8、忽略 --steps**。
 * 此前检查器一刀切写回 30 → Turbo 节点实跑 30、UI 显示 30,引擎再钳到 8 —
 * 表面「无伤」,但「UI 与日志说真话」破,且 data 里多一个被引擎忽略的字段。
 * 故 Turbo 显式给 8;其余走 DEFAULT_EDIT_STEPS(30)。
 *
 * ⚠️ 判定用与 provider `mlxgen.ts` 相同的正则(本地目录路径也命中);
 * 不调 `isQwen21EditModel` —— 那是 provider 私有 API,renderer 不 import。
 */
export function defaultEditStepsForModel(model: string): number {
  const repo = matchModel(model)?.repoId ?? model;
  if (/qwen.*2\.1.*turbo/i.test(repo)) return 8;
  return DEFAULT_EDIT_STEPS;
}

/**
 * 像素面积预算(`--output-resolution`)的默认值 —— 与 mlx-gen CLI 一致。
 *
 * ⚠️ 改动本值时必须同步 `packages/providers/src/mlxgen.ts`(renderer 不 import providers
 * —— 包边界)与 mlx-gen 的 argparse 默认;单测 `__tests__/edit-output-resolution.test.ts` 锁一致性。
 */
export const DEFAULT_OUTPUT_RESOLUTION = 1024;

/** 可选档位(32 的倍数才合法 —— CLI 会校验 `resolution % 32 == 0`) */
export const OUTPUT_RESOLUTION_STOPS = [512, 768, 1024, 1536, 2048] as const;

/**
 * 是否显示「像素预算」控件(纯函数,供单测)。
 *
 * 只有 **Qwen-Image-2.1 的参考编辑**认这个参数:
 *  - 其它编辑模型(Qwen Image Edit / flux2 / z-image)走各自的 CLI 路由,根本不接受
 *    `--output-resolution`,显示了只会误导用户以为调了有用;
 *  - 也只在 `instruction` 模式(qwen21.edit 路由)下有意义。
 *
 * 判定按 **repoId 正则**而非模型族:与 provider 的 `isQwen21EditModel` 同口径
 * (本地目录路径 / 短别名 / 8bit 历史标识都要能命中)。
 */
export function shouldShowOutputResolution(model: string, mode: string): boolean {
  if (mode !== 'instruction') return false;
  const repo = matchModel(model)?.repoId ?? model;
  return /qwen.*2\.1/i.test(repo);
}

/**
 * 像素预算 → **预测的输出尺寸**(纯函数,供单测与 UI 提示)。
 *
 * 复刻 mlx-gen `QwenImage21LatentCreator.dimensions()`:
 *   w = √(res² × ratio),h = w / ratio,各自取 32 的倍数(向下取整到倍数后至少 32)。
 *
 * ⚠️ `ratio` 必须是**最后一张**参考图的宽高比 —— 这是本次修正的核心事实,
 * 详见 `packages/providers/src/mlxgen.ts` 的 isQwen21Edit 段注释。
 * 拿不到 ratio 时返回 null(UI 不显示预测,而不是编一个数字)。
 */
export function predictOutputSize(
  outputResolution: number,
  ratio: number | null | undefined,
): { w: number; h: number } | null {
  if (!Number.isFinite(outputResolution) || outputResolution < 32) return null;
  if (ratio == null || !Number.isFinite(ratio) || ratio <= 0) return null;
  const w = Math.sqrt(outputResolution * outputResolution * ratio);
  const roundTo32 = (v: number) => Math.max(32, Math.round(v / 32) * 32);
  return { w: roundTo32(w), h: roundTo32(w / ratio) };
}

/**
 * 「最后一张参考图」是谁(纯函数,供单测)。
 *
 * **必须与 provider 的 `--image-paths` 组装顺序逐字对齐**,否则检查器预测的尺寸
 * 和实跑出来的对不上,反而误导用户。provider 侧(`mlxgen.ts` 的 isQwen21Edit 分支):
 *   `qwen21Refs = [inputPath, ...references]`  —— 输入图在前,参考图在后。
 * 所以:
 *   - 有 ref-image → **最后一张是最后一个参考图**;
 *   - 没有 ref-image 但只有 input → 最后一张就是**输入图本身**(此时比例=输入图比例)。
 * 两者都没有 → null(提交会被拦,这里不预测)。
 */
export function lastGeometrySource(args: {
  hasInput: boolean;
  refNodeIds: string[];
}): { kind: 'input' } | { kind: 'ref'; nodeId: string } | null {
  const refs = args.refNodeIds.filter(Boolean);
  if (refs.length > 0) return { kind: 'ref', nodeId: refs[refs.length - 1]! };
  if (args.hasInput) return { kind: 'input' };
  return null;
}

/* ══ 显式输出尺寸(2026-10-08 新增能力) ══
 *
 * 读 mlx-gen 源码 + 真跑实测确认:**qwen21.edit 路由接受显式 `--width/--height`**,
 * 且**宽高比不受参考图约束** —— 参考图 3:4 也能输出 16:9。实测:
 *   显式 `--width 1280 --height 704` → 输出 1280×704;
 *   不传                          → 1376×768(按最后一张参考图的 3:4 推导)。
 * 唯一硬约束(`QwenImage21LatentCreator.validate`):≥32 且 **32 的倍数**。
 */

/** 尺寸档位(全部 32 的倍数;含常用 16:9 / 9:16 / 1:1 / 4:3 / 3:4) */
export const OUTPUT_SIZE_PRESETS: Array<{ label: string; w: number; h: number }> = [
  { label: '16:9', w: 1280, h: 704 },
  { label: '9:16', w: 704, h: 1280 },
  { label: '1:1', w: 1024, h: 1024 },
  { label: '4:3', w: 1152, h: 864 },
  { label: '3:4', w: 864, h: 1152 },
];

/** 尺寸是否合法(CLI 硬约束:≥32 且 32 的倍数) */
export function isValidOutputSize(w: number, h: number): boolean {
  return (
    Number.isInteger(w) &&
    Number.isInteger(h) &&
    w >= 32 &&
    h >= 32 &&
    w % 32 === 0 &&
    h % 32 === 0
  );
}

/** 把任意数值规整到最近合法的 32 倍数(≥32);用于「一键对齐」而不阻断输入 */
export function snapTo32(v: number): number {
  if (!Number.isFinite(v)) return 32;
  return Math.max(32, Math.round(v / 32) * 32);
}

/**
 * 尺寸档位命中的预设标签(纯函数,供单测)。
 * 返回 null = 当前尺寸不在预设里(用户手填了自定义值)→ UI 高亮「自定义」。
 */
export function matchSizePreset(w: number, h: number): string | null {
  const hit = OUTPUT_SIZE_PRESETS.find((p) => p.w === w && p.h === h);
  return hit ? hit.label : null;
}

/**
 * 解析「自定义尺寸输入」的提交值(纯函数,供单测)。
 *
 * 设计原则:**非法值不写进 data,返回 null 让调用方拒绝**。
 * 若默默规整(如 720 → 704),用户以为自己填了 720、实跑 704,又是一个
 * 「界面显示 A、实跑 B」的静默不一致(本项目已踩过 steps 的同类坑)。
 */
export function parseSizeInput(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return isValidOutputSize(n, n) ? n : null;
}

/**
 * 各编辑模式可用的已知模型 + 推荐默认(2026-09 mlxgen capabilities 实测,矩阵见
 * docs/工具模型选择-产品设计与技术方案.md §2.1.1):
 * - instruction:Qwen Edit / flux2 / **Qwen-Image-2.1**(qwen21.edit,1-10 张参考图。
 *   2026-09-29 缺陷 B 修复:此前 allowed 漏了 2.1,用户选了 2.1 一切模式就被自动切走)
 * - img2img(latent):z-image / flux2 / **Qwen-Image-2.1**(qwen21.latent;
 *   2026-09-29 缺陷 A 已修:Provider 不再误拒 2.1,故入列)
 * - inpaint/outpaint → qwen.edit handler(Qwen Edit / flux2);2.1 实测无 mask/outpaint 能力
 * 自定义 repoId(matchModel 匹配不到)不自动切换,由用户自行负责。
 */
const MODE_MODELS: Record<string, { allowed: string[]; recommend: string }> = {
  instruction: { allowed: ['mlx-community/Qwen-Image-Edit-8bit', 'AbstractFramework/flux.2-klein-9b-8bit', 'Qwen/Qwen-Image-2.1'], recommend: 'mlx-community/Qwen-Image-Edit-8bit' },
  img2img: { allowed: ['AbstractFramework/z-image-turbo-8bit', 'AbstractFramework/flux.2-klein-9b-8bit', 'Qwen/Qwen-Image-2.1'], recommend: 'AbstractFramework/z-image-turbo-8bit' },
  inpaint: { allowed: ['mlx-community/Qwen-Image-Edit-8bit', 'AbstractFramework/flux.2-klein-9b-8bit', 'AbstractFramework/z-image-turbo-8bit'], recommend: 'mlx-community/Qwen-Image-Edit-8bit' },
  outpaint: { allowed: ['mlx-community/Qwen-Image-Edit-8bit', 'AbstractFramework/flux.2-klein-9b-8bit'], recommend: 'mlx-community/Qwen-Image-Edit-8bit' },
};

/** 模式切换判定(纯函数,供单测):当前已知模型不支持目标模式时给出推荐切换目标,否则 null */
export function modeSwitchDecision(currentModel: string, targetMode: string): { recommend: string } | null {
  const rule = MODE_MODELS[targetMode];
  const curRepo = matchModel(currentModel)?.repoId;
  if (rule && curRepo && !rule.allowed.includes(curRepo)) return { recommend: rule.recommend };
  return null;
}

/** 输入图来源解析结果(检查器顶部的来源卡 + 大图预览都用它) */
export interface EditInputImage {
  /** 可直接显示的 URL;null = 拿不到图(此时只显示来源卡,不渲染大图) */
  src: string | null;
  label: string;
  sub: string;
  pill: string;
}

/**
 * 解析编辑节点的输入图(纯函数,供单测)。
 *
 * 优先级:Asset 直绑(表单填的 inputAssetId)> shot 抽帧 > 上游直通。
 *
 * ⚠️ **上游有两种形态,都必须能出图**(2026-09 修复「输入节点图片没显示」):
 *   - **asset 节点**:图在资产库里,路径要从 `assetCache` 按 `data.assetId` 取 ——
 *     它**根本没有** `data.resultPath`。旧实现一律读 resultPath,拿到空串后
 *     `src` 变成 null,于是来源卡写着「asset · 产物直通」却一个图都不显示;
 *   - **其它图片节点**(image-gen / image-crop / frame-grab …):走 `data.resultPath`。
 * 与 CanvasPage 的 `upstreamImagePath` / `upstreamVideoPath` 同口径。
 *
 * 第三级优先级的三个「拿不到图」分支必须给出**互不混淆**的 sub 文案:
 * ① 上游节点在画布上找不到(已删除)→ label 回落成裸 id;② asset 上游但 assetCache
 * 查不到 → 「资产未加载」(资产记录丢失 / 缓存未刷新,两者对用户都是「去资源库看看」);
 * ③ 非 asset 上游但没有 resultPath → 「上游暂无产物」(还没跑)。
 *
 * ⚠️ 本函数**只解析 input 端口**(被编辑的底图)。参考图(ref-image)有独立的
 * `resolveRefImages` + `RefImagesCard` 展示区 —— 两个端口语义不同,不能混在一张卡里。
 * 仅参考图时这里返回「无底图」并指路下方参考图区,不再借用参考图的图充数。
 */
export function resolveEditInputImage(args: {
  inputAssetId: string;
  frameSrc?: { videoNodeId?: string; at?: 'first' | 'last' };
  imgFrom?: { nodeId?: string };
  /** 参考图来源(ref-image 入边,多值)。无底图时用它兜底显示,避免谎报「无输入」 */
  refImageFrom?: Array<{ nodeId?: string }>;
  nodes: CanvasNode[];
  assetCache: Record<string, string>;
}): EditInputImage {
  const { inputAssetId, frameSrc, imgFrom, refImageFrom, nodes, assetCache } = args;

  if (inputAssetId && assetCache[inputAssetId]) {
    return { src: previewUrlOf(assetCache[inputAssetId]), label: 'Asset 直绑', sub: inputAssetId, pill: 'Asset 直绑' };
  }
  if (frameSrc?.videoNodeId) {
    const vn = nodes.find((n) => n.id === frameSrc.videoNodeId);
    return { src: null, label: vn?.title ?? 'shot 节点', sub: `取帧 · ${frameSrc.at === 'last' ? '尾帧' : '首帧'}`, pill: '抽帧' };
  }
  if (imgFrom?.nodeId) {
    const upNode = nodes.find((n) => n.id === imgFrom.nodeId);
    const pd = (upNode?.data ?? {}) as Record<string, unknown>;
    const isAssetUp = upNode?.kind === 'asset';
    const assetId = String(pd.assetId ?? '');
    const path = isAssetUp ? (assetCache[assetId] ?? '') : String(pd.resultPath ?? '');
    /* 拿不到图时**必须说清是哪一种拿不到**(2026-10 事故:来源卡写着「asset · 资产直通」、
       大图却是空的,用户无法区分「连线没接上」与「资产没加载」/「资产记录丢了」,
       排查时只能靠猜)。与 NodeBody 的「资产未加载 …」占位文案同口径。 */
    const sub = !path
      ? isAssetUp
        ? `asset · 资产未加载${assetId ? `(${assetId})` : '(节点未绑定资产)'}`
        : `${upNode?.kind ?? '图片'} · 上游暂无产物`
      : isAssetUp
        ? 'asset · 资产直通'
        : `${upNode?.kind ?? '图片'} · 产物直通`;
    return {
      src: path ? previewUrlOf(path) : null,
      label: upNode?.title ?? imgFrom.nodeId,
      sub,
      pill: isAssetUp ? 'asset' : '直通',
    };
  }
  /* 仅参考图、无底图(Qwen-Image-2.1 的 qwen21.edit 合法用法)。
     ⚠️ 这里**只改文案,不借用参考图的图**:ref-image 有自己独立的展示区(RefImagesCard),
     在「输入图」卡里显示参考图会让用户以为那张就是被编辑对象 —— 两个端口语义不同,
     视觉上必须分开(2026-10 用户明确要求)。所以本卡如实说明「无底图」并指路下方参考图区。 */
  if ((refImageFrom ?? []).some((r) => r?.nodeId)) {
    return {
      src: null,
      label: '无底图',
      sub: `未连 input 端口 · 见下方「参考图」区(${refImageFrom!.filter((r) => r?.nodeId).length} 张)`,
      pill: '仅参考图',
    };
  }
  return { src: null, label: '无输入', sub: '连一个 shot / 图片节点 / asset,或填输入图资产', pill: '待绑定' };
}

/**
 * 「输入图 Asset ID」字段的状态判定(纯函数,供单测)。
 *
 * 这个字段的语义**不是**旧标签说的「与连线二选一」,而是 **填了就压过连线**:
 * 提交侧 `CanvasPage.runNode` 的顺序是「取帧 → inputAssetId → 上游连线」,
 * 输入框只要有值,连线解析根本不会执行。所以字段必须把这件事说清楚,
 * 并在值**不可用**时当场报错 —— 否则表现是「连了线却不出图」且毫无线索。
 *
 * 三种状态:
 *  - `empty`:没填。正常走连线 / 取帧。
 *  - `invalid`:填了,但 `assetsList`(完整资产清单)里查无此 id —— 真错误。
 *  - `ok`:填了且资产确实存在。
 *
 * ⚠️ 判据同时看两个数据源:`assetsList` 判「是否存在」,`assetCache` 判「路径是否就绪」。
 * 刚粘贴 ID / 资产刚导入时可能「存在但缓存未就绪」,这**不算错**——
 * 所以只要在 assetsList 里能查到就判 ok,不让异步时序误伤。
 */
export type AssetIdFieldState = 'empty' | 'invalid' | 'ok';

export function assetIdFieldState(
  inputAssetId: string,
  assetsList: Array<{ id: string }>,
  assetCache: Record<string, string>,
): AssetIdFieldState {
  const id = inputAssetId.trim();
  if (!id) return 'empty';
  // 资产清单里查得到 = 存在(即便缓存还没就绪也算合法,避免误伤异步加载)
  if (assetsList.some((a) => a.id === id)) return 'ok';
  // 缓存里已有路径 = 必然可用(清单可能尚未刷新)
  if (assetCache[id]) return 'ok';
  return 'invalid';
}

/**
 * 两块卡片区的**显隐判定**(纯函数,供单测)。
 *
 * 2026-10 用户要求:没有内容就不占位。
 *  - 输入图卡:没绑任何输入源 → 整块不渲染。空壳卡(「无输入」+ 空框)零信息量,
 *    还把真正的操作项挤到下面。判据用「来源是否绑定」而非「src 是否有值」——
 *    连了线但上游还没跑出产物时,来源信息本身有用(说明连的是谁、为何还没图),必须留着。
 *  - 参考图卡:**多于一张**才渲染。单张没有「多张关联」可看,不值得占一整块。
 */
export function inspectorCardVisibility(args: {
  inputAssetId: string;
  frameSrc?: { videoNodeId?: string };
  imgFrom?: { nodeId?: string };
  refImageCount: number;
}): { showInput: boolean; showRefImages: boolean } {
  return {
    // 三处都判 trim 后的内容:纯空白的 id / nodeId 是脏数据(用户粘贴时常带空白),
    // 若按真值判断会让空壳卡复现 —— 与 assetIdFieldState 的 trim 口径保持一致
    showInput:
      !!args.inputAssetId.trim() || !!args.frameSrc?.videoNodeId?.trim() || !!args.imgFrom?.nodeId?.trim(),
    showRefImages: args.refImageCount > 1,
  };
}

export function ImageEditInspector(p: ImageEditInspectorProps) {
  const { node, setData, jobs, projectId, nodes, assetCache, assetsList = [], runNode, toastMsg, onSelectTake, onSaved } = p;
  const d = (node.data ?? {}) as Record<string, unknown>;
  const mode = String(d.mode ?? 'instruction');
  // 未显式选模型时显示缺省解析结果(按当前 mode 对应的能力;2026-09-29 v1)
  // 订阅式读取(2026-10-14):冷启动缓存未加载时不再误显内置默认(见 tool-models-store)
  const toolModels = useToolModels();
  const model = String(d.model ?? '').trim() || (resolveImageModel(toolModels, capabilityOf('image-edit', mode)) ?? '');
  const prompt = String(d.prompt ?? '');
  const inputAssetId = String(d.inputAssetId ?? '');
  const maskAssetId = String(d.maskAssetId ?? '');
  const imageStrength = Number(d.imageStrength ?? 0.5);
  // 显示/写回的默认步数:**按当前 model 区分** —— Qwen-Image-2.1-Turbo 走 8 步
  // (采样表内置,引擎锁步数=8、忽略 --steps;UI 必须说真话),其余走 DEFAULT_EDIT_STEPS。
  // 滑块展示与 effect 写回都用这个值,避免「显示 30、实跑 8」或反过来的又一次事故。
  const defaultStepsForModel = defaultEditStepsForModel(model);
  const steps = Number(d.steps ?? defaultStepsForModel);
  /** 像素面积预算(仅 2.1 参考编辑有意义;未设置时用 CLI 默认 1024,不写回 data) */
  const outputResolution = Number(d.outputResolution ?? DEFAULT_OUTPUT_RESOLUTION);
  /* 显式输出尺寸(→ --width/--height)。**必须成对**才生效,与 provider 同口径:
     只给一个时另一个会走「按参考图比例推导」,拼出用户没预期的比例,故视为未指定。
     ⚠️ 「跟随参考图」写入的是 **null**(不是 undefined):setData 是 `{...data, ...patch}`
     的浅合并,**传 undefined 只会把键留下并置为 undefined**,JSON 里虽会被丢掉,
     但内存态留着一个值为 undefined 的键,后续读取方容易误判。null 是显式哨兵,一眼可辨。 */
  const numOrNull = (v: unknown): number | null => {
    const n = Number(v);
    return v != null && v !== '' && Number.isFinite(n) && n > 0 ? n : null;
  };
  const explicitW = numOrNull(d.width) ?? undefined;
  const explicitH = numOrNull(d.height) ?? undefined;
  const explicitSize = explicitW !== undefined && explicitH !== undefined;
  /** data 里是否有显式步数(未设置时下面 effect 会补写,补写前提交侧会走 provider 兜底) */
  const hasExplicitSteps = d.steps !== undefined && Number.isFinite(Number(d.steps));
  /* 补写默认步数:仅在缺失时执行一次(用户拖动滑块后 data.steps 存在,不再覆盖)。
     ⚠️⚠️ 依赖数组**故意只放节点 id**,不放 hasExplicitSteps / setData —— 这是防「无限重渲染」的硬要求:
       - `setData` 由 InspectorBody 内联定义,**每次渲染都是新引用**;
       - 写入 steps 后 props 里的 `d.steps` 要等下一轮渲染才更新,故本轮 `hasExplicitSteps` 仍为 false。
     若把这两者放进依赖,effect 会在「写入 → 重渲染 → 依赖变化 → 再写入」间自我维持,
     实测直接打爆 React 的 `Maximum update depth exceeded`(2026-09-29 真实事故,日志刷屏 672 条)。
     以 node.id 为界即可:切节点时才重新判断是否需要补写。 */
  const setDataRef = useRef(setData);
  setDataRef.current = setData;
  /** 是否已有显式步数:从 ref 读,避免进入 effect 依赖(见上方注释) */
  const hasExplicitStepsRef = useRef(hasExplicitSteps);
  hasExplicitStepsRef.current = hasExplicitSteps;
  const nodeId = node.id;
  useEffect(() => {
    // 已有显式步数(用户调过 / 补写过)不再覆盖
    if (hasExplicitStepsRef.current) return;
    // 按当前 model 选默认步数 —— Turbo 给 8(与 engine 锁步数对齐,见
    // 顶部 defaultEditStepsForModel 注释),其余 30。`model` 变化会让 useMemo/recompute
    // 拿到新值;但本 effect 依赖只放 nodeId,故**仅在切节点时**补写一次,
    // 切模型不主动重写(避免覆盖用户已调过的滑块)。
    setDataRef.current({ steps: defaultEditStepsForModel(model) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上方注释:稳定依赖,防止自维持死循环
  }, [nodeId]);
  const outpaintSides = (d.outpaintSides as { top: number; right: number; bottom: number; left: number } | undefined)
    ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const frameSrc = d.inputFrameSource as { videoNodeId?: string; at?: 'first' | 'last' } | undefined;
  const imgFrom = d.inputImageFrom as { nodeId?: string } | undefined;
  /** 参考图来源(ref-image 入边,多值):无底图时来源卡靠它兜底,不再谎报「无输入」 */
  const refImageFrom = Array.isArray(d.refImageFrom)
    ? (d.refImageFrom as Array<{ nodeId?: string }>)
    : undefined;
  // 产物路径:节点 data 优先,缺失时回退 Take 历史里最新成功产物(2026-09-29 事故修复)
  const resultPath = useTakeResult(node.id, projectId, d.resultPath, jobs) ?? '';
  const hasTake = !!d.currentTakeId || !!resultPath;
  const running = jobs.some((j) => j.nodeId === node.id && j.status === 'running');

  // 模式切换:当前模型不在该模式可用集合里时自动切到推荐模型(自定义模型不动)
  const onModeChange = (m: string) => {
    const decision = modeSwitchDecision(model, m);
    if (decision) {
      const to = matchModel(decision.recommend);
      setData({ mode: m, model: decision.recommend });
      toastMsg(`「${MODE_META.find((x) => x.key === m)?.label ?? m}」模式不支持当前模型,已自动切换为 ${to?.name ?? decision.recommend}`);
    } else {
      setData({ mode: m });
    }
  };

  // ── 输入图来源解析(Asset 直绑 > shot 抽帧 > 图片直通) ──
  const up = resolveEditInputImage({
    inputAssetId,
    frameSrc,
    imgFrom,
    refImageFrom,
    nodes,
    assetCache,
  });

  /** 输入图 Asset ID 的合法性(查不到就标红提示,不再静默当没有) */
  const assetIdState = assetIdFieldState(inputAssetId, assetsList, assetCache);

  /** 参考图解析(ref-image 端口独立展示区用;与「输入图」互不影响) */
  const refImages = resolveRefImages({ refImageFrom, nodes, assetCache });

  /* ── 两块卡片的**显隐条件**(2026-10 用户要求:没有就不占位) ──
     判据与理由见上方 inspectorCardVisibility 的文档注释 */
  const { showInput: hasInputSource, showRefImages } = inspectorCardVisibility({
    inputAssetId,
    frameSrc,
    imgFrom,
    refImageCount: refImages.length,
  });

  // 输入图自然尺寸(outpaint 导出尺寸推算用)
  const [inputDims, setInputDims] = useState<{ w?: number; h?: number }>({});
  useEffect(() => {
    if (!up.src) { setInputDims({}); return; }
    const img = new Image();
    img.onload = () => setInputDims({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => setInputDims({});
    img.src = up.src;
    return () => { img.onload = null; img.onerror = null; };
  }, [up.src]);

  /* 「最后一张参考图」的自然尺寸 —— 输出几何由它决定(见 lastGeometrySource 注释)。
     必须单独量:它通常**不是** `up.src`(输入图),用输入图的比例去预测会算错。 */
  const lastGeom = lastGeometrySource({ hasInput: hasInputSource, refNodeIds: refImages.map((r) => r.nodeId) });
  const lastGeomSrc = lastGeom?.kind === 'ref'
    ? (refImages.find((r) => r.nodeId === lastGeom.nodeId)?.src ?? null)
    : lastGeom?.kind === 'input'
      ? up.src
      : null;
  const [lastGeomDims, setLastGeomDims] = useState<{ w?: number; h?: number }>({});
  useEffect(() => {
    if (!lastGeomSrc) { setLastGeomDims({}); return; }
    const img = new Image();
    img.onload = () => setLastGeomDims({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => setLastGeomDims({});
    img.src = lastGeomSrc;
    return () => { img.onload = null; img.onerror = null; };
  }, [lastGeomSrc]);

  /** 跟随参考图时预测的输出尺寸(拿不到最后一张的比例时为 null,UI 显示 auto) */
  const predictedAutoSize = predictOutputSize(
    outputResolution,
    lastGeomDims.w && lastGeomDims.h ? lastGeomDims.w / lastGeomDims.h : null,
  );

  const upstreamStale = imgFrom?.nodeId ? !!nodes.find((n) => n.id === imgFrom.nodeId)?.stale : false;

  const [modelReady, setModelReady] = useState(true);
  useEffect(() => {
    const repo = matchModel(model)?.repoId;
    if (!repo) return;
    void window.bigbotart
      .mlxgenModels()
      .then((list) => setModelReady(!!list.find((m) => m.repoId === repo)?.downloaded))
      .catch(() => {});
  }, [model]);

  const canSubmit = !running && !upstreamStale && !(mode === 'inpaint' && !maskAssetId);
  const submitHint =
    upstreamStale
      ? '上游已变更 · 请先同步上游'
      : mode === 'inpaint' && !maskAssetId
        ? '请先绘制/选择遮罩'
        : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <GenStatePanel
        node={node}
        jobs={jobs}
        takesCount={hasTake ? 1 : 0}
        runNode={runNode}
        toastMsg={toastMsg}
        modelDownloaded={modelReady}
        onDownloadModel={() => {
          const repo = matchModel(model)?.repoId;
          if (!repo) { toastMsg('当前为自定义模型,请到设置页下载'); return; }
          void window.bigbotart.mlxgenDownload(repo).then((r) => toastMsg(r.ok ? `已开始下载 ${repo}` : `下载失败:${r.error ?? ''}`));
        }}
      />

      {/* 产物预览置顶(与 image-gen 检查器同模式)。
          顺序上**产物在输入图之上**:用户点开编辑节点最关心「改成什么样了」,
          产物才是结果;输入图(UpstreamCard + 大图)是它的上下文,排在后面。
          状态条仍留在最顶部(GenStatePanel)—— 排队/生产/失败这些状态是行动依据,
          不该被图片挤下去。 */}
      {resultPath ? (
        <div className="kv" data-od-id="edit-result-preview">
          <div className="f-sec-h"><span className="lbl">产物预览</span><span className="mut" style={{ fontSize: 10.5 }}>{hasTake ? 'Take · 可点下方历史切换' : ''}</span></div>
          <ImagePreview src={previewUrlOf(resultPath)} label="" />
          <div className="row g6">
            <SaveToLibraryButton
              projectId={projectId}
              items={[{ nodeId: node.id, path: resultPath, name: node.title, caption: prompt }]}
              toastMsg={toastMsg}
              onSaved={onSaved}
            />
          </div>
        </div>
      ) : null}

      {/* 输入图:来源卡片 + 大图预览(有源时;点 ⛶ 可全屏)。
          未出产物时它就是最上面的图,出了产物则退到产物下方作对照。
          ⚠️ hasInputSource 为假 = 没绑任何输入源 → **整块不渲染**(见上方显隐条件注释) */}
      {hasInputSource ? (
        <>
          <UpstreamCard label={up.label} sub={up.sub} src={up.src} pill={up.pill} />
          {up.src ? <ImagePreview src={up.src} alt="输入图预览" /> : null}
        </>
      ) : null}

      {/* 参考图:独立展示区(ref-image 端口专用)。
          与「输入图」并列但语义独立 —— 输入图是**被编辑对象**,这里每张都是**参考**,
          混在一张卡里会让人分不清哪张会被改(2026-10 用户要求拆开)。
          ⚠️ 仅**多于一张**时渲染:单张没有「多张关联」可看(见上方显隐条件注释) */}
      {showRefImages ? <RefImagesCard items={refImages} /> : null}

      {upstreamStale ? (
        <div className="stale-banner" data-od-id="stale-banner">
          <div className="sb-ico">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.7}><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3" /></svg>
          </div>
          <div className="sb-meta">
            <b>上游已变化 · 当前编辑基于旧产物</b>
            <div className="sb-sub">提交时自动使用上游最新产物;上游重新生成后建议重跑本节点。</div>
          </div>
          <div className="sb-acts">
            <button className="btn btn-p btn-sm" type="button" onClick={() => runNode(node.id)}>同步上游并重跑</button>
          </div>
        </div>
      ) : null}

      {/* 编辑模式 chips */}
      <div className="f-sec">
        <div className="f-sec-h"><span className="lbl">编辑模式</span></div>
        <div className="modes" style={running ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
          {MODE_META.map((m) => (
            <span key={m.key} className={`chip${mode === m.key ? ' on' : ''}`} onClick={() => onModeChange(m.key)}>
              {m.label}
              <span className="small mono">{m.mono}</span>
            </span>
          ))}
        </div>
      </div>

      {/* 输入图 Asset ID —— **不是「二选一」,而是「填了就压过连线」**(提交侧顺序:
          取帧 → inputAssetId → 上游连线)。故标题写「优先于输入端口连线」,
          并在填了值且确实压过连线时直接点明,避免「连了线却不出图」无从排查。 */}
      <div className="f-sec" style={running ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
        <div className="f-sec-h">
          <span className="lbl">输入图 Asset ID</span>
          <span className="mut" style={{ fontSize: 10.5 }}>填写后优先于输入端口连线</span>
        </div>
        <input
          className={`f-in full mono${assetIdState === 'invalid' ? ' f-in-bad' : ''}`}
          placeholder="asset-…(留空则用连线)"
          value={inputAssetId}
          aria-invalid={assetIdState === 'invalid'}
          onChange={(e) => setData({ inputAssetId: e.target.value })}
        />
        {assetIdState === 'invalid' ? (
          <div className="f-hint f-hint-bad" data-od-id="input-asset-id-invalid">
            资产库里没有这个 ID · 请从资产中心复制,或清空此框改用连线
            {imgFrom?.nodeId ? '(清空后即走已连的输入端口)' : ''}
          </div>
        ) : assetIdState === 'ok' && imgFrom?.nodeId ? (
          <div className="f-hint" data-od-id="input-asset-id-overrides">
            当前用此资产作输入图 · 已连的输入端口被忽略(清空此框即可恢复用连线)
          </div>
        ) : null}
      </div>

      {frameSrc?.videoNodeId ? (
        <div className="f-sec" style={running ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
          <div className="f-sec-h"><span className="lbl">取帧</span></div>
          <div className="row g6">
            {(['first', 'last'] as const).map((at) => (
              <span
                key={at}
                className={`chip${(frameSrc.at ?? 'first') === at ? ' on' : ''}`}
                onClick={() => setData({ inputFrameSource: { videoNodeId: frameSrc.videoNodeId, at } })}
              >
                {at === 'first' ? '首帧' : '尾帧'}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div style={running ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
        <div className="f-sec">
          <div className="f-sec-h"><span className="lbl">编辑指令</span><span className="mut" style={{ fontSize: 10.5 }}>告诉模型「改什么」</span></div>
          <textarea
            className="f-ta"
            rows={3}
            placeholder="把背景换成日落,保留主体"
            value={prompt}
            onChange={(e) => setData({ prompt: e.target.value })}
          />
        </div>

        {mode === 'img2img' ? (
          <ImageStrengthField value={imageStrength} onChange={(v) => setData({ imageStrength: v })} />
        ) : null}

        {/* 像素预算:仅 Qwen-Image-2.1 参考编辑认识该参数(见 shouldShowOutputResolution)。
            语义:未指定输出尺寸时作为推导基准,同时决定参考图被缩放到多大。 */}
        {shouldShowOutputResolution(model, mode) ? (
          <OutputResolutionField
            value={outputResolution}
            stops={OUTPUT_RESOLUTION_STOPS}
            predicted={explicitSize ? { w: explicitW, h: explicitH } : predictedAutoSize}
            onChange={(v) => setData({ outputResolution: v })}
            disabled={running}
          />
        ) : null}

        {/* 输出尺寸:显式指定 --width/--height(2026-10-08 新增)。
            编辑可以输出任意尺寸,宽高比**不受参考图约束**(实测参考图 3:4 → 16:9 成功)。 */}
        {shouldShowOutputResolution(model, mode) ? (
          <OutputSizeField
            width={explicitW}
            height={explicitH}
            autoSize={!explicitSize}
            predicted={predictedAutoSize}
            presetLabel={matchSizePreset(explicitW ?? 0, explicitH ?? 0)}
            onPickPreset={(s) => setData({ width: s.w, height: s.h })}
            onManual={(w, h) => setData({ width: w, height: h })}
            /* 「跟随参考图」= 写 null 哨兵(见上方 numOrNull 注释:不能传 undefined) */
            onUseAuto={() => setData({ width: null, height: null })}
            disabled={running}
          />
        ) : null}

        {mode === 'inpaint' ? (
          <MaskField
            baseSrc={up.src}
            maskAssetId={maskAssetId}
            maskSrc={maskAssetId && assetCache[maskAssetId] ? previewUrlOf(assetCache[maskAssetId]) : null}
            onSave={(dataUrl) => {
              void window.bigbotart
                .savePngAsset({ name: `mask-${node.id}`, dataUrl, projectId: projectId ?? undefined, tags: ['遮罩'] })
                .then((r) => {
                  if (r.ok && r.assetId) {
                    setData({ maskAssetId: r.assetId });
                    toastMsg(`遮罩已保存为资产 ${r.assetId}`);
                  } else {
                    toastMsg(`遮罩保存失败:${r.error ?? ''}`);
                  }
                })
                .catch(() => toastMsg('遮罩保存失败'));
            }}
            onClear={() => setData({ maskAssetId: '' })}
            onChangeAssetId={(v) => setData({ maskAssetId: v })}
            toastMsg={toastMsg}
          />
        ) : null}

        {mode === 'outpaint' ? (
          <OutpaintPads
            sides={outpaintSides}
            inputW={inputDims.w}
            inputH={inputDims.h}
            onChange={(sides) => setData({ outpaintSides: sides })}
          />
        ) : null}

        <div className="f-sec">
          <div className="f-sec-h"><span className="lbl">模型</span></div>
          <ModelCombo value={model} onChange={(v) => setData({ model: v })} disabled={running} />
        </div>

        {/* 采样步数:编辑原本没有该控件,导致编辑质量被静默固定在模型自身默认步数
            (实测 2026-09:flux.2-klein / z-image 不传 --steps 时都是 4 步,对去水印、改动作
            这类细活明显不够)。现在按 model 给默认(Turbo=8 / 其它=30)并**写回 data**
            (见上方 defaultEditStepsForModel 注释),滑块显示几步就实跑几步;拖动即覆盖。
            min 保留下限 4 以兼容存量节点里的小步数 */}
        <div className="f-sec">
          <div className="f-sec-h">
            <span className="lbl">采样</span>
            <span className="mut" style={{ fontSize: 10.5 }}>默认 {defaultStepsForModel} 步 · 拖动可覆盖</span>
          </div>
          <div className="f-row">
            <span className="f-lbl">steps</span>
            <div className="range" style={{ flex: 1, minWidth: 120 }}>
              <input
                type="range"
                min={4}
                max={50}
                value={steps}
                disabled={running}
                onChange={(e) => setData({ steps: Number(e.target.value) })}
              />
              <span className="val mono">{steps}</span>
            </div>
          </div>
        </div>
      </div>

      <KVSection
        rows={[
          ['引擎', 'mlxgen · generate 子命令'],
          ['路由', mode === 'instruction' ? 'edit-reference(自动)' : mode === 'img2img' ? 'latent img2img' : mode === 'inpaint' ? 'masked-edit' : 'outpaint'],
          /* 卡片隐藏时这行是唯一的输入状态出口,故即使「未绑定」也要如实给出
             (单张参考图尤其需要它 —— 参考图卡按「多于一张」才渲染,否则那张图就没有任何提示) */
          ['输入', inputAssetId ? 'Asset 直绑' : frameSrc ? 'shot 抽帧' : imgFrom ? '上游直通' : refImages.length ? '无底图' : '未绑定'],
          ...(refImages.length ? [['参考图', `${refImages.length} 张 · 非被编辑对象`] as [string, string]] : []),
        ]}
      />

      <ImageTakeSection
        node={node}
        projectId={projectId}
        jobs={jobs}
        onSelectTake={onSelectTake}
        toastMsg={toastMsg}
      />

      {/* 运行行动条放最底部,与检查器面板的「仅重跑该节点」按钮相邻;措辞与其他检查器统一为「运行」 */}
      <ActionBar
        primary={() => runNode(node.id)}
        primaryLabel={hasTake ? '重新运行' : '运行'}
        primaryIcon={hasTake ? 'regen' : 'gen'}
        disabled={!canSubmit}
        hint={submitHint}
      />
    </div>
  );
}