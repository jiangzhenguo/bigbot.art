/**
 * 画幅预设回归测试 — 每个预设的像素必须精确等于其比例 key(16:9 = 16:9,不能是 26:15)。
 * 历史 bug:832×480 / 480×832 实为 26:15 / 15:26,ratioOf 永不匹配预设 →
 * 点选 16:9/9:16 无高亮、出图比例错误(mlxgen 按所传宽高真实输出)。
 */
import { describe, it, expect } from 'vitest';
import { ASPECTS, ratioOf } from '../inspector/image-aspects.js';
import { SB_SIZE } from '@bigbotart/shared';

/** 断言 w/h 化简后精确等于 ratio(key) */
function assertExactRatio(key: string, w: number, h: number): void {
  const [twRaw, thRaw] = key.split(':');
  const tw = Number(twRaw);
  const th = Number(thRaw);
  expect(w / h, `${key} 像素 ${w}×${h} 必须是精确比例`).toBeCloseTo(tw / th, 6);
  expect(ratioOf(w, h), `${key} 化简比例必须还原为 key`).toBe(key);
}

describe('ASPECTS 画幅预设', () => {
  it('每个预设的像素都是其 key 的精确比例(化简后还原 key,点选即高亮)', () => {
    expect(ASPECTS.length).toBe(6);
    for (const a of ASPECTS) {
      assertExactRatio(a.key, a.w, a.h);
    }
  });

  it('16:9 / 9:16 使用 1024×576 / 576×1024(32 倍数,与 image-crop 同口径)', () => {
    const wide = ASPECTS.find((a) => a.key === '16:9');
    const tall = ASPECTS.find((a) => a.key === '9:16');
    expect([wide!.w, wide!.h]).toEqual([1024, 576]);
    expect([tall!.w, tall!.h]).toEqual([576, 1024]);
    // 除 2:3(720×1080,标准竖屏档,非 32 倍数但 mlxgen 无约束)外,其余预设保持 32 倍数
    for (const a of ASPECTS) {
      if (a.key === '2:3') continue;
      expect(a.w % 32).toBe(0);
      expect(a.h % 32).toBe(0);
    }
  });

  it('ratioOf:零值/非法返回空串', () => {
    expect(ratioOf(0, 0)).toBe('');
    expect(ratioOf(1024, 0)).toBe('');
  });
});

describe('SB_SIZE 铺节点默认画幅(shared 口径)', () => {
  it('16:9 / 9:16 与检查器预设同口径且精确', () => {
    const wide = SB_SIZE['16:9'];
    const tall = SB_SIZE['9:16'];
    assertExactRatio('16:9', wide!.width, wide!.height);
    assertExactRatio('9:16', tall!.width, tall!.height);
    expect([wide!.width, wide!.height]).toEqual([1024, 576]);
  });
});