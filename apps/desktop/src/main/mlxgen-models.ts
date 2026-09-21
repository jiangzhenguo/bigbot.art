/**
 * mlxgen 图片模型管理 — 模型清单 / 已下载探测 / 真实下载
 *
 * - 下载通道(按模型自动选择):
 *   a. ModelScope 直连(白名单内带 msRepoId 的模型,如 Qwen 系):主进程直接按 HF 缓存布局
 *      落盘,国内 CDN、断点续传、多轮自愈,不依赖 HF 可达性(见 ms-download.ts);
 *      `BIGBOTART_MS_DOWNLOAD=0` 可强制回退 b 通道
 *   b. `spawn('mlxgen', ['download', '--model', <repoId>])`(hf_hub,AbstractFramework 等
 *      MS 没有的模型),进度从 stdout/stderr 的 `\r` 覆盖式进度行解析 `NN%`
 * - 去重:同一模型同时只允许一个下载任务(activeByRepo)
 * - 已下载判定:HF 缓存完整性校验(见 `isCacheComplete`),不再是「目录存在即就绪」
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DebugLogger } from './logger';
import { runMsDownload } from './ms-download';

export interface MlxModelInfo {
  id: string;
  name: string;
  repoId: string;
  /** 通过 HF 缓存完整性校验 = 已下载(见 isCacheComplete) */
  downloaded: boolean;
}

/** 已知图片模型清单(与设置页「模型下载」分组同口径;下载白名单)
 *  msRepoId 存在 = 走 ModelScope 直连通道(实测 sha256 与 HF LFS oid 一致) */
const KNOWN_MODELS: Array<{ id: string; name: string; repoId: string; msRepoId?: string }> = [
  { id: 'z-image-turbo', name: 'Z-Image-Turbo', repoId: 'AbstractFramework/z-image-turbo-8bit' },
  { id: 'qwen-image-edit', name: 'Qwen Image Edit', repoId: 'mlx-community/Qwen-Image-Edit-8bit', msRepoId: 'mlx-community/Qwen-Image-Edit-8bit' },
  { id: 'seedvr2-3b', name: 'SeedVR2 3B', repoId: 'AbstractFramework/seedvr2-3b-8bit' },
  { id: 'qwen2.5-vl', name: 'Qwen2.5-VL', repoId: 'Qwen/Qwen2.5-VL-7B-Instruct', msRepoId: 'Qwen/Qwen2.5-VL-7B-Instruct' },
];

function hfHubDir(): string {
  return process.env.HF_HOME
    ? join(process.env.HF_HOME, 'hub')
    : join(homedir(), '.cache', 'huggingface', 'hub');
}

function cacheDirFor(repoId: string): string {
  return join(hfHubDir(), `models--${repoId.replace(/[\/:]/g, '--')}`);
}

/**
 * HF 缓存完整性校验(替代骨架期「目录存在即就绪」近似,离线纯结构检查):
 *  1. blobs/ 下无「无主」未完成分块:
 *     - `*.incomplete`(huggingface_hub 中断):若同名前缀的完整 blob 已存在,
 *       则是 Xet→经典重试留下的残渣,忽略(实测:重试成功后旧分块不清理,一刀切判负
 *       会把已就绪模型误标为未下载)
 *     - `*.part`(ModelScope 直连 ms-download):**存在即未完成**——下载完成时
 *       必然会 rename 成无后缀 blob,残留 .part = 中断/进行中(实测:App 退出时
 *       只要有一个权重完整落盘、其余 .part 残留,旧规则会误判「已下载」)
 *  2. snapshots/ 下至少一个提交目录:有可解析到真实 blob 的非空文件、无悬空链接
 *     (snapshot 条目是指向 blobs 的符号链接;悬空链接 = blob 未完成/被清 → 判不完整)
 *  3. 至少一个权重文件(*.safetensors/*.gguf/*.bin)——只有配置/分词器不算模型
 *     (实测:恰好在文件间掐断的下载会留下「tokenizer+config 齐全、权重为零」的假完整)
 *  4. 存在 `*.safetensors.index.json` 时,其 weight_map 引用的每个分片都必须真实存在
 *     (分片级精确校验:索引 JSON 小文件先下完、权重分片没下完的形态也能判出)
 * 残留近似:index 缺失且已有部分权重(无法得知期望清单)时仍靠规则 1-3;
 * 此时 hf_hub 断点续传会在下次下载/生成时自愈。
 */
function isCacheComplete(cacheDir: string): boolean {
  const blobsDir = join(cacheDir, 'blobs');
  const snapsDir = join(cacheDir, 'snapshots');
  if (!existsSync(blobsDir) || !existsSync(snapsDir)) return false;
  const blobs = readdirSync(blobsDir);
  const completed = blobs.filter((f) => !f.endsWith('.incomplete') && !f.endsWith('.part'));
  // hf_hub 中断:无主 .incomplete;ms-download 中断:存在 .part 即未完成(完成必已 rename)
  const interrupted =
    blobs.filter((f) => f.endsWith('.incomplete')).some((f) => !completed.some((b) => f.startsWith(b))) ||
    blobs.some((f) => f.endsWith('.part'));
  if (interrupted) return false;
  for (const commit of readdirSync(snapsDir)) {
    const snap = join(snapsDir, commit);
    if (!statSync(snap).isDirectory()) continue;
    const probe: SnapProbe = { realFiles: 0, dangling: false, weights: 0, indexes: [] };
    probeSnapshot(snap, probe);
    if (probe.dangling) return false; // 任一 snapshot 有悬空链接即不完整
    if (probe.realFiles === 0) continue;
    if (probe.weights === 0) return false; // 配置/分词器齐全但权重为零 → 未下载
    if (!probe.indexes.every(indexShardsPresent)) return false; // 分片缺失 → 未下载
    return true;
  }
  return false;
}

/** 权重文件扩展名(MLX 模型为 safetensors;gguf/bin 兼容其他来源) */
const WEIGHT_FILE = /\.(safetensors|gguf|bin)$/i;

interface SnapProbe {
  realFiles: number;
  dangling: boolean;
  weights: number;
  /** `*.safetensors.index.json` 绝对路径(分片索引,用于规则 4) */
  indexes: string[];
}

/** 递归统计 snapshot 内的真实文件;符号链接解析失败(悬空)记 dangling */
function probeSnapshot(dir: string, acc: SnapProbe): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p); // 跟随符号链接;悬空链接抛 ENOENT → 该缓存不完整
    } catch {
      acc.dangling = true;
      continue;
    }
    if (st.isDirectory()) {
      probeSnapshot(p, acc);
    } else if (st.isFile() && st.size > 0) {
      acc.realFiles += 1;
      if (WEIGHT_FILE.test(name)) acc.weights += 1;
      if (name.endsWith('.safetensors.index.json')) acc.indexes.push(p);
    }
  }
}

/** 分片索引校验:weight_map 引用的每个分片在同目录下可解析且非空(索引损坏抛错,由上层捕获记录) */
function indexShardsPresent(indexPath: string): boolean {
  const parsed = JSON.parse(readFileSync(indexPath, 'utf-8')) as {
    weight_map?: Record<string, string>;
  };
  const shards = new Set(Object.values(parsed.weight_map ?? {}));
  for (const shard of shards) {
    try {
      const st = statSync(join(dirname(indexPath), shard));
      if (!st.isFile() || st.size === 0) return false;
    } catch {
      return false; // 分片缺失/悬空
    }
  }
  return true;
}

/** 列出已知图片模型及下载状态(设置页/引导页展示用) */
export function mlxgenModelInfo(logger?: DebugLogger): MlxModelInfo[] {
  return KNOWN_MODELS.map((m) => {
    let downloaded = false;
    try {
      const dir = cacheDirFor(m.repoId);
      downloaded = existsSync(dir) && isCacheComplete(dir);
    } catch (e) {
      // 探测失败(权限等)按未就绪处理,但必须留痕(R6)
      logger?.log('warn', `mlxgen 模型缓存探测失败 ${m.repoId}: ${(e as Error).message}`);
      console.warn(`[mlxgen-models] 缓存探测失败 ${m.repoId}: ${(e as Error).message}`);
    }
    return {
      id: m.id,
      name: m.name,
      repoId: m.repoId,
      downloaded,
    };
  });
}

export interface MlxDownloadStatus {
  status: 'running' | 'done' | 'failed' | 'cancelled';
  pct: number | null;
  error?: string;
}

/** 进行中的下载任务(设置页进入时恢复进度轮询用) */
export interface MlxActiveDownload {
  id: string;
  jobId: string;
  pct: number | null;
}

interface DownloadJob extends MlxDownloadStatus {
  lastLine: string;
  /** 用户取消时的中止回调(spawn kill / ModelScope AbortSignal),由通道各自注册 */
  cancel?: () => void;
}

const jobs = new Map<string, DownloadJob>();

/** repoId → 进行中的 jobId(同模型同时只允许一个下载进程,防连点互等 hf_hub 锁) */
const activeByRepo = new Map<string, string>();

/** 当前进行中的下载任务清单(设置页进入时恢复轮询;按 KNOWN_MODELS id 回填) */
export function mlxgenDownloadActive(): MlxActiveDownload[] {
  const out: MlxActiveDownload[] = [];
  for (const [repoId, jobId] of activeByRepo) {
    const job = jobs.get(jobId);
    if (!job || job.status !== 'running') continue;
    out.push({ id: KNOWN_MODELS.find((m) => m.repoId === repoId)?.id ?? repoId, jobId, pct: job.pct });
  }
  return out;
}

/** 取消进行中的下载:置 cancelled 终态 + 触发通道中止(kill spawn / abort fetch)
 *  保留 .part/.incomplete 支持断点续传;任务释放后同一模型可重新下载 */
export function mlxgenDownloadCancel(jobId: string, logger?: DebugLogger): { ok: boolean; error?: string } {
  const job = jobs.get(jobId);
  if (!job) return { ok: false, error: '下载任务不存在(可能已完成或已清理)' };
  if (job.status === 'cancelled') return { ok: true }; // 幂等
  if (job.status !== 'running') return { ok: false, error: `任务已结束(${job.status}),无需取消` };
  job.status = 'cancelled';
  job.error = '已取消 · 保留断点续传';
  logger?.log('info', `mlxgen download ${jobId} → 用户取消`);
  try {
    job.cancel?.();
  } catch (e) {
    logger?.log('warn', `mlxgen download ${jobId} 取消回调异常:${(e as Error).message}`);
  }
  return { ok: true };
}

/** 启动真实下载;repoId 必须在已知清单内(防任意 repo 注入)
 *  去重:同一模型同时只允许一个下载进程(连点会互等 hf_hub 文件锁、全部卡死,实测事故)
 *  实测坑:新版 hf_hub 大文件走 Xet CAS CDN(cas-server.xethub.hf.co),部分网络直连 401 或挂起;
 *  报错退出时自动以 HF_HUB_DISABLE_XET=1 重试一次;挂起(零字节增长)由看门狗杀掉后同样切经典通道 */
export function mlxgenDownload(
  repoId: string,
  logger?: DebugLogger,
): { ok: boolean; jobId?: string; error?: string } {
  const known = KNOWN_MODELS.find((m) => m.repoId === repoId);
  if (!known) return { ok: false, error: `不在图片模型清单内: ${repoId}` };
  const activeId = activeByRepo.get(repoId);
  const active = activeId ? jobs.get(activeId) : undefined;
  if (active?.status === 'running') {
    logger?.log('info', `mlxgen download ${repoId} 已在下载中(${activeId}),复用该任务`);
    return { ok: true, jobId: activeId };
  }
  const jobId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
  const job: DownloadJob = { status: 'running', pct: null, lastLine: '' };
  jobs.set(jobId, job);
  activeByRepo.set(repoId, jobId);
  if (known.msRepoId && process.env.BIGBOTART_MS_DOWNLOAD !== '0') {
    // ModelScope 直连通道(国内 CDN;不依赖 HF 可达性);取消 = 外部 AbortSignal 中止 fetch
    const cancelCtrl = new AbortController();
    job.cancel = () => cancelCtrl.abort();
    runMsDownload({
      msRepoId: known.msRepoId,
      hfRepoId: repoId,
      hfCacheDir: cacheDirFor(repoId),
      job,
      logger,
      signal: cancelCtrl.signal,
    }).catch((e) => {
      // 用户取消不是失败:保持 cancelled 终态,不覆盖错误信息
      if (job.status === 'cancelled') return;
      job.status = 'failed';
      job.error = (e as Error).message;
      logger?.log('error', `ms download ${known.msRepoId} 失败: ${job.error}`);
    }).finally(() => releaseRepo(repoId, jobId));
  } else {
    runDownload(repoId, jobId, job, logger, false);
  }
  return { ok: true, jobId };
}

/** 停滞看门狗:每 30s 对 blobs 目录求字节数,连续 5 分钟零增长判定挂起 */
const STALL_CHECK_MS = 30_000;
const STALL_LIMIT_MS = 300_000;

/** blobs 目录总字节(完成块 + .incomplete 分块;下载活动的真实地面真值) */
function blobsBytes(blobsDir: string): number {
  try {
    let sum = 0;
    for (const f of readdirSync(blobsDir)) {
      try {
        sum += statSync(join(blobsDir, f)).size;
      } catch {
        /* 竞争中消失的文件忽略 */
      }
    }
    return sum;
  } catch {
    return 0;
  }
}

/** 任务终态时解除 repo 占用(允许之后重新下载) */
function releaseRepo(repoId: string, jobId: string): void {
  if (activeByRepo.get(repoId) === jobId) activeByRepo.delete(repoId);
}

function runDownload(
  repoId: string,
  jobId: string,
  job: DownloadJob,
  logger: DebugLogger | undefined,
  disableXet: boolean,
): void {
  const child = spawn('mlxgen', ['download', '--model', repoId], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: disableXet ? { ...process.env, HF_HUB_DISABLE_XET: '1' } : process.env,
  });
  // 取消:先 SIGTERM 优雅退出,5s 未退出再 SIGKILL 兜底(hf_hub 网络层可能不响应 TERM)
  job.cancel = () => {
    try {
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          if (child.exitCode === null) child.kill('SIGKILL');
        } catch {
          /* 已退出则忽略 */
        }
      }, 5000).unref?.();
    } catch {
      /* 已退出则忽略 */
    }
  };
  let buf = '';
  const eat = (d: Buffer): void => {
    buf = (buf + d.toString()).slice(-8000);
    parseProgress(job, buf);
  };
  child.stdout.on('data', eat);
  child.stderr.on('data', eat);

  // 停滞看门狗:Xet 挂起形态是「进程活着、tqdm 停在原地、零字节增长」,从不报错退出,
  // 只看输出永远发现不了——必须以 blobs 字节数为地面真值
  const blobsDir = join(cacheDirFor(repoId), 'blobs');
  let lastSize = blobsBytes(blobsDir);
  let lastGrowthAt = Date.now();
  let stalled = false;
  const watchdog = setInterval(() => {
    const size = blobsBytes(blobsDir);
    if (size > lastSize) {
      lastSize = size;
      lastGrowthAt = Date.now();
      return;
    }
    if (Date.now() - lastGrowthAt < STALL_LIMIT_MS) return;
    stalled = true;
    logger?.log(
      'warn',
      `mlxgen download ${repoId} ${STALL_LIMIT_MS / 60000} 分钟零字节增长,判定挂起,杀掉重试(禁用 Xet=${!disableXet})`,
    );
    child.kill('SIGTERM');
  }, STALL_CHECK_MS);

  child.on('error', (e) => {
    clearInterval(watchdog);
    if (job.status === 'cancelled') {
      releaseRepo(repoId, jobId);
      return;
    }
    job.status = 'failed';
    job.error = `无法执行 mlxgen:${e.message} · 请先安装(设置页/引导向导「安装 mlxgen」)`;
    logger?.log('error', `mlxgen download ${repoId} spawn 失败: ${e.message}`);
    releaseRepo(repoId, jobId);
  });
  child.on('close', (code) => {
    clearInterval(watchdog);
    // 用户取消/失败 = 终态:不再走停滞重试或 Xet 切换,直接释放 repo 占用
    if (job.status === 'cancelled' || job.status === 'failed') {
      releaseRepo(repoId, jobId);
      return;
    }
    // 看门狗杀掉的挂起进程:优先切经典通道重试;已是经典通道仍停滞 → 终态失败
    if (stalled) {
      if (!disableXet) {
        job.pct = null;
        runDownload(repoId, jobId, job, logger, true);
      } else {
        job.status = 'failed';
        job.error = '下载停滞:禁用 Xet 后仍零字节增长,请检查网络/代理后重试(断点续传)';
        logger?.log('error', `mlxgen download ${repoId} 禁用 Xet 后仍停滞`);
        releaseRepo(repoId, jobId);
      }
      return;
    }
    const xetIssue = /xet|CAS|reconstruction/i.test(buf);
    if (code !== 0 && xetIssue && !disableXet) {
      logger?.log('info', `mlxgen download ${repoId} 命中 Xet 报错,以 HF_HUB_DISABLE_XET=1 重试`);
      job.pct = null; // 经典通道重新起算
      runDownload(repoId, jobId, job, logger, true);
      return;
    }
    job.status = code === 0 ? 'done' : 'failed';
    if (code !== 0) job.error = tailLines(job.lastLine || buf) || `exit ${code}`;
    if (code === 0) job.pct = 100;
    logger?.log('info', `mlxgen download ${repoId} → ${job.status}${job.error ? ` · ${job.error}` : ''}`);
    releaseRepo(repoId, jobId);
  });
}

/** 查询下载进度(渲染层轮询) */
export function mlxgenDownloadStatus(jobId: string): MlxDownloadStatus {
  const job = jobs.get(jobId);
  if (!job) return { status: 'failed', pct: null, error: '未知下载任务(可能已清理)' };
  return { status: job.status, pct: job.pct, error: job.error };
}

/** 从 \r/\n 覆盖式进度行解析 NN%(huggingface_hub tqdm 风格,如 "Fetching 15 files:  42%|###") */
function parseProgress(job: DownloadJob, buf: string): void {
  const segments = buf.split(/\r|\n/).filter(Boolean);
  job.lastLine = segments[segments.length - 1]?.slice(0, 200) ?? '';
  const m = /(\d{1,3})\s*%/.exec(job.lastLine);
  if (m) job.pct = Math.min(100, Number(m[1]));
}

function tailLines(s: string): string {
  return s
    .split(/\r|\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-4)
    .join(' | ')
    .slice(0, 400);
}