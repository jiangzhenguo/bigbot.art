/**
 * 视频增强(超分 + 合修脸)单元/集成测试 —— 主进程 video-post.ts
 *
 * 覆盖:
 *  - 纯函数:normalizeVideoPost 参数归一/防呆、planVideoPostStages 阶段计划、
 *    buildFaceFixArgs 的 `-s` 语义(关键防二次放大)、buildSuperResArgs、estimateVideoPostSeconds
 *  - 工具链探测:probeVideoPostTooling / checkToolingFor(缺啥报啥)
 *  - 集成:真实跑一次「Real-ESRGAN 超分(小分辨率 ×2)」端到端出片(本机工具链就绪时才跑)
 *
 * 关键:video-post.ts 的模块级常量(VIDEO_POST_DIR 等)在 import 时按 env 求值 →
 * 必须先设 env,再动态 import(与 frames-crop.test.ts 同约定)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// ⚠️ 先于任何 video-post 模块加载:产物目录由 env 求值
const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-vpost-test-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');

const hasFfmpeg = (() => {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

let outDir = join(tmpHome, 'outputs');
let srcVideo = '';
let VP: typeof import('../video-post.js');

/** 用 ffmpeg 造一段极小测试视频(64x64、1s、24fps)——不碰真实用户数据 */
function makeTinyVideo(path: string): boolean {
  const r = spawnSync(
    'ffmpeg',
    ['-y', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=24:duration=1', '-pix_fmt', 'yuv420p', path],
    { stdio: 'ignore' },
  );
  return r.status === 0 && existsSync(path);
}

beforeAll(async () => {
  VP = await import('../video-post.js');
  if (hasFfmpeg) {
    // 产物目录可能尚未创建(OUTPUTS_DIR 是常量,目录由运行期 mkdir)→ 先建再产出测试源
    mkdirSync(outDir, { recursive: true });
    srcVideo = join(outDir, 'src.mp4');
    makeTinyVideo(srcVideo);
  }
});

afterAll(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响断言 */
  }
});

describe('normalizeVideoPost — 参数归一与防呆', () => {
  it('空参数走默认配方(×2 + realesrgan-x4plus + GFPGAN)', () => {
    const n = VP.normalizeVideoPost({ inputPath: '/x.mp4' });
    expect(n.scale).toBe(2);
    expect(n.doSuperRes).toBe(true);
    expect(n.srModel).toBe('realesrgan-x4plus');
    expect(n.faceModel).toBe('gfpgan');
    expect(n.doFaceFix).toBe(true);
    expect(n.deblock).toBe(false);
    expect(n.device).toBe('mps');
  });

  it('非法放大倍数回落到默认 2(4/8 之类越界值不得透传)', () => {
    expect(VP.normalizeVideoPost({ inputPath: '/x.mp4', scale: 7 }).scale).toBe(2);
    expect(VP.normalizeVideoPost({ inputPath: '/x.mp4', scale: -1 }).scale).toBe(2);
    expect(VP.normalizeVideoPost({ inputPath: '/x.mp4', scale: Number.NaN }).scale).toBe(2);
  });

  it('scale=1 时不跑超分(仅修脸:方案 C)', () => {
    const n = VP.normalizeVideoPost({ inputPath: '/x.mp4', scale: 1 });
    expect(n.doSuperRes).toBe(false);
    expect(n.doFaceFix).toBe(true);
  });

  it('superRes=none 时不跑超分,但修脸保留', () => {
    const n = VP.normalizeVideoPost({ inputPath: '/x.mp4', superRes: 'none' });
    expect(n.doSuperRes).toBe(false);
    expect(n.doFaceFix).toBe(true);
  });

  it('faceModel=none 时不跑修脸,超分保留', () => {
    const n = VP.normalizeVideoPost({ inputPath: '/x.mp4', faceModel: 'none' });
    expect(n.doFaceFix).toBe(false);
    expect(n.doSuperRes).toBe(true);
  });

  it('未知模型名回落默认(不让坏值到 spawn)', () => {
    const n = VP.normalizeVideoPost({ inputPath: '/x.mp4', srModel: 'nope' as never, faceModel: 'x' as never });
    expect(n.srModel).toBe('realesrgan-x4plus');
    expect(n.faceModel).toBe('gfpgan');
  });

  it('faceWeight/fidelityWeight 钳制到 [0,1];crf 钳制到 [0,51]', () => {
    const a = VP.normalizeVideoPost({ inputPath: '/x.mp4', faceWeight: 5, fidelityWeight: -3, crf: 999, deblockCrf: -5 });
    expect(a.faceWeight).toBe(1);
    expect(a.fidelityWeight).toBe(0);
    expect(a.crf).toBe(51);
    expect(a.deblockCrf).toBe(0);
  });

  it('device 仅认 cpu,其余一律 mps', () => {
    expect(VP.normalizeVideoPost({ inputPath: '/x.mp4', device: 'cpu' }).device).toBe('cpu');
    expect(VP.normalizeVideoPost({ inputPath: '/x.mp4', device: 'gpu' as never }).device).toBe('mps');
  });

  it('deblock 仅显式 true 才开', () => {
    expect(VP.normalizeVideoPost({ inputPath: '/x.mp4', deblock: true }).deblock).toBe(true);
    expect(VP.normalizeVideoPost({ inputPath: '/x.mp4', deblock: false }).deblock).toBe(false);
    expect(VP.normalizeVideoPost({ inputPath: '/x.mp4' }).deblock).toBe(false);
  });
});

describe('planVideoPostStages — 阶段计划', () => {
  it('默认= 超分 → 修脸(去块关)', () => {
    const s = VP.planVideoPostStages(VP.normalizeVideoPost({ inputPath: '/x.mp4' }));
    expect(s).toHaveLength(2);
    expect(s[0]).toContain('Real-ESRGAN');
    expect(s[1]).toContain('GFPGAN');
  });

  it('开去块时去块排在最前(必须先于超分)', () => {
    const s = VP.planVideoPostStages(VP.normalizeVideoPost({ inputPath: '/x.mp4', deblock: true }));
    expect(s[0]).toContain('去块');
    expect(s[1]).toContain('Real-ESRGAN');
  });

  it('全关时报「仅重编码」而不是空数组', () => {
    const s = VP.planVideoPostStages(VP.normalizeVideoPost({ inputPath: '/x.mp4', superRes: 'none', faceModel: 'none' }));
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('仅重编码');
  });

  it('CodeFormer 用保真度措辞', () => {
    const s = VP.planVideoPostStages(VP.normalizeVideoPost({ inputPath: '/x.mp4', faceModel: 'codeformer', fidelityWeight: 0.9 }));
    expect(s.some((x) => x.includes('CodeFormer') && x.includes('0.9'))).toBe(true);
  });
});

describe('buildPostArgs / buildPostSpawn — PyTorch 统一管线命令行', () => {
  it('全开:传 -s / --sr / --face / 强度 / 设备 / crf', () => {
    const n = VP.normalizeVideoPost({ inputPath: '/x.mp4', scale: 2, faceModel: 'gfpgan', faceWeight: 0.3, crf: 16 });
    const args = VP.buildPostArgs('/in.mp4', '/out.mp4', n);
    expect(args[0]).toBe('/in.mp4');
    expect(args[args.indexOf('-o') + 1]).toBe('/out.mp4');
    expect(args[args.indexOf('-s') + 1]).toBe('2');
    expect(args[args.indexOf('--sr') + 1]).toBe('realesrgan-x4plus');
    expect(args[args.indexOf('--face') + 1]).toBe('gfpgan');
    expect(args[args.indexOf('--face-weight') + 1]).toBe('0.3');
    expect(args[args.indexOf('--device') + 1]).toBe('mps');
    expect(args[args.indexOf('--crf') + 1]).toBe('16');
  });

  it('⚠️ -s 是「最终总倍数」:已超分时不在参数里做二次放大(换算在脚本内)', () => {
    const n = VP.normalizeVideoPost({ inputPath: '/x.mp4', scale: 2 });
    const args = VP.buildPostArgs('/in.mp4', '/out.mp4', n);
    // 只传一次 -s 2;脚本内部让 RealESRGANer 输出 2x、修脸器 scale=1
    expect(args.filter((a) => a === '-s')).toHaveLength(1);
    expect(args[args.indexOf('-s') + 1]).toBe('2');
  });

  it('关超分:--sr none(仅修脸,方案 C)', () => {
    const n = VP.normalizeVideoPost({ inputPath: '/x.mp4', superRes: 'none', scale: 1 });
    const args = VP.buildPostArgs('/in.mp4', '/out.mp4', n);
    expect(args[args.indexOf('--sr') + 1]).toBe('none');
    expect(args[args.indexOf('--face') + 1]).toBe('gfpgan');
  });

  it('关修脸:--face none(仅超分)', () => {
    const n = VP.normalizeVideoPost({ inputPath: '/x.mp4', faceModel: 'none' });
    const args = VP.buildPostArgs('/in.mp4', '/out.mp4', n);
    expect(args[args.indexOf('--face') + 1]).toBe('none');
    // 不修脸时不该带修脸专用参数
    expect(args).not.toContain('--face-weight');
  });

  it('CodeFormer 传 --fidelity', () => {
    const n = VP.normalizeVideoPost({ inputPath: '/x.mp4', faceModel: 'codeformer', fidelityWeight: 0.9 });
    const args = VP.buildPostArgs('/in.mp4', '/out.mp4', n);
    expect(args[args.indexOf('--face') + 1]).toBe('codeformer');
    expect(args[args.indexOf('--fidelity') + 1]).toBe('0.9');
  });

  it('⚠️ 子进程 cwd 必须是 GFPGAN 根(facexlib 相对权重目录依赖它)', () => {
    const n = VP.normalizeVideoPost({ inputPath: '/x.mp4' });
    const sp = VP.buildPostSpawn('/in.mp4', '/out.mp4', n, {
      python: '/py', script: '/s.py', gfpganRoot: '/repo/GFPGAN',
    });
    expect(sp.cwd).toBe('/repo/GFPGAN');
    expect(sp.cmd).toBe('/py');
    expect(sp.args[0]).toBe('/s.py');
  });

  it('buildPostSpawn 与 buildPostArgs 一致(单一真源)', () => {
    const n = VP.normalizeVideoPost({ inputPath: '/x.mp4', scale: 3 });
    const direct = VP.buildPostArgs('/in.mp4', '/out.mp4', n);
    const sp = VP.buildPostSpawn('/in.mp4', '/out.mp4', n, { python: '/py', script: '/s.py', gfpganRoot: '/g' });
    expect(sp.args.slice(1)).toEqual(direct);
  });

  it('去块 filtergraph 用本机 ffmpeg 真实支持的选项(回归:flat-strength 在 ffmpeg 8.x 不存在)', () => {
    const vf = VP.buildDeblockVf();
    expect(vf).toContain('deblock=');
    expect(vf).toContain('filter=strong');
    expect(vf).toContain('block=4');
    expect(vf).not.toContain('flat-strength');
  });

  it('⚠️ 本机 ffmpeg 能真正解析该 filtergraph(不是靠字符串猜)', (ctx) => {
    if (!hasFfmpeg) return ctx.skip();
    const r = spawnSync('ffmpeg', [
      '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1',
      '-vf', VP.buildDeblockVf(), '-f', 'null', '-',
    ], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
  });
});

describe('超分权重文件映射(回归:模型短名 ≠ 权重文件名)', () => {
  it('realesrgan-x4plus → RealESRGAN_x4plus.pth', () => {
    expect(VP.SR_WEIGHT_FILES['realesrgan-x4plus']).toBe('RealESRGAN_x4plus.pth');
  });
  it('三个模型都有映射(脚本与主进程必须同口径)', () => {
    expect(Object.keys(VP.SR_WEIGHT_FILES).sort()).toEqual(
      ['realesr-animevideov3', 'realesrgan-x4plus', 'realesrgan-x4plus-anime'].sort(),
    );
  });
});

describe('parsePostProgress — 脚本进度行解析', () => {
  it('解析 PROGRESS <stage> <done> <total>', () => {
    expect(VP.parsePostProgress('PROGRESS superres 40 124')).toEqual({ stage: 'superres', done: 40, total: 124 });
    expect(VP.parsePostProgress('PROGRESS facefix 124 124')).toEqual({ stage: 'facefix', done: 124, total: 124 });
    expect(VP.parsePostProgress('  PROGRESS split 1 1  ')).toEqual({ stage: 'split', done: 1, total: 1 });
  });

  it('非进度行/非法值一律 null', () => {
    expect(VP.parsePostProgress('→ 拆帧: fps=24.0')).toBeNull();
    expect(VP.parsePostProgress('PROGRESS x 0 0')).toBeNull();
    expect(VP.parsePostProgress('PROGRESS x a b')).toBeNull();
    expect(VP.parsePostProgress('')).toBeNull();
  });

  it('阶段名有中文映射', () => {
    expect(VP.POST_STAGE_LABEL.superres).toBe('超分');
    expect(VP.POST_STAGE_LABEL.facefix).toBe('修脸');
    expect(VP.POST_STAGE_LABEL.merge).toBe('拼回');
  });
});

describe('estimateVideoPostSeconds — 耗时预估', () => {
  it('时长非法/为 0 时返回 0(不做无意义预估)', () => {
    const n = VP.normalizeVideoPost({ inputPath: '/x.mp4' });
    expect(VP.estimateVideoPostSeconds(0, 24, n)).toBe(0);
    expect(VP.estimateVideoPostSeconds(Number.NaN, 24, n)).toBe(0);
  });

  it('20s 片(24fps)+ 超分 + 修脸 ≈ 10-12 分钟量级', () => {
    const n = VP.normalizeVideoPost({ inputPath: '/x.mp4' });
    const s = VP.estimateVideoPostSeconds(20, 24, n);
    expect(s).toBeGreaterThan(600);
    expect(s).toBeLessThan(900);
  });

  it('只修脸比 超分+修脸 快;只超分最快', () => {
    const both = VP.estimateVideoPostSeconds(10, 24, VP.normalizeVideoPost({ inputPath: '/x.mp4' }));
    const faceOnly = VP.estimateVideoPostSeconds(10, 24, VP.normalizeVideoPost({ inputPath: '/x.mp4', superRes: 'none', scale: 1 }));
    const srOnly = VP.estimateVideoPostSeconds(10, 24, VP.normalizeVideoPost({ inputPath: '/x.mp4', faceModel: 'none' }));
    expect(faceOnly).toBeLessThan(both);
    expect(srOnly).toBeLessThan(faceOnly);
  });
});

describe('probeVideoPostTooling / checkToolingFor — 工具链探测与防呆', () => {
  it('探测结果结构完整(本机就绪与否都返回布尔,不抛异常)', () => {
    const t = VP.probeVideoPostTooling();
    expect(typeof t.realesrgan).toBe('boolean');
    expect(typeof t.faceFixScript).toBe('boolean');
    expect(typeof t.python).toBe('boolean');
    expect(Array.isArray(t.missing)).toBe(true);
  });

  it('缺后处理脚本时超分请求被拦下并给出指引', () => {
    const n = VP.normalizeVideoPost({ inputPath: '/x.mp4' });
    const fake = { ...VP.probeVideoPostTooling(), faceFixScript: false, python: true };
    const err = VP.checkToolingFor(n, fake);
    expect(err).toBeTruthy();
    expect(err).toContain('脚本未就绪');
  });

  it('缺 GFPGAN 权重时修脸请求被拦下', () => {
    const n = VP.normalizeVideoPost({ inputPath: '/x.mp4' });
    const fake = { ...VP.probeVideoPostTooling(), gfpganWeight: false };
    const err = VP.checkToolingFor(n, fake);
    expect(err).toBeTruthy();
    expect(err).toContain('GFPGAN');
  });

  it('缺 CodeFormer 权重时只拦 CodeFormer 请求', () => {
    const fake = { ...VP.probeVideoPostTooling(), codeformerWeight: false };
    expect(VP.checkToolingFor(VP.normalizeVideoPost({ inputPath: '/x.mp4', faceModel: 'codeformer' }), fake)).toBeTruthy();
    expect(VP.checkToolingFor(VP.normalizeVideoPost({ inputPath: '/x.mp4', faceModel: 'gfpgan' }), fake)).toBeNull();
  });

  it('完全不处理(不超分不修脸)时不要求任何工具', () => {
    const n = VP.normalizeVideoPost({ inputPath: '/x.mp4', superRes: 'none', scale: 1, faceModel: 'none' });
    const none = {
      realesrgan: false, faceFixScript: false, python: false,
      gfpganWeight: false, codeformerWeight: false, ffmpeg: false, missing: [],
    };
    expect(VP.checkToolingFor(n, none)).toBeNull();
  });
});

describe('ProgressTracker(进度换算单一真源)', () => {
  /** 造一个三段计划(去块/超分/修脸),权重与真实口径同形状 */
  const plan = [
    { kind: 'deblock' as const, label: '去块', weight: 10 },
    { kind: 'superres' as const, label: '超分', weight: 45 },
    { kind: 'facefix' as const, label: '修脸', weight: 45 },
  ];
  const total = plan.reduce((a, x) => a + x.weight, 0);
  const mk = () => {
    const seen: number[] = [];
    const t = new VP.ProgressTracker(plan, (p) => seen.push(p.overall), total);
    return { t, seen };
  };

  it('单调下界:任何来源都不能把 overall 往回拽', () => {
    const { t, seen } = mk();
    t.report({ stageLabel: '超分', overallHint: t.overallAt(1, 0.42) });
    t.report({ stageLabel: '超分', overallHint: t.overallAt(1, 0.1) }); // 阶段回环
    t.report({ stageLabel: '超分', overallHint: 0 }); // 心跳误算成 0
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(seen.at(-1)).toBeCloseTo(t.overallAt(1, 0.42), 6);
  });

  it('⚠️ 回归:心跳插进超分阶段中途不得回退到阶段前缀值(42% → 0% 事故)', () => {
    const { t, seen } = mk();
    const log: string[] = [];
    const push = (label: string, hint: number) => {
      t.report({ stageLabel: label, overallHint: hint });
      log.push(`${label} ${(seen.at(-1)! * 100).toFixed(0)}%`);
    };
    // 脚本报超分 42%
    push('超分 ×2', t.overallAt(1, 0.42));
    const afterScript = seen.at(-1)!;
    // 心跳(每 10s)只更新文案:按旧实现会用陈旧 stageIndex + 归零峰值重算 → 掉回前缀值
    t.report({ stageLabel: '超分 ×2', detail: '已 12s' });
    expect(seen.at(-1), `心跳把进度拽回: ${log.at(-1)} → ${(seen.at(-1)! * 100).toFixed(0)}%`).toBe(afterScript);
    // merge 这类无权重阶段同样不得倒退
    t.report({ stageLabel: '拼回', detail: '10/10' });
    expect(seen.at(-1)).toBe(afterScript);
    for (let i = 1; i < seen.length; i++) expect(seen[i], `回退: ${log[i - 1]} → ${log[i]}`).toBeGreaterThanOrEqual(seen[i - 1]!);
  });

  it('completeStage 推进索引后,新阶段从更高前缀起步(跨阶段不回退)', () => {
    const { t, seen } = mk();
    t.report({ stageLabel: '去块', overallHint: t.overallAt(0, 1) });
    const afterDeblock = seen.at(-1)!;
    t.completeStage();
    t.report({ stageLabel: '超分', overallHint: t.overallAt(t.currentStage, 0) });
    expect(seen.at(-1)).toBeGreaterThanOrEqual(afterDeblock);
  });

  it('finish 推到 1,且此前所有上报都压在 0.999', () => {
    const { t, seen } = mk();
    t.report({ stageLabel: '修脸', overallHint: t.overallAt(2, 1) });
    expect(seen.at(-1)!).toBeLessThanOrEqual(0.999);
    t.finish('完成', '收尾中…');
    expect(seen.at(-1)).toBe(1);
  });
});

describe('整体进度(回归:跨阶段必须单调不减)', () => {
  it('buildStagePlan:权重按耗时占比,修脸最重、去块最轻', () => {
    const n = VP.normalizeVideoPost({ inputPath: '/x.mp4', scale: 2, faceModel: 'gfpgan', deblock: true });
    // 用真实探测会依赖文件,这里只验证「全开时三个阶段都在」与相对关系(权重靠时长,零时长则吃下限)
    const plan = VP.buildStagePlan(n, '/nonexistent.mp4');
    expect(plan.map((p) => p.kind)).toEqual(['deblock', 'superres', 'facefix']);
    const w = (k: string) => plan.find((p) => p.kind === k)!.weight;
    expect(w('facefix')).toBeGreaterThan(w('superres'));
    expect(w('superres')).toBeGreaterThan(w('deblock'));
  });

  it('只修脸时不包含超分/去块阶段(阶段清单随开关变化)', () => {
    const n = VP.normalizeVideoPost({ inputPath: '/x.mp4', scale: 1, superRes: 'none', faceModel: 'gfpgan' });
    const plan = VP.buildStagePlan(n, '/nonexistent.mp4');
    expect(plan.map((p) => p.kind)).toEqual(['facefix']);
  });

  it('⚠️ 真实跑:overall 单调不减且终值 1(防「拼回」把 96% 拽回 27%)', async (ctx) => {
    if (!hasFfmpeg || !srcVideo) return ctx.skip();
    const seen: number[] = [];
    const log: string[] = [];
    const r = await VP.videoUpscale(
      { inputPath: srcVideo, scale: 2, faceModel: 'none', nodeId: 'n1' },
      { onProgress: (p) => { seen.push(p.overall); log.push(`${p.stageLabel} ${(p.overall * 100).toFixed(0)}%`); } },
    );
    expect(r.ok, r.error).toBe(true);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i], `进度回退: ${log[i - 1]} → ${log[i]}`).toBeGreaterThanOrEqual(seen[i - 1]!);
    }
    expect(seen.at(-1)).toBe(1);
    expect(seen.every((v) => v >= 0 && v <= 1)).toBe(true);
  }, 180_000);
});

describe('运行态真源(防「退出画布再进入后可重复发起」)', () => {
  it('初始无运行任务', () => {
    expect(VP.listRunningVideoPost()).toEqual([]);
  });

  it('⚠️ 运行中可由主进程查到该 nodeId;结束后自动注销', async (ctx) => {
    if (!hasFfmpeg || !srcVideo) return ctx.skip();
    const p = VP.videoUpscale({ inputPath: srcVideo, scale: 2, faceModel: 'none', nodeId: 'node-A' });
    // 模拟"退出画布再进入"后查询主进程:应能查到
    await new Promise((r) => setTimeout(r, 1200));
    expect(VP.listRunningVideoPost().map((r) => r.nodeId)).toContain('node-A');
    const r = await p;
    expect(r.ok, r.error).toBe(true);
    expect(VP.listRunningVideoPost()).toEqual([]);
  }, 240_000);

  it('失败路径也会注销(否则节点永久无法重新发起)', async () => {
    const r = await VP.videoUpscale({ inputPath: '/nonexistent.mp4', nodeId: 'node-B' });
    expect(r.ok).toBe(false);
    expect(VP.listRunningVideoPost()).toEqual([]);
  });
});

describe('videoUpscale — 输入校验(不依赖工具链)', () => {
  it('空路径报错', async () => {
    const r = await VP.videoUpscale({ inputPath: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('路径为空');
  });

  it('文件不存在报错', async () => {
    const r = await VP.videoUpscale({ inputPath: join(outDir, 'nope.mp4') });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不存在');
  });

  it('目录外文件被拒(防任意读)', async () => {
    // /etc/hosts 存在但不在允许目录内
    const r = await VP.videoUpscale({ inputPath: '/etc/hosts' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/不在允许目录|不存在/);
  });
});

describe('进度解析 —— 长任务必须有可见反馈(真实反馈回归)', () => {
  it('parseFaceFixProgress:解析脚本的 [idx/total]', () => {
    expect(VP.parseFaceFixProgress('  [40/124]')).toEqual({ done: 40, total: 124 });
    expect(VP.parseFaceFixProgress('  [124/124]')).toEqual({ done: 124, total: 124 });
  });

  it('parseFaceFixProgress:非进度行/非法值一律 null(不误报)', () => {
    expect(VP.parseFaceFixProgress('→ 拆帧: fps=24.000')).toBeNull();
    expect(VP.parseFaceFixProgress('[0/0]')).toBeNull();
    expect(VP.parseFaceFixProgress('[a/b]')).toBeNull();
    expect(VP.parseFaceFixProgress('')).toBeNull();
  });

  it('parseFaceFixStage:识别拆帧/加载模型/拼回', () => {
    expect(VP.parseFaceFixStage('→ 拆帧: fps=24.000, work=/tmp/x')).toBe('拆帧中…');
    expect(VP.parseFaceFixStage('→ 修脸: model=gfpgan, device=mps, upscale=1')).toBe('加载模型…');
    expect(VP.parseFaceFixStage('→ 拼回: /out.mp4')).toBe('拼回视频…');
    expect(VP.parseFaceFixStage('  [40/124]')).toBeNull();
  });

  it('fmtDur:秒/min 人读(进度文案用)', () => {
    expect(VP.fmtDur(0)).toBe('0s');
    expect(VP.fmtDur(45)).toBe('45s');
    expect(VP.fmtDur(60)).toBe('1min');
    expect(VP.fmtDur(110)).toBe('1min50s');
  });
});

describe('facexlib 权重 / cwd —— 防「联网重下卡死」回归', () => {
  it('facexlibWeightsDir 指向 <gfpganRoot>/gfpgan/weights(GFPGAN 的相对 model_rootpath)', () => {
    expect(VP.facexlibWeightsDir('/repo/GFPGAN')).toBe('/repo/GFPGAN/gfpgan/weights');
  });

  it('missingFacexlibWeights:目标已有 → 无需补齐', () => {
    const missing = VP.missingFacexlibWeights({
      gfpganRoot: '/g',
      weightsDir: '/w',
      exists: () => true,
    });
    expect(missing).toHaveLength(0);
  });

  it('missingFacexlibWeights:目标缺失但 weightsDir 有 → 给出可拷贝来源', () => {
    const missing = VP.missingFacexlibWeights({
      gfpganRoot: '/g',
      weightsDir: '/w',
      // 只让 /w 下的文件存在(模拟权重放在 ~/ai/weights 但没放进 GFPGAN)
      exists: (p) => p.startsWith('/w/'),
    });
    expect(missing).toHaveLength(2);
    expect(missing.map((m) => m.file).sort()).toEqual(['detection_Resnet50_Final.pth', 'parsing_parsenet.pth']);
    expect(missing[0]!.to.startsWith('/g/gfpgan/weights/')).toBe(true);
    expect(missing[0]!.from.startsWith('/w/')).toBe(true);
  });

  it('missingFacexlibWeights:两边都没有 → 空(交给运行期联网下载/报错)', () => {
    const missing = VP.missingFacexlibWeights({ gfpganRoot: '/g', weightsDir: '/w', exists: () => false });
    expect(missing).toHaveLength(0);
  });

  it('⚠️ 后处理子进程的 cwd 必须是 GFPGAN 根(否则 facexlib 会联网重下 100MB+)', () => {
    const n = VP.normalizeVideoPost({ inputPath: '/x.mp4' });
    const sp = VP.buildPostSpawn('/in.mp4', '/out.mp4', n, {
      python: '/py', script: '/script.py', gfpganRoot: '/repo/GFPGAN',
    });
    expect(sp.cwd).toBe('/repo/GFPGAN');
    expect(sp.cmd).toBe('/py');
    expect(sp.args[0]).toBe('/script.py');
    expect(sp.args).toContain('/in.mp4');
    expect(sp.args[sp.args.indexOf('-o') + 1]).toBe('/out.mp4');
  });
});

describe('videoPostTarget — 输出路径推断', () => {
  it('用输入基名 + -post- 后缀 + .mp4', () => {
    const p = VP.videoPostTarget('/a/b/clip.mp4', undefined, 1234);
    expect(p.endsWith('clip-post-1234.mp4')).toBe(true);
  });

  it('outputName 覆盖基名;路径分隔符被清洗(防目录穿越)', () => {
    const p = VP.videoPostTarget('/a/b/clip.mp4', '../../evil', 1);
    expect(p.endsWith('.._.._evil-post-1.mp4')).toBe(true);
  });
});

/**
 * 集成:真实跑 Real-ESRGAN ×2(64x64 → 128x128,单帧视频,秒级完成)。
 * 工具链缺失时跳过(不阻塞 CI;本机已装则真实校验端到端出片)。
 * 注意:探测必须放在 beforeAll 之后(模块级常量在 import 时求值,模块级探测拿不到 VP)。
 */
let srReady = false;

describe('videoUpscale — Real-ESRGAN 端到端(真实工具链)', () => {
  beforeAll(() => {
    srReady = !!VP.probeVideoPostTooling().realesrgan;
  });

  it('超分 ×2 出片:产物存在、可探测、分辨率翻倍', async (ctx) => {
    if (!hasFfmpeg || !srcVideo || !srReady) return ctx.skip();
    const r = await VP.videoUpscale({ inputPath: srcVideo, scale: 2, faceModel: 'none' });
    expect(r.ok, r.error).toBe(true);
    expect(existsSync(r.path as string)).toBe(true);
    expect(statSync(r.path as string).size).toBeGreaterThan(0);
    // 阶段摘要现在标注引擎(PyTorch 版)
    expect(r.stages?.some((s) => s.includes('超分'))).toBe(true);
    expect(r.stages?.some((s) => s.includes('PyTorch'))).toBe(true);
    // 64 → 128(Real-ESRGAN 2x)
    expect(r.width).toBe(128);
    expect(r.height).toBe(128);
  }, 120_000);
});
