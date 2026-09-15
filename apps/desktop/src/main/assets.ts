/**
 * AssetStore — 资产中心(PRD §5.4 P0 基础)
 * - 导入:Electron 对话框选文件 → 复制到 ~/.bigbotart/assets/ + 自动元数据(ffprobe 宽高/时长)
 * - 持久化:assets.json;画布资产节点与资产中心互为镜像(同一 localPath)
 * - headless 导入(Agent/IPC paths):仅允许 DATA_DIR / outputs 白名单内路径,防任意读
 */
import { mkdirSync, copyFileSync, unlinkSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, extname, resolve } from 'node:path';
import { dialog, BrowserWindow } from 'electron';
import { spawnSync } from 'node:child_process';
import type { Asset, AssetImportResult } from '@bigbotart/shared';

const DATA_DIR = process.env.BIGBOTART_HOME ?? join(homedir(), '.bigbotart');
export const ASSETS_DIR = join(DATA_DIR, 'assets');
const ASSETS_FILE = join(DATA_DIR, 'assets.json');
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

/** bba-output 查找根:当前 OUTPUTS_DIR + 其它已知产物目录(旧路径兼容) */
export function outputSearchRoots(): string[] {
  const roots = new Set<string>([resolve(OUTPUTS_DIR)]);
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
  return [DATA_DIR, OUTPUTS_DIR, mockOut, imgOut];
}

/** 提取媒体元数据(ffprobe;图片/视频取宽高与时长,音频取时长,失败不阻断) */
export function probeMedia(path: string, kind: Asset['kind']): Pick<Asset, 'width' | 'height' | 'durationSec'> {
  const out: Pick<Asset, 'width' | 'height' | 'durationSec'> = {};
  if (kind === 'document') return out;
  try {
    const r = spawnSync('ffprobe', [
      '-v', 'error', '-print_format', 'json',
      '-show_streams', '-show_format', path,
    ], { timeout: 8000, encoding: 'utf-8' });
    if (r.status !== 0 || !r.stdout) return out;
    const j = JSON.parse(r.stdout);
    const v = (j.streams ?? []).find((s: { codec_type?: string }) => s.codec_type === 'video');
    if (v?.width) { out.width = v.width; out.height = v.height; }
    const dur = j.format?.duration ?? v?.duration;
    if (dur && Number.isFinite(Number(dur))) out.durationSec = Math.round(Number(dur) * 10) / 10;
  } catch {
    /* ffprobe 不可用或解析失败:元数据留空 */
  }
  return out;
}

export class AssetStore {
  private assets: Asset[] = [];

  constructor() {
    mkdirSync(ASSETS_DIR, { recursive: true });
    this.assets = this.read();
  }

  private read(): Asset[] {
    if (!existsSync(ASSETS_FILE)) return [];
    try {
      return JSON.parse(readFileSync(ASSETS_FILE, 'utf-8')) as Asset[];
    } catch {
      return [];
    }
  }

  private save() {
    writeFileSync(ASSETS_FILE, JSON.stringify(this.assets, null, 2));
  }

  list(): Asset[] {
    return [...this.assets].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  get(id: string): Asset | undefined {
    return this.assets.find((a) => a.id === id);
  }

  delete(id: string): { ok: boolean; error?: string } {
    const a = this.assets.find((x) => x.id === id);
    if (!a) return { ok: false, error: '资产不存在' };
    try {
      if (existsSync(a.localPath)) unlinkSync(a.localPath);
    } catch (e) {
      console.warn('资产文件删除失败', (e as Error).message);
    }
    this.assets = this.assets.filter((x) => x.id !== id);
    this.save();
    return { ok: true };
  }

  /** 弹出系统文件对话框导入,返回新增资产 */
  async importFromDialog(): Promise<AssetImportResult> {
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
    return this.importFromPaths(res.filePaths, { unrestricted: true });
  }

  /**
   * 按给定绝对路径列表导入(Agent headless / 程序化)。
   * 默认 restricted:路径必须落在 DATA_DIR / outputs 白名单内。
   * unrestricted 仅供系统对话框回调使用。
   */
  importFromPaths(paths: string[], opts?: { unrestricted?: boolean }): AssetImportResult {
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
        const a = this.ingest(src);
        if (a) result.assets.push(a);
        else result.failed.push({ name: basename(src), error: `不支持的扩展名(.${extname(src).slice(1).toLowerCase() || '?'})` });
      } catch (e) {
        result.failed.push({ name: basename(src ?? ''), error: (e as Error).message });
      }
    }
    return result;
  }

  /** 把单个文件纳入资产库(复制 + 元数据) */
  ingest(src: string): Asset | null {
    const ext = extname(src).slice(1).toLowerCase();
    const kind = KIND_BY_EXT[ext];
    if (!kind) return null;
    const id = `asset-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const dest = join(ASSETS_DIR, `${id}${extname(src).toLowerCase()}`);
    copyFileSync(src, dest);
    const meta = probeMedia(dest, kind);
    const asset: Asset = {
      id,
      kind,
      name: basename(src, extname(src)),
      localPath: dest,
      mime: MIME_BY_EXT[ext],
      ...meta,
      tags: [kind],
      createdAt: new Date().toISOString(),
    };
    this.assets.push(asset);
    this.save();
    return asset;
  }
}
