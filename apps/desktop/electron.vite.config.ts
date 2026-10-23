import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, 'src/main/index.ts') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, 'src/preload/index.ts') },
    },
  },
  renderer: {
    plugins: [react()],
    // ⚠️ 必须保持相对路径(base: './')。
    // 网页端的静态资源是相对引用(./assets/…),由**文档自己的 URL** 解析 ——
    // 网页跑在公网域名的一个路径前缀下(例如 https://host/bba/),
    // 相对引用才会跟着落到 /bba/assets/…,与接口前缀一致。
    // 改成绝对 base('/')会让资源跑到根路径,与接口前缀对不上(页面能开但全白)。
    // electron-vite 默认就是 './',这里写死是为了不让它被无声改掉。
    base: './',
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
      },
    },
  },
});