/**
 * 分镜表铺镜头的引擎护栏（2026-10-28「视频不生成」事故）
 *
 * 事故：renderMode=real、h3 就绪，但 storyboard 铺出来的 shot data.engine 被写死为 mock，
 * 提交日志是 `slot=video provider=mock`，只产出 1 秒占位 MP4。普通「+」新建 shot 默认 h3c，
 * 只有这条路径漏改。源码护栏锁死：铺节点块必须写 h3c，不得再出现 mock。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '../../CanvasPage.tsx'), 'utf-8');

function materializedShotDataBlock(): string {
  const start = src.indexOf("const shotId = makeNodeId('shot');");
  expect(start, 'CanvasPage 里找不到分镜表铺 shot 的起点').toBeGreaterThan(-1);
  const end = src.indexOf("newEdges.push({ from: sbNode.id", start);
  expect(end, 'CanvasPage 里找不到分镜表铺 shot 的终点').toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('分镜表铺出的镜头必须走真实 h3', () => {
  it("data.engine 固定为 'h3c'，不得回退到骨架期 mock", () => {
    const block = materializedShotDataBlock();
    expect(block).toContain("engine: 'h3c'");
    expect(block).not.toContain("engine: 'mock'");
  });
});
