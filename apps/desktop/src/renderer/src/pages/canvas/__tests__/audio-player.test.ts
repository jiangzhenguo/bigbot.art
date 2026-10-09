/**
 * 音频播放辅助纯函数单测(audio-ref 节点播放功能,2026-10-08)
 *
 * 背景:audio-ref 节点卡上的波形此前是**纯装饰**(WAVE_BARS 是写死的假数据,
 * 点它没有任何反应)—— 节点的唯一产物就是声音,却不能试听。现在换成真实播放器。
 *
 * 这里只测可确定性验证的纯函数;React 组件的播放行为靠人工/集成验证
 * (jsdom 里 HTMLMediaElement 不会真的解码播放,断言 play() 调用没有实际意义)。
 * 但**边界值的渲染结果是真 bug 高发区**,必须锁死:
 * 音频未 loadedmetadata 时 duration 是 NaN,直接渲染就是「NaN:NaN」。
 */
import { describe, it, expect } from 'vitest';
import { formatClock, playProgress, isAudioPath } from '../media.js';

describe('formatClock · 播放器时间轴', () => {
  it('常规值 → m:ss', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(59)).toBe('0:59');
    expect(formatClock(60)).toBe('1:00');
    expect(formatClock(75)).toBe('1:15');
    expect(formatClock(605)).toBe('10:05');
  });

  it('秒数补零(否则会渲染成 1:5)', () => {
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(9)).toBe('0:09');
  });

  it('NaN → 0:00(未加载元数据时 duration 就是 NaN,直接渲染会变成「NaN:NaN」)', () => {
    expect(formatClock(NaN)).toBe('0:00');
    expect(formatClock(Infinity)).toBe('0:00');
    expect(formatClock(-1)).toBe('0:00');
    expect(formatClock(undefined)).toBe('0:00');
    expect(formatClock(null)).toBe('0:00');
  });

  it('小数向下取整(播放中 currentTime 是浮点)', () => {
    expect(formatClock(2.9)).toBe('0:02');
    expect(formatClock(59.99)).toBe('0:59');
  });
});

describe('playProgress · 波形高亮比例', () => {
  it('常规进度', () => {
    expect(playProgress(0, 10)).toBe(0);
    expect(playProgress(5, 10)).toBe(0.5);
    expect(playProgress(10, 10)).toBe(1);
  });

  it('时长未知(NaN/0)→ 0,而不是 NaN(会让波形高亮条数算成 NaN 根)', () => {
    expect(playProgress(3, NaN)).toBe(0);
    expect(playProgress(3, 0)).toBe(0);
    expect(playProgress(NaN, 10)).toBe(0);
  });

  it('越界被钳制在 0~1(seek 与 ended 之间可能出现 current 略大于 duration)', () => {
    expect(playProgress(12, 10)).toBe(1);
    expect(playProgress(-1, 10)).toBe(0);
  });
});

describe('isAudioPath · 音频扩展名判定', () => {
  it('常见音频格式命中', () => {
    for (const f of ['a.mp3', 'a.wav', 'a.m4a', 'a.aac', 'a.flac', 'a.ogg']) {
      expect(isAudioPath(`/x/outputs/audio/${f}`), f).toBe(true);
    }
  });

  it('视频/图片不误判', () => {
    expect(isAudioPath('/x/o/a.mp4')).toBe(false);
    expect(isAudioPath('/x/o/a.png')).toBe(false);
  });

  it('取 basename 再判:目录名里带音频后缀不误命中', () => {
    // 与 isVideoPath 同一手法:整串测会被目录名传染
    expect(isAudioPath('/x/audio.wav/thing.mp4')).toBe(false);
  });

  it('空值安全', () => {
    expect(isAudioPath(null)).toBe(false);
    expect(isAudioPath('')).toBe(false);
    expect(isAudioPath(undefined)).toBe(false);
  });
});
