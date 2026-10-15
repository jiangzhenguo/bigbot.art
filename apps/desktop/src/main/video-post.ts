/**
 * VideoPost — 视频增强(超分 + 合修脸)主进程模块
 *
 * 实现 h3 出片后处理流水线(见 /Users/jiangzhenguo/ai/h3/POST_PROCESSING.md):
 *   ① 去块(deblock)   — ffmpeg `deblock` + 高码率重编码,消灭 h264 压缩块(超分前做,否则块被放大成方格)
 *   ② 超分(upscale)   — Real-ESRGAN 逐帧(basicsr.RealESRGANer,PyTorch + MPS),或 SeedVR2(mlxgen 视频超分)
 *   ③ 修脸(faceFix)   — GFPGAN / CodeFormer 逐帧人脸修复(face_fix_video.py,mps)
 *
 * 与 frames.ts / stitch.ts 的分工:那两个模块是**秒级纯 ffmpeg**,本模块是**分钟级**
 * (每帧 1.2-1.5s),故:
 *   - 独立串行链(不与取帧共用,避免长任务把取帧堵死);
 *   - 支持 AbortSignal 取消(检查器「取消」/ 主进程退出);
 *   - 进度按阶段回调(拆帧/超分/修脸/拼回),驱动节点 badge。
 *
 * 产物落 ${OUTPUTS_DIR}/video-post/(bba-output 协议可读)。
 * R2 红线:不加载 h3、不读 BIGBOTART_DRYRUN。Real-ESRGAN 是本地后处理;
 * SeedVR2 会经 mlxgen 加载 MLX 超分模型(用户点运行才启动),同样不在后台自动跑。
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, existsSync, copyFileSync, unlinkSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import type {
  VideoUpscaleRequest,
  VideoUpscaleResult,
  VideoPostTooling,
  VideoPostProgressEvent,
} from '@bigbotart/shared';
import { OUTPUTS_DIR, ffmpegReadRoots, isUnderRoot } from './assets';

const VIDEO_POST_DIR = join(OUTPUTS_DIR, 'video-post');
const HOME = homedir();

/** 工具链路径(全部带 BIGBOTART_ 环境变量覆盖,便于换机/自定义部署) */
export const TOOL_PATHS = {
  /** 统一后处理脚本(超分 + 修脸同一进程,只拆/拼一次帧)。
   *  基于 basicsr.RealESRGANer(PyTorch) + GFPGAN/CodeFormer —— 取代原 ncnn 外部二进制两段式。 */
  postScript: process.env.BIGBOTART_VIDEO_POST_SCRIPT ?? join(HOME, 'ai', 'face-fix', 'video_post.py'),
  /** 旧修脸脚本(仅保留路径常量供兼容/诊断;新链路不再调用) */
  faceFixScript: process.env.BIGBOTART_FACE_FIX_SCRIPT ?? join(HOME, 'ai', 'face-fix', 'face_fix_video.py'),
  /** GFPGAN 仓库根:**必须**作为修脸子进程的 cwd —— GFPGAN 把 facexlib 权重目录写成相对路径
   *  'gfpgan/weights'(gfpgan/utils.py → FaceRestoreHelper(model_rootpath=...)),facexlib 再按
   *  子进程 CWD 解析。cwd 不对时,即使本地已有权重也会去 GitHub 重新下载(实测国内链路 100MB+
   *  要几十分钟,表现成「卡住不动」)。见 POST_PROCESSING.md §2.2。 */
  gfpganRoot: process.env.BIGBOTART_GFPGAN_ROOT ?? join(HOME, 'ai', 'GFPGAN'),
  /** 修脸用 Python 解释器(superres venv:已装 torch/facexlib/basicsr/gfpgan) */
  python: process.env.BIGBOTART_SUPERRES_PYTHON ?? join(HOME, 'venvs', 'superres', 'bin', 'python'),
  /** 权重目录 */
  weightsDir: process.env.BIGBOTART_WEIGHTS_DIR ?? join(HOME, 'ai', 'weights'),
} as const;

/** PyTorch 版超分权重(PyTorch 不能读 ncnn 的 .bin/.param,必须是 .pth) */
export const SR_WEIGHT_FILES: Record<string, string> = {
  'realesrgan-x4plus': 'RealESRGAN_x4plus.pth',
  'realesr-animevideov3': 'realesr-animevideov3.pth',
  'realesrgan-x4plus-anime': 'RealESRGAN_x4plus_anime_6B.pth',
};

/** facexlib 运行期需要的检测/parsing 权重(facexlib 相对 cwd 找 gfpgan/weights/) */
export const FACEXLIB_WEIGHT_FILES = ['detection_Resnet50_Final.pth', 'parsing_parsenet.pth'] as const;

/** GFPGAN 查找 facexlib 权重的目录(相对 cwd ⇒ 实际 <gfpganRoot>/gfpgan/weights) */
export function facexlibWeightsDir(gfpganRoot: string = TOOL_PATHS.gfpganRoot): string {
  return join(gfpganRoot, 'gfpgan', 'weights');
}

/**
 * 权重兜底(纯逻辑):目标目录缺失时,列出可从 weightsDir 拷贝补齐的 [file, from, to]。
 * 双保险 —— cwd 已由 buildFaceFixSpawn 固定,这里再保证文件真的在位,避免联网重下。
 */
export function missingFacexlibWeights(opts?: {
  gfpganRoot?: string;
  weightsDir?: string;
  exists?: (p: string) => boolean;
}): Array<{ file: string; from: string; to: string }> {
  const root = opts?.gfpganRoot ?? TOOL_PATHS.gfpganRoot;
  const wd = opts?.weightsDir ?? TOOL_PATHS.weightsDir;
  const exists = opts?.exists ?? ((p: string) => existsSync(p));
  const dir = facexlibWeightsDir(root);
  const out: Array<{ file: string; from: string; to: string }> = [];
  for (const f of FACEXLIB_WEIGHT_FILES) {
    const to = join(dir, f);
    if (exists(to)) continue;
    const from = join(wd, f);
    if (exists(from)) out.push({ file: f, from, to });
  }
  return out;
}

/** 补齐 facexlib 权重(幂等;失败不抛,交由真实执行时报错) */
function ensureFacexlibWeights(): void {
  for (const m of missingFacexlibWeights()) {
    try {
      mkdirSync(facexlibWeightsDir(), { recursive: true });
      copyFileSync(m.from, m.to);
    } catch {
      /* 交由后续执行报错,不吞掉用户可见信息 */
    }
  }
}

/** 可用的 Real-ESRGAN 模型(POST_PROCESSING.md §2.1) */
export const SR_MODELS = ['realesrgan-x4plus', 'realesr-animevideov3', 'realesrgan-x4plus-anime'] as const;
/** SeedVR2 视频超分默认包(本机 HF 缓存已有的 3B 8bit;与图片节点 image-upscale 同口径) */
export const SEEDVR2_VIDEO_MODEL = 'AbstractFramework/seedvr2-3b-8bit';
/** 允许传给 `mlxgen upscale --model` 的 SeedVR2 标识(未知值回落默认包,防任意路径) */
const SEEDVR_MODEL_ALIASES: Record<string, string> = {
  seedvr2: SEEDVR2_VIDEO_MODEL,
  'seedvr2-3b': SEEDVR2_VIDEO_MODEL,
  'AbstractFramework/seedvr2-3b-8bit': SEEDVR2_VIDEO_MODEL,
  'AbstractFramework/seedvr2-3b-4bit': 'AbstractFramework/seedvr2-3b-4bit',
  'AbstractFramework/seedvr2-7b-8bit': 'AbstractFramework/seedvr2-7b-8bit',
  'AbstractFramework/seedvr2-7b-4bit': 'AbstractFramework/seedvr2-7b-4bit',
  'ByteDance-Seed/SeedVR2-3B': 'ByteDance-Seed/SeedVR2-3B',
  'ByteDance-Seed/SeedVR2-7B': 'ByteDance-Seed/SeedVR2-7B',
  'seedvr2-7b': 'seedvr2-7b',
  'seedvr2-7b-sharp': 'seedvr2-7b-sharp',
};

/** 归一化 SeedVR2 模型名;不在白名单里的一律用 3B 8bit */
export function resolveSeedVrModel(raw: unknown): string {
  const s = String(raw ?? '').trim();
  return SEEDVR_MODEL_ALIASES[s] ?? SEEDVR2_VIDEO_MODEL;
}
/** 修脸模型 */
export const FACE_MODELS = ['gfpgan', 'codeformer', 'none'] as const;

/** 默认参数(缺省 = POST_PROCESSING.md §9.1「标准(无方格问题)」配方再保守一档) */
export const VIDEO_POST_DEFAULTS = {
  scale: 2,
  superRes: 'realesrgan' as const,
  /** 真人默认:doc §2.1 明确 animevideov3 对真人会产生方格 */
  srModel: 'realesrgan-x4plus' as const,
  faceModel: 'gfpgan' as const,
  faceWeight: 0.5,
  fidelityWeight: 0.7,
  deblock: false,
  deblockCrf: 14,
  crf: 18,
  device: 'mps' as const,
} as const;

/* ────────────────────────── 纯函数:参数归一 + 命令构造(可单测) ────────────────────────── */

export interface NormalizedVideoPost {
  scale: number;
  superRes: 'realesrgan' | 'seedvr2' | 'none';
  /** 实际是否跑 Real-ESRGAN(scale>1 且 superRes=realesrgan) */
  doSuperRes: boolean;
  /** 实际是否跑 SeedVR2(mlxgen 视频超分/修复) */
  doSeedVr: boolean;
  /** 传给 mlxgen --model 的 SeedVR2 标识 */
  seedvrModel: string;
  srModel: string;
  /** 实际是否跑修脸 */
  doFaceFix: boolean;
  faceModel: 'gfpgan' | 'codeformer';
  faceWeight: number;
  fidelityWeight: number;
  deblock: boolean;
  deblockCrf: number;
  crf: number;
  device: 'mps' | 'cpu';
}

/**
 * 参数归一(纯函数):非法/越界值一律回落到 doc 默认,绝不让坏参数走到 spawn。
 *
 * 关键防呆:face_fix_video.py 的 `-s` 本身就能超分(GFPGAN 内部 4x 模型下采样到 2x),
 * 所以「Real-ESRGAN 超分」与「修脸」同时开时,**修脸阶段的 -s 固定为 1**
 * ——否则会二次放大成 4x。带 -s 2 的修脸只在「不单独超分」时使用(方案 C:仅修脸)。
 */
export function normalizeVideoPost(req: VideoUpscaleRequest): NormalizedVideoPost {
  const d = VIDEO_POST_DEFAULTS;
  const scaleRaw = Number(req.scale ?? d.scale);
  const scale = [1, 2, 3, 4].includes(Math.round(scaleRaw)) ? Math.round(scaleRaw) : d.scale;
  const superRes = req.superRes === 'none' ? 'none' : req.superRes === 'seedvr2' ? 'seedvr2' : 'realesrgan';
  // SeedVR2 的 ×1 是原分辨率修复,仍然要跑;Real-ESRGAN 的 ×1 才是「不超分」
  const doSeedVr = superRes === 'seedvr2';
  const doSuperRes = superRes === 'realesrgan' && scale > 1;
  const faceRaw = String(req.faceModel ?? d.faceModel);
  const doFaceFix = faceRaw === 'gfpgan' || faceRaw === 'codeformer';
  const srModel = (SR_MODELS as readonly string[]).includes(String(req.srModel))
    ? String(req.srModel)
    : d.srModel;
  const clamp01 = (v: unknown, fb: number): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fb;
    return Math.min(1, Math.max(0, Math.round(n * 100) / 100));
  };
  const crf = (v: unknown, fb: number): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fb;
    return Math.min(51, Math.max(0, Math.round(n)));
  };
  return {
    scale,
    superRes,
    doSuperRes,
    doSeedVr,
    seedvrModel: resolveSeedVrModel(req.seedvrModel),
    srModel,
    doFaceFix,
    faceModel: faceRaw === 'codeformer' ? 'codeformer' : 'gfpgan',
    faceWeight: clamp01(req.faceWeight, d.faceWeight),
    fidelityWeight: clamp01(req.fidelityWeight, d.fidelityWeight),
    deblock: req.deblock === true,
    deblockCrf: crf(req.deblockCrf, d.deblockCrf),
    crf: crf(req.crf, d.crf),
    device: req.device === 'cpu' ? 'cpu' : 'mps',
  };
}

/**
 * 去块 ffmpeg filtergraph(POST_PROCESSING.md §5.4)。
 *
 * ⚠️ 文档给的是 `deblock=filter=strong:block=4:flat-strength=20`,但**新版 ffmpeg(实测 8.0.1)的
 * deblock 过滤器没有 `flat-strength` 选项** —— 照抄会直接 `exit 8: Option not found`,整个去块阶段失败。
 * 该 filter 的可用选项是 `filter/block/alpha/beta/gamma/delta/planes`,因此这里只保留跨版本稳定、
 * 且语义等价的参数:`filter=strong`(强去块)+ `block=4`(4×4 块边界,对应文档 8×8 压缩块的半块粒度)。
 * 想要更狠的去块强度可调 `alpha/beta/gamma/delta`(0-1,越小越激进),但默认不动以免过度涂抹。
 */
export function buildDeblockVf(): string {
  return 'deblock=filter=strong:block=4';
}

/**
 * 执行阶段计划(纯函数):按参数决定实际跑哪几步,供 UI 预告耗时/阶段摘要。
 * 顺序固定:去块 → 超分 → 修脸(顺序不可换:先去掉压缩块再放大,否则块被放大成方格)。
 */
export function planVideoPostStages(n: NormalizedVideoPost): string[] {
  const stages: string[] = [];
  if (n.deblock) stages.push(`去块(ffmpeg deblock · CRF ${n.deblockCrf})`);
  if (n.doSeedVr) stages.push(`SeedVR2 ×${n.scale}(${n.seedvrModel})`);
  else if (n.doSuperRes) stages.push(`Real-ESRGAN ×${n.scale}(${n.srModel})`);
  if (n.doFaceFix) {
    stages.push(
      n.faceModel === 'gfpgan'
        ? `GFPGAN 修脸(强度 ${n.faceWeight})`
        : `CodeFormer 修脸(保真 ${n.fidelityWeight})`,
    );
  }
  if (stages.length === 0) stages.push('仅重编码(无处理阶段)');
  return stages;
}

/** 超分/修脸模型白名单(与脚本 --sr/--face 取值对齐) */
export const FACE_MODELS_LIST = ['gfpgan', 'codeformer', 'none'] as const;

/**
 * 统一后处理脚本命令行(纯函数)。PyTorch 版把超分与修脸放进同一进程,
 * **只拆一次帧、只拼一次回**;`-s` 语义(重要):
 *   - 已开超分 ⇒ 脚本内部让 RealESRGANer 输出 scale 倍,修脸器 scale 固定 1;
 *   - 未开超分 ⇒ 修脸器自己承担 scale(方案 C)。
 * 这层换算在脚本里做(见 video_post.py 的 face_scale 计算),这里只传用户意图。
 */
export function buildPostArgs(
  inputPath: string,
  outputPath: string,
  n: NormalizedVideoPost,
): string[] {
  const args = [inputPath, '-o', outputPath, '-s', String(n.scale)];
  args.push('--sr', n.doSuperRes ? n.srModel : 'none');
  args.push('--face', n.doFaceFix ? n.faceModel : 'none');
  if (n.doFaceFix) {
    args.push('--face-weight', String(n.faceWeight));
    args.push('--fidelity', String(n.fidelityWeight));
  }
  args.push('--device', n.device);
  args.push('--crf', String(n.crf));
  return args;
}

/**
 * SeedVR2 已经放大过之后,修脸必须按 ×1、且不再跑 Real-ESRGAN。
 * 否则 PyTorch 管线会按节点上的 scale 再放大一次。
 */
export function faceOnlyAfterSeedVr(n: NormalizedVideoPost): NormalizedVideoPost {
  return { ...n, scale: 1, superRes: 'none', doSuperRes: false, doSeedVr: false };
}

/**
 * `mlxgen upscale` 视频命令(纯函数)。
 *
 * 放大超过 1× 时引擎的安全档会直接拒绝(只允许原分辨率修复),
 * 所以显式带 `--force-unsafe-video-memory`,并用文档里验证过的 29/8 分块。
 * 缓存上限钉在 8GB,与引擎视频安全档的默认值一致。
 */
export function buildSeedVrVideoArgs(inputPath: string, outputPath: string, n: NormalizedVideoPost): string[] {
  const args = [
    'upscale',
    '--model', n.seedvrModel,
    '--video-path', inputPath,
    '--resolution', `${n.scale}x`,
    '--color-correction', 'wavelet',
    '--low-ram',
    '--mlx-cache-limit-gb', '8',
    '--json-events',
    '--output', outputPath,
  ];
  if (n.scale > 1) {
    args.push('--temporal-chunk-size', '29', '--temporal-chunk-overlap', '8', '--force-unsafe-video-memory');
  }
  return args;
}

/** mlxgen --json-events 的一行(纯函数);非 JSON 或没有进度字段则忽略 */
export function parseSeedVrEvent(line: string): { phase?: string; progress?: number; step?: number; total?: number } | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const ev = JSON.parse(t) as { phase?: unknown; progress?: unknown; step?: unknown; total_steps?: unknown };
    const phase = typeof ev.phase === 'string' ? ev.phase : undefined;
    const progress = typeof ev.progress === 'number' && Number.isFinite(ev.progress) ? ev.progress : undefined;
    const step = typeof ev.step === 'number' && Number.isFinite(ev.step) ? ev.step : undefined;
    const total = typeof ev.total_steps === 'number' && Number.isFinite(ev.total_steps) ? ev.total_steps : undefined;
    if (!phase && progress == null && step == null) return null;
    return { phase, progress, step, total };
  } catch {
    return null;
  }
}

const SEEDVR_PHASE_LABEL: Record<string, string> = {
  start: '加载 SeedVR2',
  load: '加载 SeedVR2',
  denoise: 'SeedVR2 修复',
  decode: '解码',
  save: '写出视频',
  complete: '完成',
};

/** 登录 shell 里找 mlxgen(Electron 的 PATH 常常没有 ~/.local/bin) */
export function resolveMlxgenBin(): string | undefined {
  const override = process.env.BIGBOTART_MLXGEN_BIN?.trim();
  if (override) return existsSync(override) ? override : undefined;
  try {
    const out = execFileSync('sh', ['-lc', 'command -v mlxgen'], { encoding: 'utf-8', timeout: 5000 }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** 默认 3B 8bit 包在 HF 缓存里是否真有权重(符号链接能解析、体积 > 1MB) */
export function seedvr2WeightsReady(repoId: string = SEEDVR2_VIDEO_MODEL): boolean {
  const hub = process.env.HF_HOME
    ? join(process.env.HF_HOME, 'hub')
    : join(homedir(), '.cache', 'huggingface', 'hub');
  const root = join(hub, `models--${repoId.replace(/[\/:]/g, '--')}`, 'snapshots');
  const walk = (dir: string, depth: number): boolean => {
    if (depth > 4 || !existsSync(dir)) return false;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return false;
    }
    for (const name of names) {
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) {
          if (walk(p, depth + 1)) return true;
        } else if (name.endsWith('.safetensors') && st.size > 1_000_000) {
          return true;
        }
      } catch {
        /* 悬空链接 = 权重没下完 */
      }
    }
    return false;
  };
  return walk(root, 0);
}

/** 后处理脚本启动参数(纯函数便于单测):cwd 固定到 GFPGAN 根(facexlib 相对权重目录依赖它) */
export function buildPostSpawn(
  inputPath: string,
  outputPath: string,
  n: NormalizedVideoPost,
  opts?: { python?: string; script?: string; gfpganRoot?: string },
): { cmd: string; args: string[]; cwd: string } {
  return {
    cmd: opts?.python ?? TOOL_PATHS.python,
    args: [opts?.script ?? TOOL_PATHS.postScript, ...buildPostArgs(inputPath, outputPath, n)],
    cwd: opts?.gfpganRoot ?? TOOL_PATHS.gfpganRoot,
  };
}

/** 脚本进度行解析(纯函数):`PROGRESS <stage> <done> <total>` */
export function parsePostProgress(line: string): { stage: string; done: number; total: number } | null {
  const m = /^PROGRESS\s+(\S+)\s+(\d+)\s+(\d+)\s*$/.exec(line.trim());
  if (!m) return null;
  const done = Number(m[2]);
  const total = Number(m[3]);
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
  return { stage: m[1]!, done, total };
}

/** 阶段名 → 人读文案 */
export const POST_STAGE_LABEL: Record<string, string> = {
  split: '拆帧',
  superres: '超分',
  facefix: '修脸',
  merge: '拼回',
};

/**
 * 耗时预估(秒,纯函数):POST_PROCESSING.md §8 实测换算 —— 修脸 1.2-1.5s/帧(mps),
 * Real-ESRGAN 单独超分约 0.35s/帧,ffmpeg 去块约 3% 实时。
 * 用于检查器/工具卡给用户一个量级预期(不是精确值)。
 */
export function estimateVideoPostSeconds(durationSec: number, fps: number, n: NormalizedVideoPost): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const frames = durationSec * (fps > 0 ? fps : 24);
  let sec = 0;
  if (n.doFaceFix) sec += frames * 1.35;
  if (n.doSuperRes) sec += frames * 0.35;
  // SeedVR2 3B 官方 5 秒档:1× 约 0.5s/帧,2× 约 3.6s/帧(539s / 149 帧)
  if (n.doSeedVr) sec += frames * (n.scale <= 1 ? 0.6 : 3.6 * (n.scale / 2));
  if (n.deblock) sec += durationSec * 0.05;
  return Math.round(sec);
}

/** 修脸脚本输出行 → 进度(纯函数,便于单测)。脚本按 `  [40/124]` 每 20 帧打印一次。 */
export function parseFaceFixProgress(line: string): { done: number; total: number } | null {
  const m = /\[(\d+)\/(\d+)\]/.exec(line);
  if (!m) return null;
  const done = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
  return { done, total };
}

/** 修脸脚本输出行 → 阶段提示(拆帧/修脸/拼回;纯函数) */
export function parseFaceFixStage(line: string): string | null {
  if (line.includes('拆帧')) return '拆帧中…';
  if (line.includes('修脸:')) return '加载模型…';
  if (line.includes('拼回')) return '拼回视频…';
  if (line.includes('✅ 完成')) return '完成';
  return null;
}

/** 秒 → 人读时长(纯函数,给进度文案用) */
export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}min` : `${m}min${String(r).padStart(2, '0')}s`;
}

/**
 * 心跳计时器:给「不打印进度」的阶段(Real-ESRGAN 的包装脚本只在结束时输出、去块 ffmpeg 也是)
 * 定期上报「已耗时」,让用户确认任务真的在跑,而不是看起来卡死/瞬间完成。
 * onTick 收到 detail 文案(如「已 1min20s」),由调用方换算成整体进度。
 */
function startHeartbeat(
  _label: string,
  onProgress: ((p: VideoPostProgress) => void) | undefined,
  onTick: (detail: string) => void,
): () => void {
  if (!onProgress) return () => undefined;
  const t0 = Date.now();
  const timer = setInterval(() => {
    onTick(`已 ${fmtDur((Date.now() - t0) / 1000)}`);
  }, 10_000);
  // 不阻塞进程退出
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

/* ────────────────────────── 工具链探测 ────────────────────────── */

/** 探测工具链是否就绪(检查器提示;不触发任何真实推理) */
export function probeVideoPostTooling(): VideoPostTooling {
  const missing: string[] = [];
  const exists = (p: string): boolean => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  };
  const scriptOk = exists(TOOL_PATHS.postScript);
  if (!scriptOk) missing.push(`后处理脚本缺失(${TOOL_PATHS.postScript})`);
  const pythonOk = exists(TOOL_PATHS.python);
  if (!pythonOk) missing.push('后处理 Python 环境缺失(~/venvs/superres)');
  // PyTorch 版超分权重(.pth)—— ncnn 的 .bin/.param 不能给 PyTorch 用
  const srWeights: Record<string, boolean> = {};
  for (const [model, file] of Object.entries(SR_WEIGHT_FILES)) {
    srWeights[model] = exists(join(TOOL_PATHS.weightsDir, file));
  }
  const gfpganWeight = exists(join(TOOL_PATHS.weightsDir, 'GFPGANv1.4.pth'));
  if (!gfpganWeight) missing.push('GFPGAN 权重缺失(GFPGANv1.4.pth)');
  const codeformerWeight = exists(join(TOOL_PATHS.weightsDir, 'codeformer.pth'));
  if (!codeformerWeight) missing.push('CodeFormer 权重缺失(codeformer.pth)');
  const mlxgenPath = resolveMlxgenBin();
  const mlxgen = Boolean(mlxgenPath);
  if (!mlxgen) missing.push('mlxgen 未安装(SeedVR2 视频超分需要)');
  const seedvr2 = seedvr2WeightsReady();
  if (!seedvr2) missing.push(`SeedVR2 权重未就绪(${SEEDVR2_VIDEO_MODEL})`);
  // facexlib 检测/parsing 权重:缺了不会报错,但会触发联网下载(国内链路极慢,表现为卡住)
  const fxDir = facexlibWeightsDir();
  const fxMissing = FACEXLIB_WEIGHT_FILES.filter((f) => !exists(join(fxDir, f)));
  if (fxMissing.length > 0 && exists(TOOL_PATHS.gfpganRoot)) {
    // 有本地副本可自动补齐 → 不算致命,但提前告知(运行时会自动拷)
    const canHeal = missingFacexlibWeights().length === fxMissing.length;
    if (!canHeal) missing.push(`facexlib 权重缺失(${fxMissing.join(', ')})— 首次运行会联网下载,建议按 POST_PROCESSING.md §2.2 手动放置`);
  }
  return {
    realesrgan: scriptOk, // 兼容旧字段名:现在指「PyTorch 后处理链是否就绪」
    realesrganPath: scriptOk ? TOOL_PATHS.postScript : undefined,
    faceFixScript: scriptOk,
    faceFixPath: scriptOk ? TOOL_PATHS.postScript : undefined,
    python: pythonOk,
    pythonPath: pythonOk ? TOOL_PATHS.python : undefined,
    gfpganWeight,
    codeformerWeight,
    ffmpeg: true, // ffmpeg/ffprobe 在 frames.ts/stitch.ts 已是既有硬依赖
    mlxgen,
    mlxgenPath,
    seedvr2,
    missing,
  };
}

/** 提交前防呆:所选参数所需的工具是否齐备(缺啥报啥,不让用户白等几分钟) */
export function checkToolingFor(n: NormalizedVideoPost, t: VideoPostTooling): string | null {
  if (n.doSuperRes || n.doFaceFix) {
    if (!t.faceFixScript) return `后处理脚本未就绪:${TOOL_PATHS.postScript} 不存在`;
    if (!t.python) return '后处理 Python 环境未就绪:~/venvs/superres/bin/python 不存在';
  }
  if (n.doSuperRes) {
    // PyTorch 版必须用 .pth 权重(ncnn 的 .bin/.param 读不了)
    const file = SR_WEIGHT_FILES[n.srModel];
    const w = file ? join(TOOL_PATHS.weightsDir, file) : '';
    if (w && !existsSync(w)) {
      return `超分权重未就绪:${w} 不存在(PyTorch 版需 .pth;首次运行会自动尝试下载)`;
    }
  }
  if (n.doFaceFix) {
    if (n.faceModel === 'gfpgan' && !t.gfpganWeight) return 'GFPGAN 权重未就绪:~/ai/weights/GFPGANv1.4.pth 不存在';
    if (n.faceModel === 'codeformer' && !t.codeformerWeight) return 'CodeFormer 权重未就绪:~/ai/weights/codeformer.pth 不存在';
  }
  if (n.doSeedVr) {
    if (!t.mlxgen) return 'mlxgen 未就绪:SeedVR2 视频超分需要 mlxgen(在 mlx-gen 仓库执行 uv tool install --editable .)';
    if (n.seedvrModel === SEEDVR2_VIDEO_MODEL && !t.seedvr2) {
      return `SeedVR2 权重未就绪:请在设置页下载 ${SEEDVR2_VIDEO_MODEL},或执行 mlxgen download --model ${SEEDVR2_VIDEO_MODEL}`;
    }
  }
  return null;
}

/**
 * 阶段计划 + 权重(纯函数可测逻辑在 estimateVideoPostSeconds;这里需要真实时长/帧率)。
 *
 * 权重直接取「该阶段预估耗时(秒)」,这样整体进度条与真实时间消耗成正比 ——
 * 否则修脸(占 80% 时间)与去块(几秒)各占 1/3 权重时,进度条会在开头猛涨然后长时间不动。
 */
export function buildStagePlan(n: NormalizedVideoPost, inputPath: string): VideoPostStagePlanItem[] {
  const meta = probeVideo(inputPath);
  const dur = meta.durationSec ?? 0;
  const fps = meta.fps && meta.fps > 0 ? meta.fps : 24;
  const frames = dur * fps;
  const plan: VideoPostStagePlanItem[] = [];
  if (n.deblock) {
    // ffmpeg 重编码:约 3-5% 实时,给个下限避免权重为 0
    plan.push({ kind: 'deblock', label: '去块', weight: Math.max(2, dur * 0.15) });
  }
  if (n.doSeedVr) {
    const per = n.scale <= 1 ? 0.6 : 3.6 * (n.scale / 2);
    plan.push({ kind: 'seedvr', label: `SeedVR2 ×${n.scale}`, weight: Math.max(8, frames * per) });
  } else if (n.doSuperRes) {
    plan.push({ kind: 'superres', label: `超分 ×${n.scale}`, weight: Math.max(3, frames * 0.35) });
  }
  if (n.doFaceFix) {
    // 修脸最重:每帧 1.35s(含拆帧/拼回开销,再补 3s 固定开销)
    plan.push({ kind: 'facefix', label: '修脸', weight: Math.max(5, frames * 1.35 + 3) });
  }
  if (plan.length === 0) plan.push({ kind: 'deblock', label: '重编码', weight: 1 });
  return plan;
}

/* ────────────────────────── 执行 ────────────────────────── */

/** 阶段进度(不含 nodeId —— nodeId 由 IPC 层补上;与共享契约 VideoPostProgressEvent 同源) */
export type VideoPostProgress = Omit<VideoPostProgressEvent, 'nodeId'>;

/** 阶段权重(按耗时占比给整体进度加权;粗估即可,目的是跨阶段单调递增) */
export interface VideoPostStagePlanItem {
  kind: 'deblock' | 'superres' | 'seedvr' | 'facefix';
  label: string;
  weight: number;
}

export interface VideoPostOptions {
  onProgress?: (p: VideoPostProgress) => void;
  signal?: AbortSignal;
}

/**
 * 整体进度换算器 —— 跨阶段单调递增的**单一真源**。
 *
 * 为什么必须收敛到一个类(真实回归,2026-09 由单调性测试抓到):
 * 打底后处理是「去块 → 超分 → 修脸」三段,但子脚本一条命令里跑完超分+修脸,
 * 期间还会穿插 split/merge 这类**无独立权重**的纯 I/O 阶段。此前进度有**两个**
 * 各自记账的来源:
 *   - 子脚本进度行(PROGRESS superres …):按 stageIdxOf 查真实阶段索引算 overall
 *   - 心跳(每 10s 一次,让 UI 知道还活着):却按一个只在 completeStage() 里自增的
 *     stageIndex 算,且读的是另一个从没被进度行写过的 stagePeak
 * 两者状态不共享,于是心跳一旦插进超分阶段的中途,就会用陈旧索引 + 归零的峰值
 * 重算,把已经涨到 42% 的进度打回该阶段前缀值 —— 表现就是同一阶段内「42% → 0%」。
 * 负载越高心跳插入越频繁,越容易复现(第一次全量跑碰巧没暴露)。
 *
 * 现在所有上报都经 `report()`,内部维护 `peak`(全局单调下界)与 `stagePeak`
 * (当前阶段内峰值),任何来源都不可能把 overall 往回拽。
 */
export class ProgressTracker {
  /** 全局单调下界:任何一次上报的 overall 都不会低于它 */
  private peak = 0;
  /** 已完成阶段累计权重 */
  private finished = 0;
  private stageIndex = 0;

  constructor(
    private readonly plan: VideoPostStagePlanItem[],
    private readonly push: (p: VideoPostProgress) => void,
    private readonly totalWeight: number,
  ) {}

  /** 当前阶段在整体里的权重前缀(之前所有阶段权重之和) */
  private prefixOf(index: number): number {
    return this.plan.slice(0, index).reduce((a, x) => a + x.weight, 0);
  }

  private clamp(overall: number): number {
    // 卡在 1 之前:最后阶段完成前不给 100%,避免「到了 100% 却还在跑」
    const bounded = Math.max(0, Math.min(0.999, overall));
    this.peak = Math.max(this.peak, bounded);
    return this.peak;
  }

  /**
   * 上报一次进度。
   * @param stageLabel 展示用阶段名
   * @param detail     阶段内明细(如「超分 ×2 12/124 帧」)
   * @param weightsDone 已完成阶段的累计权重;不传则用内部计数(completeStage 维护)
   * @param stageFirst 该阶段在 plan 里的索引起点;不传则用内部 stageIndex
   * @param within     阶段内进度 0-1;**undefined 表示「只更新文案,推进度按当前下界」**
   */
  report(opts: {
    stageLabel: string;
    detail?: string;
    overallHint?: number;
    stageProgress?: number;
    stagesDone?: number;
    stagesTotal?: number;
  }): void {
    this.push({
      stageLabel: opts.stageLabel,
      detail: opts.detail,
      overall: this.clamp(opts.overallHint ?? this.peak),
      stageProgress: opts.stageProgress,
      stagesDone: opts.stagesDone ?? this.stageIndex,
      stagesTotal: opts.stagesTotal ?? this.plan.length,
    });
  }

  /** 按「第 index 阶段完成了 within 比例」换算整体进度(超分/修脸这种有权重阶段用)。
   *  返回值恒为 0-1 的比例（权重和要除以总权重；调用方直接交给 report 即可）。 */
  overallAt(index: number, within: number): number {
    const w = this.plan[index]?.weight ?? 0;
    const ratio = this.clamp01(within);
    return (this.prefixOf(index) + w * ratio) / this.totalWeight;
  }

  /** 不经过外部换算,直接给一个不低于当前下界的 overall(纯文案更新 / 无权重阶段用) */
  currentOverall(): number {
    return this.peak;
  }

  /** 标记当前阶段完成:累计权重、推进索引(后续阶段自然拿到更高前缀) */
  completeStage(): void {
    this.finished += this.plan[this.stageIndex]?.weight ?? 0;
    this.stageIndex += 1;
  }

  get doneWeight(): number {
    return this.finished;
  }

  get currentStage(): number {
    return this.stageIndex;
  }

  get total(): number {
    return this.totalWeight;
  }

  private clamp01(v: number): number {
    return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  }

  /** 推到 100%(全流程结束;前面的上报都压在 0.999) */
  finish(stageLabel: string, detail?: string): void {
    this.peak = 1;
    this.push({
      stageLabel,
      detail,
      overall: 1,
      stageProgress: 1,
      stagesDone: this.plan.length,
      stagesTotal: this.plan.length,
    });
  }
}

/** 全局串行链:视频后处理同在一条链上排队(单个任务已吃满 GPU/CPU,并行只会互相拖垮) */
let postChain: Promise<unknown> = Promise.resolve();

/** 当前运行中的子进程(取消用) */
const liveChildren = new Set<ChildProcess>();

/**
 * 每个在排队或运行中的增强任务一个 AbortController。
 * 同一节点可能还有排在串行链后面的下一次,所以按 nodeId 存一组,取消时整组中止。
 * 检查器「取消」走这里:只 abort 信号,由 runChild 去 SIGTERM 对应子进程,
 * 不会误杀别的节点正在跑的进程。
 */
const runControllers = new Map<string, Set<AbortController>>();

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

/**
 * 运行中的后处理任务(主进程真源)。
 * 渲染层的「运行中」标记是组件本地 state,退出画布再进入就丢了 ——
 * 所以状态必须由主进程持有,渲染层挂载时来查(videoPostRunning IPC)。
 */
const runningRuns = new Map<string, { nodeId: string; startedAt: string; stage?: string }>();

/** 查询当前在跑的后处理任务(渲染层挂载时恢复运行态用) */
export function listRunningVideoPost(): Array<{ nodeId: string; startedAt: string; stage?: string }> {
  return [...runningRuns.values()];
}

/** 最近一次进度(供渲染层刚挂载时立刻拿到阶段文案,而不必等下一个 tick) */
export function lastVideoPostProgress(): { nodeId: string; stageLabel: string; detail?: string } | null {
  return lastProgress;
}

let lastProgress: { nodeId: string; stageLabel: string; detail?: string } | null = null;

/** 取消所有在跑的后处理子进程(主进程退出) */
export function cancelAllVideoPost(): void {
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

/**
 * 取消一次视频增强。
 * 给定 nodeId 只停该节点(含已排队、尚未拉起子进程的那次);
 * 不给 nodeId 则停掉全部。没有对应任务时返回失败,避免界面把「没在跑」当成已取消。
 */
export function cancelVideoPost(nodeId?: string): { ok: boolean; error?: string } {
  if (!nodeId) {
    if (runControllers.size === 0 && liveChildren.size === 0) {
      return { ok: false, error: '没有正在进行的增强' };
    }
    cancelAllVideoPost();
    return { ok: true };
  }
  const set = runControllers.get(nodeId);
  if (!set || set.size === 0) return { ok: false, error: '该节点没有正在进行的增强' };
  for (const ac of set) ac.abort();
  return { ok: true };
}

/**
 * 视频增强主入口:按 去块 → 超分 → 修脸 顺序执行,返回最终产物路径。
 * 中间产物写在 video-post/tmp-<ts>/ 下的临时文件,全部成功后才产出最终 mp4
 * (任一步失败 → 直接返回错误,不留半成品)。
 */
export function videoUpscale(
  req: VideoUpscaleRequest,
  opts: VideoPostOptions = {},
): Promise<VideoUpscaleResult> {
  const nodeId = String(req.nodeId ?? '');
  // 控制器在入队时就建好:用户在「准备中」点取消,排在链上还没 spawn 的任务也能停。
  const ac = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  const key = nodeId || `__anon-${Date.now()}`;
  trackRun(key, ac);
  const run = postChain.then(() => doVideoUpscale(req, { ...opts, signal: ac.signal }));
  postChain = run.catch(() => undefined);
  // 无论成功/失败/取消,都要注销运行态 —— 否则运行中标记会永远残留,
  // 让节点再也无法重新发起(比"能重复点"更糟)。finally 覆盖全部 return 分支。
  return run.finally(() => {
    untrackRun(key, ac);
    if (nodeId) {
      runningRuns.delete(nodeId);
      if (lastProgress?.nodeId === nodeId) lastProgress = null;
    }
  });
}

async function doVideoUpscale(
  req: VideoUpscaleRequest,
  opts: VideoPostOptions,
): Promise<VideoUpscaleResult> {
  const started = Date.now();
  const inputPath = String(req.inputPath ?? '');
  const n = normalizeVideoPost(req);
  const stages = planVideoPostStages(n);
  const runNodeId = String(req.nodeId ?? '');
  if (runNodeId) {
    runningRuns.set(runNodeId, { nodeId: runNodeId, startedAt: new Date().toISOString() });
  }

  if (!inputPath) return { ok: false, error: '输入视频路径为空' };
  if (!existsSync(inputPath)) return { ok: false, error: `输入视频不存在:${inputPath}` };
  // 只允许产物/资产/项目目录下的视频,防任意读(与 frames.ts 取帧同口径)
  const roots = ffmpegReadRoots();
  if (!roots.some((r) => isUnderRoot(inputPath, r))) {
    return { ok: false, error: '视频不在允许目录(产物/资产/项目目录),拒绝处理' };
  }
  const tooling = probeVideoPostTooling();
  const toolErr = checkToolingFor(n, tooling);
  if (toolErr) return { ok: false, error: toolErr };

  if (opts.signal?.aborted) return { ok: false, error: '已取消' };

  try {
    mkdirSync(VIDEO_POST_DIR, { recursive: true });
  } catch {
    /* 交给后续 spawn 报错 */
  }

  const base = basename(inputPath, extname(inputPath)) || 'video';
  const prefix = String(req.outputName ?? base).replace(/[/\\]/g, '_');
  const stamp = Date.now();
  // 单阶段无中间文件时直接写最终路径;多阶段中间产物写 tmp 目录
  const workDir = join(VIDEO_POST_DIR, `tmp-${stamp}`);
  const finalPath = join(VIDEO_POST_DIR, `${prefix}-post-${stamp}.mp4`);
  try {
    if (n.deblock || ((n.doSuperRes || n.doSeedVr) && n.doFaceFix)) mkdirSync(workDir, { recursive: true });
  } catch (e) {
    return { ok: false, error: `无法创建临时目录:${(e as Error).message}` };
  }

  let cur = inputPath;
  const applied: string[] = [];

  /* ── 整体进度:按各阶段预估耗时加权 ──
     只报「单阶段百分比」会让进度条在阶段切换时从 100% 退回 0(用户看到「不对」),
     故这里统一换算成跨阶段单调递增的整体进度,并给出阶段序号 N/M。 */
  const plan = buildStagePlan(n, inputPath);
  const totalWeight = plan.reduce((a, x) => a + x.weight, 0) || 1;
  /** 包一层:记录最近进度(runningRuns.stage + lastProgress),供渲染层恢复显示 */
  const emitProgress = (ev: VideoPostProgress): void => {
    if (runNodeId) {
      const cur = runningRuns.get(runNodeId);
      if (cur) cur.stage = ev.stageLabel;
      lastProgress = { nodeId: runNodeId, stageLabel: ev.stageLabel, detail: ev.detail };
    }
    opts.onProgress?.(ev);
  };
  /* 进度统一走 ProgressTracker(单一真源,全局单调不减)。
     ⚠️ 不要再另起一套 stageIndex/stagePeak 记账:心跳与进度行状态不共享时,
     心跳会按陈旧索引重算并把进度往回拽(真实回归,见 ProgressTracker 类注释)。 */
  const tracker = new ProgressTracker(plan, emitProgress, totalWeight);
  const emit = (stageLabel: string, detail: string | undefined, stageProgress: number | undefined): void => {
    tracker.report({
      stageLabel,
      detail,
      overallHint:
        stageProgress === undefined
          ? tracker.currentOverall()
          : tracker.overallAt(tracker.currentStage, stageProgress),
      stageProgress,
    });
  };
  const completeStage = (): void => tracker.completeStage();

  /* ① 去块(可选):ffmpeg deblock + 高码率重编码。
     必须在超分前 —— 先去掉 h264 压缩块,否则会被超分放大成方格。 */
  if (n.deblock) {
    const label = '去块';
    emit(label, '重编码中…', undefined);
    const stopDeblockBeat = startHeartbeat(label, opts.onProgress, (s2) => emit(label, s2, undefined));
    const out = join(workDir, `deblock-${stamp}.mp4`);
    const args = [
      '-y', '-i', cur,
      '-vf', buildDeblockVf(),
      '-c:v', 'libx264', '-crf', String(n.deblockCrf), '-preset', 'slow',
      '-c:a', 'copy', '-movflags', '+faststart', out,
    ];
    const r = await runChild('ffmpeg', args, opts.signal);
    stopDeblockBeat();
    if (!r.ok) return childFailure('去块失败', r.error);
    if (opts.signal?.aborted) return { ok: false, error: '已取消' };
    cur = out;
    applied.push(`去块(CRF ${n.deblockCrf})`);
    completeStage();
  }

  /* ②a SeedVR2:mlxgen 整段视频超分/修复,保留源音轨。
     后面还要修脸时先写临时文件,避免 PyTorch 管线覆盖未完成产物。 */
  if (n.doSeedVr) {
    const bin = tooling.mlxgenPath || resolveMlxgenBin();
    if (!bin) return { ok: false, error: 'mlxgen 未就绪:SeedVR2 视频超分需要 mlxgen' };
    const label = `SeedVR2 ×${n.scale}`;
    emit(label, '加载模型…', undefined);
    const out = n.doFaceFix ? join(workDir, `seedvr-${stamp}.mp4`) : finalPath;
    const seedIdx = plan.findIndex((it) => it.kind === 'seedvr');
    const runStart = Date.now();
    let lastDetail = '加载模型…';
    const onLine = (line: string): void => {
      const ev = parseSeedVrEvent(line);
      if (!ev) return;
      const within =
        ev.total && ev.total > 0 && ev.step != null
          ? Math.min(1, ev.step / ev.total)
          : ev.progress != null
            ? Math.min(1, Math.max(0, ev.progress))
            : undefined;
      const phase = SEEDVR_PHASE_LABEL[ev.phase ?? ''] ?? ev.phase ?? 'SeedVR2';
      lastDetail = ev.step != null && ev.total ? `${phase} ${ev.step}/${ev.total}` : phase;
      const elapsed = Math.round((Date.now() - runStart) / 1000);
      tracker.report({
        stageLabel: label,
        detail: `${lastDetail} · 已 ${fmtDur(elapsed)}`,
        overallHint: within == null ? tracker.currentOverall() : tracker.overallAt(seedIdx >= 0 ? seedIdx : tracker.currentStage, within),
        stageProgress: within,
        stagesDone: seedIdx >= 0 ? seedIdx : tracker.currentStage,
      });
    };
    const stopBeat = startHeartbeat(label, opts.onProgress, (s2) => {
      tracker.report({ stageLabel: label, detail: `${lastDetail} · ${s2}` });
    });
    const r = await runChild(bin, buildSeedVrVideoArgs(cur, out, n), opts.signal, undefined, undefined, onLine);
    stopBeat();
    if (!r.ok) return childFailure('SeedVR2 超分失败', r.error);
    if (opts.signal?.aborted) return { ok: false, error: '已取消' };
    if (!existsSync(out)) return { ok: false, error: 'SeedVR2 退出成功但未找到产物文件' };
    cur = out;
    applied.push(`SeedVR2 ×${n.scale}(${n.seedvrModel})`);
    completeStage();
  }

  /* ②+③ 超分 + 修脸:同一条 PyTorch 管线(基础脚本 video_post.py)。
     合并的意义:只拆一次帧、只拼一次回。
     SeedVR2 已经放大过时,这里只修脸(scale 固定 1,不再跑 Real-ESRGAN)。 */
  const torchN = n.doSeedVr ? faceOnlyAfterSeedVr(n) : n;
  if (torchN.doSuperRes || torchN.doFaceFix) {
    ensureFacexlibWeights(); // facexlib 检测/parsing 权重兜底(缺失会触发联网慢下)
    const spawnInfo = buildPostSpawn(cur, finalPath, torchN);
    const runStart = Date.now();
    // 脚本按 `PROGRESS <stage> <done> <total>` 上报;映射到对应阶段的整体权重
    const stageIdxOf: Record<string, number> = {};
    plan.forEach((it, i) => {
      if (it.kind === 'superres') stageIdxOf.superres = i;
      if (it.kind === 'facefix') stageIdxOf.facefix = i;
    });
    let lastLine = '';
    const onLine = (line: string): void => {
      const pr = parsePostProgress(line);
      if (!pr) return;
      const kind = pr.stage === 'superres' ? 'superres' : pr.stage === 'facefix' ? 'facefix' : null;
      const label0 = POST_STAGE_LABEL[pr.stage] ?? pr.stage;
      if (kind) {
        // 真实阶段索引(不能用 tracker.currentStage:合并管线里超分/修脸是**同一条命令**
        // 跑完的,completeStage 未必在此刻已推进)
        const idx = stageIdxOf[kind] ?? tracker.currentStage;
        const label = kind === 'superres' ? `超分 ×${torchN.scale}` : torchN.faceModel === 'gfpgan' ? '修脸 GFPGAN' : '修脸 CodeFormer';
        const within = pr.total > 0 ? pr.done / pr.total : 0;
        const elapsed = Math.round((Date.now() - runStart) / 1000);
        const doneFrames = pr.done;
        const eta = doneFrames > 0 ? Math.round((elapsed / doneFrames) * (pr.total - doneFrames)) : 0;
        const text =
          pr.stage === 'split'
            ? `拆帧 ${pr.done}/${pr.total}`
            : `${label0} ${pr.done}/${pr.total} 帧 · 已 ${fmtDur(elapsed)}${eta > 0 ? ` / 剩 ${fmtDur(eta)}` : ''}`;
        lastLine = text;
        // overallAt 内部按全局下界钳制 → 阶段回环(超分→修脸→再超分)也不会回退
        tracker.report({
          stageLabel: label,
          detail: text,
          overallHint: tracker.overallAt(idx, within),
          stageProgress: within,
          stagesDone: idx,
        });
      } else {
        // split / merge:自身无独立权重(纯 I/O),沿用当前下界,绝不重算
        tracker.report({ stageLabel: label0, detail: `${pr.done}/${pr.total}` });
      }
    };
    // 心跳只更新文案:进度取当前下界,不再按 stageIndex/stagePeak 重算
    // (真实回归:重算会用陈旧索引把超分阶段的 42% 打回 0%)
    const stopBeat = startHeartbeat('处理中', opts.onProgress, (s2) => {
      tracker.report({
        stageLabel: lastLine ? lastLine.split(' ')[0]! : plan[tracker.currentStage]?.label ?? '处理中',
        detail: `${lastLine ? `${lastLine} · ` : ''}${s2}`,
      });
    });
    const r = await runChild(spawnInfo.cmd, spawnInfo.args, opts.signal, undefined, spawnInfo.cwd, onLine);
    stopBeat();
    if (!r.ok) return childFailure('超分/修脸失败', r.error);
    if (opts.signal?.aborted) return { ok: false, error: '已取消' };
    if (torchN.doSuperRes) applied.push(`超分 ×${torchN.scale}(${torchN.srModel} · PyTorch)`);
    if (torchN.doFaceFix) {
      applied.push(
        n.faceModel === 'gfpgan' ? `GFPGAN 修脸(强度 ${n.faceWeight})` : `CodeFormer 修脸(保真 ${n.fidelityWeight})`,
      );
    }
    cur = finalPath;
    // 合并阶段:一次跨过剩余所有权重
    // 合并阶段:一次跨过剩余所有权重
    while (tracker.currentStage < plan.length) tracker.completeStage();
  }

  // 全部阶段跑完 → 明确推一次 100%(前面的上报都压在 0.999)
  tracker.finish('完成', '收尾中…');

  // 既没超分也没修脸(理论上仅去块)→ 去块产物即最终产物:搬到 finalPath
  if (cur !== finalPath) {
    try {
      copyFileSync(cur, finalPath);
      try {
        unlinkSync(cur);
      } catch {
        /* 临时文件清理失败不影响产物 */
      }
      cur = finalPath;
    } catch (e) {
      return { ok: false, error: `产出最终文件失败:${(e as Error).message}` };
    }
  }

  if (!existsSync(finalPath)) return { ok: false, error: '处理完成但未找到产物文件' };

  // 清理临时目录(尽力而为)
  cleanupDir(workDir);

  const size = safeSize(finalPath);
  return {
    ok: true,
    path: finalPath,
    stages: applied.length ? applied : stages,
    ...size,
    elapsedSec: Math.round((Date.now() - started) / 1000),
  };
}

/** ffprobe 量产物宽高/时长(失败返回空,不阻断成功结果) */
function safeSize(path: string): { width?: number; height?: number; durationSec?: number } {
  const meta = probeVideo(path);
  return { width: meta.width, height: meta.height, durationSec: meta.durationSec };
}

/** 同步清理临时目录(尽力而为;失败仅是占空间,不影响产物) */
function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

/** 子进程失败:用户取消时原样返回「已取消」,不要再包一层阶段前缀(检查器据此区分取消和失败)。 */
function childFailure(prefix: string, error: string | undefined): VideoUpscaleResult {
  if ((error ?? '').includes('已取消')) return { ok: false, error: '已取消' };
  return { ok: false, error: `${prefix}:${error ?? '未知错误'}` };
}

/** 跑一个子进程,收集 stderr 尾部(失败诊断),支持 AbortSignal 取消与自定义 cwd。
 *  onLine 给定时,逐行回调 stdout+stderr —— 修脸脚本按 `[idx/total]` 打印进度,据此驱动真实进度条
 *  (否则 124 帧 1536² 要跑十几分钟,UI 上「什么都没发生」,看起来像瞬间完成/卡死)。 */
function runChild(
  cmd: string,
  args: string[],
  signal?: AbortSignal,
  extraEnv?: Record<string, string>,
  cwd?: string,
  onLine?: (line: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolveP) => {
    if (signal?.aborted) return resolveP({ ok: false, error: '已取消' });
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        stdio: ['ignore', onLine ? 'pipe' : 'ignore', 'pipe'],
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
        // cwd 关系到 facexlib 相对权重的解析(见 TOOL_PATHS.gfpganRoot 注释),必须显式指定
        ...(cwd ? { cwd } : {}),
      });
    } catch (e) {
      return resolveP({ ok: false, error: `${cmd} 无法启动:${(e as Error).message}` });
    }
    liveChildren.add(child);
    // 监听必须紧挨 spawn:晚挂的话,取消落在这个窗口里子进程会变成孤儿,close 也报不成「已取消」。
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* 已退出 */
      }
      // mlxgen / python 有时不吃 SIGTERM,1.5s 后补 SIGKILL,避免 GPU 一直被占着。
      killTimer = setTimeout(() => {
        try {
          if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
      }, 1500);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    let errAcc = '';
    // onLine:按行切分(stdout 与 stderr 都要 —— 脚本的进度走 stdout,报错走 stderr)
    if (onLine) {
      let buf = '';
      const feed = (d: Buffer): void => {
        buf += d.toString();
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          if (line) onLine(line);
          buf = buf.slice(nl + 1);
          nl = buf.indexOf('\n');
        }
        // 防止无换行的超长输出撑爆缓冲
        if (buf.length > 8192) buf = buf.slice(-1024);
      };
      child.stdout?.on('data', feed);
      child.stderr?.on('data', feed);
    }
    // 只留尾部 8KB,避免长任务(逐帧打印)把内存吃满
    child.stderr?.on('data', (d: Buffer) => {
      errAcc += d.toString();
      if (errAcc.length > 8192) errAcc = errAcc.slice(-8192);
    });
    const done = (r: { ok: boolean; error?: string }) => {
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      liveChildren.delete(child);
      resolveP(r);
    };
    child.on('error', (e) => done({ ok: false, error: `${cmd} 启动失败:${e.message}` }));
    child.on('close', (code) => {
      if (signal?.aborted) return done({ ok: false, error: '已取消' });
      if (code === 0) return done({ ok: true });
      const tail = errAcc.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
      done({ ok: false, error: `${cmd} exit ${code}: ${tail || '未知错误'}` });
    });
  });
}

/** 输入视频元数据(ffprobe):检查器展示时长/分辨率 + 耗时预估用 */
export function probeVideo(inputPath: string): { width?: number; height?: number; durationSec?: number; fps?: number } {
  // 文件不存在时直接返回空 —— 否则 ffprobe 会把报错打到 stderr,污染调用方日志(纯查元数据不该有噪音)
  try {
    if (!inputPath || !existsSync(inputPath)) return {};
  } catch {
    return {};
  }
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', inputPath,
    ], { timeout: 8000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 });
    const j = JSON.parse(out) as {
      streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string }>;
      format?: { duration?: string };
    };
    const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
    const dur = Number(j.format?.duration);
    let fps: number | undefined;
    const rate = v?.r_frame_rate ?? '';
    if (rate.includes('/')) {
      const [num, den] = rate.split('/').map(Number);
      if (num && den) fps = num / den;
    } else if (Number(rate) > 0) fps = Number(rate);
    return {
      width: v?.width,
      height: v?.height,
      durationSec: Number.isFinite(dur) ? Math.round(dur * 10) / 10 : undefined,
      fps,
    };
  } catch {
    return {};
  }
}

/** 产物目录(测试/日志用) */
export function videoPostDir(): string {
  return VIDEO_POST_DIR;
}

/** 输出路径推断(纯函数,测试用):<产物目录>/<前缀>-post-<时间戳>.mp4 */
export function videoPostTarget(inputPath: string, outputName?: string, stamp = Date.now()): string {
  const base = basename(inputPath, extname(inputPath)) || 'video';
  const prefix = String(outputName ?? base).replace(/[/\\]/g, '_');
  return join(VIDEO_POST_DIR, `${prefix}-post-${stamp}.mp4`);
}
