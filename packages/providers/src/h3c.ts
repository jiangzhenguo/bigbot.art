/**
 * h3c Provider — h3.c(MiniMax-H3)视频引擎
 * 已确认:"Provider 封装,后台托管";带声直出(h3 MP4 内嵌音轨)。
 *
 * 骨架期行为:
 * - check():真实探测(--info)读 GPU/Metal/模型完整性
 * - buildArgs():真实构造 CLI 参数(见 h3c-command.ts)
 * - 执行:默认 dryRun=true(生成命令 + 占位结果,不做 144GB 推理);
 *   设 dryRun=false 会真实 spawn h3(慢,需模型目录就绪)
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  type Provider,
  type ProviderStatus,
  type ProviderCapabilities,
  type RenderRequest,
  type RenderJobHandle,
  type RenderStatus,
} from '@bigbotart/shared';
import { buildH3Args, validateTier, TIER_PRESETS } from './h3c-command.js';

const DATA_DIR = process.env.BIGBOTART_HOME ?? join(homedir(), '.bigbotart');

export const H3C_DEFAULTS = {
  binaryPath: process.env.BIGBOTART_H3_BIN ?? '/Users/jiangzhenguo/ai/h3/h3.c/h3',
  modelDir: process.env.BIGBOTART_H3_MODEL ?? '/Users/jiangzhenguo/ai/h3/MiniMax-H3',
  outputDir: process.env.BIGBOTART_H3_OUTPUTS ?? join(DATA_DIR, 'outputs'),
};

interface H3cProviderOptions {
  binaryPath?: string;
  modelDir?: string;
  outputDir?: string;
  /** 默认 true:只生成命令与占位结果;false 时真实 spawn h3 */
  dryRun?: boolean;
  /** 调试模式:h3 stdout 进度行(\r 覆盖式)实时回调(节流 1s);不设则 stdout 丢弃 */
  onLog?: (line: string) => void;
}

export type { H3cProviderOptions };

export class H3cProvider implements Provider {
  readonly id = 'h3c' as const;
  readonly name = 'h3.c (MiniMax-H3)';
  private bin: string;
  private modelDir: string;
  private outDir: string;
  private dryRun: boolean;
  private onLog?: (line: string) => void;
  private running = new Map<string, ChildProcess>();
  private outPaths = new Map<string, string>();
  /** 粗估进度:taskId → { startedAt, etaSec } */
  private progress = new Map<string, { startedAt: number; etaSec: number }>();
  /** 失败诊断:taskId → 累计 stderr(尾部) */
  private stderrs = new Map<string, string>();

  constructor(opts: H3cProviderOptions = {}) {
    this.bin = opts.binaryPath ?? H3C_DEFAULTS.binaryPath;
    this.modelDir = opts.modelDir ?? H3C_DEFAULTS.modelDir;
    this.outDir = opts.outputDir ?? H3C_DEFAULTS.outputDir;
    this.dryRun = opts.dryRun ?? true;
    this.onLog = opts.onLog;
  }

  async check(): Promise<ProviderStatus> {
    const st = {
      provider: this.id,
      installed: existsSync(this.bin),
      ready: false,
      installedPath: this.bin,
    } as ProviderStatus;
    if (!st.installed) {
      st.error = `未找到 h3 二进制: ${this.bin}`;
      st.installHint = '在 h3.c 仓库执行 make -j8 编译;或将二进制路径配到设置页';
      return st;
    }
    // --info 真实探测
    try {
      const info = await runAndCapture(this.bin, ['--info', '-d', this.modelDir], 20_000, dirname(this.bin));
      const gpuMatch = /Device:\s*(.+)/.exec(info);
      const memMatch = /physical memory\s+([\d.]+)\s*GiB/.exec(info);
      st.version = 'h3-metal 0.1.x';
      st.ready = true;
      const gpu = gpuMatch?.[1] ?? '?';
      const mem = memMatch?.[1] ?? '?';
      st.detail = `GPU ${gpu} · ${mem} GiB`;
      st.capabilities = await this.capabilities();
      if (!existsSync(this.modelDir)) {
        st.ready = false;
        st.error = `模型目录不存在: ${this.modelDir}`;
      }
    } catch (e) {
      st.error = `探测失败: ${(e as Error).message}`;
    }
    return st;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      provider: this.id,
      domains: ['video'],
      videoModes: [
        { mode: 'text2video', label: '文生视频' },
        { mode: 'first-frame', label: '首帧控制', refs: ['first-frame'] },
        { mode: 'last-frame', label: '尾帧控制', refs: ['last-frame'] },
        { mode: 'first-last', label: '首尾帧 (FL2VA)', refs: ['first-frame', 'last-frame'] },
        { mode: 'ref-image', label: '参考图 (Ref2VA)', refs: ['ref-image'] },
      ],
      tiers: ['preview', 'draft', 'default', 'reference'],
      models: ['MiniMax-H3 (BF16 144GB, local)'],
      notes: ['视频槽位独占;首次 Metal shader 编译约 30 分钟', '带声直出:MP4 内嵌同步音轨'],
    };
  }

  async submit(req: RenderRequest): Promise<RenderJobHandle> {
    if (req.slot !== 'video') throw new Error('h3c 仅支持视频任务');
    const p = req.params as Record<string, unknown>;
    const refs = req.references ?? [];
    const first = refs.find((r) => r.role === 'first-frame');
    const last = refs.find((r) => r.role === 'last-frame');
    const refImgs = refs.filter((r) => r.role === 'ref-image').map((r) => r.localPath);
    const refVideo = refs.find((r) => r.role === 'ref-video')?.localPath;
    const refAudio = refs.find((r) => r.role === 'ref-audio')?.localPath;

    const issues = validateTier({
      steps: Number(p.steps ?? 30),
      layers: Number(p.layers ?? 50),
      reuse: Number(p.reuse ?? 1),
    });
    if (issues.length > 0) {
      // 骨架期防呆:发现危险组合抛错(或自动回退,这里抛错让上层感知)
      throw new Error(`h3c 参数防呆: ${issues.join('; ')}`);
    }

    const outPath = `${this.outDir}/${req.nodeId}_${Date.now()}.mp4`;
    const seconds = Number(p.seconds ?? 0);
    const args = buildH3Args({
      modelDir: this.modelDir,
      prompt: String(p.prompt ?? ''),
      outputPath: outPath,
      width: Number(p.width ?? 768),
      height: Number(p.height ?? 768),
      seconds: seconds > 0 ? seconds : undefined,
      frames: Number(p.frames ?? 124),
      steps: Number(p.steps ?? 30),
      layers: Number(p.layers ?? 50),
      reuse: Number(p.reuse ?? 1),
      seed: Number(p.seed ?? 42),
      firstFrame: first?.localPath,
      lastFrame: last?.localPath,
      refImages: refImgs,
      refVideo,
      refAudio,
    });

    const taskId = `h3c-${Date.now()}`;
    this.outPaths.set(taskId, outPath);
    // 粗估 ETA:按档位 etaMin + 分辨率系数(544²≈1x,576²≈1.7x,704²≈3.3x)
    const tier = String(p.tier ?? 'default') as keyof typeof TIER_PRESETS;
    const baseEtaMin = TIER_PRESETS[tier]?.etaMin ?? 15;
    const areaFactor = Math.max(0.5, (Number(p.width ?? 544) * Number(p.height ?? 544)) / (544 * 544));
    const etaSec = Math.round(baseEtaMin * 60 * Math.sqrt(areaFactor));
    this.progress.set(taskId, { startedAt: Date.now(), etaSec });
    if (this.dryRun) {
      // 骨架期:不真实推理,写可播放占位 MP4,便于 UI 预览闭环
      mkdirSync(this.outDir, { recursive: true });
      const { status } = spawnSync('ffmpeg', [
        '-f', 'lavfi', '-i', 'color=c=0x3a4a6c:s=512x512:d=1',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest',
        '-y', outPath,
      ], { stdio: 'ignore' });
      if (status !== 0) {
        writeFileSync(outPath, JSON.stringify({ dryRun: true, nodeId: req.nodeId }, null, 2));
      }
      this.running.set(taskId, 'dryrun' as unknown as ChildProcess);
      return { providerTaskId: taskId };
    }
    // 真实执行
    // cwd 必须 = h3 二进制所在目录:shader 解析依赖 cwd(H3_USAGE §2,否则立即 exit 1)
    // stdout:默认 ignore(进度条 \r 覆盖式,pipe 不消费会背压死锁 H3_USAGE §5.2);
    //         调试模式(onLog)时改 pipe 实时解析进度行推送,节流 1s
    const withStdout = !!this.onLog;
    const child = withStdout
      ? spawn(this.bin, args, { cwd: dirname(this.bin), stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(this.bin, args, { cwd: dirname(this.bin), stdio: ['ignore', 'ignore', 'pipe'] });
    let errAcc = '';
    child.stderr.on('data', (d: Buffer) => {
      errAcc = (errAcc + d.toString()).slice(-2000);
      this.stderrs.set(taskId, errAcc);
    });
    if (withStdout && child.stdout) {
      let buf = '';
      let lastPush = 0;
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        const parts = buf.split(/[\r\n]+/);
        buf = parts.pop() ?? '';
        const line = parts[parts.length - 1] ?? '';
        const now = Date.now();
        if (line.trim() && now - lastPush > 1000) {
          lastPush = now;
          this.onLog?.(line.trim());
        }
      });
    }
    this.stderrs.set(taskId, '');
    this.running.set(taskId, child);
    return { providerTaskId: taskId };
  }

  async status(handle: RenderJobHandle): Promise<RenderStatus> {
    const child = this.running.get(handle.providerTaskId);
    if (!child) {
      return { status: 'SUCCEEDED', resultPath: this.outPaths.get(handle.providerTaskId), stage: 'dry-run' };
    }
    if (child === ('dryrun' as unknown)) {
      return {
        status: 'SUCCEEDED',
        progress: 1,
        stage: 'dry-run (未真实推理 · 占位片)',
        resultPath: this.outPaths.get(handle.providerTaskId),
      };
    }
    if (child.exitCode !== null) {
      const errTail = this.stderrs.get(handle.providerTaskId) ?? '';
      return child.exitCode === 0
        ? { status: 'SUCCEEDED', progress: 1, stage: 'done', resultPath: this.outPaths.get(handle.providerTaskId) }
        : { status: 'FAILED', error: `h3 exit ${child.exitCode}: ${errTail.split('\n').filter(Boolean).slice(-4).join(' | ').slice(0, 300) || '见日志'}` };
    }
    // 粗估进度(不超过 99%):elapsed / etaSec
    const est = this.progress.get(handle.providerTaskId);
    if (est) {
      const pct = Math.min(0.99, (Date.now() - est.startedAt) / (est.etaSec * 1000));
      const remainMin = Math.max(0, Math.round((est.etaSec - (Date.now() - est.startedAt) / 1000) / 60));
      return {
        status: 'RUNNING',
        progress: Number(pct.toFixed(3)),
        stage: `h3 推理中 · 约剩 ${remainMin} 分钟(粗估)`,
      };
    }
    return { status: 'RUNNING', progress: undefined, stage: 'h3 推理中(可数分钟)' };
  }

  async cancel(handle: RenderJobHandle): Promise<void> {
    const child = this.running.get(handle.providerTaskId);
    if (child && child !== ('dryrun' as unknown)) child.kill('SIGTERM');
    this.running.delete(handle.providerTaskId);
  }
}

function runAndCapture(cmd: string, args: string[], timeoutMs: number, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timeout ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`exit ${code}: ${err.slice(0, 300)}`));
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}