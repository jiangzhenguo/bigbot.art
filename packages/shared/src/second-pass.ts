/**
 * h3 二采(second pass / Hires)参数解析 —— **全链唯一真源**。
 *
 * h3.c 的内置二采有两种用法(依据引擎仓 README「Second pass」与 `h3.c` 的
 * `h3_valid_params` / `h3_generate` 实现,2026-10 本机二进制 `--help` 已含这些 flag):
 *
 *  ① **同画布精修**:`--second-pass F`(0<F<1)。把第一遍出的干净 latent 重新加噪到
 *     sigma 网格的第 `round(steps*(1-F))` 步,再跑尾部 `steps*F` 步。构图/动作不变,
 *     只重合成纹理与表情。实测约 +15~20% 时间。F=0.1 / 0.2 是推荐档。
 *  ② **画布二采(Hires)**:`--render-width/--render-height <小画布>` 让第一遍在小画布
 *     定构图 → `--second-pass F --second-pass-canvas WxH` 把 latent 双线性放大到第二遍
 *     画布,并在那里**完整重跑一遍管线**(文本、首尾帧、参考图全部按新画布重新编码)。
 *     引擎硬约束:第二遍画布必须**同比例、32 的倍数、不大于输出画布**;
 *     且 `--second-pass-canvas` 必须配 `--second-pass F`(只给画布 → exit 2
 *     "a second-pass canvas needs a fraction in (0, 1)")。
 *
 * ⚠️ **画布二采必须真的给 `--render-*`**:不给的话第一遍就在输出尺寸跑,
 *    第二遍等于把已经画好的东西再画一遍 —— 只花时间不增细节。这个参数组合
 *    (render + second-pass-canvas)是本模块存在的核心理由,调用方不要自己拍脑袋拼。
 * ⚠️ **画布二采 F 低于 0.35 会留下上采样鬼影**(h3 自己会打 warning),本模块把画布模式
 *    的下限夹到 0.35,避免产出「看着更糊」的结果。
 *
 * 本模块只做**纯计算**:不碰磁盘、不读设置。渲染层检查器(显示推算出的画布)、
 * provider 命令构造(落到 CLI 参数)、主进程校验(提交前防呆)都读同一份结果,
 * 禁止任何地方再写一套 32 倍数/同比例/比例夹取的规则。
 */

/** 二采模式:同画布精修 / 画布二采(Hires) */
export type ShotSecondPassMode = 'refine' | 'canvas';

/** 节点 `data.secondPass`(Agent 传 `true` 也能被 `normalizeSecondPass` 接住) */
export interface ShotSecondPassParams {
  enabled?: boolean;
  /** 缺省 'refine'(构图不变的精修,性价比最高) */
  mode?: ShotSecondPassMode;
  /** 重跑尾部比例 F(0<F<1);缺省按 mode:refine=0.15 / canvas=0.4 */
  fraction?: number;
}

export const SECOND_PASS_MODES: readonly ShotSecondPassMode[] = ['refine', 'canvas'];

/** 各模式的默认 F(同画布精修 0.15:实测能保住构图又明显增细节;画布二采 0.4:引擎建议值) */
export const SECOND_PASS_DEFAULT_FRACTION: Record<ShotSecondPassMode, number> = {
  refine: 0.15,
  canvas: 0.4,
};

/** 同画布精修的可用区间:0.05 以下肉眼看不出,0.6 以上接近重画(会改构图) */
export const SECOND_PASS_REFINE_MIN_FRACTION = 0.05;
export const SECOND_PASS_REFINE_MAX_FRACTION = 0.6;

/** 画布二采下限:h3 对 F<0.35 会打「会保留上采样鬼影」的 warning,低于它没有产品意义 */
export const SECOND_PASS_CANVAS_MIN_FRACTION = 0.35;
export const SECOND_PASS_CANVAS_MAX_FRACTION = 0.8;

/**
 * 画布二采建议的最少尾部步数(h3c-usage §4:画布二采要多跑一点尾部才压得住
 * 双线性上采样留下的结构;尾部步数 = `steps × F`,建议 ≥ 8)。
 *
 * ⚠️ 这只是**建议**,不是引擎硬约束:低于它也能跑,但效果接近「多花一遍 setup 钱」。
 * 最常踩的是加速模型包(4/6/8 步):8 步 × 0.4 = 3 步,基本看不出画布二采的收益,
 * 所以检查器与 provider 日志都要把「实际尾部步数」说出来,而不是让用户以为开了就有效。
 */
export const SECOND_PASS_CANVAS_MIN_TAIL_STEPS = 8;

/** 画布边长的合法倍数(h3 `H3_CANVAS_MULTIPLE`) */
const CANVAS_MULTIPLE = 32;

export interface SecondPassPlan {
  /** 是否真的会跑二采 */
  enabled: boolean;
  /** **实际会跑的模式**(canvas 不可行时已降级为 refine,见 `note`) */
  mode: ShotSecondPassMode;
  /** 实际重跑的尾部比例(已夹进 h3 合法区间) */
  fraction: number;
  /**
   * 画布二采:第一遍的内部渲染画布(`--render-width/--render-height`)。
   * 只有 canvas 模式有;第一遍跑在这里,第二遍放大到 `canvas` 重采样。
   */
  render?: { width: number; height: number };
  /** 画布二采:第二遍画布(`--second-pass-canvas`),= 输出画布 */
  canvas?: { width: number; height: number };
  /** 给人看的降级/修正说明(夹取比例、画布不可行回退等);不影响提交 */
  note?: string;
}

/** 未开启时的稳定空计划(UI 直接渲染,不必判空) */
export function disabledSecondPassPlan(): SecondPassPlan {
  return { enabled: false, mode: 'refine', fraction: SECOND_PASS_DEFAULT_FRACTION.refine };
}

function toBool(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') {
    if (raw === 1) return true;
    if (raw === 0) return false;
    return undefined;
  }
  if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase();
    if (t === 'true' || t === '1' || t === 'yes' || t === 'on') return true;
    if (t === 'false' || t === '0' || t === 'no' || t === 'off') return false;
  }
  return undefined;
}

function toMode(raw: unknown): ShotSecondPassMode | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim().toLowerCase();
  // 别名:`hires` / `hire` / `canvas-pass` 都是「画布二采」的通俗写法(Agent 会这么写)
  if (t === 'canvas' || t === 'hires' || t === 'hire' || t === 'canvas-pass' || t === 'second-pass-canvas') {
    return 'canvas';
  }
  if (t === 'refine' || t === 'same-canvas' || t === 'in-place') return 'refine';
  return undefined;
}

/**
 * 归一化节点上的 `data.secondPass`(容忍 Agent 写出来的各种形态)。
 *
 * 接受:`undefined` / `false` / `true` / `0` / `1` / `"true"` / `"off"` /
 * `{ enabled, mode, fraction }`。不认识的值一律当「未开启」,**不猜**。
 */
export function normalizeSecondPass(raw: unknown): ShotSecondPassParams {
  if (raw == null) return {};
  const asBool = toBool(raw);
  if (asBool !== undefined) return { enabled: asBool };
  if (typeof raw !== 'object' || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: ShotSecondPassParams = {};
  const enabled = toBool(o.enabled);
  if (enabled !== undefined) out.enabled = enabled;
  const mode = toMode(o.mode);
  if (mode) out.mode = mode;
  const fraction = Number(o.fraction);
  if (Number.isFinite(fraction) && fraction > 0) out.fraction = fraction;
  // `canvas` 直接写画布尺寸的写法(`{canvas:'448x768'}` / `{canvas:{width,height}}`)
  // 也视为画布二采 —— Agent 很自然会这么写,但尺寸本身由本模块按输出画布推算,不采信外部值
  if (!out.mode && o.canvas != null) out.mode = 'canvas';
  if (out.enabled === undefined && (out.mode || out.fraction !== undefined)) out.enabled = true;
  return out;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function clampFraction(value: number, mode: ShotSecondPassMode): { fraction: number; note?: string } {
  const min = mode === 'canvas' ? SECOND_PASS_CANVAS_MIN_FRACTION : SECOND_PASS_REFINE_MIN_FRACTION;
  const max = mode === 'canvas' ? SECOND_PASS_CANVAS_MAX_FRACTION : SECOND_PASS_REFINE_MAX_FRACTION;
  if (!Number.isFinite(value)) return { fraction: SECOND_PASS_DEFAULT_FRACTION[mode] };
  const clamped = Math.min(max, Math.max(min, value));
  if (clamped === value) return { fraction: clamped };
  return {
    fraction: clamped,
    note:
      mode === 'canvas'
        ? `二采比例 ${value} 已调整为 ${clamped}(画布二采建议 ${SECOND_PASS_CANVAS_MIN_FRACTION}~${SECOND_PASS_CANVAS_MAX_FRACTION};` +
          '低于 0.35 会留下上采样鬼影,引擎亦会警告)'
        : `二采比例 ${value} 已调整为 ${clamped}(同画布精修 ${SECOND_PASS_REFINE_MIN_FRACTION}~${SECOND_PASS_REFINE_MAX_FRACTION}:` +
          ' 太小看不出、太大等于重画)',
  };
}

/**
 * 解析一条镜头节点的二采计划 —— 检查器展示 / 命令构造 / 提交前校验都走这里。
 *
 * @param width/height 节点**输出**画布(shot 节点已保证是 32 的倍数)
 * @param secondPass 节点 `data.secondPass` 原值(容忍任意形态)
 *
 * 行为:
 *  - 未开启 → `{enabled:false, mode:'refine', fraction:0.15}`;
 *  - refine → 只给 `fraction`;
 *  - canvas → 额外给出 `render`(第一遍小画布)与 `canvas`(= 输出画布);
 *    输出画布不存在更小的同比例 32 倍数画布时**自动降级为 refine 并附 note**,
 *    绝不产出会让 h3 exit 2 的参数组合。
 */
export function planSecondPass(input: {
  width: number;
  height: number;
  secondPass?: unknown;
}): SecondPassPlan {
  const norm = normalizeSecondPass(input.secondPass);
  if (norm.enabled !== true) return disabledSecondPassPlan();

  const requested: ShotSecondPassMode = norm.mode ?? 'refine';
  const width = Math.round(Number(input.width));
  const height = Math.round(Number(input.height));
  const defFraction = norm.fraction ?? SECOND_PASS_DEFAULT_FRACTION[requested];
  const refinePlan = (): SecondPassPlan => {
    const c = clampFraction(norm.fraction ?? SECOND_PASS_DEFAULT_FRACTION.refine, 'refine');
    return { enabled: true, mode: 'refine', fraction: c.fraction, ...(c.note ? { note: c.note } : {}) };
  };

  if (requested === 'refine') return refinePlan();

  // ── 画布二采 ──
  const c = clampFraction(defFraction, 'canvas');
  const notes: string[] = [];
  if (c.note) notes.push(c.note);

  const validCanvas =
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width >= CANVAS_MULTIPLE &&
    height >= CANVAS_MULTIPLE &&
    width % CANVAS_MULTIPLE === 0 &&
    height % CANVAS_MULTIPLE === 0;

  if (!validCanvas) {
    notes.push(`输出画布 ${input.width}×${input.height} 不是 32 的倍数,无法规划画布二采,已改为同画布精修`);
    return { ...refinePlan(), ...(notes.length ? { note: notes.join(';') } : {}) };
  }

  // 同比例画布的「最小单位」:把 32 倍数网格上的宽高约到互质 —— 输出 = 单位 × g,
  // 因此所有合法的同比例 32 倍数画布恰好是「单位的整数倍」,g 就是可分的份数。
  const a = width / CANVAS_MULTIPLE;
  const b = height / CANVAS_MULTIPLE;
  const g = gcd(a, b);
  if (g < 2) {
    notes.push(
      `输出画布 ${width}×${height} 没有更小的同比例 32 倍数画布(引擎要求画布同比例且 32 倍数),` +
        '已改为同画布精修',
    );
    return { ...refinePlan(), ...(notes.length ? { note: notes.join(';') } : {}) };
  }
  const unitW = width / g;
  const unitH = height / g;
  // 第一遍画布取「每边 ≤ 输出 2/3」的最大合法候选:再大就接近输出(白付一遍 setup),
  // 再小则结构太糊。实测与 h3c-usage 的推荐配方完全一致:
  //   448×768→224×384 / 768×768→512×512 / 576×1024→288×512 / 864×480→576×320。
  let k = Math.max(1, Math.floor((2 * width) / (3 * unitW)));
  k = Math.min(k, Math.max(1, Math.floor((2 * height) / (3 * unitH))));
  while (k > 1 && (unitW * k >= width || unitH * k >= height)) k -= 1;
  const renderW = unitW * k;
  const renderH = unitH * k;
  if (renderW >= width || renderH >= height) {
    // 理论上 g≥2 时不会走到这里(单边已 ≤ 2/3),留作最后一道保险
    notes.push('未能从输出画布推出更小的同比例画布,已改为同画布精修');
    return { ...refinePlan(), ...(notes.length ? { note: notes.join(';') } : {}) };
  }

  return {
    enabled: true,
    mode: 'canvas',
    fraction: c.fraction,
    render: { width: renderW, height: renderH },
    canvas: { width, height },
    ...(notes.length ? { note: notes.join(';') } : {}),
  };
}

/**
 * 二采对耗时的放大系数(给 provider 的 ETA 用,不与真实进度抢位置):
 *  - 同画布精修:只重跑尾部少量步数,+15~20%(取 1.18);
 *  - 画布二采:多一遍 setup(文本编码 + transformer 装载)+ 尾部重采样,+30~60%(取 1.5)。
 */
export function secondPassEtaFactor(plan: SecondPassPlan): number {
  if (!plan.enabled) return 1;
  return plan.mode === 'canvas' ? 1.5 : 1.18;
}

/**
 * 二采实际重跑的尾部步数 = `round(steps × F)`(h3 内部即
 * `start_step = round(steps*(1-F))`,尾部 = steps - start_step),最少 1 步。
 *
 * 用途:检查器 / provider 日志把「这次二采到底重跑几步」说出来 ——
 * 加速包把步数压到 4~8 时,F=0.15 只有 1 步,用户看到的「已开启二采」几乎等于没有。
 */
export function secondPassTailSteps(steps: number, plan: SecondPassPlan): number {
  if (!plan.enabled) return 0;
  const s = Number(steps);
  if (!Number.isFinite(s) || s < 1) return 0;
  return Math.max(1, Math.round(s * plan.fraction));
}

/** 一句人话摘要(检查器提示 / 日志 / Take 备注共用),未开启返回 undefined */
export function describeSecondPass(plan: SecondPassPlan): string | undefined {
  if (!plan.enabled) return undefined;
  if (plan.mode === 'canvas' && plan.render && plan.canvas) {
    return `画布二采:第一遍 ${plan.render.width}×${plan.render.height} 定构图 → 第二遍 ${plan.canvas.width}×${plan.canvas.height} 重采样(重跑尾部 ${Math.round(
      plan.fraction * 100,
    )}% 步数)`;
  }
  return `同画布精修:重跑尾部 ${Math.round(plan.fraction * 100)}% 步数,构图不变`;
}
