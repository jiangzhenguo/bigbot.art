/**
 * 语音合成 / 视频配音(CosyVoice3)——主进程 tts.ts 单测
 *
 * 覆盖:
 *  - 纯函数:buildTtsArgs / buildDubArgs(参数面、mix/音量/keepWav)、estimateAudioSeconds、
 *    resolveTtsMode(instruct 优先)、translateTtsError(升级/未准备/ffmpeg 指引)
 *  - 探测:probeTtsTooling(package 结构齐全才算就绪、缺啥报啥、prepareHint 可照抄)
 *  - dry-run:只构造命令、不 spawn、不产出文件(R2 红线),且**不要求**引擎就绪
 *  - 输入防呆:空文本 / 缺参考音色 / 配音缺视频 → 明确拒绝
 *
 * ⚠️ 与 video-post.test.ts 同约定:tts.ts 依赖的 OUTPUTS_DIR 在 import 时按 env 求值,
 * 必须先设 BIGBOTART_HOME / BIGBOTART_TTS_OUTPUTS,再动态 import。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-tts-test-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');
process.env.BIGBOTART_TTS_OUTPUTS = join(tmpHome, 'outputs', 'dub');
process.env.BIGBOTART_DRYRUN = '1';

const pkg = join(tmpHome, 'cosyvoice3');
const vdPkg = join(tmpHome, 'qwen3-tts');
const mlxgenBin = join(tmpHome, 'bin', 'mlxgen');
let refWav = '';
let srcMp4 = '';
let TTS: typeof import('../tts.js');

beforeAll(async () => {
  mkdirSync(join(tmpHome, 'outputs'), { recursive: true });
  // 伪造一个结构完整的 prepared package(探测只看结构,不加载模型)
  mkdirSync(join(pkg, 'model'), { recursive: true });
  mkdirSync(join(pkg, 'runtime'), { recursive: true });
  mkdirSync(join(pkg, 'venv', 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'venv', 'bin', 'python'), '');
  writeFileSync(join(pkg, 'manifest.json'), '{"model":"cosyvoice3"}');
  // 引擎包自带的官方示例参考音(3.5s)
  writeFileSync(join(pkg, 'runtime', 'zero_shot_prompt.wav'), 'RIFF-official-sample');
  process.env.BIGBOTART_COSYVOICE3_PATH = pkg;

  // Qwen3-TTS VoiceDesign 包(纯 MLX:没有 runtime/venv,只有 model/ + manifest.json)
  mkdirSync(join(vdPkg, 'model'), { recursive: true });
  writeFileSync(join(vdPkg, 'manifest.json'), '{"model":"qwen3-tts-voice-design"}');
  writeFileSync(join(vdPkg, 'model', 'model.safetensors'), 'fake-weights');
  process.env.BIGBOTART_QWEN3_TTS_PATH = vdPkg;
  // 伪 mlxgen 可执行文件( dry-run 永远不会 spawn 它)
  mkdirSync(join(tmpHome, 'bin'), { recursive: true });
  writeFileSync(mlxgenBin, '#!/bin/sh\nexit 0\n');
  chmodSync(mlxgenBin, 0o755);
  process.env.BIGBOTART_MLXGEN_BIN = mlxgenBin;

  refWav = join(tmpHome, 'outputs', 'voice.wav');
  writeFileSync(refWav, 'RIFF-fake-wav');
  srcMp4 = join(tmpHome, 'outputs', 'clip.mp4');
  writeFileSync(srcMp4, 'fake-mp4-bytes');

  TTS = await import('../tts.js');
});

afterAll(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响断言 */
  }
});

describe('buildTtsArgs(mlxgen tts)', () => {
  it('拼出完整命令:model-path / text / ref-audio / speed / seed / json-events', () => {
    const args = TTS.buildTtsArgs(
      { text: '女主跃过河面。', refVoicePath: '/tmp/voice.wav', speed: 1.2, seed: 7 },
      { packagePath: '/pkg', outputPath: '/out/a.wav' },
    );
    expect(args[0]).toBe('tts');
    expect(args).toContain('--model-path');
    expect(args[args.indexOf('--model-path') + 1]).toBe('/pkg');
    expect(args).toContain('--text=女主跃过河面。');
    expect(args[args.indexOf('--ref-audio') + 1]).toBe('/tmp/voice.wav');
    expect(args[args.indexOf('--output') + 1]).toBe('/out/a.wav');
    expect(args[args.indexOf('--speed') + 1]).toBe('1.2');
    expect(args[args.indexOf('--seed') + 1]).toBe('7');
    expect(args).toContain('--json-events');
    expect(args).not.toContain('--keep-wav');
  });

  it('refText / instruct 只在非空时追加(instruct 与 refText 可同时给,由引擎判优先)', () => {
    const args = TTS.buildTtsArgs(
      { text: 'hi', refVoicePath: '/v.wav', refText: '参考音逐字稿', instruct: '温柔地说' },
      { packagePath: '/pkg', outputPath: '/out/a.wav' },
    );
    expect(args[args.indexOf('--ref-text') + 1]).toBe('参考音逐字稿');
    expect(args[args.indexOf('--instruct') + 1]).toBe('温柔地说');
    const bare = TTS.buildTtsArgs(
      { text: 'hi', refVoicePath: '/v.wav', refText: '   ', instruct: '' },
      { packagePath: '/pkg', outputPath: '/out/a.wav' },
    );
    expect(bare).not.toContain('--ref-text');
    expect(bare).not.toContain('--instruct');
  });
});

describe('buildDubArgs(mlxgen dub)', () => {
  it('含视频、mix 模式、两个音量与 keep-wav', () => {
    const args = TTS.buildDubArgs(
      {
        text: '旁白',
        refVoicePath: '/v.wav',
        inputVideoPath: '/src.mp4',
        mixMode: 'mix',
        origVolume: 0.3,
        ttsVolume: 0.9,
        keepWav: true,
      },
      { packagePath: '/pkg', outputPath: '/out/a.mp4' },
    );
    expect(args[0]).toBe('dub');
    expect(args[args.indexOf('--video-path') + 1]).toBe('/src.mp4');
    expect(args[args.indexOf('--mode') + 1]).toBe('mix');
    expect(args[args.indexOf('--orig-volume') + 1]).toBe('0.3');
    expect(args[args.indexOf('--tts-volume') + 1]).toBe('0.9');
    expect(args).toContain('--keep-wav');
    expect(args[args.indexOf('--output') + 1]).toBe('/out/a.mp4');
  });

  it('非法 mixMode / 非数值音量回落到 replace 与默认值', () => {
    const args = TTS.buildDubArgs(
      { text: 'x', refVoicePath: '/v.wav', inputVideoPath: '/s.mp4', mixMode: 'nope' as never, origVolume: Number.NaN },
      { packagePath: '/p', outputPath: '/o.mp4' },
    );
    expect(args[args.indexOf('--mode') + 1]).toBe('replace');
    expect(args[args.indexOf('--orig-volume') + 1]).toBe('0.15');
    expect(args[args.indexOf('--tts-volume') + 1]).toBe('1');
  });
});

describe('时长预估 / 模式判定', () => {
  it('中文按 ~4 字/秒估算,空文本给下限', () => {
    expect(TTS.estimateAudioSeconds('一二三四五六七八九十一二三四五六七八九十')).toBeGreaterThanOrEqual(4.5);
    expect(TTS.estimateAudioSeconds('')).toBe(1.5);
  });

  it('instruct 优先于 refText,都没有则 cross_lingual', () => {
    expect(TTS.resolveTtsMode({ instruct: '温柔', refText: '稿' })).toBe('instruct2');
    expect(TTS.resolveTtsMode({ refText: '稿' })).toBe('zero_shot');
    expect(TTS.resolveTtsMode({})).toBe('cross_lingual');
  });
});

describe('probeTtsTooling', () => {
  it('prepared package 结构齐全 + mlxgen + ffmpeg → 就绪', () => {
    const p = TTS.probeTtsTooling({
      env: { BIGBOTART_COSYVOICE3_PATH: pkg } as NodeJS.ProcessEnv,
      exists: (x) => existsSync(x),
      which: () => '/usr/bin/ffmpeg',
      resolveMlxgen: () => mlxgenBin,
    });
    expect(p.mlxgen).toBe(true);
    expect(p.packageReady).toBe(true);
    expect(p.packagePath).toBe(pkg);
    expect(p.ffmpeg).toBe(true);
    expect(p.missing).toEqual([]);
    expect(p.prepareHint).toContain('mlxgen prepare --model cosyvoice3');
  });

  it('缺 venv / 缺 mlxgen / 缺 ffmpeg → 逐项写进 missing,并给 prepareHint', () => {
    const p = TTS.probeTtsTooling({
      env: { BIGBOTART_COSYVOICE3_PATH: join(tmpHome, 'not-ready') } as NodeJS.ProcessEnv,
      exists: (x) => !x.includes('venv'),
      which: () => undefined,
      resolveMlxgen: () => undefined,
    });
    expect(p.packageReady).toBe(false);
    expect(p.mlxgen).toBe(false);
    expect(p.ffmpeg).toBe(false);
    expect(p.missing.join('\n')).toContain('mlxgen');
    expect(p.missing.join('\n')).toContain('prepared package');
    expect(p.missing.join('\n')).toContain('ffmpeg');
    expect(p.prepareHint).toContain('prepare --model cosyvoice3');
  });
});

describe('dry-run(R2 红线)', () => {
  it('tts-gen:返回 dryRun=true,不产出文件、不要求引擎就绪', async () => {
    const dubDir = process.env.BIGBOTART_TTS_OUTPUTS as string;
    const before = existsSync(dubDir) ? readdirSync(dubDir).length : 0;
    const res = await TTS.synthesizeSpeech({
      nodeId: 'dry-tts',
      kind: 'tts-gen',
      text: '一句话做出一条片。',
      refVoicePath: refWav,
    });
    expect(res.ok).toBe(false);
    expect(res.dryRun).toBe(true);
    expect(res.mode).toBe('cross_lingual');
    expect(res.error).toContain('dry-run');
    const after = existsSync(dubDir) ? readdirSync(dubDir).length : 0;
    expect(after).toBe(before);
  });

  it('video-dub:dry-run 同样只回命令,不 spawn ffmpeg/CosyVoice', async () => {
    const res = await TTS.synthesizeSpeech({
      nodeId: 'dry-dub',
      kind: 'video-dub',
      text: '旁白',
      refVoicePath: refWav,
      inputVideoPath: srcMp4,
      mixMode: 'mix',
    });
    expect(res.dryRun).toBe(true);
    expect(res.error).toContain('--video-path');
    expect(res.error).toContain('--mode');
  });
});


describe('Qwen3-TTS 文字设计音色(voice-design)', () => {
  it('包结构判定:manifest + model + 真权重才算就绪', () => {
    expect(TTS.isQwen3TtsPackageReady(vdPkg)).toBe(true);
    expect(TTS.isQwen3TtsPackageReady(join(tmpHome, 'nope'))).toBe(false);
    expect(TTS.qwen3TtsPackageCandidates({ BIGBOTART_QWEN3_TTS_PATH: '/x' }, tmpHome)[0]).toBe('/x');
  });

  it('probe 同时报告两套引擎(缺 Qwen3 包时明确标未就绪)', () => {
    const got = TTS.probeTtsTooling({
      env: { BIGBOTART_QWEN3_TTS_PATH: vdPkg, BIGBOTART_COSYVOICE3_PATH: pkg },
      which: () => '/bin/ffmpeg',
      resolveMlxgen: () => mlxgenBin,
    });
    expect(got.voiceDesignReady).toBe(true);
    expect(got.voiceDesignPackagePath).toBe(vdPkg);
    expect(got.voiceDesignPrepareHint).toContain('qwen3-tts-voice-design');
    expect(got.packageReady).toBe(true);
    // 注:探测会继续回退到开发机真实路径(~/ai/mlx-gen/out/...),所以这里只锁
    // 「自定义路径命中时用自定义路径」;包缺失的判定由 isQwen3TtsPackageReady 单测覆盖。
  });

  it('resolveVoiceMode:显式优先,只有描述时按 design,其余 clone', () => {
    expect(TTS.resolveVoiceMode({ voiceMode: 'clone', voiceDescription: 'x' })).toBe('clone');
    expect(TTS.resolveVoiceMode({ voiceMode: 'design' })).toBe('design');
    expect(TTS.resolveVoiceMode({ voiceDescription: '温暖女声' })).toBe('design');
    expect(TTS.resolveVoiceMode({ voiceProfile: 'news-anchor' })).toBe('design');
    expect(TTS.resolveVoiceMode({})).toBe('clone');
  });

  it('buildVoiceDesignArgs:profile/描述、语言、temperature、json-events', () => {
    const byProfile = TTS.buildVoiceDesignArgs(
      { text: '你好', voiceProfile: 'news-anchor', language: 'chinese', seed: 7, temperature: 0.8 },
      { packagePath: '/vd', outputPath: '/out/a.wav' },
    );
    expect(byProfile[0]).toBe('voice-design');
    expect(byProfile[byProfile.indexOf('--model-path') + 1]).toBe('/vd');
    expect(byProfile).toContain('--text=你好');
    expect(byProfile[byProfile.indexOf('--voice-profile') + 1]).toBe('news-anchor');
    expect(byProfile[byProfile.indexOf('--language') + 1]).toBe('chinese');
    expect(byProfile[byProfile.indexOf('--temperature') + 1]).toBe('0.8');
    expect(byProfile).toContain('--json-events');
    expect(byProfile).not.toContain('--ref-audio');
    const byDesc = TTS.buildVoiceDesignArgs(
      { text: 'hi', voiceDescription: 'a warm female voice' },
      { packagePath: '/vd', outputPath: '/out/b.wav' },
    );
    expect(byDesc[byDesc.indexOf('--voice') + 1]).toBe('a warm female voice');
    expect(byDesc).not.toContain('--voice-profile');
  });

  it('buildDubVoiceDesignArgs:video + voice-model-path + voice-design + 混音参数', () => {
    const args = TTS.buildDubVoiceDesignArgs(
      {
        text: '旁白',
        inputVideoPath: '/in.mp4',
        voiceDescription: 'a deep male narrator',
        language: 'chinese',
        mixMode: 'mix',
        origVolume: 0.2,
        ttsVolume: 0.9,
        keepWav: true,
      },
      { packagePath: '/vd', outputPath: '/out/a.mp4' },
    );
    expect(args[0]).toBe('dub');
    expect(args[args.indexOf('--video-path') + 1]).toBe('/in.mp4');
    expect(args[args.indexOf('--voice-model-path') + 1]).toBe('/vd');
    expect(args[args.indexOf('--voice-design') + 1]).toBe('a deep male narrator');
    expect(args[args.indexOf('--mode') + 1]).toBe('mix');
    expect(args[args.indexOf('--orig-volume') + 1]).toBe('0.2');
    expect(args[args.indexOf('--tts-volume') + 1]).toBe('0.9');
    expect(args).toContain('--keep-wav');
    expect(args).not.toContain('--ref-audio');
  });

  it('dry-run:design 不需要参考音,只构造 voice-design 命令、不 spawn、不写文件', async () => {
    const res = await TTS.synthesizeSpeech({
      kind: 'tts-gen',
      text: '晚上好。',
      voiceMode: 'design',
      voiceProfile: 'narrator-female',
      language: 'chinese',
    });
    expect(res.ok).toBe(false);
    expect(res.dryRun).toBe(true);
    expect(res.voiceMode).toBe('design');
    expect(res.error).toContain('voice-design');
    expect(res.error).toContain('--voice-profile narrator-female');
  });

  it('design 缺少描述/profile → 明确拒绝(不消耗引擎)', async () => {
    const res = await TTS.synthesizeSpeech({
      kind: 'tts-gen',
      text: '你好',
      voiceMode: 'design',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('音色描述');
  });
});

describe('示例音色(CosyVoice3 无预设音色时的开箱入口)', () => {
  it('包里有 runtime/zero_shot_prompt.wav 才算可用', () => {
    expect(TTS.sampleVoiceSource(pkg)).toBe(join(pkg, 'runtime', 'zero_shot_prompt.wav'));
    expect(TTS.sampleVoiceSource(join(tmpHome, 'nope'))).toBeUndefined();
    expect(TTS.sampleVoiceSource(undefined)).toBeUndefined();
  });

  it('复制到产物目录 voices/ 并可重复调用(幂等,不覆盖)', () => {
    const a = TTS.ensureSampleVoice();
    expect(a.ok).toBe(true);
    expect(a.path).toBe(join(process.env.BIGBOTART_TTS_OUTPUTS as string, 'voices', 'cosyvoice3-sample.wav'));
    expect(existsSync(a.path!)).toBe(true);
    const b = TTS.ensureSampleVoice();
    expect(b).toEqual({ ok: true, path: a.path });
  });

  it('包里缺示例音色时明确失败,不伪造路径', () => {
    const wav = join(pkg, 'runtime', 'zero_shot_prompt.wav');
    const backup = `${wav}.bak`;
    renameSync(wav, backup);
    try {
      const r = TTS.ensureSampleVoice();
      expect(r.ok).toBe(false);
      expect(r.error).toContain('zero_shot_prompt.wav');
      expect(r.path).toBeUndefined();
    } finally {
      renameSync(backup, wav);
    }
  });
});

describe('同节点重复提交闸', () => {
  it('并发提交同一 nodeId → 第二次当场拒绝,不排到链尾再跑一遍', async () => {
    const p1 = TTS.synthesizeSpeech({ nodeId: 'dup-node', kind: 'tts-gen', text: 'hi', refVoicePath: refWav });
    const p2 = TTS.synthesizeSpeech({ nodeId: 'dup-node', kind: 'tts-gen', text: 'hi', refVoicePath: refWav });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.dryRun).toBe(true);
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('已有语音任务');
    // 任务结束后闸门释放:同节点可以重跑
    const again = await TTS.synthesizeSpeech({ nodeId: 'dup-node', kind: 'tts-gen', text: 'hi', refVoicePath: refWav });
    expect(again.dryRun).toBe(true);
  });
});

describe('输入防呆(明确拒绝,不静默降级)', () => {
  it('空文本 / 缺参考音色 / 配音缺视频', async () => {
    const noText = await TTS.synthesizeSpeech({ kind: 'tts-gen', text: '  ', refVoicePath: refWav });
    expect(noText.ok).toBe(false);
    expect(noText.error).toContain('旁白文本为空');

    const noVoice = await TTS.synthesizeSpeech({ kind: 'tts-gen', text: 'hi', refVoicePath: '' });
    expect(noVoice.ok).toBe(false);
    expect(noVoice.error).toContain('缺少参考音色');

    const noVideo = await TTS.synthesizeSpeech({ kind: 'video-dub', text: 'hi', refVoicePath: refWav });
    expect(noVideo.ok).toBe(false);
    expect(noVideo.error).toContain('缺少输入视频');
  });

  it('参考音色不存在 → 拒绝', async () => {
    const res = await TTS.synthesizeSpeech({
      kind: 'tts-gen',
      text: 'hi',
      refVoicePath: join(tmpHome, 'outputs', 'missing.wav'),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('不存在');
  });
});

describe('translateTtsError / 取消', () => {
  it('旧版 mlxgen 不认子命令 → 升级 + prepare 指引', () => {
    const msg = TTS.translateTtsError('error: invalid choice: tts', {
      prepareHint: 'mlxgen prepare --model cosyvoice3 --path /p',
      packagePath: '/p',
    });
    expect(msg).toContain('uv tool install --upgrade mlx-gen-jzg');
    expect(msg).toContain('prepare --model cosyvoice3');
  });

  it('未准备包 → 指引 prepare;ffmpeg 缺失 → brew install', () => {
    const p = { prepareHint: 'mlxgen prepare --model cosyvoice3 --path /p', packagePath: '/p' };
    expect(TTS.translateTtsError('CosyVoice3 package directory is missing', p)).toContain('未准备');
    expect(TTS.translateTtsError('mlxgen dub needs ffmpeg on PATH', p)).toContain('brew install ffmpeg');
  });

  it('没有任务时取消 → 明确失败(不把「没在跑」当已取消)', () => {
    const r = TTS.cancelTts('nope');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('没有正在进行');
  });
});
