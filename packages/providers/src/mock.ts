/**
 * Mock Provider — 离线开发/演示用
 * 任何任务都立即"成功",产出占位文件(PNG 或带纯色帧的 MP4 via ffmpeg 若可用)。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import {
  type Provider,
  type ProviderStatus,
  type ProviderCapabilities,
  type RenderRequest,
  type RenderJobHandle,
  type RenderStatus,
} from '@bigbotart/shared';

const DATA_DIR = process.env.BIGBOTART_HOME ?? join(homedir(), '.bigbotart');

function mockOutDir(): string {
  return process.env.BIGBOTART_MOCK_OUTPUTS
    ?? (process.env.BIGBOTART_H3_OUTPUTS ? join(process.env.BIGBOTART_H3_OUTPUTS, 'mock') : join(DATA_DIR, 'outputs', 'mock'));
}

export class MockProvider implements Provider {
  readonly id = 'mock' as const;
  readonly name = 'Mock (离线演示)';
  private results = new Map<string, string>();

  async check(): Promise<ProviderStatus> {
    return {
      provider: this.id,
      installed: true,
      ready: true,
      capabilities: await this.capabilities(),
      detail: '离线可用的演示引擎,不调用真实模型',
    };
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      provider: this.id,
      domains: ['video', 'image-gen', 'image-edit', 'image-upscale'],
      videoModes: [
        { mode: 'text2video', label: '文生视频' },
        { mode: 'first-frame', label: '首帧控制', refs: ['first-frame'] },
        { mode: 'first-last', label: '首尾帧', refs: ['first-frame', 'last-frame'] },
        { mode: 'ref-image', label: '参考图', refs: ['ref-image'] },
      ],
      editModes: ['instruction', 'img2img', 'inpaint', 'outpaint'],
      tiers: ['preview', 'draft', 'default', 'reference'],
    };
  }

  async submit(req: RenderRequest): Promise<RenderJobHandle> {
    const kind = String((req.params as Record<string, unknown>).kind ?? 'video');
    const id = `mock-${Date.now()}`;
    const path = await this.writePlaceholder(id, kind);
    this.results.set(id, path);
    return { providerTaskId: id };
  }

  async status(handle: RenderJobHandle): Promise<RenderStatus> {
    return {
      status: 'SUCCEEDED',
      progress: 1,
      stage: 'mock done',
      resultPath: this.results.get(handle.providerTaskId),
    };
  }

  async cancel(): Promise<void> {}

  private async writePlaceholder(id: string, kind: string): Promise<string> {
    const OUT_DIR = mockOutDir();
    mkdirSync(OUT_DIR, { recursive: true });
    if (kind === 'video') {
      const path = resolve(OUT_DIR, `${id}.mp4`);
      // 用 ffmpeg 生成 1s 纯色测试视频(带声时加 sine 音频轨,模拟带声直出);异步 spawn 不阻塞主进程
      const ok = await runFfmpegPlaceholder(path, '0x2a3a5c');
      if (!ok) {
        // ffmpeg 不可用时写个文本占位
        writeFileSync(path, JSON.stringify({ mock: true, kind }, null, 2));
      }
      return path;
    }
    // 图片:1x1 PNG
    const path = resolve(OUT_DIR, `${id}.png`);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    writeFileSync(path, png);
    return path;
  }
}

/** 生成 1s 纯色 + 440Hz 音的占位 MP4;ffmpeg 不可用/失败返回 false(调用方写文本占位) */
function runFfmpegPlaceholder(outPath: string, color: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', [
      '-f', 'lavfi', '-i', `color=c=${color}:s=512x512:d=1`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest',
      '-y', outPath,
    ], { stdio: 'ignore' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}