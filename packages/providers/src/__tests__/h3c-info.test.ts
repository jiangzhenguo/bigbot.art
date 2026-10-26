/**
 * h3 引擎探测信息解析 + 子进程环境透传 + 档位表单一真源 —— 2026-10-25
 *
 * 背景:h3 当天把**视频 VAE 的 ViT 解码器从 FP32 换成 BF16**(MPS 张量核,
 * 3.37x 提速、峰值显存减半)。引擎行为变化带来三件事,都在这里锁住:
 *
 * ① **版本号从 `--info` 真读**:此前 `st.version` 写死 'h3-metal 0.1.x',
 *    引擎实现变了界面还报旧版本 → 「我跑的到底是哪个引擎」答不出来。
 * ② **`H3_VAE_PRECISION` 逃生口**:引擎侧留了 `H3_VAE_PRECISION=f32` 回退旧 FP32 路径,
 *    本程序用 `BIGBOTART_H3_VAE_PRECISION` 透传(不重编引擎就能回退)。
 * ③ **档位 ETA 只有一处**:providers 的 `TIER_PRESETS` 与渲染层的
 *    `SHOT_TIER_PRESETS` 此前各写一份且数值分叉过 → 现在都取 shared 的
 *    `VIDEO_TIER_PRESETS`,这里断言两者仍然同值(防将来又分叉)。
 */
import { describe, it, expect } from 'vitest';
import { parseH3Version, h3ChildEnv } from '../h3c.js';
import { TIER_PRESETS } from '../h3c-command.js';
import { VIDEO_TIER_PRESETS, VIDEO_TIERS } from '@bigbotart/shared';

/** 本机 `h3 -d ~/ai/h3/MiniMax-H3 --info` 的真实输出(2026-10-25) */
const INFO_SAMPLE = `h3-metal 0.1.0-dev
Device: Apple M5 Pro (applegpu_g17s)
  physical memory       64.0 GiB
  recommended GPU set   51.8 GiB
  max Metal buffer      38.9 GiB
  Apple GPU family      10
  Metal 4               yes
  unified memory        yes
Native checkpoint inventory (header-only):
  Qwen3-VL encoder   14 files  1058 tensors   62.133 GiB
  FL2VA DiT          13 files   535 tensors   61.728 GiB
  Ref2VA DiT         13 files   535 tensors   61.728 GiB
  video VAE           1 files   560 tensors    9.700 GiB
  audio VAE           1 files  1087 tensors    0.564 GiB
`;

describe('h3 --info 版本解析', () => {
  it('从首行读出真实版本(h3-metal 0.1.0-dev)', () => {
    expect(parseH3Version(INFO_SAMPLE)).toBe('h3-metal 0.1.0-dev');
  });

  it('读不到时返回 undefined(不猜版本)', () => {
    expect(parseH3Version('')).toBeUndefined();
    expect(parseH3Version('Device: Apple M5 Pro\n')).toBeUndefined();
  });

  it('不会把别的行误认成版本行', () => {
    const noise = `Metal 4               yes\n  physical memory       64.0 GiB\n`;
    expect(parseH3Version(noise)).toBeUndefined();
  });
});

describe('h3 子进程环境(BIGBOTART_H3_VAE_PRECISION 透传)', () => {
  it('未设置时原样继承父进程环境', () => {
    const env = h3ChildEnv({ PATH: '/usr/bin' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.H3_VAE_PRECISION).toBeUndefined();
  });

  it('BIGBOTART_H3_VAE_PRECISION=f32 → 透传 H3_VAE_PRECISION=f32(引擎回退旧 FP32 路径)', () => {
    const env = h3ChildEnv({ BIGBOTART_H3_VAE_PRECISION: 'f32', PATH: '/usr/bin' });
    expect(env.H3_VAE_PRECISION).toBe('f32');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('空值/空白值视为未设置(不污染引擎环境)', () => {
    expect(h3ChildEnv({ BIGBOTART_H3_VAE_PRECISION: '' }).H3_VAE_PRECISION).toBeUndefined();
    expect(h3ChildEnv({ BIGBOTART_H3_VAE_PRECISION: '   ' }).H3_VAE_PRECISION).toBeUndefined();
  });

  it('仅白名单 f32 透传;bf16/大写/任意非法值均不改变引擎环境', () => {
    for (const value of ['bf16', 'F32', 'fp32', 'garbage']) {
      expect(h3ChildEnv({ BIGBOTART_H3_VAE_PRECISION: value }).H3_VAE_PRECISION).toBeUndefined();
    }
  });
});

describe('档位表单一真源(providers ↔ shared)', () => {
  it('etaMin 与 shared 的 VIDEO_TIER_PRESETS 完全一致', () => {
    for (const tier of VIDEO_TIERS) {
      expect(TIER_PRESETS[tier].etaMin).toBe(VIDEO_TIER_PRESETS[tier].etaMin);
      expect(TIER_PRESETS[tier].steps).toBe(VIDEO_TIER_PRESETS[tier].steps);
      expect(TIER_PRESETS[tier].layers).toBe(VIDEO_TIER_PRESETS[tier].layers);
      expect(TIER_PRESETS[tier].reuse).toBe(VIDEO_TIER_PRESETS[tier].reuse);
      expect(TIER_PRESETS[tier].frames).toBe(VIDEO_TIER_PRESETS[tier].frames);
    }
  });

  it('2026-10-25 BF16 视频 VAE 之后的标定值(预览/草稿/默认/参考 = 4/9/14/28 分钟)', () => {
    expect([
      TIER_PRESETS.preview.etaMin,
      TIER_PRESETS.draft.etaMin,
      TIER_PRESETS.default.etaMin,
      TIER_PRESETS.reference.etaMin,
    ]).toEqual([4, 9, 14, 28]);
  });

  it('1:1 锚点尺寸取自 SHOT_SIZES(不另抄一份)', () => {
    expect(TIER_PRESETS.preview.width).toBe(448);
    expect(TIER_PRESETS.preview.height).toBe(448);
    expect(TIER_PRESETS.default.width).toBe(544);
    expect(TIER_PRESETS.default.height).toBe(544);
    expect(TIER_PRESETS.reference.width).toBe(768);
    expect(TIER_PRESETS.reference.height).toBe(768);
  });
});
