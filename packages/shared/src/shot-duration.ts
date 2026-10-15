/**
 * 镜头时长归一化 + 提交前尺寸/时长校验(Agent 建镜 / 提交共用)
 *
 * 2026-10-13「技能3」事故:Agent 建「镜头 01 · 15s Hook」只写了标题,
 * data 里没有 seconds;后来节点落到 preview 档 frames=22(≈0.9s),提交秒数全错。
 *
 * 约定与渲染层 ShotInspector 同口径:
 *   - seconds > 0 优先于 frames(h3 `--seconds`)
 *   - 单段上限 SHOT_MAX_SECONDS(= h3 对齐后 362 帧 ≈15.08s)
 *   - 帧数按 24fps 后对齐 5+17n
 *   - Agent 默认用 SHOT_DEFAULT_SECONDS,非必要不写满 15
 */

/** h3 输出帧率 */
export const H3_FPS = 24;

/**
 * 单段时长上限(秒)。
 * h3.c 硬上限是对齐后 5..362 帧(≈15.08s);App 放宽到 15 与引擎对齐。
 * 与渲染层 constants.SHOT_MAX_SECONDS 同口径(那边 re-export 本常量)。
 */
export const SHOT_MAX_SECONDS = 15;

/** Agent/建节点未写时长时的缺省(default 档甜点 ≈124 帧) */
export const SHOT_DEFAULT_SECONDS = 5;

/** h3.c: frames must align within the released 5..362 range */
export const H3_MIN_FRAMES = 5;
export const H3_MAX_FRAMES = 362;

/** h3.c H3_MAX_PIXELS / H3_CANVAS_MULTIPLE */
export const H3_MAX_PIXELS = 768 * 1344;
export const H3_DIM_MULTIPLE = 32;

/** h3.c 帧数对齐:向上进位到 5+17n */
export function h3AlignFrames(frames: number): number {
  const v = Math.max(H3_MIN_FRAMES, Math.round(frames));
  const rem = ((v - 5) % 17 + 17) % 17;
  return rem === 0 ? v : v + 17 - rem;
}

/** 秒 → 对齐后的帧数 */
export function h3FramesForSeconds(seconds: number): number {
  return h3AlignFrames(seconds * H3_FPS);
}

/**
 * 从标题/文案里抠时长提示:「15s」「15 秒」「约15秒 Hook」。
 * 取**第一个**命中;没有则 undefined。
 *
 * ⚠️ 会命中区间写法「0-3秒」里的 3 —— 要认**总时长**请用 `parseTotalDurationHint`。
 */
export function parseDurationHint(text: string): number | undefined {
  // 不用 \b 收尾:中文「秒」后往往不是 ASCII 词界,「15秒」会被 \b 判失败
  const m = String(text ?? '').match(/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s|秒)(?![a-zA-Z0-9])/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

/**
 * 从提示词/画面描述里抠**成片总时长**(不认「0-3秒」这类区间切片)。
 *
 * 2026-10-13「技能4」事故:单镜 15s 被 storyboard.plan 拆成多行(时长列 4/5/6/4),
 * Agent 删掉多余镜后只留首行 → data.seconds=4,但 prompt 仍写「单镜15秒 / seconds=15」。
 * 必须认总时长标记,不能用 parseDurationHint(会先命中「0-3秒」→ 3)。
 */
export function parseTotalDurationHint(text: string): number | undefined {
  const s = String(text ?? '');
  if (!s.trim()) return undefined;
  const patterns = [
    /seconds\s*=\s*(\d+(?:\.\d+)?)/i,
    /(?:单镜|一条|全程|总时长?|成片)\s*(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s|秒)/i,
    /(?:^|\n)\s*(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s|秒)\s*[,，][^\n]{0,40}16\s*:\s*9/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/**
 * 分镜表行 → 铺节点用的秒数:时长列与画面/提示词里的总时长标记取较大者。
 * 典型:时长列写 4、画面描述写「单镜15秒」→ 15。
 */
export function resolveMaterializeSeconds(
  rowSeconds: number,
  ...texts: Array<string | undefined>
): number {
  let best = Number.isFinite(rowSeconds) && rowSeconds > 0 ? rowSeconds : 0;
  for (const t of texts) {
    const h = parseTotalDurationHint(t ?? '');
    if (h !== undefined && h > best) best = h;
  }
  return best;
}

export interface NormalizeShotDurationResult {
  data: Record<string, unknown>;
  changed: boolean;
  /** 给人/模型看的说明(截断、从标题识别、默认值) */
  note?: string;
}

/**
 * 把 shot.data 的 seconds/frames 规整成可提交状态。
 *
 * 优先级:
 *   1. 提示词/标题里的**总时长标记**(单镜15秒 / seconds=15)若大于 data.seconds → 覆盖
 *      (技能4:文案写 15s、参数留着拆行后的 4s)
 *   2. data.seconds > 0 → 以此为准,同步 frames
 *   3. 否则若 label 能抠出时长 → 写入 seconds(+frames)
 *   4. 否则若已有 frames > 0 → 尊重帧数(用户改过 F / 选过档位),不瞎改
 *   5. 否则默认 SHOT_DEFAULT_SECONDS
 *
 * 超过 SHOT_MAX_SECONDS 一律截断并在 note 里说明。
 */
export function normalizeShotDuration(
  data: Record<string, unknown>,
  opts?: { label?: string; prompt?: string },
): NormalizeShotDurationResult {
  const next: Record<string, unknown> = { ...data };
  const notes: string[] = [];
  const secRaw = Number(next.seconds ?? 0);
  const framesRaw = Number(next.frames ?? 0);
  const promptText = opts?.prompt ?? (typeof next.prompt === 'string' ? next.prompt : '');
  const totalHint =
    parseTotalDurationHint(promptText) ??
    (opts?.label ? parseTotalDurationHint(opts.label) : undefined);
  const labelHint = opts?.label ? parseDurationHint(opts.label) : undefined;

  let seconds: number | undefined;
  if (
    totalHint !== undefined &&
    Number.isFinite(secRaw) &&
    secRaw > 0 &&
    totalHint > secRaw
  ) {
    seconds = totalHint;
    notes.push(
      `提示词写明总时长 ${totalHint}s,已覆盖节点上的 ${secRaw}s(避免「文案写长片、参数却是拆行后的短时长」)`,
    );
  } else if (Number.isFinite(secRaw) && secRaw > 0) {
    seconds = secRaw;
  } else if (totalHint !== undefined) {
    seconds = totalHint;
    notes.push(`已从提示词识别总时长 ${totalHint}s 写入 data.seconds`);
  } else if (labelHint !== undefined) {
    seconds = labelHint;
    notes.push(`已从标题识别时长 ${labelHint}s 写入 data.seconds(标题写了时长但节点没填,这是常见漏写)`);
  } else if (Number.isFinite(framesRaw) && framesRaw > 0) {
    // 有帧数、无秒数:尊重既有 F(档位预设 / 用户手改),不覆盖
    return { data: next, changed: false };
  } else {
    seconds = SHOT_DEFAULT_SECONDS;
    notes.push(
      `未指定时长,已默认 ${SHOT_DEFAULT_SECONDS}s(硬上限 ${SHOT_MAX_SECONDS}s;Agent 非必要勿用满 ${SHOT_MAX_SECONDS},更长请拆镜)`,
    );
  }

  if (seconds! > SHOT_MAX_SECONDS) {
    notes.push(`单段上限 ${SHOT_MAX_SECONDS}s,已从 ${seconds} 截到 ${SHOT_MAX_SECONDS}(更长请拆多镜头段落)`);
    seconds = SHOT_MAX_SECONDS;
  }

  const frames = h3FramesForSeconds(seconds!);
  const changed = Number(next.seconds ?? 0) !== seconds || Number(next.frames ?? 0) !== frames;
  next.seconds = seconds;
  next.frames = frames;
  return {
    data: next,
    changed,
    note: notes.length ? notes.join('; ') : undefined,
  };
}

/**
 * 创建/更新镜头时把显式宽高规整到 h3 合法档(32 倍数 + 面积上限)。
 *
 * 与 validateShotSubmitParams(提交前拦截、禁止静默 clamp 后入队)分工不同:
 * 这里是**参数落盘前**的规整,改动经 note 明示给调用方,让节点始终保持「可提交」状态。
 * 2026-10-15「骑士小猫」事故:Agent 建镜头直接抄了参考图尺寸 2752×1536,创建不拦、
 * 提交才拒;模型改 1280×720(720 非 32 倍数)再被拒 —— 白烧两轮引擎往返。
 */
export function snapShotDimensions(data: Record<string, unknown>): { data: Record<string, unknown>; note?: string } {
  const w = Number(data.width ?? 0);
  const h = Number(data.height ?? 0);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return { data };
  let width = Math.max(H3_DIM_MULTIPLE, Math.round(w / H3_DIM_MULTIPLE) * H3_DIM_MULTIPLE);
  let height = Math.max(H3_DIM_MULTIPLE, Math.round(h / H3_DIM_MULTIPLE) * H3_DIM_MULTIPLE);
  if (width * height > H3_MAX_PIXELS) {
    const scale = Math.sqrt(H3_MAX_PIXELS / (width * height));
    width = Math.max(H3_DIM_MULTIPLE, Math.floor((width * scale) / H3_DIM_MULTIPLE) * H3_DIM_MULTIPLE);
    height = Math.max(H3_DIM_MULTIPLE, Math.floor((height * scale) / H3_DIM_MULTIPLE) * H3_DIM_MULTIPLE);
  }
  if (width === w && height === h) return { data };
  return {
    data: { ...data, width, height },
    note: `尺寸 ${w}×${h} 不合 h3 规范(宽高须 ${H3_DIM_MULTIPLE} 倍数且面积 ≤ ${H3_MAX_PIXELS}),已规整为 ${width}×${height}`,
  };
}

/**
 * 触发生成前校验镜头尺寸 + 时长是否符合 h3 硬约束。
 * 返回空数组 = 可提交;有内容 = 必须拦下并给出可执行修法(禁止静默 clamp 后入队)。
 *
 * 覆盖:
 *   - 宽高:正数、32 倍数、乘积 ≤ H3_MAX_PIXELS
 *   - 时长:seconds∈(0,SHOT_MAX_SECONDS] 或 frames 对齐后 ∈[5,362]
 */
export function validateShotSubmitParams(params: {
  width?: unknown;
  height?: unknown;
  seconds?: unknown;
  frames?: unknown;
}): string[] {
  const errors: string[] = [];
  const w = Number(params.width);
  const h = Number(params.height);

  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    errors.push(
      `分辨率无效(当前 ${String(params.width)}×${String(params.height)}):必须是正数。` +
        `常用档:864×480(16:9)/576×1024(9:16)/544×544(1:1)`,
    );
  } else {
    if (w % H3_DIM_MULTIPLE !== 0 || h % H3_DIM_MULTIPLE !== 0) {
      errors.push(
        `分辨率必须是 ${H3_DIM_MULTIPLE} 的倍数(当前 ${w}×${h})。` +
          `请改到合法档,如 864×480 / 576×1024 / 544×544`,
      );
    }
    if (w * h > H3_MAX_PIXELS) {
      errors.push(
        `分辨率乘积超限(${w}×${h}=${w * h} > ${H3_MAX_PIXELS})。` +
          `请降低到 h3 上限面积内(如 768×1344 / 704×1280)`,
      );
    }
  }

  const sec = Number(params.seconds ?? 0);
  const framesRaw = Number(params.frames ?? 0);
  let alignedFrames: number | undefined;

  if (Number.isFinite(sec) && sec > 0) {
    if (sec > SHOT_MAX_SECONDS) {
      errors.push(
        `单段时长上限 ${SHOT_MAX_SECONDS}s(当前 ${sec}s)。更长请拆多镜头段落`,
      );
    }
    alignedFrames = h3FramesForSeconds(sec);
  } else if (Number.isFinite(framesRaw) && framesRaw > 0) {
    alignedFrames = h3AlignFrames(framesRaw);
  } else {
    errors.push(
      `未指定时长(seconds/frames 皆空)。请设 data.seconds(推荐 ${SHOT_DEFAULT_SECONDS}s,硬上限 ${SHOT_MAX_SECONDS}s;非必要不要写满 ${SHOT_MAX_SECONDS})`,
    );
    return errors;
  }

  if (
    alignedFrames !== undefined &&
    (alignedFrames < H3_MIN_FRAMES || alignedFrames > H3_MAX_FRAMES)
  ) {
    errors.push(
      `帧数须对齐到 ${H3_MIN_FRAMES}..${H3_MAX_FRAMES}(5+17n);` +
        `当前对齐后 ${alignedFrames} 帧(≈${(alignedFrames / H3_FPS).toFixed(2)}s)。` +
        `请把 data.seconds 压到 ≤${SHOT_MAX_SECONDS}`,
    );
  }

  return errors;
}
