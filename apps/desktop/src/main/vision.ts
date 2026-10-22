/**
 * VisionTool — 图片反推提示词(Agent `vision.caption`)
 *
 * 背景:Agent 主 LLM 通道是**纯文本**的(pi-chat.ts 声明 `input:['text']`,图片像素
 * 从不进入主模型上下文)。因此「看着图反推提示词」这类任务主模型做不到 ——
 * 过去它只能盲目建一个节点来「代替回答」。
 *
 * 本模块把「看图」拆成独立一步,把图片转成文字描述再交回主 LLM 按需成稿。
 * **两条通道**(2026-10 新增第二条):
 *  - `endpoint`:OpenAI 兼容多模态端点(LM Studio :1234 / 远端),需要外部服务在跑;
 *  - `mlxgen`:mlx-gen 新出的 `mlxgen-caption`(本地 MLX Qwen3-VL,**不需要任何 server**),
 *    实现在 ./mlxgen-caption.ts。
 * 选择顺序:设置页「工具模型 → 看图反推」的显式绑定 > `BIGBOTART_CAPTION_BACKEND`
 * > auto(本机有可用 checkpoint + 可执行命令就优先本地,否则端点)。
 * 回退只发生在 auto 且调用方没有传入通道时;设置页或环境变量显式选定的通道失败就报失败。
 * 回退发生时结果里明说「主通道失败已回退」(不静默降级)。
 * 主链路(pi-chat)零改动,主模型不需要具备视觉能力。
 *
 * 安全:只允许读产物/资产/导出目录下的图片(与 frames.ts 同白名单口径),防任意读。
 * 错误:一律显式返回,不静默吞(AGENTS.md R6)。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { withOpenCodeGoHeaders } from '@bigbotart/shared';
import type { LlmProtocol } from '@bigbotart/shared';
import { extractTextResult, responseError, textCallUrl, visionCallBody } from './llm-http.js';
import { ffmpegReadRoots, isUnderRoot } from './assets';
import {
  resolveCaptionConfig,
  resolveCaptionConfigDetailed,
  runMlxgenCaption,
  type CaptionDeps,
  type CaptionLocalBinding,
  type MlxgenCaptionConfig,
} from './mlxgen-caption';

/** 单图大小上限(视觉请求会 base64 膨胀约 1.37 倍,20MB 原图已足够) */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** 视觉端点默认值:LM Studio 本地(与本机已装 Qwen3-VL 对齐) */
const DEFAULT_VL_BASE_URL = 'http://127.0.0.1:1234/v1';
const DEFAULT_VL_MODEL = 'qwen3-vl-8b-nsfw-caption-v4.5-affine';

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

/** 视频扩展名:命中时给出「先 frames.extract 取帧」的可执行指引(见 captionImage) */
const VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v']);
/** 音频扩展名:本工具无法分析 */
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg']);

export interface VisionEndpoint {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** 对话协议:缺省 chat(/chat/completions);grok 等只开 /responses 的端点走 responses */
  protocol?: LlmProtocol;
}

export interface CaptionResult {
  ok: boolean;
  /** 反推出的提示词文本 */
  caption?: string;
  model?: string;
  /** 实际走通的通道('endpoint' 端点 / 'mlxgen' 本地引擎)—— 回显,便于用户判断走了哪条 */
  backend?: 'endpoint' | 'mlxgen';
  /** 回退说明:主通道失败后由另一条通道救回时写明原因(不静默降级) */
  note?: string;
  error?: string;
}

/**
 * 看图通道 —— 端点 or 本地 mlxgen-caption。
 * `config` 缺失 = 显式要求本地通道但本机不可用(命令/checkpoint 缺),`reason` 说明原因;
 * 这种情况**不回退**,直接把原因报出来(用户显式要的通道不该被悄悄换掉)。
 */
export type VisionRoute =
  | { kind: 'endpoint'; endpoint: VisionEndpoint }
  | { kind: 'mlxgen'; config?: MlxgenCaptionConfig; reason?: string };

/**
 * 解析视觉端点(纯函数,便于单测):
 * 优先 `BIGBOTART_VL_*` 专属配置 → 回退 `BIGBOTART_LLM_*`(主端点若本身支持视觉)
 * → 最后回退本地 LM Studio 默认视觉模型。
 */
export function resolveVisionEndpoint(env: NodeJS.ProcessEnv = process.env): VisionEndpoint {
  // baseUrl 与 model 必须成对回退:只回退了 baseUrl 却用本地默认模型名去打远端端点,
  // 会请求一个远端不存在的模型(404)。模型优先级与 baseUrl 一致:VL 专属 → 主 LLM → 本地默认。
  const vlBase = env.BIGBOTART_VL_BASE_URL;
  const llmBase = env.BIGBOTART_LLM_BASE_URL;
  const base = vlBase ?? llmBase ?? DEFAULT_VL_BASE_URL;
  const model =
    env.BIGBOTART_VL_MODEL ??
    (vlBase ? undefined : env.BIGBOTART_LLM_MODEL) ??
    DEFAULT_VL_MODEL;
  const apiKey = env.BIGBOTART_VL_API_KEY ?? (vlBase ? undefined : env.BIGBOTART_LLM_API_KEY);
  // 协议跟主 LLM 同一开关(BIGBOTART_LLM_PROTOCOL=responses);否则看图端点仍是 chat
  const protocol: LlmProtocol = env.BIGBOTART_LLM_PROTOCOL === 'responses' ? 'responses' : 'chat';
  return { baseUrl: base.replace(/\/+$/, ''), apiKey, model, protocol };
}

/** 端点通道(包装成 route,便于两条通道统一处理) */
function endpointRoute(env: NodeJS.ProcessEnv = process.env): VisionRoute {
  return { kind: 'endpoint', endpoint: resolveVisionEndpoint(env) };
}

/**
 * 本地 mlxgen-caption 通道(设置页显式绑定 / env 指定 checkvex 时用)。
 * 不可用时**不抛异常**,返回带 reason 的 route —— 让调用方把原因说清楚而不是换个通道悄悄跑。
 */
export async function buildMlxgenRoute(
  env: NodeJS.ProcessEnv = process.env,
  binding?: CaptionLocalBinding,
  deps: CaptionDeps = {},
): Promise<VisionRoute> {
  try {
    const r = await resolveCaptionConfigDetailed(env, binding, deps);
    if (r.ok) return { kind: 'mlxgen', config: r.config };
    // 原因由解析器给出(命令缺失 / 模型目录不存在 / 目录不是合格 checkpoint / 裸模型名匹配不到…)
    return { kind: 'mlxgen', reason: r.reason };
  } catch (e) {
    return { kind: 'mlxgen', reason: `本地 caption 通道解析失败:${(e as Error).message}` };
  }
}

/**
 * 解析本次看图用哪条通道(纯逻辑 + 注入,便于单测):
 *  - `BIGBOTART_CAPTION_BACKEND=endpoint|mlxgen` 显式指定(不可用也不换,报原因);
 *  - 缺省 `auto`:本机同时具备命令 + checkpoint 时优先**本地**(不依赖 LM Studio 是否在跑),
 *    否则走既有端点回退链(存量行为不变)。
 */
export async function resolveVisionRoute(
  env: NodeJS.ProcessEnv = process.env,
  deps: CaptionDeps = {},
): Promise<VisionRoute> {
  const mode = (env.BIGBOTART_CAPTION_BACKEND ?? 'auto').trim().toLowerCase();
  if (mode === 'endpoint') return endpointRoute(env);
  if (mode === 'mlxgen') return buildMlxgenRoute(env, undefined, deps);
  const local = await resolveCaptionConfig(env, undefined, deps).catch(() => undefined);
  return local ? { kind: 'mlxgen', config: local } : endpointRoute(env);
}

/**
 * 按用途组装反推指令(纯函数):每种用途给出不同侧重点的成稿要求。
 * ⚠️ **默认中文**(2026-10-12 用户反馈:反推出来的提示词全是英文,不符合中文产品预期)。
 * 需要英文提示词的场景(部分境外模型/社区工作流偏好英文)请显式选 `prompt-en` ——
 * 不靠「模型自己猜语言」,语言由指令写死,否则同一张图会时中时英。
 */
export function buildCaptionInstruction(style: string, extra?: string): string {
  const base =
    style === 'zimage'
      ? '写一条**中文**的文生图提示词(Z-Image 六段式:主体 / 场景 / 构图 / 光影 / 风格 / 约束),六段都要覆盖。' +
        '只输出提示词本身,不要任何前言或解释。'
      : style === 'h3'
        ? '写一条**中文**的视频生成提示词(H3 五段式:场景 / 动作 / 镜头 / 光影与风格 / 声音),镜头运动与光照要写明确。' +
          '只输出提示词本身,不要任何前言或解释。'
        : style === 'json'
          ? '用结构化 JSON 描述这张图,键固定为 subject / scene / composition / lighting / style / colors / details,' +
            '**值一律用中文**。只输出 JSON,不要任何前言或解释。'
          : style === 'prompt-en'
            ? 'Write a detailed **English** image-generation prompt describing this image. ' +
              'Cover subject, appearance, pose, scene, composition, lighting, style and quality. Output the prompt only, no preamble.'
            : '写一条**中文**的文生图提示词,详细描述这张图:主体与外貌、姿态动作、场景环境、构图与视角、光影、风格与画质。' +
              '只输出提示词本身,不要任何前言或解释。';
  if (!extra?.trim()) return base;
  const prefix = style === 'prompt-en' ? 'Additional requirement' : '附加要求';
  return `${base}\n\n${prefix}:${extra.trim()}`;
}

/** 视觉请求体构造(纯函数,便于单测):按协议选多模态消息形状(chat: image_url / responses: input_image) */
export function buildVisionRequest(
  model: string,
  dataUrl: string,
  instruction: string,
  maxTokens = 700,
  protocol: LlmProtocol = 'chat',
): Record<string, unknown> {
  return visionCallBody({ baseUrl: '', model, protocol }, dataUrl, instruction, maxTokens);
}

/** 端点通道执行体(原 captionImage 的 fetch 部分,行为零改动) */
async function captionViaEndpoint(
  endpoint: VisionEndpoint,
  imagePath: string,
  instruction: string,
): Promise<CaptionResult> {
  const mime = MIME_BY_EXT[extname(imagePath).slice(1).toLowerCase()] ?? 'image/png';
  const dataUrl = `data:${mime};base64,${readFileSync(imagePath).toString('base64')}`;
  const protocol = endpoint.protocol === 'responses' ? 'responses' : 'chat';
  const body = buildVisionRequest(endpoint.model, dataUrl, instruction, 700, protocol);

  const res = await fetch(textCallUrl(endpoint.baseUrl, protocol), {
    method: 'POST',
    headers: withOpenCodeGoHeaders(endpoint.baseUrl, `vision-${imagePath}`, {
      'Content-Type': 'application/json',
      ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
    }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `视觉端点返回 ${res.status}:${text.slice(0, 300)}` };
  }

  const json = await res.json().catch(() => undefined);
  const caption = extractTextResult(json, protocol).text;
  const errMsg = responseError(json);
  if (errMsg && !caption) return { ok: false, error: `视觉端点报错:${errMsg.slice(0, 200)}` };
  if (!caption) return { ok: false, error: '视觉模型返回空内容(可检查端点模型是否支持视觉输入)' };
  return { ok: true, caption, model: endpoint.model, backend: 'endpoint' };
}

/** 本地通道执行体(mlxgen-caption;命令/checkpoint 缺时把原因原样报出) */
async function captionViaMlxgen(
  route: Extract<VisionRoute, { kind: 'mlxgen' }>,
  imagePath: string,
  instruction: string,
  deps: CaptionDeps,
): Promise<CaptionResult> {
  if (!route.config) {
    return { ok: false, error: `本地看图通道不可用:${route.reason ?? '未解析到可用配置'}`, backend: 'mlxgen' };
  }
  const res = await runMlxgenCaption(route.config, imagePath, instruction, deps);
  if (!res.ok) return { ok: false, error: res.error, backend: 'mlxgen' };
  return { ok: true, caption: res.caption, model: res.model, backend: 'mlxgen' };
}

/** 按 route 派发(不负责校验,校验在 captionImage 里统一做) */
async function runRoute(
  route: VisionRoute,
  imagePath: string,
  instruction: string,
  deps: CaptionDeps,
): Promise<CaptionResult> {
  if (route.kind === 'endpoint') return captionViaEndpoint(route.endpoint, imagePath, instruction);
  return captionViaMlxgen(route, imagePath, instruction, deps);
}

/**
 * 反推指令 → 交给哪条通道(纯函数,便于单测回退规则)。
 * `explicit` = 调用方传入了通道(设置页「工具模型 → 看图反推」的绑定,或直接传入的端点)。
 * 这是用户的选择:失败就报失败,不因为环境变量仍是 auto 就换另一条。
 * 未显式传入时,才按 `BIGBOTART_CAPTION_BACKEND` 决定(endpoint|mlxgen 也不回退;auto 才互为兜底)。
 */
export function planFallback(
  primary: VisionRoute,
  env: NodeJS.ProcessEnv = process.env,
  explicit = false,
): 'endpoint' | 'mlxgen' | undefined {
  if (explicit) return undefined;
  if (env.BIGBOTART_CAPTION_FALLBACK === '0') return undefined;
  const mode = (env.BIGBOTART_CAPTION_BACKEND ?? 'auto').trim().toLowerCase();
  if (mode === 'mlxgen' || mode === 'endpoint') return undefined;
  return primary.kind === 'endpoint' ? 'mlxgen' : 'endpoint';
}

/**
 * 图片 → 提示词。
 * @param imagePath 图片绝对路径(须在产物/资产/导出白名单目录内)
 * @param style     'prompt'(通用**中文**详述,默认) | 'prompt-en'(通用英文) | 'zimage'(Z-Image 中文六段) | 'h3'(H3 中文五段) | 'json'(结构化,值中文)
 * @param extra     额外要求(追加到指令末尾)
 * @param route     看图通道。传入 = 显式选择(设置页绑定 / 调用方指定),失败不回退另一条通道。
 *                  不传 = 按 auto/环境变量解析,仅 auto 下主通道失败才回退。兼容传裸端点对象。
 * @param deps      注入点(单测用:which/exists/run —— 注入后不碰真模型)
 */
export async function captionImage(
  imagePath: string,
  style = 'prompt',
  extra?: string,
  route?: VisionRoute | VisionEndpoint,
  deps: CaptionDeps = {},
): Promise<CaptionResult> {
  try {
    if (!imagePath) return { ok: false, error: '图片路径为空' };
    if (!existsSync(imagePath)) return { ok: false, error: `图片文件不存在:${imagePath}` };

    // 白名单:只读产物/资产/导出目录,防任意读
    const roots = ffmpegReadRoots();
    if (!roots.some((r) => isUnderRoot(imagePath, r))) {
      return { ok: false, error: '图片不在允许目录(产物/资产/导出),拒绝读取' };
    }

    const ext = extname(imagePath).slice(1).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
      // 视频/音频是最常见的「传错源」:模型拿到一个 asset 节点就直接调本工具,不知道它是视频。
      // 错误信息必须给出**可直接执行的下一步**,否则模型要再摸索好几轮才绕得出来
      // (真实事故:对 mp4 调本工具报错后,又试了 get_node / 再调一次,共 3 轮才想到 frames.extract)。
      if (VIDEO_EXTS.has(ext)) {
        return {
          ok: false,
          error:
            `这是视频(${ext}),vision.caption 只能看**图片**,不能直接读视频。` +
            `请先用 frames.extract 从它取一帧(如 frames.extract { nodeId: "<该视频节点 id>", at: "first" }),` +
            `再用返回的节点/资产 id 调 vision.caption;若要分析视频中段画面,取帧时把 at 设为秒数(如 at: 298)。`,
        };
      }
      if (AUDIO_EXTS.has(ext)) {
        return { ok: false, error: `这是音频(${ext}),本工具只能看图片画面,无法分析音频内容。` };
      }
      return { ok: false, error: `不支持的图片格式:${ext || '(无扩展名)'}(支持 png/jpg/jpeg/webp/gif/bmp)` };
    }

    const size = statSync(imagePath).size;
    if (size > MAX_IMAGE_BYTES) {
      return { ok: false, error: `图片过大(${(size / 1e6).toFixed(1)}MB),上限 ${MAX_IMAGE_BYTES / 1e6}MB` };
    }

    const instruction = buildCaptionInstruction(style, extra);
    // 调用方传入 route(含裸端点对象)= 显式选择。设置页绑了本地或端点时走这里,
    // 不能再按环境变量 auto 去换另一条通道。
    const explicitRoute = route != null;
    const primary: VisionRoute = !route
      ? await resolveVisionRoute(process.env, deps)
      : 'kind' in route
        ? route
        : { kind: 'endpoint', endpoint: route };

    const first = await runRoute(primary, imagePath, instruction, deps);
    if (first.ok) return first;

    // 主通道失败 → 另一条通道兜底(仅「未显式指定」且 env=auto;显式选择失败就报失败)
    const alt = planFallback(primary, process.env, explicitRoute);
    if (!alt) return first;
    const altRoute: VisionRoute =
      alt === 'mlxgen' ? await buildMlxgenRoute(process.env, undefined, deps) : endpointRoute(process.env);
    // 兜底通道本身不可用/没配 → 保留主通道的原始错误(它才是真因)
    if (altRoute.kind === 'mlxgen' && !altRoute.config) return first;
    const second = await runRoute(altRoute, imagePath, instruction, deps);
    if (!second.ok) {
      return { ...first, error: `${first.error};回退${alt} 也失败:${second.error}` };
    }
    return {
      ...second,
      note: `主通道(${primary.kind === 'endpoint' ? `端点 ${primary.endpoint.baseUrl}` : '本地 mlxgen-caption'})失败,已回退${alt === 'mlxgen' ? '本地 mlxgen-caption' : '视觉端点'}:${first.error}`,
    };
  } catch (e) {
    return { ok: false, error: `反推失败:${(e as Error).message}` };
  }
}
