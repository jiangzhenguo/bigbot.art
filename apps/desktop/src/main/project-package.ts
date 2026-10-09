/**
 * 项目包导入/导出(.bba)—— 项目级「整个项目搬走」的唯一通道
 *
 * 取代 PRD §8.3 的「H3Mise 项目导入」:那条路径是「把别人的项目台数据搬进来」,
 * 而本应用真正缺的是**自己的项目出得去** —— 换机、备份、发给协作者都没有通道。
 * 现在导出 = 项目 → 单文件 .bba;导入 = .bba → **新建一个项目**。
 *
 * ## 文件形态
 * `gzip(JSON)`,用 Node 内置 `zlib`,**不引入 zip 依赖**:
 * 媒体按 base64 内联在 JSON 里。代价是媒体体积 +33%(base64 开销),换来
 * 零新增运行时依赖、无 zip 解压路径穿越风险、包本身是一份可直接看的 JSON。
 *
 * ## 包里有什么 / 没有什么
 * 有:项目元数据、全部画布(节点/连线/分组/视口)、Take 历史、Agent 记忆、
 *     项目资源元数据、**用户导入的附件实体文件**(assets/ 与 projects/<pid>/assets/)。
 * 没有:**生成产物**(outputs/ 下的 mp4/png)。几十个镜头的项目动辄数 GB,
 *     且产物能用节点参数重跑。
 *
 * ## 产物路径怎么处理(关键取舍)
 * 导入时 `resultPath` / Take.resultPath / Take.cmdline 一律**保留原绝对路径,不重写**。
 * 理由:①同机重装/复制项目时原路径仍然有效,重写反而把能用的引用改坏;
 *       ②换机时路径必然命中不到,渲染层已有「产物缺失」降级展示(stale 标记),
 *         用户重跑即可 —— 这比伪造一个空文件诚实得多(本项目反复出现的「假成功」形态)。
 * 缺失的产物在导入结果里以 `warnings` 明示。
 *
 * ## 附件路径怎么处理
 * 附件（`source !== 'product'` 的项目资源）的实体文件**进包**,导入时落到新项目的
 * `projects/<newId>/assets/`,并把 asset.localPath 重写为新路径 —— 附件是用户
 * **无法重跑**的输入(参考图/剧本/素材),丢了就是真丢了。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import type {
  Asset,
  AssetCategory,
  Project,
  ProjectCanvases,
  ProjectImportResult,
  ProjectExportRequest,
  ProjectExportResult,
  ProjectPackage,
  ProjectPackageMedia,
  ProjectPackageStats,
  Take,
} from '@bigbotart/shared';
import { PROJECT_PACKAGE_VERSION } from '@bigbotart/shared';
import { ASSETS_DIR, projectAssetsDir } from './assets.js';
import type { AssetStore } from './assets.js';
import type { ProjectStore } from './store.js';
import type { TakeStore } from './takes.js';
import type { MemoryStore } from './memory.js';

/** 单个媒体条目的体积上限(防一个包把内存打爆;2GB 与本项目资产上限同口径) */
const MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024;

/** 包内媒体的目录名(导出/导入两侧共用,别各写一份) */
const MEDIA_DIR_NAME = 'assets';

/* ────────────────────────── 纯函数(可单测,不碰文件系统) ────────────────────────── */

/** 把任意项目名清洗成安全的文件名(不含扩展名) */
export function safeFileStem(name: string): string {
  const cleaned = (name || '').trim().replace(/[^\w.\u4e00-\u9fff-]+/g, '_').replace(/^\.+/, '');
  return (cleaned || 'project').slice(0, 60);
}

/** 是否是需要进包的实体(用户导入的附件/素材);产物(product)不入包 */
export function isPackableAsset(asset: Asset): boolean {
  if (asset.deletedAt) return false;
  if (!asset.localPath) return false;
  return asset.source !== 'product';
}

/** 判断包对象是否合法(格式标识 + 版本);返回错误文案或 null */
export function validatePackageShape(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return '文件内容不是有效的项目包(不是 JSON 对象)';
  const p = raw as Partial<ProjectPackage>;
  if (p.format !== 'bigbotart-project') return '文件不是 BigBotArt 项目包(缺少 format 标识)';
  const v = Number(p.version);
  if (!Number.isFinite(v) || v < 1) return `项目包版本字段非法:${String(p.version)}`;
  if (v > PROJECT_PACKAGE_VERSION) {
    return `项目包版本 ${v} 高于当前应用支持的 ${PROJECT_PACKAGE_VERSION},请升级 BigBotArt 后再导入`;
  }
  if (!p.payload || typeof p.payload !== 'object') return '项目包缺少 payload';
  const pl = p.payload as Partial<ProjectPackage['payload']>;
  if (!pl.project || typeof pl.project !== 'object') return '项目包缺少项目元数据(payload.project)';
  if (!pl.canvases || !Array.isArray(pl.canvases.canvases)) return '项目包缺少画布数据(payload.canvases)';
  return null;
}

/** 媒体条目在包内的相对落盘名(key 已含扩展名,这里只做去重后缀) */
export function mediaFileName(media: ProjectPackageMedia, index: number): string {
  const ext = extname(media.name) || '';
  const stem = basename(media.name, ext).replace(/[/\\]/g, '_').slice(0, 40) || 'file';
  return `${String(index).padStart(3, '0')}-${stem}${ext}`.replace(/\s+/g, '_');
}

/**
 * 重写附件资源的 localPath 到导入后的新位置。
 *
 * 只动**进包了的**附件(srcKey 命中),产物路径与包外路径一律原样保留 ——
 * 见模块头「产物路径怎么处理」。
 */
export function rewriteAssetPaths(
  assets: Asset[],
  keyByAssetId: Map<string, string>,
  newPathByKey: Map<string, string>,
): { assets: Asset[]; copied: number; missing: string[] } {
  const missing: string[] = [];
  let copied = 0;
  const next = assets.map((a) => {
    const key = keyByAssetId.get(a.id);
    if (!key) return a;
    const np = newPathByKey.get(key);
    if (!np) {
      missing.push(a.name || a.id);
      return a;
    }
    copied += 1;
    return { ...a, localPath: np };
  });
  return { assets: next, copied, missing };
}

/**
 * 重写画布节点里的产物路径引用 —— 当前**恒等**(保留原绝对路径)。
 * 独立成函数是为了把这条取舍钉在代码里:以后若要做「产物也打进包」,
 * 只需改这里 + 导出端的收集逻辑,不必满仓库找 resultPath。
 */
export function rewriteNodePaths<T>(canvas: T): T {
  return canvas;
}

/** 统计包内容(导出/导入结果展示共用) */
export function computeStats(payload: ProjectPackage['payload']): ProjectPackageStats {
  let nodes = 0;
  let edges = 0;
  for (const c of payload.canvases.canvases ?? []) {
    nodes += c.nodes?.length ?? 0;
    edges += c.edges?.length ?? 0;
  }
  const mediaBytes = payload.media.reduce((s, m) => s + (m.bytes || 0), 0);
  return {
    canvases: payload.canvases.canvases?.length ?? 0,
    nodes,
    edges,
    takes: payload.takes?.length ?? 0,
    assets: payload.assets?.length ?? 0,
    mediaFiles: payload.media.length,
    mediaBytes,
  };
}

/* ────────────────────────── 导出 ────────────────────────── */

export interface ExportDeps {
  store: ProjectStore;
  assets: AssetStore;
  takes: TakeStore;
  memory: MemoryStore;
  /** 应用版本(诊断用,可选) */
  appVersion?: string;
  /** 数据根(诊断用,可选) */
  dataRoot?: string;
}

/**
 * 打包一个项目(纯数据,不写盘)。
 *
 * 媒体收集口径:`AssetStore.list(projectId)` 里 `source !== 'product'` 且文件存在的条目,
 * 加上画布节点 `data.assetId` / `data.resultAssetId` 引用到的同项目资源(双保险 ——
 * 手动绑定的资产未必带 projectId,漏收集会让导入后节点指向空)。
 */
export function buildProjectPackage(projectId: string, deps: ExportDeps): ProjectPackage {
  const project = deps.store.getProject(projectId);
  if (!project) throw new Error('项目不存在');

  const canvases: ProjectCanvases = deps.store.loadProjectCanvases(projectId);
  const takes: Take[] = deps.takes.list(projectId);
  const memory = deps.memory.get(projectId) ?? null;

  // 项目资源(不含已软删的)
  const allAssets = deps.assets.list(projectId);
  // 画布节点引用的资源 id(跨项目引用也要收进来 —— 否则导入后 asset 节点是空的)
  const referencedIds = new Set<string>();
  const collectFromData = (data: unknown) => {
    if (!data || typeof data !== 'object') return;
    const d = data as Record<string, unknown>;
    for (const f of ['assetId', 'resultAssetId', 'inputAssetId']) {
      if (typeof d[f] === 'string') referencedIds.add(d[f] as string);
    }
    // shot.refs[].assetId
    if (Array.isArray(d.refs)) {
      for (const r of d.refs as Array<Record<string, unknown>>) {
        if (typeof r?.assetId === 'string') referencedIds.add(r.assetId);
      }
    }
  };
  for (const c of canvases.canvases ?? []) {
    for (const n of c.nodes ?? []) collectFromData(n.data);
  }
  const byId = new Map<string, Asset>();
  for (const a of allAssets) byId.set(a.id, a);
  for (const id of referencedIds) {
    const a = deps.assets.get(id);
    if (a && !a.deletedAt && !byId.has(a.id)) byId.set(a.id, a);
  }
  const assets = [...byId.values()];

  const categories: AssetCategory[] = deps.assets.listCategories().filter((c) => c.projectId === projectId);

  // 媒体实体:附件/素材进包;产物(product)不进
  const media: ProjectPackageMedia[] = [];
  for (const a of assets.filter(isPackableAsset)) {
    if (!existsSync(a.localPath)) continue;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(a.localPath);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_MEDIA_BYTES) continue;
    const ext = extname(a.localPath).toLowerCase();
    const stem = basename(a.localPath, ext) || a.id;
    media.push({
      key: `${a.id}${ext}`,
      kind: 'asset',
      name: `${stem}${ext}`,
      originalPath: a.localPath,
      bytes: st.size,
      dataBase64: readFileSync(a.localPath).toString('base64'),
    });
  }

  const payload: ProjectPackage['payload'] = {
    project,
    canvases: {
      ...canvases,
      canvases: (canvases.canvases ?? []).map((c) => rewriteNodePaths(c)),
    },
    takes,
    memory,
    assets,
    assetCategories: categories,
    media,
  };

  return {
    format: 'bigbotart-project',
    version: PROJECT_PACKAGE_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: deps.appVersion,
    exportedFrom: deps.dataRoot,
    stats: computeStats(payload),
    payload,
  };
}

/** 序列化 + gzip(单独导出便于单测直接比对往返) */
export function serializePackage(pkg: ProjectPackage): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(pkg), 'utf-8'), { level: 9 });
}

/** 解析 + 结构校验;任何一步失败都抛明确错误(不静默返回空包) */
export function parsePackage(buf: Buffer): ProjectPackage {
  let text: string;
  try {
    text = gunzipSync(buf).toString('utf-8');
  } catch (e) {
    throw new Error(`不是有效的 .bba 项目包(解压失败:${(e as Error).message})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`项目包内容损坏(JSON 解析失败:${(e as Error).message})`);
  }
  const bad = validatePackageShape(raw);
  if (bad) throw new Error(bad);
  return raw as ProjectPackage;
}

/** 写出包到指定路径;返回字节数 */
export function writePackageFile(pkg: ProjectPackage, filePath: string): number {
  const buf = serializePackage(pkg);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, buf);
  return buf.length;
}

/** 默认导出文件名:`<项目名>-<YYYYMMDD>.bba` */
export function defaultPackageName(project: Project, at = new Date()): string {
  const d = `${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, '0')}${String(at.getDate()).padStart(2, '0')}`;
  return `${safeFileStem(project.name)}-${d}.bba`;
}

/**
 * 导出入口(带对话框)。`req.path` 给定时直接写盘(Agent/脚本用),
 * 否则弹保存对话框;用户取消返回 `canceled: true`(**不是失败**)。
 */
export async function exportProject(
  req: ProjectExportRequest,
  deps: ExportDeps & { showSaveDialog: (defaultName: string) => Promise<string | null> },
): Promise<ProjectExportResult> {
  try {
    const project = deps.store.getProject(req.projectId);
    if (!project) return { ok: false, error: '项目不存在' };

    let target = req.path;
    if (!target) {
      const picked = await deps.showSaveDialog(defaultPackageName(project));
      if (!picked) return { ok: false, canceled: true };
      target = picked;
    }
    if (!target.toLowerCase().endsWith('.bba')) target += '.bba';

    const pkg = buildProjectPackage(req.projectId, deps);
    const bytes = writePackageFile(pkg, target);
    return { ok: true, path: target, bytes, stats: pkg.stats };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/* ────────────────────────── 导入 ────────────────────────── */

export interface ImportDeps {
  store: ProjectStore;
  assets: AssetStore;
  takes: TakeStore;
  memory: MemoryStore;
}

/**
 * 把包内容落成一个**新项目**。
 *
 * 三条不变量:
 *  1. **绝不覆盖既有项目** —— 项目 id 一律重新分配,画布 id 也重新分配
 *     (画布 id 在 store 里按项目容器隔离,但 Take/记忆按 projectId 索引,重分配最干净);
 *  2. **先落数据再报成功** —— 画布/资源/Take/记忆全部写盘后才返回 ok;
 *  3. **不静默吞** —— 缺失的产物/附件进 `warnings`,附件落盘失败也进 warnings 而不是假装成功。
 */
export function materializePackage(pkg: ProjectPackage, deps: ImportDeps): ProjectImportResult {
  const warnings: string[] = [];
  const payload = pkg.payload;
  const oldProject = payload.project;

  // 1) 建项目(名字撞了也照建,由用户自己去重命名 —— 比偷偷改名可预期)
  const project = deps.store.createProject(oldProject.name || '导入的项目');
  const newId = project.id;
  if (oldProject.description) project.description = oldProject.description;
  if (oldProject.llmOverride) {
    deps.store.setProjectLlm(newId, oldProject.llmOverride);
  }

  // 2) 媒体落盘:先全部解开,得到「包内 key → 新绝对路径」
  const newPathByKey = new Map<string, string>();
  const mediaDir = join(projectAssetsDir(newId), MEDIA_DIR_NAME);
  mkdirSync(mediaDir, { recursive: true });
  payload.media.forEach((m, i) => {
    try {
      const buf = Buffer.from(m.dataBase64, 'base64');
      if (m.bytes && buf.length !== m.bytes) {
        warnings.push(`附件「${m.name}」大小与包内记录不符(${buf.length} ≠ ${m.bytes}),已按实际内容写入`);
      }
      const dest = join(mediaDir, mediaFileName(m, i));
      writeFileSync(dest, buf);
      newPathByKey.set(m.key, dest);
    } catch (e) {
      warnings.push(`附件「${m.name}」写入失败:${(e as Error).message}`);
    }
  });

  // 3) 资源登记:localPath 重写(附件指向新落盘位置;产物保留原路径)
  const keyByAssetId = new Map<string, string>();
  for (const m of payload.media) {
    if (m.kind !== 'asset') continue;
    // 导出端 key 约定 = `<assetId><ext>`,去掉扩展名即 assetId
    keyByAssetId.set(m.key.slice(0, m.key.length - extname(m.key).length), m.key);
  }
  const { assets: rewritten, copied, missing } = rewriteAssetPaths(payload.assets, keyByAssetId, newPathByKey);
  // 归因两类缺失,别混为一谈:
  //  a) media 里**有**该条但落盘失败(写盘异常) → rewriteAssetPaths 记进 missing;
  //  b) media 里**根本没有**该条 —— 导出端就不会为「源文件已不在」的附件生成 media
  //     (见 buildProjectPackage 的 existsSync 过滤),包本身是好的,只是这条附件没带过来。
  //  (b) 以前完全没人报:keyByAssetId 为空 → 走不到 missing → 用户看到一条指向
  //  原机路径的资产,换机后打开是空的,却没有任何提示。这里补齐。
  const noEntity = rewritten.filter((a) => isPackableAsset(a) && !keyByAssetId.has(a.id)).map((a) => a.name || a.id);
  if (missing.length) warnings.push(`${missing.length} 个附件写入失败,已保留原路径:${missing.slice(0, 3).join('、')}`);
  if (noEntity.length) {
    warnings.push(
      `${noEntity.length} 个附件没有随包带过来(导出时源文件已不在原机),保留的路径在本机可能无效:` +
        `${noEntity.slice(0, 3).join('、')}`,
    );
  }
  const { idMap: assetIdMap } = deps.assets.importParsed(newId, rewritten, payload.assetCategories);
  // ⚠️ 顺序要害:资源必须先登记拿到 idMap,再写画布 —— 否则节点里的 assetId 引用
  // 会在 id 撞车重分配后指向旧 id(画布上「资产未加载」就是这么来的)。
  const remapAssetIds = (v: unknown): unknown => {
    if (typeof v === 'string') return assetIdMap.get(v) ?? v;
    if (Array.isArray(v)) return v.map(remapAssetIds);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = remapAssetIds(val);
      return out;
    }
    return v;
  };

  // 4) 画布:重分配 id 与 projectId;节点 data 里的 assetId 引用按 idMap 改写
  const oldToNew = new Map<string, string>();
  const canvases = (payload.canvases.canvases ?? []).map((c, i) => {
    const nid = `${newId}-cv-${i + 1}`;
    oldToNew.set(c.id, nid);
    return {
      ...c,
      id: nid,
      projectId: newId,
      version: 1,
      nodes: (c.nodes ?? []).map((n) => ({
        ...n,
        data: remapAssetIds(n.data) as typeof n.data,
      })),
    };
  });
  const activeOld = payload.canvases.activeCanvasId;
  const activeNew = oldToNew.get(activeOld) ?? canvases[0]?.id ?? 'main';
  deps.store.replaceCanvases(newId, { projectId: newId, canvases, activeCanvasId: activeNew });

  // 5) Take 历史整体写入(id 原样保留:Take.id 只在本项目内引用,与画布/节点不冲突;
  //    shotNodeId 是**节点 id**,节点 id 原样保留,故不动)
  if (payload.takes?.length) deps.takes.replaceAll(newId, payload.takes);

  // 6) 记忆:projectId 重指,画布级键(canvasMemory)按 old→new 画布 id 重映射
  if (payload.memory) {
    const m = JSON.parse(JSON.stringify(payload.memory)) as typeof payload.memory;
    m.projectId = newId;
    const remapped: typeof m.canvasMemory = {};
    for (const [cid, v] of Object.entries(m.canvasMemory ?? {})) {
      remapped[oldToNew.get(cid) ?? cid] = v;
    }
    m.canvasMemory = remapped;
    for (const r of m.recall ?? []) {
      if (r.canvasId) r.canvasId = oldToNew.get(r.canvasId) ?? r.canvasId;
    }
    deps.memory.replace(newId, m);
  }

  // 7) 产物缺失提醒(不阻断导入,但必须让用户看见)
  const resultPaths = new Set<string>();
  for (const c of canvases) {
    for (const n of c.nodes ?? []) {
      const rp = (n.data as { resultPath?: string })?.resultPath;
      if (typeof rp === 'string' && rp) resultPaths.add(rp);
    }
  }
  for (const t of payload.takes ?? []) if (t.resultPath) resultPaths.add(t.resultPath);
  const absent = [...resultPaths].filter((p) => !existsSync(p));
  if (absent.length) {
    warnings.push(
      `${absent.length} 个生成产物不在本机(换机导入时不带产物是正常的),相关节点会显示为待重跑;` +
        `重跑即可重新出片(产物不计入项目包)`,
    );
  }

  const stats = computeStats(payload);
  return {
    ok: true,
    project: deps.store.getProject(newId)!,
    stats: { ...stats, assets: copied },
    warnings,
  };
}

/** 读文件 + 解析 + 落项目(导入入口的完整链路,单测直接调它) */
export function importProjectFromFile(filePath: string, deps: ImportDeps): ProjectImportResult {
  if (!existsSync(filePath)) return { ok: false, error: `文件不存在:${basename(filePath)}` };
  let buf: Buffer;
  try {
    buf = readFileSync(filePath);
  } catch (e) {
    return { ok: false, error: `读取文件失败:${(e as Error).message}` };
  }
  let pkg: ProjectPackage;
  try {
    pkg = parsePackage(buf);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  try {
    return materializePackage(pkg, deps);
  } catch (e) {
    return { ok: false, error: `导入失败:${(e as Error).message}` };
  }
}
