/**
 * Ref2VA 参考图画布规整。
 *
 * h3 引擎读取参考图后用 H3_IMAGE_FIT_STRETCH 拉伸到视频画布,不会等比留白。
 * 竖版角色卡直接喂横版视频时,人脸/身体比例先被压坏,再参与生成。
 * 这里先等比缩放并用中性灰补齐,保证进入 h3 的每张参考图与输出同宽高比。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface NormalizeReferenceOptions {
  targetWidth: number;
  targetHeight: number;
  outDir: string;
  /** true=失败即拒绝提交;false(dry-run)=保留原路径以便预览命令 */
  strict: boolean;
}

/** ffmpeg 过滤器:等比缩小到画布内,再居中补灰,不裁剪人物。 */
export function buildReferencePadFilter(width: number, height: number): string {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x7f7f7f`;
}

async function probeSize(path: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', path],
    { timeout: 20_000 },
  );
  const parsed = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> };
  const s = parsed.streams?.[0];
  if (!s?.width || !s?.height) throw new Error('ffprobe 未返回图片宽高');
  return { width: s.width, height: s.height };
}

export async function normalizeH3ReferenceImage(
  srcPath: string,
  opts: NormalizeReferenceOptions,
): Promise<{ path: string; changed: boolean }> {
  const fallback = { path: srcPath, changed: false };
  try {
    if (!srcPath || !existsSync(srcPath)) throw new Error(`参考图不存在:${srcPath || '(空路径)'}`);
    const { width: sw, height: sh } = await probeSize(srcPath);
    const { targetWidth: tw, targetHeight: th } = opts;
    if (!Number.isFinite(tw) || !Number.isFinite(th) || tw <= 0 || th <= 0) return fallback;
    const sourceRatio = sw / sh;
    const targetRatio = tw / th;
    if (Math.abs(sourceRatio - targetRatio) / targetRatio <= 0.01) return fallback;

    mkdirSync(opts.outDir, { recursive: true });
    const signature = `${srcPath}|${tw}x${th}|${statSync(srcPath).mtimeMs}`;
    const hash = createHash('sha256').update(signature).digest('hex').slice(0, 12);
    const stem = basename(srcPath).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'ref';
    const out = join(opts.outDir, `${stem}-${tw}x${th}-${hash}.png`);
    if (existsSync(out)) return { path: out, changed: true };
    await execFileAsync('ffmpeg', ['-y', '-i', srcPath, '-vf', buildReferencePadFilter(tw, th), out], {
      timeout: 30_000,
    });
    if (!existsSync(out)) throw new Error('ffmpeg 未产出补齐后的参考图');
    return { path: out, changed: true };
  } catch (e) {
    if (opts.strict) throw new Error(`参考图等比补齐失败:${(e as Error).message}`);
    return fallback;
  }
}

/** 顺序处理,避免多张参考图并发抢 CPU/IO;顺序与 <Picture N> 保持一致。 */
export async function normalizeH3ReferenceImages(
  paths: string[],
  opts: NormalizeReferenceOptions,
): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    const normalized = await normalizeH3ReferenceImage(path, opts);
    out.push(normalized.path);
  }
  return out;
}
