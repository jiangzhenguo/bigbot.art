/**
 * storyboard.materialize 铺节点参数单测(2026-10-09 「测试1」事故修复)
 *
 * 事故现场:Agent 用分镜表铺出 8 个 shot + 8 个 image-gen,结果
 *   ① 8 个 shot 的 `data.engine` 全是 'mock' → 产物落 outputs/mock/*.mp4,
 *      **一个都没走 h3**。用户以为在跑真模型,实际拿到的是 ffmpeg 占位片。
 *   ② 8 个 shot 里只有 Agent 事后手动 update_node 补的那一个带 accel,
 *      其余 7 个没有 → 「装了加速包却不加速」。
 *
 * 本文件锁住两条:
 *   A. 铺出的 shot 必须 engine='h3c'(与渲染层「+」弹层同口径)—— 不得写死 mock;
 *      演示态由 settings.renderMode 决定,节点不该自己写死引擎。
 *   B. 开了「默认加速」总开关时,铺出的 shot 全部带上同一份 accel;
 *      开关关闭 / 无可用包时**一律不写 accel**(存量行为不变)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ⚠️ 先于任何主进程模块加载:数据目录指向临时 HOME,绝不触碰真实用户数据(R5)
const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-materialize-'));
process.env.BIGBOTART_HOME = tmpHome;

const PROJECT = 'p-sb';
const CANVAS = 'c-sb';

/** 分镜表 markdown:两行,「需配图」列均为「是」→ 每行铺 shot + image-gen */
const MARKDOWN = [
  '# 分镜表',
  '',
  '| 镜号 | 画面描述 | 对白/旁白 | 景别 | 运镜 | 时长(s) | 需配图 |',
  '|---|---|---|---|---|---|---|',
  '| 1 | 机翼上两人对峙 | 无 | 远景 | 航拍侧移 | 5 | 是 |',
  '| 2 | 红衣特写 | 无 | 近景 | 慢推 | 3 | 是 |',
].join('\n');

let ToolHandlers: typeof import('../tool-handlers.js').ToolHandlers;

/** 只实现 materialize 路径上用到的 store 方法 */
function makeStore() {
  const snapshot = {
    id: CANVAS,
    name: '主画布',
    version: 1,
    nodes: [
      {
        id: 'sb-1',
        kind: 'storyboard',
        label: '分镜表',
        position: { x: 60, y: 80 },
        data: { markdown: MARKDOWN, aspect: '16:9', tier: 'default' },
      },
    ],
    edges: [],
    groups: [],
    updatedAt: new Date().toISOString(),
  };
  const saved: unknown[] = [];
  return {
    loadProjectCanvases: () => ({ projectId: PROJECT, canvases: [snapshot] }),
    saveCanvasSnapshot: (s: unknown) => {
      saved.push(s);
      return { ok: true };
    },
    __saved: saved,
    __snapshot: snapshot,
  } as unknown as import('../store.js').ProjectStore & {
    __saved: unknown[];
    __snapshot: typeof snapshot;
  };
}

/** 造一个只实现 defaultShotAccel 的 AccelStore stub(真实选包逻辑另有单测) */
function makeAccel(cfg: { enabled: true; packId: string; steps: 4 | 8 } | null) {
  return { defaultShotAccel: () => cfg } as unknown as import('../lora.js').AccelStore;
}

/**
 * 构造 ToolHandlers。
 * ⚠️ accel 走 **options 对象**的第 2 个字段(不是位置参数)。
 * 传 undefined 时 `this.accel?.defaultShotAccel()` 得 undefined,
 * 走「不写 accel」分支(与「用户没开总开关」等价),用来验证存量行为不变。
 */
function makeHandlers(accelImpl?: import('../lora.js').AccelStore) {
  const store = makeStore();
  const h = new ToolHandlers(
    store,
    {} as never, // assets
    {} as never, // skills
    {} as never, // exportSvc
    {} as never, // queue
    {} as never, // memory
    { accel: accelImpl as never },
  );
  return { h, store };
}

const ctx = { projectId: PROJECT, canvasId: CANVAS };

beforeAll(async () => {
  ToolHandlers = (await import('../tool-handlers.js')).ToolHandlers;
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/** 跑一次 materialize,返回铺出来的节点 */
async function materialize(accel: import('../lora.js').AccelStore | undefined, args: Record<string, unknown> = {}) {
  const { h, store } = makeHandlers(accel);
  const res = await h.call('storyboard.materialize', { nodeId: 'sb-1', ...args }, ctx);
  const snap = store.__snapshot as { nodes: Array<{ kind: string; data: Record<string, unknown> }> };
  return { res, nodes: snap.nodes };
}

describe('storyboard.materialize · shot 引擎(事故 A:不得写死 mock)', () => {
  it('铺出的 shot 一律 engine=h3c,不能是 mock', async () => {
    const { nodes } = await materialize(undefined);
    const shots = nodes.filter((n) => n.kind === 'shot');
    expect(shots.length).toBe(2);
    for (const s of shots) {
      // 事故回归:这里曾长期是 'mock',导致「用分镜表铺节点」永远只得到 ffmpeg 占位片
      expect(s.data.engine).toBe('h3c');
    }
  });

  it('engine 与渲染层「+」弹层同口径(两处都必须是 h3c)', async () => {
    const { nodes } = await materialize(undefined);
    const shot = nodes.find((n) => n.kind === 'shot')!;
    // 演示态由 settings.renderMode 统一决定,节点自身不该声明 mock
    expect(shot.data.engine).not.toBe('mock');
    expect(shot.data.mode).toBe('text2video');
  });
});

describe('storyboard.materialize · 加速默认(事故 B)', () => {
  it('总开关关闭 / 无 accel store → 不写 accel(存量行为不变)', async () => {
    const { nodes } = await materialize(undefined);
    for (const s of nodes.filter((n) => n.kind === 'shot')) {
      expect(s.data.accel).toBeUndefined();
    }
  });

  it('开关开启 → 每个 shot 都带上同一份 accel', async () => {
    const cfg = { enabled: true as const, packId: 'turbo-t8test', steps: 8 as const };
    const { nodes } = await materialize(makeAccel(cfg));
    const shots = nodes.filter((n) => n.kind === 'shot');
    expect(shots.length).toBe(2);
    for (const s of shots) {
      expect(s.data.accel).toEqual(cfg);
    }
  });

  it('同一批节点的 accel 完全一致(取一次复用的意义)', async () => {
    const cfg = { enabled: true as const, packId: 'turbo', steps: 4 as const };
    const { nodes } = await materialize(makeAccel(cfg));
    const accels = nodes.filter((n) => n.kind === 'shot').map((n) => JSON.stringify(n.data.accel));
    // 逐行各取一次会在用户中途改设置时产出参数不齐的一批;这里必须全部相同
    expect(new Set(accels).size).toBe(1);
  });

  it('image-gen 节点不带 accel(加速是 shot/h3 的概念)', async () => {
    const cfg = { enabled: true as const, packId: 'turbo-t8test', steps: 8 as const };
    const { nodes } = await materialize(makeAccel(cfg));
    for (const n of nodes.filter((x) => x.kind === 'image-gen')) {
      expect(n.data.accel).toBeUndefined();
    }
  });
});

describe('storyboard.materialize · image-gen 缺省模型(问题 2 回归)', () => {
  it('image-gen 不写死 model —— 留给提交期按「工具模型 > 内置默认」解析', async () => {
    const { nodes } = await materialize(undefined);
    const imgs = nodes.filter((n) => n.kind === 'image-gen');
    expect(imgs.length).toBe(2);
    for (const n of imgs) {
      // 写死会让「设置页选的模型」失效(事故 2 的形态:用户设了 2.1 却以为跑的是 z-image)
      expect(n.data.model).toBeUndefined();
      expect(n.data.engine).toBe('mlxgen');
    }
  });
});
