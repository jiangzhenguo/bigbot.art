/**
 * 检查器「二采(second pass)」展示层 + 白名单联动闸。
 *
 * 两层价值:
 *  ① 文案/档位是纯函数,直接锁措辞(**用户看到的数字必须与 provider 实际跑的一致**;
 *     例如「重跑尾部 15% 步数 · 预计 +18% 时间」这两个数分别来自 shared 的
 *     `describeSecondPass` 与 `secondPassEtaFactor`,不是本文件自己拍的值);
 *  ② 源码护栏:检查器写了 `data.secondPass`,就必须在 `CanvasPage.runNode` 的
 *     **显式白名单**里有一项 —— 只写 data 不列白名单 = 控件看起来生效、参数根本没进
 *     provider(仓库反复出现的事故形态,见 edit-output-resolution.test.ts 同名那组)。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  planSecondPass,
  describeSecondPass,
  secondPassEtaFactor,
  SECOND_PASS_DEFAULT_FRACTION,
  SECOND_PASS_CANVAS_MIN_TAIL_STEPS,
} from '@bigbotart/shared';
import {
  SECOND_PASS_OFF_HINT,
  secondPassHint,
  secondPassNote,
  secondPassEtaText,
  secondPassTailHint,
  secondPassRatioOptions,
  isSecondPassRatioActive,
  secondPassFractionForMode,
  secondPassPctText,
} from '../second-pass-view';

/** 仓库根(本文件在 apps/desktop/src/renderer/src/pages/canvas/inspector/__tests__/) */
const repoRoot = path.join(__dirname, '../../../../../../../../..');

describe('secondPassHint — 关闭态', () => {
  it('关闭时讲清「做什么 + 花多少时间」,不是「未开启」占位', () => {
    const plan = planSecondPass({ width: 448, height: 768, secondPass: undefined });
    expect(plan.enabled).toBe(false);
    expect(secondPassHint(plan)).toBe(SECOND_PASS_OFF_HINT);
    expect(SECOND_PASS_OFF_HINT).toContain('开启后 h3 重跑去噪尾部');
    expect(SECOND_PASS_OFF_HINT).toContain('构图不变');
    expect(SECOND_PASS_OFF_HINT).toContain('细节更稳');
    expect(SECOND_PASS_OFF_HINT).toContain('15~20%');
  });

  it('关闭态两种模式的代价都写出来(画布二采贵一档,不能被「+15~20%」误导)', () => {
    expect(SECOND_PASS_OFF_HINT).toContain('画布二采');
    expect(SECOND_PASS_OFF_HINT).toContain('30~60%');
    // 关闭态不该出现「预计 +N% 时间」这种只对已开启有意义的措辞
    expect(SECOND_PASS_OFF_HINT).not.toMatch(/预计 \+\d+% 时间/);
    expect(secondPassEtaText(planSecondPass({ width: 448, height: 768 }))).toBe('');
  });

  it('关闭态没有告警行(note 只在开启且有修正时出现)', () => {
    const plan = planSecondPass({ width: 448, height: 768, secondPass: false });
    expect(secondPassNote(plan)).toBeUndefined();
  });
});

describe('secondPassHint — 同画布精修(refine)', () => {
  const plan = planSecondPass({
    width: 448,
    height: 768,
    secondPass: { enabled: true, mode: 'refine' },
  });

  it('显示尾部比例与代价,且不含画布推算(精修不换画布)', () => {
    const text = secondPassHint(plan);
    expect(text).toContain('同画布精修');
    expect(text).toContain('重跑尾部 15% 步数');
    expect(text).toContain('构图不变');
    expect(text).toContain('预计 +18% 时间');
    // 没有 render/canvas 字段 → 不该出现「第一遍 … 第二遍 …」
    expect(plan.render).toBeUndefined();
    expect(plan.canvas).toBeUndefined();
    expect(text).not.toContain('第一遍');
  });

  it('文案与 shared 的唯一真源同源(数字不许在本文件另算)', () => {
    const text = secondPassHint(plan);
    expect(text.startsWith(describeSecondPass(plan)!)).toBe(true);
    expect(secondPassEtaFactor(plan)).toBe(1.18);
    expect(secondPassEtaText(plan)).toBe('预计 +18% 时间');
  });

  it('比例改小 → 文案跟着变(0.05 → 5%)', () => {
    const p = planSecondPass({
      width: 448,
      height: 768,
      secondPass: { enabled: true, mode: 'refine', fraction: 0.05 },
    });
    expect(secondPassHint(p)).toContain('重跑尾部 5% 步数');
  });
});

describe('secondPassHint — 画布二采(canvas / Hires)', () => {
  it('448×768 → 第一遍 224×384 定构图,第二遍 448×768 重采样', () => {
    const plan = planSecondPass({
      width: 448,
      height: 768,
      secondPass: { enabled: true, mode: 'canvas' },
    });
    expect(plan.mode).toBe('canvas');
    expect(plan.render).toEqual({ width: 224, height: 384 });
    expect(plan.canvas).toEqual({ width: 448, height: 768 });

    const text = secondPassHint(plan);
    expect(text).toContain('画布二采');
    expect(text).toContain('第一遍 224×384 定构图');
    expect(text).toContain('第二遍 448×768 重采样');
    expect(text).toContain('重跑尾部 40% 步数');
    expect(text).toContain('预计 +50% 时间');
  });

  it('画面规格改为 544×544 → 推算画布跟着变(检查器用的就是提交那份 width/height)', () => {
    const plan = planSecondPass({
      width: 544,
      height: 544,
      secondPass: { enabled: true, mode: 'canvas' },
    });
    expect(plan.render).toEqual({ width: 352, height: 352 });
    expect(secondPassHint(plan)).toContain('第一遍 352×352 定构图');
    expect(secondPassHint(plan)).toContain('第二遍 544×544 重采样');
  });

  it('画布二采的代价是 +50%(完整重跑一遍管线),与精修的 +18% 明确区分', () => {
    const canvasPlan = planSecondPass({ width: 448, height: 768, secondPass: { enabled: true, mode: 'canvas' } });
    const refinePlan = planSecondPass({ width: 448, height: 768, secondPass: { enabled: true, mode: 'refine' } });
    expect(secondPassEtaFactor(canvasPlan)).toBe(1.5);
    expect(secondPassEtaFactor(refinePlan)).toBe(1.18);
  });
});

describe('secondPassNote — 降级/夹取必须单独告警', () => {
  it('比例被夹取 → note 说明「已调整为」', () => {
    const plan = planSecondPass({
      width: 448,
      height: 768,
      secondPass: { enabled: true, mode: 'refine', fraction: 0.01 },
    });
    const note = secondPassNote(plan);
    expect(note).toBeTruthy();
    expect(note).toContain('已调整为 0.05');
    // 主提示行保持干净(告警不混进正常态那句)
    expect(secondPassHint(plan)).not.toContain('已调整为');
  });

  it('输出画布推不出更小的同比例画布 → 降级同画布精修 + note', () => {
    // 544×768:宽高除以 32 后 17 与 24 互质,没有更小的同比例 32 倍数画布
    const plan = planSecondPass({
      width: 544,
      height: 768,
      secondPass: { enabled: true, mode: 'canvas', fraction: 0.5 },
    });
    expect(plan.mode).toBe('refine');
    const note = secondPassNote(plan);
    expect(note).toContain('已改为同画布精修');
    // 降级后 hint 说的是「实际会跑的模式」,不能还写「画布二采」
    expect(secondPassHint(plan)).toContain('同画布精修');
  });

  it('画布二采比例低于 0.35 → 夹到 0.4 并告警(低于它 h3 会因上采样鬼影告警)', () => {
    const plan = planSecondPass({
      width: 448,
      height: 768,
      secondPass: { enabled: true, mode: 'canvas', fraction: 0.2 },
    });
    expect(plan.fraction).toBe(0.35);
    expect(secondPassNote(plan)).toContain('上采样鬼影');
  });
});

describe('比例档位', () => {
  it('精修 4 档、画布 3 档,推荐档 = shared 的默认值', () => {
    const refine = secondPassRatioOptions('refine');
    expect(refine.map((o) => o.value)).toEqual([0.05, 0.1, 0.15, 0.2]);
    expect(refine.filter((o) => o.recommended).map((o) => o.value)).toEqual([
      SECOND_PASS_DEFAULT_FRACTION.refine,
    ]);

    const canvas = secondPassRatioOptions('canvas');
    expect(canvas.map((o) => o.value)).toEqual([0.4, 0.5, 0.6]);
    expect(canvas.filter((o) => o.recommended).map((o) => o.value)).toEqual([
      SECOND_PASS_DEFAULT_FRACTION.canvas,
    ]);
  });

  it('选中态按 plan.fraction 比(夹取后的实际值),不是 data 原值', () => {
    // data 写 0.01 → 实际夹到 0.05 → 0.05 那个 chip 必须亮,否则用户看不到当前档位
    const plan = planSecondPass({
      width: 448,
      height: 768,
      secondPass: { enabled: true, mode: 'refine', fraction: 0.01 },
    });
    expect(isSecondPassRatioActive(plan, 0.05)).toBe(true);
    expect(isSecondPassRatioActive(plan, 0.15)).toBe(false);
  });

  it('未开启时任何档位都不亮', () => {
    const plan = planSecondPass({ width: 448, height: 768 });
    expect(isSecondPassRatioActive(plan, 0.15)).toBe(false);
  });

  it('切模式落该模式默认比例(不沿用另一模式的比例)', () => {
    expect(secondPassFractionForMode('refine')).toBe(0.15);
    expect(secondPassFractionForMode('canvas')).toBe(0.4);
    expect(secondPassPctText(0.05)).toBe('5%');
    expect(secondPassPctText(0.15)).toBe('15%');
  });
});

/**
 * 🚨 白名单联动闸
 *
 * `CanvasPage.runNode` 的 `params` 是显式白名单对象:只写进 `node.data` 而没列进它,
 * 参数就到不了 provider —— 检查器控件显示正常、也能写盘,只有命令行里没这个参数。
 */
describe('联动:检查器写的 secondPass 必须能到达 provider', () => {
  const inspector = fs.readFileSync(
    path.join(repoRoot, 'apps/desktop/src/renderer/src/pages/canvas/inspector/ShotInspector.tsx'),
    'utf8',
  );
  const canvasPage = fs.readFileSync(
    path.join(repoRoot, 'apps/desktop/src/renderer/src/pages/CanvasPage.tsx'),
    'utf8',
  );

  it('检查器用 shared 的 planSecondPass 解析(不自己算 32 倍数/同比例)', () => {
    expect(inspector).toContain('planSecondPass({ width, height, secondPass: d.secondPass })');
    /* 检查器不得自己做画布换算(除以 32 / 取 gcd 之类)—— 那套规则只能在 shared 里有一份。
       provider / 主进程读同一份 plan,才不会出现「界面说 224×384、命令行给 320×320」。 */
    expect(inspector).not.toMatch(/\/\s*32\b/);
  });

  it('检查器有控件树的锚点(data-od-id)', () => {
    expect(inspector).toContain('data-od-id="shot-second-pass"');
    expect(inspector).toContain('data-od-id="shot-second-pass-toggle"');
    expect(inspector).toContain('data-od-id={`shot-second-pass-mode-${m}`}');
    expect(inspector).toContain('data-od-id={`shot-second-pass-ratio-${o.value}`}');
    expect(inspector).toContain('data-od-id="shot-second-pass-hint"');
    expect(inspector).toContain('data-od-id="shot-second-pass-note"');
  });

  it('runNode 的视频 params 白名单里有 secondPass', () => {
    const i = canvasPage.indexOf('const params = isImage');
    expect(i).toBeGreaterThan(-1);
    const seg = canvasPage.slice(i, i + 2600);
    expect(seg).toMatch(/secondPass:\s*shotData\.secondPass/);
    // 必须落在**视频**分支(shotData 是 shot 的 data);图片分支没有这个字段
    const videoBranch = seg.indexOf('kind: \'video\'');
    expect(videoBranch).toBeGreaterThan(-1);
    expect(seg.indexOf('secondPass: shotData.secondPass')).toBeGreaterThan(videoBranch);
  });

  it('检查器写回时用 normalizeSecondPass 摊平(容忍 Agent 写的 true / "true" / {canvas:…})', () => {
    expect(inspector).toContain('normalizeSecondPass(d.secondPass)');
  });
});

describe('secondPassTailHint — 「开了但只重跑 1~3 步」必须说出来', () => {
  const canvasPlan = planSecondPass({
    width: 448,
    height: 768,
    secondPass: { enabled: true, mode: 'canvas', fraction: 0.4 },
  });

  it('关闭态 / 正常步数 → 无告警', () => {
    expect(secondPassTailHint(planSecondPass({ width: 448, height: 768 }), 30)).toBeUndefined();
    // 档位默认 30 步 × 15% = 5 步:精修的设计就是小尾部,不打扰用户
    expect(
      secondPassTailHint(planSecondPass({ width: 448, height: 768, secondPass: true }), 30),
    ).toBeUndefined();
    // 画布二采 30 步 × 40% = 12 步 ≥ 阈值
    expect(secondPassTailHint(canvasPlan, 30)).toBeUndefined();
  });

  it('画布二采 + 8 步加速包 → 3 步告警,指向「提高比例或关模型包」', () => {
    const text = secondPassTailHint(canvasPlan, 8);
    expect(text).toBeTruthy();
    expect(text).toContain('只重跑 3 步');
    expect(text).toContain(`≥ ${SECOND_PASS_CANVAS_MIN_TAIL_STEPS} 步`);
    expect(text).toContain('模型包');
  });

  it('精修 + 4 步加速包 → 只剩 1 步也要告警(「开了但看不出来」形态)', () => {
    const refine = planSecondPass({ width: 448, height: 768, secondPass: { enabled: true, fraction: 0.15 } });
    const text = secondPassTailHint(refine, 4);
    expect(text).toBeTruthy();
    expect(text).toContain('只重跑 1 步');
    expect(text).toContain('加速模型包');
  });
});
