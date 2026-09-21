/**
 * Vitest 配置 — BigBotArt 单元/集成测试
 * - `@bigbotart/shared` 直连源码(src),避免依赖 dist 构建产物
 * - `electron` 打桩:主进程模块(assets/frames)在纯 node 环境可加载
 * - 集成测试(ffmpeg 裁切)通过 BIGBOTART_HOME=临时目录隔离,绝不触碰真实用户数据
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@bigbotart/shared': resolve(root, 'packages/shared/src/index.ts'),
      electron: resolve(root, 'apps/desktop/src/main/__tests__/electron-stub.ts'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/**/*.{test,spec}.ts',
      'apps/desktop/src/**/*.{test,spec}.ts',
    ],
    // 每个测试文件独立进程,避免模块级常量(OUTPUTS_DIR 等)跨用例污染
    isolate: true,
  },
});