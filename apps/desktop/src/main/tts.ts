/**
 * Tts — CosyVoice3 语音合成 / 视频配音主进程模块
 *
 * 对应两个画布节点:
 *   - `tts-gen`   文生语音:文本 + 参考音色 → wav
 *   - `video-dub` 视频配音:成片 + 参考音色 + 旁白 → 带旁白 mp4(画面 stream-copy)
 *
 * 引擎事实(~/ai/mlx-gen/docs/cosyvoice3-tts.md,2026-10):
 *   - `mlxgen tts` / `mlxgen dub` 是**顶层子命令**,不是 `mlxgen generate` 的路由;
 *   - CosyVoice3 没有预设音色,`--ref-audio` 必填(3–30 秒干净人声);
 *   - 推理跑在 prepared package 的**隔离 venv**(Python 3.11 + torch),mlx-gen 主环境不加载 torch;
 *   - `--json-events` 在 stdout 打 JSONL runtime events(phase: loading/loaded/synthesizing/complete/failed)。
 *
 * 与 video-post.ts 同族(本地长任务):
 *   - 不进 RenderQueue,全局串行链(CPU 合成已吃满,并行只会互相拖垮);
 *   - AbortSignal 取消(检查器「取消」/ 主进程退出);
 *   - 进度按引擎事件 + 心跳回调,驱动节点 badge / 检查器进度条;
 *   - 产物落 ${OUTPUTS_DIR}/dub/(bba-output 协议可读)。
 *
 * R2 红线:默认 dry-run(BIGBOTART_DRYRUN !== '0')只构造命令,**绝不 spawn**,
 * 也**绝不产出占位文件** —— 返回 `dryRun:true` 的诚实失败,由 UI 明说「已跳过真实合成」。
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type {
  TtsRequest,
  TtsResult,
  TtsTooling,
  TtsProgressEvent,
  TtsVoiceMode,
} from '@bigbotart/shared';
import { OUTPUTS_DIR, ffmpegReadRoots, isUnderRoot } from './assets';
import { extractAudio } from './frames';
import { probeVideo, resolveMlxgenBin } from './video-post';

const HOME = homedir();

/** 配音/合成产物目录(可用 `BIGBOTART_TTS_OUTPUTS` 覆盖;缺省 ~/.bigbotart/outputs/dub) */
export function ttsOutputsDir(): string {
  return process.env.BIGBOTART_TTS_OUTPUTS?.trim() || join(OUTPUTS_DIR, 'dub');
}

/** 视频扩展名(参考音色若给的是「带人声的短视频」,提交前抽音轨) */
const VIDEO_EXT_RE = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;

/* ────────────────────────── 准备包探测 ────────────────────────── */

/**
 * prepared package 候选目录(按优先级):
 *   1. `BIGBOTART_COSYVOICE3_PATH`(显式覆盖)
 *   2. 仓库自带的开发包 `~/ai/mlx-gen/out/cosyvoice3`(本机已知路径)
 *   3. `MFLUX_CACHE_DIR/cosyvoice3`(引擎 `mlxgen prepare` 的默认落点)
 *   4. macOS 下 platformdirs 的默认缓存 `~/Library/Caches/mflux/cosyvoice3`
 *   5. `~/models/cosyvoice3`(手工放置)
 */
export function cosyVoice3PackageCandidates(env: NodeJS.ProcessEnv = process.env, home = HOME): string[] {
  const out: string[] = [];
  const override = env.BIGBOTART_COSYVOICE3_PATH?.trim();
  if (override) out.push(override);
  out.push(join(home, 'ai', 'mlx-gen', 'out', 'cosyvoice3'));
  const cache = env.MFLUX_CACHE_DIR?.trim();
  out.push(join(cache || join(home, 'Library', 'Caches', 'mflux'), 'cosyvoice3'));
  out.push(join(cache || join(home, '.cache', 'mlx-flux'), 'cosyvoice3'));
  out.push(join(home, 'models', 'cosyvoice3'));
  return [...new Set(out)];
}

/** 包结构是否完整:model/ + runtime/ + venv/bin/python + manifest.json */
export function isCosyVoice3PackageReady(
  dir: string,
  exists: (p: string) => boolean = (p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  },
): boolean {
  if (!dir) return false;
  return (
    exists(join(dir, 'manifest.json')) &&
    exists(join(dir, 'model')) &&
    exists(join(dir, 'runtime')) &&
    (exists(join(dir, 'venv', 'bin', 'python')) || exists(join(dir, 'venv', 'Scripts', 'python.exe')))
  );
}

/**
 * Qwen3-TTS VoiceDesign prepared package 候选目录(2026-11 新增):
 *   1. `BIGBOTART_QWEN3_TTS_PATH`(显式覆盖)
 *   2. 仓库自带开发包 `~/ai/mlx-gen/out/qwen3-tts-voice-design`
 *   3. `MFLUX_CACHE_DIR/qwen3-tts-voice-design`
 *   4. macOS 默认缓存 `~/Library/Caches/mflux/qwen3-tts-voice-design`
 *   5. `~/models/qwen3-tts-voice-design`
 *
 * 与 CosyVoice3 不同:Qwen3-TTS 是纯 MLX(mlx-audio),包里没有 runtime/ 与 venv/,
 * 只有 `model/` + `manifest.json`,所以就绪判定也短一截。
 */
export function qwen3TtsPackageCandidates(env: NodeJS.ProcessEnv = process.env, home = HOME): string[] {
  const out: string[] = [];
  const override = env.BIGBOTART_QWEN3_TTS_PATH?.trim();
  if (override) out.push(override);
  out.push(join(home, 'ai', 'mlx-gen', 'out', 'qwen3-tts-voice-design'));
  const cache = env.MFLUX_CACHE_DIR?.trim();
  out.push(join(cache || join(home, 'Library', 'Caches', 'mflux'), 'qwen3-tts-voice-design'));
  out.push(join(cache || join(home, '.cache', 'mlx-flux'), 'qwen3-tts-voice-design'));
  out.push(join(home, 'models', 'qwen3-tts-voice-design'));
  return [...new Set(out)];
}

/** Qwen3-TTS 包是否完整:manifest.json + model/ + 真权重(单文件或分片 index) */
export function isQwen3TtsPackageReady(
  dir: string,
  exists: (p: string) => boolean = (p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  },
): boolean {
  if (!dir) return false;
  if (!exists(join(dir, 'manifest.json')) || !exists(join(dir, 'model'))) return false;
  return (
    exists(join(dir, 'model', 'model.safetensors')) ||
    exists(join(dir, 'model', 'model.safetensors.index.json')) ||
    exists(join(dir, 'model', 'weights.safetensors'))
  );
}

function defaultWhich(bin: string): string | undefined {
  try {
    const out = execFileSync('sh', ['-lc', `command -v ${bin}`], { encoding: 'utf-8', timeout: 5000 }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * CosyVoice3 就绪探测(检查器徽标 / 设置页 / 提交前防呆;不触发任何真实推理)。
 * 失败时给出**可照抄**的 prepare 命令(设计文档 §5.4 的探测顺序)。
 */
export function probeTtsTooling(deps?: {
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
  which?: (bin: string) => string | undefined;
  resolveMlxgen?: () => string | undefined;
}): TtsTooling {
  const env = deps?.env ?? process.env;
  const exists =
    deps?.exists ??
    ((p: string) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    });
  const which = deps?.which ?? defaultWhich;
  const mlxgenPath = deps?.resolveMlxgen ? deps.resolveMlxgen() : resolveMlxgenBin();
  const mlxgen = Boolean(mlxgenPath);
  const ffmpeg = Boolean(which('ffmpeg'));

  const candidates = cosyVoice3PackageCandidates(env, HOME);
  const ready = candidates.find((dir) => isCosyVoice3PackageReady(dir, exists));
  const existing = ready ?? candidates.find((dir) => exists(dir));
  const packagePath = existing ?? candidates[1] ?? candidates[0];

  const vdCandidates = qwen3TtsPackageCandidates(env, HOME);
  const vdReady = vdCandidates.find((dir) => isQwen3TtsPackageReady(dir, exists));
  const vdExisting = vdReady ?? vdCandidates.find((dir) => exists(dir));
  const voiceDesignPackagePath = vdExisting ?? vdCandidates[1] ?? vdCandidates[0];

  const missing: string[] = [];
  if (!mlxgen) missing.push('mlxgen 未安装(需含 tts/dub/voice-design 子命令,uv tool install --upgrade mlx-gen-jzg)');
  if (!ready) missing.push(`CosyVoice3 prepared package 未就绪(${packagePath})`);
  if (!vdReady) missing.push(`Qwen3-TTS prepared package 未就绪(${voiceDesignPackagePath})`);
  if (!ffmpeg) missing.push('ffmpeg 未安装(配音混音 / 参考视频抽音轨需要)');

  return {
    mlxgen,
    mlxgenPath,
    packagePath,
    packageReady: Boolean(ready),
    voiceDesignPackagePath,
    voiceDesignReady: Boolean(vdReady),
    ffmpeg,
    missing,
    prepareHint: `mlxgen prepare --model cosyvoice3 --path ${packagePath}`,
    voiceDesignPrepareHint: `mlxgen prepare --model qwen3-tts-voice-design --path ${voiceDesignPackagePath}`,
  };
}

/* ────────────────────────── 命令构造(纯函数)────────────────────────── */

/** 中文旁白时长粗估(秒):约 4 字/秒(CosyVoice3 中文语速实测 ~3.6 字/秒,留一点余量) */
export function estimateAudioSeconds(text: string): number {
  const chars = String(text ?? '').replace(/\s/g, '').length;
  return Math.max(1.5, Math.round((chars / 4) * 10) / 10);
}

/** 引擎自动判定模式(instruct 优先于 refText),用于 UI 回显与结果回执 */
export function resolveTtsMode(req: Pick<TtsRequest, 'refText' | 'instruct'>): 'instruct2' | 'zero_shot' | 'cross_lingual' {
  if (String(req.instruct ?? '').trim()) return 'instruct2';
  if (String(req.refText ?? '').trim()) return 'zero_shot';
  return 'cross_lingual';
}

/**
 * 音色来源判定:
 *  - 显式 `voiceMode` 优先(UI 模式开关 / Agent 明确指定);
 *  - 兼容老请求:只给了音色描述/profile 没给 voiceMode → 按 design;
 *  - 其余一律 clone(CosyVoice3,含示例音色回落)。
 */
export function resolveVoiceMode(
  req: Pick<TtsRequest, 'voiceMode' | 'voiceDescription' | 'voiceProfile'>,
): TtsVoiceMode {
  if (req.voiceMode === 'design') return 'design';
  if (req.voiceMode === 'clone') return 'clone';
  return String(req.voiceDescription ?? '').trim() || String(req.voiceProfile ?? '').trim() ? 'design' : 'clone';
}

/** design 模式的音色描述(profile 优先:profile 由引擎解析成固定描述) */
function voiceDesignSelector(req: TtsRequest): { profile?: string; description?: string } {
  const profile = String(req.voiceProfile ?? '').trim();
  const description = String(req.voiceDescription ?? '').trim();
  return profile ? { profile } : { description };
}

/** 公共 TTS 参数(tts 与 dub 共用的那一段) */
function commonVoiceArgs(
  req: TtsRequest,
  opts: { packagePath: string; text: string },
): string[] {
  const args = [
    '--model-path',
    opts.packagePath,
    // 用 `--text=` 形式:旁白正文可能以 - 开头,分开传会被 argparse 当成选项
    `--text=${opts.text}`,
    '--ref-audio',
    String(req.refVoicePath),
    '--speed',
    String(Number.isFinite(Number(req.speed)) ? Number(req.speed) : 1),
    '--seed',
    String(Number.isFinite(Number(req.seed)) ? Math.trunc(Number(req.seed)) : 42),
    '--json-events',
    '--metadata',
  ];
  const refText = String(req.refText ?? '').trim();
  if (refText) args.push('--ref-text', refText);
  const instruct = String(req.instruct ?? '').trim();
  if (instruct) args.push('--instruct', instruct);
  return args;
}

/** 文生语音命令:`mlxgen tts ...` */
export function buildTtsArgs(
  req: Pick<TtsRequest, 'text' | 'refVoicePath' | 'refText' | 'instruct' | 'speed' | 'seed'>,
  opts: { packagePath: string; outputPath: string },
): string[] {
  return [
    'tts',
    ...commonVoiceArgs(req as TtsRequest, { packagePath: opts.packagePath, text: String(req.text ?? '').trim() }),
    '--output',
    opts.outputPath,
  ];
}

/** 视频配音命令:`mlxgen dub ...`(画面 stream-copy,只重编码音轨) */
export function buildDubArgs(
  req: Pick<
    TtsRequest,
    | 'text'
    | 'refVoicePath'
    | 'inputVideoPath'
    | 'refText'
    | 'instruct'
    | 'speed'
    | 'seed'
    | 'mixMode'
    | 'origVolume'
    | 'ttsVolume'
    | 'keepWav'
  >,
  opts: { packagePath: string; outputPath: string },
): string[] {
  const mixMode = req.mixMode === 'mix' ? 'mix' : 'replace';
  const args = [
    'dub',
    '--video-path',
    String(req.inputVideoPath ?? ''),
    ...commonVoiceArgs(req as TtsRequest, { packagePath: opts.packagePath, text: String(req.text ?? '').trim() }),
    '--output',
    opts.outputPath,
    '--mode',
    mixMode,
    '--orig-volume',
    String(Number.isFinite(Number(req.origVolume)) ? Number(req.origVolume) : 0.15),
    '--tts-volume',
    String(Number.isFinite(Number(req.ttsVolume)) ? Number(req.ttsVolume) : 1),
  ];
  if (req.keepWav) args.push('--keep-wav');
  return args;
}

/** 文生语音(文字设计音色)命令:`mlxgen voice-design ...`(Qwen3-TTS,纯 MLX) */
export function buildVoiceDesignArgs(
  req: Pick<
    TtsRequest,
    'text' | 'voiceDescription' | 'voiceProfile' | 'language' | 'seed' | 'temperature'
  >,
  opts: { packagePath: string; outputPath: string },
): string[] {
  const { profile, description } = voiceDesignSelector(req as TtsRequest);
  const args = [
    'voice-design',
    '--model-path',
    opts.packagePath,
    // `--text=` 形式:正文可能以 - 开头
    `--text=${String(req.text ?? '').trim()}`,
    '--seed',
    String(Number.isFinite(Number(req.seed)) ? Math.trunc(Number(req.seed)) : 42),
  ];
  if (profile) args.push('--voice-profile', profile);
  else args.push('--voice', description ?? '');
  const language = String(req.language ?? '').trim();
  if (language) args.push('--language', language);
  if (Number.isFinite(Number(req.temperature)) && String(req.temperature ?? '').trim() !== '') {
    args.push('--temperature', String(Number(req.temperature)));
  }
  args.push('--output', opts.outputPath, '--json-events', '--metadata');
  return args;
}

/** 视频配音(文字设计音色)命令:`mlxgen dub --voice-design / --voice-profile ...` */
export function buildDubVoiceDesignArgs(
  req: Pick<
    TtsRequest,
    | 'text'
    | 'inputVideoPath'
    | 'voiceDescription'
    | 'voiceProfile'
    | 'language'
    | 'seed'
    | 'temperature'
    | 'mixMode'
    | 'origVolume'
    | 'ttsVolume'
    | 'keepWav'
  >,
  opts: { packagePath: string; outputPath: string },
): string[] {
  const { profile, description } = voiceDesignSelector(req as TtsRequest);
  const args = [
    'dub',
    '--video-path',
    String(req.inputVideoPath ?? ''),
    '--voice-model-path',
    opts.packagePath,
    `--text=${String(req.text ?? '').trim()}`,
    '--seed',
    String(Number.isFinite(Number(req.seed)) ? Math.trunc(Number(req.seed)) : 42),
  ];
  if (profile) args.push('--voice-profile', profile);
  else args.push('--voice-design', description ?? '');
  const language = String(req.language ?? '').trim();
  if (language) args.push('--language', language);
  if (Number.isFinite(Number(req.temperature)) && String(req.temperature ?? '').trim() !== '') {
    args.push('--temperature', String(Number(req.temperature)));
  }
  args.push(
    '--output',
    opts.outputPath,
    '--mode',
    req.mixMode === 'mix' ? 'mix' : 'replace',
    '--orig-volume',
    String(Number.isFinite(Number(req.origVolume)) ? Number(req.origVolume) : 0.15),
    '--tts-volume',
    String(Number.isFinite(Number(req.ttsVolume)) ? Number(req.ttsVolume) : 1),
  );
  if (req.keepWav) args.push('--keep-wav');
  args.push('--json-events', '--metadata');
  return args;
}

/* ────────────────────────── 运行态 / 进度 ────────────────────────── */

/** 全局串行链:CosyVoice 合成是 CPU 重活,同一时刻只跑一个 */
let ttsChain: Promise<unknown> = Promise.resolve();

/** 当前运行中的子进程(取消/退出用) */
const liveChildren = new Set<ChildProcess>();

/** 每个在排队或运行中的任务一个 AbortController(按节点分组,取消可精确到节点) */
const runControllers = new Map<string, Set<AbortController>>();

/** 运行中的语音任务(主进程真源;渲染层挂载时恢复运行态) */
const runningRuns = new Map<string, { nodeId: string; startedAt: string; stage?: string }>();

let lastProgress: { nodeId: string; stageLabel: string; detail?: string } | null = null;

export function listRunningTts(): Array<{ nodeId: string; startedAt: string; stage?: string }> {
  return [...runningRuns.values()];
}

export function lastTtsProgress(): { nodeId: string; stageLabel: string; detail?: string } | null {
  return lastProgress;
}

export function cancelAllTts(): void {
  for (const set of runControllers.values()) {
    for (const ac of set) ac.abort();
  }
  for (const c of liveChildren) {
    try {
      c.kill('SIGTERM');
    } catch {
      /* 进程已退出 */
    }
  }
  liveChildren.clear();
}

/** 取消语音任务:给定 nodeId 只停该节点(含已排队未启动的);不给则停全部 */
export function cancelTts(nodeId?: string): { ok: boolean; error?: string } {
  if (!nodeId) {
    if (runControllers.size === 0 && liveChildren.size === 0) return { ok: false, error: '没有正在进行的语音任务' };
    cancelAllTts();
    return { ok: true };
  }
  const set = runControllers.get(nodeId);
  if (!set || set.size === 0) return { ok: false, error: '该节点没有正在进行的语音任务' };
  for (const ac of set) ac.abort();
  return { ok: true };
}

function trackRun(key: string, ac: AbortController): void {
  let set = runControllers.get(key);
  if (!set) {
    set = new Set();
    runControllers.set(key, set);
  }
  set.add(ac);
}

function untrackRun(key: string, ac: AbortController): void {
  const set = runControllers.get(key);
  if (!set) return;
  set.delete(ac);
  if (set.size === 0) runControllers.delete(key);
}

/** 进度上报器:保证 overall 跨阶段单调递增,并记录最近一次(挂载时恢复) */
class ProgressReporter {
  private peak = 0;
  constructor(
    private readonly nodeId: string,
    private readonly onProgress?: (p: TtsProgressEvent) => void,
  ) {}

  push(stageLabel: string, overall: number, detail?: string, stageProgress?: number): void {
    const v = Math.max(this.peak, Math.max(0, Math.min(1, overall)));
    this.peak = v;
    if (!this.onProgress) return;
    if (this.nodeId) lastProgress = { nodeId: this.nodeId, stageLabel, detail };
    this.onProgress({ nodeId: this.nodeId, stageLabel, detail, overall: v, stageProgress });
  }
}

/* ────────────────────────── 子进程执行 ────────────────────────── */

interface ChildRunResult {
  code: number;
  stderrTail: string;
  aborted: boolean;
}

function runChild(
  bin: string,
  args: string[],
  opts: {
    signal?: AbortSignal;
    onLine?: (line: string) => void;
    onStderr?: (line: string) => void;
    onSpawn?: (child: ChildProcess) => void;
  },
): Promise<ChildRunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    liveChildren.add(child);
    opts.onSpawn?.(child);
    const stderrLines: string[] = [];
    let aborted = false;
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      liveChildren.delete(child);
      resolve({ code, stderrTail: stderrLines.slice(-40).join('\n'), aborted });
    };
    const onAbort = () => {
      aborted = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* 已退出 */
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
      }, 3000);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    };
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let buf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      for (;;) {
        const idx = buf.indexOf('\n');
        if (idx < 0) break;
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) opts.onLine?.(line);
      }
    });
    let ebuf = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      ebuf += chunk.toString('utf8');
      for (;;) {
        const idx = ebuf.indexOf('\n');
        if (idx < 0) break;
        const line = ebuf.slice(0, idx).trim();
        ebuf = ebuf.slice(idx + 1);
        if (!line) continue;
        stderrLines.push(line);
        if (stderrLines.length > 200) stderrLines.shift();
        opts.onStderr?.(line);
      }
    });
    child.on('error', (err) => {
      stderrLines.push(`spawn 失败: ${err.message}`);
      settle(-1);
    });
    child.on('close', (code) => settle(code ?? -1));
  });
}

/** 把引擎/子进程的英文报错翻译成可执行的中文指引(不吞原始信息) */
export function translateTtsError(raw: string, tooling: Pick<TtsTooling, 'prepareHint' | 'packagePath'>): string {
  const msg = String(raw ?? '').trim();
  if (!msg) return 'CosyVoice3 失败(无 stderr 输出)';
  if (/No module named ['"]?mlx_audio['"]?|mlx_audio.*not.*found/i.test(msg)) {
    return `Qwen3-TTS 推理依赖 mlx-audio 未装进当前 mlxgen 环境(editable 安装不会自动补依赖)。执行:\`uv pip install --python "$(head -1 "$(command -v mlxgen)" | sed 's/^#!//')" "mlx-audio>=0.6.4"\`,或整体重装:\`uv tool install --reinstall --editable ~/ai/mlx-gen\`。原始错误:${msg.slice(0, 400)}`;
  }
  if (/invalid choice|unrecognized arguments|No module named .*cosyvoice|unknown command|voice-design.*not.*found|tts.*not.*found/i.test(msg)) {
    return `当前 mlxgen 不含所需的语音子命令。请升级:\`uv tool install --upgrade mlx-gen-jzg\`,然后:\`${tooling.prepareHint}\`。原始错误:${msg.slice(0, 400)}`;
  }
  if (/Qwen3-TTS|VoiceDesign|voice-design/i.test(msg) && /package|manifest|prepared|weights|model_path|model-path/i.test(msg)) {
    return `Qwen3-TTS VoiceDesign 未准备。请先执行:\`mlxgen prepare --model qwen3-tts-voice-design\`(约 4.5 GB,只需一次)。原始错误:${msg.slice(0, 400)}`;
  }
  if (/Package directory|manifest\.json|prepared package|resolve_package|CosyVoice3 package/i.test(msg)) {
    return `CosyVoice3 未准备。请先执行:\`${tooling.prepareHint}\`(约 5.4 GB,只需一次)。原始错误:${msg.slice(0, 400)}`;
  }
  if (/--ref-audio not found|ref_audio not found/i.test(msg)) {
    return `参考音色文件不存在或不可读(3–30 秒干净人声):${msg.slice(0, 300)}`;
  }
  if (/No such file or directory.*ffmpeg|ffmpeg.*not found|needs ffmpeg/i.test(msg)) {
    return `配音混音需要 ffmpeg(brew install ffmpeg)。原始错误:${msg.slice(0, 300)}`;
  }
  return msg.slice(0, 1200);
}

/* ────────────────────────── 示例音色(CosyVoice3 无预设音色)────────────────────────── */

/**
 * 引擎包自带的官方示例参考音(`runtime/zero_shot_prompt.wav`,约 3.5 秒)。
 *
 * 为什么需要:用户第一次用「文生语音」时通常手里没有 3–30 秒干净人声,
 * 而 CosyVoice3 **没有预设说话人** —— 没参考音就完全跑不起来(节点按钮只能是灰的)。
 * 引擎包本身带着官方 demo 参考音,把它显式做成「使用示例音色」按钮,
 * 既保持「必须给参考音」的语义(它确实是真实参考音),又让节点开箱可用。
 * 不叫「预设音色库」:只有这一条,且明确标注是官方示例。
 */
export function sampleVoiceSource(packagePath: string | undefined): string | undefined {
  if (!packagePath) return undefined;
  const p = join(packagePath, 'runtime', 'zero_shot_prompt.wav');
  try {
    return existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把示例音色复制到产物目录(`outputs/dub/voices/`)—— 必须在 ffmpeg 允许根内,
 * 否则 doSynthesize 的白名单会以「参考音色不在允许目录」拒绝合成。
 * 幂等:目标已存在就直接复用(不覆盖用户可能替换过的文件)。
 */
export function ensureSampleVoice(): { ok: boolean; path?: string; error?: string } {
  const tooling = probeTtsTooling();
  if (!tooling.packageReady) {
    return { ok: false, error: `CosyVoice3 未准备:${tooling.prepareHint}` };
  }
  const src = sampleVoiceSource(tooling.packagePath);
  if (!src) {
    return { ok: false, error: '引擎包里没有 runtime/zero_shot_prompt.wav,无法提供示例音色;请导入一段 3–30 秒人声' };
  }
  const dir = join(ttsOutputsDir(), 'voices');
  const dest = join(dir, 'cosyvoice3-sample.wav');
  try {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(dest)) copyFileSync(src, dest);
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: `复制示例音色失败:${(e as Error).message}` };
  }
}

/* ────────────────────────── 主入口 ────────────────────────── */

/** 已入队/在跑的节点 id(含排在串行链后面还没启动的那次)——
 *  同节点重复提交必须**当场拒绝**,而不是排到链尾再跑一遍(设计 §7.2 / 渲染层同口径)。 */
const activeNodeIds = new Set<string>();

/**
 * 语音合成主入口。kind=tts-gen 出 wav;kind=video-dub 出带旁白 mp4。
 * 串行执行;返回最终产物路径。任一步失败直接返回错误,不留半成品节点。
 */
export function synthesizeSpeech(req: TtsRequest, opts: { onProgress?: (p: TtsProgressEvent) => void; signal?: AbortSignal } = {}): Promise<TtsResult> {
  const nodeId = String(req.nodeId ?? '');
  if (nodeId && activeNodeIds.has(nodeId)) {
    return Promise.resolve({
      ok: false,
      error: '该节点已有语音任务在排队/运行中,不重复提交。等它完成即可;确要重跑,先在检查器点「取消」。',
    });
  }
  if (nodeId) activeNodeIds.add(nodeId);
  const ac = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  const key = nodeId || `__anon-${Date.now()}`;
  trackRun(key, ac);
  const run = ttsChain.then(() => doSynthesize(req, { ...opts, signal: ac.signal }));
  ttsChain = run.catch(() => undefined);
  return run.finally(() => {
    untrackRun(key, ac);
    if (nodeId) {
      activeNodeIds.delete(nodeId);
      runningRuns.delete(nodeId);
      if (lastProgress?.nodeId === nodeId) lastProgress = null;
    }
  });
}

async function doSynthesize(
  req: TtsRequest,
  opts: { onProgress?: (p: TtsProgressEvent) => void; signal?: AbortSignal },
): Promise<TtsResult> {
  const started = Date.now();
  const nodeId = String(req.nodeId ?? '');
  const kind = req.kind === 'video-dub' ? 'video-dub' : 'tts-gen';
  const text = String(req.text ?? '').trim();
  const refVoiceRaw = String(req.refVoicePath ?? '').trim();
  const videoRaw = String(req.inputVideoPath ?? '').trim();
  const voiceMode = resolveVoiceMode(req);
  const voiceProfile = String(req.voiceProfile ?? '').trim();
  const voiceDescription = String(req.voiceDescription ?? '').trim();
  const reporter = new ProgressReporter(nodeId, opts.onProgress);

  if (!text) return { ok: false, error: '旁白文本为空(请在检查器填写文本)' };
  if (voiceMode === 'design' && !voiceProfile && !voiceDescription) {
    return { ok: false, error: '文字设计音色需要音色描述:选一个内置音色类型,或写一句描述(如「三十多岁女性,声音温暖沉稳」)' };
  }
  if (voiceMode === 'clone' && !refVoiceRaw) {
    return { ok: false, error: '缺少参考音色:连线一个音频资产/音频参考节点,或在检查器绑定资产(或改用「文字设计音色」)' };
  }
  if (kind === 'video-dub' && !videoRaw) return { ok: false, error: '视频配音缺少输入视频:把镜头成片/视频增强/成片时间线连到 input-video 端口' };

  const roots = ffmpegReadRoots();
  const allowed = (p: string) => roots.some((r) => isUnderRoot(p, r));
  if (voiceMode === 'clone') {
    if (!existsSync(refVoiceRaw)) return { ok: false, error: `参考音色文件不存在:${refVoiceRaw}` };
    if (!allowed(refVoiceRaw)) return { ok: false, error: '参考音色不在允许目录(产物/资产/项目目录),拒绝读取' };
  }
  if (kind === 'video-dub') {
    if (!existsSync(videoRaw)) return { ok: false, error: `输入视频不存在:${videoRaw}` };
    if (!allowed(videoRaw)) return { ok: false, error: '输入视频不在允许目录(产物/资产/项目目录),拒绝处理' };
  }

  const tooling = probeTtsTooling();
  const dryRun = process.env.BIGBOTART_DRYRUN !== '0';
  // dry-run 只构造命令、不 spawn:因此**不要求**引擎就绪(开发机没 prepare 也能看清命令);
  // 真实跑则 mlxgen 与 prepared package 必须都在,缺啥报啥。
  if (!dryRun) {
    if (!tooling.mlxgen) {
      return { ok: false, error: `mlxgen 未安装或不可执行(需要含 tts/dub/voice-design 的新版):${tooling.prepareHint}` };
    }
    if (voiceMode === 'design') {
      if (!tooling.voiceDesignReady) {
        return {
          ok: false,
          error: `Qwen3-TTS VoiceDesign 未准备。请先执行:\`${tooling.voiceDesignPrepareHint}\`(约 4.5 GB,只需一次)。当前包路径:${tooling.voiceDesignPackagePath}`,
        };
      }
    } else if (!tooling.packageReady) {
      return { ok: false, error: `CosyVoice3 未准备。请先执行:\`${tooling.prepareHint}\`(约 5.4 GB,只需一次)。当前包路径:${tooling.packagePath}` };
    }
  }

  const dir = ttsOutputsDir();
  const ts = Date.now();
  const stemBase = String(req.outputName ?? '').trim() || (nodeId ? nodeId.replace(/[^\w.-]+/g, '_') : kind);
  const outputPath =
    kind === 'video-dub'
      ? join(dir, `${stemBase}-dub-${ts}.mp4`)
      : join(dir, `${stemBase}-tts-${ts}.wav`);
  const packagePath =
    voiceMode === 'design' ? (tooling.voiceDesignPackagePath ?? '') : (tooling.packagePath ?? '');
  const mode = voiceMode === 'design' ? 'voice-design' : resolveTtsMode(req);

  if (dryRun) {
    // 红线 R2:dry-run 绝不 spawn、绝不写占位产物 —— 诚实返回「已跳过」,让 UI 说真话
    const dryArgv =
      voiceMode === 'design'
        ? kind === 'video-dub'
          ? buildDubVoiceDesignArgs(
              { ...req, text, voiceProfile, voiceDescription, inputVideoPath: videoRaw || undefined },
              { packagePath, outputPath },
            )
          : buildVoiceDesignArgs(
              { ...req, text, voiceProfile, voiceDescription },
              { packagePath, outputPath },
            )
        : kind === 'video-dub'
          ? buildDubArgs(
              { ...req, text, refVoicePath: refVoiceRaw, inputVideoPath: videoRaw || undefined },
              { packagePath, outputPath },
            )
          : buildTtsArgs({ ...req, text, refVoicePath: refVoiceRaw }, { packagePath, outputPath });
    const voiceShown =
      voiceMode === 'design'
        ? `--voice${voiceProfile ? '-profile ' + voiceProfile : '=<' + voiceDescription.length + ' 字描述>'}` +
          (req.language ? ` --language ${req.language}` : '')
        : `--ref-audio ${basename(refVoiceRaw)}`;
    const shown = `mlxgen ${dryArgv[0]} … --text=<${text.replace(/\s/g, '').length} 字> ${voiceShown}${kind === 'video-dub' ? ` --video-path ${basename(videoRaw)} --mode ${req.mixMode === 'mix' ? 'mix' : 'replace'}` : ''} --output ${basename(outputPath)}`;
    return {
      ok: false,
      dryRun: true,
      mode,
      voiceMode,
      error: `dry-run 已跳过真实合成(未加载 CosyVoice3、未产出文件)。命令:${shown}。真实跑请用 pnpm dev 并在设置页开启真实推理。`,
    };
  }

  // 参考音色给的是视频(带人声的短视频)→ 先抽音轨(CosyVoice 只吃 wav,且 3–30s 干净人声);
  // design 模式没有参考音,不碰 ffmpeg。
  let refVoicePath = refVoiceRaw;
  if (voiceMode === 'clone' && refVoicePath && VIDEO_EXT_RE.test(refVoicePath)) {
    reporter.push('抽取参考音轨', 0.02, basename(refVoicePath));
    const extracted = await extractAudio(refVoicePath);
    if (!extracted.ok || !extracted.path) {
      return { ok: false, error: `参考视频抽音轨失败:${extracted.error ?? '未知错误'}(请改用音频文件)` };
    }
    refVoicePath = extracted.path;
  }

  const normalized: TtsRequest = {
    ...req,
    kind,
    text,
    voiceMode,
    refVoicePath,
    inputVideoPath: videoRaw || undefined,
  };
  const argv =
    voiceMode === 'design'
      ? kind === 'video-dub'
        ? buildDubVoiceDesignArgs(normalized, { packagePath, outputPath })
        : buildVoiceDesignArgs(normalized, { packagePath, outputPath })
      : kind === 'video-dub'
        ? buildDubArgs(normalized, { packagePath, outputPath })
        : buildTtsArgs(normalized, { packagePath, outputPath });

  mkdirSync(dir, { recursive: true });
  if (nodeId) runningRuns.set(nodeId, { nodeId, startedAt: new Date().toISOString(), stage: '准备合成' });
  reporter.push('准备合成', 0.01, `${text.replace(/\s/g, '').length} 字 · 模式 ${mode}`);
  if (opts.signal?.aborted) return { ok: false, error: '已取消' };

  const estimate = estimateAudioSeconds(text);
  let synthAudioSec = 0;
  let phase = '';
  let child: ChildProcess | undefined;

  // 心跳:loading/synthesizing 阶段引擎只报事件、不报细分进度,给「已耗时」避免看起来卡死
  const heartbeat = setInterval(() => {
    if (!child) return;
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (phase === 'synthesizing') {
      const frac = Math.min(0.98, synthAudioSec > 0 ? synthAudioSec / estimate : 0);
      reporter.push('合成旁白', 0.15 + frac * 0.65, `已合成 ${synthAudioSec > 0 ? synthAudioSec.toFixed(1) + 's' : '…'} · 已 ${elapsed}s`);
    } else if (phase === 'muxing') {
      reporter.push('混音封装', 0.85, `画面 stream-copy · 已 ${elapsed}s`);
    } else {
      reporter.push(
        voiceMode === 'design' ? '加载 Qwen3-TTS' : '加载模型',
        0.06,
        voiceMode === 'design' ? `MLX · Metal · 已 ${elapsed}s` : `已 ${elapsed}s(首次加载约 20–40s)`,
      );
    }
  }, 5000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  let stderrTail = '';
  try {
    const res = await runChild(tooling.mlxgenPath as string, argv, {
      signal: opts.signal,
      onSpawn: (c) => {
        child = c;
      },
      onLine: (line) => {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return; // 非 JSON 行(stdout 被库污染)忽略,真错误走 stderr
        }
        const p = String(ev.phase ?? '');
        phase = p;
        if (p === 'loading') {
          reporter.push(
            voiceMode === 'design' ? '加载 Qwen3-TTS' : '加载模型',
            0.05,
            voiceMode === 'design' ? '纯 MLX · Metal' : '隔离 venv · CPU',
          );
        } else if (p === 'loaded') {
          const load = Number(ev.load_seconds);
          reporter.push('模型就绪', 0.12, Number.isFinite(load) ? `加载 ${load}s · 采样率 ${ev.sample_rate ?? '?'}` : undefined);
        } else if (p === 'synthesizing') {
          const audio = Number(ev.audio_seconds);
          if (Number.isFinite(audio)) synthAudioSec = audio;
          const frac = Math.min(1, synthAudioSec > 0 ? synthAudioSec / estimate : 0);
          reporter.push('合成旁白', 0.15 + frac * 0.65, `已合成 ${synthAudioSec.toFixed(1)}s / 约 ${estimate}s`, frac);
        } else if (p === 'complete') {
          const audio = Number(ev.audio_seconds);
          if (Number.isFinite(audio)) synthAudioSec = audio;
          if (kind === 'video-dub') {
            phase = 'muxing';
            reporter.push('混音封装', 0.85, '画面 stream-copy · 只重编码音轨');
          } else {
            reporter.push('写 wav', 0.95, Number.isFinite(audio) ? `${audio.toFixed(1)}s 音频` : undefined);
          }
        } else if (p === 'failed') {
          stderrTail = String(ev.error ?? '');
        }
      },
    });

    if (res.aborted || opts.signal?.aborted) return { ok: false, error: '已取消' };
    if (res.code !== 0) {
      const raw = stderrTail || res.stderrTail || `exit ${res.code}`;
      return { ok: false, error: translateTtsError(raw, tooling) };
    }

    // 引擎 exit 0 不等于产物可用:必须文件存在且非空(本项目反复出现的「假成功」形态)
    let productOk = false;
    try {
      const st = statSync(outputPath);
      productOk = st.isFile() && st.size > 0;
    } catch {
      productOk = false;
    }
    if (!productOk) {
      return { ok: false, error: `引擎返回成功但产物不存在/为空:${outputPath}` };
    }

    const narrationPath =
      kind === 'video-dub' && req.keepWav ? outputPath.replace(/\.mp4$/i, '.wav') : undefined;
    let durationSec = synthAudioSec > 0 ? synthAudioSec : undefined;
    if (kind === 'video-dub') {
      const meta = probeVideo(outputPath);
      durationSec = meta.durationSec ?? durationSec;
    }
    reporter.push('完成', 1, basename(outputPath));
    return {
      ok: true,
      path: outputPath,
      narrationPath: narrationPath && existsSync(narrationPath) ? narrationPath : undefined,
      durationSec,
      elapsedSec: Math.round((Date.now() - started) / 1000),
      mode,
      voiceMode,
    };
  } catch (e) {
    return { ok: false, error: `语音任务异常:${(e as Error).message}` };
  } finally {
    clearInterval(heartbeat);
  }
}
