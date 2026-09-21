/**
 * electron 打桩 — 仅用于 vitest(node 环境)
 * 主进程模块(assets.ts 等)顶层 import { dialog, BrowserWindow } from 'electron';
 * 纯 node 下 electron 包不可按命名导出加载,这里提供最小空实现。
 * 被测代码(frames 裁切 / 资产元数据)不触碰这些符号;用到时按需补充。
 */
export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showMessageBox: async () => ({ response: 0 }),
};

export const BrowserWindow = class {
  static getAllWindows() {
    return [];
  }
};

export const app = {
  getPath: () => '/tmp',
  whenReady: () => Promise.resolve(),
  on: () => {},
};

export const shell = { openPath: async () => 'ok', showItemInFolder: () => {} };
export const protocol = { registerSchemesAsPrivileged: () => {}, handle: async () => {} };
export const net = { fetch: async () => new Response() };