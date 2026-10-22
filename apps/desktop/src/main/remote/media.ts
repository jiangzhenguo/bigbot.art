/**
 * HTTP 媒体路径。复刻 bba-asset / bba-output 的文件名规则,
 * 命中后再 realpath,防止符号链接跳出白名单。
 */
import { realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { ASSETS_DIR, isValidOutputRelName, outputSearchRoots } from '../assets';

const ASSET_NAME = /^asset-[A-Za-z0-9._-]+$/;

export interface MediaHit {
  ok: true;
  file: string;
}
export interface MediaMiss {
  ok: false;
  status: 400 | 403 | 404;
  error: string;
}

function inside(realFile: string, realRoot: string): boolean {
  const root = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  return realFile === realRoot || realFile.startsWith(root);
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

export function resolveAssetFile(name: string): MediaHit | MediaMiss {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return { ok: false, status: 400, error: '文件名无法解码' };
  }
  if (!ASSET_NAME.test(decoded)) return { ok: false, status: 400, error: '资产文件名不合法' };
  const candidate = join(ASSETS_DIR, decoded);
  if (!existsSync(candidate)) return { ok: false, status: 404, error: '资产不存在' };
  const root = realOrNull(ASSETS_DIR) ?? resolve(ASSETS_DIR);
  const real = realOrNull(candidate);
  if (!real || !inside(real, root)) return { ok: false, status: 403, error: '资产路径越界' };
  return { ok: true, file: real };
}

export function resolveOutputFile(name: string): MediaHit | MediaMiss {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return { ok: false, status: 400, error: '文件名无法解码' };
  }
  if (!isValidOutputRelName(decoded)) return { ok: false, status: 400, error: '产物路径不合法' };
  for (const root of outputSearchRoots()) {
    const candidate = resolve(join(root, decoded));
    const rootResolved = resolve(root);
    if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) continue;
    if (!existsSync(candidate)) continue;
    const realRoot = realOrNull(root) ?? rootResolved;
    const real = realOrNull(candidate);
    if (!real || !inside(real, realRoot)) return { ok: false, status: 403, error: '产物路径越界' };
    return { ok: true, file: real };
  }
  return { ok: false, status: 404, error: '产物不存在' };
}
