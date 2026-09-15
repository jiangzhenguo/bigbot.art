/**
 * mlxgen Provider — 本地图片生成/编辑引擎(mlx-gen, CLI `mlxgen`)
 * 覆盖:文生图 / 指令编辑 / I2I / Inpaint / Outpaint / 超分
 *
 * 骨架期行为:
 * - check():探测 `mlxgen` 命令(which + --help)
 * - submit:默认 dryRun=true(构造 mlxgen 命令 + 占位);false 时真实调用
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  type Provider,
  type ProviderStatus,
  type ProviderCapabilities,
  type RenderRequest,
  type RenderJobHandle,
  type RenderStatus,
} from '@bigbotart/shared';

const execFileP = promisify(execFile);

const DATA_DIR = process.env.BIGBOTART_HOME ?? join(homedir(), '.bigbotart');

export const MLXGEN_DEFAULTS = {
  bin: 'mlxgen',
  outputDir: process.env.BIGBOTART_MLXGEN_OUTPUTS ?? join(DATA_DIR, 'outputs', 'images'),
};

interface MlXGenProviderOptions {
  bin?: string;
  outputDir?: string;
  dryRun?: boolean;
}

export type { MlXGenProviderOptions };

export class MlXGenProvider implements Provider {
  readonly id = 'mlxgen' as const;
  readonly name = 'mlxgen (MLX 图片)';
  private bin: string;
  private outDir: string;
  private dryRun: boolean;
  private running = new Map<string, ChildProcess>();
  private outPaths = new Map<string, string>();

  constructor(opts: MlXGenProviderOptions = {}) {
    this.bin = opts.bin ?? MLXGEN_DEFAULTS.bin;
    this.outDir = opts.outputDir ?? MLXGEN_DEFAULTS.outputDir;
    this.dryRun = opts.dryRun ?? true;
  }

  async check(): Promise<ProviderStatus> {
    const st = { provider: this.id, installed: false, ready: false } as ProviderStatus;
    try {
      // 探测 PATH 中的 mlxgen
      const { stdout } = await execFileP('sh', ['-lc', `command -v ${this.bin}`], { timeout: 5000 });
      const path = stdout.trim();
      if (!path) {
        st.installHint = '运行 uv tool install --upgrade mlx-gen 安装';
        return st;
      }
      st.installed = true;
      st.installedPath = path;
      const { stdout: help } = await execFileP(path, ['--help'], { timeout: 5000 });
      const ver = /version[^\d]*([\d.]+)/i.exec(help);
      st.version = ver?.[1];
      st.ready = true;
      st.capabilities = await this.capabilities();
    } catch (e) {
      const msg = (e as Error).message;
      if (!/not found|command not found|ENOENT/.test(msg)) st.error = msg;
      st.installHint = '运行 uv tool install --upgrade mlx-gen;模型:mlxgen download --model <id>';
    }
    return st;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      provider: this.id,
      domains: ['image-gen', 'image-edit', 'image-upscale'],
      editModes: ['instruction', 'img2img', 'inpaint', 'outpaint'],
      aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '2:3'],
      models: [
        'AbstractFramework/z-image-turbo-8bit (Z-Image Turbo, 文生图, ~3GB)',
        'qwen-image (Qwen Image, 文生图)',
        'qwen-image-edit (Qwen Image Edit, 指令编辑/mask)',
        'AbstractFramework/flux.2-klein-9b-8bit (多参考编辑/outpaint)',
        'AbstractFramework/seedvr2-3b-8bit (超分修复)',
      ],
      notes: ['图片槽位与视频槽位互斥', '模型文件需 mlxgen download 预下载'],
    };
  }

  async submit(req: RenderRequest): Promise<RenderJobHandle> {
    if (req.slot !== 'image') throw new Error('mlxgen 仅支持图片任务');
    const p = req.params as Record<string, unknown>;
    const kind = (p.kind as string) ?? 'generate';
    const model = String(p.model ?? 'AbstractFramework/z-image-turbo-8bit');
    const taskId = `mlxgen-${kind}-${Date.now()}`;
    const outBase = `${this.outDir}/${req.nodeId}_${taskId}`;
    // 显式记录将执行的命令(dry-run 也构造,便于调试)
    const cmd = ['generate', '--model', model, '--prompt', String(p.prompt ?? '')];
    if (kind === 'generate') {
      cmd.push('--width', String(p.width ?? 768), '--height', String(p.height ?? 768));
      cmd.push('--steps', String(p.steps ?? 24), '--guidance', String(p.guidance ?? 1.0));
      if (Array.isArray(p.seeds) && p.seeds.length) cmd.push('--seed', p.seeds.join(' '));
      cmd.push('--output', `${outBase}.png`);
    } else if (kind === 'upscale') {
      cmd.splice(0, 1, 'upscale');
      cmd.push('--image-path', String(p.inputPath ?? ''), '--resolution', String(p.scale ?? '2x'), '--output', `${outBase}.png`);
    } else {
      // edit:instruction / img2img / inpaint / outpaint
      if (p.inputPath) cmd.push('--image-path', String(p.inputPath));
      if (kind === 'inpaint' && p.maskPath) cmd.push('--mask-path', String(p.maskPath));
      cmd.push('--output', `${outBase}.png`);
    }
    const outPath = `${outBase}.png`;
    (this as unknown as Record<string, unknown>).lastCmd = cmd;
    this.outPaths.set(taskId, outPath);
    if (!this.dryRun) {
      // 真实执行
      const child = spawn(this.bin, cmd, { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stderr.on('data', () => {});
      this.running.set(taskId, child);
    }
    return { providerTaskId: taskId };
  }

  async status(handle: RenderJobHandle): Promise<RenderStatus> {
    const child = this.running.get(handle.providerTaskId);
    if (!child) {
      return { status: 'SUCCEEDED', progress: 1, stage: 'dry-run (未真实推理);命令见日志', resultPath: this.outPaths.get(handle.providerTaskId) };
    }
    if (child.exitCode !== null) {
      return child.exitCode === 0
        ? { status: 'SUCCEEDED', progress: 1, stage: 'done', resultPath: this.outPaths.get(handle.providerTaskId) }
        : { status: 'FAILED', error: `exit ${child.exitCode}` };
    }
    return { status: 'RUNNING', progress: undefined, stage: 'mlxgen 推理中' };
  }

  async cancel(handle: RenderJobHandle): Promise<void> {
    const child = this.running.get(handle.providerTaskId);
    if (child) child.kill('SIGTERM');
    this.running.delete(handle.providerTaskId);
  }
}