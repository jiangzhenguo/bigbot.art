/**
 * 删除画布 — 2026-10-22「删未命名画布 2 无效」
 *
 * 事故链:UI 删完当前画布 → switchCanvas 先 flushSaveNow →
 * saveCanvasSnapshot 对未知 id 旧逻辑 push → 画布当场复活。
 * 修法:store 拒绝写入不存在的画布;UI 删完不 flush / 不 switch。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;
type StoreMod = typeof import('../store');
let storeMod: StoreMod;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bbart-del-canvas-'));
  process.env.BIGBOTART_HOME = home;
  storeMod = await import('../store');
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('ProjectStore.deleteCanvas', () => {
  it('删除非唯一画布成功,active 切到剩余第一个', () => {
    const store = new storeMod.ProjectStore();
    const p = store.createProject('多画布');
    const a = store.createCanvas(p.id, '主画布');
    const b = store.createCanvas(p.id, '未命名画布 2');
    store.switchActiveCanvas(p.id, b.id);

    const r = store.deleteCanvas(p.id, b.id);
    expect(r.ok).toBe(true);
    const pc = store.loadProjectCanvases(p.id);
    expect(pc.canvases.map((c) => c.id)).toEqual([a.id]);
    expect(pc.activeCanvasId).toBe(a.id);
  });

  it('事故回归:删除后用旧 id flush 不得复活画布', () => {
    const store = new storeMod.ProjectStore();
    const p = store.createProject('复活测试');
    store.createCanvas(p.id, '主画布');
    const b = store.createCanvas(p.id, '未命名画布 2');
    store.switchActiveCanvas(p.id, b.id);

    expect(store.deleteCanvas(p.id, b.id).ok).toBe(true);

    const zombie = store.saveCanvasSnapshot({
      id: b.id,
      projectId: p.id,
      name: '未命名画布 2',
      nodes: [
        {
          id: 'n1',
          kind: 'asset',
          label: '残留',
          position: { x: 0, y: 0 },
          data: {},
          createdAt: 't',
          updatedAt: 't',
        },
      ],
      edges: [],
      version: 2,
      createdAt: b.createdAt,
      updatedAt: new Date().toISOString(),
    });
    expect(zombie.ok).toBe(false);

    const pc = store.loadProjectCanvases(p.id);
    expect(pc.canvases.some((c) => c.id === b.id)).toBe(false);
    expect(pc.canvases).toHaveLength(1);
  });

  it('只剩一个画布时拒绝删除', () => {
    const store = new storeMod.ProjectStore();
    const p = store.createProject('单画布');
    const a = store.createCanvas(p.id, '主画布');
    const r = store.deleteCanvas(p.id, a.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('至少保留');
  });
});
