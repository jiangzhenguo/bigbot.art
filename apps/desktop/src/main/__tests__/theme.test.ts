/**
 * normalizeTheme / 窗口底色 — 主题契约纯函数单测
 * (docs/深色浅色主题-产品设计与技术方案.md §8)
 */
import { describe, expect, it, vi } from 'vitest';
import {
  normalizeTheme,
  windowBackgroundColor,
  THEME_WINDOW_BG,
} from '../theme';

describe('normalizeTheme', () => {
  it('合法三值原样返回', () => {
    expect(normalizeTheme('system')).toBe('system');
    expect(normalizeTheme('light')).toBe('light');
    expect(normalizeTheme('dark')).toBe('dark');
  });

  it('缺省 / null / undefined → system,不记日志', () => {
    const warn = vi.fn();
    expect(normalizeTheme(undefined, warn)).toBe('system');
    expect(normalizeTheme(null, warn)).toBe('system');
    expect(warn).not.toHaveBeenCalled();
  });

  it('非法值回落 system 并记 warn', () => {
    const warn = vi.fn();
    expect(normalizeTheme('auto', warn)).toBe('system');
    expect(normalizeTheme(1, warn)).toBe('system');
    expect(normalizeTheme({ x: 1 }, warn)).toBe('system');
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0]![0]).toMatch(/非法 theme/);
  });
});

describe('windowBackgroundColor', () => {
  it('与 --bg 深浅值对齐', () => {
    expect(windowBackgroundColor(false)).toBe(THEME_WINDOW_BG.light);
    expect(windowBackgroundColor(true)).toBe(THEME_WINDOW_BG.dark);
  });
});
