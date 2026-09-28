/**
 * 带音轨参考视频的时长下限 — 渲染层与 providers 常量一致性
 *
 * 背景(真实事故 2026-09):h3.c:1146 规定带内嵌音轨的 `--ref-video` 要求输出 ≥2 秒,
 * 而 preview 档只有 22 帧(≈0.92s)→ 提交必失败,且错误发生在入队后、文案是英文
 * (`video soundtrack 2 requires at least 2 seconds; request at least 56 output frames`)。
 *
 * 防呆分两层:
 *   - providers `validateParams`(提交前硬拦,权威判据);
 *   - renderer `constants.ts` 的同名常量(编辑时实时预警,给用户即时反馈)。
 * renderer 不 import providers(包边界),常量是复制品 —— 本测试防的就是两边漂移。
 */
import { describe, it, expect } from 'vitest';
import {
  MIN_SOUNDTRACK_SECONDS,
  MIN_SOUNDTRACK_FRAMES,
  H3_FPS,
  h3OutputSeconds,
} from '../constants';

describe('时长下限常量(与 h3k-command 同口径)', () => {
  it('2 秒 / 56 帧(h3 的报错文案给的就是 56)', () => {
    expect(MIN_SOUNDTRACK_SECONDS).toBe(2);
    expect(MIN_SOUNDTRACK_FRAMES).toBe(56);
  });

  it('56 帧换算成秒确实 ≥2(preview 的 22 帧则不足)', () => {
    expect(MIN_SOUNDTRACK_FRAMES / H3_FPS).toBeGreaterThanOrEqual(MIN_SOUNDTRACK_SECONDS);
    expect(22 / H3_FPS).toBeLessThan(MIN_SOUNDTRACK_SECONDS);
  });

  it('48 帧恰好 2.0 秒(边界:达标)', () => {
    expect(48 / H3_FPS).toBe(MIN_SOUNDTRACK_SECONDS);
  });
});

describe('h3OutputSeconds', () => {
  it('seconds 优先于 frames', () => {
    expect(h3OutputSeconds({ frames: 22, seconds: 5 })).toBe(5);
  });

  it('无 seconds 时用 frames / 24', () => {
    expect(h3OutputSeconds({ frames: 124 })).toBeCloseTo(124 / 24, 5);
  });

  it('seconds=0 视为未设置(与渲染层「直接改帧数→清空时长」的约定一致)', () => {
    expect(h3OutputSeconds({ frames: 48, seconds: 0 })).toBe(2);
  });

  it('缺字段 → 0(不崩,且会被判为不足 2 秒)', () => {
    expect(h3OutputSeconds({})).toBe(0);
    expect(h3OutputSeconds({})).toBeLessThan(MIN_SOUNDTRACK_SECONDS);
  });

  it('实战:preview 档(22 帧)触发预警,default 档(124 帧)不触发', () => {
    const preview = h3OutputSeconds({ frames: 22 });
    const def = h3OutputSeconds({ frames: 124 });
    expect(preview < MIN_SOUNDTRACK_SECONDS).toBe(true);
    expect(def < MIN_SOUNDTRACK_SECONDS).toBe(false);
  });
});
