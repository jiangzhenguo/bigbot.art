/**
 * 数据迁移:平铺文件 → 按工作空间收拢到子目录(v1,2026-09-29)
 *
 * 把
 *   ~/.bigbotart/canvases-<pid>.json / memory-<pid>.json / takes-<pid>.json
 * 迁到
 *   ~/.bigbotart/workspaces/<pid>/{canvases,memory,takes}.json
 *
 * 并(批次2)把**项目资源**从全局 assets.json 拆到 workspaces/<pid>/assets.json:
 *   `projectId` 有值的资产/分类 → 该项目文件;缺省的留在全局 assets.json(总资源库)。
 *   ⚠️ **只搬元数据,不搬实体文件**:`Asset.localPath` 是绝对路径且不改写,实体仍留在全局
 *   `assets/`。搬实体要连带改协议白名单 + importAllowRoots + export 白名单,属独立一步。
 *
 * 设计约束(逐条都有理由,改前先读):
 *
 * 1. **幂等**:以 `.migration-ws-v1.json` 标记为权威闸;已迁移直接返回。
 *    ⚠️ "workspaces/ 目录存在"**不等于**迁移完成(上次可能中断在半途),故不据此 return,
 *    而是续跑:已搬的跳过、没搬的补上、目标冲突记 failures。
 * 2. **先备份再移动**:被动到的文件先复制一份到 backups-<YYYYMMDD>-ws-migrate/,再原地 rename。
 *    回滚 = 删掉 workspaces/ 目录 + revert 代码 —— 备份副本与旧文件都不删(红线 R5)。
 * 3. **只移不删**:`.bak` / `.demo-bak-*` / `.pre-rescue-*` 等历史快照后缀一律跳过,留在原地。
 * 4. **孤立 pid 一并迁移**:实测 6 个项目却有 19 个 canvases-*.json —— 大量文件属于已删除的项目。
 *    迁移器扫目录取 pid 并集(项目记录 ∪ 磁盘文件名),**不丢任何文件**。
 * 5. **单个失败不中断**:某个 pid 出错就记进失败清单继续做其余的,最后统一写日志总线(红线 R6),
 *    不做"静默吞掉一半迁移"。
 * 6. **不碰的**:assets/ 实体目录 / outputs/ / exports/ / settings.json / skills*.json
 *    (理由见 workspace-paths.ts 顶部注释)。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DATA_DIR,
  PROJECTS_FILE,
  WORKSPACES_DIR,
  workspaceDir,
  workspaceAssetsFile,
  canvasesFile,
  memoryFile,
  takesFile,
  legacyCanvasesFile,
  legacyMemoryFile,
  legacyTakesFile,
} from './workspace-paths.js';

/** 迁移标记文件(记录时间戳与移动清单,便于排错与回滚审计) */
const MARKER_FILE = join(DATA_DIR, '.migration-ws-v1.json');

/** 备份目录名(含日期;与既有的 backups-20260919 等命名风格一致) */
function backupDirName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `backups-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-ws-migrate`;
}

/** 每个 pid 要搬运的三类文件:旧路径 → 新路径 */
type MoveSpec = { from: string; to: string; label: string };

export interface MigrationResult {
  /** 是否真的执行了迁移(false = 已迁移过或无需迁移) */
  ran: boolean;
  /** 跳过原因(ran=false 时有值) */
  skipped?: string;
  movedFiles: number;
  projectsHandled: number;
  /** 搬运失败的项目 id + 原因(不中断其余项目) */
  failures: Array<{ projectId: string; error: string }>;
  backupDir?: string;
  /** 批次2:从全局 assets.json 拆出的项目资源条数(0 = 无需拆分) */
  assetsSplit?: number;
}

/** 从 projects.json 读项目 id(容错:文件缺失/损坏视为空) */
function readProjectIds(projectsFile: string = PROJECTS_FILE): string[] {
  if (!existsSync(projectsFile)) return [];
  try {
    const doc = JSON.parse(readFileSync(projectsFile, 'utf-8')) as { projects?: Array<{ id?: unknown }> };
    return (doc.projects ?? [])
      .map((p) => (typeof p?.id === 'string' ? p.id : ''))
      .filter((id): id is string => !!id);
  } catch {
    return [];
  }
}

/**
 * 扫磁盘上的旧平铺文件名,提取 pid。
 * 只认 `canvases-<pid>.json` / `memory-<pid>.json` / `takes-<pid>.json` 三种**精确形态**;
 * 带额外后缀的(.bak / .demo-bak-* / .pre-rescue-* 等历史快照)一律不认 —— 它们留在原地。
 */
export function collectLegacyProjectIds(dir: string = DATA_DIR): string[] {
  const ids = new Set<string>();
  const re = /^(?:canvases|memory|takes)-(.+)\.json$/;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of entries) {
    const m = re.exec(name);
    if (m?.[1]) ids.add(m[1]);
  }
  return [...ids].sort();
}

/**
 * 执行迁移。**必须在任何 Store 实例化之前调用**(ProjectStore 构造函数里就会读画布文件)。
 * 幂等:重复调用直接返回 ran:false。
 */
export function runDataMigration(opts: { dataDir?: string; now?: Date } = {}): MigrationResult {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const now = opts.now ?? new Date();
  const workspacesDir = opts.dataDir ? join(dataDir, 'workspaces') : WORKSPACES_DIR;
  const markerFile = opts.dataDir ? join(dataDir, '.migration-ws-v1.json') : MARKER_FILE;
  // ⚠️ projects.json 也必须跟随 dataDir —— 否则单测会读到真实 ~/.bigbotart(隔离失效),
  // 正式运行时若 opts.dataDir 与 BIGBOTART_HOME 不一致也会读错文件。
  const projectsFile = opts.dataDir ? join(dataDir, 'projects.json') : PROJECTS_FILE;

  const result: MigrationResult = { ran: false, movedFiles: 0, projectsHandled: 0, failures: [] };

  // ── 闸 1:标记文件存在 → 已迁移过 ──
  if (existsSync(markerFile)) {
    result.skipped = '已有迁移标记(.migration-ws-v1.json)';
    return result;
  }

  // ── 闸 2:workspaces/ 已存在 → **不直接判定完成**,继续续跑 ──
  // 只有标记文件才是"完成"的权威依据。上次迁移可能中断在半途(部分 pid 已搬、
  // 其余仍在旧路径),此时直接 return 会让剩余文件永远留在旧位置(业务代码已改读新路径 → 数据"消失")。
  // 故继续执行:无旧文件的 pid 自然跳过,已搬过的目标冲突记 failures,没搬的补上。

  // ── 取 pid 并集:项目记录 ∪ 磁盘旧文件名(孤立 pid 不能丢) ──
  const projectIds = new Set<string>([...readProjectIds(projectsFile), ...collectLegacyProjectIds(dataDir)]);
  if (projectIds.size === 0) {
    result.skipped = '没有需要迁移的项目数据(全新安装)';
    writeMarker(markerFile, { migratedAt: now.toISOString(), note: result.skipped, movedFiles: 0 });
    return result;
  }

  // ── 备份目录:延后到"确有文件要搬"时再建,避免空跑留下空目录 ──
  let backupDir: string | undefined;
  const ensureBackupDir = (): string => {
    if (!backupDir) {
      backupDir = join(dataDir, backupDirName(now));
      mkdirSync(backupDir, { recursive: true });
      result.backupDir = backupDir;
    }
    return backupDir;
  };

  const movedList: Array<{ projectId: string; from: string; to: string }> = [];

  for (const pid of projectIds) {
    // 旧路径拼接:opts.dataDir 用于单测隔离,正式运行走 workspace-paths 的常量
    const specs: MoveSpec[] = opts.dataDir
      ? [
          { from: join(dataDir, `canvases-${pid}.json`), to: join(workspacesDir, pid, 'canvases.json'), label: 'canvases' },
          { from: join(dataDir, `memory-${pid}.json`), to: join(workspacesDir, pid, 'memory.json'), label: 'memory' },
          { from: join(dataDir, `takes-${pid}.json`), to: join(workspacesDir, pid, 'takes.json'), label: 'takes' },
        ]
      : [
          { from: legacyCanvasesFile(pid), to: canvasesFile(pid), label: 'canvases' },
          { from: legacyMemoryFile(pid), to: memoryFile(pid), label: 'memory' },
          { from: legacyTakesFile(pid), to: takesFile(pid), label: 'takes' },
        ];

    // 该项目一个旧文件都没有 → 跳过(不建空目录)
    if (!specs.some((s) => existsSync(s.from))) continue;

    try {
      const destDir = opts.dataDir ? join(workspacesDir, pid) : workspaceDir(pid);
      mkdirSync(destDir, { recursive: true });

      for (const s of specs) {
        if (!existsSync(s.from)) continue;
        // 目标已存在(异常:上次迁移中断在半途)→ 不覆盖,记为失败让人工确认
        if (existsSync(s.to)) {
          result.failures.push({ projectId: pid, error: `目标已存在,拒绝覆盖:${s.to}` });
          continue;
        }
        copyFileSync(s.from, join(ensureBackupDir(), `${pid}.${s.label}.json`)); // 备份
        renameSync(s.from, s.to); // 同文件系统原子移动
        movedList.push({ projectId: pid, from: s.from, to: s.to });
        result.movedFiles += 1;
      }
      result.projectsHandled += 1;
    } catch (e) {
      result.failures.push({ projectId: pid, error: (e as Error).message });
    }
  }

  // ── 批次2:把全局 assets.json 里的项目资源拆到各自工作空间 ──
  const split = splitProjectAssets({
    dataDir,
    workspacesDir,
    backupDir: ensureBackupDir,
  });
  result.assetsSplit = split.moved;
  result.failures.push(...split.failures.map((f) => ({ projectId: f.projectId, error: f.error })));

  result.ran = true;
  writeMarker(markerFile, {
    migratedAt: now.toISOString(),
    backupDir,
    projectsHandled: result.projectsHandled,
    movedFiles: result.movedFiles,
    assetsSplit: result.assetsSplit,
    failures: result.failures,
    moved: movedList,
  });
  return result;
}

/** 内置资源文件结构(与 AssetStore 的 AssetStoreFile 同形;此处不 import 以免循环依赖) */
interface AssetsDoc {
  version?: number;
  assets?: Array<Record<string, unknown>>;
  categories?: Array<Record<string, unknown>>;
}

/**
 * 把全局 assets.json 中 `projectId` 有值的资产/分类拆到 `workspaces/<pid>/assets.json`。
 *
 * **只搬元数据,不搬实体文件**(`localPath` 是绝对路径,保持原样)。
 * - 备份原 assets.json 到备份目录,再**重写**全局文件(只留 projectId 缺省的 = 总资源库)
 * - 已有项目文件的 pid:**合并**而不是覆盖(避免续跑时丢掉上次已拆出的条目)
 * - 原文件不含任何项目资源时不动它(不制造无意义写盘)
 */
function splitProjectAssets(ctx: {
  dataDir: string;
  workspacesDir: string;
  backupDir: () => string;
}): { moved: number; failures: Array<{ projectId: string; error: string }> } {
  const failures: Array<{ projectId: string; error: string }> = [];
  const globalFile = join(ctx.dataDir, 'assets.json');
  if (!existsSync(globalFile)) return { moved: 0, failures };

  let doc: AssetsDoc;
  try {
    doc = JSON.parse(readFileSync(globalFile, 'utf-8')) as AssetsDoc;
  } catch {
    return { moved: 0, failures: [{ projectId: '(global)', error: `assets.json 无法解析,已跳过资源拆分:${globalFile}` }] };
  }
  // 旧版是裸数组(Array.isArray)→ 视为全部全局资源,不拆(交给 AssetStore 的 V1 迁移处理)
  if (Array.isArray(doc)) return { moved: 0, failures };

  const allAssets = Array.isArray(doc.assets) ? doc.assets : [];
  const allCats = Array.isArray(doc.categories) ? doc.categories : [];
  const projectAssets = allAssets.filter((a) => typeof a.projectId === 'string' && a.projectId);
  const projectCats = allCats.filter((c) => typeof c.projectId === 'string' && c.projectId);
  if (projectAssets.length === 0 && projectCats.length === 0) return { moved: 0, failures };

  // 备份原文件(只复制不删;回滚依据)
  try {
    copyFileSync(globalFile, join(ctx.backupDir(), '(global).assets.before-split.json'));
  } catch (e) {
    // 备份失败就不继续拆 —— 没有回滚依据的破坏性操作不做
    return { moved: 0, failures: [{ projectId: '(global)', error: `备份 assets.json 失败,已中止资源拆分:${(e as Error).message}` }] };
  }

  // 按 projectId 归组
  const byProject = new Map<string, { assets: Array<Record<string, unknown>>; categories: Array<Record<string, unknown>> }>();
  for (const a of projectAssets) {
    const pid = String(a.projectId);
    const b = byProject.get(pid) ?? { assets: [], categories: [] };
    b.assets.push(a);
    byProject.set(pid, b);
  }
  for (const c of projectCats) {
    const pid = String(c.projectId);
    const b = byProject.get(pid) ?? { assets: [], categories: [] };
    b.categories.push(c);
    byProject.set(pid, b);
  }

  // 逐个 pid 写项目文件(已存在则合并,按 id 去重)
  for (const [pid, incoming] of byProject) {
    try {
      const f = ctx.dataDir ? join(ctx.workspacesDir, pid, 'assets.json') : workspaceAssetsFile(pid);
      mkdirSync(join(ctx.workspacesDir, pid), { recursive: true });
      let existing: AssetsDoc = { version: 2, assets: [], categories: [] };
      if (existsSync(f)) {
        try {
          existing = JSON.parse(readFileSync(f, 'utf-8')) as AssetsDoc;
        } catch {
          failures.push({ projectId: pid, error: `项目资源文件损坏,拒绝覆盖:${f}` });
          continue;
        }
      }
      const ids = new Set((existing.assets ?? []).map((a) => String(a.id)));
      const catIds = new Set((existing.categories ?? []).map((c) => String(c.id)));
      const merged: AssetsDoc = {
        version: 2,
        assets: [...(existing.assets ?? []), ...incoming.assets.filter((a) => !ids.has(String(a.id)))],
        categories: [...(existing.categories ?? []), ...incoming.categories.filter((c) => !catIds.has(String(c.id)))],
      };
      writeFileSync(f, JSON.stringify(merged, null, 2));
    } catch (e) {
      failures.push({ projectId: pid, error: `写项目资源失败:${(e as Error).message}` });
    }
  }

  // 重写全局文件:只留 projectId 缺省的(总资源库)
  const kept: AssetsDoc = {
    version: 2,
    assets: allAssets.filter((a) => !(typeof a.projectId === 'string' && a.projectId)),
    categories: allCats.filter((c) => !(typeof c.projectId === 'string' && c.projectId)),
  };
  try {
    writeFileSync(globalFile, JSON.stringify(kept, null, 2));
  } catch (e) {
    failures.push({ projectId: '(global)', error: `重写全局 assets.json 失败:${(e as Error).message}` });
  }

  return { moved: projectAssets.length + projectCats.length, failures };
}

function writeMarker(file: string, payload: unknown): void {
  try {
    writeFileSync(file, JSON.stringify(payload, null, 2));
  } catch {
    /* 标记写不了不影响数据可用性:闸 2(workspaces/ 有内容)仍能挡住重复迁移 */
  }
}
