/**
 * 服务端缩略图。
 *
 * 为什么需要:公网链路实测只有 ~350KB/s,而首页一次要拉 19 张**全尺寸原图**
 * (实测合计 27.6MB)。这些大文件会把 HTML/JS/接口请求全堵在后面 ——
 * 表现为「打开要等一分钟,连登录都慢」。
 *
 * 做法:用 macOS 自带的 sips 按最长边缩放,结果缓存到 ~/.bigbotart/thumbs/。
 * 缓存键含 mtime + size,原图变了自动重生成;原图没变就永远命中。
 *
 * 降级:sips 不在(非 macOS)、格式不支持、sips 失败 → 返回 null,调用方回退原图。
 * 宁可给大图,也不能给不出来。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DATA_DIR } from '../workspace-paths';

const execFileAsync = promisify(execFile);

/** 缩略图宽度下限:太小没有意义,还会被放大糊 */
export const MIN_THUMB_WIDTH = 16;
/** 上限:防止有人传 ?w=99999 造出一个巨图 */
export const MAX_THUMB_WIDTH = 2048;

const THUMB_DIR = join(DATA_DIR, 'thumbs');

/** 同一 key 的并发请求共用一次生成 */
const pending = new Map<string, Promise<string | null>>();

/** 能不能按这个宽度做缩略图 */
export function isThumbWidth(w: unknown): w is number {
  return typeof w === 'number' && Number.isFinite(w) && w >= MIN_THUMB_WIDTH && w <= MAX_THUMB_WIDTH;
}

/** 动图不做缩略图(第一帧当封面没意义,而且 GIF 缩略后动画会丢) */
function isAnimated(name: string): boolean {
  return /\.gif$/i.test(name);
}

/** 缩略图缓存键:路径 + mtime + size + 宽度 —— 原图一改就换键 */
function cacheKey(file: string, width: number, mtimeMs: number, size: number): string {
  return createHash('sha1').update(`${file}|${mtimeMs}|${size}|${width}`).digest('hex');
}

/**
 * 取(必要时生成)缩略图,返回磁盘路径;失败返回 null。
 */
export async function thumbnailFor(file: string, width: number): Promise<string | null> {
  if (!isThumbWidth(width)) return null;
  if (!existsSync(file)) return null;
  if (isAnimated(file)) return null;

  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  const key = cacheKey(file, width, st.mtimeMs, st.size);
  const out = join(THUMB_DIR, `${key}.jpg`);
  if (existsSync(out)) return out;

  const inflight = pending.get(key);
  if (inflight) return inflight;

  const task = (async () => {
    try {
      mkdirSync(THUMB_DIR, { recursive: true });
      // -Z:按最长边等比缩放;-s format jpeg:统一输出(浏览器都认)
      await execFileAsync('sips', ['-Z', String(width), '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', file, '--out', out], {
        timeout: 15_000,
      });
      return existsSync(out) ? out : null;
    } catch {
      return null;
    } finally {
      pending.delete(key);
    }
  })();

  pending.set(key, task);
  return task;
}
