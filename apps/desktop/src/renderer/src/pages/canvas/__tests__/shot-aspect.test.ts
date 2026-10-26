/**
 * 视频画幅(shot)尺寸规则单测 —— 2026-10
 *
 * 锁三件事:
 *  ① **新增比例 4:3 / 3:4 必须是合法档**(32 倍数 + 严格比例);
 *  ② **分辨率一律由「档位」决定** —— 任何情况下不被图片分辨率顶掉(事故回归);
 *  ③ 连接角色只影响**比例**:首帧沿用图片比例、参考图默认 4:3。
 *
 * ② 是真实事故:早期实现让「首帧」模式把上游图片的宽高直接当视频尺寸,
 * 于是 4K 参考图 + 「预览档」会出 4K 片,用户选的档位失效、耗时显存失控。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tierKeyOf, resLine } from '../constants.js';
import {
  VIDEO_ASPECTS,
  VIDEO_ASPECT_LABEL,
  VIDEO_TIERS,
  VIDEO_TIER_PRESETS,
  SHOT_SIZES,
  fitImageSizeToGrid,
  classifyAspect,
  defaultShotAspectForRole,
} from '@bigbotart/shared';

const here = dirname(fileURLToPath(import.meta.url));

/** h3 硬约束:宽高都是 32 的倍数,且面积 ≤ 768×1344 */
const isLegal = (w: number, h: number) =>
  w > 0 && h > 0 && w % 32 === 0 && h % 32 === 0 && w * h <= 768 * 1344;

describe('① 新增比例 4:3 / 3:4 在画幅清单中', () => {
  it('含 4:3 / 3:4,且保留原有三种', () => {
    for (const a of ['16:9', '9:16', '1:1', '4:3', '3:4']) expect(VIDEO_ASPECTS).toContain(a);
  });

  it('每个比例都有中文标签', () => {
    for (const a of VIDEO_ASPECTS) expect(VIDEO_ASPECT_LABEL[a], `${a} 缺标签`).toBeTruthy();
    expect(VIDEO_ASPECT_LABEL['4:3']).toContain('4:3');
    expect(VIDEO_ASPECT_LABEL['3:4']).toContain('3:4');
  });
});

describe('② 分辨率由档位决定(事故回归:图片尺寸不得顶掉档位)', () => {
  it('每个「比例 × 档位」组合都在 SHOT_SIZES 里且合法', () => {
    for (const a of VIDEO_ASPECTS) {
      for (const t of VIDEO_TIERS) {
        const s = SHOT_SIZES[a][t];
        expect(s, `${a}/${t} 缺档位`).toBeTruthy();
        expect(isLegal(s.width, s.height), `${a}/${t} = ${s.width}×${s.height} 非法`).toBe(true);
      }
    }
  });

  it('同一比例下,reference 档面积 ≥ preview 档(档位语义单调)', () => {
    for (const a of VIDEO_ASPECTS) {
      const p = SHOT_SIZES[a].preview;
      const r = SHOT_SIZES[a].reference;
      expect(r.width * r.height, `${a} 参考档不应小于预览档`).toBeGreaterThanOrEqual(p.width * p.height);
    }
  });

  it('4:3 与同等 16:9 的面积量级接近(切比例不改变速度档位)', () => {
    for (const t of VIDEO_TIERS) {
      const a169 = SHOT_SIZES['16:9'][t];
      const a43 = SHOT_SIZES['4:3'][t];
      const ratio = (a43.width * a43.height) / (a169.width * a169.height);
      expect(ratio, `${t} 档 4:3/16:9 面积比 ${ratio}`).toBeGreaterThan(0.4);
      expect(ratio, `${t} 档 4:3/16:9 面积比 ${ratio}`).toBeLessThan(2.5);
    }
  });

  it('4:3 的每个档位都严格等于 4:3 比例、3:4 严格等于 3:4', () => {
    for (const t of VIDEO_TIERS) {
      const a = SHOT_SIZES['4:3'][t];
      const b = SHOT_SIZES['3:4'][t];
      expect(a.width / a.height, `4:3/${t}`).toBeCloseTo(4 / 3, 10);
      expect(b.width / b.height, `3:4/${t}`).toBeCloseTo(3 / 4, 10);
      // 严格旋转对称
      expect([b.width, b.height]).toEqual([a.height, a.width]);
    }
  });
});

describe('③ 连接角色只定比例:首帧沿用图片比例,参考图默认 4:3', () => {
  it('首帧 + 16:9 图片 → 比例 16:9(不是图片的像素尺寸)', () => {
    const a = defaultShotAspectForRole('first-frame', { width: 1920, height: 1080 });
    expect(a).toBe('16:9');
    // 关键:返回值只能是比例,像素由档位查表
    const size = SHOT_SIZES[a!].preview;
    expect(size).toEqual({ width: 864, height: 480 }); // 不是 1920×1080
  });

  it('首帧 + 4:3 图片 → 4:3', () => {
    expect(defaultShotAspectForRole('first-frame', { width: 1024, height: 768 })).toBe('4:3');
  });

  it('首帧 + 9:16 图片 → 9:16(非 32 倍数也能正确归类)', () => {
    expect(defaultShotAspectForRole('first-frame', { width: 1080, height: 1920 })).toBe('9:16');
  });

  it('首帧但没有上游尺寸 → null(不干预,用弹层所选)', () => {
    expect(defaultShotAspectForRole('first-frame', undefined)).toBeNull();
    expect(defaultShotAspectForRole('first-frame', { width: 0, height: 0 })).toBeNull();
  });

  it('首帧 + 无法归类的图片比例(如 3:2)→ null(不猜)', () => {
    expect(defaultShotAspectForRole('first-frame', { width: 1500, height: 1000 })).toBeNull();
  });

  it('参考图 → 4:3,且与上游尺寸无关', () => {
    expect(defaultShotAspectForRole('ref-image')).toBe('4:3');
    expect(defaultShotAspectForRole('ref-image', { width: 1920, height: 1080 })).toBe('4:3');
  });

  it('其余角色不干预', () => {
    for (const r of [undefined, '', 'text2video', 'ref-video', 'audio-ref', 'last-frame']) {
      expect(defaultShotAspectForRole(r as string), `${r} 不应干预`).toBeNull();
    }
  });
});

describe('fitImageSizeToGrid / classifyAspect 纯函数', () => {
  it('非法输入退回 1:1 兜底,不抛错', () => {
    for (const [w, h] of [
      [0, 0],
      [-5, 10],
      [NaN, 100],
      [Infinity, 100],
    ] as Array<[number, number]>) {
      const r = fitImageSizeToGrid(w, h);
      expect(r).toEqual({ width: 544, height: 544 });
    }
  });

  it('贴合结果始终合法,且比例漂移 <1%', () => {
    for (const [w, h] of [
      [1534, 2047],
      [1000, 1000],
      [1921, 1081],
      [1080, 1920],
      [4096, 4096],
    ] as Array<[number, number]>) {
      const r = fitImageSizeToGrid(w, h);
      expect(isLegal(r.width, r.height), `${w}×${h} → ${r.width}×${r.height} 非法`).toBe(true);
      const err = Math.abs(r.width / r.height - w / h) / (w / h);
      expect(err, `${w}×${h} → ${r.width}×${r.height} 漂移 ${err}`).toBeLessThan(0.01);
    }
  });

  it('超大图不超面积上限', () => {
    const r = fitImageSizeToGrid(4096, 4096);
    expect(r.width * r.height).toBeLessThanOrEqual(768 * 1344);
  });

  it('classifyAspect 容差内归类,超差回 custom', () => {
    expect(classifyAspect(1024, 768)).toBe('4:3');
    expect(classifyAspect(1080, 1920)).toBe('9:16');
    expect(classifyAspect(1920, 1080)).toBe('16:9');
    expect(classifyAspect(1500, 1000)).toBe('custom'); // 3:2
    expect(classifyAspect(1250, 1000)).toBe('custom'); // 5:4
    expect(classifyAspect(0, 0)).toBe('custom');
  });
});

describe('④ 表一致性:渲染层 SHOT_SIZES 必须就是 shared 的那份', () => {
  const rendererSrc = readFileSync(join(here, '..', 'constants.ts'), 'utf8');

  it('渲染层不再自带副本,而是从 shared 取', () => {
    expect(rendererSrc).toContain('SHOT_SIZES as SHARED_SHOT_SIZES');
    expect(rendererSrc).toContain('export const SHOT_SIZES = SHARED_SHOT_SIZES');
  });

  it('providers 的 ASPECT_SIZES 与本表在新增比例上一致', () => {
    const repoRoot = (() => {
      let dir = here;
      for (let i = 0; i < 12; i++) {
        if (existsSync(join(dir, 'packages', 'providers', 'src', 'h3c-command.ts'))) return dir;
        dir = join(dir, '..');
      }
      throw new Error('未能定位仓库根');
    })();
    const src = readFileSync(join(repoRoot, 'packages', 'providers', 'src', 'h3c-command.ts'), 'utf8');
    for (const aspect of ['4:3', '3:4'] as const) {
      const i = src.indexOf(`'${aspect}': {`);
      expect(i, `providers 缺 ${aspect}`).toBeGreaterThan(-1);
      const block = src.slice(i, i + 400);
      for (const t of VIDEO_TIERS) {
        const expect_ = SHOT_SIZES[aspect][t];
        expect(
          block.includes(`width: ${expect_.width}, height: ${expect_.height}`),
          `providers 的 ${aspect}/${t} 与 shared 不一致(应含 ${expect_.width}×${expect_.height})`,
        ).toBe(true);
      }
    }
  });
});

describe('⑤ 事故回归:弹层中文档位标签必须能查到尺寸(否则静默退回旧硬编码)', () => {
  /*
   * 真实事故(2026-10):`AddNodePopover` 的档位 chips 是中文「预览/草稿/默认/参考」,
   * 而 `SHOT_SIZES` 的键是英文 preview/draft/default/reference。直接把中文当 key 查表
   * 得到 undefined,`createFromPop` 里 `...(specSize ? {...} : {})` 便**静默**不写尺寸,
   * 节点回落到 `makeInitialData` 的硬编码 1280×720 ——
   * 表现为「弹层选 3:4 默认档,节点却是 1280×720 / 16:9」,且没有任何报错。
   *
   * 这里锁死:tierKeyOf 对中文标签与英文 key 都能归一,且每个组合都查得到尺寸。
   */
  it('中文档位标签能归一为英文 key', () => {
    expect(tierKeyOf('预览')).toBe('preview');
    expect(tierKeyOf('草稿')).toBe('draft');
    expect(tierKeyOf('默认')).toBe('default');
    expect(tierKeyOf('参考')).toBe('reference');
  });

  it('英文 key 原样透传(兼容直接传 key 的调用方)', () => {
    for (const t of VIDEO_TIERS) expect(tierKeyOf(t)).toBe(t);
  });

  it('未知档位标签有确定兜底(不返回 undefined)', () => {
    for (const bad of ['', '不存在', 'Default', 'PREVIEW']) {
      expect(tierKeyOf(bad), `${bad} 应兜底为 default`).toBe('default');
    }
  });

  it('弹层用的 4 个中文档位 × 全部比例,都能查到合法尺寸', () => {
    for (const label of ['预览', '草稿', '默认', '参考']) {
      for (const a of VIDEO_ASPECTS) {
        const s = SHOT_SIZES[a][tierKeyOf(label)];
        expect(s, `${label} + ${a} 查不到尺寸(会静默退回旧硬编码)`).toBeTruthy();
        expect(isLegal(s.width, s.height), `${label}/${a} = ${s.width}×${s.height} 非法`).toBe(true);
      }
    }
  });

  it('resLine 提示的尺寸 === SHOT_SIZES 落盘尺寸(提示与实际同源)', () => {
    for (const label of ['预览', '草稿', '默认', '参考']) {
      for (const a of VIDEO_ASPECTS) {
        const s = SHOT_SIZES[a][tierKeyOf(label)];
        const line = resLine(a, label);
        expect(line, `${label}/${a} 提示行未反映真实尺寸`).toContain(`${s.width}×${s.height}`);
      }
    }
  });

  it('resLine 的 ETA 与 shared VIDEO_TIER_PRESETS 完全一致(不再维护第三份表)', () => {
    for (const tier of VIDEO_TIERS) {
      const preset = VIDEO_TIER_PRESETS[tier];
      expect(resLine('16:9', preset.label)).toContain(`预计 ${preset.eta}`);
      expect(resLine('16:9', tier)).toContain(`预计 ${preset.eta}`);
    }
  });
});
