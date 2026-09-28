/**
 * 引擎自检(引导向导第 4 步)单测
 *
 * 覆盖:
 *  1. `parseH3Info` 纯函数:真实 h3 `--info` 输出解析(GPU/内存/checkpoint 计数),
 *     以及「退 0 但无 checkpoint」的边界(只看 exit code 会误判就绪)
 *  2. `runSelfCheck` 结构:四项齐全、passed/total 自洽、每项带真实耗时
 *  3. 失败面**不静默**:h3 二进制缺失 / mlxgen 未装 / LLM 端点不可达
 *     都必须返回 ok=false **且带可执行 hint**(R6:不吞错)
 *  4. LLM 探测真实发请求:fetch 打桩,验证确实 POST 了带 `tools` 的
 *     /chat/completions 请求(工具调用能力是 Agent 能干活的硬前提)
 *  5. 数据目录检查真实写盘:临时 HOME 下可写 → 通过;并清理探针文件
 *
 * 关键:模块级常量按 env 求值 → 必须在模块顶层先设 env,再在测试内动态 import。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ⚠️ 先于任何主进程模块加载:目录指向临时 HOME,绝不触碰真实用户数据(R5),
//    并把 h3 指到不存在的路径 —— 默认场景即「未安装」,不依赖本机是否真有 h3
const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-selfcheck-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_BIN = join(tmpHome, 'no-such-h3');
process.env.BIGBOTART_H3_MODEL = join(tmpHome, 'no-such-model');

let selfcheck: typeof import('../selfcheck.js');

beforeAll(async () => {
  selfcheck = await import('../selfcheck.js');
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('parseH3Info — 真实 h3 --info 输出解析', () => {
  /** 本机 h3-metal 0.1.0-dev 的真实输出样本(勿改格式) */
  const REAL_OUTPUT = [
    'h3-metal 0.1.0-dev',
    'Device: Apple M5 Pro (applegpu_g17s)',
    '  physical memory       64.0 GiB',
    '  recommended GPU set   51.8 GiB',
    '  max Metal buffer      38.9 GiB',
    '  Apple GPU family      10',
    '  Metal 4               yes',
    '  unified memory        yes',
    'Native checkpoint inventory (header-only):',
    '  Qwen3-VL encoder   14 files  1058 tensors   62.133 GiB',
    '  FL2VA DiT          13 files   535 tensors   61.728 GiB',
    '  Ref2VA DiT         13 files   535 tensors   61.728 GiB',
    '  video VAE           1 files   560 tensors    9.700 GiB',
    '  audio VAE           1 files  1087 tensors    0.564 GiB',
  ].join('\n');

  it('解析真实 GPU / 内存 / checkpoint 清单行数', () => {
    const r = selfcheck.parseH3Info(REAL_OUTPUT);
    expect(r.gpu).toBe('Apple M5 Pro (applegpu_g17s)');
    expect(r.mem).toBe('64.0');
    expect(r.models).toBe(5); // 5 个组件行(Qwen3-VL / FL2VA / Ref2VA / video VAE / audio VAE)
  });

  it('设备段齐全但零 checkpoint → models 为 0(只看 exit code 会误判就绪)', () => {
    const out = [
      'Device: Apple M5 Pro (applegpu_g17s)',
      '  physical memory       64.0 GiB',
      'Native checkpoint inventory (header-only):',
    ].join('\n');
    const r = selfcheck.parseH3Info(out);
    expect(r.gpu).toBe('Apple M5 Pro (applegpu_g17s)');
    expect(r.models).toBe(0);
  });

  it('空输出 / 垃圾输出不抛错,返回零值', () => {
    expect(() => selfcheck.parseH3Info('')).not.toThrow();
    const r = selfcheck.parseH3Info('random garbage');
    expect(r.models).toBe(0);
    expect(r.gpu).toBeUndefined();
  });

  it('不把「出现过 safetensors 字样」误判为就绪(旧实现的坑)', () => {
    const r = selfcheck.parseH3Info('loading model.safetensors ...\nDevice: X');
    expect(r.models).toBe(0);
  });
});

describe('runSelfCheck — 报告结构', () => {
  it('四项齐全、passed/total 自洽、每项带真实耗时与 label', async () => {
    const report = await selfcheck.runSelfCheck();
    expect(report.items).toHaveLength(4);
    expect(report.total).toBe(4);
    expect(report.items.map((i) => i.id)).toEqual(['h3c', 'mlxgen', 'llm', 'storage']);
    expect(report.passed).toBe(report.items.filter((i) => i.ok).length);
    for (const item of report.items) {
      expect(typeof item.label).toBe('string');
      expect(item.label.length).toBeGreaterThan(0);
      expect(typeof item.detail).toBe('string');
      expect(item.detail.length).toBeGreaterThan(0);
      expect(typeof item.ms).toBe('number');
      expect(item.ms).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);

  it('h3 二进制缺失 → 明确失败 + 可执行 hint(不静默吞)', async () => {
    const report = await selfcheck.runSelfCheck();
    const h3 = report.items.find((i) => i.id === 'h3c')!;
    expect(h3.ok).toBe(false);
    expect(h3.detail).toContain('h3 二进制');
    expect(h3.hint).toMatch(/BIGBOTART_H3_BIN|make -j8/);
  }, 60_000);

  it('数据目录检查真实写盘且清理探针文件(临时 HOME 可写 → 通过)', async () => {
    const report = await selfcheck.runSelfCheck();
    const st = report.items.find((i) => i.id === 'storage')!;
    expect(st.ok).toBe(true);
    expect(st.detail).toContain(tmpHome);
    // 探针文件必须被清理,不留残渣
    const leftovers = readdirSync(tmpHome).filter((f) => f.startsWith('.selfcheck-'));
    expect(leftovers).toEqual([]);
    expect(existsSync(tmpHome)).toBe(true);
  }, 60_000);
});

describe('LLM 工具回环 — 真实发请求(打桩)', () => {
  it('POST 带 tools 的 /chat/completions;200 → 通过', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { role: 'assistant', content: '' } }] }),
      });
    });
    const report = await selfcheck.runSelfCheck();
    vi.unstubAllGlobals();

    const llm = report.items.find((i) => i.id === 'llm')!;
    expect(llm.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toMatch(/\/chat\/completions$/);
    // 必须真带 tools:这是「端点能工具调用」的证据,不是普通连通性
    expect(Array.isArray(call.body.tools)).toBe(true);
    expect(llm.detail).toContain('工具 schema');
  }, 60_000);

  it('端点不可达 → 失败 + 提示启动 LM Studio(不静默)', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));
    const report = await selfcheck.runSelfCheck();
    vi.unstubAllGlobals();
    const llm = report.items.find((i) => i.id === 'llm')!;
    expect(llm.ok).toBe(false);
    expect(llm.detail).toContain('ECONNREFUSED');
    expect(llm.hint).toMatch(/LM Studio|Local Server/);
  }, 60_000);

  it('404(模型不存在)→ 失败且 hint 指向「选择已加载的模型」', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve('{"error":"model not found"}'),
      }),
    );
    const report = await selfcheck.runSelfCheck();
    vi.unstubAllGlobals();
    const llm = report.items.find((i) => i.id === 'llm')!;
    expect(llm.ok).toBe(false);
    expect(llm.detail).toContain('404');
    expect(llm.hint).toContain('模型');
  }, 60_000);
});
