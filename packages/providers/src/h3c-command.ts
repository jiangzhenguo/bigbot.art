/**
 * h3.c CLI 命令构造器 — 业务参数 → h3 命令行参数
 *
 * 依据 h3c-usage skill 的事实:
 * - 必须: -d MODEL_DIR、-p PROMPT;给 -o 则非交互生成
 * - 宽高须 32 的倍数,乘积 ≤ 768*1344;帧数自动对齐 5+17n(交由 h3 自身处理)
 * - 档位防呆:禁用 layers40+reuse3+token-reduction 组合等
 */

import type { QualityTier } from '@bigbotart/shared';

export interface H3CliOptions {
  modelDir: string;
  prompt: string;
  outputPath: string;
  width: number;
  height: number;
  frames: number;
  steps: number;
  layers: number;
  reuse: number;
  seed: number;
  /** 秒数(24fps);给定时替代 frames 用 --seconds */
  seconds?: number;
  /** SSD 流式读权重:内存紧张时开启,省 RAM 但更慢(默认关;64GB+ 实测关更快 ~30%) */
  ssdStreaming?: boolean;
  /** 条件控制文件 */
  firstFrame?: string;
  lastFrame?: string;
  refImages?: string[];
  refVideo?: string;
  refAudio?: string;
  /** 加速选项(骨架期不开放) */
  extra?: string[];
}

/** 档位模板说明(供 UI 显示 & 防呆)— 与 H3_USAGE.md §4.3 对齐 */
export const TIER_PRESETS: Record<QualityTier, { label: string; width: number; height: number; frames: number; steps: number; layers: number; reuse: number; etaMin: number; note: string }> = {
  preview:  { label: '预览构图', width: 448, height: 448, frames: 22,  steps: 6,  layers: 40, reuse: 2, etaMin: 4,  note: '极速草稿 · ~4 分钟(reuse2,避开防呆组合)' },
  draft:    { label: '快草稿',   width: 544, height: 544, frames: 56,  steps: 12, layers: 50, reuse: 2, etaMin: 9,  note: '快速出片 · ~7-10 分钟' },
  default:  { label: '默认质量', width: 544, height: 544, frames: 124, steps: 20, layers: 50, reuse: 1, etaMin: 15, note: '5s 段甜点 · ~14-18 分钟' },
  reference:{ label: '参考质量', width: 768, height: 768, frames: 124, steps: 30, layers: 50, reuse: 1, etaMin: 30, note: 'high quality · ~30-50 分钟,gold 档' },
};

/** 比例 → 不同 tier 下的实际宽高(全部 32 倍数,来自 H3_USAGE.md §4.2 合法档) */
export const ASPECT_SIZES: Record<'16:9' | '9:16' | '1:1', Record<QualityTier, { width: number; height: number }>> = {
  '16:9': {
    preview:   { width: 864, height: 480 },
    draft:     { width: 864, height: 480 },
    default:   { width: 864, height: 480 },
    reference: { width: 1280, height: 704 },
  },
  '9:16': {
    preview:   { width: 480, height: 864 },
    draft:     { width: 480, height: 864 },
    default:   { width: 576, height: 1024 },
    reference: { width: 704, height: 1280 },
  },
  '1:1': {
    preview:   { width: 448, height: 448 },
    draft:     { width: 544, height: 544 },
    default:   { width: 544, height: 544 },
    reference: { width: 768, height: 768 },
  },
};

/** 比例 × 档位 → 具体宽高(custom 返回 null,让 UI 用 customWidth/customHeight) */
export function resolveDimensions(
  aspect: '16:9' | '9:16' | '1:1' | 'custom',
  tier: QualityTier,
  customWidth?: number,
  customHeight?: number,
): { width: number; height: number } {
  if (aspect === 'custom') {
    const w = Math.max(32, Math.round((customWidth ?? 544) / 32) * 32);
    const h = Math.max(32, Math.round((customHeight ?? 544) / 32) * 32);
    return clampDimension(w, h);
  }
  const size = ASPECT_SIZES[aspect][tier];
  return clampDimension(size.width, size.height);
}

/** 校验并规整宽高:32 的倍数,乘积 ≤ 768*1344 */
export function clampDimension(w: number, h: number): { width: number; height: number } {
  let width = Math.max(32, Math.round(w / 32) * 32);
  let height = Math.max(32, Math.round(h / 32) * 32);
  // 乘积超限时按比例缩
  const maxArea = 768 * 1344;
  if (width * height > maxArea) {
    const scale = Math.sqrt(maxArea / (width * height));
    width = Math.max(32, Math.floor((width * scale) / 32) * 32);
    height = Math.max(32, Math.floor((height * scale) / 32) * 32);
  }
  return { width, height };
}

/** 危险组合防呆;返回所有违规说明(空数组 = 安全) */
export function validateTier(options: Pick<H3CliOptions, 'steps' | 'layers' | 'reuse'>): string[] {
  const issues: string[] = [];
  if ((options.layers ?? 50) <= 40 && (options.reuse ?? 1) >= 3) {
    issues.push('layers≤40 + reuse≥3 组合易出鬼影/振铃,已拒绝提交(请提高 layers 或降低 reuse)');
  }
  if (options.steps < 8 && options.layers >= 50 && options.reuse <= 2) {
    // 预览档快速;允许,仅提示
  }
  return issues;
}

/** 把选项构造成 h3 CLI 参数数组 */
export function buildH3Args(opts: H3CliOptions): string[] {
  const { width, height } = clampDimension(opts.width, opts.height);
  const args: string[] = [];
  args.push('-d', opts.modelDir);
  args.push('--width', String(width));
  args.push('--height', String(height));
  // seconds 优先(24fps),否则用 frames
  if (opts.seconds && opts.seconds > 0) args.push('--seconds', String(opts.seconds));
  else args.push('--frames', String(opts.frames));
  args.push('--steps', String(opts.steps));
  args.push('--layers', String(opts.layers));
  args.push('--reuse', String(opts.reuse));
  args.push('--seed', String(opts.seed));
  if (opts.firstFrame) args.push('--first-frame', opts.firstFrame);
  if (opts.lastFrame) args.push('--last-frame', opts.lastFrame);
  for (const img of opts.refImages ?? []) args.push('--ref-image', img);
  if (opts.refVideo) args.push('--ref-video', opts.refVideo);
  if (opts.refAudio) args.push('--ref-audio', opts.refAudio);
  if (opts.ssdStreaming === true) args.push('--ssd-streaming');
  for (const e of opts.extra ?? []) args.push(e);
  args.push('-p', opts.prompt);
  args.push('-o', opts.outputPath);
  return args;
}

/** 生成 h3 五段式提示词(Scene/Action/Camera/Look/Audio)— 骨架期确定性模板 */
export function buildH3Prompt(input: {
  scene: string;
  action: string;
  camera: string;
  look: string;
  audio: string;
}): string {
  return [
    `Scene: ${input.scene}`,
    `Action: ${input.action}`,
    `Camera: ${input.camera}`,
    `Look: ${input.look}`,
    `Audio: ${input.audio}`,
  ].join('\n');
}