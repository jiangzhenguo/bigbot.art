/**
 * ProjectStore — 项目/画布持久化(M1+:一个项目可有多画布)
 *
 * 文件布局:
 *   ~/.bigbotart/projects.json                 ← 项目列表(含 canvasIds/activeCanvasId)
 *   ~/.bigbotart/canvases-${projectId}.json    ← 该项目下所有画布快照 + activeCanvasId
 *
 * 向后兼容:旧版 ~/.bigbotart/canvas-${projectId}.json(单个画布)会在第一次
 * loadProjectCanvases 时自动迁移为"主画布"并归入新容器,迁移后旧文件保留
 * 备份但不再使用。
 *
 * 骨架期实现:纯 JSON 文件存储(基于 Node 内置 fs,零依赖,Electron 内置 Node 20 也能跑)。
 * PRD §5.7 要求 SQLite(node:sqlite);由于 Electron 31 内置 Node 20.x 无 node:sqlite,
 * 采用"存储接口 + 文件实现",后续可无缝替换为 better-sqlite3 等(接口不变)。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CanvasSnapshot, Project, ProjectCanvases } from '@bigbotart/shared';

const DATA_DIR = process.env.BIGBOTART_HOME ?? join(homedir(), '.bigbotart');
const PROJECTS_FILE = join(DATA_DIR, 'projects.json');

interface StoredDoc {
  projects: Project[];
}

/** 主画布固定 id —— 新建/迁移项目无画布时使用 */
const MAIN_CANVAS_ID = 'main';

export class ProjectStore {
  private docs: StoredDoc;

  /** 画布快照写盘回调(主进程注册 → 广播给渲染层;Agent 工具增量写与渲染层整体保存都会触发) */
  onCanvasSaved?: (snap: CanvasSnapshot) => void;

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
    this.docs = this.read();
  }

  init(): Promise<void> {
    this.save();
    return Promise.resolve();
  }

  private read(): StoredDoc {
    if (!existsSync(PROJECTS_FILE)) return { projects: [] };
    try {
      return JSON.parse(readFileSync(PROJECTS_FILE, 'utf-8')) as StoredDoc;
    } catch {
      return { projects: [] };
    }
  }

  private save() {
    writeFileSync(PROJECTS_FILE, JSON.stringify(this.docs, null, 2));
  }

  /** 项目下的画布容器文件路径 */
  private canvasesFile(projectId: string): string {
    return join(DATA_DIR, `canvases-${projectId}.json`);
  }

  /** 旧版单画布文件路径(用于一次性迁移) */
  private legacyCanvasFile(projectId: string): string {
    return join(DATA_DIR, `canvas-${projectId}.json`);
  }

  /** 读项目下的画布容器;不存在时尝试从旧文件迁移;都没有则返回空容器 */
  loadProjectCanvases(projectId: string): ProjectCanvases {
    const f = this.canvasesFile(projectId);
    if (existsSync(f)) {
      try {
        return JSON.parse(readFileSync(f, 'utf-8')) as ProjectCanvases;
      } catch {
        // 文件损坏:尝试迁移/回退到空容器
      }
    }
    // 迁移旧 canvas-${projectId}.json 为主画布
    const legacy = this.legacyCanvasFile(projectId);
    if (existsSync(legacy)) {
      try {
        const old = JSON.parse(readFileSync(legacy, 'utf-8')) as {
          nodes?: unknown[]; edges?: unknown[]; version?: number;
        };
        const now = new Date().toISOString();
        const main: CanvasSnapshot = {
          id: MAIN_CANVAS_ID,
          projectId,
          name: '主画布',
          nodes: (old.nodes ?? []) as CanvasSnapshot['nodes'],
          edges: (old.edges ?? []) as CanvasSnapshot['edges'],
          version: (old.version ?? 0) + 1,
          createdAt: now,
          updatedAt: now,
        };
        const migrated: ProjectCanvases = {
          projectId,
          canvases: [main],
          activeCanvasId: MAIN_CANVAS_ID,
        };
        writeFileSync(f, JSON.stringify(migrated, null, 2));
        // 把旧文件改名备份(.bak),保留以便排错
        try { renameSync(legacy, legacy + '.bak'); } catch { /* ignore */ }
        return migrated;
      } catch {
        /* fallthrough */
      }
    }
    return { projectId, canvases: [], activeCanvasId: MAIN_CANVAS_ID };
  }

  /** 写项目下的画布容器;同时回写项目的 activeCanvasId */
  private saveProjectCanvases(pc: ProjectCanvases): void {
    writeFileSync(this.canvasesFile(pc.projectId), JSON.stringify(pc, null, 2));
    const p = this.docs.projects.find((x) => x.id === pc.projectId);
    if (p) {
      p.canvasIds = pc.canvases.map((c) => c.id);
      p.activeCanvasId = pc.activeCanvasId;
      p.updatedAt = new Date().toISOString();
      this.save();
    }
  }

  /** 单画布快照写回(自动定位到对应项目容器)。
   *  版本防护:snap.version 落后于 store 当前版本(如 Agent 工具已增量写盘、渲染层还持旧状态)时
   *  拒绝整体覆盖(stale=true + 最新 current),让渲染层刷新后再保存 —— 修复「Agent 操作的画布被
   *  渲染层旧快照覆盖」(两个写入者无版本协调时,整体替换会把增量写入吞掉)。 */
  saveCanvasSnapshot(snap: CanvasSnapshot): { ok: boolean; stale?: boolean; current?: CanvasSnapshot } {
    const pc = this.loadProjectCanvases(snap.projectId);
    const now = new Date().toISOString();
    const idx = pc.canvases.findIndex((c) => c.id === snap.id);
    const cur = idx >= 0 ? pc.canvases[idx] : undefined;
    // 🛡️ 防护:空快照覆盖有内容的画布一律拒绝(最后防线)。
    // 事故背景(2026-09-22):渲染层在「画布尚未装填」的瞬间 flush 了一次空快照,把 version 374 的
    // 有内容画布写成了空画布;version 防护挡不住(渲染层版本并不落后),只能靠内容判空兜底。
    // 用户真要清空画布时,渲染层会先删节点(每次删除都算内容变化)→ 那时传的是「非首次」的空快照,
    // 这里按「当前 store 有、传入为空」拒绝;确需清空请走 delete-canvas 或先删到只剩一个节点再删。
    if (cur && (cur.nodes?.length ?? 0) > 0 && (snap.nodes?.length ?? 0) === 0 && (snap.edges?.length ?? 0) === 0) {
      this.onCanvasSaved?.(cur);
      return { ok: false, stale: true, current: cur };
    }
    // 防护:传入快照 version 落后于当前(说明 store 有更新的写入,渲染层未同步)→ 拒绝覆盖
    if (cur && (snap.version ?? 0) < cur.version) {
      // 广播最新快照:渲染层凭此同步 version/内容,下一次保存不再落后(避免反复被拒)
      this.onCanvasSaved?.(cur);
      return { ok: false, stale: true, current: cur };
    }
    const next: CanvasSnapshot = {
      ...snap,
      version: (snap.version ?? 0) + 1,
      createdAt: cur?.createdAt ?? now,
      updatedAt: now,
    };
    if (idx >= 0) pc.canvases[idx] = next;
    else pc.canvases.push(next);
    // 没活动画布就设它
    if (!pc.activeCanvasId || !pc.canvases.some((c) => c.id === pc.activeCanvasId)) {
      pc.activeCanvasId = pc.canvases[0]?.id ?? snap.id;
    }
    this.saveProjectCanvases(pc);
    // 写盘后广播最新快照(渲染层同步本地状态;Agent 工具与渲染层保存都从这里驱动 UI)
    this.onCanvasSaved?.(next);
    return { ok: true };
  }

  listProjects(): Project[] {
    // 修正旧数据:没有新字段的项目补默认值
    for (const p of this.docs.projects) {
      if (!p.canvasIds) p.canvasIds = [];
      if (!p.activeCanvasId) p.activeCanvasId = MAIN_CANVAS_ID;
    }
    return [...this.docs.projects].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  createProject(name: string): Project {
    const now = new Date().toISOString();
    const id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const p: Project = {
      id, name, canvasIds: [], activeCanvasId: MAIN_CANVAS_ID,
      createdAt: now, updatedAt: now,
    };
    this.docs.projects.push(p);
    this.save();
    return p;
  }

  deleteProject(id: string): { ok: boolean; error?: string } {
    const idx = this.docs.projects.findIndex((p) => p.id === id);
    if (idx < 0) return { ok: false, error: '项目不存在' };
    this.docs.projects.splice(idx, 1);
    this.save();
    return { ok: true };
  }

  renameProject(id: string, name: string): { ok: boolean; error?: string } {
    const p = this.docs.projects.find((x) => x.id === id);
    if (!p) return { ok: false, error: '项目不存在' };
    p.name = name;
    p.updatedAt = new Date().toISOString();
    this.save();
    return { ok: true };
  }

  getProject(id: string): Project | undefined {
    return this.docs.projects.find((p) => p.id === id);
  }

  /** 项目级 LLM 覆盖(null 清除,回退全局) */
  setProjectLlm(id: string, llm: Project['llmOverride'] | null): { ok: boolean; error?: string } {
    const p = this.docs.projects.find((x) => x.id === id);
    if (!p) return { ok: false, error: '项目不存在' };
    p.llmOverride = llm ?? undefined;
    p.updatedAt = new Date().toISOString();
    this.save();
    return { ok: true };
  }

  /** 创建一个新画布;若项目还没有画布,这个画布成为主画布 */
  createCanvas(projectId: string, name?: string): CanvasSnapshot {
    const pc = this.loadProjectCanvases(projectId);
    const now = new Date().toISOString();
    const seq = pc.canvases.length + 1;
    const canvas: CanvasSnapshot = {
      id: `cv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      projectId,
      name: name?.trim() || `未命名画布 ${seq}`,
      nodes: [],
      edges: [],
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    pc.canvases.push(canvas);
    if (pc.canvases.length === 1) pc.activeCanvasId = canvas.id;
    this.saveProjectCanvases(pc);
    return canvas;
  }

  renameCanvas(projectId: string, canvasId: string, name: string): { ok: boolean; error?: string } {
    const pc = this.loadProjectCanvases(projectId);
    const c = pc.canvases.find((x) => x.id === canvasId);
    if (!c) return { ok: false, error: '画布不存在' };
    const v = name.trim();
    if (!v) return { ok: false, error: '名称不能为空' };
    if (v.length > 24) return { ok: false, error: '名称过长(≤24)' };
    c.name = v;
    c.updatedAt = new Date().toISOString();
    this.saveProjectCanvases(pc);
    return { ok: true };
  }

  deleteCanvas(projectId: string, canvasId: string): { ok: boolean; error?: string } {
    const pc = this.loadProjectCanvases(projectId);
    if (pc.canvases.length <= 1) return { ok: false, error: '至少保留一个画布' };
    const idx = pc.canvases.findIndex((c) => c.id === canvasId);
    if (idx < 0) return { ok: false, error: '画布不存在' };
    pc.canvases.splice(idx, 1);
    if (pc.activeCanvasId === canvasId) {
      const next = pc.canvases[0];
      if (next) pc.activeCanvasId = next.id;
    }
    this.saveProjectCanvases(pc);
    return { ok: true };
  }

  switchActiveCanvas(projectId: string, canvasId: string): { ok: boolean; error?: string } {
    const pc = this.loadProjectCanvases(projectId);
    if (!pc.canvases.some((c) => c.id === canvasId)) return { ok: false, error: '画布不存在' };
    if (pc.activeCanvasId === canvasId) return { ok: true };
    pc.activeCanvasId = canvasId;
    this.saveProjectCanvases(pc);
    return { ok: true };
  }
}