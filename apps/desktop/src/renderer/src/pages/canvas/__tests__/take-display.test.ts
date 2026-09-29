/**
 * Take 展示工具单测(检查器 Take 历史:生成时长 + 生成时提示词)
 *
 * 覆盖两个纯函数:
 * - formatDurationSec:秒 → 人类可读时长(空/非法一律 null,不渲染「NaN秒」)
 * - takePromptOf / takeElapsedSec:从 Take 存档里取生成时提示词与生成耗时
 */
import { describe, expect, it } from 'vitest';
import { formatDurationSec } from '../media';
import { takePromptOf, takeElapsedSec } from '../inspector/ImageTakeSection';

describe('formatDurationSec', () => {
  it('低于 1 分钟只给秒', () => {
    expect(formatDurationSec(0)).toBe('0秒');
    expect(formatDurationSec(8.4)).toBe('8秒');
    expect(formatDurationSec(59)).toBe('59秒');
  });

  it('1 分钟以上给「N分M秒」,整分钟省略秒', () => {
    expect(formatDurationSec(60)).toBe('1分');
    expect(formatDurationSec(61)).toBe('1分1秒');
    expect(formatDurationSec(125)).toBe('2分5秒');
    expect(formatDurationSec(600)).toBe('10分');
  });

  it('缺失/非法值返回 null(调用方据此显示「时长未知」而不是 NaN)', () => {
    expect(formatDurationSec(undefined)).toBeNull();
    expect(formatDurationSec(null)).toBeNull();
    expect(formatDurationSec(NaN)).toBeNull();
    expect(formatDurationSec(Infinity)).toBeNull();
    expect(formatDurationSec(-1)).toBeNull();
  });
});

describe('takePromptOf / takeElapsedSec', () => {
  it('取 Take.params.prompt(生成时提交的原文)', () => {
    expect(takePromptOf({ params: { prompt: '晨雾针叶林' } })).toBe('晨雾针叶林');
  });

  it('params 缺失 / prompt 非字符串时不炸,给空串', () => {
    expect(takePromptOf({})).toBe('');
    expect(takePromptOf({ params: undefined })).toBe('');
    expect(takePromptOf({ params: { prompt: 42 } })).toBe('42');
    expect(takePromptOf({ params: null })).toBe('');
  });

  it('生成耗时优先 elapsedSec(墙钟),历史数据缺字段时回退 durationSec', () => {
    expect(takeElapsedSec({ elapsedSec: 125, durationSec: 5 })).toBe(125);
    expect(takeElapsedSec({ durationSec: 5 })).toBe(5);
    expect(takeElapsedSec({})).toBeUndefined();
  });
});
