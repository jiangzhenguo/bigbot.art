'use strict';

const { spawn } = require('node:child_process');
const { existsSync, statSync } = require('node:fs');
const { join } = require('node:path');

/**
 * 从视频的第一条音轨生成标准 WAV。这里只做本地媒体转码，不触发任何 AI 推理。
 * 使用 CommonJS 是为了让安装到任意数据目录后的单个 .js 文件无需额外 package.json。
 */
async function execute(ctx) {
  const input = ctx.inputs['input-video']?.[0];
  if (!input) throw new Error('缺少 input-video 输入');
  if (!existsSync(input) || !statSync(input).isFile()) throw new Error(`输入视频不存在: ${input}`);

  const format = ctx.parameters.format ?? 'wav';
  if (format !== 'wav') throw new Error(`不支持的音频格式: ${String(format)}`);

  const resultPath = join(ctx.outputDir, 'audio.wav');
  const args = [
    '-y',
    '-i', input,
    '-vn',
    '-map', '0:a:0',
    '-acodec', 'pcm_s16le',
    '-ar', '48000',
    '-ac', '2',
    resultPath,
  ];

  ctx.log('开始提取音轨(16-bit PCM / 48kHz / 立体声)');
  ctx.reportProgress(0, '正在提取音轨');

  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      // 只保留尾部，既够排障，也避免长任务 stderr 无限占用内存。
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });
    child.on('error', (error) => {
      reject(new Error(`无法启动 ffmpeg: ${error.message}`));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-12).join('\n').slice(-4000);
        reject(new Error(`ffmpeg 退出码 ${code ?? '未知'}${tail ? `:\n${tail}` : ''}`));
        return;
      }
      if (!existsSync(resultPath) || !statSync(resultPath).isFile() || statSync(resultPath).size === 0) {
        reject(new Error('ffmpeg 未生成有效音频；请确认输入视频包含音轨'));
        return;
      }
      resolve();
    });
  });

  ctx.reportProgress(100, '音轨提取完成');
  ctx.log('音轨提取完成');
  return { resultPath };
}

module.exports = { execute };
