/**
 * VisionTool — 图片反推提示词(Agent `vision.caption`)
 *
 * 背景:Agent 主 LLM 通道是**纯文本**的(pi-chat.ts 声明 `input:['text']`,图片像素
 * 从不进入主模型上下文)。因此「看着图反推提示词」这类任务主模型做不到 ——
 * 过去它只能盲目建一个节点来「代替回答」。
 *
 * 本模块把「看图」拆成独立一步:调**视觉模型端点**(LM Studio 里的 VL 模型,或任意
 * OpenAI 兼容多模态端点),把图片转成文字描述,再交回主 LLM 按需成稿。
 * 主链路(pi-chat)零改动,主模型不需要具备视觉能力。
 *
 * 安全:只允许读产物/资产/导出目录下的图片(与 frames.ts 同白名单口径),防任意读。
 * 错误:一律显式返回,不静默吞(AGENTS.md R6)。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { ffmpegReadRoots, isUnderRoot } from './assets';

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
}

export interface CaptionResult {
  ok: boolean;
  /** 反推出的提示词文本 */
  caption?: string;
  model?: string;
  error?: string;
}

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
  return { baseUrl: base.replace(/\/+$/, ''), apiKey, model };
}

/** 按用途组装反推指令(纯函数):每种用途给出不同侧重点的成稿要求 */
export function buildCaptionInstruction(style: string, extra?: string): string {
  const base =
    style === 'zimage'
      ? 'Write a single Chinese text-to-image prompt (Z-Image 六段式:主体/场景/构图/光影/风格/约束). ' +
        'Cover subject, scene, composition, lighting, style and constraints. Output the prompt only, no preamble.'
      : style === 'h3'
        ? 'Write a single Chinese video-generation prompt in H3 five-section form: Scene(场景)/ Action(动作)/ Camera(镜头)/ Look(光影与风格)/ Audio(声音). ' +
          'Describe camera movement and lighting explicitly. Output the prompt only, no preamble.'
        : style === 'json'
          ? 'Describe the image as structured JSON with keys: subject, scene, composition, lighting, style, colors, details. Output JSON only.'
          : 'Write a detailed English image-generation prompt describing this image. Cover subject, appearance, pose, scene, composition, lighting, style and quality. Output the prompt only, no preamble.';
  return extra?.trim() ? `${base}\n\nAdditional requirement: ${extra.trim()}` : base;
}

/** 视觉请求体构造(纯函数,便于单测):OpenAI 兼容多模态消息格式 */
export function buildVisionRequest(
  model: string,
  dataUrl: string,
  instruction: string,
  maxTokens = 700,
): Record<string, unknown> {
  return {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: instruction },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: maxTokens,
    temperature: 0.2,
  };
}

/**
 * 图片 → 提示词。
 * @param imagePath 图片绝对路径(须在产物/资产/导出白名单目录内)
 * @param style     'prompt'(通用英文) | 'zimage'(Z-Image 中文六段) | 'h3'(H3 五段) | 'json'(结构化)
 * @param extra     额外要求(追加到指令末尾)
 */
export async function captionImage(
  imagePath: string,
  style = 'prompt',
  extra?: string,
  endpoint: VisionEndpoint = resolveVisionEndpoint(),
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

    const dataUrl = `data:${mime};base64,${readFileSync(imagePath).toString('base64')}`;
    const body = buildVisionRequest(endpoint.model, dataUrl, buildCaptionInstruction(style, extra));

    const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `视觉端点返回 ${res.status}:${text.slice(0, 300)}` };
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    // 视觉模型 content 可能是字符串或多模态块数组,两种都兜住
    const raw = json.choices?.[0]?.message?.content;
    const caption =
      typeof raw === 'string'
        ? raw.trim()
        : Array.isArray(raw)
          ? raw
              .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text?: unknown }).text ?? '') : ''))
              .join('')
              .trim()
          : '';

    if (!caption) return { ok: false, error: '视觉模型返回空内容(可检查端点模型是否支持视觉输入)' };
    return { ok: true, caption, model: endpoint.model };
  } catch (e) {
    return { ok: false, error: `反推失败:${(e as Error).message}` };
  }
}
