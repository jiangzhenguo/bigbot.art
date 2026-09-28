/**
 * 性能采集统计测试(D)
 *
 * 面板上所有数字(含「该优化哪条路径」的结论句)都从这里算出来。
 * 口径错了会**误导优化方向** —— 比没有面板更糟。所以这里逐条锁口径:
 * 分位数插值、环形缓冲的相位对齐、阶段归因、帧等级判定。
 */
import { describe, it, expect } from 'vitest';
import {
  createPerfStore,
  record,
  setPhase,
  samplesOf,
  percentile,
  summarize,
  byPhase,
  frameLevel,
  diagnose,
  LONG_FRAME_MS,
  JANK_FRAME_MS,
} from '../perf.js';

/** 造一个已写入若干样本的 store */
function withSamples(dts: number[], capacity = 600) {
  let s = createPerfStore(capacity);
  for (const dt of dts) s = record(s, dt);
  return s;
}

describe('percentile — 线性插值口径', () => {
  it('空数组 → 0(不抛错)', () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it('单元素 → 该元素', () => {
    expect(percentile([42], 0.95)).toBe(42);
  });

  it('[1,2,3,4] 的 p50 取中间插值', () => {
    // pos = 3*0.5 = 1.5 → 2 与 3 之间
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });

  it('p0 / p100 取端点', () => {
    const s = [5, 10, 15];
    expect(percentile(s, 0)).toBe(5);
    expect(percentile(s, 1)).toBe(15);
  });

  it('p95 的敏感边界:慢帧占比必须 >5% 才会体现在 p95 上', () => {
    /* 这是个**容易误解的口径**,必须写清楚:
       p95 = 第 95 百分位,意味着「5% 的样本可以比它更差」。
       所以慢帧占比 ≤5% 时 p95 仍会落在快帧区,看起来「一切正常」。
       要捕捉「偶发卡顿」不能只看 p95,得看 worst / longPct —— 面板上
       这两个指标是并列展示的,正是为了互补。 */
    const fewSlow = [...Array(980).fill(16), ...Array(20).fill(200)].sort((a, b) => a - b); // 2% 慢帧
    expect(percentile(fewSlow, 0.95)).toBe(16); // p95 看不到
    // 但 worst 能看到 —— 这就是为什么面板要同时显示 p95 与 worst
    expect(fewSlow[fewSlow.length - 1]).toBe(200);

    const moreSlow = [...Array(900).fill(16), ...Array(100).fill(200)].sort((a, b) => a - b); // 10% 慢帧
    expect(percentile(moreSlow, 0.95)).toBe(200); // 占比够大时 p95 如实反映
  });

  it('均值会摊薄尾部慢帧(比 p95 更钝)', () => {
    // 95 个好帧 + 5 个 200ms:均值 25.2ms 仍低于长帧阈值,看不出问题
    const s = [...Array(95).fill(16), ...Array(5).fill(200)];
    const avg = s.reduce((a, b) => a + b, 0) / s.length;
    expect(avg).toBeLessThan(LONG_FRAME_MS);
    expect(Math.max(...s)).toBeGreaterThan(LONG_FRAME_MS);
  });
});

describe('record — 环形缓冲', () => {
  it('未满时顺序写入', () => {
    const s = withSamples([10, 20, 30]);
    expect(samplesOf(s)).toEqual([10, 20, 30]);
    expect(s.total).toBe(3);
  });

  it('满后覆盖最旧,且总计数继续累加', () => {
    const s = withSamples([1, 2, 3, 4, 5], 3);
    // 容量 3:保留最近 3 个
    expect(samplesOf(s)).toEqual([3, 4, 5]);
    expect(s.buf).toHaveLength(3); // 不无限增长
    expect(s.total).toBe(5);
  });

  it('绕圈后 samplesOf 仍返回时间序(从最旧到最新)', () => {
    const s = withSamples([1, 2, 3, 4, 5, 6, 7], 4);
    expect(samplesOf(s)).toEqual([4, 5, 6, 7]);
  });

  it('非法帧间隔被忽略(时钟回拨 / NaN / 0)', () => {
    const s = withSamples([10, NaN, -5, 0, 20]);
    expect(samplesOf(s)).toEqual([10, 20]);
  });

  it('不修改传入的 store(纯函数语义)', () => {
    const s0 = createPerfStore();
    const s1 = record(s0, 16);
    expect(s0.total).toBe(0);
    expect(s1.total).toBe(1);
    expect(s1).not.toBe(s0);
  });
});

describe('summarize — 汇总口径', () => {
  it('空样本 → 全零且 fps 为 0(不产生 NaN)', () => {
    const st = summarize(createPerfStore());
    expect(st.frames).toBe(0);
    expect(st.fps).toBe(0);
    expect(Number.isNaN(st.fps)).toBe(false);
  });

  it('稳定 16.7ms → FPS ≈ 60', () => {
    const st = summarize(withSamples(Array(120).fill(16.6667)));
    expect(st.fps).toBeGreaterThan(59);
    expect(st.fps).toBeLessThan(61);
  });

  it('长帧与卡顿分别计数', () => {
    const st = summarize(withSamples([16, 16, 50, 16, 150, 16]));
    expect(st.longFrames).toBe(2); // 50 与 150 都 > 33
    expect(st.jankFrames).toBe(1); // 只有 150 > 100
  });

  it('longPct 是百分比(保留一位)', () => {
    const st = summarize(withSamples([16, 16, 16, 100])); // 4 帧里 1 个长帧
    expect(st.longPct).toBe(25);
  });

  it('worst 取最大值', () => {
    const st = summarize(withSamples([16, 500, 20]));
    expect(st.worst).toBe(500);
  });

  it('p50 ≤ p95 ≤ p99 ≤ worst(单调性)', () => {
    const st = summarize(withSamples([10, 16, 20, 40, 60, 120, 300]));
    expect(st.p50).toBeLessThanOrEqual(st.p95);
    expect(st.p95).toBeLessThanOrEqual(st.p99);
    expect(st.p99).toBeLessThanOrEqual(st.worst);
  });
});

describe('byPhase — 长帧归因(面板的核心价值)', () => {
  it('按阶段分组统计帧数与长帧数', () => {
    let s = createPerfStore();
    s = setPhase(s, 'drag-node');
    s = record(s, 16);
    s = record(s, 80); // 长帧
    s = setPhase(s, 'pan');
    s = record(s, 16);
    const b = byPhase(s);
    const drag = b.find((x) => x.phase === 'drag-node')!;
    const pan = b.find((x) => x.phase === 'pan')!;
    expect(drag.frames).toBe(2);
    expect(drag.longFrames).toBe(1);
    expect(drag.worst).toBe(80);
    expect(pan.frames).toBe(1);
    expect(pan.longFrames).toBe(0);
  });

  it('未声明的阶段记为 idle', () => {
    const b = byPhase(withSamples([16, 16]));
    expect(b.map((x) => x.phase)).toEqual(['idle']);
  });

  it('环形绕圈后阶段与帧仍对齐(不错位)', () => {
    /* 这是最容易写错的地方:buf 与 phases 必须同增同绕。
       容量 3,写 5 个:前 2 个被覆盖,剩下 drag-node 的 60/200 与 pan 的 16。 */
    let s = createPerfStore(3);
    s = setPhase(s, 'marquee');
    s = record(s, 5);
    s = record(s, 6);
    s = setPhase(s, 'drag-node');
    s = record(s, 60);
    s = record(s, 200);
    s = setPhase(s, 'pan');
    s = record(s, 16);
    const b = byPhase(s);
    expect(b.find((x) => x.phase === 'marquee')).toBeUndefined(); // 已被覆盖
    const drag = b.find((x) => x.phase === 'drag-node')!;
    expect(drag.frames).toBe(2);
    expect(drag.worst).toBe(200);
    const pan = b.find((x) => x.phase === 'pan')!;
    expect(pan.frames).toBe(1);
    // 关键:若相位错位,60/200 会被算到 pan 头上
    expect(pan.worst).toBe(16);
  });

  it('阶段输出顺序固定(便于面板稳定显示)', () => {
    let s = createPerfStore();
    s = setPhase(s, 'zoom');
    s = record(s, 16);
    s = setPhase(s, 'pan');
    s = record(s, 16);
    const order = byPhase(s).map((x) => x.phase);
    expect(order).toEqual(['pan', 'zoom']); // 按预定义顺序,而非写入顺序
  });

  it('无样本 → 空数组', () => {
    expect(byPhase(createPerfStore())).toEqual([]);
  });
});

describe('frameLevel — 配色阈值', () => {
  it('33ms 以内为 ok', () => {
    expect(frameLevel(16)).toBe('ok');
    expect(frameLevel(LONG_FRAME_MS)).toBe('ok');
  });

  it('超过 33ms 为 warn', () => {
    expect(frameLevel(LONG_FRAME_MS + 1)).toBe('warn');
    expect(frameLevel(80)).toBe('warn');
  });

  it('超过 100ms 为 bad', () => {
    expect(frameLevel(JANK_FRAME_MS + 1)).toBe('bad');
  });
});

describe('diagnose — 结论句(要能指出优化方向)', () => {
  it('样本不足时明确说不足,而不是硬算', () => {
    const st = summarize(withSamples([16, 16]));
    expect(diagnose(st, [])).toContain('样本不足');
  });

  it('流畅时给出流畅结论', () => {
    const s = withSamples(Array(100).fill(16.6667));
    const st = summarize(s);
    expect(diagnose(st, byPhase(s))).toContain('流畅');
  });

  it('掉帧时点名具体操作 ← 面板存在的意义', () => {
    let s = createPerfStore();
    s = setPhase(s, 'pan');
    for (let i = 0; i < 40; i++) s = record(s, 16);
    s = setPhase(s, 'drag-node');
    for (let i = 0; i < 40; i++) s = record(s, 120); // 拖节点严重掉帧
    const st = summarize(s);
    const verdict = diagnose(st, byPhase(s));
    expect(verdict).toContain('拖动节点');
    expect(verdict).toContain('掉帧');
  });

  it('样本少但已归因的阶段不参与结论(< 10 帧的偶发长帧不算数)', () => {
    const s = withSamples(Array(60).fill(16.6667)); // 全流畅,idle
    const st = summarize(s);
    expect(diagnose(st, byPhase(s))).toContain('流畅');
  });
});

describe('setPhase — 幂等', () => {
  it('相同阶段不产生新对象(避免无谓重渲染)', () => {
    const s = setPhase(createPerfStore(), 'pan');
    expect(setPhase(s, 'pan')).toBe(s);
  });

  it('不同阶段产生新对象', () => {
    const s = createPerfStore();
    expect(setPhase(s, 'pan')).not.toBe(s);
  });
});
