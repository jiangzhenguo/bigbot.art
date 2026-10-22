/**
 * `save-canvas-snapshot` 的 allowEmpty 接线测试(2026-10-20「测试主画布删不掉节点」)
 *
 * 事故形态:用户删掉画布上**最后一个**节点 → 渲染层保存被两道闸同时吞掉
 *   ① 渲染层 `maybePersist` 无条件拦「本地 0 节点 && store 有节点」,收了 allowEmpty 却不读
 *   ② 即使读,IPC 契约 `saveCanvasSnapshot(snap)` 也**没有第二参数**,store 的 allowEmpty 永远拿不到
 * → 0 节点快照存不下去,写盘广播又把旧节点推回来,用户视角就是「点删除没反应 / 删了又回来」。
 *
 * 本文件锁第 ② 半(接线):
 *  - 不带 opts 的 0 节点快照 → store 拒绝,原节点还在(2026-09-22 防线的回归)
 *  - 带 `{allowEmpty:true}` → 真正落成 0 节点(用户合法清空)
 *  - allowEmpty 只对目标画布生效,不会顺带放行别的画布
 *
 * 渲染层那一半由 `canvas/__tests__/empty-save-guard.test.ts` 锁定。
 *
 * ⚠️ 状态读写一律走 IPC handler(不另 new Store):handler 闭包里是 index.ts 的那一份单例。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-save-empty-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');
process.env.BIGBOTART_DRYRUN = '1';

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();

vi.mock('electron', async () => {
  const actual = await import('./electron-stub');
  return {
    ...actual,
    app: {
      ...actual.app,
      isPackaged: false,
      getVersion: () => '0.1.0-test',
      whenReady: () => new Promise(() => {}),
    },
    ipcMain: {
      handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      },
      on: () => {},
    },
  };
});

function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`handler 未注册:${channel}`);
  return Promise.resolve(fn({}, ...args) as T);
}

interface Snap {
  id: string;
  projectId: string;
  name: string;
  nodes: Array<{ id: string; kind: string; label: string; position: { x: number; y: number }; data: Record<string, unknown> }>;
  edges: unknown[];
  groups: unknown[];
  viewport?: { x: number; y: number; z: number };
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

let projectId = '';
let canvasId = '';

beforeAll(async () => {
  await import('../index');
  const project = await call<{ id: string }>('create-project', '删除闸测试');
  projectId = project.id;
  const canvas = await call<Snap>('create-canvas', projectId, '主画布');
  canvasId = canvas.id;
});

function snapshotWith(nodes: Snap['nodes'], version: number): Snap {
  return {
    id: canvasId,
    projectId,
    name: '主画布',
    nodes,
    edges: [],
    groups: [],
    viewport: { x: 0, y: 0, z: 1 },
    version,
  };
}

async function nodeCount(): Promise<number> {
  const pc = await call<{ canvases: Snap[] }>('load-project-canvases', projectId);
  return pc.canvases.find((c) => c.id === canvasId)?.nodes.length ?? -1;
}

const oneNode = [
  {
    id: 'n1',
    kind: 'text',
    label: '唯一节点',
    position: { x: 0, y: 0 },
    data: { text: 'hello' },
  },
];

describe('save-canvas-snapshot · allowEmpty 接线', () => {
  it('先存一个有内容的画布', async () => {
    const r = await call<{ ok: boolean }>('save-canvas-snapshot', snapshotWith(oneNode, 1));
    expect(r.ok).toBe(true);
    expect(await nodeCount()).toBe(1);
  });

  it('不带 opts 的 0 节点快照被拒绝,原节点还在(2026-09-22 防线未破)', async () => {
    const r = await call<{ ok: boolean; stale?: boolean }>('save-canvas-snapshot', snapshotWith([], 2));
    expect(r.ok).toBe(false);
    expect(r.stale).toBe(true);
    expect(await nodeCount()).toBe(1);
  });

  it('⚠️ 0 节点 + 悬空边 → 永远拒绝,即使带 allowEmpty(2026-10-20 画布被抹空事故)', async () => {
    // 事故:渲染层窗口期构造出「nodes 空、edges 还在」的快照,allowEmpty 放行了,
    // 两个项目被抹成 0 节点 + 11/16 悬空边
    const store = await call<{ canvases: Snap[] }>('load-project-canvases', projectId);
    const v = store.canvases.find((c) => c.id === canvasId)!.version;
    const dangling: Snap = {
      ...snapshotWith([], v),
      edges: [{ source: 'ghost-a', target: 'ghost-b', label: 'first-frame' }],
    };
    const r = await call<{ ok: boolean; stale?: boolean }>('save-canvas-snapshot', dangling, { allowEmpty: true });
    expect(r.ok).toBe(false);
    expect(r.stale).toBe(true);
    // 原节点原封不动
    expect(await nodeCount()).toBe(1);
  });

  it('带 allowEmpty 的 0 节点快照真正落盘(用户删掉最后一个节点)', async () => {
    const r = await call<{ ok: boolean }>('save-canvas-snapshot', snapshotWith([], 2), { allowEmpty: true });
    expect(r.ok).toBe(true);
    expect(await nodeCount()).toBe(0);
  });

  it('清空后回到有节点再清空仍然可用(不是一次性状态)', async () => {
    const stored = await call<{ canvases: Snap[] }>('load-project-canvases', projectId);
    const v = stored.canvases.find((c) => c.id === canvasId)!.version;
    expect((await call<{ ok: boolean }>('save-canvas-snapshot', snapshotWith(oneNode, v))).ok).toBe(true);
    const v2 = (await call<{ canvases: Snap[] }>('load-project-canvases', projectId)).canvases.find((c) => c.id === canvasId)!.version;
    expect((await call<{ ok: boolean }>('save-canvas-snapshot', snapshotWith([], v2), { allowEmpty: true })).ok).toBe(true);
    expect(await nodeCount()).toBe(0);
  });
});
