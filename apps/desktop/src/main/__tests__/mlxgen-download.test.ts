/**
 * mlxgen 下载管理测试(mlxgen-models.ts 的去重 + 停滞看门狗)
 * - mock child_process.spawn:不触网、不起真实 mlxgen
 * - 假定时器驱动看门狗:零字节增长 5 分钟 → 杀掉并以 HF_HUB_DISABLE_XET=1 重试;再停滞 → failed
 * - HF_HOME 指向临时目录,blobs 写字节模拟「下载在涨」
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* spawn 打桩:记录每次调用的参数,返回可控假子进程(vi.hoisted 供 mock 工厂引用) */
const h = vi.hoisted(() => ({ children: [] as any[], calls: [] as any[] }));
vi.mock('node:child_process', async () => {
  const { EventEmitter: EE } = await import('node:events');
  return {
    spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
      const c: InstanceType<typeof EE> & { killed: boolean; kill: ReturnType<typeof vi.fn> } =
        Object.assign(new EE(), {
          stdout: new EE(),
          stderr: new EE(),
          killed: false,
          kill: vi.fn(function (this: { killed: boolean }) {
            this.killed = true;
            return true;
          }),
        }) as never;
      h.children.push(c);
      h.calls.push({ cmd, args, opts });
      return c;
    },
  };
});

const REPO_ZIMAGE = 'AbstractFramework/z-image-turbo-8bit';
const REPO_SEEDVR = 'AbstractFramework/seedvr2-3b-8bit';

let hfHome = '';
let M: typeof import('../mlxgen-models.js');

const repoDir = (repoId: string): string =>
  join(hfHome, 'hub', `models--${repoId.replace(/[\/:]/g, '--')}`);
/** 模拟下载活动:往 blobs 里写字节(看门狗的地面真值) */
const growBlobs = (repoId: string, bytes = 1024): void => {
  const b = join(repoDir(repoId), 'blobs');
  mkdirSync(b, { recursive: true });
  writeFileSync(join(b, `chunk-${Date.now()}-${Math.random()}`), Buffer.alloc(bytes));
};

beforeAll(async () => {
  hfHome = mkdtempSync(join(tmpdir(), 'bbart-dlmgr-test-'));
  process.env.HF_HOME = hfHome;
  vi.useFakeTimers();
  // Qwen 系已改走 ModelScope 通道(真实 fetch)——本文件只测 spawn 通道,fetch 一律禁止
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('测试不应触网'))));
});

beforeEach(async () => {
  // 每用例重置模块状态(jobs/activeByRepo),两个 spawn 通道模型可复用
  vi.resetModules();
  M = await import('../mlxgen-models.js');
});

afterEach(() => {
  vi.clearAllTimers();
});

afterAll(() => {
  vi.useRealTimers();
  rmSync(hfHome, { recursive: true, force: true });
});

describe('mlxgenDownload 去重', () => {
  it('同一模型重复调用复用进行中任务,不起第二个进程', () => {
    const before = h.children.length;
    const r1 = M.mlxgenDownload(REPO_ZIMAGE);
    const r2 = M.mlxgenDownload(REPO_ZIMAGE);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r2.jobId).toBe(r1.jobId);
    expect(h.children.length).toBe(before + 1); // 只有一个 mlxgen 进程
  });

  it('不在白名单的 repoId 直接拒绝', () => {
    const r = M.mlxgenDownload('evil/arbitrary-repo');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不在图片模型清单内');
  });
});

describe('停滞看门狗(Xet 挂起形态)', () => {
  it('零字节增长 5 分钟 → 杀掉并以禁用 Xet 重试;仍停滞 → failed', () => {
    const r = M.mlxgenDownload(REPO_ZIMAGE);
    const first = h.children[h.children.length - 1];
    expect(h.calls[h.calls.length - 1].opts.env).not.toHaveProperty('HF_HUB_DISABLE_XET');

    // 5 分钟零增长 → 看门狗杀进程
    vi.advanceTimersByTime(310_000);
    expect(first.killed).toBe(true);
    first.emit('close', null); // SIGTERM 退出

    // 自动以 HF_HUB_DISABLE_XET=1 重试(同一 jobId)
    const second = h.children[h.children.length - 1];
    expect(second).not.toBe(first);
    expect((h.calls[h.calls.length - 1].opts.env as Record<string, string>).HF_HUB_DISABLE_XET).toBe('1');
    expect(M.mlxgenDownloadStatus(r.jobId!).status).toBe('running');

    // 经典通道仍零增长 5 分钟 → 终态失败(可重新下载)
    vi.advanceTimersByTime(310_000);
    expect(second.killed).toBe(true);
    second.emit('close', null);
    const st = M.mlxgenDownloadStatus(r.jobId!);
    expect(st.status).toBe('failed');
    expect(st.error).toContain('停滞');
  });

  it('blobs 有字节增长则看门狗不动手', () => {
    const r = M.mlxgenDownload(REPO_SEEDVR);
    const child = h.children[h.children.length - 1];
    vi.advanceTimersByTime(150_000);
    growBlobs(REPO_SEEDVR); // t=150s 写入 → 下个 tick(t=180s)记录为新增长点
    vi.advanceTimersByTime(290_000); // t=440s,距增长点 260s < 300s
    expect(child.killed).toBe(false);
    vi.advanceTimersByTime(50_000); // t=490s,tick 480s 时距增长点 300s → 杀
    expect(child.killed).toBe(true);
    child.emit('close', null); // 触发禁用 Xet 重试,释放定时器
    expect(M.mlxgenDownloadStatus(r.jobId!).status).toBe('running');
  });
});

describe('终态释放占用', () => {
  it('下载失败后可重新发起(新 jobId、新进程)', () => {
    const r1 = M.mlxgenDownload(REPO_SEEDVR);
    const child = h.children[h.children.length - 1];
    child.emit('close', 1); // 普通失败(非 Xet 报错文本)
    expect(M.mlxgenDownloadStatus(r1.jobId!).status).toBe('failed');
    const before = h.children.length;
    const r2 = M.mlxgenDownload(REPO_SEEDVR);
    expect(r2.jobId).not.toBe(r1.jobId);
    expect(h.children.length).toBe(before + 1);
  });
});
