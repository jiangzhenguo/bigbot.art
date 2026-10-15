/**
 * 时长输入解析单测(2026-10-09 「5 秒变 1 秒」事故)
 *
 * 事故形态:镜头 03 的时长明明填了 5 秒,用户**点一下输入框**就变成 1 秒。
 *
 * 根因:`type="number"` 的受控输入框在「全选后重输」「退格删到空」时会先抛出**空串**,
 * 而旧代码是 `Number(e.target.value)` → `Number('') === 0` → `0 <= 0` 成立
 * → 立刻 `setData({ seconds: 0 })` 把值清掉。
 * 值被清空后 `value` 回落成空串,placeholder 显示按 frames 推算的时长,看着就像"变成 1 秒"。
 *
 * 旁证:测试2 画布 12 个镜头里**只有 1 个**保留了 seconds,其余 11 个都是空 ——
 * 完全符合「点一下就丢」的形态。
 */
import { describe, it, expect } from 'vitest';
import { parseSecondsInput, h3FramesForSeconds, SHOT_MAX_SECONDS } from '../constants';

describe('parseSecondsInput — 空串绝不能清空数据(事故根因)', () => {
  it('空串 → keep=true(不写盘),而不是 seconds=0', () => {
    const r = parseSecondsInput('');
    expect(r.keep).toBe(true);
    expect(r.seconds).toBeUndefined(); // 关键:不能是 0
  });

  it('纯空白 → 同样 keep', () => {
    expect(parseSecondsInput('   ').keep).toBe(true);
  });

  it('回归断言:空串不会再被算成 0 并写进节点', () => {
    /* 旧逻辑「!isFinite(s) || s <= 0 → setData({seconds:0})」在这里必然把值清掉。
       新逻辑必须 keep —— 这条断言就是那个 bug 的墓碑。 */
    const r = parseSecondsInput('');
    expect(r.keep).toBe(true);
    expect(JSON.stringify(r)).not.toContain('"seconds":0');
  });
});

describe('parseSecondsInput — 非法中间态也不丢', () => {
  it('只打了负号 "-" → keep(用户还在输入)', () => {
    expect(parseSecondsInput('-').keep).toBe(true);
  });

  it('字母 → keep', () => {
    expect(parseSecondsInput('abc').keep).toBe(true);
  });

  it('0 / 负数 → keep(不写 0,不丢原值)', () => {
    expect(parseSecondsInput('0').keep).toBe(true);
    expect(parseSecondsInput('-3').keep).toBe(true);
  });
});

describe('parseSecondsInput — 合法值正常落盘', () => {
  it('"5" → seconds=5 且 frames 按 5+17n 对齐', () => {
    const r = parseSecondsInput('5');
    expect(r.keep).toBe(false);
    expect(r.seconds).toBe(5);
    expect(r.frames).toBe(h3FramesForSeconds(5));
    expect(r.frames).toBe(124); // 事故里那个镜头用的就是 124 帧
  });

  it('各档位秒数都能解析', () => {
    for (const s of [1, 2, 3, 4, 6, 8, 10, 15]) {
      const r = parseSecondsInput(String(s));
      expect(r.keep).toBe(false);
      expect(r.seconds).toBe(s);
    }
  });

  it('前后空白被容忍("  5  " → 5)', () => {
    expect(parseSecondsInput('  5  ').seconds).toBe(5);
  });

  it('小数也能解析', () => {
    const r = parseSecondsInput('2.5');
    expect(r.keep).toBe(false);
    expect(r.seconds).toBe(2.5);
  });
});

describe('parseSecondsInput — 上限截断', () => {
  it('超过 15 秒 → 截断到 15 并标记 clamped(调用方据此提示用户)', () => {
    const r = parseSecondsInput('30');
    expect(r.keep).toBe(false);
    expect(r.seconds).toBe(SHOT_MAX_SECONDS);
    expect(SHOT_MAX_SECONDS).toBe(15);
    expect(r.clamped).toBe(true);
  });

  it('正好 15 秒 → 不算截断', () => {
    const r = parseSecondsInput('15');
    expect(r.seconds).toBe(15);
    expect(r.clamped).toBe(false);
  });
});
