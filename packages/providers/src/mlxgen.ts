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
  /** 失败诊断:taskId → 累计 stderr 尾部 */
  private stderrs = new Map<string, string>();

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
        'AbstractFramework/z-image-turbo-8bit (Z-Image Turbo, 文生图, ~11GB)',
        'qwen-image (Qwen Image, 文生图)',
        'mlx-community/Qwen-Image-Edit-8bit (Qwen Image Edit 8bit, 指令编辑/mask, ~37.5GB)',
        'AbstractFramework/flux.2-klein-9b-8bit (多参考编辑/outpaint, ~18GB)',
        'AbstractFramework/seedvr2-3b-8bit (超分修复, ~4.7GB)',
      ],
      notes: ['图片槽位与视频槽位互斥', '模型文件需 mlxgen download 预下载'],
    };
  }

  /** 自定义量化仓库 → 基座模型提示(CLI `--base-model`;不给会被误路由成文生图 handler) */
  private static readonly BASE_MODEL_HINTS: Record<string, string> = {
    'mlx-community/Qwen-Image-Edit-8bit': 'Qwen/Qwen-Image-Edit',
  };

  async submit(req: RenderRequest): Promise<RenderJobHandle> {
    if (req.slot !== 'image') throw new Error('mlxgen 仅支持图片任务');
    const p = req.params as Record<string, unknown>;
    const kind = (p.kind as string) ?? 'generate';
    const model = String(p.model ?? 'AbstractFramework/z-image-turbo-8bit');
    const taskId = `mlxgen-${kind}-${Date.now()}`;
    const outBase = `${this.outDir}/${req.nodeId}_${taskId}`;

    // 命令构造对齐真实 mlx-gen CLI(2026-09 静态+实测验证,见 docs/图片生成与编辑能力现状盘点.md 附录):
    // - `--seed` 必须展开为独立参数(`--seed 42 43`),join 成单个 token 会被后端 int 解析拒绝
    // - `upscale` 是无提示词路由,不接受 `--prompt`;`--resolution` 整数=目标短边像素、`2x`=倍率,
    //   检查器存的是数字(2/4),必须转成 `2x/4x`
    // - edit 的 img2img 需 `--i2i-mode latent`(否则被路由成指令编辑);outpaint 需 `--outpaint-padding`
    // - 自定义量化仓库需 `--base-model` 提示(实测:mlx-community/Qwen-Image-Edit-8bit 不给提示会被
    //   误路由成 qwen.generate 文生图,给了才走 qwen.edit 编辑 handler)
    const cmd = ['generate', '--model', model, '--prompt', String(p.prompt ?? '')];
    const baseHint = MlXGenProvider.BASE_MODEL_HINTS[model];
    if (baseHint) cmd.push('--base-model', baseHint);
    const seeds = normalizeSeeds(p.seeds);
    let outPath = `${outBase}.png`;
    if (kind === 'generate') {
      cmd.push('--width', String(p.width ?? 768), '--height', String(p.height ?? 768));
      cmd.push('--steps', String(p.steps ?? 24), '--guidance', String(p.guidance ?? 1.0));
      if (p.negativePrompt) cmd.push('--negative-prompt', String(p.negativePrompt));
      if (seeds.length > 0) {
        cmd.push('--seed');
        for (const s of seeds) cmd.push(String(s));
        // 多 seed 时官方自动按 `_seed_<n>` 追加文件名;登记第一个产物的真实路径,便于 UI 回写预览
        if (seeds.length > 1) outPath = `${outBase}_seed_${seeds[0]}.png`;
      }
      cmd.push('--output', `${outBase}.png`);
    } else if (kind === 'upscale') {
      cmd.splice(0, 1, 'upscale');
      // 去掉 generate 分支遗留的 --prompt(实测:mlxgen upscale 报 unrecognized arguments: --prompt)
      const pi = cmd.indexOf('--prompt');
      if (pi !== -1) cmd.splice(pi, 2);
      const scale = String(p.scale ?? '2x');
      const res = /^\d+$/i.test(scale) ? `${scale}x` : scale; // 数字 → 倍率 'Nx'(裸整数会被当成短边像素)
      cmd.push('--image-path', String(p.inputPath ?? ''), '--resolution', res, '--output', outPath);
    } else {
      // edit:instruction / img2img / inpaint / outpaint(统一走 mlxgen generate 路由)
      if (p.inputPath) cmd.push('--image-path', String(p.inputPath));
      if (kind === 'img2img') {
        cmd.push('--i2i-mode', 'latent');
        // 图像强度(0-1):CLI 要求 (0,1] 区间内数值,0 视为未设置不传
        const st = Number(p.imageStrength);
        if (Number.isFinite(st) && st > 0 && st <= 1) cmd.push('--image-strength', st.toFixed(2));
      }
      if (kind === 'inpaint' && p.maskPath) cmd.push('--mask-path', String(p.maskPath));
      if (kind === 'outpaint') {
        const sides = (p.outpaintSides ?? undefined) as
          | { top?: number; bottom?: number; left?: number; right?: number }
          | undefined;
        if (sides) {
          const pad = `${sides.top ?? 0},${sides.right ?? 0},${sides.bottom ?? 0},${sides.left ?? 0}`;
          if (/\d/.test(pad)) cmd.push('--outpaint-padding', pad);
        }
      }
      cmd.push('--output', outPath);
    }
    (this as unknown as Record<string, unknown>).lastCmd = cmd;
    this.outPaths.set(taskId, outPath);
    if (!this.dryRun) {
      // 真实执行
      const child = spawn(this.bin, cmd, { stdio: ['ignore', 'pipe', 'pipe'] });
      const errAcc: string[] = [];
      child.stderr.on('data', (d: Buffer) => {
        errAcc.push(d.toString());
        this.stderrs.set(taskId, errAcc.join('').slice(-1600));
      });
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
      if (child.exitCode === 0) {
        return { status: 'SUCCEEDED', progress: 1, stage: 'done', resultPath: this.outPaths.get(handle.providerTaskId) };
      }
      const errTail = (this.stderrs.get(handle.providerTaskId) ?? '').split('\n').filter(Boolean).slice(-4).join(' | ').slice(0, 300);
      return { status: 'FAILED', error: `mlxgen exit ${child.exitCode}: ${errTail || '见日志'}` };
    }
    return { status: 'RUNNING', progress: undefined, stage: 'mlxgen 推理中' };
  }

  async cancel(handle: RenderJobHandle): Promise<void> {
    const child = this.running.get(handle.providerTaskId);
    if (child) child.kill('SIGTERM');
    this.running.delete(handle.providerTaskId);
  }
}

/** 归一化 seeds:数组成员 / 单整数 / 逗号或空格分隔字符串 → number[] */
function normalizeSeeds(v: unknown): number[] {
  const arr = Array.isArray(v)
    ? v
    : typeof v === 'number' || typeof v === 'string'
      ? [v]
      : [];
  return arr
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && Number.isInteger(n));
}