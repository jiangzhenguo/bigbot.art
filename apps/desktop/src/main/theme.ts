/**
 * 主题开关 — Electron nativeTheme 为唯一源
 * (见 docs/深色浅色主题-产品设计与技术方案.md §4 / §5.2)
 *
 * 渲染层 CSS 只依赖 `prefers-color-scheme`;themeSource 设为
 * 'dark' | 'light' | 'system' 后媒体查询立即跟随,系统菜单/对话框一并跟随。
 */
import { nativeTheme, type BrowserWindow } from 'electron';
import type { ThemePref } from '@bigbotart/shared';

/** 与 colors_and_type.css `--bg` 深浅两套值对齐,窗口露底时不闪反色 */
export const THEME_WINDOW_BG = {
  light: '#ffffff',
  dark: '#1c1c1e',
} as const;

export function normalizeTheme(
  raw: unknown,
  logWarn?: (msg: string) => void,
): ThemePref {
  if (raw === 'system' || raw === 'light' || raw === 'dark') return raw;
  if (raw !== undefined && raw !== null) {
    logWarn?.(`非法 theme 值 ${JSON.stringify(raw)}，回落 system`);
  }
  return 'system';
}

export function windowBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? THEME_WINDOW_BG.dark : THEME_WINDOW_BG.light;
}

/** 启动 / patch 时调用:写入 themeSource,原生控件与 prefers-color-scheme 同步 */
export function applyThemeSource(theme: ThemePref): void {
  nativeTheme.themeSource = theme;
}

/** 窗口底色跟随当前解析结果(防缩放/拖出时露底闪色) */
export function syncWindowBackground(win: BrowserWindow | null | undefined): void {
  if (!win || win.isDestroyed()) return;
  win.setBackgroundColor(windowBackgroundColor(nativeTheme.shouldUseDarkColors));
}
