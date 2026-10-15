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
