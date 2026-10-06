/**
 * 资源节点「媒体信息」面板展示逻辑单测 —— MediaInfoPanel 的纯函数
 *
 * 为什么测这些:面板是用户唯一能核对「这条素材到底多大/多长/多少帧」的地方,
 * 显示错了比不显示更糟(拿错误的分辨率去配 h3 参数必炸)。这里覆盖三类回归:
 *  ① 拿不到的字段**不显示**,而不是填 `—`/`NaN`/`0`(噪音 + 看起来像 bug);
 *  ② 视频的「带不带音轨」必须显式给出 —— 带音轨的参考视频会触发 h3 的
 *     「输出 ≥2 秒」硬规则(见 soundtrack-duration 单测),这里要如实报;
 *  ③ 播放器实测值(videoWidth/duration)优先于 ffprobe 探测值。
 *
 * 全部是纯函数,不挂 DOM(vitest environment 是 node)。
 */
import { describe, expect, it } from 'vitest';
import type { MediaInfo } from '@bigbotart/shared';
import {
  formatBytes,
  formatChannels,
  formatClock,
  formatFps,
  formatSampleRate,
  mediaRows,
  simpleRatio,
} from '../inspector/MediaInfoPanel';

const ok = (patch: Partial<MediaInfo>): MediaInfo => ({ ok: true, ...patch });

describe('formatClock — 时长', () => {
  it('1 分钟内给 `秒.十分位`(便于比对生成参数)', () => {
    expect(formatClock(5.2)).toBe('0:05.2');
    expect(formatClock(59.94)).toBe('0:59.9');
  });

  it('1 分钟以上给 `分:秒`', () => {
    expect(formatClock(65)).toBe('1:05.0');
    expect(formatClock(125.5)).toBe('2:05.5');
  });

  it('1 小时以上给 `时:分:秒`(秒取整,小时级不需要十分位)', () => {
    expect(formatClock(3725)).toBe('1:02:05');
  });

  it('0 是合法值(0 秒视频),显示 0:00.0', () => {
    expect(formatClock(0)).toBe('0:00.0');
  });

  it('undefined / NaN / 负数一律 null(调用方据此不渲染该行)', () => {
    expect(formatClock(undefined)).toBeNull();
    expect(formatClock(Number.NaN)).toBeNull();
    expect(formatClock(-1)).toBeNull();
  });
});

describe('formatSampleRate — 采样率', () => {
  it('整数 kHz 不带小数', () => {
    expect(formatSampleRate(48000)).toBe('48 kHz');
    expect(formatSampleRate(32000)).toBe('32 kHz');
  });

  it('非整数 kHz 保留一位(44100 → 44.1)', () => {
    expect(formatSampleRate(44100)).toBe('44.1 kHz');
  });

  it('非法值 null', () => {
    expect(formatSampleRate(0)).toBeNull();
    expect(formatSampleRate(-8000)).toBeNull();
    expect(formatSampleRate(undefined)).toBeNull();
  });
});

describe('formatChannels — 声道', () => {
  it('声道数 + 布局', () => {
    expect(formatChannels(2, 'stereo')).toBe('2 声道 · stereo');
  });

  it('只有布局 / 只有声道数都要能显示', () => {
    expect(formatChannels(undefined, '5.1')).toBe('5.1');
    expect(formatChannels(1, undefined)).toBe('1 声道');
  });

  it('都没有 null', () => {
    expect(formatChannels(undefined, undefined)).toBeNull();
    expect(formatChannels(0, '')).toBeNull();
  });
});

describe('formatFps — 帧率', () => {
  it('整数不带小数', () => {
    expect(formatFps(24)).toBe('24 fps');
    expect(formatFps(25)).toBe('25 fps');
  });

  it('非整数保留两位(29.97 不是 30)', () => {
    expect(formatFps(29.97)).toBe('29.97 fps');
    expect(formatFps(23.98)).toBe('23.98 fps');
  });

  it('非法值 null', () => {
    expect(formatFps(0)).toBeNull();
    expect(formatFps(undefined)).toBeNull();
  });
});

describe('formatBytes — 文件大小', () => {
  it('MB / GB 两档', () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB');
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.50 GB');
  });

  it('0 / undefined null', () => {
    expect(formatBytes(0)).toBeNull();
    expect(formatBytes(undefined)).toBeNull();
  });
});

describe('mediaRows — 图片', () => {
  it('给尺寸(含百万像素)与格式', () => {
    const rows = mediaRows(ok({ width: 1024, height: 768, videoCodec: 'png', sizeBytes: 400 * 1024 }), 'image');
    expect(rows).toContainEqual(['尺寸', '1024 × 768 · 0.8 MP']);
    expect(rows).toContainEqual(['格式', 'PNG']);
    expect(rows).toContainEqual(['文件', '0.4 MB']);
  });

  it('图片不出现时长/帧率行', () => {
    const rows = mediaRows(ok({ width: 800, height: 600 }), 'image');
    const keys = rows.map(([k]) => k);
    expect(keys).not.toContain('时长');
    expect(keys).not.toContain('帧率');
  });

  it('宽高缺失时不渲染尺寸行(不留 `尺寸 —`)', () => {
    expect(mediaRows(ok({ videoCodec: 'png' }), 'image').map(([k]) => k)).not.toContain('尺寸');
  });
});

describe('mediaRows — 视频', () => {
  const video = ok({
    width: 864,
    height: 480,
    durationSec: 5.2,
    fps: 24,
    frameCount: 124,
    videoCodec: 'h264',
    hasAudio: true,
    audioCodec: 'aac',
    sampleRate: 32000,
    channels: 2,
    channelLayout: 'stereo',
    bitrateKbps: 1500,
    sizeBytes: 12 * 1024 * 1024,
  });

  it('分辨率带常见宽高比(864×480 正好是 9:5)', () => {
    expect(mediaRows(video, 'video')).toContainEqual(['分辨率', '864 × 480 · 9:5']);
  });

  /**
   * ⚠️ 真实数据回归(2026-09,用户素材实测 854×480):
   * 旧实现按欧几里得约分 + 字符长度阈值,印出「854 × 480 · 427:240」——
   * 数学正确、对用户毫无意义(且才 7 个字符,长度阈值根本拦不住)。
   * 现在只认常见画幅,认不出就不写比例。
   */
  it('不再印出 427:240 这类无意义约分:854×480 归到 16:9', () => {
    expect(mediaRows(ok({ width: 854, height: 480 }), 'video').find(([k]) => k === '分辨率')?.[1]).toBe('854 × 480 · 16:9');
  });

  it('常见画幅识别:精确与常见近似都要认出来', () => {
    expect(simpleRatio(1920, 1080)).toBe('16:9');
    expect(simpleRatio(1280, 720)).toBe('16:9');
    // 854×480(差 0.078%)是 16:9 最常见的近似分辨率之一,必须认出来
    expect(simpleRatio(854, 480)).toBe('16:9');
  });

  it('竖屏 / 方形 / 宽银幕', () => {
    expect(simpleRatio(1080, 1920)).toBe('9:16');
    expect(simpleRatio(1024, 1024)).toBe('1:1');
    expect(simpleRatio(1024, 768)).toBe('4:3');
    expect(simpleRatio(2520, 1080)).toBe('21:9');
  });

  /**
   * ⚠️ 刻意保守的一面:「显示一个**错误**的比例」比「不显示比例」更糟 ——
   * 用户会照着它去配 h3 的宽高参数。所以容差只给 0.5%:
   *  1150×1144 距 1:1 只有 0.52%、1410×1066 距 4:3 有 0.80%
   * 这两类真·怪尺寸宁可不说,也不强行归类。
   * (代价:2560×1080 距 2.39:1 有 0.82%,同样拿不到标签 —— 这是安全方向的漏判。)
   */
  it('真·怪比例老实返回 null,不强行归到最近的画幅', () => {
    expect(simpleRatio(1150, 1144)).toBeNull();
    expect(simpleRatio(1024, 1000)).toBeNull();
    expect(simpleRatio(1410, 1066)).toBeNull();
    expect(simpleRatio(2560, 1080)).toBeNull();
  });

  it('怪比例在面板上只给宽高,不给比例', () => {
    expect(mediaRows(ok({ width: 1150, height: 1144 }), 'video').find(([k]) => k === '分辨率')?.[1]).toBe('1150 × 1144');
    expect(mediaRows(ok({ width: 1410, height: 1066 }), 'video').find(([k]) => k === '分辨率')?.[1]).toBe('1410 × 1066');
  });

  it('时长带总帧数 / 帧率 / 编码', () => {
    const rows = mediaRows(video, 'video');
    expect(rows).toContainEqual(['时长', '0:05.2 · 124 帧']);
    expect(rows).toContainEqual(['帧率', '24 fps']);
    expect(rows).toContainEqual(['视频编码', 'H264']);
  });

  it('有音轨:编码 + 采样率 + 声道一起给(下游据采样率判断音质规格)', () => {
    expect(mediaRows(video, 'video')).toContainEqual(['音轨', 'AAC · 32 kHz · 2 声道 · stereo']);
  });

  it('无音轨:显式写「无(静音)」—— 这是有实际后果的信息,不能省略', () => {
    const rows = mediaRows(ok({ width: 100, height: 100, hasAudio: false }), 'video');
    expect(rows).toContainEqual(['音轨', '无(静音)']);
  });

  it('hasAudio 未知(undefined)时不写音轨行,不猜', () => {
    const rows = mediaRows(ok({ width: 100, height: 100 }), 'video');
    expect(rows.map(([k]) => k)).not.toContain('音轨');
  });

  it('帧数缺失时不显示「· undefined 帧」', () => {
    const rows = mediaRows(ok({ width: 100, height: 100, durationSec: 3 }), 'video');
    expect(rows).toContainEqual(['时长', '0:03.0']);
  });

  it('竖拍(宽高已互换)时旋转角单独成行,避免用户以为画面被裁了', () => {
    const rows = mediaRows(ok({ width: 1080, height: 1920, rotation: 90 }), 'video');
    expect(rows.find(([k]) => k === '旋转')?.[1]).toContain('90°');
  });

});

describe('mediaRows — 音频', () => {
  const audio = ok({
    durationSec: 12.3,
    sampleRate: 44100,
    channels: 1,
    channelLayout: 'mono',
    audioCodec: 'pcm_s16le',
    sizeBytes: 1024 * 1024,
  });

  it('时长/采样率/声道/编码', () => {
    const rows = mediaRows(audio, 'audio');
    expect(rows).toContainEqual(['时长', '0:12.3']);
    expect(rows).toContainEqual(['采样率', '44.1 kHz']);
    expect(rows).toContainEqual(['声道', '1 声道 · mono']);
    expect(rows).toContainEqual(['音频编码', 'PCM_S16LE']);
  });

  it('音频不出现分辨率/帧率行', () => {
    const keys = mediaRows(audio, 'audio').map(([k]) => k);
    expect(keys).not.toContain('分辨率');
    expect(keys).not.toContain('帧率');
  });
});

describe('mediaRows — 播放器实测值优先', () => {
  it('live 里的宽高/时长覆盖 ffprobe 探测值(浏览器解码的才是真的)', () => {
    const info = ok({ width: 320, height: 240, durationSec: 2, fps: 25 });
    const rows = mediaRows(info, 'video', { width: 640, height: 480, durationSec: 2.5 });
    expect(rows.find(([k]) => k === '分辨率')?.[1]).toContain('640 × 480');
    expect(rows.find(([k]) => k === '时长')?.[1]).toBe('0:02.5');
    // 播放器给不了的字段仍用探测值
    expect(rows).toContainEqual(['帧率', '25 fps']);
  });

  it('live 只给部分字段时其余回落探测值', () => {
    const info = ok({ width: 320, height: 240, durationSec: 2 });
    const rows = mediaRows(info, 'video', { durationSec: 9 });
    expect(rows.find(([k]) => k === '分辨率')?.[1]).toContain('320 × 240');
    expect(rows.find(([k]) => k === '时长')?.[1]).toBe('0:09.0');
  });
});

describe('mediaRows — 失败 / 空', () => {
  it('探测失败时不给任何行(错误文案由面板单独渲染)', () => {
    expect(mediaRows({ ok: false, error: '未找到 ffprobe' }, 'video')).toEqual([]);
  });

  it('info 为 null(未探测/无资产)时给空数组', () => {
    expect(mediaRows(null, 'image')).toEqual([]);
  });

  it('探测成功但一无所有时不编造行', () => {
    expect(mediaRows(ok({}), 'video')).toEqual([]);
  });
});
