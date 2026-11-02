/**
 * h3c 命令构造单测 — 条件参考参数(首帧/尾帧/参考图/参考视频/音轨)
 *
 * 背景:参考视频此前在画布侧全链路缺失(连线可见、提交静默丢弃);补上后
 * `--ref-video` / `--ref-silent-video` 必须真的落到命令行上,否则「连通了但没生效」会重演。
 */
import { describe, it, expect } from 'vitest';
import { buildH3Args, validateParams, outputSeconds, type H3CliOptions } from '../h3c-command.js';

const base: H3CliOptions = {
  modelDir: '/models/MiniMax-H3',
  prompt: 'Scene: test',
  outputPath: '/out/x.mp4',
  width: 544,
  height: 544,
  frames: 124,
  steps: 20,
  layers: 50,
  reuse: 1,
  seed: 42,
};

/** 取某个 flag 后面跟的值(未出现则 undefined) */
function valueOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe('buildH3Args · 参考视频', () => {
  it('refVideo 缺省走 --ref-video(连同源片内嵌音轨一起注入)', () => {
    const args = buildH3Args({ ...base, refVideo: '/refs/prev.mp4' });
    expect(valueOf(args, '--ref-video')).toBe('/refs/prev.mp4');
    expect(args).not.toContain('--ref-silent-video');
  });

  it('refVideoSilent=true 改走 --ref-silent-video(忽略源片音轨)', () => {
    const args = buildH3Args({ ...base, refVideo: '/refs/prev.mp4', refVideoSilent: true });
    expect(valueOf(args, '--ref-silent-video')).toBe('/refs/prev.mp4');
    expect(args).not.toContain('--ref-video');
  });

  it('refVideoSilent=true 但没有 refVideo 时不输出任何参考视频 flag(不产生裸 flag)', () => {
    const args = buildH3Args({ ...base, refVideoSilent: true });
    expect(args).not.toContain('--ref-video');
    expect(args).not.toContain('--ref-silent-video');
  });

  it('参考视频与首/尾帧、参考图可同时存在(各走各的 flag,互不挤占)', () => {
    const args = buildH3Args({
      ...base,
      firstFrame: '/refs/first.png',
      refImages: ['/refs/a.png', '/refs/b.png'],
      refVideo: '/refs/prev.mp4',
      refAudio: '/refs/voice.wav',
    });
    expect(valueOf(args, '--first-frame')).toBe('/refs/first.png');
    expect(args.filter((a) => a === '--ref-image')).toHaveLength(2);
    expect(valueOf(args, '--ref-video')).toBe('/refs/prev.mp4');
    expect(valueOf(args, '--ref-audio')).toBe('/refs/voice.wav');
  });

  it('参考 flag 出现在 -p 提示词之前(h3 参数解析口径)', () => {
    const args = buildH3Args({ ...base, refVideo: '/refs/prev.mp4' });
    expect(args.indexOf('--ref-video')).toBeLessThan(args.indexOf('-p'));
    for (const f of ['-d', '--width', '--frames', '--steps', '--layers', '--reuse', '--seed']) {
      expect(args, f).toContain(f);
    }
  });
});

describe('validateParams · A:带音轨参考视频的时长下限(h3.c:1146)', () => {
  const base = { steps: 30, layers: 50, reuse: 1, frames: 124 };

  it('preview 档(22 帧 ≈0.92s)+ 带音轨 ref-video → 拒绝(真实事故参数)', () => {
    const issues = validateParams({ ...base, frames: 22, refVideo: '/r/prev.mp4', refVideoSilent: false });
    expect(issues.some((i) => i.includes('至少 2 秒') || i.includes('输出时长 ≥ 2 秒') || i.includes('≥ 2 秒'))).toBe(true);
  });

  it('拒绝文案必须给出两条可执行修法(提时长 / 忽略音轨)', () => {
    const issues = validateParams({ ...base, frames: 22, refVideo: '/r/prev.mp4' });
    const msg = issues.join(' ');
    expect(msg).toContain('56');                  // 提帧数
    expect(msg).toContain('忽略参考视频音轨');      // 绕法
    expect(msg).toContain('--ref-silent-video');
  });

  it('勾「忽略音轨」(refVideoSilent=true)→ 短时长合法(不走 truncate 分支)', () => {
    const issues = validateParams({ ...base, frames: 22, refVideo: '/r/prev.mp4', refVideoSilent: true });
    expect(issues.some((i) => i.includes('2 秒'))).toBe(false);
  });

  it('无参考视频时短时长合法(preview 档正常可用)', () => {
    expect(validateParams({ ...base, frames: 22 })).toEqual([]);
  });

  it('56 帧(≈2.33s)→ 通过(h3 建议值)', () => {
    expect(validateParams({ ...base, frames: 56, refVideo: '/r/prev.mp4' })).toEqual([]);
  });

  it('边界:恰好 48 帧(=2.0s)→ 通过', () => {
    expect(validateParams({ ...base, frames: 48, refVideo: '/r/prev.mp4' })).toEqual([]);
  });

  it('边界:47 帧(<2.0s)→ 拒绝', () => {
    const issues = validateParams({ ...base, frames: 47, refVideo: '/r/prev.mp4' });
    expect(issues.length).toBeGreaterThan(0);
  });

  it('seconds 优先于 frames(给了 seconds=5 就不再按 frames 判)', () => {
    expect(validateParams({ ...base, frames: 22, seconds: 5, refVideo: '/r/prev.mp4' })).toEqual([]);
  });

  it('seconds < 2(如 1.5s)→ 拒绝', () => {
    const issues = validateParams({ ...base, frames: 999, seconds: 1.5, refVideo: '/r/prev.mp4' });
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('validateParams · D:尺寸/时长硬约束(validateShotSubmitParams)', () => {
  const base = { steps: 30, layers: 50, reuse: 1, frames: 124, width: 864, height: 480, seconds: 5 };

  it('合法 864×480 / 5s → 通过', () => {
    expect(validateParams(base)).toEqual([]);
  });

  it('15s 合法(引擎上限)', () => {
    expect(validateParams({ ...base, seconds: 15, frames: 362 })).toEqual([]);
  });

  it('非 32 倍数 → 拒绝', () => {
    const issues = validateParams({ ...base, width: 865, height: 480 });
    expect(issues.some((i) => i.includes('32'))).toBe(true);
  });

  it('时长 16s → 拒绝', () => {
    const issues = validateParams({ ...base, seconds: 16 });
    expect(issues.some((i) => i.includes('上限') || i.includes('15'))).toBe(true);
  });

  it('未传 width/height → 不触发尺寸闸(兼容旧调用)', () => {
    expect(validateParams({ steps: 30, layers: 50, reuse: 1, frames: 124 })).toEqual([]);
  });
});

describe('validateParams · C:reuse 配极少步数(与 h3 warning 同口径)', () => {
  const base = { steps: 30, layers: 50, reuse: 1, frames: 124 };

  it('reuse 2 + 4 步(真实事故参数)→ 给出警告', () => {
    const issues = validateParams({ ...base, steps: 4, reuse: 2 });
    expect(issues.some((i) => i.includes('reuse') && i.includes('质量'))).toBe(true);
  });

  it('警告文案包含 h3 的原话线索 + 两条修法', () => {
    const msg = validateParams({ ...base, steps: 4, reuse: 2 }).join(' ');
    expect(msg).toContain('fresh model evaluations');
    expect(msg).toContain('reuse 1');
  });

  it('reuse 1 + 4 步 → 无警告(加速包常用配置,合法)', () => {
    expect(validateParams({ ...base, steps: 4, reuse: 1 })).toEqual([]);
  });

  it('reuse 2 + 8 步 → 无警告(步数够了)', () => {
    expect(validateParams({ ...base, steps: 8, reuse: 2 })).toEqual([]);
  });

  it('reuse 3 仍走原 layers 防呆(两层规则互不干扰)', () => {
    const issues = validateParams({ steps: 30, layers: 40, reuse: 3, frames: 124 });
    expect(issues.some((i) => i.includes('layers'))).toBe(true);
  });
});

/**
 * 二采(second pass)参数面 —— 对应 `packages/shared/src/second-pass.ts` 的全链真源。
 *
 * 两条引擎硬规则(h3.c `h3_valid_params`):
 *  1. `--second-pass-canvas` 必须配 `--second-pass F`,只给画布 → exit 2
 *     "a second-pass canvas needs a fraction in (0, 1)"(且发生在**入队之后**);
 *  2. `--render-width/--render-height` 必须成对,只给一边引擎不会用,第一遍仍在输出尺寸跑。
 * 构建器的职责是「宁可一个 flag 都不输出」,而不是拼出半套参数 —— 半套参数只会得到
 * 「提交成功、跑完没有二采效果」的假成功。
 */
describe('buildH3Args · 二采 refine(同画布精修)', () => {
  it('① 只输出 --second-pass,不带画布、不带渲染画布', () => {
    const args = buildH3Args({ ...base, secondPass: 0.15 });
    expect(valueOf(args, '--second-pass')).toBe('0.15');
    expect(args).not.toContain('--second-pass-canvas');
    expect(args).not.toContain('--render-width');
    expect(args).not.toContain('--render-height');
  });

  it('F 原样保留精度(0.125 不能被 toFixed(2) 改成 0.13 —— 那会改变重跑步数)', () => {
    const args = buildH3Args({ ...base, secondPass: 0.125 });
    expect(valueOf(args, '--second-pass')).toBe('0.125');
  });
});

describe('buildH3Args · 二采 canvas(Hires)', () => {
  it('② render 画布 + F + 二采画布三组齐全,画布格式 WxH', () => {
    const args = buildH3Args({
      ...base,
      width: 576,
      height: 1024,
      renderWidth: 288,
      renderHeight: 512,
      secondPass: 0.4,
      secondPassCanvas: { width: 576, height: 1024 },
    });
    expect(valueOf(args, '--render-width')).toBe('288');
    expect(valueOf(args, '--render-height')).toBe('512');
    expect(valueOf(args, '--second-pass')).toBe('0.4');
    expect(valueOf(args, '--second-pass-canvas')).toBe('576x1024');
  });

  it('③ 只有 secondPassCanvas、没有 secondPass → 二采 flag 一个都不输出(引擎否则 exit 2)', () => {
    const args = buildH3Args({
      ...base,
      secondPassCanvas: { width: 576, height: 1024 },
    });
    expect(args).not.toContain('--second-pass');
    expect(args).not.toContain('--second-pass-canvas');
    expect(args).not.toContain('--render-width');
    expect(args).not.toContain('--render-height');
  });

  it('④ 非法 F(0 / 1 / NaN / 负数 / Infinity)→ 不输出 --second-pass,画布也一并丢掉', () => {
    for (const f of [0, 1, Number.NaN, -0.2, Number.POSITIVE_INFINITY]) {
      const args = buildH3Args({
        ...base,
        secondPass: f,
        secondPassCanvas: { width: 576, height: 1024 },
      });
      expect(args, `F=${String(f)} 不应产出 --second-pass`).not.toContain('--second-pass');
      expect(args).not.toContain('--second-pass-canvas');
    }
  });

  it('⑤ render 画布只给一边 / 非正整数 → 两个都不输出(半对参数会被引擎静默无视)', () => {
    const patches: Array<Partial<H3CliOptions>> = [
      { renderWidth: 288 },
      { renderHeight: 512 },
      { renderWidth: 0, renderHeight: 512 },
      { renderWidth: 288, renderHeight: Number.NaN },
      { renderWidth: 288.5, renderHeight: 512 },
    ];
    for (const patch of patches) {
      const args = buildH3Args({ ...base, ...patch });
      expect(args, JSON.stringify(patch)).not.toContain('--render-width');
      expect(args).not.toContain('--render-height');
    }
  });

  it('⑥ 与首/尾帧、参考图、参考视频、参考音频共存,互不挤占,prompt 仍收尾', () => {
    const args = buildH3Args({
      ...base,
      width: 576,
      height: 1024,
      firstFrame: '/refs/first.png',
      lastFrame: '/refs/last.png',
      refImages: ['/refs/a.png'],
      refVideo: '/refs/prev.mp4',
      refAudio: '/refs/voice.wav',
      renderWidth: 288,
      renderHeight: 512,
      secondPass: 0.4,
      secondPassCanvas: { width: 576, height: 1024 },
    });
    expect(valueOf(args, '--first-frame')).toBe('/refs/first.png');
    expect(valueOf(args, '--last-frame')).toBe('/refs/last.png');
    expect(args.filter((a) => a === '--ref-image')).toHaveLength(1);
    expect(valueOf(args, '--ref-video')).toBe('/refs/prev.mp4');
    expect(valueOf(args, '--ref-audio')).toBe('/refs/voice.wav');
    expect(valueOf(args, '--render-width')).toBe('288');
    expect(valueOf(args, '--second-pass')).toBe('0.4');
    expect(valueOf(args, '--second-pass-canvas')).toBe('576x1024');
    // -p 必须在 -o 之前且紧跟提示词:二采 flag 不能把提示词挤到错误位置
    const pIdx = args.indexOf('-p');
    expect(args[pIdx + 1]).toBe(base.prompt);
    expect(args[args.indexOf('-o') + 1]).toBe(base.outputPath);
  });

  it('不开二采时一个二采 flag 都不出现(存量行为零变化)', () => {
    const args = buildH3Args({ ...base });
    expect(args).not.toContain('--second-pass');
    expect(args).not.toContain('--second-pass-canvas');
    expect(args).not.toContain('--render-width');
    expect(args).not.toContain('--render-height');
  });
});

describe('validateParams · E:二采脏值(直接调用方的最后一道闸)', () => {
  const base = { steps: 30, layers: 50, reuse: 1, frames: 124, width: 576, height: 1024, seconds: 5 };

  it('合法组合(refine / canvas)→ 通过', () => {
    expect(validateParams({ ...base, secondPass: 0.15 })).toEqual([]);
    expect(
      validateParams({
        ...base,
        secondPass: 0.4,
        secondPassCanvas: { width: 576, height: 1024 },
        renderWidth: 288,
        renderHeight: 512,
      }),
    ).toEqual([]);
  });

  it('⑦ F 越界 → 中文拒绝,说明 0/1 为什么不合法并给推荐值', () => {
    for (const f of [0, 1, -0.5, 2, Number.NaN]) {
      const msg = validateParams({ ...base, secondPass: f }).join(' ');
      expect(msg).toContain('二采比例');
      expect(msg).toContain('0<F<1');
      expect(msg).toContain('0.4');
    }
  });

  it('⑦ 只给二采画布 → 拒绝并引用引擎原话(入队后才 exit 2 是最坏形态)', () => {
    const msg = validateParams({ ...base, secondPassCanvas: { width: 576, height: 1024 } }).join(' ');
    expect(msg).toContain('a second-pass canvas needs a fraction in (0, 1)');
    expect(msg).toContain('--second-pass');
  });

  it('⑦ render 画布不成对 / 非正整数 → 拒绝(否则引擎静默无视,画布二采白花一遍时间)', () => {
    for (const patch of [
      { renderWidth: 288 },
      { renderHeight: 512 },
      { renderWidth: 0, renderHeight: 512 },
      { renderWidth: 288.5, renderHeight: 512 },
    ]) {
      const msg = validateParams({ ...base, secondPass: 0.4, ...patch }).join(' ');
      expect(msg).toContain('--render-width');
      expect(msg).toContain('成对');
    }
  });

  it('合法 F + 合法渲染画布不误伤(provider 走 planSecondPass,传过来永远合法)', () => {
    expect(validateParams({ ...base, secondPass: 0.05, renderWidth: 288, renderHeight: 512 })).toEqual([]);
    expect(validateParams({ ...base, secondPass: 0.9999 })).toEqual([]);
  });
});

/**
 * ⑧ 参考组合(h3 引擎两条硬校验)—— 2026-11-02。
 *
 * 引擎事实(源码 + 实测,h3 二进制):
 *   ① --ref-image/--ref-video/--ref-audio 与 --first-frame/--last-frame 互斥
 *      (h3.c:618;--ref-audio 同样让 reference_count 自增,main.c:512-518)
 *      ⇒ `h3 --first-frame X --ref-audio Y` 实测报
 *        "full references cannot be combined with frame anchors"(exit 1)
 *   ② --ref-audio 不能单独存在(h3.c:659;纯音频引用不计入 visual)
 *      ⇒ `h3 --ref-audio Y` 实测报
 *        "reference audio requires an image or video reference"(exit 1)
 *
 * 这两条在引擎里是**入队后**才 exit 1 的硬错误,所以必须在提交前拦。
 */
describe('validateParams · ⑧ 参考组合(h3 引擎硬校验)', () => {
  it('⑧ 首帧/尾帧 与 音频参考同时给出 → 拒绝并引用引擎原话', () => {
    for (const patch of [{ firstFrame: '/f.png' }, { lastFrame: '/l.png' }]) {
      const msg = validateParams({ ...base, ...patch, refAudio: '/a.wav' }).join(' ');
      expect(msg).toContain('互斥');
      expect(msg).toContain('full references cannot be combined with frame anchors');
    }
  });

  it('⑧ 只有音频参考、没有视觉参考 → 拒绝并引用引擎原话', () => {
    const msg = validateParams({ ...base, refAudio: '/a.wav' }).join(' ');
    expect(msg).toContain('reference audio requires an image or video reference');
  });

  it('⑧ 音频参考 + 参考图 / 参考视频 → 合法(engine 侧实测通过校验)', () => {
    expect(validateParams({ ...base, refAudio: '/a.wav', refImages: ['/r.png'] })).toEqual([]);
    expect(validateParams({ ...base, refAudio: '/a.wav', refVideo: '/v.mp4' })).toEqual([]);
  });

  it('⑧ 首帧 与 参考图 互斥(既有规则,回归护栏)', () => {
    const msg = validateParams({ ...base, firstFrame: '/f.png', refImages: ['/r.png'] }).join(' ');
    expect(msg).toContain('互斥');
  });

  it('⑧ 不给任何参考字段的老调用方不受影响(向后兼容)', () => {
    expect(validateParams({ steps: 30, layers: 50, reuse: 1, frames: 124 })).toEqual([]);
  });
});
