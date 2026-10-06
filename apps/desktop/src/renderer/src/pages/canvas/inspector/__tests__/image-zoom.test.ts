/**
 * image-zoom 测试 — 全屏看图缩放数学(纯函数)
 *
 * 覆盖三类:钳制(不越界 / 不产生 NaN)、以光标为锚点的缩放(点不动 = 直觉正确)、
 * 档位步进与平移钳制(未放大时居中、放大后可拖到边缘)。这些是交互里最容易算错、
 * 又最难肉眼验证的部分(锚点算错的表现是「图往一侧漂」)。
 *
 * 约定:W/H = 视口尺寸,S = 图片 contain 后的显示尺寸;zoom=1 即适应窗口。
 */
import { describe, it, expect } from 'vitest';
import {
  IDENTITY_VIEW,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STOPS,
  clamp,
  clampPanView,
  clampZoom,
  nextStop,
  panDeltaFor,
  panLimit,
  zoomAtPoint,
  zoomByFactor,
  zoomLabel,
  zoomToStop,
} from '../lib/image-zoom.js';

/** 测试常用的一对尺寸:图片与视口同宽高比(方形视口 + 方形图),便于手算 */
const W = 1000;
const H = 800;

describe('clamp / clampZoom', () => {
  it('钳进区间', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it('NaN 回落下界,+Infinity 落上界(不产生 NaN 视图)', () => {
    expect(clamp(Number.NaN, 0, 10)).toBe(0);
    expect(clamp(Number.POSITIVE_INFINITY, 0, 10)).toBe(10);
    expect(clamp(Number.NEGATIVE_INFINITY, 0, 10)).toBe(0);
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(MAX_ZOOM);
  });

  it('缩放倍率被钳在 0.25–12', () => {
    expect(clampZoom(0.001)).toBe(MIN_ZOOM);
    expect(clampZoom(999)).toBe(MAX_ZOOM);
    expect(clampZoom(3)).toBe(3);
  });
});

describe('panLimit / clampPanView', () => {
  it('未放大时不允许平移(图片居中不动)', () => {
    expect(clampPanView(0.5, -0.5, 1, 800, 600, W, H)).toEqual({ tx: 0, ty: 0 });
    // -0 必须归一化成 0(否则断言与快照会抖)
    expect(clampPanView(-0, -0, 1, 800, 600, W, H)).toEqual({ tx: 0, ty: 0 });
  });

  it('视觉尺度 = z·S + (z−1)·L:界按此口径给出', () => {
    // 图 1000×800 恰填满 1000×800(无留白),放大 2 倍:
    // 横向 slack = 2·1000 + 1·800 = 2800 → (2800−1000)/2 = 900 → 900/1000 = 0.9
    // 纵向 slack = 2·800 + 1·1000 = 2600 → (2600−800)/2 = 900 → 900/800 = 1.125
    const lim = panLimit(2, 1000, 800, W, H);
    expect(lim.x).toBeCloseTo(0.9, 9);
    expect(lim.y).toBeCloseTo(1.125, 9);
  });

  it('未铺满方向上的留白随缩放一起撑开(拖到底仍贴边、不露白)', () => {
    // 图 500×500 在 1000×800 视口:左右各留 250;放大 2 倍后图宽 1000,留白被撑成每边 500
    // 横向 slack = 1000 + 500 = 1500 → (1500−1000)/2 = 250 → 250/500 = 0.5
    // 纵向 slack = 1000 + 500 = 1500 → (1500−800)/2  = 350 → 350/500 = 0.7
    const lim = panLimit(2, 500, 500, W, H);
    expect(lim.x).toBeCloseTo(0.5, 9);
    expect(lim.y).toBeCloseTo(0.7, 9);
  });

  it('放大后视觉尺度仍不超过视口时居中不动', () => {
    // 图 400×400,z=2:横向 slack = 800 + 400 = 1200 > 1000 → 有界
    // 纵向 slack = 800 + 400 = 1200 > 800 → 有界(均按同一口径,不再人为分成“短边/长边”)
    const lim = panLimit(2, 400, 400, W, H);
    expect(lim.x).toBeCloseTo(0.25, 9);
    expect(lim.y).toBeCloseTo(0.5, 9);
    // 小图小倍率:100×100 在 1000×1000,2× → slack = 200 + 100 = 300 < 1000 → 居中
    expect(panLimit(2, 100, 100, 1000, 1000)).toEqual({ x: 0, y: 0 });
    // 6× → slack = 600 + 500 = 1100 > 1000 → (1100−1000)/2 = 50 → 50/100 = 0.5
    expect(panLimit(6, 100, 100, 1000, 1000).x).toBeCloseTo(0.5, 9);
    // 未放大时一律居中
    expect(panLimit(1, 1000, 800, W, H)).toEqual({ x: 0, y: 0 });
  });

  it('NaN 输入回落 0(拖拽事件缺字段时不会把图片拖飞)', () => {
    expect(clampPanView(Number.NaN, 0, 3, 800, 600, W, H)).toEqual({ tx: 0, ty: 0 });
  });

  it('视口未测量(0)时钳为居中', () => {
    expect(clampPanView(0.7, 0.7, 3, 800, 600, 0, 0)).toEqual({ tx: 0, ty: 0 });
  });
});

describe('zoomAtPoint', () => {
  it('放大后锚点仍在同一屏幕位置(触控板捏合的直觉)', () => {
    // 图 1000×800 恰填满视口;光标在中心右侧 200px → 锚点在图片坐标 a = 0.2;
    // 放大到 2 倍后 t' = a - a·2 = -0.2(即图片左移 0.2 个图宽 → 该点留在原处)
    const v = zoomAtPoint(IDENTITY_VIEW, 2, 200, 0, W, H, W, H);
    expect(v.zoom).toBe(2);
    expect(v.tx).toBeCloseTo(-0.2, 9);
  });

  it('锚点在图片之内时精确对齐(a=0.3 → 该点缩放后仍在原处)', () => {
    // 图 500×400 居中于 1000×800 视口 → 图片盒 x∈[−250,250](相对视口中心)。
    // 光标 px=+400 落在图片外?不:换算后 a=(400−250)/500=0.3,仍在图片内(左半偏右)。
    // 故不触发边界钳制,按通式得 t' = a − a·2 = −0.3,且 |t'| < 界 0.4
    const v = zoomAtPoint(IDENTITY_VIEW, 2, 400, 0, 500, 400, W, H);
    expect(v.tx).toBeCloseTo(-0.3, 9);
  });

  it('锚点确实在图片之外 → 钳到图片边界,结果仍受平移界约束', () => {
    // 同上尺寸,光标 px=+700 → 屏幕位置已越过图片右边界(250):
    // a = (700−250)/500 = 0.9(图示:仍在范围内),px=+900 → a 被钳到 1
    const dw = 500;
    const dh = 400;
    const lim = panLimit(2, dw, dh, W, H);
    const v = zoomAtPoint(IDENTITY_VIEW, 2, 900, 0, dw, dh, W, H);
    // a=1 → t' = 1 − 2 = −1 → 被界钳住(slack = 2·500 + 1·400 = 1400 → (1400−1000)/2/500 = 0.4)
    expect(lim.x).toBeCloseTo(0.4, 9);
    expect(v.tx).toBeCloseTo(-0.4, 9);
    expect(Math.abs(v.tx)).toBeLessThanOrEqual(lim.x + 1e-9);
  });

  it('图片与视口同宽高比且填满时:锚点偏移按比例缩放', () => {
    // 图 1000×800 恰填满视口;光标在中心右侧 200px → a = 200/1000 = 0.2
    // t' = a - (a - 0) · 2 = -0.2;平移到 2× 后可移 (2000-1000)/2 = 500 → 0.5,不被钳
    const v = zoomAtPoint(IDENTITY_VIEW, 2, 200, 0, W, H, W, H);
    expect(v.tx).toBeCloseTo(-0.2, 9);
    expect(v.ty).toBeCloseTo(0, 9);
  });

  it('视口中心锚点 = 纯缩放(不产生偏移)', () => {
    const v = zoomAtPoint({ zoom: 1, tx: 0, ty: 0 }, 2, 0, 0, W, H, W, H);
    expect(v).toEqual({ zoom: 2, tx: 0, ty: 0 });
  });

  it('缩放结果同样走平移钳制(锚点补偿不会把图顶出视口)', () => {
    const v = zoomAtPoint(IDENTITY_VIEW, 1.2, 9999, 9999, 1000, 1000, W, H);
    const lim = panLimit(1.2, 1000, 1000, W, H);
    expect(Math.abs(v.tx)).toBeLessThanOrEqual(lim.x + 1e-9);
    expect(Math.abs(v.ty)).toBeLessThanOrEqual(lim.y + 1e-9);
  });

  it('倍率被钳制(超上限时结果 = 上限)', () => {
    expect(zoomAtPoint({ zoom: 9, tx: 0, ty: 0 }, 100, 0, 0, 800, 600, W, H).zoom).toBe(MAX_ZOOM);
  });

  it('视口 / 图片尺寸未测量或锚点非法 → 退化为纯缩放,不产生 NaN', () => {
    expect(zoomAtPoint({ zoom: 1, tx: 0, ty: 0 }, 2, 10, 10, 0, 0, 0, 0)).toEqual({ zoom: 2, tx: 0, ty: 0 });
    expect(zoomAtPoint({ zoom: 1, tx: 0, ty: 0 }, 2, 10, 10, 0, 0, W, H)).toEqual({ zoom: 2, tx: 0, ty: 0 });
    expect(Number.isNaN(zoomAtPoint({ zoom: 1, tx: 0, ty: 0 }, 2, Number.NaN, 0, 800, 600, W, H).tx)).toBe(false);
  });

  it('缩回 1× 后偏移被清零(避免带着放大期的平移量显示错位)', () => {
    const zoomed = zoomAtPoint(IDENTITY_VIEW, 3, 300, 200, W, H, W, H);
    expect(zoomed.tx).not.toBe(0);
    const back = zoomAtPoint(zoomed, 1, 300, 200, W, H, W, H);
    expect(back).toEqual({ zoom: 1, tx: 0, ty: 0 });
  });

  it('放大再等量缩回是可逆的(往返回到原点)', () => {
    const a = zoomAtPoint(IDENTITY_VIEW, 2, 150, -80, W, H, W, H);
    const b = zoomAtPoint(a, 1, 150, -80, W, H, W, H);
    expect(b.tx).toBeCloseTo(0, 9);
    expect(b.ty).toBeCloseTo(0, 9);
  });
});

describe('zoomByFactor', () => {
  it('因子按乘法叠加', () => {
    const v = zoomByFactor(IDENTITY_VIEW, 1.5, 0, 0, W, H, W, H);
    expect(v.zoom).toBeCloseTo(1.5, 9);
    expect(zoomByFactor(v, 2, 0, 0, W, H, W, H).zoom).toBeCloseTo(3, 9);
  });

  it('非法因子退化为不变(不缩放)', () => {
    expect(zoomByFactor(IDENTITY_VIEW, Number.NaN, 0, 0, W, H, W, H).zoom).toBe(1);
    expect(zoomByFactor(IDENTITY_VIEW, 0, 0, 0, W, H, W, H).zoom).toBe(1);
    expect(zoomByFactor(IDENTITY_VIEW, -2, 0, 0, W, H, W, H).zoom).toBe(1);
  });

  it('持续缩放被钳制在上下限内', () => {
    let v = IDENTITY_VIEW;
    for (let i = 0; i < 60; i += 1) v = zoomByFactor(v, 1.4, 0, 0, W, H, W, H);
    expect(v.zoom).toBe(MAX_ZOOM);
    for (let i = 0; i < 80; i += 1) v = zoomByFactor(v, 0.7, 0, 0, W, H, W, H);
    expect(v.zoom).toBe(MIN_ZOOM);
  });
});

describe('nextStop / zoomToStop', () => {
  it('向上取下一个更大的档位', () => {
    expect(nextStop(1, 1)).toBeCloseTo(1.5, 9);
    expect(nextStop(1.2, 1)).toBeCloseTo(1.5, 9);
    expect(nextStop(0.3, 1)).toBeCloseTo(0.5, 9);
  });

  it('向下取下一个更小的档位', () => {
    expect(nextStop(1, -1)).toBeCloseTo(0.75, 9);
    expect(nextStop(1.4, -1)).toBeCloseTo(1, 9);
    expect(nextStop(0.26, -1)).toBeCloseTo(0.25, 9);
  });

  it('端点停住不越界(按钮在那里应置灰)', () => {
    expect(nextStop(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(nextStop(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });

  it('档位序列本身合法(递增且在钳制区间内)', () => {
    expect([...ZOOM_STOPS].sort((a, b) => a - b)).toEqual(ZOOM_STOPS);
    expect(ZOOM_STOPS[0]).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(ZOOM_STOPS[ZOOM_STOPS.length - 1]).toBeLessThanOrEqual(MAX_ZOOM);
  });

  it('zoomToStop 以视口中心为锚点 = 纯缩放', () => {
    const v = zoomToStop(IDENTITY_VIEW, 1, W, H, W, H);
    expect(v.zoom).toBeCloseTo(1.5, 9);
    expect(v.tx).toBe(0);
    expect(v.ty).toBe(0);
  });
});

describe('panDeltaFor', () => {
  it('屏幕位移 ÷ 图片未缩放尺寸 = t 增量(与 zoom 无关)', () => {
    // 图片显示宽 600,想让它屏幕移动 60px → t 增量 0.1
    expect(panDeltaFor(60, 600)).toBeCloseTo(0.1, 9);
    // 同样 60px 位移,图片更小(300)时需要更大的 t
    expect(panDeltaFor(60, 300)).toBeCloseTo(0.2, 9);
  });

  it('⚠️ 回归:不能按「缩放后尺寸」换算(否则键盘平移随放大变慢)', () => {
    // 若错误地除以 z(用 z·S 当基准),z=2 时会得到 0.05 而不是 0.1 —— 位移只有一半
    const correct = panDeltaFor(60, 600);
    const wrong = panDeltaFor(60, 600) / 2;
    expect(correct).toBeCloseTo(0.1, 9);
    expect(correct).not.toBeCloseTo(wrong, 9);
  });

  it('非法输入回落到 0(不产生 NaN 平移)', () => {
    expect(panDeltaFor(Number.NaN, 600)).toBe(0);
    expect(panDeltaFor(60, 0)).toBe(0);
    expect(panDeltaFor(60, Number.NaN)).toBe(0);
  });
});

describe('zoomLabel', () => {
  it('格式化为整数百分比', () => {
    expect(zoomLabel(1)).toBe('100%');
    expect(zoomLabel(0.25)).toBe('25%');
    expect(zoomLabel(2.5)).toBe('250%');
    expect(zoomLabel(Number.NaN)).toBe('25%');
  });
});
