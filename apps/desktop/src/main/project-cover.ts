/**
 * 项目封面(Project Cover)—— 把首页/项目页那张**假图**换成项目真实产物
 *
 * ## 背景
 * 首页项目卡片与项目管理页此前用 `PROJ_THUMBS` / `env-dusk.jpg` 四张打包进来的
 * 静态图轮流充数 —— 打开任何项目看到的封面都跟内容无关。本模块提供真实封面。
 *
 * ## 两条来源(手动优先,可清除回自动)
 *  1. **auto**(缺省):取画布上**第一个产图节点**的产物。图片优先;整个项目一张图片都
 *     没有时,回退到第一个产物(可能是 mp4 —— 渲染层抽首帧,见 media.tsx 的 VideoPoster)。
 *  2. **manual**:用户从本地上传一张图,登记为项目资源并记 `Project.coverAssetId`。
 *     手动设过就**不再被新产物顶掉**;清除后立刻回到 auto(见 `clearCover`)。
 *
 * ## 为什么「图片优先」而不是「严格按节点顺序」
 * 实测真实项目的 `resultPath` 里 mp4 与 png 混排(「你好」项目第一个产物就是镜头 mp4),
 * 严格按顺序会把视频当封面 —— 视频要抽帧、首帧还可能是黑屏。图片优先能覆盖绝大多数
 * 项目;真的一张图都没有时才退回视频抽帧兜底(有总比占位图强)。
 *
 * ## 路径语义
 * 只认**磁盘上真实存在**的产物(`existsSync`)。文件被删/换机后,auto 会自动跳到下一个
 * 候选,或返回 `path: null` 让渲染层显示占位 —— **绝不返回一个指向空气的路径**
 * (那会得到一个破图,比占位图更让人以为功能坏了)。
 */
import { existsSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { CanvasSnapshot, Project, ProjectCover } from '@bigbotart/shared';
import { isUnderRoot, ASSETS_DIR, OUTPUTS_DIR, importAllowRoots } from './assets.js';
import type { ProjectStore } from './store.js';
import type { AssetStore } from './assets.js';

/** 图片扩展名(与 assets.ts 的 KIND_BY_EXT 同口径的图片子集) */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|avif|heic|tiff|bmp)$/i;
/** 视频扩展名(与 media.tsx 的 VIDEO_EXT_RE 同口径) */
const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;

export function isImageFile(p: string | null | undefined): boolean {
  return !!p && IMAGE_EXT_RE.test(basename(p));
}

export function isVideoFile(p: string | null | undefined): boolean {
  return !!p && VIDEO_EXT_RE.test(basename(p));
}

/** 单个节点候选:该节点产出的、**磁盘上真实存在**的文件路径 */
export interface CoverCandidate {
  nodeId: string;
  nodeKind: string;
  label: string;
  path: string;
  isVideo: boolean;
}

/**
 * 从节点 `data` 里挖出所有产物路径。
 *
 * 覆盖三种既有形态(不是我们发明的,是各节点早就写进 data 的):
 *  - `resultPath`        —— 单产物节点(shot / image-gen / image-edit / frame-grab …)
 *  - `pieces: string[]`  —— image-split 的多片产物(第 1 片同时写 resultPath,这里去重)
 *  - `outputs`           —— 工作流出口节点的汇聚产物
 */
export function collectNodePaths(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as Record<string, unknown>;
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim() && !out.includes(v)) out.push(v);
  };
  push(d.resultPath);
  if (Array.isArray(d.pieces)) for (const p of d.pieces) push(p);
  if (Array.isArray(d.outputs)) for (const o of d.outputs) push(o);
  return out;
}

/**
 * 按「画布顺序 → 节点顺序」收集封面候选(**只含有磁盘实体文件的**)。
 *
 * 画布顺序取 `canvases` 数组顺序,并以活动画布**优先** —— 用户看到的主画布就是
 * 进项目默认打开那张,封面应当优先反映它。
 */
export function collectCoverCandidates(
  canvases: CanvasSnapshot[],
  activeCanvasId: string | undefined,
  exists: (p: string) => boolean = existsSync,
): CoverCandidate[] {
  const ordered = [...canvases].sort((a, b) => {
    const av = a.id === activeCanvasId ? 0 : 1;
    const bv = b.id === activeCanvasId ? 0 : 1;
    return av - bv;
  });
  const out: CoverCandidate[] = [];
  const seen = new Set<string>();
  for (const c of ordered) {
    for (const n of c.nodes ?? []) {
      for (const p of collectNodePaths(n.data)) {
        if (seen.has(p)) continue;
        seen.add(p);
        if (!exists(p)) continue; // 纸面路径不算候选(见模块头「路径语义」)
        out.push({
          nodeId: n.id,
          nodeKind: n.kind,
          label: n.label ?? n.id,
          path: p,
          isVideo: isVideoFile(p),
        });
      }
    }
  }
  return out;
}

/**
 * 选封面:图片优先,没有图片则用第一个产物(视频,交由渲染层抽帧)。
 * 纯函数 —— 传进来的候选已按想要的顺序排好。
 */
export function pickCover(candidates: CoverCandidate[]): CoverCandidate | null {
  if (!candidates.length) return null;
  return candidates.find((c) => !c.isVideo) ?? candidates[0]!;
}

/** 允许作为封面读取的根目录(与 ffmpeg/导出白名单同口径;防封面读到任意路径) */
export function coverReadRoots(): string[] {
  return [...new Set([...importAllowRoots(), ASSETS_DIR, OUTPUTS_DIR])];
}

/** 自动封面:从画布候选里挑一个(可注入 exists 便于单测) */
export function resolveAutoCover(
  projectId: string,
  canvases: CanvasSnapshot[],
  activeCanvasId: string | undefined,
  exists: (p: string) => boolean = existsSync,
): ProjectCover {
  const picked = pickCover(collectCoverCandidates(canvases, activeCanvasId, exists));
  if (!picked) return { projectId, mode: 'auto', path: null, isVideo: false, sourceNodeId: null };
  return {
    projectId,
    mode: 'auto',
    path: picked.path,
    isVideo: picked.isVideo,
    sourceNodeId: picked.nodeId,
  };
}

/**
 * 解析一个项目的封面(手动优先)。
 *
 * 手动封面**不可用时降级到自动**而不是直接给空:用户上传的图被删了(或目录被清),
 * 与其显示占位图,不如退回项目自己的产物 —— 但那要把降级原因放进 `error`,
 * 否则用户会以为「我设的封面怎么变成别的了」。
 */
export function resolveProjectCover(
  project: Project,
  canvases: CanvasSnapshot[],
  activeCanvasId: string | undefined,
  getAssetPath: (assetId: string) => string | undefined,
  exists: (p: string) => boolean = existsSync,
): ProjectCover {
  const auto = () => resolveAutoCover(project.id, canvases, activeCanvasId, exists);

  if (project.coverMode !== 'manual' || !project.coverAssetId) return auto();

  const p = getAssetPath(project.coverAssetId);
  if (!p) {
    const fallback = auto();
    return { ...fallback, error: '手动封面已失效(资源不存在),已回退到自动封面' };
  }
  if (!exists(p)) {
    const fallback = auto();
    return { ...fallback, error: '手动封面文件已不在磁盘上,已回退到自动封面' };
  }
  return {
    projectId: project.id,
    mode: 'manual',
    path: p,
    isVideo: isVideoFile(p),
    sourceNodeId: null,
    error: null,
  };
}

/* ────────────────────────── 主进程门面 ────────────────────────── */

export interface CoverDeps {
  store: ProjectStore;
  assets: AssetStore;
}

/** 一次拿到全部项目封面(首页/项目页批量渲染;逐个项目 resolve) */
export function listProjectCovers(deps: CoverDeps): ProjectCover[] {
  return deps.store.listProjects().map((p) => coverOf(p, deps));
}

/** 单项目封面解析 */
export function coverOf(project: Project, deps: CoverDeps): ProjectCover {
  const pc = deps.store.loadProjectCanvases(project.id);
  return resolveProjectCover(
    project,
    pc.canvases ?? [],
    pc.activeCanvasId,
    (id) => deps.assets.get(id)?.localPath,
  );
}

/**
 * 设为手动封面(图片已由 `uploadCover` 登记进资产库,这里只落 project 字段)。
 *
 * 校验:资产必须存在、必须是图片、文件必须真实存在 —— 三条缺一条就明确报错,
 * 不允许写入一个「看起来设上了、渲染出来是空的」的 coverAssetId。
 */
export function setCoverAsset(
  deps: CoverDeps,
  projectId: string,
  assetId: string,
): { ok: boolean; error?: string; cover?: ProjectCover } {
  const project = deps.store.getProject(projectId);
  if (!project) return { ok: false, error: '项目不存在' };
  const asset = deps.assets.get(assetId);
  if (!asset) return { ok: false, error: '封面资源不存在' };
  if (asset.kind !== 'image') return { ok: false, error: `只有图片能作封面(该资源是 ${asset.kind})` };
  if (!existsSync(asset.localPath)) return { ok: false, error: '封面文件不在磁盘上' };
  const r = deps.store.setProjectCover(projectId, { coverMode: 'manual', coverAssetId: assetId });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, cover: coverOf(deps.store.getProject(projectId)!, deps) };
}

/** 清除手动封面 → 回到自动(不是「设为空封面」) */
export function clearCover(deps: CoverDeps, projectId: string): { ok: boolean; error?: string; cover?: ProjectCover } {
  const project = deps.store.getProject(projectId);
  if (!project) return { ok: false, error: '项目不存在' };
  const r = deps.store.setProjectCover(projectId, { coverMode: 'auto', coverAssetId: null });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, cover: coverOf(deps.store.getProject(projectId)!, deps) };
}

/**
 * 只读探测:该路径能否作为封面读取(上传时先验一遍,免得先拷贝再报错)。
 * 与 `coverReadRoots` 同口径。
 */
export function isCoverReadablePath(p: string): boolean {
  return coverReadRoots().some((root) => isUnderRoot(p, root));
}

/** 该文件是不是我们这个封面功能认的图片(扩展名 + 是常规文件 + 不为空) */
export function isUsableCoverFile(p: string): { ok: boolean; error?: string } {
  try {
    const st = statSync(p);
    if (!st.isFile()) return { ok: false, error: '不是常规文件' };
    if (st.size === 0) return { ok: false, error: '文件是空的' };
  } catch {
    return { ok: false, error: '文件不存在或不可读' };
  }
  if (!isImageFile(p)) return { ok: false, error: `不支持的封面格式(${extname(p) || '无扩展名'}),请用 png/jpg/webp` };
  return { ok: true };
}
