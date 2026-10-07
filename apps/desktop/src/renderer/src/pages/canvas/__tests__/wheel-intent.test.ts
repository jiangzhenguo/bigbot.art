/**
 * 滚轮 / 触控板双指滑动意图判定(2026-10 改动的核心不变量)
 *
 * 需求原话:「单击滑动就是拖动画布改成双指滑动是拖动画布」。
 * 落到实现上有三条必须钉住的分支:
 *   ① 触控板双指滑动(像素 deltaMode + 无修饰键)→ **平移**,不再缩放;
 *   ② Ctrl/⌘ + 滑动 → 缩放(触控板捏合在 Chromium 里就是 ctrl+wheel,捏合缩放靠它);
 *   ③ 传统鼠标滚轮(行/页 deltaMode)→ 缩放(鼠标没有第二根手指,否则再也缩不了)。
 *
 * 判定与执行分离:执行侧直写 DOM 无法单测,故把「怎么判」抽成纯函数在此覆盖。
 */
import { describe, it, expect } from 'vitest';
import { wheelIntent, panOffset, zoomFactorFor } from '../wheel-intent';

describe('wheelIntent — 双指滑动 vs 滚轮', () => {
  it('触控板双指滑动(像素模式、无修饰键)→ 平移', () => {
    expect(wheelIntent({ deltaMode: 0 })).toBe('pan');
    expect(wheelIntent({})).toBe('pan');
  });

  it('Ctrl + 滑动 → 缩放(触控板捏合被 Chromium 合成为 ctrl+wheel)', () => {
    expect(wheelIntent({ ctrlKey: true, deltaMode: 0 })).toBe('zoom');
  });

  it('⌘ + 滑动 → 缩放', () => {
    expect(wheelIntent({ metaKey: true, deltaMode: 0 })).toBe('zoom');
  });

  it('传统鼠标滚轮(行/页模式)→ 缩放', () => {
    expect(wheelIntent({ deltaMode: 1 })).toBe('zoom');
    expect(wheelIntent({ deltaMode: 2 })).toBe('zoom');
  });

  it('shiftKey 不参与判定:横滑不会因顺带的 shift 变成缩放', () => {
    // 触控板横向滑动时 Chromium 有时会带上 shift;
    // 若据 shift 改判,会得到「横滑突然缩放」的怪异手感 —— 横滑就该横移画布
    expect(wheelIntent({ deltaMode: 0, shiftKey: true })).toBe('pan');
  });

  it('没有任何字段的裸对象仍按触控板默认处理(平移),不抛错', () => {
    expect(() => wheelIntent({})).not.toThrow();
    expect(wheelIntent({})).toBe('pan');
  });
});

describe('panOffset — 滑动位移 → 视口平移', () => {
  it('方向取负:手指左滑(deltaX<0)时视口原点右移(内容跟着左走,自然滚动)', () => {
    expect(panOffset(-30, 0)).toEqual({ dx: 30, dy: 0 });
    expect(panOffset(0, -30)).toEqual({ dx: 0, dy: 30 });
  });

  it('竖直滚动向下(deltaY>0)= 视口上移,内容向上走', () => {
    expect(panOffset(0, 40)).toEqual({ dx: 0, dy: -40 });
  });

  it('平移量与缩放无关 —— 不除以 z(平移在 transform 的 scale 之前)', () => {
    // 纯函数签名里根本没有 z,这里锁的是「别有人后来加一个 z 参数进来」
    expect(panOffset.length).toBe(2);
    // 1px 滑动恒等 1px 位移
    expect(panOffset(1, 1)).toEqual({ dx: -1, dy: -1 });
  });

  it('NaN / Infinity 一律归零,不产生 NaN 视口(否则整张画布消失)', () => {
    expect(panOffset(NaN, 0)).toEqual({ dx: 0, dy: 0 });
    expect(panOffset(0, NaN)).toEqual({ dx: 0, dy: 0 });
    expect(panOffset(Infinity, -Infinity)).toEqual({ dx: 0, dy: 0 });
  });
});

describe('zoomFactorFor — 滚轮 deltaY → 缩放因子', () => {
  it('向上滚(deltaY<0)放大、向下滚缩小', () => {
    expect(zoomFactorFor(-100)).toBeGreaterThan(1);
    expect(zoomFactorFor(100)).toBeLessThan(1);
  });

  it('上下对称:一个 deltaY 与其相反数的因子互为倒数', () => {
    expect(zoomFactorFor(-120) * zoomFactorFor(120)).toBeCloseTo(1, 10);
  });

  it('deltaY = 0 → 因子 1(不缩放)', () => {
    expect(zoomFactorFor(0)).toBe(1);
  });

  it('非法 deltaY 归零为不缩放,不产生 NaN 倍率', () => {
    expect(zoomFactorFor(NaN)).toBe(1);
    expect(zoomFactorFor(Infinity)).toBe(1);
  });
});
