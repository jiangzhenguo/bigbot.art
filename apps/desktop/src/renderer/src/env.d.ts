/// <reference types="vite/client" />
import type { BigBotArtApi } from '../../preload/index';

declare global {
  interface Window {
    bigbotart: BigBotArtApi;
    /** preload 设为 true。网页入口在挂 HTTP 客户端时设为 false。未设置按桌面。 */
    bigbotartShell?: boolean;
  }
}

export {};