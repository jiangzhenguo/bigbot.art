/**
 * h3 二采(second pass / Hires)参数解析单测。
 *
 * 锁的是**与引擎硬约束一致**的三件事(错一条就是入队很久之后才 exit 2/1):
 *  ① F 必须在 (0,1) 且画布模式不低于 0.35(低于它会留上采样鬼影,h3 自己会警告);
 *  ② 画布二采的第二遍画布必须同比例、32 倍数、不大于输出画布;
 *  ③ 画布二采必须同时给出第一遍 render 画布(否则第一遍已在输出尺寸跑 = 白付时间)。
 */
import { describe, expect, it } from 'vitest';
import {
  SECOND_PASS_CANVAS_MAX_FRACTION,
  SECOND_PASS_CANVAS_MIN_FRACTION,
  SECOND_PASS_CANVAS_MIN_TAIL_STEPS,
  SECOND_PASS_DEFAULT_FRACTION,
  SECOND_PASS_REFINE_MAX_FRACTION,
  SECOND_PASS_REFINE_MIN_FRACTION,
  describeSecondPass,
  disabledSecondPassPlan,
  normalizeSecondPass,
  planSecondPass,
  secondPassEtaFactor,
  secondPassTailSteps,
} from '../second-pass.js';

describe('normalizeSecondPass', () => {
  it('未设置 / false / 0 → 未开启', () => {
    expect(normalizeSecondPass(undefined)).toEqual({});
    expect(normalizeSecondPass(null)).toEqual({});
    expect(normalizeSecondPass(false)).toEqual({ enabled: false });
    expect(normalizeSecondPass(0)).toEqual({ enabled: false });
  });

  it('Agent 常见的 boolean / 字符串写法都能接住', () => {
    expect(normalizeSecondPass(true)).toEqual({ enabled: true });
    expect(normalizeSecondPass('true')).toEqual({ enabled: true });
    expect(normalizeSecondPass('on')).toEqual({ enabled: true });
    expect(normalizeSecondPass('false')).toEqual({ enabled: false });
    expect(normalizeSecondPass('off')).toEqual({ enabled: false });
  });

  it('对象:enabled / mode(含别名)/ fraction', () => {
    expect(normalizeSecondPass({ enabled: true, mode: 'canvas', fraction: 0.5 })).toEqual({
      enabled: true,
      mode: 'canvas',
      fraction: 0.5,
    });
    // 别名:Agent 很自然会写 hires / same-canvas
    expect(normalizeSecondPass({ mode: 'hires' }).mode).toBe('canvas');
    expect(normalizeSecondPass({ mode: 'same-canvas' }).mode).toBe('refine');
  });

  it('只写 mode/fraction 时视为开启(不要求显式 enabled)', () => {
    expect(normalizeSecondPass({ mode: 'canvas' })).toEqual({ enabled: true, mode: 'canvas' });
    expect(normalizeSecondPass({ fraction: 0.2 })).toEqual({ enabled: true, fraction: 0.2 });
    expect(normalizeSecondPass({ canvas: '448x768' })).toEqual({ enabled: true, mode: 'canvas' });
  });

  it('不认识的形态当未开启,不猜', () => {
    expect(normalizeSecondPass({ mode: 'whatever' })).toEqual({});
    expect(normalizeSecondPass([1, 2])).toEqual({});
    expect(normalizeSecondPass({ fraction: -1 })).toEqual({});
    expect(normalizeSecondPass({ fraction: 'abc' })).toEqual({});
  });
});

describe('planSecondPass · 关闭 / 同画布精修', () => {
  it('未开启 → disabled 计划(比例回落到默认 0.15,不产出任何画布)', () => {
    const plan = planSecondPass({ width: 448, height: 768 });
    expect(plan).toEqual(disabledSecondPassPlan());
    expect(plan.render).toBeUndefined();
    expect(plan.canvas).toBeUndefined();
    expect(secondPassEtaFactor(plan)).toBe(1);
    expect(describeSecondPass(plan)).toBeUndefined();
  });

  it('true → 同画布精修 0.15,只有 fraction(不带 render / canvas)', () => {
    const plan = planSecondPass({ width: 448, height: 768, secondPass: true });
    expect(plan).toMatchObject({ enabled: true, mode: 'refine', fraction: SECOND_PASS_DEFAULT_FRACTION.refine });
    expect(plan.render).toBeUndefined();
    expect(plan.canvas).toBeUndefined();
    expect(secondPassEtaFactor(plan)).toBe(1.18);
  });

  it('自定义比例原样保留(F 是步数比例,不是噪声强度)', () => {
    expect(planSecondPass({ width: 448, height: 768, secondPass: { enabled: true, fraction: 0.1 } }).fraction).toBe(0.1);
  });

  it('越界比例夹进合法区间并留 note(绝不把非法 F 交给引擎)', () => {
    const low = planSecondPass({ width: 448, height: 768, secondPass: { enabled: true, fraction: 0.001 } });
    expect(low.fraction).toBe(SECOND_PASS_REFINE_MIN_FRACTION);
    expect(low.note).toContain('已调整');

    const high = planSecondPass({ width: 448, height: 768, secondPass: { enabled: true, fraction: 0.95 } });
    expect(high.fraction).toBe(SECOND_PASS_REFINE_MAX_FRACTION);
    expect(high.note).toContain('已调整');
  });
});

describe('planSecondPass · 画布二采(Hires)', () => {
  const recipes: Array<{ w: number; h: number; render: [number, number] }> = [
    // 与 h3c-usage §7 的实测配方逐一对齐(448×768 竖屏人物首选 / 768² 方形 / 576×1024 严格 9:16 / 864×480 9:5)
    { w: 448, h: 768, render: [224, 384] },
    { w: 768, h: 768, render: [512, 512] },
    { w: 576, h: 1024, render: [288, 512] },
    { w: 864, h: 480, render: [576, 320] },
    // 4:3 / 3:4 档位
    { w: 640, h: 480, render: [384, 288] },
    { w: 672, h: 896, render: [384, 512] },
    { w: 544, h: 544, render: [352, 352] },
  ];

  for (const r of recipes) {
    it(`${r.w}×${r.h} → 第一遍 ${r.render[0]}×${r.render[1]},第二遍 = 输出画布`, () => {
      const plan = planSecondPass({
        width: r.w,
        height: r.h,
        secondPass: { enabled: true, mode: 'canvas', fraction: 0.4 },
      });
      expect(plan.enabled).toBe(true);
      expect(plan.mode).toBe('canvas');
      expect(plan.fraction).toBe(0.4);
      expect(plan.render).toEqual({ width: r.render[0], height: r.render[1] });
      expect(plan.canvas).toEqual({ width: r.w, height: r.h });
      expect(secondPassEtaFactor(plan)).toBe(1.5);
      expect(describeSecondPass(plan)).toContain(`${r.render[0]}×${r.render[1]}`);
    });
  }

  it('画布约束恒等式:render 与 canvas 同为 32 倍数、严格同比例、都 ≤ 输出', () => {
    const sizes: Array<[number, number]> = [
      [448, 768], [768, 768], [576, 1024], [864, 480], [640, 480], [672, 896],
      [544, 544], [1280, 704], [704, 1280], [1024, 768], [480, 640], [768, 1024],
    ];
    for (const [w, h] of sizes) {
      const plan = planSecondPass({ width: w, height: h, secondPass: { enabled: true, mode: 'canvas', fraction: 0.4 } });
      expect(plan.mode, `${w}×${h} 应能规划画布二采`).toBe('canvas');
      const { render, canvas } = plan;
      expect(render && canvas).toBeTruthy();
      for (const c of [render!, canvas!]) {
        expect(c.width % 32, `${w}×${h} 画布宽 ${c.width} 不是 32 倍数`).toBe(0);
        expect(c.height % 32, `${w}×${h} 画布高 ${c.height} 不是 32 倍数`).toBe(0);
        expect(c.width).toBeGreaterThanOrEqual(32);
        expect(c.height).toBeGreaterThanOrEqual(32);
        expect(c.width / c.height).toBeCloseTo(w / h, 6); // 严格同比例
        expect(c.width).toBeLessThanOrEqual(w);
        expect(c.height).toBeLessThanOrEqual(h);
      }
      // 第一遍必须真的更小,否则「画布二采」只是把同一尺寸再画一遍
      expect(render!.width).toBeLessThan(w);
      expect(render!.height).toBeLessThan(h);
    }
  });

  it('画布模式比例低于 0.35 → 夹到 0.35 并解释鬼影(h3 同名 warning 的口径)', () => {
    const plan = planSecondPass({
      width: 448,
      height: 768,
      secondPass: { enabled: true, mode: 'canvas', fraction: 0.2 },
    });
    expect(plan.mode).toBe('canvas');
    expect(plan.fraction).toBe(SECOND_PASS_CANVAS_MIN_FRACTION);
    expect(plan.note).toContain('鬼影');
  });

  it('画布模式比例过大 → 夹到上限', () => {
    const plan = planSecondPass({
      width: 448,
      height: 768,
      secondPass: { enabled: true, mode: 'canvas', fraction: 0.99 },
    });
    expect(plan.fraction).toBe(SECOND_PASS_CANVAS_MAX_FRACTION);
  });

  it('输出画布没有更小的同比例 32 倍数画布(如 288×512)→ 降级同画布精修并说明', () => {
    const plan = planSecondPass({
      width: 288,
      height: 512,
      secondPass: { enabled: true, mode: 'canvas', fraction: 0.4 },
    });
    expect(plan.enabled).toBe(true);
    expect(plan.mode).toBe('refine');
    expect(plan.render).toBeUndefined();
    expect(plan.canvas).toBeUndefined();
    expect(plan.note).toContain('更小的同比例');
  });

  it('输出尺寸不是 32 倍数 → 降级同画布精修(不产出会被引擎拒绝的画布)', () => {
    const plan = planSecondPass({
      width: 430,
      height: 768,
      secondPass: { enabled: true, mode: 'canvas', fraction: 0.4 },
    });
    expect(plan.mode).toBe('refine');
    expect(plan.note).toContain('32 的倍数');
  });
});

describe('describeSecondPass / secondPassEtaFactor', () => {
  it('文案说清「跑的是什么」:同画布精修 vs 画布二采', () => {
    expect(describeSecondPass(disabledSecondPassPlan())).toBeUndefined();
    expect(describeSecondPass(planSecondPass({ width: 448, height: 768, secondPass: true }))).toContain('构图不变');
    const canvas = planSecondPass({
      width: 448,
      height: 768,
      secondPass: { enabled: true, mode: 'canvas', fraction: 0.4 },
    });
    expect(describeSecondPass(canvas)).toContain('224×384');
    expect(describeSecondPass(canvas)).toContain('448×768');
  });

  it('ETA:关闭 1 / 精修 1.18 / 画布 1.5', () => {
    expect(secondPassEtaFactor(disabledSecondPassPlan())).toBe(1);
    expect(secondPassEtaFactor(planSecondPass({ width: 448, height: 768, secondPass: true }))).toBe(1.18);
    expect(
      secondPassEtaFactor(
        planSecondPass({ width: 448, height: 768, secondPass: { enabled: true, mode: 'canvas' } }),
      ),
    ).toBe(1.5);
  });
});

describe('secondPassTailSteps — 「这次到底重跑几步」', () => {
  it('未开启 → 0;步数非法 → 0(不编造一个数出来)', () => {
    const off = planSecondPass({ width: 448, height: 768 });
    expect(secondPassTailSteps(30, off)).toBe(0);
    const on = planSecondPass({ width: 448, height: 768, secondPass: true });
    expect(secondPassTailSteps(Number.NaN, on)).toBe(0);
    expect(secondPassTailSteps(0, on)).toBe(0);
  });

  it('= round(steps × F),最少 1 步(h3 的 start_step = round(steps*(1-F)))', () => {
    const refine = planSecondPass({ width: 448, height: 768, secondPass: { enabled: true, fraction: 0.15 } });
    expect(secondPassTailSteps(30, refine)).toBe(5); // 4.5 → 5
    expect(secondPassTailSteps(20, refine)).toBe(3);
    // 加速包把步数压到 4 时只剩 1 步 —— 这正是检查器要告警的形态
    expect(secondPassTailSteps(4, refine)).toBe(1);
    // 极小比例也不返回 0(h3 至少跑 1 步),否则调用方会误判「没开」
    const tiny = planSecondPass({ width: 448, height: 768, secondPass: { enabled: true, fraction: 0.05 } });
    expect(secondPassTailSteps(10, tiny)).toBe(1);
  });

  it('画布二采:8 步加速包 × 0.4 只有 3 步(低于建议阈值 8)', () => {
    const canvas = planSecondPass({
      width: 448,
      height: 768,
      secondPass: { enabled: true, mode: 'canvas', fraction: 0.4 },
    });
    expect(secondPassTailSteps(30, canvas)).toBe(12);
    expect(secondPassTailSteps(8, canvas)).toBe(3);
    expect(secondPassTailSteps(8, canvas)).toBeLessThan(SECOND_PASS_CANVAS_MIN_TAIL_STEPS);
    expect(secondPassTailSteps(20, canvas)).toBe(SECOND_PASS_CANVAS_MIN_TAIL_STEPS);
  });
});
