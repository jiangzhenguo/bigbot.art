/**
 * mlxgen-caption 本地通道 —— mlx-gen 的「图片 → 文本」路由(Qwen3-VL,2026-10 引擎新增)
 *
 * 背景:mlx-gen 新增 `mlxgen-caption`(模块 `mflux.models.qwen3_vl_caption.cli.caption`),
 * 用**本地 MLX 格式 Qwen3-VL checkpoint** 做提示词反推,不需要 LM Studio / 任何 server。
 * 此前 vision.caption 只能打 OpenAI 兼容端点(默认 LM Studio :1234),即「LM Studio 没开
 * = Agent 瞎」;本模块把同一份 checkpoint 直接交给引擎进程,补齐这条独立通道。
 *
 * 与 vision.ts 的分工:vision.ts 负责「看图这件事的公共面」(白名单/格式/指令/回退),
 * 本模块只管「怎么把一张图喂给 mlxgen-caption 并把文本取回来」。
 *
 * 三个刻意的取舍:
 *  ① **命令解析带 shebang 回退**:引擎的 console script(`mlxgen-caption`)是新增的,
 *     `uv tool install` 过的旧 venv 里**还没有这个可执行文件**(实测 `command -v mlxgen-caption`
 *     为空)。故按 `mlxgen-caption` → 从 `mlxgen` 的 shebang 反查 venv python 再
 *     `-m mflux.models.qwen3_vl_caption.cli.caption` 两级回退 —— 不要求用户先重装工具。
 *  ② **产物走 `--output` 文件而不是 stdout**:CLI 的 `verbose=True` 会往 stdout/stderr 打
 *     token 统计,直接抓 stdout 会把日志混进提示词。写文件读回,内容确定。
 *  ③ **失败一律显式**:命令缺失/模型目录不存在/非零退出/超时,全部带可执行指引返回,
 *     绝不返回空字符串当成功(AGENTS.md R6)。
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CaptionLocalBinding } from '@bigbotart/shared';

export type { CaptionLocalBinding };

/** 默认 checkpoint:与本机 LM Studio 里那份 caption 微调同名(应用 DEFAULT_VL_MODEL 的同一模型) */
export const DEFAULT_CAPTION_MODEL_DIRS = [
  '.lmstudio/models/gavinmroy/Qwen3-VL-8B-NSFW-Caption-V4.5-affine-4bit',
];

/** 图片 token 预算默认值(引擎 doc 实测:640000 ≈ 800x800,冷启动 4.2s / 峰值 6.3GB) */
export const DEFAULT_CAPTION_MAX_PIXELS = 640_000;
/** 生成长度默认值(引擎 doc:caption 模型卡建议 2048) */
export const DEFAULT_CAPTION_MAX_TOKENS = 1024;
/** 单次反推超时(冷启动加载权重 + prefill;实测 17s,给足余量) */
const DEFAULT_TIMEOUT_MS = 300_000;
/** 引擎模块入口(console script 缺失时的回退路径,见文件头取舍 ①) */
const CAPTION_MODULE = 'mflux.models.qwen3_vl_caption.cli.caption';

/** 一条可执行的 caption 命令:bin + 前置参数(console script 时为空,模块回退时是 -m <module>) */
export interface CaptionCommand {
  bin: string;
  prefixArgs: string[];
  /** 展示用(报错/回显),不参与执行 */
  label: string;
}

export interface MlxgenCaptionConfig {
  cmd: CaptionCommand;
  model: string;
  maxPixels: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface CaptionRunResult {
  ok: boolean;
  caption?: string;
  /** 实际用的 checkpoint(回显给用户/Agent,不是模型名而是目录名) */
  model?: string;
  error?: string;
}

/** 依赖注入点(单测用;生产走默认实现) */
export interface CaptionDeps {
  /** 解析可执行路径(默认 `sh -lc command -v`) */
  which?: (bin: string) => Promise<string | undefined>;
  /** 文件/目录存在性(默认 fs.existsSync) */
  exists?: (p: string) => boolean;
  /** 目录列举(默认 fs.readdirSync) */
  listDir?: (p: string) => string[];
  /** 读取文本文件(默认 fs.readFileSync utf8) */
  readText?: (p: string) => string;
  /** 真正执行(默认 spawn;单测注入假进程,不碰真模型) */
  run?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** 临时目录(默认 os.tmpdir 下建唯一目录) */
  makeTmpDir?: () => string;
  /** 目录判定(默认 fs.statSync().isDirectory();注入后探测不再碰真盘) */
  isDir?: (p: string) => boolean;
}

/* ────────────────────────── 命令解析 ────────────────────────── */

/** `sh -lc command -v <bin>` 的真实实现(与 providers/mlxgen.ts 的探测同口径) */
export async function whichOnPath(bin: string): Promise<string | undefined> {
  try {
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile('sh', ['-lc', `command -v ${bin}`], { timeout: 5000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve({ stdout: String(stdout) });
      });
    });
    const p = stdout.trim();
    return p || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析 `mlxgen-caption` 命令(纯逻辑 + 注入 which/readText,便于单测):
 *  1. `BIGBOTART_CAPTION_BIN` 显式指定(最高优先)
 *  2. PATH 里的 `mlxgen-caption`(新版 uv tool install 才会有)
 *  3. **shebang 回退**:取 `mlxgen` 可执行文件首行的解释器路径,用它跑模块入口
 */
export async function resolveCaptionCommand(
  env: NodeJS.ProcessEnv = process.env,
  deps: CaptionDeps = {},
): Promise<CaptionCommand | undefined> {
  const which = deps.which ?? whichOnPath;
  const readText = deps.readText ?? ((p: string) => readFileSync(p, 'utf8'));
  const exists = deps.exists ?? existsSync;

  const explicit = env.BIGBOTART_CAPTION_BIN?.trim();
  if (explicit) {
    if (!exists(explicit)) return undefined;
    // 显式指定 python 解释器时也支持模块形式(路径含 python 且给了 BIGBOTART_CAPTION_MODULE)
    if (env.BIGBOTART_CAPTION_MODULE) {
      return { bin: explicit, prefixArgs: ['-m', CAPTION_MODULE], label: `${explicit} -m ${CAPTION_MODULE}` };
    }
    return { bin: explicit, prefixArgs: [], label: explicit };
  }

  const direct = await which('mlxgen-caption');
  if (direct) return { bin: direct, prefixArgs: [], label: direct };

  // shebang 回退:mlxgen 存在但 console script 是新的(旧 venv 里没有)
  const mlxgen = await which('mlxgen');
  if (!mlxgen) return undefined;
  try {
    const shebang = readText(mlxgen).split('\n', 1)[0] ?? '';
    const m = /^#!\s*(\S+)/.exec(shebang);
    const python = m?.[1];
    if (!python || !exists(python)) return undefined;
    return { bin: python, prefixArgs: ['-m', CAPTION_MODULE], label: `${mlxgen} → ${python} -m ${CAPTION_MODULE}` };
  } catch {
    return undefined;
  }
}

/* ────────────────────────── checkpoint 发现 ────────────────────────── */

/** 已知 checkpoint 根目录(LM Studio 模型库优先) */
export function captionModelRoots(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const roots = [join(home, '.lmstudio', 'models'), join(home, 'ai', 'models')];
  const extra = env.BIGBOTART_CAPTION_MODEL_ROOTS?.split(':').map((s) => s.trim()).filter(Boolean) ?? [];
  return [...extra, ...roots];
}

/** HF 缓存根(`mlxgen download` 落盘处;`BIGBOTART_HF_HOME` 可覆盖) */
export function hfCacheRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.HF_HUB_CACHE ?? env.BIGBOTART_HF_HOME ?? join(home, '.cache', 'huggingface', 'hub');
}

/** 一个目录是不是可用的 MLX Qwen3-VL checkpoint(config 判族 + 权重真在) */
export function isMlxVlCheckpoint(dir: string, deps: CaptionDeps = {}): boolean {
  const exists = deps.exists ?? existsSync;
  const listDir = deps.listDir ?? ((p: string) => readdirSync(p) as string[]);
  const readText = deps.readText ?? ((p: string) => readFileSync(p, 'utf8'));
  const cfg = join(dir, 'config.json');
  if (!exists(cfg)) return false;
  try {
    const parsed = JSON.parse(readText(cfg)) as Record<string, unknown>;
    const type = String(parsed.model_type ?? '');
    const arch = Array.isArray(parsed.architectures) ? parsed.architectures.join(',') : String(parsed.architectures ?? '');
    // 只看目录名会把别的东西认进来;必须是 Qwen3-VL 家族(引擎只认 dense Qwen3-VL)
    if (!/qwen3[_-]?vl/i.test(`${type},${arch}`)) return false;
  } catch {
    return false;
  }
  // 权重要真在:config/分词器齐但 safetensors 缺的目录是「下了一半」
  if (exists(join(dir, 'model.safetensors.index.json'))) return true;
  try {
    return listDir(dir).some((f) => f.endsWith('.safetensors'));
  } catch {
    return false;
  }
}


/**
 * 扫描本机 MLX 格式 Qwen3-VL checkpoint,三处:
 *  ① `<root>/<publisher>/<model>`(LM Studio 模型库 / ~/ai/models)
 *  ② HF 缓存 `<hub>/models--<org>--<name>/snapshots/<sha>/`(`mlxgen download` 落盘处)
 * 判定依据是 `config.json` 的 model_type/architectures + 权重存在。
 */
export function discoverCaptionModels(
  env: NodeJS.ProcessEnv = process.env,
  deps: CaptionDeps = {},
  home = homedir(),
): string[] {
  const exists = deps.exists ?? existsSync;
  const listDir = deps.listDir ?? ((p: string) => readdirSync(p) as string[]);
  const found: string[] = [];
  for (const root of captionModelRoots(env, home)) {
    if (!exists(root)) continue;
    let publishers: string[];
    try {
      publishers = listDir(root);
    } catch {
      continue;
    }
    for (const pub of publishers) {
      const pubDir = join(root, pub);
      let models: string[];
      try {
        models = listDir(pubDir);
      } catch {
        continue;
      }
      for (const name of models) {
        const dir = join(pubDir, name);
        if (isMlxVlCheckpoint(dir, deps)) found.push(dir);
      }
    }
  }
  // HF 缓存:snapshots 下的实体目录(软链到 blobs,引擎按目录读即可)
  // 整段包 try/catch:缓存目录权限异常/半删除状态不该让「自动发现」整体抛错
  try {
    const hub = hfCacheRoot(env, home);
    if (exists(hub)) {
      for (const repo of listDir(hub).filter((d) => d.startsWith('models--'))) {
        const snaps = join(hub, repo, 'snapshots');
        if (!exists(snaps)) continue;
        for (const sha of listDir(snaps)) {
          const dir = join(snaps, sha);
          if (isMlxVlCheckpoint(dir, deps)) found.push(dir);
        }
      }
    }
  } catch {
    /* 缓存不可读 → 只跳过这一处来源,不影响 LM Studio 目录的发现结果 */
  }
  // caption 微调优先(提示词反推质量最好),其余按发现顺序
  return [...new Set(found)].sort((a, b) => Number(/caption/i.test(b)) - Number(/caption/i.test(a)));
}

/** 名字归一化(用于「裸模型名 → 本机 checkpoint」反查):只留小写字母数字 */
export function normalizeModelName(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** 解析结果:带上**失败原因**,让上层能把「为什么用不了」说清楚(而不是笼统报不可用) */
export type CaptionResolution = { ok: true; config: MlxgenCaptionConfig } | { ok: false; reason: string };

/**
 * 解析一份可用的本地 caption 配置(带原因版;vision.ts 用它把真因讲清楚)。
 *
 * `model` 三种合法写法 —— 真实事故(2026-10-12):用户在设置页把 **LM Studio 的模型名**
 * `qwen3-vl-8b-nsfw-caption-v4.5-affine` 填了进来,那既不是路径也不是仓库 id,
 * 直接丢给引擎必然失败(`MLX-Gen will not download model files during generation`)。
 * 故三种都认:
 *  1. **绝对路径**:必须是合格 MLX Qwen3-VL 目录(不合格给出具体原因,不笼统说不可用);
 *  2. **`owner/name` 仓库 id**:交给引擎去本地缓存找;
 *  3. **裸名字**(LM Studio 模型名/展示名):按归一化子串反查本机已发现的 checkpoint,
 *     命中就用那个目录 —— 把最常见的误填变成能跑,而不是逼用户猜格式;
 *  4. 留空 = 自动发现(caption 微调优先)。
 */
export async function resolveCaptionConfigDetailed(
  env: NodeJS.ProcessEnv = process.env,
  binding?: CaptionLocalBinding,
  deps: CaptionDeps = {},
): Promise<CaptionResolution> {
  const cmd = await resolveCaptionCommand(env, deps);
  if (!cmd) {
    return { ok: false, reason: `${captionCommandHint()};本机当前也没有可回退的 mlxgen` };
  }
  const exists = deps.exists ?? existsSync;
  const discovered = discoverCaptionModels(env, deps);
  const explicit = binding?.model?.trim() || env.BIGBOTART_CAPTION_MODEL?.trim();

  let model: string | undefined;
  if (!explicit) {
    model = discovered[0];
    if (!model) {
      return {
        ok: false,
        reason:
          '本机没有找到 MLX 格式的 Qwen3-VL checkpoint(自动发现范围:~/.lmstudio/models、~/ai/models、HF 缓存 snapshots)。' +
          '请先下 Qwen3-VL 8B caption(应用内「模型下载」或在 LM Studio 里下),或把模型目录路径填到本行',
      };
    }
  } else if (explicit.startsWith('/')) {
    if (!exists(explicit)) {
      return { ok: false, reason: `填的模型目录不存在:${explicit}(路径写错,或模型已被删除/移动)` };
    }
    if (!isMlxVlCheckpoint(explicit, deps)) {
      return {
        ok: false,
        reason:
          `目录存在但不是合格的 MLX 格式 dense Qwen3-VL checkpoint:${explicit}` +
          '(要求 config.json 的 model_type/architectures 属于 Qwen3-VL 且 safetensors 权重真在;' +
          'torch/HF 原始布局、MoE qwen3_vl_moe、下了一半的目录都会被拒)',
      };
    }
    model = explicit;
  } else if (explicit.includes('/')) {
    model = explicit; // 仓库 id:交给引擎去本地缓存找
  } else {
    const norm = normalizeModelName(explicit);
    const hit = discovered.find((p) => {
      const base = normalizeModelName(p.split('/').filter(Boolean).pop() ?? '');
      return Boolean(norm) && (base.includes(norm) || norm.includes(base));
    });
    if (!hit) {
      const cands = discovered.length ? `本机已发现:${discovered.join(', ')}` : '本机未发现任何 MLX Qwen3-VL checkpoint';
      return {
        ok: false,
        reason:
          `「${explicit}」既不是目录路径也不是仓库 id,按模型名反查也没匹配到本机 checkpoint。${cands}。` +
          '请填 **checkpoint 目录的绝对路径** 或 **owner/name 仓库 id**,留空则自动发现',
      };
    }
    model = hit;
  }

  const num = (v: unknown, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
  };
  return {
    ok: true,
    config: {
      cmd,
      model,
      maxPixels: num(binding?.maxPixels ?? env.BIGBOTART_CAPTION_MAX_PIXELS, DEFAULT_CAPTION_MAX_PIXELS),
      maxTokens: num(binding?.maxTokens ?? env.BIGBOTART_CAPTION_MAX_TOKENS, DEFAULT_CAPTION_MAX_TOKENS),
      timeoutMs: num(env.BIGBOTART_CAPTION_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    },
  };
}

/**
 * 解析一份可用的本地 caption 配置(兼容签名:不可用 → undefined)。
 * 绑定 model > `BIGBOTART_CAPTION_MODEL` > 本机自动发现。
 */
export async function resolveCaptionConfig(
  env: NodeJS.ProcessEnv = process.env,
  binding?: CaptionLocalBinding,
  deps: CaptionDeps = {},
): Promise<MlxgenCaptionConfig | undefined> {
  const r = await resolveCaptionConfigDetailed(env, binding, deps);
  return r.ok ? r.config : undefined;
}

/* ────────────────────────── 执行 ────────────────────────── */

/** CLI 参数构造(纯函数,便于单测):与引擎 `caption.py` 的参数面一一对应 */
export function buildCaptionCliArgs(
  cfg: MlxgenCaptionConfig,
  imagePath: string,
  instruction: string,
  outFile: string,
): string[] {
  return [
    ...cfg.cmd.prefixArgs,
    '--model',
    cfg.model,
    '--image-path',
    imagePath,
    '--prompt',
    instruction,
    '--max-tokens',
    String(cfg.maxTokens),
    '--max-pixels',
    String(cfg.maxPixels),
    // 反推要的是**确定性**,不是多样性:贪心解码(引擎 doc:temperature 0 = greedy)
    '--temperature',
    '0',
    '--output',
    outFile,
  ];
}

/** 默认执行器:spawn + 收 stdout/stderr + 超时杀进程 */
export function spawnCaption(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code: number): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      // 超时不静默:杀掉并让上层报「超时」而不是空结果
      stderr += `\n[caption] 超时 ${Math.round(timeoutMs / 1000)}s,已终止进程`;
      child.kill('SIGKILL');
      finish(-1);
    }, timeoutMs);
    child.stdout?.on('data', (d) => (stdout += String(d)));
    child.stderr?.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => {
      stderr += `\n${(e as Error).message}`;
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
  });
}

/** 给用户/Agent 的安装指引(命令缺失时用) */
export function captionCommandHint(): string {
  return (
    '本机没有可用的 mlxgen-caption:请执行 `uv tool install --upgrade mlx-gen-jzg`' +
    '(上游包 mlx-gen 没有这条命令),或用 BIGBOTART_CAPTION_BIN 指定可执行文件'
  );
}

/**
 * 运行一次本地反推。
 * @param cfg      由 resolveCaptionConfig 得到(含命令与 checkpoint)
 * @param imagePath 已通过 vision.ts 白名单校验的图片绝对路径
 * @param instruction 反推指令(由 vision.ts 的 buildCaptionInstruction 生成,与端点通道同口径)
 */
export async function runMlxgenCaption(
  cfg: MlxgenCaptionConfig,
  imagePath: string,
  instruction: string,
  deps: CaptionDeps = {},
): Promise<CaptionRunResult> {
  const run = deps.run ?? spawnCaption;
  const exists = deps.exists ?? existsSync;
  const readText = deps.readText ?? ((p: string) => readFileSync(p, 'utf8'));
  const makeTmpDir = deps.makeTmpDir ?? (() => mkdtempSync(join(tmpdir(), 'bba-caption-')));

  if (cfg.model.startsWith('/') && !exists(cfg.model)) {
    return {
      ok: false,
      error:
        `本地 caption 模型目录不存在:${cfg.model}。请确认 Qwen3-VL checkpoint 已下载到本机` +
        `(LM Studio 模型库 / ~/ai/models 下),或在设置 → 工具模型 → 看图反推里改路径`,
    };
  }

  const tmp = makeTmpDir();
  const outFile = join(tmp, 'caption.txt');
  const args = buildCaptionCliArgs(cfg, imagePath, instruction, outFile);
  try {
    const res = await run(cfg.cmd.bin, args, cfg.timeoutMs);
    if (res.code !== 0) {
      const tail = (res.stderr || res.stdout || '').trim().split('\n').slice(-6).join('\n');
      const missing = /ENOENT|command not found|No such file/i.test(tail);
      return { ok: false, error: missing ? captionCommandHint() : `mlxgen-caption 退出码 ${res.code}:${tail.slice(-600)}` };
    }
    const fileOk = exists(outFile);
    const caption = (fileOk ? readText(outFile) : res.stdout).trim();
    if (!caption) {
      const tail = (res.stderr || '').trim().split('\n').slice(-6).join('\n');
      return {
        ok: false,
        error: `mlxgen-caption 未产出文本(可检查 checkpoint 是否为 MLX 格式的 dense Qwen3-VL)${tail ? `:${tail.slice(-400)}` : ''}`,
      };
    }
    return { ok: true, caption, model: cfg.model.split('/').filter(Boolean).pop() ?? cfg.model };
  } catch (e) {
    return { ok: false, error: `本地反推失败:${(e as Error).message}` };
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响结果 */
    }
  }
}

/** 便捷探测:本机该通道是否可用(设置页/自检用;不加载模型,只判命令 + 目录) */
export async function probeLocalCaption(
  env: NodeJS.ProcessEnv = process.env,
  binding?: CaptionLocalBinding,
  deps: CaptionDeps = {},
): Promise<{ available: boolean; command?: string; model?: string; reason?: string }> {
  const r = await resolveCaptionConfigDetailed(env, binding, deps);
  if (!r.ok) return { available: false, reason: r.reason };
  const cfg = r.config;
  // 目录可达性再确认一次(避免「配置了但盘上没有」被判成可用)
  const isDir = deps.isDir ?? ((p: string) => statSync(p).isDirectory());
  if (cfg.model.startsWith('/')) {
    try {
      if (!isDir(cfg.model)) return { available: false };
    } catch {
      return { available: false };
    }
  }
  return { available: true, command: cfg.cmd.label, model: cfg.model };
}
