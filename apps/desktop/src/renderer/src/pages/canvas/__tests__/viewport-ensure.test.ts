/**
 * 选中避让 / 检查器宽度 — 纯函数单测
 */
import { describe, expect, it } from 'vitest';
import {
  clampInspWidth,
  easeOutCubic,
  ensureWorldBoxVisible,
  leftChromeWidth,
  lerpView,
  panDeltaToFit,
  rightChromeWidth,
  worldBoxToScreen,
  DEFAULT_INSP_W,
  MIN_INSP_W,
  PANEL_EDGE,
  PANEL_TOP,
  PALETTE_W,
  INSP_PALETTE_GAP,
} from '../viewport-ensure';

describe('leftChromeWidth', () => {
  it('检查器关 + 面板开 = 12 + 200', () => {
    expect(leftChromeWidth({ inspOpen: false, inspW: 300, palCollapsed: false })).toBe(
      PANEL_EDGE + PALETTE_W,
    );
  });

  it('检查器关 + 面板收起 = 0', () => {
    expect(leftChromeWidth({ inspOpen: false, inspW: 300, palCollapsed: true })).toBe(0);
  });

  it('检查器开 + 面板开 = 12 + inspW + 8 + 200', () => {
    expect(leftChromeWidth({ inspOpen: true, inspW: 300, palCollapsed: false })).toBe(
      PANEL_EDGE + 300 + INSP_PALETTE_GAP + PALETTE_W,
    );
  });

  it('检查器开 + 面板收起 = 12 + inspW + 8', () => {
    expect(leftChromeWidth({ inspOpen: true, inspW: 280, palCollapsed: true })).toBe(
      PANEL_EDGE + 280 + INSP_PALETTE_GAP,
    );
  });
});

describe('worldBoxToScreen / panDeltaToFit', () => {
  it('identity view 下屏幕坐标 = 世界坐标', () => {
    expect(worldBoxToScreen({ x: 100, y: 50, w: 224, h: 120 }, { x: 0, y: 0, z: 1 })).toEqual({
      left: 100,
      top: 50,
      right: 324,
      bottom: 170,
    });
  });

  it('节点被左侧检查器挡住 → dx 为正(视口右移,节点相对屏幕右移)', () => {
    // 节点屏幕落在 left=40,检查器占到 320,安全左缘 ≈ 320+24
    const screen = { left: 40, top: 100, right: 264, bottom: 220 };
    const { dx, dy } = panDeltaToFit(
      screen,
      { w: 1200, h: 800 },
      { left: 320, top: PANEL_TOP, right: 356, bottom: PANEL_EDGE },
    );
    expect(dx).toBeGreaterThan(0);
    expect(dy).toBe(0);
    expect(screen.left + dx).toBe(320 + 24);
  });

  it('已在安全区内 → 零平移', () => {
    const { dx, dy } = panDeltaToFit(
      { left: 400, top: 120, right: 624, bottom: 240 },
      { w: 1200, h: 800 },
      { left: 320, top: PANEL_TOP, right: 356, bottom: PANEL_EDGE },
    );
    expect(dx).toBe(0);
    expect(dy).toBe(0);
  });

  it('节点比安全区更宽 → 贴齐左缘(不钻进检查器)', () => {
    const { dx } = panDeltaToFit(
      { left: 10, top: 100, right: 900, bottom: 220 },
      { w: 1000, h: 800 },
      { left: 320, top: PANEL_TOP, right: 100, bottom: PANEL_EDGE },
    );
    expect(10 + dx).toBe(320 + 24);
  });
});

describe('ensureWorldBoxVisible', () => {
  it('挡住则返回新 view,否则 null', () => {
    const stage = { w: 1200, h: 800 };
    const insets = {
      left: leftChromeWidth({ inspOpen: true, inspW: DEFAULT_INSP_W, palCollapsed: false }),
      top: PANEL_TOP,
      right: rightChromeWidth(344),
      bottom: PANEL_EDGE,
    };
    // 节点在世界 (0,100), view 默认附近 → 屏幕左侧被挡
    const next = ensureWorldBoxVisible({
      box: { x: 0, y: 100, w: 224, h: 160 },
      view: { x: 20, y: 10, z: 0.86 },
      stage,
      insets,
    });
    expect(next).not.toBeNull();
    expect(next!.x).toBeGreaterThan(20);

    // 安全区约 left≈544 / right≈820;节点屏幕宽≈193 → 世界 x=650 落在中间
    const ok = ensureWorldBoxVisible({
      box: { x: 650, y: 200, w: 224, h: 160 },
      view: { x: 20, y: 10, z: 0.86 },
      stage,
      insets,
    });
    expect(ok).toBeNull();
  });
});

describe('clampInspWidth', () => {
  it('下限 MIN_INSP_W,默认附近可取', () => {
    expect(clampInspWidth(100, 480)).toBe(MIN_INSP_W);
    expect(clampInspWidth(300, 480)).toBe(300);
    expect(clampInspWidth(999, 480)).toBeLessThanOrEqual(480);
  });
});

describe('easeOutCubic / lerpView', () => {
  it('ease 端点钉死 0/1,中段 < 线性(先快后慢)', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });

  it('lerpView 在 t=1 落到目标', () => {
    const v = lerpView({ x: 0, y: 0, z: 1 }, { x: 100, y: 40, z: 1 }, 1);
    expect(v).toEqual({ x: 100, y: 40, z: 1 });
  });
});
