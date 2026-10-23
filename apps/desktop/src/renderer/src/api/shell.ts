/** 桌面壳由 preload 把 bigbotartShell 设为 true。网页入口显式设为 false。未设置时按桌面(现有单测不设这个标志)。 */
export function isDesktopShell(): boolean {
  return typeof window === 'undefined' || window.bigbotartShell !== false;
}
