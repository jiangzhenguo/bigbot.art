/**
 * h3c Provider 的二采(second pass)链路单测 —— planSecondPass → CLI 参数 / ETA / 日志。
 *
 * 为什么单独成文件:h3c-command 的用例只验「构器拿到合法输入后输出什么」,
 * 而这一层要验「节点上的 `data.secondPass`(Agent 可能写 `true` / `{mode:'hires'}` /
 * 脏 fraction)经 shared 真源解析后,最终落成哪套 flag」。两层的失败形态不同:
 * 构器错了是拼错 flag,provider 错了是**根本没把参数接上**(控件看着生效、命令里没有)。
 *
 * ⚠️ 全面打桩 `node:child_process`:本用例绝不真实 spawn h3 或 ffmpeg(真实推理要几十分钟)。
 * dryRun 分支的占位 ffmpeg 走 mock 直接回 exit 0,因此也不会往磁盘写任何产物。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RenderRequest } from '@bigbotart/shared';

/** spawn 调用记录(vi.hoisted 供 mock 工厂引用) */
const h = vi.hoisted(() => ({ spawns: [] as Array<{ cmd: string; args: string[] }> }));

vi.mock('node:child_process', () => {
  const spawn = (cmd: string, args: string[]) => {
    h.spawns.push({ cmd, args: Array.isArray(args) ? args : [] });
    return {
      pid: 4242,
      exitCode: null,
      on: (event: string, cb: (code: number) => void) => {
        // 占位 ffmpeg 只在 close 时判定成败;异步回调保持与真实子进程同形态
        if (event === 'close') queueMicrotask(() => cb(0));
        return undefined;
      },
      kill: () => true,
      stdout: { on: () => undefined },
      stderr: { on: () => undefined },
    };
  };
  return {
    spawn,
    spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
    execFile: () => {
      throw new Error('本用例不应执行外部命令(参考图补齐走空列表)');
    },
  };
});

const { H3cProvider, estimateH3EtaSec } = await import('../h3c.js');

/** 取某个 flag 后面跟的值(未出现则 undefined) */
function valueOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

let outDir = '';
const logs: string[] = [];

beforeEach(() => {
  h.spawns.length = 0;
  logs.length = 0;
  outDir = mkdtempSync(join(tmpdir(), 'h3c-sp-'));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

/** 用给定 params 提交一次 dry-run(不真实推理),返回实际构造出的 h3 参数 */
async function submitWith(params: Record<string, unknown>): Promise<{ args: string[] }> {
  const provider = new H3cProvider({
    binaryPath: '/fake/h3',
    modelDir: '/fake/models',
    outputDir: outDir,
    // dryRun=false + spawn 打桩:这样 h3 参数会被真的构造并交给(假的)spawn,
    // 我们才能断言 CLI;dryRun 分支根本不会 spawn h3(只 spawn 占位 ffmpeg),看不到参数。
    dryRun: false,
    onLog: (line) => logs.push(line),
  });
  const req: RenderRequest = {
    nodeId: 'shot-1',
    slot: 'video',
    params: {
      prompt: 'Scene: test',
      width: 576,
      height: 1024,
      frames: 124,
      steps: 30,
      layers: 50,
      reuse: 1,
      seed: 42,
      tier: 'default',
      ...params,
    },
    references: [],
  };
  await provider.submit(req);
  const call = h.spawns.find((c) => c.cmd === '/fake/h3');
  expect(call, '应当把构造出的参数交给(打桩的)h3 进程').toBeTruthy();
  return { args: call!.args };
}

describe('h3c submit · 二采 refine(同画布精修)', () => {
  it('data.secondPass=true(Agent 最自然的写法)→ --second-pass 0.15,不带画布/渲染画布', async () => {
    const { args } = await submitWith({ secondPass: true });
    expect(valueOf(args, '--second-pass')).toBe('0.15');
    expect(args).not.toContain('--second-pass-canvas');
    expect(args).not.toContain('--render-width');
    expect(args).not.toContain('--render-height');
    expect(logs.join('\n')).toContain('同画布精修');
  });

  it('显式 fraction 透传(String 保精度,0.125 不会被四舍五入)', async () => {
    const { args } = await submitWith({ secondPass: { enabled: true, mode: 'refine', fraction: 0.125 } });
    expect(valueOf(args, '--second-pass')).toBe('0.125');
  });

  it('脏 fraction(0.9)被 planSecondPass 夹到同画布精修上限 0.6,并在日志里说明', async () => {
    const { args } = await submitWith({ secondPass: { enabled: true, mode: 'refine', fraction: 0.9 } });
    expect(valueOf(args, '--second-pass')).toBe('0.6');
    expect(logs.join('\n')).toContain('已调整为');
  });

  it('未开启(undefined / false)→ 一个二采 flag 都没有(存量行为零变化)', async () => {
    for (const sp of [undefined, false]) {
      const { args } = await submitWith({ secondPass: sp });
      expect(args).not.toContain('--second-pass');
      expect(args).not.toContain('--second-pass-canvas');
      expect(args).not.toContain('--render-width');
    }
  });
});

describe('h3c submit · 二采 canvas(Hires)', () => {
  it('mode=canvas:三组参数齐全(第一遍 render 画布 → F → 第二遍画布)', async () => {
    const { args } = await submitWith({ secondPass: { enabled: true, mode: 'canvas', fraction: 0.4 } });
    // 576×1024 的 2/3 边长配方 = 288×512(与 h3c-usage 推荐一致)
    expect(valueOf(args, '--render-width')).toBe('288');
    expect(valueOf(args, '--render-height')).toBe('512');
    expect(valueOf(args, '--second-pass')).toBe('0.4');
    expect(valueOf(args, '--second-pass-canvas')).toBe('576x1024');
    expect(logs.join('\n')).toContain('画布二采');
  });

  it('别名 mode=hires 同样按画布二采处理(Agent 会这么写)', async () => {
    const { args } = await submitWith({ secondPass: { enabled: true, mode: 'hires' } });
    expect(valueOf(args, '--render-width')).toBe('288');
    expect(valueOf(args, '--second-pass-canvas')).toBe('576x1024');
  });

  it('输出画布没有更小的同比例 32 倍数画布(544×480)→ 降级同画布精修,绝不产出裸 --second-pass-canvas', async () => {
    const { args } = await submitWith({
      width: 544,
      height: 480,
      secondPass: { enabled: true, mode: 'canvas', fraction: 0.4 },
    });
    // 降级后只剩 F(值不变:0.4 在精修区间内)
    expect(valueOf(args, '--second-pass')).toBe('0.4');
    expect(args).not.toContain('--second-pass-canvas');
    expect(args).not.toContain('--render-width');
    expect(args).not.toContain('--render-height');
    expect(logs.join('\n')).toContain('没有更小的同比例');
  });
});

describe('h3c submit · ETA 口径', () => {
  const baseEta = estimateH3EtaSec({ tier: 'default', width: 576, height: 1024 });

  it('同画布精修 ×1.18(ETA 不跟着涨会让用户以为卡死)', () => {
    const refine = estimateH3EtaSec({
      tier: 'default',
      width: 576,
      height: 1024,
      secondPass: { enabled: true, mode: 'refine', fraction: 0.15 },
    });
    expect(refine).toBe(Math.round(baseEta * 1.18));
    expect(refine).toBeGreaterThan(baseEta);
  });

  it('画布二采 ×1.5(多一遍 setup + 尾部重采样)', () => {
    const canvas = estimateH3EtaSec({
      tier: 'default',
      width: 576,
      height: 1024,
      secondPass: { enabled: true, mode: 'canvas', fraction: 0.4, render: { width: 288, height: 512 }, canvas: { width: 576, height: 1024 } },
    });
    expect(canvas).toBe(Math.round(baseEta * 1.5));
  });

  it('未开启二采 = 原口径;风格包仍不打折(既有语义不被二采改动)', () => {
    expect(
      estimateH3EtaSec({
        tier: 'default',
        width: 576,
        height: 1024,
        secondPass: { enabled: false, mode: 'refine', fraction: 0.15 },
      }),
    ).toBe(baseEta);
    const stylePack = estimateH3EtaSec({
      tier: 'default',
      width: 576,
      height: 1024,
      accel: { enabled: true, steps: 8, kind: 'style' },
    });
    expect(stylePack).toBe(baseEta);
  });
});
