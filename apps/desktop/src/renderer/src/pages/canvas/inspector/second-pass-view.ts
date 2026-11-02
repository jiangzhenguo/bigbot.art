/**
 * 检查器「二采(second pass)」展示层 —— **纯函数,无 React/无 IPC**,供 UI 与单测共用。
 *
 * 为什么单独一个文件:ShotInspector.tsx 是个几千行的组件模块,模块级还拉了
 * media / ImageTakeSection / ref-binding 一串浏览器依赖;把文案与档位表放这里,
 * 单测可以像 `edit-output-resolution.test.ts` 那样直接 import 纯函数,
 * 不必为了断言一句话而把整个检查器(含 `window.bigbotart`)拽进 node 环境。
 *
 * ⚠️ 所有数值语义的唯一真源仍是 `@bigbotart/shared` 的 `second-pass.ts`
 * (`planSecondPass` / `describeSecondPass` / `SECOND_PASS_DEFAULT_FRACTION`)。
 * 本文件**只做措辞与档位呈现**,不得在这里重算 32 倍数、同比例、夹取区间 ——
 * 一旦本文件自己夹一次,就会出现「检查器显示 40%、实际提交 35%」这类静默不一致。
 */
import {
  describeSecondPass,
  secondPassEtaFactor,
  secondPassTailSteps,
  SECOND_PASS_CANVAS_MIN_TAIL_STEPS,
  SECOND_PASS_DEFAULT_FRACTION,
  type SecondPassPlan,
  type ShotSecondPassMode,
} from '@bigbotart/shared';

/**
 * 关闭态的说明文案(取舍见下)。
 *
 * 取舍:**关闭时不隐藏这条说明,而是把「它做什么 + 它花多少时间」一次讲清**。
 * - 不写「未开启」这种零信息占位:用户看不到开关的价值就不会去点它,
 *   而二采恰恰是「同一提示词再出一次、细节更稳」里性价比最高的一档;
 * - 不在关闭态展开模式/比例控件:关闭 = 干净(控件只增不减会让检查器越来越长),
 *   但代价(时间 +15~20% 起)必须**前置**告知,不能等用户打开后才发现要等更久;
 * - 两种模式的代价差异一起写:画布二采要完整重跑一遍管线,是 +30~60%,
 *   比精修贵一档。只写「约 +15~20%」会让人误以为「开二采都只贵一点」。
 */
export const SECOND_PASS_OFF_HINT =
  '开启后 h3 重跑去噪尾部:构图不变、细节更稳(同画布精修约 +15~20% 时间;画布二采要完整重跑一遍,约 +30~60%)';

/** 二采对耗时的预计影响(与 provider ETA 共用 `secondPassEtaFactor` 的系数) */
export function secondPassEtaText(plan: SecondPassPlan): string {
  if (!plan.enabled) return '';
  const pct = Math.round((secondPassEtaFactor(plan) - 1) * 100);
  return `预计 +${pct}% 时间`;
}

/**
 * 一行人话摘要(检查器主提示行)。
 *  - 关闭 → {@link SECOND_PASS_OFF_HINT}
 *  - 精修 → `同画布精修:重跑尾部 15% 步数,构图不变 · 预计 +18% 时间`
 *  - 画布 → `画布二采:第一遍 224×384 定构图 → 第二遍 448×768 重采样(重跑尾部 40% 步数) · 预计 +50% 时间`
 *
 * 描述部分一律走 shared 的 `describeSecondPass`,保证「检查器说的」与
 * 「Take 备注/日志说的」是同一句话。
 */
export function secondPassHint(plan: SecondPassPlan): string {
  if (!plan.enabled) return SECOND_PASS_OFF_HINT;
  const desc = describeSecondPass(plan) ?? '';
  return `${desc} · ${secondPassEtaText(plan)}`;
}

/**
 * 降级/夹取说明行(检查器用 `color: var(--warn)` 单独一行渲染)。
 *
 * 为什么不把它拼进 {@link secondPassHint}:那是**正常态**的一句描述,
 * 夹取说明是**异常态**的告警,两者视觉权重不同(用户扫一眼检查器时
 * 得能立刻分辨「这只是二采在跑」和「我选的 40% 被改成 35% 了」)。
 * 返回 undefined 表示没有需要告警的内容。
 */
export function secondPassNote(plan: SecondPassPlan): string | undefined {
  return plan.enabled && plan.note ? plan.note : undefined;
}

/** 比例档位(带「推荐」标记);数字与 shared 的默认值同源,避免两处各写一份 */
export interface SecondPassRatioOption {
  value: number;
  recommended: boolean;
}

/**
 * 各模式的可选比例。
 *
 * 上下界刻意**比 shared 的合法区间窄**:那是「引擎能接受」的区间
 * (精修 0.05~0.6 / 画布 0.35~0.8),这里是「产品愿意让用户点」的档位 ——
 * 档位之外的值仍可被 Agent 写进 data 并被 planSecondPass 正常夹取,
 * UI 只是不做成 chips(否则一排 12 个 chip,用户反而挑不动)。
 */
export function secondPassRatioOptions(mode: ShotSecondPassMode): readonly SecondPassRatioOption[] {
  if (mode === 'canvas') {
    const d = SECOND_PASS_DEFAULT_FRACTION.canvas;
    return [0.4, 0.5, 0.6].map((value) => ({ value, recommended: Math.abs(value - d) < 1e-9 }));
  }
  const d = SECOND_PASS_DEFAULT_FRACTION.refine;
  return [0.05, 0.1, 0.15, 0.2].map((value) => ({ value, recommended: Math.abs(value - d) < 1e-9 }));
}

/**
 * 某个档位是否「当前生效」。
 *
 * ⚠️ 必须拿 `plan.fraction`(已归一化/夹取后的**实际值**)比,不能拿 `data.secondPass.fraction`
 * 比 —— 后者可能是 Agent 写的 `0.1`(字符串)、`0.35`(画布模式被夹到 0.35 但 chips 没有这个档),
 * 或干脆缺省(undefined)。用原值比会导致「一个 chip 都不亮」,用户看不出现在是什么档。
 */
export function isSecondPassRatioActive(plan: SecondPassPlan, value: number): boolean {
  return plan.enabled && Math.abs(plan.fraction - value) < 1e-9;
}

/**
 * 「这次二采到底重跑几步」的告警(无问题时返回 undefined)。
 *
 * 为什么需要:尾部步数 = `steps × F`(h3 内部 `start_step = round(steps*(1-F))`),
 * 而加速模型包把步数压到 4/6/8 —— 8 步 × 0.4 只有 3 步,4 步 × 0.15 只有 **1 步**。
 * 用户看到的是「二采已开启」,实际只是把最后一步又跑了一遍:多花一遍 setup、
 * 画面几乎不动。这正是本项目反复出现的「假成功」形态,所以要在检查器里说清,
 * 而不是等用户对比两版视频都看不出差别才发现。
 *
 * 阈值依据:h3c-usage §4「画布二采尾部步数建议 ≥ 8」;精修模式不套用该建议
 * (它的设计就是以小尾部换小代价,h3 文档明确 0.1~0.2 可用),只在**只剩 1 步**时提示。
 */
export function secondPassTailHint(plan: SecondPassPlan, steps: number): string | undefined {
  if (!plan.enabled) return undefined;
  const tail = secondPassTailSteps(steps, plan);
  if (tail <= 0) return undefined;
  const pct = Math.round(plan.fraction * 100);
  if (plan.mode === 'canvas' && tail < SECOND_PASS_CANVAS_MIN_TAIL_STEPS) {
    return (
      `画布二采只重跑 ${tail} 步(${steps} 步 × ${pct}%):建议 ≥ ${SECOND_PASS_CANVAS_MIN_TAIL_STEPS} 步,` +
      '否则双线性上采样的结构压不住、接近「只多付一遍 setup」。可提高重跑比例或关闭模型包拿回档位步数。'
    );
  }
  if (tail <= 1) {
    return (
      `二采只重跑 1 步(${steps} 步 × ${pct}%):效果几乎看不出来。` +
      '加速模型包(4/6/8 步)下请把重跑比例提到 20% 以上,或临时关闭模型包用档位步数跑二采。'
    );
  }
  return undefined;
}

/** 比例的人话写法(`0.15` → `15%`) */
export function secondPassPctText(fraction: number): string {
  const pct = Math.round(fraction * 100);
  return `${pct}%`;
}

/**
 * 切模式时要落的比例:直接落到该模式的默认值。
 *
 * 不沿用旧比例的原因:refine 的 `0.15` 在 canvas 模式下会被 shared 夹到 `0.35`
 * (低于 0.35 有上采样鬼影),canvas 的 `0.4` 在 refine 模式下又等于「重画一半」。
 * 两种模式的 F 语义不同,沿用另一个模式的比例 = 用户切一次模式就意外改了强度。
 */
export function secondPassFractionForMode(mode: ShotSecondPassMode): number {
  return SECOND_PASS_DEFAULT_FRACTION[mode];
}
