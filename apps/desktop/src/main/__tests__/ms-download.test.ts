/**
 * ModelScope 下载器测试(ms-download.ts)
 * - git blob oid 算法(git 空 blob 已知向量)
 * - MS 清单解析(过滤目录/空文件)
 * - 全流程集成:mock fetch,验证 HF 缓存布局落盘(blobs/快照链接/refs)+ Range 断点续传
 *   全程离线,不触网
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { gitBlobOid, fetchMsFiles, runMsDownload, type MsJob } from '../ms-download.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'bbart-msdl-test-'));

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const jsonRes = (obj: unknown) =>
  ({ ok: true, status: 200, json: async () => obj }) as unknown as Response;

const bufRes = (buf: Buffer, status = 200) =>
  ({
    ok: status < 400,
    status,
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () =>
            sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: new Uint8Array(buf) }),
        };
      },
    },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
  }) as unknown as Response;

const newJob = (): MsJob => ({ status: 'running', pct: null, lastLine: '' });

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe('gitBlobOid', () => {
  it('空内容 = git 空 blob 已知哈希', () => {
    expect(gitBlobOid(Buffer.alloc(0))).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });
});

describe('fetchMsFiles', () => {
  it('过滤目录与空文件,保留 sha256/size', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonRes({
        Data: {
          Files: [
            { Path: 'transformer', Type: 'tree' },
            { Path: 'README.md', Type: 'blob', Size: 0 },
            { Path: 'model.safetensors', Type: 'blob', Size: 100, Sha256: 'ab12' },
            { Path: 'config.json', Type: 'blob', Size: 10 },
          ],
        },
      }),
    );
    const files = await fetchMsFiles('Test/Repo');
    expect(files).toEqual([
      { path: 'model.safetensors', sha256: 'ab12', size: 100 },
      { path: 'config.json', sha256: '', size: 10 },
    ]);
  });

  it('仓库不存在/空清单 → 抛错', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonRes({ Data: { Files: [] } }));
    await expect(fetchMsFiles('No/Such')).rejects.toThrow('为空或不存在');
  });
});

describe('runMsDownload 全流程(mock fetch,离线)', () => {
  const COMMIT = 'a'.repeat(40);
  const lfsContent = Buffer.alloc(200_000, 7); // 200KB 假 LFS
  const lfsSha = createHash('sha256').update(lfsContent).digest('hex');
  const smallContent = Buffer.from('{"vocab": true}\n');

  const msFiles = {
    Data: {
      Files: [
        { Path: 'weights/model.safetensors', Type: 'blob', Size: lfsContent.length, Sha256: lfsSha },
        { Path: 'tokenizer/vocab.json', Type: 'blob', Size: smallContent.length },
      ],
    },
  };

  function stubRouter(opts?: { lfsStatus?: number }) {
    vi.mocked(fetch).mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('https://modelscope.cn/api/')) return jsonRes(msFiles);
      if (u.startsWith('https://huggingface.co/api/')) return jsonRes({ sha: COMMIT });
      if (u.includes('/resolve/master/weights/model.safetensors')) {
        const range = (init?.headers as Record<string, string> | undefined)?.Range;
        const m = /^bytes=(\d+)-$/.exec(range ?? '');
        if (m) return bufRes(lfsContent.subarray(Number(m[1])), 206);
        return bufRes(lfsContent, opts?.lfsStatus ?? 200);
      }
      if (u.includes('/resolve/master/tokenizer/vocab.json')) return bufRes(smallContent);
      throw new Error(`unexpected url ${u}`);
    });
  }

  it('LFS + 普通文件按 HF 缓存布局落盘,job 置 done', async () => {
    stubRouter();
    const cacheDir = join(tmpRoot, 'case1');
    const job = newJob();
    await runMsDownload({ msRepoId: 'Test/Repo', hfRepoId: 'Test/Repo', hfCacheDir: cacheDir, job });

    // LFS blob 以 sha256 命名,内容与源一致
    const lfsBlob = join(cacheDir, 'blobs', lfsSha);
    expect(readFileSync(lfsBlob)).toEqual(lfsContent);
    // 普通文件 blob 以 git oid 命名
    const gitOid = gitBlobOid(smallContent);
    expect(readFileSync(join(cacheDir, 'blobs', gitOid))).toEqual(smallContent);
    // snapshot 符号链接可解析到相同内容
    expect(readFileSync(join(cacheDir, 'snapshots', COMMIT, 'weights/model.safetensors'))).toEqual(lfsContent);
    expect(readFileSync(join(cacheDir, 'snapshots', COMMIT, 'tokenizer/vocab.json'))).toEqual(smallContent);
    // refs/main
    expect(readFileSync(join(cacheDir, 'refs', 'main'), 'utf-8')).toBe(COMMIT);
    expect(job.status).toBe('done');
    expect(job.pct).toBe(100);
  });

  it('断点续传:已有 .part 时带 Range 头,拼成完整 blob', async () => {
    const cacheDir = join(tmpRoot, 'case2');
    mkdirSync(join(cacheDir, 'blobs'), { recursive: true });
    // 预置前半段 .part
    writeFileSync(join(cacheDir, 'blobs', `${lfsSha}.part`), lfsContent.subarray(0, 100_000));
    stubRouter();
    const job = newJob();
    await runMsDownload({ msRepoId: 'Test/Repo', hfRepoId: 'Test/Repo', hfCacheDir: cacheDir, job });

    const rangeCalls = vi
      .mocked(fetch)
      .mock.calls.filter(
        ([u, init]) =>
          String(u).includes('model.safetensors') &&
          (init?.headers as Record<string, string> | undefined)?.Range === 'bytes=100000-',
      );
    expect(rangeCalls.length).toBeGreaterThan(0); // 确实带 Range 续传
    expect(readFileSync(join(cacheDir, 'blobs', lfsSha))).toEqual(lfsContent);
    expect(job.status).toBe('done');
  });

  it('已完整 blob 直接跳过(不请求文件 URL)', async () => {
    const cacheDir = join(tmpRoot, 'case3');
    mkdirSync(join(cacheDir, 'blobs'), { recursive: true });
    writeFileSync(join(cacheDir, 'blobs', lfsSha), lfsContent); // 已完整
    stubRouter();
    const job = newJob();
    await runMsDownload({ msRepoId: 'Test/Repo', hfRepoId: 'Test/Repo', hfCacheDir: cacheDir, job });

    const lfsCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([u]) => String(u).includes('weights/model.safetensors'));
    expect(lfsCalls.length).toBe(0);
    expect(job.status).toBe('done');
  });
});
