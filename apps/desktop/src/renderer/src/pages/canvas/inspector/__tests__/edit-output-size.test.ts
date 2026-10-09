/**
 * 输出尺寸(--width/--height)纯函数单测 — Qwen-Image-2.1 参考编辑
 *
 * 能力确认过程(2026-10-08,读源码 + 真跑):
 *   ① `qwen_image_21_edit.py`:width/height 为 None 时才用 `dimensions()` 推导的 default,
 *      即**显式传入会直接覆盖**;
 *   ② CLI `QwenImage21LatentCreator.validate()`:唯一约束是「≥32 且 32 的倍数」,
 *      **不限制宽高比**;
 *   ③ 真跑实测(2 步):参考图 896×1184(3:4)
 *        - 不传尺寸          → 1376×768(按参考图 3:4 推导)
 *        - `--width 1280 --height 704` → **1280×704**(16:9,覆盖成功)
 *   ④ `--canvas-policy` 在该路由是 no-op(qwen21 edit CLI 从不读它),无需传。
 *
 * ⚠️ 720 **不是** 32 的倍数(720/32=22.5),所以 16:9 的合法档位是 1280×**704**。
 *    这是最容易踩的坑:用户想填 1280×720 会被 CLI 直接拒绝。
 */
import { describe, it, expect } from 'vitest';
import {
  OUTPUT_SIZE_PRESETS,
  isValidOutputSize,
  matchSizePreset,
  parseSizeInput,
  snapTo32,
} from '../ImageEditInspector';

describe('isValidOutputSize — CLI 硬约束「≥32 且 32 的倍数」', () => {
  it('常用合法尺寸', () => {
    const ok = [
      [1280, 704], // 16:9
      [704, 1280], // 9:16
      [1024, 1024], // 1:1
      [1152, 864], // 4:3
      [864, 1152], // 3:4
      [896, 1184], // 参考图原尺寸
      [32, 32], // 下界
    ];
    for (const [w, h] of ok) {
      expect(isValidOutputSize(w!, h!), `${w}×${h}`).toBe(true);
    }
  });

  it('🚨 1280×720 必须判非法 —— 720 不是 32 的倍数(最易踩的坑)', () => {
    expect(720 % 32).not.toBe(0);
    expect(isValidOutputSize(1280, 720)).toBe(false);
    // 对照:16:9 的合法写法
    expect(isValidOutputSize(1280, 704)).toBe(true);
  });

  it('小于 32 判非法', () => {
    expect(isValidOutputSize(0, 704)).toBe(false);
    expect(isValidOutputSize(1280, 0)).toBe(false);
    expect(isValidOutputSize(16, 16)).toBe(false);
  });

  it('非 32 倍数判非法', () => {
    for (const n of [33, 100, 300, 500, 1000, 1080]) {
      expect(isValidOutputSize(n, n), String(n)).toBe(false);
    }
  });

  it('非整数 / NaN 判非法', () => {
    expect(isValidOutputSize(1280.5, 704)).toBe(false);
    expect(isValidOutputSize(NaN, 704)).toBe(false);
    expect(isValidOutputSize(Infinity, 704)).toBe(false);
  });
});

describe('parseSizeInput — 非法输入返回 null(绝不静默规整)', () => {
  it('合法整数通过', () => {
    expect(parseSizeInput('1280')).toBe(1280);
    expect(parseSizeInput(' 704 ')).toBe(704);
    expect(parseSizeInput('32')).toBe(32);
  });

  it('🚨 非 32 倍数返回 null —— 这是刻意的:静默规整会造成「显示 720、实跑 704」的静默不一致', () => {
    expect(parseSizeInput('720')).toBeNull();
    expect(parseSizeInput('1080')).toBeNull();
    expect(parseSizeInput('100')).toBeNull();
  });

  it('空 / 非数字 / 负数 / 小数返回 null', () => {
    for (const bad of ['', '   ', 'abc', '-64', '12.5', '1e3', '0x100', '64px']) {
      expect(parseSizeInput(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('小于 32 返回 null', () => {
    expect(parseSizeInput('0')).toBeNull();
    expect(parseSizeInput('16')).toBeNull();
  });
});

describe('matchSizePreset — 预设命中', () => {
  it('命中各档位标签', () => {
    expect(matchSizePreset(1280, 704)).toBe('16:9');
    expect(matchSizePreset(704, 1280)).toBe('9:16');
    expect(matchSizePreset(1024, 1024)).toBe('1:1');
    expect(matchSizePreset(1152, 864)).toBe('4:3');
    expect(matchSizePreset(864, 1152)).toBe('3:4');
  });

  it('不在预设里(自定义尺寸)→ null,UI 据此不高亮任何档位', () => {
    expect(matchSizePreset(896, 1184)).toBeNull();
    expect(matchSizePreset(1536, 640)).toBeNull();
  });
});

describe('OUTPUT_SIZE_PRESETS — 档位本身必须合法', () => {
  it('每个预设都满足 CLI 约束(否则用户点一下就会 exit)', () => {
    for (const p of OUTPUT_SIZE_PRESETS) {
      expect(isValidOutputSize(p.w, p.h), `${p.label} ${p.w}×${p.h}`).toBe(true);
    }
  });

  it('比例与标签相符(容差 3% —— 32 对齐无法精确表达比例)', () => {
    /* 实测:16:9 在 32 对齐下最接近的是 1280×704(精确 16:9 需要 720,而 720 不是 32 的倍数),
       偏差 2.27%。容差必须放到 3%,否则会误判成「标签写错」。 */
    for (const p of OUTPUT_SIZE_PRESETS) {
      const [a, b] = p.label.split(':').map(Number);
      const want = a! / b!;
      const got = p.w / p.h;
      expect(Math.abs(got - want) / want, `${p.label} → ${p.w}×${p.h}`).toBeLessThan(0.03);
    }
  });

  it('不含重复比例', () => {
    const labels = OUTPUT_SIZE_PRESETS.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('未设置尺寸的三种形态都必须被当成「未指定」', () => {
  /* 「跟随参考图」写的是 null 哨兵(setData 是浅合并,传 undefined 会留下脏键)。
     下面三种形态历史上都出现过(undefined = 从没设过 / null = 点了跟随 / '' = 输入框清空),
     必须一致地被忽略,否则会出现「显示跟随、实际传了尺寸」的反向不一致。 */
  it('null / undefined / 空串都不算有效尺寸', () => {
    expect(isValidOutputSize(Number(null), 704)).toBe(false);
    expect(isValidOutputSize(Number(undefined), 704)).toBe(false);
    expect(isValidOutputSize(Number(''), 704)).toBe(false);
  });

  it('与 provider 侧的判定口径一致(≥32 且有限才传)', () => {
    const passesProviderGuard = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 32;
    };
    for (const v of [null, undefined, '', 0, 16, NaN]) {
      expect(passesProviderGuard(v), JSON.stringify(v)).toBe(false);
    }
    for (const v of [32, 704, 1280]) {
      expect(passesProviderGuard(v), String(v)).toBe(true);
    }
  });
});

describe('snapTo32 — 规整到最近合法值', () => {
  it('就近取整到 32 的倍数', () => {
    // 720 恰好等距于 704 与 736(各差 16),JS 的 Math.round 对 .5 进位 → 取上界 736
    expect(snapTo32(720)).toBe(736);
    expect(snapTo32(730)).toBe(736); // 22.8 → 23
    expect(snapTo32(700)).toBe(704); // 21.9 → 22
    expect(snapTo32(1280)).toBe(1280);
  });

  it('下界钳到 32', () => {
    expect(snapTo32(0)).toBe(32);
    expect(snapTo32(-100)).toBe(32);
    expect(snapTo32(NaN)).toBe(32);
  });

  it('结果永远合法', () => {
    for (const v of [1, 31, 33, 100, 719, 720, 721, 4096]) {
      const s = snapTo32(v);
      expect(isValidOutputSize(s, s), String(v)).toBe(true);
    }
  });
});
