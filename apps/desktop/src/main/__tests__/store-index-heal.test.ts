/**
 * 画布索引自愈测试 —— 「画布都消失了」事故回归(2026-09-29)
 *
 * 事故形态:
 *   1. 一个**跑旧构建**的实例读旧路径 `canvases-<pid>.json`(已迁移 → 视为空);
 *   2. 它调用 `createCanvas`,新建一张**空画布写到旧路径**,并用新 id 覆盖
 *      `projects.json` 的 `canvasIds/activeCanvasId`;
 *   3. 新位置 `workspaces/<pid>/canvases.json` 里**真实画布纹丝不动**(20 节点还在);
 *   4. 渲染层按悬空的 `activeCanvasId` 加载不到画布 → 判为「空项目」→ 再建一张空画布
 *      ⇒ **用户看到画布全空**。
 *
 * 数据从未丢失,是**索引被污染**。修复 = 以 `canvases.json` 为唯一真源,读时自愈 `projects.json`。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;
type StoreMod = typeof import('../store');
let storeMod: StoreMod;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bbart-store-heal-'));
  process.env.BIGBOTART_HOME = home;
  storeMod = await import('../store');
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

/** 直接铺一个「文件里是真实画布、projects.json 索引是悬空 id」的项目 */
function seedCorrupted(opts: { cids: string[]; fileActive: string; indexIds: string[]; indexActive: string }) {
  const pid = `proj-heal-${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(home, 'workspaces', pid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'canvases.json'),
    JSON.stringify({
      projectId: pid,
      canvases: opts.cids.map((id) => ({
        id,
        projectId: pid,
        name: '主画布',
        nodes: [{ id: 'n1', kind: 'shot', label: '镜头 01', position: { x: 0, y: 0 }, data: {}, createdAt: '', updatedAt: '' }],
        edges: [],
        version: 3,
        createdAt: '',
        updatedAt: '',
      })),
      activeCanvasId: opts.fileActive,
    }),
  );
  // 写 projects.json(索引指向悬空 id)
  const pf = join(home, 'projects.json');
  const doc = existsSync(pf) ? JSON.parse(readFileSync(pf, 'utf-8')) : { projects: [] };
  doc.projects.push({
    id: pid,
    name: `项目 ${pid}`,
    canvasIds: opts.indexIds,
    activeCanvasId: opts.indexActive,
    createdAt: '',
    updatedAt: '',
  });
  writeFileSync(pf, JSON.stringify(doc, null, 2));
  return pid;
}

const readProject = (pid: string) => {
  const doc = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf-8'));
  return doc.projects.find((p: { id: string }) => p.id === pid);
};

describe('画布索引自愈 · 事故回归', () => {
  it('悬空 activeCanvasId 被纠正为文件里的真实画布(用户不再看到空画布)', () => {
    const pid = seedCorrupted({
      cids: ['cv-real-1'],
      fileActive: 'cv-real-1',
      indexIds: ['cv-ghost-999'],
      indexActive: 'cv-ghost-999', // 旧构建写进来的悬空 id
    });

    const store = new storeMod.ProjectStore();
    const pc = store.loadProjectCanvases(pid);

    // 返回的是真实画布(20 节点那类),不是空的
    expect(pc.canvases).toHaveLength(1);
    expect(pc.canvases[0]!.id).toBe('cv-real-1');
    expect(pc.canvases[0]!.nodes).toHaveLength(1);
    // projects.json 已被自愈
    expect(readProject(pid).canvasIds).toEqual(['cv-real-1']);
    expect(readProject(pid).activeCanvasId).toBe('cv-real-1');
  });

  it('canvasIds 与文件不一致 → 以文件为准回写', () => {
    const pid = seedCorrupted({
      cids: ['cv-a', 'cv-b'],
      fileActive: 'cv-b',
      indexIds: ['cv-a'], // 索引少了一张
      indexActive: 'cv-a',
    });

    const store = new storeMod.ProjectStore();
    store.loadProjectCanvases(pid);

    expect(readProject(pid).canvasIds).toEqual(['cv-a', 'cv-b']);
    expect(readProject(pid).activeCanvasId).toBe('cv-a'); // 索引里的 active 仍有效 → 保留
  });

  it('索引本来就正确时不做任何写入(幂等)', () => {
    const pid = seedCorrupted({
      cids: ['cv-ok'],
      fileActive: 'cv-ok',
      indexIds: ['cv-ok'],
      indexActive: 'cv-ok',
    });
    const before = readFileSync(join(home, 'projects.json'), 'utf-8');

    const store = new storeMod.ProjectStore();
    store.loadProjectCanvases(pid);

    // 逐字节未变(没有多余的 save)
    expect(readFileSync(join(home, 'projects.json'), 'utf-8')).toBe(before);
  });

  it('孤立 pid(项目已删但文件还在)不写 projects.json', () => {
    const pid = 'proj-orphan-no-record';
    mkdirSync(join(home, 'workspaces', pid), { recursive: true });
    writeFileSync(
      join(home, 'workspaces', pid, 'canvases.json'),
      JSON.stringify({ projectId: pid, canvases: [{ id: 'cv-x', nodes: [], edges: [] }], activeCanvasId: 'cv-x' }),
    );
    const before = readFileSync(join(home, 'projects.json'), 'utf-8');

    const store = new storeMod.ProjectStore();
    const pc = store.loadProjectCanvases(pid);

    expect(pc.canvases).toHaveLength(1); // 照常读得到
    expect(readFileSync(join(home, 'projects.json'), 'utf-8')).toBe(before); // 但不污染索引
  });

  it('真实画布内容一个节点都不丢(事故核心断言)', () => {
    const pid = seedCorrupted({
      cids: ['cv-with-nodes'],
      fileActive: 'cv-with-nodes',
      indexIds: ['cv-ghost'],
      indexActive: 'cv-ghost',
    });

    const store = new storeMod.ProjectStore();
    store.loadProjectCanvases(pid); // 触发自愈
    const pc2 = store.loadProjectCanvases(pid); // 再读一次

    expect(pc2.canvases[0]!.nodes).toHaveLength(1);
    expect(pc2.canvases[0]!.nodes[0]!.label).toBe('镜头 01');
  });
});
