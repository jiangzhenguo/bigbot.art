/**
 * ProjectStore — 项目/画布持久化(M1+:一个项目可有多画布)
 *
 * 文件布局(2026-09-29 起按工作空间收拢到子目录,见 workspace-paths.ts):
 *   ~/.bigbotart/projects.json                        ← 项目列表(含 canvasIds/activeCanvasId)
 *   ~/.bigbotart/workspaces/<projectId>/canvases.json ← 该项目下所有画布快照 + activeCanvasId
 *
 * 旧布局(canvases-<pid>.json 平铺在 DATA_DIR 下)由 migrate.ts 在启动时一次性搬迁;
 * 更早的 ~/.bigbotart/canvas-${projectId}.json(单个画布)在第一次 loadProjectCanvases
 * 时仍会自动迁移为"主画布"并归入新容器(目标改为新子目录),迁移后旧文件改名 .bak 保留。
 *
 * 骨架期实现:纯 JSON 文件存储(基于 Node 内置 fs,零依赖,Electron 内置 Node 20 也能跑)。
 * PRD §5.7 要求 SQLite(node:sqlite);由于 Electron 31 内置 Node 20.x 无 node:sqlite,
 * 采用"存储接口 + 文件实现",后续可无缝替换为 better-sqlite3 等(接口不变)。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CanvasSnapshot, Project, ProjectCanvases } from '@bigbotart/shared';
import {
  DATA_DIR,
  PROJECTS_FILE,
  canvasesFile as wsCanvasesFile,
  legacySingleCanvasFile,
} from './workspace-paths.js';

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

  /** 项目下的画布容器文件路径(workspaces/<pid>/canvases.json) */
  private canvasesFile(projectId: string): string {
    return wsCanvasesFile(projectId);
  }

  /** 旧版单画布文件路径(用于一次性迁移) */
  private legacyCanvasFile(projectId: string): string {
    return legacySingleCanvasFile(projectId);
  }

  /** 确保文件所在目录存在 —— 2026-09-29 改为子目录后,name 平铺时代只 mkdir DATA_DIR 的做法会 ENOENT */
  private ensureDir(file: string): void {
    mkdirSync(dirname(file), { recursive: true });
  }

  /**
   * 索引自愈:把 `projects.json` 里的 `canvasIds/activeCanvasId` 对齐到 `canvases.json` 的**真实内容**。
   *
   * 触发条件(任一不满足即视为索引被污染):
   *   - `canvasIds` 与文件里的画布 id 集合不一致;
   *   - `activeCanvasId` 不在真实画布列表里(悬空 → 渲染层加载不到,会误判成空项目)。
   *
   * 为什么必须做:渲染层 `App.tsx` 按 `activeCanvasId` 取画布,取不到就**新建一张空画布** ——
   * 索引一旦悬空,用户看到的就是「画布全空」,而真实数据其实完好(2026-09-29 真实事故)。
   * 这里以文件为准静默纠正,并在日志总线留痕(红线 R6:不静默吞)。
   */
  private reconcileProjectIndex(projectId: string, pc: ProjectCanvases): void {
    const p = this.docs.projects.find((x) => x.id === projectId);
    if (!p) return; // 孤立 pid(项目已删但文件还在):不动 projects.json
    const realIds = pc.canvases.map((c) => c.id);
    // active 的取舍:索引里的值**仍然有效就保留**(那是用户当前选中的画布,不能被文件里的旧值覆盖);
    // 只有悬空(指向已不存在的画布)时才回退到文件值,再不行退回第一张。
    const activeStillValid = !!p.activeCanvasId && realIds.includes(p.activeCanvasId);
    const idsMatch =
      Array.isArray(p.canvasIds) && p.canvasIds.length === realIds.length && p.canvasIds.every((id, i) => id === realIds[i]);
    if (idsMatch && activeStillValid) return;

    const nextActive = activeStillValid
      ? p.activeCanvasId
      : realIds.includes(pc.activeCanvasId)
        ? pc.activeCanvasId
        : (realIds[0] ?? MAIN_CANVAS_ID);

    console.warn(
      `[store] 画布索引与文件不一致,已自愈 projectId=${projectId} ` +
        `canvasIds=${JSON.stringify(p.canvasIds)} → ${JSON.stringify(realIds)} ` +
        `active=${p.activeCanvasId} → ${nextActive}`,
    );
    p.canvasIds = realIds;
    p.activeCanvasId = nextActive;
    this.save();
  }

  /**
   * 读项目下的画布容器;不存在时尝试从旧文件迁移;都没有则返回空容器。
   *
   * 🛡️ **自愈(2026-09-29 画布消失事故)**:`canvases.json` 是画布的**唯一真源**,
   * `projects.json` 里的 `canvasIds/activeCanvasId` 只是索引副本。二者不一致时(例如被一个
   * 跑旧构建、写旧路径的实例用悬空 id 覆盖过),**以文件为准回写 projects.json**。
   *
   * 事故形态:旧构建的 `createCanvas` 读旧路径 `canvases-<pid>.json`(已迁移 → 视为空)→
   * 新建一张空画布写到旧路径 + 用新 id 更新 projects.json;而新位置的真实画布纹丝不动。
   * 渲染层随后按 activeCanvasId 找不到画布 → 判为「空项目」→ 再建一张 ⇒ 用户看到**画布全空**。
   * 数据从未丢失,只是索引被污染。此处的自愈让下一次启动即自动纠正。
   */
  loadProjectCanvases(projectId: string): ProjectCanvases {
    const f = this.canvasesFile(projectId);
    if (existsSync(f)) {
      try {
        const pc = JSON.parse(readFileSync(f, 'utf-8')) as ProjectCanvases;
        this.reconcileProjectIndex(projectId, pc);
        return pc;
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
        this.ensureDir(f);
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
    const f = this.canvasesFile(pc.projectId);
    this.ensureDir(f);
    writeFileSync(f, JSON.stringify(pc, null, 2));
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