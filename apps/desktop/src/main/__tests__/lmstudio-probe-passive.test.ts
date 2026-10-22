/**
 * LM Studio 探测的「无副作用」护栏(2026-10-21 用户反馈回归)
 *
 * 故障形态:进入「设置 → LLM 来源」时总是先闪一下 LM Studio,然后 LM Studio 被自动启动。
 * 根因:listLmStudio() 一上来就 exec `lms ls --json`,而 `lms` CLI 在服务没跑时会
 * 「唤醒」LM Studio 守护进程(二进制里 `wakeUpServiceFromLocation` → `LM Studio started`);
 * 这个函数又被设置页 / 对话页 / 引导页的**被动探测**调用 —— 看一眼状态就把用户的 App 拉起来。
 *
 * 现行契约(本文件锁死):
 *  1. LM Studio 服务不可达(/v1/models 失败)→ 直接判不可用,**一次 `lms` 都不许 exec**
 *  2. 服务已在跑 → 才允许用 `lms ls` 补全尺寸/工具标记(REST 常缺 sizeBytes)
 *  3. 旧版只有 /v1/models → 复用探活响应,不再二次请求
 *
 * child_process 全程打桩:测试里绝不允许真的执行 `lms`(会在开发机上启动 LM Studio)。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

/** execFile 调用记录 + lms 尝试计数(vi.hoisted 供 mock 工厂引用) */
const h = vi.hoisted(() => ({
  exec: [] as Array<{ file: string; args: string[] }>,
  lmsAttempts: 0,
  /** 设置后,`lms ls --json` 返回这份 stdout(模拟 LM Studio 在跑且 CLI 可用) */
  cliStdout: null as string | null,
}));

vi.mock('node:child_process', () => {
  const execFile = (
    file: string,
    args: string[],
    optsOrCb: unknown,
    maybeCb?: unknown,
  ): void => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as
      | ((err: Error | null, out?: { stdout: string; stderr: string }) => void)
      | undefined;
    h.exec.push({ file, args: Array.isArray(args) ? args : [] });
    if (/(^|\/)lms$/.test(file)) {
      h.lmsAttempts += 1;
      if (h.cliStdout) {
        cb?.(null, { stdout: h.cliStdout, stderr: '' });
        return;
      }
      cb?.(new Error('lms 不可用'));
      return;
    }
    // sysctl / security 等:空输出即可(memTotalGb 走 64GB 兜底)
    cb?.(null, { stdout: '', stderr: '' });
  };
  return {
    execFile,
    spawn: () => {
      throw new Error('被动探测不应 spawn 任何子进程');
    },
  };
});

let listLmStudio: typeof import('../llm.js').listLmStudio;

beforeAll(async () => {
  ({ listLmStudio } = await import('../llm.js'));
});

/** 假的 fetch Response(GET /models 与 /api/v0/models 共用) */
const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h.exec.length = 0;
  h.lmsAttempts = 0;
  h.cliStdout = null;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listLmStudio — 被动探测绝不启动 LM Studio', () => {
  it('服务不可达:判不可用,且一次 lms 都不 exec', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'));

    const r = await listLmStudio();

    expect(r.available).toBe(false);
    expect(r.detail).toContain('未检测到 LM Studio');
    expect(h.lmsAttempts).toBe(0);
    expect(h.exec.some((c) => c.args[0] === 'ls')).toBe(false);
  });

  it('服务在跑:才允许用 lms ls 补全 sizeBytes / 工具标记', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/v0/models')) {
        // 新版 REST:缺 sizeBytes(正是需要 CLI 补全的场景)
        return okJson({ data: [{ id: 'qwen3-4b', type: 'llm', state: 'loaded' }] });
      }
      // 探活:/v1/models
      return okJson({ data: [{ id: 'qwen3-4b' }] });
    });
    h.cliStdout = JSON.stringify([
      { modelKey: 'qwen3-4b', sizeBytes: 2_500_000_000, displayName: 'Qwen3 4B', trainedForToolUse: true },
    ]);

    const r = await listLmStudio();

    expect(r.available).toBe(true);
    expect(h.lmsAttempts).toBeGreaterThan(0);
    expect(r.models[0]?.id).toBe('qwen3-4b');
    expect(r.models[0]?.sizeBytes).toBe(2_500_000_000);
    expect(r.models[0]?.displayName).toContain('Qwen3 4B');
    expect(r.models[0]?.loaded).toBe(true);
  });

  it('旧版只有 /v1/models:复用探活响应,不二次请求', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/v0/models')) throw new Error('HTTP 404');
      return okJson({ data: [{ id: 'ornith-35b' }] });
    });

    const r = await listLmStudio();

    expect(r.available).toBe(true);
    expect(r.models.map((m) => m.id)).toEqual(['ornith-35b']);
    // /v1/models 只打了一次(旧实现会在兜底里再请求一遍)
    const v1Calls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith(':1234/v1/models'));
    expect(v1Calls).toHaveLength(1);
  });

  it('CLI 不可用(未装 lms)也不影响 REST 结果', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/v0/models')) return okJson({ data: [{ id: 'm', type: 'llm' }] });
      return okJson({ data: [{ id: 'm' }] });
    });
    h.cliStdout = null; // 让 lms 打桩返回错误

    const r = await listLmStudio();

    expect(r.available).toBe(true);
    expect(r.models[0]?.id).toBe('m');
  });
});
