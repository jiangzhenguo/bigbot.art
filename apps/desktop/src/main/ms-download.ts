/**
 * ModelScope 直连下载器 — 图片模型走国内 CDN,绕开 HF 不可达 / Xet 挂起
 *
 * 背景(本机实测):直连 huggingface.co 不可达、hf-mirror 已失效(308 回跳官方源)、
 * 代理线路抖动大;ModelScope 镜像了 Qwen 系列模型,且 LFS 文件 sha256 与 HF oid 完全一致
 * (已抽查验证)。因此按 HF 缓存布局落盘,mlxgen 与 App 完整性校验无缝识别:
 *
 *   models--<owner>--<name>/
 *     blobs/<oid>                    LFS:oid=sha256(与 HF 一致);普通文件:oid=git blob sha1(本地算)
 *     snapshots/<commit>/<path>      指向 blob 的符号链接
 *     refs/main                      commit
 *
 * - 文件清单:MS API `/api/v1/models/<repo>/repo/files?Recursive=true`
 * - 断点续传:<oid>.part + Range;并发 4 路;失败/停滞自动多轮续传(最多 5 轮)
 * - 停滞看门狗:2s 采样目标字节,连续 5 分钟零增长 → 中止本轮、下轮续传
 * - 进度:目标文件当前字节 / 总字节(真实百分比,不解析 tqdm)
 */
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import type { DebugLogger } from './logger';

const MS_API = 'https://modelscope.cn';
const CONCURRENCY = 4;
const MAX_ROUNDS = 5;
const TICK_MS = 2_000;
const STALL_LIMIT_MS = 300_000;
const HF_API_TIMEOUT_MS = 10_000;

export interface MsFileEntry {
  path: string;
  /** LFS 文件为 sha256(与 HF oid 一致);普通文件为空串 */
  sha256: string;
  size: number;
}

/** 与 mlxgen-models.ts 的 DownloadJob 结构对齐(进度/状态由本下载器直接写) */
export interface MsJob {
  status: 'running' | 'done' | 'failed' | 'cancelled';
  pct: number | null;
  error?: string;
  lastLine: string;
}

export interface MsDownloadOpts {
  /** ModelScope 仓库(通常与 HF 同名,如 Qwen/Qwen-Image-Edit) */
  msRepoId: string;
  /** HF 仓库 id(commit 探测用) */
  hfRepoId: string;
  /** HF 缓存目录(models--owner--name) */
  hfCacheDir: string;
  job: MsJob;
  logger?: DebugLogger;
  /** 外部取消信号(用户点「取消」):中止本轮全部 fetch,保持 job.status='cancelled' 由调用方设置 */
  signal?: AbortSignal;
}

/** git blob oid = sha1("blob <len>\0" + content)(HF 缓存里普通文件的 blob 名) */
export function gitBlobOid(buf: Buffer): string {
  const h = createHash('sha1');
  h.update(`blob ${buf.length}\0`);
  h.update(buf);
  return h.digest('hex');
}

/** MS 仓库文件清单(只取文件,过滤目录/空文件) */
export async function fetchMsFiles(msRepoId: string): Promise<MsFileEntry[]> {
  const res = await fetch(`${MS_API}/api/v1/models/${msRepoId}/repo/files?Recursive=true`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`ModelScope 清单请求失败: HTTP ${res.status}`);
  const data = (await res.json()) as {
    Data?: { Files?: Array<{ Path: string; Type?: string; Sha256?: string; Size?: number }> };
  };
  const files = data?.Data?.Files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`ModelScope 仓库为空或不存在: ${msRepoId}`);
  }
  return files
    .filter((f) => f.Type !== 'tree' && (f.Size ?? 0) > 0)
    .map((f) => ({ path: f.Path, sha256: f.Sha256 ?? '', size: f.Size ?? 0 }));
}

/**
 * 目标 HF commit 探测:
 *  1. 缓存已有 snapshot 目录(断点续传场景)→ 复用
 *  2. HF API(本机直连可能不可达,短超时尽力而为)
 *  3. 兜底 'master'(hf_hub 网络失败回退缓存时按 refs 直读,可用;HF 可达时会自愈到正确 commit)
 */
async function resolveCommit(
  hfRepoId: string,
  cacheDir: string,
  logger?: DebugLogger,
): Promise<string> {
  try {
    const dirs = (await readdir(join(cacheDir, 'snapshots'))).filter((d) => /^[0-9a-f]{40}$/.test(d));
    if (dirs[0]) return dirs[0];
  } catch {
    /* 无缓存目录 */
  }
  try {
    const r = await fetch(`https://huggingface.co/api/models/${hfRepoId}`, {
      signal: AbortSignal.timeout(HF_API_TIMEOUT_MS),
    });
    if (r.ok) {
      const d = (await r.json()) as { sha?: string };
      if (typeof d.sha === 'string' && /^[0-9a-f]{40}$/.test(d.sha)) return d.sha;
    }
  } catch (e) {
    logger?.log('warn', `HF API 不可达(${hfRepoId}),commit 兜底为 master:${(e as Error).message}`);
  }
  return 'master';
}

const sizeOfSync = (p: string): number => {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
};

/** 下载执行体:多轮并发续传,全部文件落齐后写 refs/main 并置 done */
export async function runMsDownload(opts: MsDownloadOpts): Promise<void> {
  const { job, logger } = opts;
  const blobsDir = join(opts.hfCacheDir, 'blobs');
  await mkdir(blobsDir, { recursive: true });

  job.lastLine = '获取 ModelScope 文件清单…';
  const files = await fetchMsFiles(opts.msRepoId);
  const commit = await resolveCommit(opts.hfRepoId, opts.hfCacheDir, logger);
  const snapDir = join(opts.hfCacheDir, 'snapshots', commit);
  await mkdir(snapDir, { recursive: true });
  const total = files.reduce((s, f) => s + f.size, 0);
  job.lastLine = `ModelScope 直连 · ${files.length} 文件 ${(total / 1e9).toFixed(1)}GB · commit ${commit.slice(0, 8)}`;
  logger?.log('info', `ms download ${opts.msRepoId} → HF 缓存 ${opts.hfCacheDir} · ${job.lastLine}`);

  /** blob 落盘名:LFS=sha256;普通文件下载后按 git oid(此处先用 sha256 占位判断 LFS) */
  const blobNameOf = (f: MsFileEntry): string => f.sha256;
  const linkToSnapshot = async (f: MsFileEntry, blobPath: string): Promise<void> => {
    const dest = join(snapDir, f.path);
    await mkdir(dirname(dest), { recursive: true });
    await unlink(dest).catch(() => {});
    await symlink(blobPath, dest);
  };
  const isComplete = async (f: MsFileEntry): Promise<boolean> => {
    if (!f.sha256) return existsSync(join(snapDir, f.path)); // 普通文件:链接存在即完成
    return sizeOfSync(join(blobsDir, f.sha256)) === f.size;
  };
  /** 进度字节:只看本任务目标文件(blob 或 .part),不被历史残渣干扰 */
  const currentBytes = (): number =>
    files.reduce((s, f) => {
      if (!f.sha256) return s + (existsSync(join(snapDir, f.path)) ? f.size : 0);
      return s + Math.min(f.size, Math.max(sizeOfSync(join(blobsDir, f.sha256)), sizeOfSync(join(blobsDir, `${f.sha256}.part`))));
    }, 0);

  const getOne = async (f: MsFileEntry, signal: AbortSignal): Promise<void> => {
    const url = `${MS_API}/models/${opts.msRepoId}/resolve/master/${f.path.split('/').map(encodeURIComponent).join('/')}`;
    if (!f.sha256) {
      // 普通小文件:整取 → git blob oid 落盘
      if (await isComplete(f)) return;
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${f.path}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const blobPath = join(blobsDir, gitBlobOid(buf));
      await writeFile(blobPath, buf);
      await linkToSnapshot(f, blobPath);
      return;
    }
    const blobPath = join(blobsDir, blobNameOf(f));
    if (sizeOfSync(blobPath) === f.size) {
      await linkToSnapshot(f, blobPath);
      return;
    }
    const partPath = `${blobPath}.part`;
    const have = sizeOfSync(partPath);
    const res = await fetch(url, {
      headers: have > 0 ? { Range: `bytes=${have}-` } : {},
      signal,
    });
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} ${f.path}`);
    const append = res.status === 206 && have > 0; // 服务器忽略 Range(回 200)→ 从头写
    const out = createWriteStream(partPath, { flags: append ? 'a' : 'w' });
    const reader = res.body?.getReader();
    if (!reader) throw new Error(`空响应体 ${f.path}`);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        if (!out.write(Buffer.from(value))) await once(out, 'drain');
      }
    }
    await new Promise<void>((resolveW, rejectW) =>
      out.end((err: Error | null | undefined) => (err ? rejectW(err) : resolveW())),
    );
    if (sizeOfSync(partPath) === f.size) {
      await rename(partPath, blobPath);
      await linkToSnapshot(f, blobPath);
    }
  };

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (opts.signal?.aborted) return; // 外部取消:保持调用方设置的 cancelled 终态
    const ctrl = new AbortController();
    // 外部取消联动:用户点「取消」→ 中止本轮全部 fetch
    const onOuterAbort = (): void => ctrl.abort();
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
    let lastSize = currentBytes();
    let lastGrowthAt = Date.now();
    let stalled = false;
    const ticker = setInterval(() => {
      const sz = currentBytes();
      job.pct = total > 0 ? Math.min(99, Math.floor((sz / total) * 100)) : null;
      if (sz > lastSize) {
        lastSize = sz;
        lastGrowthAt = Date.now();
      } else if (Date.now() - lastGrowthAt >= STALL_LIMIT_MS) {
        stalled = true;
        logger?.log('warn', `ms download ${opts.msRepoId} 第 ${round} 轮 5 分钟零增长,中止续传`);
        ctrl.abort();
      }
    }, TICK_MS);

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < files.length && !ctrl.signal.aborted) {
        const f = files[cursor++];
        if (!f) break;
        try {
          await getOne(f, ctrl.signal);
        } catch (e) {
          if (ctrl.signal.aborted) return;
          logger?.log('warn', `ms download ${opts.msRepoId} 文件失败(下轮续传)${f.path}: ${(e as Error).message}`);
        }
      }
    };
    await Promise.allSettled(Array.from({ length: CONCURRENCY }, () => worker()));
    clearInterval(ticker);
    opts.signal?.removeEventListener('abort', onOuterAbort);
    if (opts.signal?.aborted) return; // 外部取消:保留已落盘的 .part,断点续传

    const missing: string[] = [];
    for (const f of files) if (!(await isComplete(f))) missing.push(f.path);
    if (missing.length === 0) {
      await mkdir(join(opts.hfCacheDir, 'refs'), { recursive: true });
      await writeFile(join(opts.hfCacheDir, 'refs', 'main'), commit);
      job.pct = 100;
      job.status = 'done';
      job.lastLine = `完成 · ${files.length} 文件已按 HF 缓存布局落盘`;
      logger?.log('info', `ms download ${opts.msRepoId} → done`);
      return;
    }
    logger?.log(
      stalled ? 'warn' : 'info',
      `ms download ${opts.msRepoId} 第 ${round}/${MAX_ROUNDS} 轮结束,缺 ${missing.length} 文件${stalled ? '(停滞中止)' : ''}`,
    );
    job.lastLine = `第 ${round} 轮续传 · 缺 ${missing.length} 文件`;
  }
  throw new Error(`ModelScope 下载 ${MAX_ROUNDS} 轮后仍未完成,请检查网络后重试(断点续传)`);
}
