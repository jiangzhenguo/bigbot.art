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
  createReadStream, readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { join, basename, extname, resolve, dirname } from 'node:path';
import { dialog, BrowserWindow, app } from 'electron';
import type { Asset, AssetCategory, AssetRef, AssetImportResult } from '@bigbotart/shared';
import type { ProjectStore as MainProjectStore } from './store';
import { WORKSPACES_DIR, workspaceAssetsFile } from './workspace-paths.js';
import { probeMediaInfo } from './media-probe.js';

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
 * 打包态(Finder/Dock 启动的安装版)。真实事故 2026-10:安装版 cwd=/,
 * cwd 候选全部落空 → 产物根飘到 ~/.bigbotart/outputs,而历史产物在仓库
 * .bigbotart/outputs,bba-output:// 白名单又只认产物根 → 画布视频全部「消失」。
 * 打包版因此**绝不跟随 cwd**;dev 版保留 cwd 候选以兼容仓库内历史产物。
 */
const IS_PACKAGED = !!app.isPackaged;

/**
 * 解析产物根目录(纯函数,可单测):环境变量优先;
 * 打包版固定 DATA_DIR/outputs;dev 版额外尝试 cwd 候选(兼容仓库内旧产物)。
 */
export function pickOutputsDir(opts: {
  envOverride?: string;
  isPackaged: boolean;
  cwd: string;
  dataDir: string;
  exists: (p: string) => boolean;
}): string {
  const { envOverride, isPackaged, cwd, dataDir, exists } = opts;
  if (envOverride) return resolve(envOverride);
  const candidates = isPackaged
    ? [join(dataDir, 'outputs')]
    : [join(cwd, '.bigbotart', 'outputs'), join(cwd, '..', '..', '.bigbotart', 'outputs'), join(dataDir, 'outputs')];
  for (const c of candidates) {
    if (exists(c)) return resolve(c);
  }
  return resolve(join(dataDir, 'outputs'));
}

function resolveOutputsDir(): string {
  const dir = pickOutputsDir({
    envOverride: process.env.BIGBOTART_H3_OUTPUTS,
    isPackaged: IS_PACKAGED,
    cwd: process.cwd(),
    dataDir: DATA_DIR,
    exists: existsSync,
  });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 渲染产物根(与主进程 H3_OUTPUTS_DIR / mock / mlxgen 对齐) */
export const OUTPUTS_DIR = resolveOutputsDir();

/** bba-output 查找根:当前 OUTPUTS_DIR + 导出目录;dev 版另含 cwd 候选(旧路径兼容) */
export function outputSearchRoots(): string[] {
  const roots = new Set<string>([resolve(OUTPUTS_DIR), resolve(join(DATA_DIR, 'exports'))]);
  const dataOutputs = join(DATA_DIR, 'outputs');
  if (existsSync(dataOutputs)) roots.add(resolve(dataOutputs));
  if (!IS_PACKAGED) {
    roots.add(resolve(join(process.cwd(), '.bigbotart', 'exports')));
    for (const c of [join(process.cwd(), '.bigbotart', 'outputs'), join(process.cwd(), '..', '..', '.bigbotart', 'outputs')]) {
      if (existsSync(c)) roots.add(resolve(c));
    }
  }
  return [...roots];
}

/**
 * bba-output:// 相对文件名校验(纯函数,可单测)。
 *
 * 真实事故(2026-10):旧实现用 `/^[A-Za-z0-9._/-]+$/` 白名单,而导出成片文件名由
 * 项目名派生(sanitizeOutputName 明确保留中文 ‑‑ ),于是「飞机1-xxx.mp4」这类
 * 中文名被协议层 400 拒掉 → 画布 timeline 节点成片预览**整块黑屏**。
 * 现只拒绝真正危险的形态:空串 / `..` 路径穿越 / 绝对路径 / 控制字符 / 反斜杠 / 冒号;
 * 中文等 Unicode 文件名合法。最终落盘仍由调用处的 resolve + 根目录边界检查兜底。
 */
export function isValidOutputRelName(name: string): boolean {
  if (!name) return false;
  if (name.includes('..') || name.startsWith('/')) return false;
  // eslint-disable-next-line no-control-regex -- 故意拒绝控制字符(协议层防呆)
  if (/[\x00-\x1f\\:]/.test(name)) return false;
  return true;
}

function mimeOf(file: string): string {
  return MIME_BY_EXT[extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 把本地文件作为 HTTP 响应返回,**支持 Range 请求**。
 *
 * 为什么不能直接 `net.fetch('file://…')`(2026-09 修复「视频能播但进度条拖不动」):
 * 那条路径返回的响应**不含 `accept-ranges` / `content-length`,且完全忽略 `Range` 头**
 * —— 永远回 200 整个文件。浏览器据此判定资源不可定位,`<video>.seekable` 恒为 `[0,0]`,
 * 原生控件的进度条因此拖不动(能正常顺序播放,但无法任意跳转)。
 *
 * 这里自己解析 `Range: bytes=<start>-<end>`,命中就流式返回 206 + `content-range`
 * (大文件如 126MB 视频绝不整块读进内存),否则回 200 并补上 `accept-ranges: bytes`。
 */
export function rangeFileResponse(file: string, rangeHeader: string | null): Response {
  const type = mimeOf(file);
  if (!existsSync(file)) return new Response(`not found: ${basename(file)}`, { status: 404 });
  const size = statSync(file).size;
  const total = `bytes */${size}`;

  // 解析 Range:仅支持单区间 `bytes=start-end`(浏览器 seek 只用这种形态)
  const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
  if (rangeHeader && !m) {
    return new Response('unsupported range', {
      status: 416,
      headers: { 'content-range': total, 'accept-ranges': 'bytes' },
    });
  }

  let start = 0;
  let end = size - 1;
  if (m) {
    const hasStart = m[1] !== '';
    const hasEnd = m[2] !== '';
    if (hasStart) {
      start = Number(m[1]);
      if (hasEnd) end = Number(m[2]);
    } else if (hasEnd) {
      // 后缀区间 `bytes=-N` = 末尾 N 字节
      start = Math.max(0, size - Number(m[2]));
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return new Response('range not satisfiable', {
        status: 416,
        headers: { 'content-range': total, 'accept-ranges': 'bytes' },
      });
    }
    end = Math.min(end, size - 1);
  }

  const length = end - start + 1;
  // ⚠️ 必须是**真正的 web ReadableStream**(`Readable.toWeb`),不能把 Node 流直接塞进 Response
  // (原写法 `createReadStream(...) as unknown as ReadableStream` 只是骗过 tsc;2026-10-12 真实弹窗事故):
  // undici 的 extractBody 见「不是 ReadableStream、但是 async iterable」就会用 ReadableStreamFrom()
  // 包一层,而那一层的 pull() 在迭代器结束时**无保护地** `queueMicrotask(() => controller.close())`
  // (Node 22.22 / Electron 38.8.6 内置 undici,行号 1596)。一旦消费方在「源读完」的同一拍取消
  // —— Chromium 取消 bba-asset/bba-output 请求:缩略图重渲染、节点删除、`<video>` seek 打断上一个
  // Range 请求、HMR 整页重载 —— close() 就抛 ERR_INVALID_STATE: ReadableStream is already closed;
  // 异常发生在 queueMicrotask 里,调用方 try/catch **拦不住** → 主进程 uncaughtException →
  // Electron 弹「A JavaScript error occurred in the main process」。走 toWeb 则 undici 命中
  // `object instanceof ReadableStream` 分支,根本不生成那层包装器
  // (Node 22.22 实测:旧写法 150 次命中 3 次,toWeb 200 次 0 次)。
  const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
  const headers: Record<string, string> = {
    'content-type': type,
    'content-length': String(length),
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
  };
  if (m) {
    headers['content-range'] = `bytes ${start}-${end}/${size}`;
    return new Response(body, { status: 206, headers });
  }
  return new Response(body, { status: 200, headers });
}

const KIND_BY_EXT: Record<string, Asset['kind']> = {
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image', heic: 'image', tiff: 'image',
  mp4: 'video', mov: 'video', m4v: 'video', webm: 'video', mkv: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', ogg: 'audio',
  md: 'document', txt: 'document', json: 'document', html: 'document', pdf: 'document', srt: 'document', vtt: 'document',
};

/** 扩展名 → MIME(自定义协议要显式给 content-type;视频 seek 依赖正确的类型声明) */
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  avif: 'image/avif', heic: 'image/heic', tiff: 'image/tiff', bmp: 'image/bmp',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg',
  md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', json: 'application/json',
  html: 'text/html; charset=utf-8', pdf: 'application/pdf', srt: 'text/plain; charset=utf-8', vtt: 'text/vtt; charset=utf-8',
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

/**
 * 提取媒体元数据(ffprobe 异步执行,不阻塞主进程;失败不阻断导入)。
 *
 * 委托给 `media-probe.ts` 的统一解析器 —— 检查器里的「媒体信息」面板用的是同一份逻辑,
 * 两处对同一个文件必须给出同一组数字(曾经视频探测有两条独立实现,字段各缺一半)。
 * 这里只挑出入库该长期保存的几个字段写进 assets.json;帧数/编码/容器这些
 * 展示用信息不入库,检查器按需重探即可。
 */
export async function probeMedia(
  path: string,
  kind: Asset['kind'],
): Promise<Pick<Asset, 'width' | 'height' | 'durationSec' | 'fps' | 'sampleRate' | 'channels'>> {
  const out: Pick<Asset, 'width' | 'height' | 'durationSec' | 'fps' | 'sampleRate' | 'channels'> = {};
  if (kind === 'document') return out;
  const info = await probeMediaInfo(path, kind);
  if (!info.ok) return out;
  if (info.width) out.width = info.width;
  if (info.height) out.height = info.height;
  if (info.durationSec !== undefined) out.durationSec = info.durationSec;
  if (info.fps !== undefined) out.fps = info.fps;
  if (info.sampleRate !== undefined) out.sampleRate = info.sampleRate;
  if (info.channels !== undefined) out.channels = info.channels;
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

  /**
   * 🧪 仅供测试:取「index.ts 构造的那一份 AssetStore」单例。
   *
   * 集成测试(project-package-ipc.test.ts)要在**同一份** Store 上铺数据 ——
   * 测试里另 new 一个实例会变成两个写入者共享一个 projects.json/assets.json,
   * 直接复现本项目最难查的那类故障(在测试里表现为莫名其妙的假失败)。
   * 生产代码路径不读这个字段。
   */
  static __lastInstance?: AssetStore;

  constructor() {
    AssetStore.__lastInstance = this;
    mkdirSync(ASSETS_DIR, { recursive: true });
    mkdirSync(TRASH_DIR, { recursive: true });
    const data = this.readAll();
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

  /**
   * 读取全部资源:**全局库文件 + 各工作空间的 assets.json**(2026-09-29 批次2)。
   *
   * 内存里仍是**一份扁平数组**(`this.assets`),调用点(`list`/`get`/引用检查…)全部零改动;
   * 只有**写盘**按 `projectId` 分流到两个位置(见 save)。某个项目文件损坏时**只丢该项目**
   * 的资源,不再像单文件时代那样一旦 JSON 坏掉就整个资产库不可读。
   */
  private readAll(): { assets: Asset[]; categories: AssetCategory[]; migratedV1: boolean } {
    const base = this.read();
    const assets: Asset[] = [...base.assets];
    const categories: AssetCategory[] = [...base.categories];
    // 扫 workspaces/<pid>/assets.json,合并各项目的资源与分类
    let dirs: string[] = [];
    try {
      dirs = readdirSync(WORKSPACES_DIR).filter((d) => {
        try { return statSync(join(WORKSPACES_DIR, d)).isDirectory(); } catch { return false; }
      });
    } catch { /* workspaces/ 尚不存在(全新安装或未迁移) */ }
    for (const pid of dirs) {
      const f = workspaceAssetsFile(pid);
      if (!existsSync(f)) continue;
      try {
        const doc = JSON.parse(readFileSync(f, 'utf-8')) as Partial<AssetStoreFile>;
        if (Array.isArray(doc.assets)) assets.push(...(doc.assets as Asset[]));
        if (Array.isArray(doc.categories)) categories.push(...(doc.categories as AssetCategory[]));
      } catch {
        // 单个项目文件损坏不影响其余(比单文件时代更健壮),但要显式记一笔不静默吞
        console.warn(`[assets] 项目资源文件损坏,已跳过:${f}`);
      }
    }
    return { assets, categories, migratedV1: !!base.migratedV1 };
  }

  /** 写盘:按 projectId 分流 —— 项目资源写进自己的工作空间,其余(缺省=全局库)写全局文件。
   *  categories 同样按 projectId 分流。只写有内容的文件,避免给每个项目留下空壳 assets.json。 */
  private save() {
    const globalAssets = this.assets.filter((a) => !a.projectId);
    const globalCats = this.categories.filter((c) => !c.projectId);
    writeFileSync(
      ASSETS_FILE,
      JSON.stringify({ version: 2, assets: globalAssets, categories: globalCats } satisfies AssetStoreFile, null, 2),
    );

    const byProject = new Map<string, { assets: Asset[]; categories: AssetCategory[] }>();
    for (const a of this.assets) {
      if (!a.projectId) continue;
      const b = byProject.get(a.projectId) ?? { assets: [], categories: [] };
      b.assets.push(a);
      byProject.set(a.projectId, b);
    }
    for (const c of this.categories) {
      if (!c.projectId) continue;
      const b = byProject.get(c.projectId) ?? { assets: [], categories: [] };
      b.categories.push(c);
      byProject.set(c.projectId, b);
    }
    for (const [pid, b] of byProject) {
      const f = workspaceAssetsFile(pid);
      try {
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, JSON.stringify({ version: 2, assets: b.assets, categories: b.categories } satisfies AssetStoreFile, null, 2));
      } catch (e) {
        // 红线 R6:不静默吞 —— 写项目资源失败必须留痕(否则用户看到"导入成功但列表没有")
        console.error(`[assets] 写项目资源失败 projectId=${pid}:${(e as Error).message}`);
      }
    }
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

  /**
   * 整体登记一批资源与分类(项目包导入专用)。
   *
   * 与 `importFromPaths` 的区别:那条会**重新 probe 媒体元数据、重新分配 id、重新落盘**,
   * 而导入端拿到的是包里**带完整元数据与已落盘 localPath 的记录**,再 probe 一遍纯属浪费
   * (且 ffprobe 会重新解一遍大视频)。这里直接登记:
   *  - id 冲突时重新分配(并把新 id 回传,调用方据此改写画布节点里的 assetId 引用);
   *  - projectId 一律覆盖为新项目 id(防止包里旧 pid 把资源挂到别的项目上)。
   *
   * @returns `idMap` 旧 id → 新 id(未冲突时同值),`added` 实际登记条数
   */
  importParsed(
    projectId: string,
    assets: Asset[],
    categories: AssetCategory[] = [],
  ): { added: number; idMap: Map<string, string> } {
    const idMap = new Map<string, string>();
    let added = 0;
    // 分类先登记(id 冲突同样重分配),资源挂靠时要按新 id 改写 categoryId
    const catMap = new Map<string, string>();
    for (const c of categories) {
      let nid = c.id;
      while (this.categories.some((x) => x.id === nid)) {
        nid = `cat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      }
      catMap.set(c.id, nid);
      this.categories.push({ ...c, id: nid, projectId });
    }
    for (const a of assets) {
      let nid = a.id;
      while (this.assets.some((x) => x.id === nid)) {
        nid = `asset-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      }
      idMap.set(a.id, nid);
      this.assets.push({
        ...a,
        id: nid,
        projectId,
        categoryId: a.categoryId ? (catMap.get(a.categoryId) ?? a.categoryId) : undefined,
      });
      added += 1;
    }
    if (added || categories.length) this.save();
    return { added, idMap };
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