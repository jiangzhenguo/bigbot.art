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
  /** 参考视频是否忽略源片内嵌音轨:true → --ref-silent-video,false/缺省 → --ref-video(连音轨一起注入) */
  refVideoSilent?: boolean;
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

/** 已知比例集合(h3 合法档;`custom` 不在此列 —— 它走 customWidth/customHeight) */
export type KnownAspect = '16:9' | '9:16' | '1:1' | '4:3' | '3:4';

/**
 * 比例 → 不同 tier 下的实际宽高(全部 32 倍数,来自 H3_USAGE.md §4.2 合法档)。
 *
 * 4:3 / 3:4 是 2026-10 新增的:此前视频只有 16:9 / 9:16 / 1:1 三种,而
 * 「参考图生成(Ref2VA)」的常见参考图本身是 4:3(相机/多数图片素材比例),
 * 没有对应档位就只能退化成 1:1 或 16:9,构图被裁。
 *
 * ⚠️ **严格比例 + 严格 32 倍数同时成立时,档位是离散的**:
 * 设 w=32a、h=32b,要求 w/h=4/3 ⇒ a/b=4/3 ⇒ a=4k, b=3k ⇒
 *   - 4:3:w=128k, h=96k
 *   - 3:4:w=96k,  h=128k
 * 下面的取值即按此网格挑选,**与同级 16:9 / 9:16 档位的面积尽量对齐**
 * (preview/draft/default 取 0.31–0.44MP,reference 取 0.79–1.0MP),
 * 保证切比例不会意外改变速度档位。
 * 校验见 `h3c-command.test.ts` 的「比例档位合法性」组(宽高 32 倍数 + 比例精确)。
 */
export const ASPECT_SIZES: Record<KnownAspect, Record<QualityTier, { width: number; height: number }>> = {
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
  // 128k × 96k(k=3/4/5 对应 0.31/0.44/0.60 MP;reference 取 k=8 = 0.79MP)
  '4:3': {
    preview:   { width: 640, height: 480 },
    draft:     { width: 768, height: 576 },
    default:   { width: 896, height: 672 },
    reference: { width: 1024, height: 768 },
  },
  // 96k × 128k(与 4:3 严格旋转对称,同一 k 网格)
  '3:4': {
    preview:   { width: 480, height: 640 },
    draft:     { width: 576, height: 768 },
    default:   { width: 672, height: 896 },
    reference: { width: 768, height: 1024 },
  },
};

/** 比例 × 档位 → 具体宽高(custom 返回 null,让 UI 用 customWidth/customHeight) */
export function resolveDimensions(
  aspect: KnownAspect | 'custom',
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

/** h3 输出帧率(与 h3.c 的 H3_FPS 一致) */
export const H3_FPS = 24;

/**
 * 带**内嵌音轨**的参考视频要求的最小输出时长(h3 硬规则)。
 *
 * 依据 h3.c:1146(truncate 分支):
 *     max_samples = condition_frames[visual] * 32000 / H3_FPS;
 *     if (max_samples < 64000)  → "video soundtrack %zu requires at least 2 seconds;
 *                                  request at least 56 output frames"
 * 即输出 < 2 秒(64000/32000)时,h3 无法从参考视频里截出足够音轨,直接 exit 1。
 * h3 自己建议 ≥56 帧(56/24 ≈ 2.33s,兼顾 5+17n 帧数对齐)。
 */
export const MIN_SOUNDTRACK_SECONDS = 2;
export const MIN_SOUNDTRACK_FRAMES = 56;

/** 输出时长(秒):seconds 优先,否则 frames / H3_FPS */
export function outputSeconds(opts: Pick<H3CliOptions, 'frames' | 'seconds'>): number {
  if (opts.seconds && opts.seconds > 0) return opts.seconds;
  return (opts.frames ?? 0) / H3_FPS;
}

/**
 * 参数组合统一防呆(提交前调用,返回所有违规说明;空数组 = 安全)。
 *
 * 覆盖三件事:
 *  ① 档位危险组合(layers≤40 + reuse≥3):易出鬼影/振铃 —— **拒绝**;
 *  ② 带内嵌音轨的参考视频 + 输出时长不足 2 秒(h3.c:1146 硬规则)—— **拒绝**,
 *     并给出「忽略音轨」这条绕法(--ref-silent-video 不走 truncate 分支,短时长合法);
 *  ③ reuse 配极少步数:模型新鲜评估太少,画质/多样性下降 —— **警告**(沿用 h3 自己的判断)。
 *
 * ② 为什么必须拦:带音轨的 ref-video 端口现在已经全链路打通(asset / 上游镜头 / 视频增强都可连),
 * 而 preview 档只有 22 帧(≈0.92s)—— 组合起来必炸,且 h3 的报错发生在**入队之后**,
 * 错误信息(`video soundtrack 2 requires at least 2 seconds`)看不出该怎么改。真实事故 2026-09。
 */
export function validateParams(
  opts: Pick<H3CliOptions, 'steps' | 'layers' | 'reuse' | 'frames' | 'seconds' | 'refVideo' | 'refVideoSilent'>,
): string[] {
  const issues = validateTier(opts);

  // ② 带音轨参考视频的时长下限
  const hasAudioRefVideo = !!opts.refVideo && opts.refVideoSilent !== true;
  if (hasAudioRefVideo) {
    const secs = outputSeconds(opts);
    if (secs < MIN_SOUNDTRACK_SECONDS) {
      issues.push(
        `参考视频带音轨时,h3 要求输出时长 ≥ ${MIN_SOUNDTRACK_SECONDS} 秒(否则无法从参考片截取音轨)——` +
          `当前 ${secs.toFixed(2)} 秒(${opts.frames ?? 0} 帧)。两个修法任选:` +
          `① 把时长提到 ≥ ${MIN_SOUNDTRACK_SECONDS} 秒(帧数 ≥ ${MIN_SOUNDTRACK_FRAMES},如 draft/default 档);` +
          `② 只想借参考视频的画面/动作时,勾选「忽略参考视频音轨」(改走 --ref-silent-video,不再受该限制)`,
      );
    }
  }

  // ③ reuse 配极少步数:与 h3 的 warning 同口径,但提前到提交前告知
  if ((opts.reuse ?? 1) >= 2 && (opts.steps ?? 0) < 8) {
    issues.push(
      `警告:--reuse ${opts.reuse} 配 ${opts.steps} 步时,模型新鲜评估次数很少,画面质量与多样性会下降` +
        `(h3 亦会提示 "leaves very few fresh model evaluations")。建议 reuse 1,或把步数提到 ≥8。`,
    );
  }
  return issues;
}

/** 危险组合防呆;返回所有违规说明(空数组 = 安全) */
export function validateTier(options: Pick<H3CliOptions, 'steps' | 'layers' | 'reuse'>): string[] {
  const issues: string[] = [];
  if ((options.layers ?? 50) <= 40 && (options.reuse ?? 1) >= 3) {
    issues.push('layers≤40 + reuse≥3 组合易出鬼影/振铃,已拒绝提交(请提高 layers 或降低 reuse)');
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
  // 参考视频:默认 --ref-video(连源片内嵌音轨一起注入);勾「忽略音轨」走 --ref-silent-video
  if (opts.refVideo) args.push(opts.refVideoSilent === true ? '--ref-silent-video' : '--ref-video', opts.refVideo);
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