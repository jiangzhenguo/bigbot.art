/// <reference types="vite/client" />
import type { BigBotArtApi } from '../../preload/index';

declare global {
  interface Window {
    bigbotart: BigBotArtApi;
  }
}

export {};