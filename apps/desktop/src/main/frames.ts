/**
 * FrameTool — 视频取帧(ffmpeg):抽首帧 / 尾帧 PNG
 * P0 #1/#3:上游 shot 跑完后抽尾帧 → 归档为下游镜头 first-frame 参考候选;
 * 也是 shot→image-edit「取帧再编辑」的帧来源。
 *
 * 产物落 ${OUTPUTS_DIR}/frames/ 下(bba-output 协议可读),文件名
 * <视频基名>-<mode>-<毫秒时间戳>.png,多次抽取互不覆盖。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { OUTPUTS_DIR, outputSearchRoots, isUnderRoot } from './assets';

const FRAMES_DIR = join(OUTPUTS_DIR, 'frames');

export interface FrameExtractResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export function extractFrame(
  videoPath: string,
  mode: 'first' | 'last',
): Promise<FrameExtractResult> {
  return new Promise((resolveP) => {
    if (!videoPath) return resolveP({ ok: false, error: '视频路径为空' });
    if (!existsSync(videoPath)) return resolveP({ ok: false, error: '视频文件不存在' });
    // 只允许产物/资产/导出目录下的视频,防任意读
    const roots = outputSearchRoots();
    if (!roots.some((r) => isUnderRoot(videoPath, r))) {
      return resolveP({ ok: false, error: '视频不在允许目录,拒绝取帧' });
    }
    try {
      mkdirSync(FRAMES_DIR, { recursive: true });
    } catch {
      /* 目录已存在/不可建则交给 ffmpeg 报错 */
    }
    const name = basename(videoPath).replace(/\.[^.]+$/, '') || 'frame';
    const out = join(FRAMES_DIR, `${name}-${mode}-${Date.now()}.png`);
    const args =
      mode === 'last'
        // 尾帧:-sseof 从文件末尾回退 0.2s 定位,兼容各封装
        ? ['-y', '-sseof', '-0.2', '-i', videoPath, '-frames:v', '1', out]
        : ['-y', '-i', videoPath, '-frames:v', '1', out];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errAcc = '';
    child.stderr.on('data', (d: Buffer) => (errAcc += d.toString()));
    child.on('close', (code) => {
      if (code === 0 && existsSync(out)) resolveP({ ok: true, path: out });
      else {
        const tail = errAcc.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 200);
        resolveP({ ok: false, error: `ffmpeg exit ${code}: ${tail || '未知错误'}` });
      }
    });
    child.on('error', (e) => resolveP({ ok: false, error: e.message }));
  });
}