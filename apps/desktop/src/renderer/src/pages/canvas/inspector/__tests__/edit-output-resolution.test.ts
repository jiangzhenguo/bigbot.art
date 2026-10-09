/**
 * 图片编辑「像素预算」(`--output-resolution`)与输出尺寸预测单测
 *
 * 背景(2026-10-08 真实排查):用户发现 `new27-0fxs`(896×1184)与输入图 `pal26-0fxs`
 * (1280×720)比例不一致。读 mlx-gen 源码确认:
 *
 *   `qwen_image_21_edit.py` 的 generate_image:
 *     ratio = images[-1].width / images[-1].height     ← **最后一张**,不是第一张
 *     default_w, default_h = QwenImage21LatentCreator.dimensions(output_resolution, ratio)
 *     width  = default_w if width  is None else width   ← 编辑路由从不传 width/height
 *     height = default_h if height is None else height  ← 故两个 default 全部生效
 *
 *   而 App 侧 `--image-paths` 的顺序是 [inputPath, ...references]
 *   (输入图在前、参考图在后)→ **最后一张 = 最后一个参考图**。
 *   实测吻合到像素:output_resolution=1024 + 参考图 896×1184 → 896×1184。
 *
 * 本文件锁:① 尺寸公式与 mlx-gen 一致;② 「最后一张」的判定顺序与 provider 一致;
 * ③ 控件只在 2.1 参考编辑下出现;④ 默认值与 mlx-gen argparse 一致。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  predictOutputSize,
  lastGeometrySource,
  shouldShowOutputResolution,
  DEFAULT_OUTPUT_RESOLUTION,
  OUTPUT_RESOLUTION_STOPS,
} from '../ImageEditInspector';

const MLXGEN = 'Qwen/Qwen-Image-2.1';
const QWEN_EDIT = 'mlx-community/Qwen-Image-Edit-8bit';
const FLUX2 = 'AbstractFramework/flux.2-klein-9b-8bit';

/** 仓库根(本文件在 apps/desktop/src/renderer/src/pages/canvas/inspector/__tests__/) */
const repoRoot = path.join(__dirname, '../../../../../../../../..');

describe('predictOutputSize — 公式必须与 mlx-gen 一致', () => {
  it('事故现场复现:output_resolution=1024 + 参考图 896×1184 → 896×1184', () => {
    // 这是真实生成结果的尺寸,必须一像素不差
    expect(predictOutputSize(1024, 896 / 1184)).toEqual({ w: 896, h: 1184 });
  });

  it('对照:若最后一张是 1280×720 的输入图 → 1376×768(证明比例来源不同结果不同)', () => {
    expect(predictOutputSize(1024, 1280 / 720)).toEqual({ w: 1376, h: 768 });
  });

  it('输出必然是 32 的倍数(CLI 会硬校验,否则 exit)', () => {
    for (const ratio of [1, 16 / 9, 9 / 16, 4 / 3, 3 / 4, 2 / 3, 896 / 1184]) {
      for (const res of OUTPUT_RESOLUTION_STOPS) {
        const r = predictOutputSize(res, ratio)!;
        expect(r.w % 32, `ratio=${ratio} res=${res} → ${r.w}`).toBe(0);
        expect(r.h % 32, `ratio=${ratio} res=${res} → ${r.h}`).toBe(0);
        expect(r.w).toBeGreaterThanOrEqual(32);
        expect(r.h).toBeGreaterThanOrEqual(32);
      }
    }
  });

  it('正方形比例 → 宽高相等', () => {
    const r = predictOutputSize(1024, 1)!;
    expect(r.w).toBe(r.h);
  });

  it('提高预算只放大、不改变宽高比(控件「改不了比例」这句的依据)', () => {
    const a = predictOutputSize(1024, 896 / 1184)!;
    const b = predictOutputSize(2048, 896 / 1184)!;
    expect(b.w).toBeGreaterThan(a.w);
    expect(b.h).toBeGreaterThan(a.h);
    // 比例保持一致(允许 32 对齐带来的极小误差)
    expect(Math.abs(a.w / a.h - b.w / b.h)).toBeLessThan(0.02);
  });

  it('拿不到比例时返回 null(UI 不预测,而不是编一个数)', () => {
    expect(predictOutputSize(1024, null)).toBeNull();
    expect(predictOutputSize(1024, undefined)).toBeNull();
    expect(predictOutputSize(1024, NaN)).toBeNull();
    expect(predictOutputSize(1024, 0)).toBeNull();
    expect(predictOutputSize(1024, -1)).toBeNull();
  });

  it('非法预算返回 null', () => {
    expect(predictOutputSize(NaN, 1)).toBeNull();
    expect(predictOutputSize(16, 1)).toBeNull();
  });
});

describe('lastGeometrySource — 必须与 provider 的 --image-paths 顺序一致', () => {
  it('有参考图 → 最后一张 = 最后一个参考图(不是第一个)', () => {
    expect(lastGeometrySource({ hasInput: true, refNodeIds: ['r1', 'r2', 'r3'] }))
      .toEqual({ kind: 'ref', nodeId: 'r3' });
  });

  it('单张参考图 → 就是它', () => {
    expect(lastGeometrySource({ hasInput: true, refNodeIds: ['only'] }))
      .toEqual({ kind: 'ref', nodeId: 'only' });
  });

  it('参考图排在输入图之后 —— 故有参考图时输入图不决定几何', () => {
    // 这正是事故现场:input=1280×720 但输出跟着参考图 896×1184
    const geom = lastGeometrySource({ hasInput: true, refNodeIds: ['ref'] });
    expect(geom).toEqual({ kind: 'ref', nodeId: 'ref' });
    expect(geom).not.toEqual({ kind: 'input' });
  });

  it('无参考图、只有输入图 → 输入图决定几何', () => {
    expect(lastGeometrySource({ hasInput: true, refNodeIds: [] })).toEqual({ kind: 'input' });
  });

  it('都没有 → null', () => {
    expect(lastGeometrySource({ hasInput: false, refNodeIds: [] })).toBeNull();
  });

  it('滤掉空 nodeId(脏派生态不能当成有效参考图)', () => {
    expect(lastGeometrySource({ hasInput: true, refNodeIds: ['r1', '', undefined as unknown as string] }))
      .toEqual({ kind: 'ref', nodeId: 'r1' });
  });
});

describe('shouldShowOutputResolution — 只在 2.1 的指令编辑下出现', () => {
  it('Qwen-Image-2.1 + instruction → 显示', () => {
    expect(shouldShowOutputResolution(MLXGEN, 'instruction')).toBe(true);
  });

  it('其它模型不显示(它们走别的路由,根本不认这个参数)', () => {
    expect(shouldShowOutputResolution(QWEN_EDIT, 'instruction')).toBe(false);
    expect(shouldShowOutputResolution(FLUX2, 'instruction')).toBe(false);
  });

  it('2.1 的非指令模式不显示(只有 qwen21.edit 路由认它)', () => {
    expect(shouldShowOutputResolution(MLXGEN, 'img2img')).toBe(false);
    expect(shouldShowOutputResolution(MLXGEN, 'inpaint')).toBe(false);
    expect(shouldShowOutputResolution(MLXGEN, 'outpaint')).toBe(false);
  });

  it('短别名 / 本地目录路径 / 历史 8bit 标识都能命中(按正则而非精确 repoId)', () => {
    expect(shouldShowOutputResolution('qwen-image-2.1', 'instruction')).toBe(true);
    expect(shouldShowOutputResolution('qwen-2.1', 'instruction')).toBe(true);
    expect(shouldShowOutputResolution('/Users/x/ai/models/Qwen-Image-2.1-bf16', 'instruction')).toBe(true);
    expect(shouldShowOutputResolution('JoyFusionAI/Qwen-Image-2.1-MLX-8bit', 'instruction')).toBe(true);
  });

  it('不能误伤 Qwen-Image-Edit(没有 2.1 字样)', () => {
    expect(shouldShowOutputResolution('mlx-community/Qwen-Image-Edit-8bit', 'instruction')).toBe(false);
    expect(shouldShowOutputResolution('Qwen-Image-Edit-2511', 'instruction')).toBe(false);
  });
});

describe('默认值与档位', () => {
  it('默认 1024,且与 mlx-gen CLI 的 argparse 默认一致', () => {
    expect(DEFAULT_OUTPUT_RESOLUTION).toBe(1024);
    const cli = fs.readFileSync(
      path.join(process.env.HOME ?? '', 'ai/mlx-gen/src/mflux/models/qwen21/cli/qwen21_edit_generate.py'),
      'utf8',
    );
    // parser.add_argument("--output-resolution", type=int, default=1024, ...)
    const m = /"--output-resolution",\s*\n?\s*type=int,\s*\n?\s*default=(\d+)/.exec(cli);
    expect(m, '未能在 mlx-gen CLI 中找到 --output-resolution 默认值').toBeTruthy();
    expect(Number(m![1])).toBe(DEFAULT_OUTPUT_RESOLUTION);
  });

  it('全部档位都是 32 的倍数(CLI 硬约束)', () => {
    for (const s of OUTPUT_RESOLUTION_STOPS) {
      expect(s % 32, `档位 ${s}`).toBe(0);
      expect(s % 1024 === 0 || s % 256 === 0, `档位 ${s} 应是常用档`).toBe(true);
    }
  });

  it('档位包含默认值,否则 UI 会把默认值当成「非档位值」额外插一项', () => {
    expect(OUTPUT_RESOLUTION_STOPS).toContain(DEFAULT_OUTPUT_RESOLUTION);
  });
});

describe('provider 侧注释已更正(本次修正的核心事实)', () => {
  it('mlxgen.ts 不得再写「第一张锚定几何」这种错误说法', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'packages/providers/src/mlxgen.ts'), 'utf8');
    expect(src).not.toMatch(/顺序即语义:第一张锚定几何/);
    expect(src).toMatch(/images\[-1\]/); // 正确事实已在注释里留证
    expect(src).toMatch(/最后一张/);
  });

  it('CLAUDE.md 不得再写「首张锚定几何」', () => {
    const md = fs.readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
    expect(md).not.toMatch(/首张锚定几何/);
  });
});

/**
 * 🚨 白名单联动闸(本组测试的真正价值)
 *
 * `CanvasPage.runNode` 里的 `params` 是一个**显式白名单对象** —— 只写进 `node.data`
 * 而没列进这个对象的字段,**到不了 provider**。表现极其隐蔽:检查器控件显示正常、
 * 也能写盘,只有实际生成的命令里没这个参数(用户以为调了、其实没生效)。
 *
 * 本组测试把「检查器会写 data 的字段」与「runNode 会转发到 provider 的字段」对账,
 * 防的就是这一类静默断裂。
 */
describe('联动:检查器写的字段必须能到达 provider', () => {
  const canvasPage = fs.readFileSync(
    path.join(repoRoot, 'apps/desktop/src/renderer/src/pages/CanvasPage.tsx'),
    'utf8',
  );
  const provider = fs.readFileSync(path.join(repoRoot, 'packages/providers/src/mlxgen.ts'), 'utf8');

  it('runNode 的 image params 白名单里有 outputResolution', () => {
    // 取 isImage ? { … } : { … } 那段白名单
    const i = canvasPage.indexOf('const params = isImage');
    expect(i).toBeGreaterThan(-1);
    const seg = canvasPage.slice(i, i + 1200);
    expect(seg).toMatch(/outputResolution:\s*d\.outputResolution/);
  });

  it('provider 确实把它转成 --output-resolution', () => {
    expect(provider).toMatch(/p\.outputResolution\s*!=/);
    expect(provider).toMatch(/cmd\.push\('--output-resolution'/);
  });

  it('provider 侧对非法值有防护(不把 NaN 拼进命令行)', () => {
    const i = provider.indexOf("cmd.push('--output-resolution'");
    expect(i).toBeGreaterThan(-1);
    // 上一行应是有限性校验
    const before = provider.slice(Math.max(0, i - 200), i);
    expect(before).toMatch(/Number\.isFinite/);
  });

  /* 输出尺寸(width/height)走的是 image-gen 早就用的同名字段,
     故白名单里本就有 —— 但仍要锁住,防有人「清理未使用字段」时把它删掉。 */
  it('runNode 白名单里有 width/height(编辑尺寸能力依赖它)', () => {
    const i = canvasPage.indexOf('const params = isImage');
    const seg = canvasPage.slice(i, i + 1200);
    expect(seg).toMatch(/width:\s*d\.width/);
    expect(seg).toMatch(/height:\s*d\.height/);
  });

  it('provider 把 width/height 转成 --width/--height(且两个都有效才传)', () => {
    expect(provider).toMatch(/cmd\.push\('--width', String\(Math\.round\(editW\)\), '--height'/);
    // 成对判定:必须同时校验 editW 与 editH
    const i = provider.indexOf('const editW = Number(p.width)');
    expect(i).toBeGreaterThan(-1);
    const seg = provider.slice(i, i + 400);
    expect(seg).toMatch(/Number\.isFinite\(editW\)/);
    expect(seg).toMatch(/Number\.isFinite\(editH\)/);
  });
});
