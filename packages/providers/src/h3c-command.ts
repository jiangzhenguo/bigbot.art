/**
 * h3.c CLI 命令构造器 — 业务参数 → h3 命令行参数
 *
 * 依据 h3c-usage skill 的事实:
 * - 必须: -d MODEL_DIR、-p PROMPT;给 -o 则非交互生成
 * - 宽高须 32 的倍数,乘积 ≤ 768*1344;帧数自动对齐 5+17n(交由 h3 自身处理)
 * - 档位防呆:禁用 layers40+reuse3+token-reduction 组合等
 */

import {
  validateShotSubmitParams,
  referenceCombinationIssues,
  SHOT_SIZES,
  VIDEO_TIER_PRESETS,
  type QualityTier,
} from '@bigbotart/shared';

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
  /**
   * 二采(second pass)重跑 sigma 网格尾部的比例 F,必须 0<F<1。
   * ⚠️ 由 shared `planSecondPass` 解析后传入,**这里不再夹取**(夹取规则只有一份)。
   */
  secondPass?: number;
  /** 画布二采的第二遍画布(`--second-pass-canvas`);**必须与 secondPass 同时给**,否则引擎 exit 2 */
  secondPassCanvas?: { width: number; height: number };
  /** 画布二采第一遍的内部渲染画布(`--render-width/--render-height`);两值必须成对 */
  renderWidth?: number;
  renderHeight?: number;
  /** 加速选项(骨架期不开放) */
  extra?: string[];
}

/**
 * 引擎侧档位表 —— **数值全部来自 shared 的 `VIDEO_TIER_PRESETS`**(全链唯一真源),
 * 这里只补引擎需要的「1:1 锚点尺寸」(取自 `SHOT_SIZES['1:1']`)。
 *
 * ⚠️ 这张表此前在 providers 与渲染层各写一份且**数值分叉过**(弹窗 ETA 与检查器 ETA
 *    不一致,见 docs/连接器设计.md)。现在 ETA / 步数只有 shared 一处。
 * ⚠️ **etaMin 的口径 = 本机实测标定(2026-10-25),不是上游文档抄数**:
 *    h3 把视频 VAE 的 ViT 解码器从 FP32 改成 BF16(MPS 张量核):960×544×124 的解码
 *    159.45s → 47.33s(3.37x),端到端 409.95s → 316.93s,VAE 峰值显存 9.37 → 4.68 GiB。
 *    VAE 解码耗时 ∝ 帧数 × 像素数,按各档位折算端到端各省 0.13 / 0.48 / 1.06 / 2.11 分钟
 *    (预览 / 草稿 / 默认 / 参考)→ 旧值 4/9/15/30 取整为 4/9/14/28。
 *    推导过程见 `packages/shared/src/prompt.ts` 的 `VIDEO_TIER_PRESETS` 注释。
 */
export interface H3TierPreset {
  label: string;
  width: number;
  height: number;
  frames: number;
  steps: number;
  layers: number;
  reuse: number;
  etaMin: number;
  note: string;
}

export const TIER_PRESETS: Record<QualityTier, H3TierPreset> = buildTierPresets();

function buildTierPresets(): Record<QualityTier, H3TierPreset> {
  const out = {} as Record<QualityTier, H3TierPreset>;
  for (const tier of Object.keys(VIDEO_TIER_PRESETS) as QualityTier[]) {
    const preset = VIDEO_TIER_PRESETS[tier];
    const size = SHOT_SIZES['1:1'][tier];
    out[tier] = {
      label: preset.label,
      width: size.width,
      height: size.height,
      frames: preset.frames,
      steps: preset.steps,
      layers: preset.layers,
      reuse: preset.reuse,
      etaMin: preset.etaMin,
      note: preset.note,
    };
  }
  return out;
}

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

/* ───────────────────────── 二采(second pass)参数面 ───────────────────────── */

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0;
}

/**
 * 二采比例是否可用:h3 只认 0<F<1。
 *
 * 依据 `h3.c` 的 `h3_valid_params`(以及 `--second-pass-canvas` 的报错文案
 * "a second-pass canvas needs a fraction in (0, 1)"):F=0 表示一步都不重跑
 * (等于开关没生效),F=1 表示整段重画(构图会变),两者都不是「二采」的语义。
 * NaN / ±Infinity / 负数同样拒收 —— 生成环境变量的字符串数字时很容易漏掉这层。
 */
export function isValidSecondPassFraction(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1;
}

/**
 * 第一遍的内部渲染画布:**成对且为正整数**才成立。
 *
 * 引擎要求 `--render-width` / `--render-height` 成对;只给一边时它不会用你的画布,
 * 第一遍照旧在输出尺寸跑 —— 画布二采于是「花两遍时间却没有额外细节」,
 * 属于最典型的假成功(用户看不出哪里不对,只觉得慢)。所以宁可一个 flag 都不输出。
 */
export function resolveRenderCanvas(
  opts: Pick<H3CliOptions, 'renderWidth' | 'renderHeight'>,
): { width: number; height: number } | undefined {
  const { renderWidth, renderHeight } = opts;
  if (!isPositiveInt(renderWidth) || !isPositiveInt(renderHeight)) return undefined;
  return { width: renderWidth, height: renderHeight };
}

/**
 * 第二遍画布 `--second-pass-canvas`:**只有 F 合法时才允许出现**。
 *
 * 引擎硬约束:只给画布不给 F 会直接 exit 2
 * ("a second-pass canvas needs a fraction in (0, 1)"),而这个失败发生在
 * **任务入队后**——用户以为提交成功了,等几分钟才看到失败。构建器因此绝不输出裸 flag。
 */
export function resolveSecondPassCanvas(
  opts: Pick<H3CliOptions, 'secondPass' | 'secondPassCanvas'>,
): { width: number; height: number } | undefined {
  if (!isValidSecondPassFraction(opts.secondPass)) return undefined;
  const canvas = opts.secondPassCanvas;
  if (!canvas || !isPositiveInt(canvas.width) || !isPositiveInt(canvas.height)) return undefined;
  return { width: canvas.width, height: canvas.height };
}

/**
 * 参数组合统一防呆(提交前调用,返回所有违规说明;空数组 = 安全)。
 *
 * 覆盖:
 *  ① 档位危险组合(layers≤40 + reuse≥3):易出鬼影/振铃 —— **拒绝**;
 *  ② 带内嵌音轨的参考视频 + 输出时长不足 2 秒(h3.c:1146 硬规则)—— **拒绝**,
 *     并给出「忽略音轨」这条绕法(--ref-silent-video 不走 truncate 分支,短时长合法);
 *  ③ reuse 配极少步数:模型新鲜评估太少,画质/多样性下降 —— **警告**(沿用 h3 自己的判断);
 *  ④ 尺寸/时长硬约束(32 倍数、面积上限、单段 ≤15s / 帧 5..362)—— **拒绝**
 *     (shared.validateShotSubmitParams;传入 width/height 时生效);
 *  ⑤ 二采参数脏值(F 不在 (0,1) / 只给二采画布不给 F / render 画布不成对)—— **拒绝**
 *     (只拦**直接调用方**;provider 走 shared 的 planSecondPass,传过来的永远合法)。
 *
 * ② 为什么必须拦:带音轨的 ref-video 端口现在已经全链路打通(asset / 上游镜头 / 视频增强都可连),
 * 而 preview 档只有 22 帧(≈0.92s)—— 组合起来必炸,且 h3 的报错发生在**入队之后**,
 * 错误信息(`video soundtrack 2 requires at least 2 seconds`)看不出该怎么改。真实事故 2026-09。
 */
export function validateParams(
  // width/height 可选(H3CliOptions 里是必填,Pick 会继承必填 ⇒ 老用例只传 steps/frames 会编译失败;
  // 运行时本就以 `width != null` 判生效,类型口径对齐成 Partial)
  opts: Pick<H3CliOptions, 'steps' | 'layers' | 'reuse' | 'frames' | 'seconds' | 'refVideo' | 'refVideoSilent'> &
    Pick<
      Partial<H3CliOptions>,
      'width' | 'height' | 'secondPass' | 'secondPassCanvas' | 'renderWidth' | 'renderHeight' | 'firstFrame' | 'lastFrame' | 'refImages' | 'refAudio'
    >,
): string[] {
  const issues = validateTier(opts);

  // ④ 尺寸 + 时长(有宽高时才拦;旧调用方只传 steps/frames 的用例保持兼容)
  if (opts.width != null || opts.height != null) {
    issues.push(
      ...validateShotSubmitParams({
        width: opts.width,
        height: opts.height,
        seconds: opts.seconds,
        frames: opts.frames,
      }),
    );
  }

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

  // ⑤ 二采比例:防御性闸(只针对**直接调用方**传脏值)。
  //    provider 走 shared 的 planSecondPass,那里已把 F 夹进合法区间,所以这里永不误伤;
  //    但 buildH3Args/validateParams 是包级公开 API(脚本/测试会用),
  //    非法 F 会被构建器静默丢弃 —— 静默丢弃正是本项目反复出现的「假成功」,
  //    故在提交前明确拒绝并说清 0 与 1 为什么不合法。
  if (opts.secondPass != null && !isValidSecondPassFraction(opts.secondPass)) {
    issues.push(
      `二采比例 --second-pass 必须满足 0<F<1(当前 ${String(opts.secondPass)}):` +
        `F 是「重跑 sigma 网格尾部的比例」,0 等于不跑(开关形同未开)、1 等于整段重画(构图会变)。` +
        `同画布精修推荐 0.1~0.2,画布二采推荐 0.4(画布二采下限 0.35,更低会保留上采样鬼影)。`,
    );
  }

  // ⑥ 二采画布必须配合法的 F —— 否则 h3 入队后才 exit 2,
  //    用户视角是「提交成功、等了几分钟才失败」,比提前拒绝糟得多。
  if (opts.secondPassCanvas != null && !isValidSecondPassFraction(opts.secondPass)) {
    const c = opts.secondPassCanvas;
    issues.push(
      `给了二采画布(--second-pass-canvas ${c?.width}x${c?.height})却没有合法的 --second-pass 比例:` +
        `h3 会以 "a second-pass canvas needs a fraction in (0, 1)" exit 2。` +
        `请同时给出 0<F<1(画布二采推荐 0.4),或去掉二采画布。`,
    );
  }

  // ⑦ 第一遍渲染画布必须成对:只给一边时引擎不会使用该画布,第一遍仍在输出尺寸跑,
  //    画布二采等于「多花一遍时间、不多一点细节」。不报错就会被当成已生效。
  const hasRenderW = opts.renderWidth != null;
  const hasRenderH = opts.renderHeight != null;
  if (hasRenderW !== hasRenderH || (hasRenderW && hasRenderH && !resolveRenderCanvas(opts))) {
    issues.push(
      `--render-width / --render-height 必须成对给出且为正整数` +
        `(当前 width=${String(opts.renderWidth)}, height=${String(opts.renderHeight)}):` +
        `只给一边或给 0/非整数时 h3 不会使用该画布,第一遍仍按输出画布跑,画布二采只会白花一遍时间。`,
    );
  }

  // ⑧ 参考组合(h3 引擎硬校验,规则说明见 shared.referenceCombinationIssues):
  //    ① --ref-image/--ref-video/--ref-audio 与 --first-frame/--last-frame 互斥;
  //    ② --ref-audio 不能单独存在(必须搭配 --ref-image 或 --ref-video)。
  //    这里用**同一份 shared 规则**(角色口径 ↔ CLI 口径的映射在本地做),避免两处各写一套。
  //    ⚠️ 只在给了参考相关字段时才判(老用例只传 steps/frames,不受影响)。
  const refRoles: Array<{ role?: string }> = [];
  if (opts.firstFrame) refRoles.push({ role: 'first-frame' });
  if (opts.lastFrame) refRoles.push({ role: 'last-frame' });
  if (opts.refImages?.length) refRoles.push({ role: 'ref-image' });
  if (opts.refVideo) refRoles.push({ role: 'ref-video' });
  if (opts.refAudio) refRoles.push({ role: 'ref-audio' });
  if (refRoles.length > 0) {
    issues.push(...referenceCombinationIssues(refRoles).map((i) => i.message));
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
  // ── 二采(second pass)──
  // 顺序按 h3c-usage 的推荐配方:第一遍渲染画布 → F → 第二遍画布。
  // 引擎硬约束(`h3.c` 的 `h3_valid_params`):`--second-pass-canvas` 必须配
  // `--second-pass F`,只给画布会 "a second-pass canvas needs a fraction in (0, 1)" exit 2。
  // 因此画布只在 F 合法时才输出。**绝不产出裸 flag** —— 那个失败发生在任务入队之后,
  // 用户以为提交成功了、等几分钟才看到失败(比提前拒绝误导得多)。
  const renderCanvas = resolveRenderCanvas(opts);
  if (renderCanvas) {
    args.push('--render-width', String(renderCanvas.width), '--render-height', String(renderCanvas.height));
  }
  if (isValidSecondPassFraction(opts.secondPass)) {
    // String(F) 而不是 toFixed:二采的 F 直接换算成重跑步数(round(steps*(1-F))),
    // 四舍五入会悄悄改变耗时与质感(0.125 → 0.13 就差半步)
    args.push('--second-pass', String(opts.secondPass));
    const spCanvas = resolveSecondPassCanvas(opts);
    if (spCanvas) args.push('--second-pass-canvas', `${spCanvas.width}x${spCanvas.height}`);
  }
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