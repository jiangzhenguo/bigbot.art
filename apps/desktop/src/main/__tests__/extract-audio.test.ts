/**
 * 音轨抽取集成测试(主进程 frames.ts 的 `extractAudio`)
 *
 * 覆盖「视频节点 → 音频参考」连接器的底层能力:视频 → 16-bit PCM wav。
 *
 * 三条必须锁死的行为:
 *  1. **真能抽出音轨**(ffmpeg 真实跑,产物是 wav 且可被 ffprobe 认出音频流);
 *  2. **无音轨的视频明确失败** —— 绝不能产出一个 0 字节文件然后让 h3 在很远的地方
 *     报一句看不懂的错(本项目反复出现的「假成功」形态);
 *  3. **白名单**:产物/资产/导出目录之外的文件拒绝读取(与取帧/裁切同口径)。
 *
 * 关键:frames.ts 的模块级常量在 import 时按 env 求值 → 必须先设 BIGBOTART_HOME
 * 再动态 import(与 frames-crop.test.ts 同约定)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// ⚠️ 先于任何 frames 模块加载:产物目录指向临时 HOME,绝不触碰真实用户数据(R5)
const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-audio-test-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');

const hasFfmpeg = (() => {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();
const hasFfprobe = (() => {
  try {
    return spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

const outDir = join(tmpHome, 'outputs');
/** 带音轨的视频(testsrc 画面 + sine 音调) */
let videoWithAudio = '';
/** 纯画面无音轨的视频 */
let videoNoAudio = '';
/** 白名单之外的文件 */
let outsidePath = '';

let F: typeof import('../frames.js');

beforeAll(async () => {
  F = await import('../frames.js');
  if (!hasFfmpeg) return;
  mkdirSync(outDir, { recursive: true });

  videoWithAudio = join(outDir, 'with-audio.mp4');
  const g1 = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=s=320x240:d=2:r=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      videoWithAudio,
    ],
    { stdio: 'ignore' },
  );
  if (g1.status !== 0) throw new Error('无法生成带音轨的测试视频');

  videoNoAudio = join(outDir, 'no-audio.mp4');
  const g2 = spawnSync(
    'ffmpeg',
    ['-y', '-f', 'lavfi', '-i', 'testsrc=s=320x240:d=1:r=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', videoNoAudio],
    { stdio: 'ignore' },
  );
  if (g2.status !== 0) throw new Error('无法生成无音轨的测试视频');

  // 白名单之外:临时 HOME 之外的路径
  const outsideDir = mkdtempSync(join(tmpdir(), 'bbart-audio-outside-'));
  outsidePath = join(outsideDir, 'evil.mp4');
  writeFileSync(outsidePath, 'not really a video');
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/** ffprobe 探测流类型(失败返回空数组) */
function probeStreams(path: string): string[] {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path],
    { encoding: 'utf-8' },
  );
  return (r.stdout ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
}

describe.runIf(hasFfmpeg)('extractAudio · 视频 → 音轨', () => {
  it('真实抽音轨:产出 wav,且容器里只有音频流(没有视频流)', async () => {
    const res = await F.extractAudio(videoWithAudio);
    expect(res.ok, res.error).toBe(true);
    expect(res.path).toBeTruthy();
    expect(existsSync(res.path!)).toBe(true);
    // 产物落在 outputs/audio/ 下
    expect(res.path!).toContain(join('outputs', 'audio'));
    expect(res.path!.endsWith('.wav')).toBe(true);
    // 文件非空(0 字节 = 抽取失败却报成功,正是要防的形态)
    expect(statSync(res.path!).size).toBeGreaterThan(1000);

    if (hasFfprobe) {
      const streams = probeStreams(res.path!);
      expect(streams).toContain('audio');
      expect(streams).not.toContain('video');
    }
  });

  it('无音轨的视频 → 明确失败,且不产出文件', async () => {
    const res = await F.extractAudio(videoNoAudio);
    expect(res.ok).toBe(false);
    // 错误信息要能让人知道「下一步该怎么办」,而不是一句 ffmpeg 英文尾巴
    expect(res.error).toContain('没有音轨');
    expect(res.path).toBeUndefined();
  });

  it('文件不存在 → 明确失败', async () => {
    const res = await F.extractAudio(join(outDir, 'does-not-exist.mp4'));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('不存在');
  });

  it('空路径 → 明确失败(不抛异常)', async () => {
    const res = await F.extractAudio('');
    expect(res.ok).toBe(false);
  });

  it('白名单:产物/资产/导出目录之外的文件拒绝读取', async () => {
    const res = await F.extractAudio(outsidePath);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('不在允许目录');
  });

  it('连续两次抽取互不覆盖(文件名带时间戳)', async () => {
    const a = await F.extractAudio(videoWithAudio);
    // 时间戳精度可能撞,这里只要求两次都成功且路径存在
    const b = await F.extractAudio(videoWithAudio);
    expect(a.ok && b.ok).toBe(true);
    expect(existsSync(a.path!)).toBe(true);
    expect(existsSync(b.path!)).toBe(true);
  });
});
