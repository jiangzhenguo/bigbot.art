import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildReferencePadFilter, normalizeH3ReferenceImage } from '../reference-images';

const execFileAsync = promisify(execFile);

describe('Ref2VA 参考图等比补齐', () => {
  it('过滤器是等比缩放 + 居中补灰,不裁切、不拉伸', () => {
    expect(buildReferencePadFilter(1024, 576)).toBe(
      'scale=1024:576:force_original_aspect_ratio=decrease:flags=lanczos,pad=1024:576:(ow-iw)/2:(oh-ih)/2:color=0x7f7f7f',
    );
  });

  it('竖图进横画布:输出尺寸正确且原图不改写', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h3-ref-pad-'));
    try {
      const src = join(dir, 'vertical.png');
      await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x128', '-frames:v', '1', src]);
      const result = await normalizeH3ReferenceImage(src, {
        targetWidth: 128,
        targetHeight: 128,
        outDir: join(dir, 'out'),
        strict: true,
      });
      expect(result.changed).toBe(true);
      expect(result.path).not.toBe(src);
      expect(existsSync(result.path)).toBe(true);
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', result.path,
      ]);
      const info = JSON.parse(stdout) as { streams: Array<{ width: number; height: number }> };
      expect(info.streams[0]).toMatchObject({ width: 128, height: 128 });
      // 再次提交复用同一补齐文件,不重复生成新文件。
      const again = await normalizeH3ReferenceImage(src, {
        targetWidth: 128,
        targetHeight: 128,
        outDir: join(dir, 'out'),
        strict: true,
      });
      expect(again.path).toBe(result.path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('同画幅不另建文件;缺图在真实模式明确失败,dry-run 可预览原路径', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h3-ref-same-'));
    try {
      const src = join(dir, 'wide.png');
      await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=128x64', '-frames:v', '1', src]);
      const same = await normalizeH3ReferenceImage(src, {
        targetWidth: 256,
        targetHeight: 128,
        outDir: join(dir, 'out'),
        strict: true,
      });
      expect(same).toEqual({ path: src, changed: false });
      await expect(
        normalizeH3ReferenceImage(join(dir, 'missing.png'), {
          targetWidth: 128,
          targetHeight: 128,
          outDir: join(dir, 'out'),
          strict: true,
        }),
      ).rejects.toThrow('参考图等比补齐失败');
      const dry = await normalizeH3ReferenceImage(join(dir, 'missing.png'), {
        targetWidth: 128,
        targetHeight: 128,
        outDir: join(dir, 'out'),
        strict: false,
      });
      expect(dry.changed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
