/**
 * AssetStore — 资产中心(v2:分类 / 标签 / 项目视图 / 产物归档 / 回收站)
 * - 导入:Electron 对话框选文件 → 复制到 ~/.bigbotart/assets/ + 自动元数据(ffprobe 宽高/时长)
 * - 持久化:assets.json(V2:{version, assets, categories});画布资产节点以 assetId 引用资产中心
 * - 项目视图:Asset.projectId 归属(缺省 = 总资源库全局共享);「项目资源页」= 按 projectId 过滤
 * - 删除 = 软删:文件移入 ~/.bigbotart/trash/,记录 deletedAt;7 天后懒清理;restore 移回
 * - 产物归档:复制产物文件进 assets/ 并登记(source='product',originNodeId 反查画布)
 * - 附件登记:对话附件副本已拷入 projects/<pid>/assets/(见 copyAttachmentsToProject),仅登记不复制
 * - headless 导入(Agent/IPC paths):仅允许 DATA_DIR / outputs 白名单内路径,防任意读
 */
import {
  mkdirSync, copyFileSync, unlinkSync, existsSync, readFileSync, writeFileSync, statSync, renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, extname, resolve } from 'node:path';
import { dialog, BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Asset, AssetCategory, AssetRef, AssetImportResult } from '@bigbotart/shared';
import type { ProjectStore as MainProjectStore } from './store';

/** ffprobe 探测用:异步 execFile(不阻塞主进程),8s 超时 */
const execFileP = promisify(execFile);

const DATA_DIR = process.env.BIGBOTART_HOME ?? join(homedir(), '.bigbotart');
export const ASSETS_DIR = join(DATA_DIR, 'assets');
const ASSETS_FILE = join(DATA_DIR, 'assets.json');
const TRASH_DIR = join(DATA_DIR, 'trash');
/** 软删除保留天数(设计稿:7 天后清理) */
const TRASH_TTL_DAYS = 7;
/** 项目文件夹根:projects/<projectId>/——发给 Agent 的附件先拷入此处,项目自包含、可迁移 */
export const PROJECTS_DIR = join(DATA_DIR, 'projects');
/** 单文件大小上限(2GB)——超出拒绝,避免无意复制巨型文件撑爆磁盘 */
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

/**
 * 解析产物根目录:优先环境变量 → 已有仓库内 .bigbotart/outputs → ~/.bigbotart/outputs
 * (兼容此前写在项目目录下的 Take 视频)
 */
function resolveOutputsDir(): string {
  if (process.env.BIGBOTART_H3_OUTPUTS) return resolve(process.env.BIGBOTART_H3_OUTPUTS);
  const candidates = [
    join(process.cwd(), '.bigbotart', 'outputs'),
    join(process.cwd(), '..', '..', '.bigbotart', 'outputs'),
    join(DATA_DIR, 'outputs'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return resolve(c);
  }
  const fallback = join(DATA_DIR, 'outputs');
  mkdirSync(fallback, { recursive: true });
  return resolve(fallback);
}

/** 渲染产物根(与主进程 H3_OUTPUTS_DIR / mock / mlxgen 对齐) */
export const OUTPUTS_DIR = resolveOutputsDir();

/** bba-output 查找根:当前 OUTPUTS_DIR + 导出目录 + 其它已知产物目录(旧路径兼容) */
export function outputSearchRoots(): string[] {
  const roots = new Set<string>([
    resolve(OUTPUTS_DIR),
    resolve(join(DATA_DIR, 'exports')),
    resolve(join(process.cwd(), '.bigbotart', 'exports')),
  ]);
  for (const c of [
    join(DATA_DIR, 'outputs'),
    join(process.cwd(), '.bigbotart', 'outputs'),
    join(process.cwd(), '..', '..', '.bigbotart', 'outputs'),
  ]) {
    if (existsSync(c)) roots.add(resolve(c));
  }
  return [...roots];
}

const KIND_BY_EXT: Record<string, Asset['kind']> = {
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image', heic: 'image', tiff: 'image',
  mp4: 'video', mov: 'video', m4v: 'video', webm: 'video', mkv: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', ogg: 'audio',
  md: 'document', txt: 'document', json: 'document', html: 'document', pdf: 'document', srt: 'document', vtt: 'document',
};

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  md: 'text/markdown', txt: 'text/plain', json: 'application/json', pdf: 'application/pdf', srt: 'text/srt', vtt: 'text/vtt',
};

/** 路径是否落在允许根目录之下(resolve 后前缀校验) */
export function isUnderRoot(filePath: string, root: string): boolean {
  const real = resolve(filePath);
  const base = resolve(root);
  return real === base || real.startsWith(base + '/');
}

/** headless 导入允许的根目录 */
export function importAllowRoots(): string[] {
  const mockOut = process.env.BIGBOTART_MOCK_OUTPUTS ?? join(OUTPUTS_DIR, 'mock');
  const imgOut = process.env.BIGBOTART_MLXGEN_OUTPUTS ?? join(OUTPUTS_DIR, 'images');
  // DATA_DIR 已覆盖 projects/<pid>/ 项目文件夹
  return [DATA_DIR, OUTPUTS_DIR, mockOut, imgOut];
}

/**
 * ffmpeg 读源(取帧/裁切)允许的根:渲染产物/导出(outputSearchRoots)
 * ∪ 数据目录/资产库/项目文件夹(importAllowRoots)∪ 资产库显式根。
 * 素材与产物在资产库、各 outputs 下都可作为裁剪 / 取帧源(过去只认 outputs,
 * 资产库素材会误报「不在允许目录」)。
 */
export function ffmpegReadRoots(): string[] {
  return [...new Set([...outputSearchRoots(), ...importAllowRoots(), ASSETS_DIR])];
}

/** 项目资产目录(不存在则创建) */
export function projectAssetsDir(projectId: string): string {
  // projectId 由应用生成(proj-<ts>-<rand>),仍过滤路径分隔符防注入
  const safe = projectId.replace(/[/\\]/g, '_');
  const dir = join(PROJECTS_DIR, safe, 'assets');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 把对话附件拷入项目文件夹并返回项目内副本路径。
 * 幂等:目标已存在(同资产 id)直接复用,不重复拷贝;源文件缺失时回退原路径并在结果标注。
 * 注意:只负责拷贝;「登记进资产库」由调用方调 AssetStore.registerAttachment(幂等)。
 */
export function copyAttachmentsToProject<T extends { id: string; localPath: string }>(
  projectId: string,
  atts: T[],
): Array<T & { projectPath: string; copied: boolean }> {
  if (!atts.length) return [];
  const dir = projectAssetsDir(projectId);
  return atts.map((a) => {
    const dest = join(dir, `${a.id}${extname(a.localPath).toLowerCase()}`);
    try {
      if (!existsSync(dest)) copyFileSync(a.localPath, dest);
      return { ...a, projectPath: dest, copied: true };
    } catch {
      // 源文件已不在(资产被外部删掉等):回退原路径,由调用方决定是否仍引用
      return { ...a, projectPath: a.localPath, copied: false };
    }
  });
}

/** 提取媒体元数据(ffprobe 异步执行,不阻塞主进程;图片/视频取宽高与时长,音频取时长,失败不阻断) */
export async function probeMedia(
  path: string,
  kind: Asset['kind'],
): Promise<Pick<Asset, 'width' | 'height' | 'durationSec'>> {
  const out: Pick<Asset, 'width' | 'height' | 'durationSec'> = {};
  if (kind === 'document') return out;
  try {
    const r = await execFileP('ffprobe', [
      '-v', 'error', '-print_format', 'json',
      '-show_streams', '-show_format', path,
    ], { timeout: 8000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 });
    const j = JSON.parse(r.stdout);
    const v = (j.streams ?? []).find((s: { codec_type?: string }) => s.codec_type === 'video');
    if (v?.width) { out.width = v.width; out.height = v.height; }
    const dur = j.format?.duration ?? v?.duration;
    if (dur && Number.isFinite(Number(dur))) out.durationSec = Math.round(Number(dur) * 10) / 10;
  } catch {
    /* ffprobe 不可用/超时/解析失败:元数据留空(不阻塞主进程) */
  }
  return out;
}

/** assets.json 的磁盘结构(V2) */
interface AssetStoreFile {
  version: number;
  assets: Asset[];
  categories: AssetCategory[];
}

/**
 * 遍历项目画布查找资产引用(删除安全警告 / 「定位画布」)。
 * 引用字段:asset 节点 / audio-ref 节点 data.assetId;image-edit / image-upscale data.inputAssetId;
 * shot data.refs[].assetId;workflow-input slots[].value.assetId。
 */
export function collectAssetRefs(store: MainProjectStore, assetId: string): AssetRef[] {
  const refs: AssetRef[] = [];
  for (const p of store.listProjects()) {
    let pc;
    try {
      pc = store.loadProjectCanvases(p.id);
    } catch {
      continue; // 画布文件损坏/缺失不阻断
    }
    for (const c of pc.canvases) {
      for (const n of c.nodes ?? []) {
        const d = (n.data ?? {}) as Record<string, unknown>;
        const where = `${c.name}`;
        const push = (kind: string, detail: string) => refs.push({
          assetId,
          projectId: p.id,
          canvasId: c.id,
          canvasName: c.name,
          nodeId: n.id,
          kind,
          where: `${where} · ${detail}`,
        });
        if (n.kind === 'asset' && d.assetId === assetId) push('asset', `资产节点 · ${n.label}`);
        else if (n.kind === 'audio-ref' && d.assetId === assetId) push('audio-ref', `音频参考 · ${n.label}`);
        else if ((n.kind === 'image-edit' || n.kind === 'image-upscale') && d.inputAssetId === assetId) {
          push(n.kind, `${n.kind === 'image-edit' ? '图片编辑' : '超分'} · ${n.label}`);
        } else if (n.kind === 'shot' && Array.isArray(d.refs) && (d.refs as Array<{ assetId?: string }>).some((r) => r.assetId === assetId)) {
          push('shot', `镜头 · ${n.label} · 参考`);
        } else if (n.kind === 'workflow-input' && Array.isArray(d.slots)) {
          const hit = (d.slots as Array<{ name?: string; value?: { kind?: string; assetId?: string } }>).find(
            (s) => s.value?.kind === 'asset' && s.value.assetId === assetId,
          );
          if (hit) push('workflow-input', `工作流入口 · 槽位「${hit.name ?? '?'}」`);
        }
      }
    }
  }
  return refs;
}

/** 列项目画布中「有产物」的节点(「从画布产物导入」弹层候选项) */
export function listArchivableProducts(
  store: MainProjectStore,
  projectId: string,
): Array<{ nodeId: string; name: string; path: string; meta: string }> {
  const out: Array<{ nodeId: string; name: string; path: string; meta: string }> = [];
  let pc;
  try {
    pc = store.loadProjectCanvases(projectId);
  } catch {
    return out;
  }
  const saw = new Set<string>();
  for (const c of pc.canvases) {
    for (const n of c.nodes ?? []) {
      const d = (n.data ?? {}) as Record<string, unknown>;
      const path = String(d.resultPath ?? '');
      if (!path || saw.has(path)) continue;
      saw.add(path);
      const kindLabel: Record<string, string> = {
        shot: '视频镜头', 'image-gen': '图片生成', 'image-edit': '图片编辑', 'image-upscale': '超分', timeline: '时间线导出',
      };
      out.push({
        nodeId: n.id,
        name: n.label || basename(path),
        path,
        meta: `${kindLabel[n.kind ?? ''] ?? n.kind ?? '节点'} · ${c.name}`,
      });
    }
  }
  return out;
}

export class AssetStore {
  private assets: Asset[] = [];
  private categories: AssetCategory[] = [];

  constructor() {
    mkdirSync(ASSETS_DIR, { recursive: true });
    mkdirSync(TRASH_DIR, { recursive: true });
    const data = this.read();
    this.assets = data.assets;
    this.categories = data.categories;
    // V1 数组 → 立即落 V2(新主进程加载的明确证据:assets.json 变为 {version:2,...};后续写入统一走 V2)
    if (data.migratedV1) this.save();
    // 懒清理:过期回收站(expiredAt)资产,文件一并删除
    const cutoff = Date.now() - TRASH_TTL_DAYS * 24 * 3600 * 1000;
    const before = this.assets.length;
    this.assets = this.assets.filter((a) => {
      if (a.deletedAt && new Date(a.deletedAt).getTime() < cutoff) {
        if (a.localPath && existsSync(a.localPath)) {
          try { unlinkSync(a.localPath); } catch { /* 忽略 */ }
        }
        return false;
      }
      return true;
    });
    // 重复 id 资产(历史 bug 产物:同 id 两条记录):后者软删进回收站,文件保留可恢复
    const seen = new Set<string>();
    let dupFixed = false;
    for (const a of this.assets) {
      if (a.deletedAt) continue;
      if (seen.has(a.id)) {
        a.deletedAt = new Date().toISOString();
        dupFixed = true;
      } else {
        seen.add(a.id);
      }
    }
    if (this.assets.length !== before || dupFixed) this.save();
  }

  /** 读取并兼容旧版数组结构(数组 → {version:2, assets, categories}) */
  private read(): AssetStoreFile & { migratedV1?: boolean } {
    if (!existsSync(ASSETS_FILE)) return { version: 2, assets: [], categories: [] };
    try {
      const raw = JSON.parse(readFileSync(ASSETS_FILE, 'utf-8'));
      if (Array.isArray(raw)) return { version: 2, assets: raw as Asset[], categories: [], migratedV1: true };
      const obj = raw as Partial<AssetStoreFile>;
      return {
        version: 2,
        assets: Array.isArray(obj.assets) ? (obj.assets as Asset[]) : [],
        categories: Array.isArray(obj.categories) ? (obj.categories as AssetCategory[]) : [],
      };
    } catch {
      return { version: 2, assets: [], categories: [] };
    }
  }

  private save() {
    const file: AssetStoreFile = { version: 2, assets: this.assets, categories: this.categories };
    writeFileSync(ASSETS_FILE, JSON.stringify(file, null, 2));
  }

  /** 列资产:projectId 给定 = 项目视图(该项目的资源);缺省 = 总资源库(全部,不含回收站) */
  list(projectId?: string): Asset[] {
    const live = this.assets.filter((a) => !a.deletedAt);
    const src = projectId ? live.filter((a) => a.projectId === projectId) : live;
    return [...src].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  get(id: string): Asset | undefined {
    return this.assets.find((a) => a.id === id);
  }

  /** 从 base64 PNG dataURL 导入资产(检查器画遮罩生成 mask 用);写入资产库并登记,返回新资产 */
  importFromDataUrl(input: { name: string; dataUrl: string; projectId?: string; tags?: string[] }): { ok: boolean; asset?: Asset; error?: string } {
    const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(input.dataUrl ?? '');
    if (!m) return { ok: false, error: '仅支持 PNG/JPEG/WebP base64 dataURL' };
    const ext = m[1] === 'png' ? '.png' : m[1] === 'jpeg' ? '.jpg' : '.webp';
    const id = `asset-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const dest = join(ASSETS_DIR, `${id}${ext}`);
    try {
      writeFileSync(dest, Buffer.from(m[2]!, 'base64'));
      const asset: Asset = {
        id,
        kind: 'image',
        name: input.name,
        localPath: dest,
        mime: `image/${m[1] === 'jpeg' ? 'jpeg' : m[1]}`,
        projectId: input.projectId,
        source: 'import',
        tags: input.tags ?? ['遮罩'],
        createdAt: new Date().toISOString(),
      };
      this.assets.push(asset);
      this.save();
      return { ok: true, asset };
    } catch (e) {
      return { ok: false, error: `写入失败:${(e as Error).message}` };
    }
  }

  /* ── 更新:重命名 / 改分类 / 改归属 / 改标签 ── */
  update(
    id: string,
    patch: { name?: string; categoryId?: string | null; projectId?: string | null; tags?: string[] },
  ): { ok: boolean; error?: string } {
    const a = this.assets.find((x) => x.id === id);
    if (!a) return { ok: false, error: '资产不存在' };
    if (patch.name !== undefined) a.name = patch.name;
    if (patch.categoryId !== undefined) a.categoryId = patch.categoryId ?? undefined;
    if (patch.projectId !== undefined) a.projectId = patch.projectId ?? undefined;
    if (patch.tags !== undefined) a.tags = patch.tags;
    this.save();
    return { ok: true };
  }

  /* ── 分类字典 ── */
  listCategories(): AssetCategory[] {
    return [...this.categories].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  createCategory(name: string, projectId?: string): AssetCategory {
    const c: AssetCategory = {
      id: `cat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim(),
      projectId,
      createdAt: new Date().toISOString(),
    };
    this.categories.push(c);
    this.save();
    return c;
  }

  renameCategory(id: string, name: string): { ok: boolean; error?: string } {
    const c = this.categories.find((x) => x.id === id);
    if (!c) return { ok: false, error: '分类不存在' };
    c.name = name.trim();
    this.save();
    return { ok: true };
  }

  /** 删除分类:分类下资源转「未分类」(categoryId 置空),文件保留 */
  deleteCategory(id: string): { ok: boolean; error?: string } {
    if (!this.categories.some((x) => x.id === id)) return { ok: false, error: '分类不存在' };
    this.categories = this.categories.filter((x) => x.id !== id);
    for (const a of this.assets) {
      if (a.categoryId === id) a.categoryId = undefined;
    }
    this.save();
    return { ok: true };
  }

  /* ── 软删除 / 回收站 ── */
  /** 软删:文件移入 trash/,记录 deletedAt;被画布引用时调用方应给出 refs 警告(软删仍允许,7 天内可恢复) */
  delete(id: string): { ok: boolean; error?: string } {
    const a = this.assets.find((x) => x.id === id);
    if (!a) return { ok: false, error: '资产不存在' };
    if (a.deletedAt) return { ok: false, error: '资产已在回收站' };
    try {
      if (a.localPath && existsSync(a.localPath)) {
        const dest = join(TRASH_DIR, `${a.id}${extname(a.localPath).toLowerCase()}`);
        renameSync(a.localPath, dest);
        a.localPath = dest;
      }
    } catch (e) {
      console.warn('资产软删移动失败', (e as Error).message);
    }
    a.deletedAt = new Date().toISOString();
    this.save();
    return { ok: true };
  }

  listTrash(): Asset[] {
    return this.assets
      .filter((a) => a.deletedAt)
      .sort((a, b) => (a.deletedAt! < b.deletedAt! ? 1 : -1));
  }

  restore(id: string): { ok: boolean; error?: string } {
    const a = this.assets.find((x) => x.id === id && x.deletedAt);
    if (!a) return { ok: false, error: '回收站中不存在该资产' };
    try {
      if (a.localPath && existsSync(a.localPath)) {
        const dest = join(ASSETS_DIR, `${a.id}${extname(a.localPath).toLowerCase()}`);
        renameSync(a.localPath, dest);
        a.localPath = dest;
      }
    } catch (e) {
      console.warn('资产恢复移动失败', (e as Error).message);
    }
    delete a.deletedAt;
    this.save();
    return { ok: true };
  }

  /** 清空回收站:物理删除文件并移除记录 */
  emptyTrash(): { ok: boolean } {
    const trash = this.assets.filter((a) => a.deletedAt);
    for (const a of trash) {
      if (a.localPath && existsSync(a.localPath)) {
        try { unlinkSync(a.localPath); } catch { /* 忽略 */ }
      }
    }
    if (trash.length) {
      this.assets = this.assets.filter((a) => !a.deletedAt);
      this.save();
    }
    return { ok: true };
  }

  /* ── 画布产物归档:复制产物进资产库 + 登记(source='product') ── */
  async archiveProducts(
    projectId: string,
    items: Array<{ nodeId: string; path: string }>,
    categoryId?: string,
  ): Promise<{ ok: boolean; assets: Asset[]; error?: string }> {
    const created: Asset[] = [];
    for (const it of items) {
      if (!it.path || !existsSync(it.path)) continue;
      const ext = extname(it.path).slice(1).toLowerCase();
      const kind = KIND_BY_EXT[ext];
      if (!kind) continue;
      const st = statSync(it.path);
      if (!st.isFile()) continue;
      const id = `asset-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const dest = join(ASSETS_DIR, `${id}${extname(it.path).toLowerCase()}`);
      try {
        copyFileSync(it.path, dest);
      } catch {
        continue; // 产物文件不可读/正在写入:跳过该项
      }
      const meta = await probeMedia(dest, kind);
      const asset: Asset = {
        id,
        kind,
        name: basename(it.path, extname(it.path)),
        localPath: dest,
        mime: MIME_BY_EXT[ext],
        ...meta,
        projectId,
        categoryId,
        source: 'product',
        originNodeId: it.nodeId,
        tags: ['产物'],
        createdAt: new Date().toISOString(),
      };
      this.assets.push(asset);
      created.push(asset);
    }
    if (created.length) this.save();
    return { ok: created.length > 0, assets: created };
  }

  /* ── 对话附件登记:副本已在项目目录,只登记不复制(幂等:按 localPath 复用) ── */
  async registerAttachment(projectId: string, file: { id: string; path: string }): Promise<Asset | null> {
    const dup = this.assets.find((a) => a.localPath === file.path);
    if (dup) return dup;
    const ext = extname(file.path).slice(1).toLowerCase();
    const kind = KIND_BY_EXT[ext];
    if (!kind || !existsSync(file.path)) return null;
    // 附件 id 若来自资产中心(asset-xxx)会与资产库撞 id → 一律换新 id,避免同 id 双记录
    let id = `asset-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    while (this.assets.some((a) => a.id === id)) {
      id = `asset-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    }
    const meta = await probeMedia(file.path, kind);
    const asset: Asset = {
      id,
      kind,
      name: basename(file.path, extname(file.path)),
      localPath: file.path,
      mime: MIME_BY_EXT[ext],
      ...meta,
      projectId,
      source: 'attachment',
      tags: ['附件'],
      createdAt: new Date().toISOString(),
    };
    this.assets.push(asset);
    this.save();
    return asset;
  }

  /* ── 导入 ── */
  /** 弹出系统文件对话框导入,返回新增资产;projectId 给定时直接归属到项目(原子完成) */
  async importFromDialog(projectId?: string): Promise<AssetImportResult> {
    const win = BrowserWindow.getAllWindows()[0] ?? undefined;
    const res = await dialog.showOpenDialog(win as never, {
      title: '导入资产到 BigBotArt',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '媒体与文档', extensions: Object.keys(KIND_BY_EXT) },
        { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] },
        { name: '视频', extensions: ['mp4', 'mov', 'm4v', 'webm'] },
        { name: '音频', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac'] },
        { name: '文档', extensions: ['md', 'txt', 'json', 'srt', 'vtt', 'pdf'] },
      ],
    });
    if (res.canceled || res.filePaths.length === 0) return { assets: [], failed: [], canceled: true };
    // 用户显式选文件:不受白名单限制
    return await this.importFromPaths(res.filePaths, { unrestricted: true, projectId });
  }

  /**
   * 按给定绝对路径列表导入(Agent headless / 程序化)。
   * 默认 restricted:路径必须落在 DATA_DIR / outputs 白名单内。
   * unrestricted 仅供系统对话框回调使用。
   * projectId 给定时,成功资产直接归属该项目(source 保持默认),避免"导入后再逐条归属"的分裂链路。
   */
  async importFromPaths(paths: string[], opts?: { unrestricted?: boolean; projectId?: string }): Promise<AssetImportResult> {
    const result: AssetImportResult = { assets: [], failed: [] };
    const unrestricted = opts?.unrestricted === true;
    const roots = importAllowRoots();
    for (const src of paths) {
      try {
        if (!src || typeof src !== 'string') {
          result.failed.push({ name: String(src), error: '路径无效' });
          continue;
        }
        if (!unrestricted && !roots.some((r) => isUnderRoot(src, r))) {
          result.failed.push({
            name: basename(src),
            error: '路径不在允许目录(请用 openDialog=true 由用户选择,或仅导入应用数据/产物目录内文件)',
          });
          continue;
        }
        if (!existsSync(src)) {
          result.failed.push({ name: basename(src), error: '文件不存在' });
          continue;
        }
        const st = statSync(src);
        if (!st.isFile()) {
          result.failed.push({ name: basename(src), error: '不是常规文件' });
          continue;
        }
        if (st.size > MAX_FILE_SIZE) {
          result.failed.push({
            name: basename(src),
            error: `文件过大 ${(st.size / 1e9).toFixed(2)}GB(上限 2GB)`,
          });
          continue;
        }
        const a = await this.ingest(src, opts?.projectId ? { projectId: opts.projectId } : undefined);
        if (a) result.assets.push(a);
        else result.failed.push({ name: basename(src), error: `不支持的扩展名(.${extname(src).slice(1).toLowerCase() || '?'})` });
      } catch (e) {
        result.failed.push({ name: basename(src ?? ''), error: (e as Error).message });
      }
    }
    return result;
  }

  /** 把单个文件纳入资产库(复制 + 元数据);opts.projectId 给定时直接归属项目 */
  async ingest(src: string, opts?: { projectId?: string }): Promise<Asset | null> {
    const ext = extname(src).slice(1).toLowerCase();
    const kind = KIND_BY_EXT[ext];
    if (!kind) return null;
    const id = `asset-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const dest = join(ASSETS_DIR, `${id}${extname(src).toLowerCase()}`);
    copyFileSync(src, dest);
    const meta = await probeMedia(dest, kind);
    const asset: Asset = {
      id,
      kind,
      name: basename(src, extname(src)),
      localPath: dest,
      mime: MIME_BY_EXT[ext],
      ...meta,
      ...(opts?.projectId ? { projectId: opts.projectId } : {}),
      tags: [kind],
      createdAt: new Date().toISOString(),
    };
    this.assets.push(asset);
    this.save();
    return asset;
  }
}