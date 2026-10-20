/**
 * 安装包 worker 入口。
 * ELECTRON_RUN_AS_NODE 读不了 app.asar,所以安装包走 app.asar.unpacked 里的 worker.js。
 * 2026-10-20 曾改走 esbuild 单文件 worker.bundle.js,循环依赖把 ModelsImpl
 * 留成未初始化,对话报 "ModelsImpl is not a constructor"。入口必须继续用 tsc 的 worker.js。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkerEntry } from '../manager.js';

function layout(): { asarDist: string; unpackedDist: string } {
  const root = mkdtempSync(join(tmpdir(), 'bba-worker-entry-'));
  const asarDist = join(root, 'app.asar', 'node_modules', '@bigbotart', 'agent', 'dist');
  const unpackedDist = join(root, 'app.asar.unpacked', 'node_modules', '@bigbotart', 'agent', 'dist');
  mkdirSync(asarDist, { recursive: true });
  mkdirSync(unpackedDist, { recursive: true });
  return { asarDist, unpackedDist };
}

describe('resolveWorkerEntry', () => {
  it('开发目录走旁边的 worker.js', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bba-worker-dev-'));
    writeFileSync(join(dir, 'worker.bundle.js'), '');
    expect(resolveWorkerEntry(dir)).toBe(join(dir, 'worker.js'));
  });

  it('安装包走解包后的 worker.js,即使旁边有 bundle', () => {
    const { asarDist, unpackedDist } = layout();
    writeFileSync(join(unpackedDist, 'worker.js'), '');
    writeFileSync(join(unpackedDist, 'worker.bundle.js'), '');
    expect(resolveWorkerEntry(asarDist)).toBe(join(unpackedDist, 'worker.js'));
  });

  it('解包目录里没有 worker.js 时退回 asar 内路径', () => {
    const { asarDist } = layout();
    expect(resolveWorkerEntry(asarDist)).toBe(join(asarDist, 'worker.js'));
  });
});
