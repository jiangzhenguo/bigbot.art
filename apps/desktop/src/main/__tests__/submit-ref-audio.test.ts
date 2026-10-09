/**
 * Agent 侧 `engine.submit` 的「视频 → 音频参考」提交路径(2026-10-08)
 *
 * 与渲染层 runNode 同口径:`deriveShotRefsFromEdges` 派生出来的 ref-audio 若指向
 * **视频文件**,提交前必须由 `extractAudio` 换成抽出的 wav —— h3 的 `--ref-audio`
 * 要的是音轨,把 mp4 直接塞进去只会得到一句看不懂的报错。
 *
 * 本文件锁死两件事:
 *  1. 视频源 **真被换成 wav**(真跑 ffmpeg);
 *  2. 抽不出来时**明确失败**并回传原因,不静默降级(红线 R6)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// ⚠️ 先于主进程模块加载:产物目录与 takes 都指向临时 HOME,绝不触碰真实用户数据(R5)
const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-refaudio-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');

const hasFfmpeg = (() => {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

const outDir = join(tmpHome, 'outputs');
const PROJECT = 'p-refaudio';
const CANVAS = 'c-refaudio';

/** 带音轨的上游成片(shot 产物) / 无音轨的成片 */
let upstreamWithAudio = '';
let upstreamNoAudio = '';

let ToolHandlers: typeof import('../tool-handlers.js').ToolHandlers;
const captured: Array<Record<string, unknown>> = [];

function makeQueue() {
  return {
    submit: (req: Record<string, unknown>) => {
      captured.push(req);
      return { providerTaskId: `job-${captured.length}` };
    },
    list: () => [],
    cancel: () => {},
  } as unknown as import('../render-queue.js').RenderQueue;
}

/** 画布:上游镜头(有声/无声)+ 下游镜头,中间连一条 ref-audio 边 */
function makeStore(upstreamPath: string) {
  const snapshot = {
    id: CANVAS,
    name: '主画布',
    version: 1,
    nodes: [
      {
        id: 'up',
        kind: 'shot',
        label: '上游镜头',
        position: { x: 0, y: 0 },
        data: { resultPath: upstreamPath, prompt: 'x' },
      },
      {
        id: 'down',
        kind: 'shot',
        label: '下游镜头',
        position: { x: 400, y: 0 },
        data: { prompt: '一个美女跳舞', engine: 'h3c', mode: 'text2video', width: 544, height: 544 },
      },
    ],
    edges: [{ id: 'e1', source: 'up', target: 'down', label: 'ref-audio' }],
    groups: [],
    updatedAt: new Date().toISOString(),
  };
  return {
    loadProjectCanvases: () => ({ projectId: PROJECT, canvases: [snapshot] }),
    saveCanvasSnapshot: () => ({ ok: true }),
  } as unknown as import('../store.js').ProjectStore;
}

function makeHandlers(store: import('../store.js').ProjectStore) {
  return new ToolHandlers(
    store,
    { get: () => undefined } as never,
    {} as never,
    {} as never,
    makeQueue(),
    {} as never,
    { takes: { append: () => ({ id: 'take-1' }), patch: () => undefined } as never },
  );
}

beforeAll(async () => {
  ToolHandlers = (await import('../tool-handlers.js')).ToolHandlers;
  if (!hasFfmpeg) return;
  mkdirSync(outDir, { recursive: true });
  upstreamWithAudio = join(outDir, 'up-audio.mp4');
  const g1 = spawnSync('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=s=320x240:d=1:r=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    upstreamWithAudio,
  ], { stdio: 'ignore' });
  if (g1.status !== 0) throw new Error('无法生成带音轨测试视频');

  upstreamNoAudio = join(outDir, 'up-silent.mp4');
  const g2 = spawnSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x240:d=1:r=24',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', upstreamNoAudio,
  ], { stdio: 'ignore' });
  if (g2.status !== 0) throw new Error('无法生成无音轨测试视频');
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe.runIf(hasFfmpeg)('engine.submit · 视频源 → ref-audio 抽音轨', () => {
  it('上游成片的 ref-audio 被换成抽出的 wav 后再提交', async () => {
    captured.length = 0;
    const h = makeHandlers(makeStore(upstreamWithAudio));
    const res = await h.call('engine.submit', { nodeId: 'down', provider: 'h3c' }, { projectId: PROJECT, canvasId: CANVAS });
    expect(res.ok, res.result).toBe(true);

    const req = captured[0]!;
    const refs = (req.references ?? []) as Array<{ role: string; localPath: string }>;
    const audio = refs.find((r) => r.role === 'ref-audio');
    expect(audio, 'ref-audio 未被提交').toBeTruthy();
    // 关键:提交给 h3 的必须是抽出来的 wav,不是上游 mp4
    expect(audio!.localPath.endsWith('.wav'), `实际提交了 ${audio!.localPath}`).toBe(true);
    expect(existsSync(audio!.localPath)).toBe(true);
  });

  it('上游成片没有音轨 → 明确失败并说明原因(不静默降级成文生视频)', async () => {
    captured.length = 0;
    const h = makeHandlers(makeStore(upstreamNoAudio));
    const res = await h.call('engine.submit', { nodeId: 'down', provider: 'h3c' }, { projectId: PROJECT, canvasId: CANVAS });
    expect(res.ok).toBe(false);
    expect(res.result).toContain('音频参考抽取失败');
    expect(res.result).toContain('没有音轨');
    // 不允许「抽不出来就照常提交」—— 那会让 h3 拿到 mp4,错误跑到很远的地方才暴露
    expect(captured.length).toBe(0);
  });
});
