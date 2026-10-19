/**
 * store 版本防护测试 — 「Agent 工具增量写盘 vs 渲染层整体保存」竞态
 *
 * 背景:Agent 工具(canvas.create_node 等)在主进程增量写 store 并 saveCanvasSnapshot;
 * 渲染层(auto-save)用其内存快照整体替换。渲染层状态未同步时,旧版本整体保存会把
 * Agent 刚写的节点/连线吞掉(线上事故:Agent 建的 shot + ref-image 边从画布消失)。
 *
 * 修复:saveCanvasSnapshot 增加版本防护 —— snap.version 落后于 store 当前版本时
 * 拒绝覆盖(stale=true + current),由渲染层刷新后再保存;每次写盘回调 onCanvasSaved 广播。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasSnapshot } from '@bigbotart/shared';

let home: string;
type StoreMod = typeof import('../store');
let storeMod: StoreMod;

beforeAll(async () => {
  // store.ts 的 DATA_DIR 在模块加载时读 env —— 动态 import 前设好隔离目录
  home = mkdtempSync(join(tmpdir(), 'bbart-store-guard-'));
  process.env.BIGBOTART_HOME = home;
  storeMod = await import('../store');
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const freshCanvas = (): { store: InstanceType<StoreMod['ProjectStore']>; canvas: CanvasSnapshot } => {
  const store = new storeMod.ProjectStore();
  const p = store.createProject('guard-test');
  const c = store.createCanvas(p.id, '主画布');
  return { store, canvas: c };
};

/** 模拟 Agent 工具增量写盘(create_node + connect,每次 version+1 后整体保存) */
const agentWrite = (store: InstanceType<StoreMod['ProjectStore']>, canvas: CanvasSnapshot, nodeId: string): void => {
  const pc = store.loadProjectCanvases(canvas.projectId);
  const cur = pc.canvases.find((x) => x.id === canvas.id)!;
  const now = new Date().toISOString();
  cur.nodes.push({
    id: nodeId,
    kind: 'shot',
    label: nodeId,
    position: { x: 0, y: 0 },
    data: {
      engine: 'h3c',
      mode: 'ref-image',
      prompt: 'p',
      width: 1280,
      height: 720,
      frames: 124,
      steps: 30,
      layers: 50,
      reuse: 1,
      tier: 'default',
      seed: 1,
      refs: [],
    },
    createdAt: now,
    updatedAt: now,
  });
  cur.edges.push({ id: `e-${nodeId}`, source: 'pal', target: nodeId, label: 'ref-image' });
  cur.version += 1;
  store.saveCanvasSnapshot(cur);
};

describe('saveCanvasSnapshot 版本防护(渲染层整体保存 vs Agent 增量)', () => {
  it('渲染层持旧版本快照保存 → 拒绝覆盖(stale),Agent 写的节点/边保留', () => {
    const { store, canvas } = freshCanvas();
    agentWrite(store, canvas, 'shot-agent-1');

    // 渲染层从未同步:快照 version 还是创建时的初始值,内容也是旧的(无 Agent 节点)
    const staleSnap: CanvasSnapshot = {
      ...canvas,
      nodes: [],
      edges: [],
      version: canvas.version,
    };
    const r = store.saveCanvasSnapshot(staleSnap);
    expect(r.ok).toBe(false);
    expect(r.stale).toBe(true);
    expect(r.current?.version ?? 0).toBeGreaterThan(canvas.version);

    // 覆盖被拒:盘上仍是 Agent 写后的内容
    const after = store.loadProjectCanvases(canvas.projectId).canvases.find((x) => x.id === canvas.id)!;
    expect(after.nodes.some((n) => n.id === 'shot-agent-1')).toBe(true);
    expect(after.edges.some((e) => e.source === 'pal' && e.label === 'ref-image')).toBe(true);
  });

  it('渲染层同步到最新版本后保存成功(version 对齐不误拒)', () => {
    const { store, canvas } = freshCanvas();
    agentWrite(store, canvas, 'shot-agent-2');
    let pushed: CanvasSnapshot | undefined;
    store.onCanvasSaved = (snap) => {
      pushed = snap;
    };

    const cur = store.loadProjectCanvases(canvas.projectId).canvases.find((x) => x.id === canvas.id)!;
    // 渲染层刷新后:version = store 最新,内容 = store 全部(含 Agent 节点)
    const syncSnap: CanvasSnapshot = { ...cur, nodes: cur.nodes, edges: cur.edges, version: cur.version };
    // 渲染层在已同步内容上保存(例如拖动一个节点)
    const moved = { ...syncSnap, nodes: [...syncSnap.nodes] };
    const r = store.saveCanvasSnapshot(moved);
    expect(r.ok).toBe(true);
    expect(r.stale).toBeUndefined();
    // 写盘广播触发(渲染层据此保持同步)
    expect(pushed?.id).toBe(cur.id);
    expect(pushed?.version).toBeGreaterThan(cur.version);
  });

  it('未声明 allowEmpty 时,删到 0 节点的快照被拒绝,原节点还在', () => {
    const { store, canvas } = freshCanvas();
    agentWrite(store, canvas, 'shot-last');
    const cur = store.loadProjectCanvases(canvas.projectId).canvases.find((x) => x.id === canvas.id)!;
    const emptied: CanvasSnapshot = { ...cur, nodes: [], edges: [], version: cur.version + 1 };
    const r = store.saveCanvasSnapshot(emptied);
    expect(r.ok).toBe(false);
    expect(r.stale).toBe(true);
    const after = store.loadProjectCanvases(canvas.projectId).canvases.find((x) => x.id === canvas.id)!;
    expect(after.nodes.map((n) => n.id)).toEqual(['shot-last']);
  });

  it('allowEmpty 时,明确清空可以落成 0 节点', () => {
    const { store, canvas } = freshCanvas();
    agentWrite(store, canvas, 'shot-last');
    const cur = store.loadProjectCanvases(canvas.projectId).canvases.find((x) => x.id === canvas.id)!;
    const emptied: CanvasSnapshot = { ...cur, nodes: [], edges: [], version: cur.version + 1 };
    const r = store.saveCanvasSnapshot(emptied, { allowEmpty: true });
    expect(r.ok).toBe(true);
    const after = store.loadProjectCanvases(canvas.projectId).canvases.find((x) => x.id === canvas.id)!;
    expect(after.nodes).toEqual([]);
  });

  it('Agent 工具连续增量写盘不误伤(自身版本同步,不触发 stale)', () => {
    const { store, canvas } = freshCanvas();
    agentWrite(store, canvas, 'shot-a');
    agentWrite(store, canvas, 'shot-b');
    const final = store.loadProjectCanvases(canvas.projectId).canvases.find((x) => x.id === canvas.id)!;
    expect(final.nodes.some((n) => n.id === 'shot-a')).toBe(true);
    expect(final.nodes.some((n) => n.id === 'shot-b')).toBe(true);
    expect(final.version).toBeGreaterThan(canvas.version);
  });
});