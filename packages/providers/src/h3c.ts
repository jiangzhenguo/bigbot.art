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
import { buildH3Args, validateParams, TIER_PRESETS } from './h3c-command.js';
import {
  ProgressTracker,
  splitProgressChunks,
  stallLevel,
  stallMessage,
} from './h3c-progress.js';

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
  /** 真实进度跟踪:taskId → ProgressTracker(解析 stderr 进度行,单调递增 + 停滞判定) */
  private trackers = new Map<string, ProgressTracker>();

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

    // 参数组合防呆(validateParams 统一入口):
    //  ① layers≤40+reuse≥3 → 拒绝
    //  ② 带内嵌音轨的 ref-video + 输出 <2s → 拒绝(h3.c:1146 硬规则,否则入队后才 exit 1)
    //  ③ reuse 配极少步数 → 拒绝提交前的**警告**(与 h3 同名 warning 同口径)
    const issues = validateParams({
      steps: Number(p.steps ?? 30),
      layers: Number(p.layers ?? 50),
      reuse: Number(p.reuse ?? 1),
      frames: Number(p.frames ?? 124),
      seconds: Number(p.seconds ?? 0) > 0 ? Number(p.seconds) : undefined,
      width: Number(p.width ?? 768),
      height: Number(p.height ?? 768),
      refVideo,
      refVideoSilent: p.refVideoSilent === true,
    });
    if (issues.length > 0) {
      throw new Error(`h3c 参数防呆: ${issues.join('; ')}`);
    }

    const outPath = `${this.outDir}/${req.nodeId}_${Date.now()}.mp4`;
    const seconds = Number(p.seconds ?? 0);
    // 🚀 加速 LoRA:主进程 submit-render 已把 accel 解析为 params.modelDir / steps;
    // 这里兼容任何直接调用方带 modelDir 覆盖(未带则用构造时的默认模型)
    const modelDir = String(p.modelDir ?? '') || this.modelDir;
    const args = buildH3Args({
      modelDir,
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
      // 参考视频音轨:节点 data.refVideoSilent 为 true 时改走 --ref-silent-video
      refVideoSilent: p.refVideoSilent === true,
      refAudio,
      ssdStreaming: p.ssdStreaming === true,
    });

    const taskId = `h3c-${Date.now()}`;
    this.outPaths.set(taskId, outPath);
    // 粗估 ETA:按档位 etaMin + 分辨率系数(544²≈1x,576²≈1.7x,704²≈3.3x);
    // 加速模型包(蒸馏)省时:4 步 ≈×0.2,8 步 ≈×0.35(手册 §3.1 实测);
    // ⚠️ 风格包(kind='style',mystic 等)换的是画风不是速度 —— ETA 不打折,
    //    否则用户会以为「选了风格包还变快了」,实际步数没变、耗时与基础模型相同。
    const tier = String(p.tier ?? 'default') as keyof typeof TIER_PRESETS;
    const baseEtaMin = TIER_PRESETS[tier]?.etaMin ?? 15;
    const areaFactor = Math.max(0.5, (Number(p.width ?? 544) * Number(p.height ?? 544)) / (544 * 544));
    const accel = (p.accel ?? undefined) as { enabled?: boolean; steps?: number; kind?: string } | undefined;
    const accelOn = accel?.enabled === true && !!modelDir && accel?.kind !== 'style';
    const accelFactor = accelOn ? (accel?.steps === 4 ? 0.2 : 0.35) : 1;
    const etaSec = Math.round(baseEtaMin * 60 * Math.sqrt(areaFactor) * accelFactor);
    this.progress.set(taskId, { startedAt: Date.now(), etaSec });
    if (this.dryRun) {
      // 骨架期:不真实推理,写可播放占位 MP4(异步 spawn,不阻塞主进程),便于 UI 预览闭环
      mkdirSync(this.outDir, { recursive: true });
      const ok = await runFfmpegPlaceholder(outPath);
      if (!ok) {
        // ffmpeg 不可用:写文本占位,不影响队列/预览闭环
        writeFileSync(outPath, JSON.stringify({ dryRun: true, nodeId: req.nodeId }, null, 2));
      }
      this.running.set(taskId, 'dryrun' as unknown as ChildProcess);
      return { providerTaskId: taskId };
    }
    // 真实执行
    // cwd 必须 = h3 二进制所在目录:shader 解析依赖 cwd(H3_USAGE §2,否则立即 exit 1)
    //
    // ⚠️ 进度在 **stderr**,不在 stdout(h3.c main.c:168 `fprintf(stderr, "\r%-25s %4d/%-4d", ...)`)。
    //    旧实现把 stdout 当进度源、stderr 只攒错误尾巴 —— 于是进度数据一直从手里流过却被丢掉,
    //    进度条只能靠时间估算(elapsed/etaSec),会出现「爬到 99% 干等」和「卡死却显示正常」两种假象。
    //    stdout 仍然丢弃(stdout 的 \r 覆盖式输出不消费会背压死锁,H3_USAGE §5.2);
    //    stderr 必须持续消费(既拿真实进度、也保留错误尾部诊断)。
    const child = spawn(this.bin, args, { cwd: dirname(this.bin), stdio: ['ignore', 'ignore', 'pipe'] });
    const tracker = new ProgressTracker();
    this.trackers.set(taskId, tracker);
    let errAcc = '';
    let errTail = ''; // 未完成的行尾(进度行是 \r 覆盖式,必须按行切干净)
    let lastLog = 0;
    /** 处理一批已切分好的片段:进度行喂 tracker,其余留作错误诊断 */
    const consume = (parts: string[]) => {
      for (const raw of parts) {
        const ev = tracker.pushLine(raw);
        if (ev) {
          // 调试日志:节流 1s,只推真实进度行(避免刷屏)
          const now = Date.now();
          if (this.onLog && now - lastLog > 1000) {
            lastLog = now;
            this.onLog(`${ev.phase} ${ev.done}/${ev.total}`);
          }
        } else if (raw.trim()) {
          // 非进度行 = 真正的日志/错误,保留尾部供失败诊断
          errAcc = (errAcc + raw + '\n').slice(-2000);
          this.stderrs.set(taskId, errAcc);
        }
      }
    };
    child.stderr.on('data', (d: Buffer) => {
      const text = errTail + d.toString();
      const [parts, tail] = splitProgressChunks(text);
      errTail = tail;
      consume(parts);
    });
    // 进程结束时冲刷**最后一个片段**:h3 的进度行以 `\r` 分隔,最后一行之后
    // 可能没有换行符(尤其被 kill / 异常退出时),不冲刷就会丢掉最后一条进度
    // (实测:少了末尾的 `FFmpeg 124/124`,总进度停在 95% 而非 100%)。
    child.on('close', () => {
      if (errTail.trim()) {
        consume([errTail]);
        errTail = '';
      }
    });
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
    // 真实进度优先:解析自 h3 stderr 的阶段进度行(单调递增),附带停滞判定。
    // 不再用 elapsed/etaSec 的估算 —— 那与引擎实际进度无关,会「爬到 99% 干等」
    // 且在卡死时仍显示正常(实测:9 分钟、CPU 仅 42 秒的僵死任务,估算进度条一路照爬)。
    const tracker = this.trackers.get(handle.providerTaskId);
    if (tracker && tracker.stageText) {
      const stalled = tracker.stalledFor();
      const level = stallLevel(stalled, true);
      const stallNote = stallMessage(level, tracker.stageText, stalled);
      // 进度封顶 0.99:最后的收尾(落盘/编码)没进度行,别让 UI 提前显示 100%
      const pct = Math.min(0.99, tracker.progress);
      return {
        status: 'RUNNING',
        progress: Number(pct.toFixed(3)),
        stage: stallNote ?? `h3 · ${tracker.stageText}`,
      };
    }
    // 还没解析到任何进度行:可能仍在加载权重 / 编译 Metal shader(首跑可达 30 分钟)。
    // 用已运行时长给一个诚实的说明,而不是编造百分比。
    const est = this.progress.get(handle.providerTaskId);
    if (est) {
      const elapsedMin = Math.round((Date.now() - est.startedAt) / 60000);
      const hint = elapsedMin >= 3
        ? '(仍无进度行:可能在加载权重或编译 Metal shader,首跑较慢;持续无输出请留意)'
        : '(正在启动…)';
      return { status: 'RUNNING', progress: undefined, stage: `h3 准备中 · 已 ${elapsedMin} 分钟 ${hint}` };
    }
    return { status: 'RUNNING', progress: undefined, stage: 'h3 推理中(可数分钟)' };
  }

  async cancel(handle: RenderJobHandle): Promise<void> {
    const child = this.running.get(handle.providerTaskId);
    if (child && child !== ('dryrun' as unknown)) {
      child.kill('SIGTERM');
      // h3 结尾会派生 ffmpeg 做编码;尽力把它的直接子进程(如 ffmpeg)也清掉,
      // 避免取消后残留编码进程继续写几秒(清理失败不影响主体取消)
      const pid = child.pid;
      if (pid) {
        try {
          const out = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf-8', timeout: 1500 });
          if (out.status === 0 && out.stdout) {
            for (const l of out.stdout.split('\n')) {
              const p = Number(l.trim());
              if (Number.isFinite(p) && p > 0) {
                try {
                  process.kill(p, 'SIGTERM');
                } catch {
                  /* 已退出则忽略 */
                }
              }
            }
          }
        } catch {
          /* pgrep 不可用则只杀主体 */
        }
      }
    }
    this.running.delete(handle.providerTaskId);
    this.trackers.delete(handle.providerTaskId);
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

/** Dry-run 占位 MP4(纯色 512² + 440Hz 音轨):异步 ffmpeg,避免 spawnSync 阻塞主进程 */
function runFfmpegPlaceholder(outPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', [
      '-f', 'lavfi', '-i', 'color=c=0x3a4a6c:s=512x512:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest',
      '-y', outPath,
    ], { stdio: 'ignore' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}