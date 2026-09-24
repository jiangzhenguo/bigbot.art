/**
 * 图片拼接/拆分测试(主进程 stitch.ts)
 * - 纯函数:planStitch / buildStitchFilter / planSplit / buildSplitFilter(布局与 filtergraph 构造)
 * - 集成:ffmpeg 真实拼接/拆分(本机有 ffmpeg 时跑),产物在临时 BIGBOTART_HOME 下,绝不触碰真实用户数据
 *
 * 与 frames-crop.test.ts 同约束:stitch.ts 的模块级常量(OUTPUTS_DIR/STITCH_DIR/SPLITS_DIR)
 * 在 import 时按 env 求值 → 必须在模块顶层先设 env,再在 beforeAll 里动态 import。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// ⚠️ 先于任何 stitch 模块加载
const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-stitch-test-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');

const hasFfmpeg = (() => {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
      && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

let S: typeof import('../stitch.js');

beforeAll(async () => {
  S = await import('../stitch.js');
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/* ── 纯函数:planStitch ── */
describe('planStitch 布局', () => {
  const sq = (w: number, h: number) => ({ w, h });

  it('少于 2 张被拒', () => {
    const r = S.planStitch([sq(100, 100)], 'row');
    expect(r.ok).toBe(false);
  });

  it('row:统一到最小高,横向累加 + 间距', () => {
    const r = S.planStitch([sq(200, 100), sq(100, 50), sq(300, 200)], 'row', 3, 10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // H = 50;宽按比例 100 / 100 / 75
    expect(r.plan.canvas).toEqual({ w: 100 + 100 + 75 + 20, h: 50 });
    expect(r.plan.placements.map((p) => [p.x, p.y, p.w, p.h])).toEqual([
      [0, 0, 100, 50],
      [110, 0, 100, 50],
      [220, 0, 75, 50],
    ]);
  });

  it('column:统一到最小宽,纵向累加', () => {
    const r = S.planStitch([sq(100, 100), sq(200, 100)], 'column');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // W = 100;高 100 / 50
    expect(r.plan.canvas).toEqual({ w: 100, h: 150 });
    expect(r.plan.placements[1]).toEqual({ x: 0, y: 100, w: 100, h: 50 });
  });

  it('grid:单元格 = 最小宽×最小高,比例缩放居中,末行留白', () => {
    // 3 张图 2 列 → 2 行,第 3 片在左格
    const r = S.planStitch([sq(200, 100), sq(100, 100), sq(100, 200)], 'grid', 2, 6);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.canvas).toEqual({ w: 100 * 2 + 6, h: 100 * 2 + 6 });
    // 200×100 → 缩到 100×50,单元格内垂直居中 (0, 25)
    expect(r.plan.placements[0]).toEqual({ x: 0, y: 25, w: 100, h: 50 });
    // 100×100 → 原样 (106, 0)
    expect(r.plan.placements[1]).toEqual({ x: 106, y: 0, w: 100, h: 100 });
    // 100×200 → 缩到 50×100,水平居中 (0+25, 106)
    expect(r.plan.placements[2]).toEqual({ x: 25, y: 106, w: 50, h: 100 });
  });

  it('grid 列数超过图片数时收敛到图片数', () => {
    const r = S.planStitch([sq(10, 10), sq(10, 10)], 'grid', 9);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.canvas.w).toBe(20); // 2 列
  });
});

describe('buildStitchFilter', () => {
  it('color 底版 + 逐张 overlay,末棒输出 [out]', () => {
    const plan = {
      canvas: { w: 200, h: 100 },
      placements: [
        { x: 0, y: 0, w: 100, h: 100 },
        { x: 100, y: 0, w: 100, h: 100 },
      ],
    };
    const f = S.buildStitchFilter(plan, 'white');
    expect(f).toBe('[0:v]scale=100:100[v0];[1:v]scale=100:100[v1];[2:v][v0]overlay=0:0[t0];[t0][v1]overlay=100:0[out]');
  });
});

/* ── 纯函数:planSplit ── */
describe('planSplit 等分', () => {
  it('rows:横切 N 段,末段吃余数', () => {
    const r = S.planSplit({ w: 100, h: 101 }, 'rows', 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rects).toEqual([
      { x: 0, y: 0, w: 100, h: 33 },
      { x: 0, y: 33, w: 100, h: 33 },
      { x: 0, y: 66, w: 100, h: 35 },
    ]);
  });

  it('cols:竖切 N 段,末段吃余数', () => {
    const r = S.planSplit({ w: 7, h: 50 }, 'cols', 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rects.map((x) => [x.x, x.w])).toEqual([[0, 2], [2, 2], [4, 3]]);
  });

  it('grid:行优先编号(piece-1 = 左上)', () => {
    const r = S.planSplit({ w: 90, h: 60 }, 'grid', 3, 3, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rects).toHaveLength(6);
    expect(r.rects[0]).toEqual({ x: 0, y: 0, w: 30, h: 30 });
    expect(r.rects[3]).toEqual({ x: 0, y: 30, w: 30, h: 30 });
    expect(r.rects[5]).toEqual({ x: 60, y: 30, w: 30, h: 30 });
  });

  it('片数越界 / 尺寸不足被拒', () => {
    expect(S.planSplit({ w: 100, h: 100 }, 'rows', 1).ok).toBe(false);
    expect(S.planSplit({ w: 100, h: 100 }, 'rows', 99).ok).toBe(false);
    expect(S.planSplit({ w: 2, h: 100 }, 'cols', 5).ok).toBe(false);
  });
});

describe('buildSplitFilter', () => {
  it('split=N + 逐片 crop', () => {
    const f = S.buildSplitFilter([
      { x: 0, y: 0, w: 50, h: 100 },
      { x: 50, y: 0, w: 50, h: 100 },
    ]);
    expect(f).toBe('[0:v]split=2[s0][s1];[s0]crop=50:100:0:0[o0];[s1]crop=50:100:50:0[o1]');
  });
});

/* ── 集成:真实 ffmpeg(有 ffmpeg+ffprobe 才跑) ── */
describe.skipIf(!hasFfmpeg)('ffmpeg 集成', () => {
  const mk = (name: string, color: string, size: string) => {
    const p = join(tmpHome, name);
    const r = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`, '-frames:v', '1', p], { stdio: 'ignore' });
    if (r.status !== 0) throw new Error(`造图失败: ${name}`);
    return p;
  };

  it('row 拼接 2 张不同尺寸 → 画布 = 宽相加 × 最小高', async () => {
    const a = mk('a.png', 'red', '200x100');
    const b = mk('b.png', 'blue', '100x50');
    const res = await S.stitchImages([a, b], { mode: 'row' });
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(res.path && existsSync(res.path)).toBe(true);
    // 产物尺寸:H=50 → 200×100 缩成 100×50,100×50 原样;画布 (100+100)×50
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', res.path!]);
    expect(probe.stdout.toString().trim()).toBe('200x50');
  });

  it('grid 拆分 90x60 → 3×2 共 6 片,尺寸正确', async () => {
    const src = mk('g.png', 'green', '90x60');
    const res = await S.splitImage(src, { mode: 'grid', gridCols: 3, gridRows: 2 });
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(res.paths).toHaveLength(6);
    for (const p of res.paths!) expect(existsSync(p)).toBe(true);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', res.paths![5]!]);
    expect(probe.stdout.toString().trim()).toBe('30x30');
  });

  it('白名单外路径被拒', async () => {
    const res = await S.splitImage('/etc/hosts', { mode: 'rows', count: 2 });
    expect(res.ok).toBe(false);
  });
});
