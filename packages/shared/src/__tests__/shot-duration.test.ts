/**
 * 镜头时长归一化 + 提交前尺寸/时长校验
 * (2026-10-13 Agent 建「15s」镜头却提交 22 帧事故)
 */
import { describe, expect, it } from 'vitest';
import {
  H3_FPS,
  H3_MAX_FRAMES,
  H3_MAX_PIXELS,
  SHOT_DEFAULT_SECONDS,
  SHOT_MAX_SECONDS,
  h3FramesForSeconds,
  normalizeShotDuration,
  parseDurationHint,
  parseTotalDurationHint,
  resolveMaterializeSeconds,
  snapShotDimensions,
  validateShotSubmitParams,
} from '../shot-duration.js';

describe('parseDurationHint', () => {
  it('识别 15s / 15秒 / 约15 秒', () => {
    expect(parseDurationHint('镜头 01 · 15s Hook 主镜头')).toBe(15);
    expect(parseDurationHint('开场视频·双人合作主菜单 15秒')).toBe(15);
    expect(parseDurationHint('约15 秒片头')).toBe(15);
    expect(parseDurationHint('duration 8sec clip')).toBe(8);
  });

  it('没有时长提示 → undefined', () => {
    expect(parseDurationHint('镜头 01')).toBeUndefined();
    expect(parseDurationHint('')).toBeUndefined();
  });
});

describe('parseTotalDurationHint / resolveMaterializeSeconds', () => {
  it('认 seconds=15 / 单镜15秒 / 开头「15秒,16:9」', () => {
    expect(parseTotalDurationHint('只铺1个shot(seconds=15),按区间组织')).toBe(15);
    expect(parseTotalDurationHint('单镜15秒16:9手绘实拍融合')).toBe(15);
    expect(parseTotalDurationHint('15秒,16:9横版视频。将实拍的旧阳台')).toBe(15);
  });

  it('不把「0-3秒」区间误当成总时长', () => {
    expect(parseTotalDurationHint('0-3秒:一只手去取衣夹')).toBeUndefined();
    expect(parseTotalDurationHint('3-6秒:它从指缝溜走')).toBeUndefined();
  });

  it('技能4:时长列 4 + 画面写单镜15秒 → 铺节点用 15', () => {
    expect(
      resolveMaterializeSeconds(
        4,
        '单镜15秒16:9手绘实拍融合短片「旧阳台晾衣角」,只铺1个shot(seconds=15),0-3秒:…',
      ),
    ).toBe(15);
  });
});

describe('normalizeShotDuration', () => {
  it('技能4事故:prompt 写单镜15秒、data.seconds=4 → 覆盖为 15', () => {
    const r = normalizeShotDuration(
      {
        seconds: 4,
        prompt:
          'Scene: 单镜15秒16:9手绘实拍融合短片,只铺1个shot(seconds=15)。0-3秒:一只手…',
      },
      { label: '镜头 01' },
    );
    expect(r.changed).toBe(true);
    expect(r.data.seconds).toBe(15);
    expect(r.data.frames).toBe(h3FramesForSeconds(15));
    expect(r.note).toMatch(/总时长|覆盖/);
  });

  it('事故形态:标题写 15s、data 无 seconds、frames=22(preview) → 按标题写入 15s', () => {
    const r = normalizeShotDuration(
      { frames: 22, seconds: 0, tier: 'preview' },
      { label: '镜头 01 · 15s Hook 主镜头' },
    );
    expect(r.changed).toBe(true);
    expect(r.data.seconds).toBe(15);
    expect(r.data.frames).toBe(h3FramesForSeconds(15));
    expect(r.data.frames).toBeLessThanOrEqual(H3_MAX_FRAMES);
    expect(r.note).toMatch(/标题识别/);
  });

  it('显式 seconds 优先于标题与 frames', () => {
    const r = normalizeShotDuration(
      { seconds: 5, frames: 22 },
      { label: '镜头 · 15s' },
    );
    expect(r.data.seconds).toBe(5);
    expect(r.data.frames).toBe(h3FramesForSeconds(5));
  });

  it('只有 frames、无标题提示 → 尊重帧数不改', () => {
    const r = normalizeShotDuration({ frames: 22, seconds: 0 }, { label: '镜头 01' });
    expect(r.changed).toBe(false);
    expect(r.data.frames).toBe(22);
  });

  it('完全空白 → 默认 5s', () => {
    const r = normalizeShotDuration({}, { label: '新镜头' });
    expect(r.data.seconds).toBe(SHOT_DEFAULT_SECONDS);
    expect(r.data.frames).toBe(h3FramesForSeconds(SHOT_DEFAULT_SECONDS));
    // 5s @24fps 对齐后应是 124
    expect(r.data.frames).toBe(124);
    expect(H3_FPS).toBe(24);
  });

  it('超过上限截断(>15 → 15)', () => {
    const r = normalizeShotDuration({ seconds: 20 });
    expect(r.data.seconds).toBe(SHOT_MAX_SECONDS);
    expect(SHOT_MAX_SECONDS).toBe(15);
    expect(r.note).toMatch(/上限/);
  });

  it('正好 15s 保留不截断', () => {
    const r = normalizeShotDuration({ seconds: 15 });
    expect(r.data.seconds).toBe(15);
    expect(r.note).toBeUndefined();
  });
});

describe('validateShotSubmitParams', () => {
  const okBase = { width: 864, height: 480, seconds: 5, frames: 124 };

  it('合法档位通过', () => {
    expect(validateShotSubmitParams(okBase)).toEqual([]);
    expect(validateShotSubmitParams({ width: 576, height: 1024, seconds: 15 })).toEqual([]);
  });

  it('非 32 倍数拒绝', () => {
    const errs = validateShotSubmitParams({ ...okBase, width: 865, height: 480 });
    expect(errs.join(' ')).toMatch(/32/);
  });

  it('面积超限拒绝', () => {
    const errs = validateShotSubmitParams({ width: 2000, height: 2000, seconds: 5 });
    expect(errs.join(' ')).toMatch(/超限|乘积/);
    expect(2000 * 2000).toBeGreaterThan(H3_MAX_PIXELS);
  });

  it('时长超上限拒绝', () => {
    const errs = validateShotSubmitParams({ ...okBase, seconds: 16 });
    expect(errs.join(' ')).toMatch(/上限|15/);
  });

  it('缺时长拒绝', () => {
    const errs = validateShotSubmitParams({ width: 864, height: 480 });
    expect(errs.join(' ')).toMatch(/未指定时长/);
  });

  it('15s 对齐后仍在 h3 帧数上限内', () => {
    expect(h3FramesForSeconds(15)).toBeLessThanOrEqual(H3_MAX_FRAMES);
    expect(validateShotSubmitParams({ width: 864, height: 480, seconds: 15 })).toEqual([]);
  });
});

describe('snapShotDimensions', () => {
  it('合法尺寸原样返回(无 note、对象不变)', () => {
    const d = { width: 864, height: 480, seconds: 5 };
    const r = snapShotDimensions(d);
    expect(r.note).toBeUndefined();
    expect(r.data).toBe(d);
  });

  it('缺尺寸/非法值不干预(留给缺省档位逻辑)', () => {
    expect(snapShotDimensions({}).data).toEqual({});
    expect(snapShotDimensions({ width: 'abc', height: 480 }).note).toBeUndefined();
    expect(snapShotDimensions({ width: 0, height: -5 }).note).toBeUndefined();
  });

  it('非 32 倍数就近取整(1280×720 → 高 704 或 736)', () => {
    const r = snapShotDimensions({ width: 1280, height: 720 });
    expect(Number(r.data.width) % 32).toBe(0);
    expect(Number(r.data.height) % 32).toBe(0);
    expect(r.note).toMatch(/1280×720/);
    expect(r.note).toMatch(/已规整为/);
    // 规整后必须过提交校验
    expect(validateShotSubmitParams({ ...r.data, seconds: 5 })).toEqual([]);
  });

  it('面积超限按比例缩到上限内(2752×1536 参考图尺寸事故)', () => {
    const r = snapShotDimensions({ width: 2752, height: 1536 });
    const w = Number(r.data.width);
    const h = Number(r.data.height);
    expect(w * h).toBeLessThanOrEqual(H3_MAX_PIXELS);
    expect(w % 32).toBe(0);
    expect(h % 32).toBe(0);
    // 比例基本保持(16:9 类)
    expect(w / h).toBeGreaterThan(1.5);
    expect(r.note).toMatch(/2752×1536/);
    expect(validateShotSubmitParams({ ...r.data, seconds: 5 })).toEqual([]);
  });
});
