/**
 * 图片裁切集成/单元测试(主进程 frames.ts)
 * - 纯函数:parseCropAspect / buildCropVf(画幅解析与 filtergraph 构造)
 * - 集成:ffmpeg 真实裁剪(本机有 ffmpeg 时跑),产物在临时 BIGBOTART_HOME 下,绝不触碰真实用户数据
 *
 * 关键:frames.ts 的模块级常量(OUTPUTS_DIR/CROPS_DIR)在 import 时按 env 求值 →
 * 必须在模块顶层先设 BIGBOTART_HOME,再在 beforeAll 里动态 import。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// ⚠️ 先于任何 frames 模块加载:OUTPUTS_DIR 由 BIGBOTART_H3_OUTPUTS(优先)/BIGBOTART_HOME 求值,
// 两处都要指向临时目录,避免落到仓库内 `.bigbotart/outputs`(resolveOutputsDir 会优先命中已有目录)
const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-crop-test-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');

const hasFfmpeg = (() => {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
})();

let outDir = join(tmpHome, 'outputs');
let srcPath = '';
let assetSrcPath = '';
let assetVideoPath = '';
// 模块引用:beforeAll 内动态加载(此时 env 已就绪)
let F: typeof import('../frames.js');

beforeAll(async () => {
  F = await import('../frames.js');
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/** ffprobe 探测 PNG 尺寸(失败返回 null) */
function pngSize(path: string): { w: number; h: number } | null {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path],
    { encoding: 'utf-8' },
  );
  if (r.status !== 0 || !r.stdout) return null;
  const [w, h] = r.stdout.trim().split(',');
  const nw = Number(w);
  const nh = Number(h);
  return Number.isFinite(nw) && Number.isFinite(nh) && nw > 0 && nh > 0 ? { w: nw, h: nh } : null;
}

describe('parseCropAspect(纯函数)', () => {
  it('16:9 → 比值 ≈ 1.7778;9:16 → ≈ 0.5625;1:1 → 1', () => {
    const { parseCropAspect } = F;
    expect(parseCropAspect('16:9')).toEqual({ ok: true, ratio: expect.closeTo(16 / 9, 6) });
    expect((parseCropAspect('9:16') as { ratio: number }).ratio).toBeCloseTo(9 / 16, 6);
    expect((parseCropAspect('1:1') as { ratio: number }).ratio).toBe(1);
  });

  it('非法格式返回错误(0 值/非 A:B/空串)', () => {
    const { parseCropAspect } = F;
    expect(parseCropAspect('0:1').ok).toBe(false);
    expect(parseCropAspect('16').ok).toBe(false);
    expect(parseCropAspect('foo').ok).toBe(false);
    expect(parseCropAspect('').ok).toBe(false);
  });
});

describe('buildCropVf(纯函数)', () => {
  it('center:两个轴均居中表达式', () => {
    const vf = F.buildCropVf(9 / 16, 'center');
    expect(vf).toContain('crop=min(iw\\,ih*');
    expect(vf).toContain('(iw-ow)/2');
    expect(vf).toContain('(ih-oh)/2');
  });

  it('left/right 锚定 x 轴(右 → iw-ow)', () => {
    expect(F.buildCropVf(9 / 16, 'right')).toContain(':iw-ow:');
    expect(F.buildCropVf(9 / 16, 'left')).toContain(':0:');
  });

  it('top/bottom 锚定 y 轴(下 → ih-oh)', () => {
    expect(F.buildCropVf(9 / 16, 'bottom')).toContain(':ih-oh');
    expect(F.buildCropVf(9 / 16, 'top')).toContain(':0');
  });
});

describe.runIf(hasFfmpeg)('集成 · ffmpeg 真实裁剪', () => {
  beforeAll(() => {
    mkdirSync(outDir, { recursive: true });
    srcPath = join(outDir, 'src-1024.png');
    // 资产库素材(模拟 ~/.bigbotart/assets/ 导入素材):图片与视频都放在 ASSETS_DIR
    const assetDir = join(tmpHome, 'assets');
    mkdirSync(assetDir, { recursive: true });
    assetSrcPath = join(assetDir, 'src-asset-1024.png');
    assetVideoPath = join(assetDir, 'src-asset-video.mp4');
    // 用 ffmpeg 生成 1024×1024 测试图(产出在输出根目录 outputSearchRoots 之下)
    const gen = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0x336699:s=1024x1024:d=1', '-frames:v', '1', srcPath], { stdio: 'ignore' });
    if (gen.status !== 0) throw new Error('无法生成测试图(ffmpeg 异常)');
    const genAsset = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0x339966:s=1024x1024:d=1', '-frames:v', '1', assetSrcPath], { stdio: 'ignore' });
    if (genAsset.status !== 0) throw new Error('无法生成资产测试图(ffmpeg 异常)');
    const genVid = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=s=320x240:d=1:r=24', '-pix_fmt', 'yuv420p', assetVideoPath], { stdio: 'ignore' });
    if (genVid.status !== 0) throw new Error('无法生成资产测试视频(ffmpeg 异常)');
  });

  it('1:1 (1024²) → 9:16:输出 576×1024,产物落临时目录', async () => {
    const res = await F.cropImage(srcPath, '9:16', 'center');
    expect(res.ok, res.error).toBe(true);
    expect(res.path!).toContain(tmpHome); // 隔离:产物在临时 HOME 下
    expect(pngSize(res.path!)).toEqual({ w: 576, h: 1024 });
  });

  it('1:1 (1024²) → 16:9:输出 1024×576', async () => {
    const res = await F.cropImage(srcPath, '16:9', 'center');
    expect(res.ok, res.error).toBe(true);
    expect(pngSize(res.path!)).toEqual({ w: 1024, h: 576 });
  });

  it('锚点变体(right)仍为 9:16 尺寸(内容裁剪位置不同)', async () => {
    const res = await F.cropImage(srcPath, '9:16', 'right');
    expect(res.ok, res.error).toBe(true);
    expect(pngSize(res.path!)).toEqual({ w: 576, h: 1024 });
  });

  it('非法画幅 → ok:false 带错误文案', async () => {
    const res = await F.cropImage(srcPath, 'foo', 'center');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('画幅格式非法');
  });

  it('输入文件不存在 → ok:false', async () => {
    const res = await F.cropImage(join(outDir, 'nope.png'), '9:16', 'center');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('不存在');
  });

  it('输入路径不在允许目录 → 拒绝裁切(安全边界)', async () => {
    const res = await F.cropImage('/etc/hosts', '9:16', 'center');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('允许目录');
  });

  it('资产库素材(ASSETS_DIR)图片可裁剪(回归:曾误报「不在允许目录」)', async () => {
    const res = await F.cropImage(assetSrcPath, '9:16', 'center');
    expect(res.ok, res.error).toBe(true);
    expect(pngSize(res.path!)).toEqual({ w: 576, h: 1024 });
  });

  it('资产库素材(ASSETS_DIR)视频可取帧(回归:与裁切同源校验)', async () => {
    const res = await F.extractFrame(assetVideoPath, 'first');
    expect(res.ok, res.error).toBe(true);
    expect(existsSync(res.path!)).toBe(true);
  });

  it('产物文件确实存在且为 PNG', async () => {
    const res = await F.cropImage(srcPath, '1:1', 'center');
    expect(res.ok, res.error).toBe(true);
    expect(existsSync(res.path!)).toBe(true);
  });
});