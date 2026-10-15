/**
 * 技能4「阳台麻雀」:环境图连 first-frame、角色卡连 ref-image,
 * mode 被同步成首帧,h3 入队后才报 full references cannot be combined with frame anchors。
 *
 * 锁两道闸:
 *  1. canvas.connect 在已有对立端口时直接拒绝,不落边
 *  2. 存量脏图的 engine.submit 在入队前拒绝,不进队列
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-anchor-conflict-'));
process.env.BIGBOTART_HOME = tmpHome;

const PROJECT = 'p-anchor';
const CANVAS = 'c-anchor';

let ToolHandlers: typeof import('../tool-handlers.js').ToolHandlers;

beforeAll(async () => {
  ToolHandlers = (await import('../tool-handlers.js')).ToolHandlers;
});

const ctx = { projectId: PROJECT, canvasId: CANVAS };

function img(id: string, label: string) {
  return {
    id,
    kind: 'image-gen',
    label,
    position: { x: 0, y: 0 },
    data: { resultPath: `/tmp/${id}.png`, prompt: label, width: 1280, height: 720 },
  };
}

function shotNode(mode = 'text2video') {
  return {
    id: 'shot',
    kind: 'shot',
    label: '镜头 · 阳台麻雀变形记(15s)',
    position: { x: 400, y: 0 },
    data: {
      prompt: 'a chalk sparrow on a morning balcony',
      engine: 'h3c',
      mode,
      width: 864,
      height: 480,
      seconds: 15,
    },
  };
}

function harness(nodes: Array<Record<string, unknown>>, edges: Array<Record<string, unknown>> = []) {
  const snapshot = {
    id: CANVAS,
    name: '主画布',
    version: 1,
    nodes,
    edges,
    groups: [],
    updatedAt: new Date().toISOString(),
  };
  const queued: unknown[] = [];
  const store = {
    loadProjectCanvases: () => ({ projectId: PROJECT, canvases: [snapshot] }),
    saveCanvasSnapshot: () => ({ ok: true }),
  };
  const queue = {
    submit: (req: unknown) => {
      queued.push(req);
      return { providerTaskId: `job-${queued.length}` };
    },
    list: () => [],
    cancel: () => {},
  };
  const h = new ToolHandlers(
    store as never,
    { get: () => undefined } as never,
    {} as never,
    {} as never,
    queue as never,
    { getActiveSkillId: () => undefined } as never,
  );
  return { h, snapshot, queued };
}

describe('canvas.connect · 首帧与参考图互斥', () => {
  it('先连 first-frame 再连 ref-image → 拒绝且不落边', async () => {
    const { h, snapshot } = harness([img('env', '环境底图'), img('card', '粉笔角色卡'), shotNode()]);
    const first = await h.call(
      'canvas.connect',
      { from: 'env', to: 'shot', label: 'first-frame' },
      ctx,
    );
    expect(first.ok).toBe(true);
    const second = await h.call(
      'canvas.connect',
      { from: 'card', to: 'shot', label: 'ref-image' },
      ctx,
    );
    expect(second.ok).toBe(false);
    expect(second.result).toContain('互斥');
    expect(second.result).toContain('ref-image');
    expect(snapshot.edges).toHaveLength(1);
    expect((snapshot.edges[0] as { label: string }).label).toBe('first-frame');
  });

  it('先连 ref-image 再连 first-frame → 拒绝', async () => {
    const { h, snapshot } = harness([img('env', '环境底图'), img('card', '粉笔角色卡'), shotNode()]);
    const ref = await h.call('canvas.connect', { from: 'card', to: 'shot', label: 'ref-image' }, ctx);
    expect(ref.ok).toBe(true);
    expect(ref.result).toContain('ref-image');
    const anchor = await h.call('canvas.connect', { from: 'env', to: 'shot', label: 'first-frame' }, ctx);
    expect(anchor.ok).toBe(false);
    expect(anchor.result).toContain('first-frame');
    expect(snapshot.edges).toHaveLength(1);
  });

  it('first-frame 与 ref-audio 可以共存', async () => {
    const audio = {
      id: 'aud',
      kind: 'asset',
      label: '环境音',
      position: { x: 0, y: 200 },
      data: { assetId: 'asset-aud', mediaType: 'audio' },
    };
    const { h, snapshot } = harness([img('env', '环境底图'), audio, shotNode()]);
    expect((await h.call('canvas.connect', { from: 'env', to: 'shot', label: 'first-frame' }, ctx)).ok).toBe(true);
    const audioEdge = await h.call('canvas.connect', { from: 'aud', to: 'shot', label: 'ref-audio' }, ctx);
    expect(audioEdge.ok).toBe(true);
    expect(snapshot.edges).toHaveLength(2);
  });
});

describe('engine.submit · 存量混连不入队', () => {
  it('技能4 形态(first-frame + 两张 ref-image)提交被拒绝', async () => {
    const { h, queued } = harness(
      [img('env', '环境底图'), img('card', '粉笔角色卡'), img('hand', '手部参考'), shotNode('first-frame')],
      [
        { id: 'e1', source: 'env', target: 'shot', label: 'first-frame' },
        { id: 'e2', source: 'card', target: 'shot', label: 'ref-image' },
        { id: 'e3', source: 'hand', target: 'shot', label: 'ref-image' },
      ],
    );
    const res = await h.call('engine.submit', { nodeId: 'shot' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('提交被拒绝');
    expect(res.result).toContain('互斥');
    expect(queued).toHaveLength(0);
  });

  it('只有 ref-image 的关联镜头可以提交', async () => {
    const { h, queued } = harness(
      [img('env', '环境底图'), img('card', '粉笔角色卡'), shotNode('ref-image')],
      [
        { id: 'e1', source: 'env', target: 'shot', label: 'ref-image' },
        { id: 'e2', source: 'card', target: 'shot', label: 'ref-image' },
      ],
    );
    const res = await h.call('engine.submit', { nodeId: 'shot' }, ctx);
    expect(res.ok).toBe(true);
    expect(queued).toHaveLength(1);
  });
});
