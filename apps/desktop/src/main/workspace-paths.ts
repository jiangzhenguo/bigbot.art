/**
 * 工作空间(Workspace)目录约定 —— 单一事实来源
 *
 * 背景(2026-09-29):在此之前,项目级数据在 ~/.bigbotart/ 下**平铺**:
 *   projects.json / canvases-<pid>.json / memory-<pid>.json / takes-<pid>.json
 * 一个项目的数据散在 4 个文件里,删除项目会留下一地孤儿文件(实测:6 个项目却
 * 有 20+ 个 canvases-*.json、15 个 memory-*.json),也没法"整个项目搬走"。
 *
 * 现改为**按工作空间收拢到子目录**,与「项目 = 工作空间」的定位一致:
 *   ~/.bigbotart/workspaces/<projectId>/
 *     ├── canvases.json     ← 该项目全部画布快照 + activeCanvasId
 *     ├── memory.json       ← Agent 分层记忆
 *     ├── takes.json        ← Take 历史
 *     └── assets/           ← 对话附件副本(既有的 copyAttachmentsToProject)
 *
 * ⚠️ **用户可见的概念仍叫「项目」**(Project),本模块只表达"物理目录按项目隔离"。
 * 文件与内部键名一律保留 project 语义(projects.json 只做文件名迁移,键名不动),
 * 避免把一次目录收拢扩大成全仓库改名。
 *
 * **不改动的**:
 * - settings.json / skills.json / skills-builtin-deleted.json —— 全局配置
 * - assets.json + assets/  —— **全局资源库**(跨项目共享,projectId 缺省的资产)
 *                            + projects/<pid>/assets/ 内的项目副本
 * - outputs/ —— 产物根(runLocalImageNode / 各 Provider 产物)。旧节点 data.resultPath
 *               与 asset.localPath 存的是**绝对路径**,迁移目录会让历史产物全部失效,
 *               故原位保留(详见 docs 迁移方案 §四)
 * - exports/ —— 全局导出目录
 *
 * 迁移器见 migrate.ts;旧文件只移不删,回滚 = 删除本模块约定的 workspaces/ 目录。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 数据根目录(BIGBOTART_HOME 覆盖;与各 Store 的既有取值保持一致) */
export const DATA_DIR = process.env.BIGBOTART_HOME ?? join(homedir(), '.bigbotart');

/** 项目列表文件(由旧的 projects.json 迁移而来;**内部键名仍是 projects**) */
export const PROJECTS_FILE = join(DATA_DIR, 'projects.json');

/** 工作空间根目录:每个项目一个子目录 */
export const WORKSPACES_DIR = join(DATA_DIR, 'workspaces');

/** 某个工作空间(项目)的子目录 */
export function workspaceDir(projectId: string): string {
  return join(WORKSPACES_DIR, projectId);
}

/** 该项目的画布容器文件 */
export function canvasesFile(projectId: string): string {
  return join(workspaceDir(projectId), 'canvases.json');
}

/** 该项目的 Agent 记忆文件 */
export function memoryFile(projectId: string): string {
  return join(workspaceDir(projectId), 'memory.json');
}

/** 该项目的 Take 历史文件 */
export function takesFile(projectId: string): string {
  return join(workspaceDir(projectId), 'takes.json');
}

/**
 * 该项目的**资源元数据**文件(2026-09-29 批次2:项目资源从全局 assets.json 拆出)。
 *
 * ⚠️ **只管元数据,不管实体文件**:资产的实体文件(48 条)一律仍写在全局
 * `~/.bigbotart/assets/`(ASSETS_DIR),`Asset.localPath` 是**绝对路径且不改写**。
 * 理由:搬实体文件要连带重写每条 localPath + `bba-asset://` 协议白名单 +
 * importAllowRoots/export 白名单,风险面比批次1 大;拆元数据已足够让"项目资源
 * 归项目",实体文件位置留作独立一步(与 outputs/ 同口径)。
 */
export function workspaceAssetsFile(projectId: string): string {
  return join(workspaceDir(projectId), 'assets.json');
}

/* ── 旧路径(仅供迁移器读取 / 兼容分支使用,不要在业务代码里写入) ── */

/** @deprecated 旧平铺画布容器:canvases-<pid>.json */
export function legacyCanvasesFile(projectId: string): string {
  return join(DATA_DIR, `canvases-${projectId}.json`);
}

/** @deprecated 更早的单画布文件:canvas-<pid>.json */
export function legacySingleCanvasFile(projectId: string): string {
  return join(DATA_DIR, `canvas-${projectId}.json`);
}

/** @deprecated 旧平铺记忆:memory-<pid>.json */
export function legacyMemoryFile(projectId: string): string {
  return join(DATA_DIR, `memory-${projectId}.json`);
}

/** @deprecated 旧平铺 Take:takes-<pid>.json */
export function legacyTakesFile(projectId: string): string {
  return join(DATA_DIR, `takes-${projectId}.json`);
}
