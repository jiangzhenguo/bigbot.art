/**
 * 画幅预设回归测试 — 每个预设的像素必须精确等于其比例 key(16:9 = 16:9,不能是 26:15)。
 * 历史 bug:832×480 / 480×832 实为 26:15 / 15:26,ratioOf 永不匹配预设 →
 * 点选 16:9/9:16 无高亮、出图比例错误(mlxgen 按所传宽高真实输出)。
 */
import { describe, it, expect } from 'vitest';
import {
  ASPECTS,
  BASE_RESOLUTIONS,
  aspectKeyOf,
  baseResolutionOf,
  ratioOf,
  resizeToBase,
} from '../inspector/image-aspects.js';
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

describe('基础分辨率档(1K / 1.5K / 2K)', () => {
  it('三档长边分别为 1024 / 1536 / 2048', () => {
    expect(BASE_RESOLUTIONS.map((r) => [r.key, r.longEdge])).toEqual([
      ['1k', 1024],
      ['1.5k', 1536],
      ['2k', 2048],
    ]);
  });

  it('16:9 换档得出 1024×576 / 1536×864 / 2048×1152(比例不变)', () => {
    const src = { w: 1024, h: 576 };
    expect(resizeToBase(src.w, src.h, 1024)).toEqual({ w: 1024, h: 576 });
    expect(resizeToBase(src.w, src.h, 1536)).toEqual({ w: 1536, h: 864 });
    expect(resizeToBase(src.w, src.h, 2048)).toEqual({ w: 2048, h: 1152 });
  });

  it('1:1 换档得出 1024² / 1536² / 2048²', () => {
    expect(resizeToBase(1024, 1024, 1536)).toEqual({ w: 1536, h: 1536 });
    expect(resizeToBase(1024, 1024, 2048)).toEqual({ w: 2048, h: 2048 });
  });

  it('每个画幅换到每一档后,长边精确等于目标像素', () => {
    for (const a of ASPECTS) {
      for (const r of BASE_RESOLUTIONS) {
        const out = resizeToBase(a.w, a.h, r.longEdge);
        expect(Math.max(out.w, out.h), `${a.key} @ ${r.label} 长边`).toBe(r.longEdge);
      }
    }
  });

  it('换档后画幅仍然匹配原比例(容差匹配,宽高取整不丢高亮)', () => {
    for (const a of ASPECTS) {
      for (const r of BASE_RESOLUTIONS) {
        const out = resizeToBase(a.w, a.h, r.longEdge);
        expect(aspectKeyOf(out.w, out.h), `${a.key} @ ${r.label} → ${out.w}×${out.h}`).toBe(a.key);
      }
    }
  });

  it('2:3 是取整最危险的一档,长边 1024 时仍不得漂成 21:32', () => {
    const out = resizeToBase(720, 1080, 1024);
    expect(out).toEqual({ w: 683, h: 1024 });
    expect(aspectKeyOf(out.w, out.h)).toBe('2:3');
    // 旧 21:32 (672×1024) 就是「选 2:3 却出别的比例」的形态,必须判不匹配
    expect(aspectKeyOf(672, 1024)).not.toBe('2:3');
  });

  it('自定义尺寸按长边等比缩放(800×600 → 1024×768)', () => {
    expect(resizeToBase(800, 600, 1024)).toEqual({ w: 1024, h: 768 });
    expect(aspectKeyOf(1024, 768)).toBe('4:3');
  });

  it('非法宽高原样返回,不写坏 data', () => {
    expect(resizeToBase(0, 0, 1024)).toEqual({ w: 0, h: 0 });
    expect(resizeToBase(1024, 576, 0)).toEqual({ w: 1024, h: 576 });
    expect(baseResolutionOf(0, 0)).toBeNull();
  });

  it('baseResolutionOf:命中档位 / 自定义长边返回 null', () => {
    expect(baseResolutionOf(1024, 576)?.key).toBe('1k');
    expect(baseResolutionOf(1536, 864)?.key).toBe('1.5k');
    expect(baseResolutionOf(2048, 1152)?.key).toBe('2k');
    expect(baseResolutionOf(1280, 720)).toBeNull();
    // 2:3 在 1K 档缩放后长边仍是 1024(取整不会把它顶到 1056)
    expect(baseResolutionOf(683, 1024)?.key).toBe('1k');
  });

  it('aspectKeyOf:历史错误尺寸 832×480(26:15)不再伪装成 16:9', () => {
    expect(aspectKeyOf(832, 480)).toBe('');
    expect(aspectKeyOf(1024, 576)).toBe('16:9');
  });
});