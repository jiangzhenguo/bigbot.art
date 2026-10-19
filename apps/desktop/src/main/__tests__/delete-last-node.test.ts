/**
 * canvas.delete_node 删到最后一节点 — 2026-10-16「开始制作」
 *
 * 用户说「删除所有节点」。前 6 个都删掉了,最后的「镜头 05」每次
 * canvas.delete_node 都回「已删除」,紧接着 list_nodes 还看得到。
 *
 * 根因:saveCanvasSnapshot 拒绝 0 节点覆盖(防渲染层 flush 把画布写空),
 * delete_node 不看返回值,照样报成功。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasSnapshot } from '@bigbotart/shared';

let home: string;
type StoreMod = typeof import('../store');
type HandlersMod = typeof import('../tool-handlers');
let storeMod: StoreMod;
let ToolHandlers: HandlersMod['ToolHandlers'];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bbart-delete-last-'));
  process.env.BIGBOTART_HOME = home;
  storeMod = await import('../store');
  ToolHandlers = (await import('../tool-handlers')).ToolHandlers;
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function seed(nodeIds: string[]): { store: InstanceType<StoreMod['ProjectStore']>; canvas: CanvasSnapshot } {
  const store = new storeMod.ProjectStore();
  const p = store.createProject('delete-last');
  const canvas = store.createCanvas(p.id, '主画布');
  const pc = store.loadProjectCanvases(p.id);
  const cur = pc.canvases.find((c) => c.id === canvas.id)!;
  const now = new Date().toISOString();
  for (const id of nodeIds) {
    cur.nodes.push({
      id,
      kind: 'shot',
      label: id,
      position: { x: 0, y: 0 },
      data: { engine: 'h3c', prompt: 'p' } as CanvasSnapshot['nodes'][number]['data'],
      createdAt: now,
      updatedAt: now,
    });
  }
  cur.version += 1;
  store.saveCanvasSnapshot(cur);
  return { store, canvas };
}

function handlers(store: InstanceType<StoreMod['ProjectStore']>) {
  return new ToolHandlers(store, {} as never, {} as never, {} as never, {} as never, {} as never);
}

describe('canvas.delete_node 删除最后一节点', () => {
  it('只剩一个节点时删除成功,画布变为 0 节点', async () => {
    const { store, canvas } = seed(['shot-05']);
    const h = handlers(store);
    const res = await h.call('canvas.delete_node', { nodeId: 'shot-05' }, { projectId: canvas.projectId, canvasId: canvas.id });
    expect(res.ok).toBe(true);
    expect(res.result).toContain('已删除');
    const after = store.loadProjectCanvases(canvas.projectId).canvases.find((c) => c.id === canvas.id)!;
    expect(after.nodes).toEqual([]);
  });

  it('先删到剩一个,再删最后一个,两次都真的落盘', async () => {
    const { store, canvas } = seed(['shot-04', 'shot-05']);
    const h = handlers(store);
    const ctx = { projectId: canvas.projectId, canvasId: canvas.id };
    const first = await h.call('canvas.delete_node', { nodeId: 'shot-04' }, ctx);
    expect(first.ok).toBe(true);
    let nodes = store.loadProjectCanvases(canvas.projectId).canvases.find((c) => c.id === canvas.id)!.nodes;
    expect(nodes.map((n) => n.id)).toEqual(['shot-05']);
    const last = await h.call('canvas.delete_node', { nodeId: 'shot-05' }, ctx);
    expect(last.ok).toBe(true);
    nodes = store.loadProjectCanvases(canvas.projectId).canvases.find((c) => c.id === canvas.id)!.nodes;
    expect(nodes).toEqual([]);
  });
});
