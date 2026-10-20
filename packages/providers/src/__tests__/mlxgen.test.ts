/**
 * mlxgen Provider 测试 — dry-run 下命令构造(不 spawn、不推理)
 * 覆盖:generate / upscale / edit(instruction·inpaint)三种 kind 分支;槽位校验;dry-run 状态语义
 */
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MlXGenProvider } from '../mlxgen.js';
import type { RenderRequest } from '@bigbotart/shared';

/** 构造 provider(dry-run 默认 true → submit 只登记命令,不 spawn) */
const makeProvider = () => new MlXGenProvider({ dryRun: true });

/** 读最近一次构造的命令(dry-run 也构造,便于调试) */
const lastCmd = (p: MlXGenProvider): string[] =>
  (p as unknown as { lastCmd: string[] }).lastCmd ?? [];

const req = (kind: string, params: Record<string, unknown> = {}): RenderRequest =>
  ({ provider: 'mlxgen', nodeId: 'n1', slot: 'image', params: { kind, model: 'm/z-8bit', ...params } }) as RenderRequest;

describe('submit · 槽位校验', () => {
  it('slot !== image 抛错(mock 防呆)', async () => {
    const p = makeProvider();
    await expect(p.submit({ ...req('generate'), slot: 'video' } as RenderRequest)).rejects.toThrow('仅支持图片任务');
  });
});

describe('submit · generate 参考图(多参考生成)', () => {
  const refs = (paths: string[]) =>
    paths.map((p) => ({
      asset: { id: `ref:${p}`, kind: 'image' as const, name: p, localPath: p, tags: [], createdAt: '' },
      role: 'ref-image',
      localPath: p,
    }));

  it('klein 模型 + ref-image references → --i2i-mode multi-reference + 逐张 --image', async () => {
    const p = makeProvider();
    await p.submit({
      ...req('generate', { model: 'AbstractFramework/flux.2-klein-9b-8bit', prompt: '角色展示图' }),
      references: refs(['/lib/r1.png', '/lib/r2.png']),
    });
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--i2i-mode') + 1]).toBe('multi-reference');
    const imgs = cmd.map((c, i) => (c === '--image' ? cmd[i + 1] : null)).filter(Boolean);
    expect(imgs).toEqual(['/lib/r1.png', '/lib/r2.png']);
  });

  it('z-image-turbo(纯文生图)带参考图 → 明确报错指引换模型', async () => {
    const p = makeProvider();
    await expect(
      p.submit({ ...req('generate', { model: 'AbstractFramework/z-image-turbo-8bit' }), references: refs(['/lib/r1.png']) }),
    ).rejects.toThrow('多参考模型');
  });

  // 真实事故(2026-09):klein 带参考图 exit 2 —— `--image` 是 mlx-gen 路由器入口参数,
  // 后端只认 `--image-path`(单图)/ `--image-paths`(多图),路由器靠 `--i2i-mode` 决定改写成哪个。
  // 图片数与 i2i-mode 不匹配时改写链断裂,`--image` 原样透传给裸 `mflux-generate-flux2`,
  // argparse 报 "ambiguous option: --image could match --image-path, --image-strength"。
  // 故单图必须显式 `edit`,不能沿用 multi-reference(那是 min_images=2 的能力行)。
  it('klein 模型 + 单张 ref-image → --i2i-mode edit(不误用 multi-reference)', async () => {
    const p = makeProvider();
    await p.submit({
      ...req('generate', { model: 'AbstractFramework/flux.2-klein-9b-8bit', prompt: '换个背景' }),
      references: refs(['/lib/only.png']),
    });
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--i2i-mode') + 1]).toBe('edit');
    const imgs = cmd.map((c, i) => (c === '--image' ? cmd[i + 1] : null)).filter(Boolean);
    expect(imgs).toEqual(['/lib/only.png']);
  });

  it('带参考图时始终显式声明 --i2i-mode(不留给 CLI auto 推断)', async () => {
    for (const paths of [['/lib/a.png'], ['/lib/a.png', '/lib/b.png']]) {
      const pp = makeProvider();
      await pp.submit({
        ...req('generate', { model: 'AbstractFramework/flux.2-klein-9b-8bit', prompt: 'x' }),
        references: refs(paths),
      });
      expect(lastCmd(pp)).toContain('--i2i-mode');
    }
  });

  it('无参考图 → 不带 --i2i-mode/--image(纯文生图不变)', async () => {
    const p = makeProvider();
    await p.submit(req('generate', { prompt: '晨雾森林' }));
    const cmd = lastCmd(p);
    expect(cmd).not.toContain('--i2i-mode');
    expect(cmd).not.toContain('--image');
  });
});
describe('submit · generate 参考图 · Qwen-Image-2.1(缺陷 D,2026-09-29)', () => {
  const refs = (paths: string[]) =>
    paths.map((p) => ({
      asset: { id: `ref:${p}`, kind: 'image' as const, name: p, localPath: p, tags: [], createdAt: '' },
      role: 'ref-image',
      localPath: p,
    }));

  it('2.1 + 2 张参考图 → --i2i-mode edit + --image-paths(不是 multi-reference;2.1 没有该 handler)', async () => {
    const p = makeProvider();
    await p.submit({
      ...req('generate', { model: 'Qwen/Qwen-Image-2.1', prompt: '角色展示图' }),
      references: refs(['/lib/r1.png', '/lib/r2.png']),
    });
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--i2i-mode') + 1]).toBe('edit');
    const ip = cmd.indexOf('--image-paths');
    expect(ip).toBeGreaterThan(-1);
    expect(cmd.slice(ip + 1, ip + 3)).toEqual(['/lib/r1.png', '/lib/r2.png']);
    // 2.1 参数面不用逐张 --image(klein 的写法)
    expect(cmd).not.toContain('--image');
  });

  it('2.1 + 单张参考图 → 同样 --image-paths(参数面一致,不因数量切换写法)', async () => {
    const p = makeProvider();
    await p.submit({
      ...req('generate', { model: 'Qwen/Qwen-Image-2.1', prompt: '换风格' }),
      references: refs(['/lib/only.png']),
    });
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--i2i-mode') + 1]).toBe('edit');
    expect(cmd.slice(cmd.indexOf('--image-paths') + 1, cmd.indexOf('--image-paths') + 2)).toEqual(['/lib/only.png']);
  });

  it('2.1 + 11 张参考图 → 提交前拦截(上限 10),建议换 klein', async () => {
    const p = makeProvider();
    const many = Array.from({ length: 11 }, (_, i) => `/lib/r${i}.png`);
    await expect(
      p.submit({ ...req('generate', { model: 'Qwen/Qwen-Image-2.1' }), references: refs(many) }),
    ).rejects.toThrow('最多支持 10 张');
  });

  it('2.1 本地目录路径 + 参考图 → 同口径(isQwen21EditModel 按 checkpoint 判,不认路径形式)', async () => {
    const p = makeProvider();
    await p.submit({
      ...req('generate', { model: 'Qwen-Image-2.1-bf16', prompt: 'x' }),
      references: refs(['/lib/a.png', '/lib/b.png']),
    });
    expect(lastCmd(p)[lastCmd(p).indexOf('--i2i-mode') + 1]).toBe('edit');
  });
});

describe('submit · generate(文生图)', () => {
  it('命令以 generate 开头,含模型/提示词/宽高/步数/引导/输出', async () => {
    const p = makeProvider();
    await p.submit(req('generate', { prompt: '晨雾森林', width: 768, height: 768, steps: 24, guidance: 1.0, seeds: [42, 43] }));
    const cmd = lastCmd(p);
    expect(cmd[0]).toBe('generate');
    expect(cmd).toContain('--model');
    expect(cmd[cmd.indexOf('--model') + 1]).toBe('m/z-8bit');
    expect(cmd).toContain('--prompt');
    expect(cmd[cmd.indexOf('--prompt') + 1]).toBe('晨雾森林');
    expect(cmd).toContain('--width');
    expect(cmd[cmd.indexOf('--width') + 1]).toBe('768');
    expect(cmd).toContain('--seed');
    expect(cmd).toContain('--output');
    expect(cmd[cmd.indexOf('--output') + 1]!).toMatch(/\.png$/);
  });

  it('命令带 --json-events(真实跑时 stdout 输出 JSONL 进度事件,Provider 解析供 status() 上报)', async () => {
    const p = makeProvider();
    await p.submit(req('generate', { prompt: '晨雾森林' }));
    expect(lastCmd(p)).toContain('--json-events');
  });

  it('upscale / edit 路由同样带 --json-events', async () => {
    const p = makeProvider();
    await p.submit(req('upscale', { inputPath: '/tmp/a.png', scale: '2x' }));
    expect(lastCmd(p)).toContain('--json-events');
    await p.submit(req('instruction', { prompt: '改站姿', inputPath: '/tmp/a.png' }));
    expect(lastCmd(p)).toContain('--json-events');
  });

  it('多 seed 批量:--seed 展开为独立参数(单 token 会被后端 int 解析拒绝)', async () => {
    const p = makeProvider();
    await p.submit(req('generate', { seeds: [1, 2, 3] }));
    const cmd = lastCmd(p);
    const idx = cmd.indexOf('--seed');
    expect(idx).toBeGreaterThan(-1);
    expect(cmd.slice(idx, idx + 4)).toEqual(['--seed', '1', '2', '3']);
  });

  it('多 seed:登记的产物路径 = 官方命名 outBase_seed_<第一个seed>.png', async () => {
    const p = makeProvider();
    const h = await p.submit(req('generate', { seeds: [101, 202] }));
    const st = await p.status(h);
    expect(st.resultPath).toMatch(/_seed_101\.png$/);
  });

  it('kind 缺省视为 generate', async () => {
    const p = makeProvider();
    await p.submit(req('generate', {}));
    expect(lastCmd(p)[0]).toBe('generate');
  });

  it('negativePrompt 非空时拼 --negative-prompt', async () => {
    const p = makeProvider();
    await p.submit(req('generate', { prompt: 'x', negativePrompt: '模糊,水印' }));
    const cmd = lastCmd(p);
    expect(cmd).toContain('--negative-prompt');
    expect(cmd[cmd.indexOf('--negative-prompt') + 1]).toBe('模糊,水印');
  });
});

describe('submit · upscale(超分)', () => {
  it('命令首参 upscale,含 --image-path/--resolution/--output,且不含 --prompt', async () => {
    const p = makeProvider();
    await p.submit(req('upscale', { inputPath: '/tmp/in.png', scale: '2x' }));
    const cmd = lastCmd(p);
    expect(cmd[0]).toBe('upscale');
    expect(cmd).not.toContain('--prompt');
    expect(cmd).toContain('--image-path');
    expect(cmd[cmd.indexOf('--image-path') + 1]).toBe('/tmp/in.png');
    expect(cmd).toContain('--resolution');
    expect(cmd[cmd.indexOf('--resolution') + 1]).toBe('2x');
  });

  it('数字 scale(2/4)→ 缩放因子 2x/4x(裸整数会被 CLI 当作短边像素)', async () => {
    const p = makeProvider();
    await p.submit(req('upscale', { inputPath: '/tmp/in.png', scale: 2 }));
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--resolution') + 1]).toBe('2x');
  });
});

describe('submit · edit(编辑四模式)', () => {
  it('自定义量化仓库追加 --base-model 提示(8bit 编辑模型 → qwen.edit handler)', async () => {
    const p = makeProvider();
    await p.submit(req('instruction', { prompt: '换背景', inputPath: '/tmp/in.png', model: 'mlx-community/Qwen-Image-Edit-8bit' }));
    const cmd = lastCmd(p);
    expect(cmd).toContain('--base-model');
    expect(cmd[cmd.indexOf('--base-model') + 1]).toBe('Qwen/Qwen-Image-Edit');
  });

  it('普通仓库不带 --base-model', async () => {
    const p = makeProvider();
    await p.submit(req('instruction', { prompt: '换背景', inputPath: '/tmp/in.png' }));
    expect(lastCmd(p)).not.toContain('--base-model');
  });

  it('instruction:带 --image-path 与 --output(generate 路由)', async () => {
    const p = makeProvider();
    await p.submit(req('instruction', { prompt: '换背景', inputPath: '/tmp/in.png' }));
    const cmd = lastCmd(p);
    expect(cmd[0]).toBe('generate');
    expect(cmd).toContain('--image-path');
    expect(cmd[cmd.indexOf('--image-path') + 1]).toBe('/tmp/in.png');
  });

  it('编辑显式给 steps → 传 --steps(此前编辑完全不传,质量被固定在模型默认 4 步)', async () => {
    const p = makeProvider();
    await p.submit(req('instruction', { prompt: '去掉水印', inputPath: '/tmp/in.png', steps: 12 }));
    const cmd = lastCmd(p);
    expect(cmd).toContain('--steps');
    expect(cmd[cmd.indexOf('--steps') + 1]).toBe('12');
  });

  it('编辑未给 steps → 不传 --steps(交由 mlxgen 用模型默认,存量节点行为不变)', async () => {
    const p = makeProvider();
    await p.submit(req('instruction', { prompt: '去掉水印', inputPath: '/tmp/in.png' }));
    expect(lastCmd(p)).not.toContain('--steps');
  });

  it('img2img / outpaint 同样支持显式 steps(各编辑模式口径一致)', async () => {
    const p = makeProvider();
    await p.submit(req('img2img', { prompt: '改写风格', inputPath: '/tmp/in.png', steps: 8 }));
    let cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--steps') + 1]).toBe('8');

    const p2 = makeProvider();
    await p2.submit(req('outpaint', {
      prompt: '扩图', inputPath: '/tmp/in.png', steps: 20,
      outpaintSides: { top: 10, right: 10, bottom: 10, left: 10 },
    }));
    cmd = lastCmd(p2);
    expect(cmd[cmd.indexOf('--steps') + 1]).toBe('20');
  });

  it('img2img:带 --i2i-mode latent(否则被路由成指令编辑)', async () => {
    const p = makeProvider();
    await p.submit(req('img2img', { prompt: '改写风格', inputPath: '/tmp/in.png' }));
    const cmd = lastCmd(p);
    expect(cmd).toContain('--i2i-mode');
    expect(cmd[cmd.indexOf('--i2i-mode') + 1]).toBe('latent');
  });

  it('img2img:--image-strength 必填(latent 路由缺省报错),未设/0/越界回退 0.5,合法值透传', async () => {
    const p = makeProvider();
    await p.submit(req('img2img', { prompt: '改写风格', inputPath: '/tmp/in.png', imageStrength: 0.45 }));
    let cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--image-strength') + 1]).toBe('0.45');
    // 未设置 → 默认 0.5(实测:latent 模式不带 --image-strength 会 exit 2 "is required")
    const p0 = makeProvider();
    await p0.submit(req('img2img', { prompt: '改写风格', inputPath: '/tmp/in.png', imageStrength: 0 }));
    cmd = lastCmd(p0);
    expect(cmd[cmd.indexOf('--image-strength') + 1]).toBe('0.50');
    const pUndef = makeProvider();
    await pUndef.submit(req('img2img', { prompt: '改写风格', inputPath: '/tmp/in.png' }));
    cmd = lastCmd(pUndef);
    expect(cmd[cmd.indexOf('--image-strength') + 1]).toBe('0.50');
  });


  it('img2img + Qwen-Image-2.1:放行(缺陷 A 修复;2.1 实测有 qwen21.latent,BASE_MODEL_HINTS 成员资格不再当能力判定)', async () => {
    const p = makeProvider();
    await p.submit(req('img2img', { prompt: '改写风格', inputPath: '/tmp/in.png', model: 'Qwen/Qwen-Image-2.1' }));
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--i2i-mode') + 1]).toBe('latent');
    expect(cmd).toContain('--image-strength');
  });

  it('img2img + 2.1 本地目录标识:同样放行(同模型两种写法一致)', async () => {
    const p = makeProvider();
    await p.submit(req('img2img', { prompt: '改写风格', inputPath: '/tmp/in.png', model: 'Qwen-Image-2.1-bf16' }));
    expect(lastCmd(p)[lastCmd(p).indexOf('--i2i-mode') + 1]).toBe('latent');
  });
  it('img2img + Qwen Image Edit 模型:提交前拒绝(mlxgen exit 2 防呆),提示换 Z-Image Turbo', async () => {
    const p = makeProvider();
    await expect(
      p.submit(req('img2img', { prompt: '改写风格', inputPath: '/tmp/in.png', model: 'mlx-community/Qwen-Image-Edit-8bit' })),
    ).rejects.toThrow(/latent I2I.*z-image-turbo/s);
    // instruction 模式不受影响(Qwen Edit 的主场)
    const p2 = makeProvider();
    await expect(
      p2.submit(req('instruction', { prompt: '换背景', inputPath: '/tmp/in.png', model: 'mlx-community/Qwen-Image-Edit-8bit' })),
    ).resolves.toBeTruthy();
  });

  it('短别名 qwen-image-edit 归一化为 8bit 社区仓库(全量 57.7GB 未下载会 exit 1),并补 --base-model', async () => {
    const p = makeProvider();
    await p.submit(req('instruction', { prompt: '换背景', inputPath: '/tmp/in.png', model: 'qwen-image-edit' }));
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--model') + 1]).toBe('mlx-community/Qwen-Image-Edit-8bit');
    expect(cmd[cmd.indexOf('--base-model') + 1]).toBe('Qwen/Qwen-Image-Edit');
  });

  it('inpaint:额外带 --mask-path', async () => {
    const p = makeProvider();
    await p.submit(req('inpaint', { prompt: '只改左半', inputPath: '/tmp/in.png', maskPath: '/tmp/mask.png' }));
    const cmd = lastCmd(p);
    expect(cmd).toContain('--mask-path');
    expect(cmd[cmd.indexOf('--mask-path') + 1]).toBe('/tmp/mask.png');
  });

  it('outpaint:outpaintSides 映射为 --outpaint-padding top,right,bottom,left', async () => {
    const p = makeProvider();
    await p.submit(
      req('outpaint', {
        prompt: '向四周扩图',
        inputPath: '/tmp/in.png',
        outpaintSides: { top: 0, bottom: 10, left: 20, right: 0 },
      }),
    );
    const cmd = lastCmd(p);
    expect(cmd).toContain('--outpaint-padding');
    expect(cmd[cmd.indexOf('--outpaint-padding') + 1]).toBe('0,0,10,20');
  });
});

describe('status · dry-run 语义', () => {
  it('dry-run 提交后状态 SUCCEEDED,含 dry-run 说明与登记产物路径', async () => {
    const p = makeProvider();
    const h = await p.submit(req('generate', { width: 768, height: 768 }));
    const st = await p.status(h);
    expect(st.status).toBe('SUCCEEDED');
    expect(st.stage).toContain('dry-run');
    expect(st.resultPath).toMatch(/\.png$/);
  });
});

describe('check · 未安装 mlxgen 场景', () => {
  const hasMlxgen = (() => {
    try {
      execFileSync('sh', ['-lc', 'command -v mlxgen'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  // 仅在本机确实未安装 mlxgen 时断言(装了就跳过,避免假阴性)
  describe.skipIf(hasMlxgen)('本机未装 mlxgen', () => {
    it('check() 返回 installed=false + 安装提示', async () => {
      const p = makeProvider();
      const st = await p.check();
      expect(st.installed).toBe(false);
      expect(st.ready).toBe(false);
      expect(st.installHint).toContain('uv tool install');
    });
  });

  afterEach(() => vi.restoreAllMocks());
});
describe('submit · 默认模型按 kind 分派', () => {
  // req() 辅助函数固定注入 model,这里需要「未指定模型」的场景,单独构造
  const reqNoModel = (kind: string, params: Record<string, unknown> = {}): RenderRequest =>
    ({ provider: 'mlxgen', nodeId: 'n1', slot: 'image', params: { kind, ...params } }) as RenderRequest;

  it('instruction(指令编辑)缺省模型 → Qwen-Image-Edit-8bit(而非 z-image 文生图)', async () => {
    const p = makeProvider();
    await p.submit(reqNoModel('instruction', { prompt: '去文字', inputPath: '/tmp/a.png' }));
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--model') + 1]).toBe('mlx-community/Qwen-Image-Edit-8bit');
    expect(cmd[cmd.indexOf('--image-path') + 1]).toBe('/tmp/a.png');
  });

  it('upscale 缺省模型 → SeedVR2;generate 缺省 → z-image-turbo', async () => {
    const p = makeProvider();
    await p.submit(reqNoModel('upscale', { inputPath: '/tmp/a.png', scale: '2x' }));
    expect(lastCmd(p)[lastCmd(p).indexOf('--model') + 1]).toBe('AbstractFramework/seedvr2-3b-8bit');
    await p.submit(reqNoModel('generate', { prompt: 'x' }));
    expect(lastCmd(p)[lastCmd(p).indexOf('--model') + 1]).toBe('AbstractFramework/z-image-turbo-8bit');
  });

  it('显式给模型时不受默认分派影响', async () => {
    // 隔离本机真实 ~/ai/models:本机已下载 flux2-klein-9b-8bit,不隔离会命中本地目录,
    // 断言到的就是路径而非 repoId(与 Qwen-2.1 组同因,见下方「本地模型目录直用」组)
    const prev = process.env.BIGBOTART_MODELS_DIR;
    process.env.BIGBOTART_MODELS_DIR = join(tmpdir(), `bbart-mlxiso-klein-${process.pid}`);
    try {
      const p = makeProvider();
      await p.submit(req('instruction', { prompt: 'x', inputPath: '/tmp/a.png', model: 'AbstractFramework/flux.2-klein-9b-8bit' }));
      expect(lastCmd(p)[lastCmd(p).indexOf('--model') + 1]).toBe('AbstractFramework/flux.2-klein-9b-8bit');
    } finally {
      if (prev === undefined) delete process.env.BIGBOTART_MODELS_DIR;
      else process.env.BIGBOTART_MODELS_DIR = prev;
    }
  });
});

describe('submit · Qwen-Image-2.1(bf16 全量)', () => {
  const Q21 = 'Qwen/Qwen-Image-2.1';
  // 整组隔离本机真实 ~/ai/models:否则命中本地目录,断言的是路径而非 repoId(本机已有该模型)
  beforeAll(() => {
    process.env.BIGBOTART_MODELS_DIR = join(tmpdir(), `bbart-mlxiso-${process.pid}`);
  });
  afterAll(() => {
    delete process.env.BIGBOTART_MODELS_DIR;
  });

  it('全名仓库追加 --base-model 提示(否则被家族兜底误路由成旧 Qwen Image)', async () => {
    const p = makeProvider();
    await p.submit(req('generate', { prompt: '雪山日出', model: Q21 }));
    const cmd = lastCmd(p);
    expect(cmd).toContain('--base-model');
    expect(cmd[cmd.indexOf('--base-model') + 1]).toBe('qwen-image-2.1');
  });

  it('短别名 qwen-image-2.1 归一化到 bf16 全量(2026-09-28 收敛:原指向 8bit 已移除)', async () => {
    const p = makeProvider();
    await p.submit(req('generate', { prompt: '雪山日出', model: 'qwen-image-2.1' }));
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--model') + 1]).toBe(Q21);
    expect(cmd[cmd.indexOf('--base-model') + 1]).toBe('qwen-image-2.1');
  });

  it('其余短别名(qwen-2.1 / qwen-image-21)同样归一化到 bf16', async () => {
    for (const alias of ['qwen-2.1', 'qwen-image-21']) {
      const p = makeProvider();
      await p.submit(req('generate', { prompt: '雪山日出', model: alias }));
      expect(lastCmd(p)[lastCmd(p).indexOf('--model') + 1]).toBe(Q21);
    }
  });

  it('已移除的 8bit 仓库名仍能路由:--base-model 提示不丢、40 步默认不回落', async () => {
    // 防御:老项目文件/老节点里可能还存着 8bit 仓库名。它不该炸,也不该静默换语义
    const p = makeProvider();
    await p.submit(req('generate', { prompt: 'x', model: 'JoyFusionAI/Qwen-Image-2.1-MLX-8bit' }));
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--base-model') + 1]).toBe('qwen-image-2.1');
    expect(cmd[cmd.indexOf('--steps') + 1]).toBe('40');
  });

  it('缺省 40 步(官方推荐),未被通用 24 步覆盖', async () => {
    const p = makeProvider();
    await p.submit(req('generate', { prompt: '雪山日出', model: Q21 }));
    expect(lastCmd(p)[lastCmd(p).indexOf('--steps') + 1]).toBe('40');
  });

  it('显式传 steps 时优先于 40 步默认', async () => {
    const p = makeProvider();
    await p.submit(req('generate', { prompt: '雪山日出', model: Q21, steps: 12 }));
    expect(lastCmd(p)[lastCmd(p).indexOf('--steps') + 1]).toBe('12');
  });

  it('非 2.1 模型仍保持 24 步默认(不误伤其他模型)', async () => {
    const p = makeProvider();
    await p.submit(req('generate', { prompt: 'x', model: 'AbstractFramework/z-image-turbo-8bit' }));
    expect(lastCmd(p)[lastCmd(p).indexOf('--steps') + 1]).toBe('24');
  });
});

describe('submit · 本地模型目录直用(免下载)', () => {
  const Q21 = 'Qwen/Qwen-Image-2.1';
  const root = join(tmpdir(), `bbart-mlxlocal-${process.pid}`);

  beforeAll(() => {
    process.env.BIGBOTART_MODELS_DIR = root;
    mkdirSync(join(root, 'Qwen-Image-2.1-bf16', 'transformer'), { recursive: true });
    writeFileSync(join(root, 'Qwen-Image-2.1-bf16', 'transformer', '0.safetensors'), 'w');
  });
  afterAll(() => {
    delete process.env.BIGBOTART_MODELS_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it('本地有就绪目录时 --model 用本地路径(不再走 repoId 下载)', async () => {
    const p = makeProvider();
    await p.submit(req('generate', { prompt: '雪山日出', model: Q21 }));
    const cmd = lastCmd(p);
    const m = cmd[cmd.indexOf('--model') + 1];
    expect(m).toBe(join(root, 'Qwen-Image-2.1-bf16'));
  });

  it('走本地路径时仍带 --base-model 路由提示(否则被家族兜底误路由)', async () => {
    const p = makeProvider();
    await p.submit(req('generate', { prompt: '雪山日出', model: Q21 }));
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--base-model') + 1]).toBe('qwen-image-2.1');
  });

  it('走本地路径时 40 步默认仍生效(按 repoId 判,不按路径)', async () => {
    const p = makeProvider();
    await p.submit(req('generate', { prompt: '雪山日出', model: Q21 }));
    expect(lastCmd(p)[lastCmd(p).indexOf('--steps') + 1]).toBe('40');
  });

  it('本地目录缺权重分片(只建了空 transformer/)→ 不认作就绪,回退 repoId', async () => {
    // 隔离到只含「空 transformer」的根:目录存在但无权重,应回退 repoId 而非误用空目录
    const bare = join(tmpdir(), `bbart-mlxiso-bare-${process.pid}`);
    mkdirSync(join(bare, 'Qwen-Image-2.1-bf16', 'transformer'), { recursive: true });
    const prev = process.env.BIGBOTART_MODELS_DIR;
    process.env.BIGBOTART_MODELS_DIR = bare;
    try {
      const p = makeProvider();
      await p.submit(req('generate', { prompt: 'x', model: Q21 }));
      expect(lastCmd(p)[lastCmd(p).indexOf('--model') + 1]).toBe(Q21);
    } finally {
      process.env.BIGBOTART_MODELS_DIR = prev;
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('index.json 引用的分片缺失 → 判未就绪(防半截模型)', async () => {
    const half = join(tmpdir(), `bbart-mlxiso-half-${process.pid}`);
    const tf = join(half, 'Qwen-Image-2.1-bf16', 'transformer');
    mkdirSync(tf, { recursive: true });
    writeFileSync(join(tf, '0.safetensors'), 'w');
    writeFileSync(
      join(tf, 'model.safetensors.index.json'),
      JSON.stringify({ weight_map: { 'a.weight': '0.safetensors', 'b.weight': '1.safetensors' } }),
    );
    const prev = process.env.BIGBOTART_MODELS_DIR;
    process.env.BIGBOTART_MODELS_DIR = half;
    try {
      const p = makeProvider();
      await p.submit(req('generate', { prompt: 'x', model: Q21 }));
      // 1.safetensors 不存在 → 不该用这个半截目录
      expect(lastCmd(p)[lastCmd(p).indexOf('--model') + 1]).toBe(Q21);
    } finally {
      process.env.BIGBOTART_MODELS_DIR = prev;
      rmSync(half, { recursive: true, force: true });
    }
  });
});

/**
 * FLUX.2 Klein 9B 本地目录直用。
 * 背景:官方 AbstractFramework/flux.2-klein-9b-8bit 在 HF 上是 gated(需登录授权),
 * 国内直连常不通;实际来源为 ModelScope 的 mlx-community/flux2-klein-9b-8bit(与之同源)。
 * repoId 必须保持 AbstractFramework 全名不变——它同时是渲染层模型选择与
 * BASE_MODEL_HINTS/latentOnly 的 key,改了会让已有节点的模型引用失效。
 */
describe('submit · FLUX.2 Klein 9B 本地目录直用', () => {
  const KLEIN = 'AbstractFramework/flux.2-klein-9b-8bit';
  const root = join(tmpdir(), `bbart-mlxklein-${process.pid}`);

  beforeAll(() => {
    process.env.BIGBOTART_MODELS_DIR = root;
    mkdirSync(join(root, 'flux2-klein-9b-8bit', 'transformer'), { recursive: true });
    writeFileSync(join(root, 'flux2-klein-9b-8bit', 'transformer', '0.safetensors'), 'w');
  });
  afterAll(() => {
    delete process.env.BIGBOTART_MODELS_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it('本地有就绪目录时 --model 用本地路径(免 HF 授权、免重复下载)', async () => {
    const p = makeProvider();
    await p.submit(req('generate', { prompt: '角色展示图', model: KLEIN }));
    expect(lastCmd(p)[lastCmd(p).indexOf('--model') + 1]).toBe(join(root, 'flux2-klein-9b-8bit'));
  });

  it('多参考编辑同样走本地路径(该模型的核心用途)', async () => {
    const p = makeProvider();
    await p.submit(req('instruction', {
      prompt: '融合两张参考图', inputPath: '/tmp/a.png', model: KLEIN, i2iMode: 'multi-reference',
    }));
    expect(lastCmd(p)[lastCmd(p).indexOf('--model') + 1]).toBe(join(root, 'flux2-klein-9b-8bit'));
  });

  it('本地目录无 flux2-klein-9b-8bit 子目录 → 回退 repoId(不影响他人机器)', async () => {
    const other = join(tmpdir(), `bbart-mlxklein-none-${process.pid}`);
    mkdirSync(other, { recursive: true });
    const prev = process.env.BIGBOTART_MODELS_DIR;
    process.env.BIGBOTART_MODELS_DIR = other;
    try {
      const p = makeProvider();
      await p.submit(req('generate', { prompt: 'x', model: KLEIN }));
      expect(lastCmd(p)[lastCmd(p).indexOf('--model') + 1]).toBe(KLEIN);
    } finally {
      process.env.BIGBOTART_MODELS_DIR = prev;
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('submit · 纯 latent 模型的编辑防呆(--image-strength is required 事故)', () => {
  const Z = 'AbstractFramework/z-image-turbo-8bit';
  const Q21 = 'JoyFusionAI/Qwen-Image-2.1-MLX-8bit';
  const ROOT = join(tmpdir(), `bbart-mlxguard-${process.pid}`);
  beforeAll(() => { process.env.BIGBOTART_MODELS_DIR = ROOT; });
  afterAll(() => { delete process.env.BIGBOTART_MODELS_DIR; });

  it('z-image + instruction + 输入图 → 明确报错(不再透传给 CLI 抛 exit 2)', async () => {
    const p = makeProvider();
    await expect(
      p.submit(req('instruction', { prompt: '换背景', inputPath: '/tmp/in.png', model: Z })),
    ).rejects.toThrow(/不支持「指令编辑」/);
  });

  it('qwen-image-2.1 + instruction + 输入图 → 同样被拦(它也只有 latent i2i)', async () => {
    const p = makeProvider();
    await expect(
      p.submit(req('instruction', { prompt: '换背景', inputPath: '/tmp/in.png', model: Q21 })),
    ).rejects.toThrow(/不支持「指令编辑」/);
  });

  it('报错信息给出可操作指引(换模型 / 改模式)', async () => {
    const p = makeProvider();
    await expect(
      p.submit(req('outpaint', { prompt: 'x', inputPath: '/tmp/in.png', model: Z })),
    ).rejects.toThrow(/Qwen-Image-Edit-8bit|图生图|Inpaint/);
  });

  it('⚠️ z-image + inpaint(带 mask)必须放行:实测它能做 mask 编辑(z-image.inpaint)', async () => {
    const p = makeProvider();
    await p.submit(req('inpaint', { prompt: 'x', inputPath: '/tmp/in.png', maskPath: '/tmp/m.png', model: Z }));
    const cmd = lastCmd(p);
    expect(cmd).toContain('--mask-path');
    expect(cmd).toContain('--image-path');
  });

  it('z-image + instruction 但不带输入图(纯文生图)→ 不拦', async () => {
    const p = makeProvider();
    await p.submit(req('instruction', { prompt: 'x', model: Z }));
    expect(lastCmd(p)).toContain('--model');
  });

  it('Qwen Image Edit 的指令编辑不受影响(它有 edit-reference 能力)', async () => {
    const p = makeProvider();
    await p.submit(req('instruction', { prompt: '换背景', inputPath: '/tmp/in.png', model: 'mlx-community/Qwen-Image-Edit-8bit' }));
    expect(lastCmd(p)).toContain('--image-path');
  });

  it('flux.2-klein 的 outpaint 不受影响', async () => {
    const p = makeProvider();
    await p.submit(req('outpaint', {
      prompt: '扩图', inputPath: '/tmp/in.png', model: 'AbstractFramework/flux.2-klein-9b-8bit',
      outpaintSides: { top: 100, right: 0, bottom: 0, left: 0 },
    }));
    expect(lastCmd(p)).toContain('--outpaint-padding');
  });

  it('z-image 的 img2img 仍正常(该走 latent 且带 --image-strength)', async () => {
    const p = makeProvider();
    await p.submit(req('img2img', { prompt: '重绘', inputPath: '/tmp/in.png', model: Z }));
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--i2i-mode') + 1]).toBe('latent');
    expect(cmd).toContain('--image-strength');
  });
});

describe('submit · Qwen-Image-2.1 参考编辑(qwen21.edit,2026-09-28 引擎新增)', () => {
  const Q21BF16 = 'Qwen/Qwen-Image-2.1';
  // 隔离本机真实 ~/ai/models:否则命中本地目录直用,断言的是路径而非 repoId
  beforeAll(() => {
    process.env.BIGBOTART_MODELS_DIR = join(tmpdir(), `bbart-q21edit-iso-${process.pid}`);
  });
  afterAll(() => {
    delete process.env.BIGBOTART_MODELS_DIR;
  });

  const refs = (paths: string[]) =>
    paths.map((p) => ({
      asset: { id: `ref:${p}`, kind: 'image' as const, name: p, localPath: p, tags: [], createdAt: '' },
      role: 'ref-image' as const,
      localPath: p,
    }));

  it('instruction 模式走 2.1 编辑路由:--image-paths 复数参数 + --base-model 提示', async () => {
    const p = makeProvider();
    await p.submit(
      req('instruction', { model: Q21BF16, prompt: '把背景换成雪山', inputPath: '/in/base.png' }),
    );
    const cmd = lastCmd(p);
    // --image-paths 是 nargs='+' 的复数参数:一次给路径列表,而非重复 --image
    expect(cmd).toContain('--image-paths');
    expect(cmd[cmd.indexOf('--image-paths') + 1]).toBe('/in/base.png');
    expect(cmd).toContain('--base-model');
    expect(cmd[cmd.indexOf('--base-model') + 1]).toBe('qwen-image-2.1');
    // 该路由是 edit-reference,绝不能带 --image-strength(那是 latent i2i 的参数)
    expect(cmd).not.toContain('--image-strength');
    // 也绝不能用 flux2/qwen-edit 的重复 --image 写法
    expect(cmd).not.toContain('--image');
    expect(cmd).not.toContain('--image-path');
  });

  it('input 图 + ref-image 连线合并进同一份 --image-paths 列表(顺序=input 在前)', async () => {
    const p = makeProvider();
    await p.submit({
      ...req('instruction', { model: Q21BF16, prompt: 'dress the person', inputPath: '/in/base.png' }),
      references: refs(['/lib/jacket.png', '/lib/shoes.png']),
    });
    const cmd = lastCmd(p);
    const i = cmd.indexOf('--image-paths');
    // --image-paths 之后的连续路径 token(到下一个 --flag 为止)
    const tail: string[] = [];
    for (let k = i + 1; k < cmd.length && !cmd[k]!.startsWith('--'); k++) tail.push(cmd[k]!);
    expect(tail).toEqual(['/in/base.png', '/lib/jacket.png', '/lib/shoes.png']);
  });

  it('⚠️ 必须显式带 --i2i-mode edit(多参考真跑 exit 2 回归)', async () => {
    const p = makeProvider();
    // 根因:ml-gen 在「多张 --image-paths」时自动把模式推成 multi-reference,
    // 而 2.1 的能力行是 edit-reference → 通用校验直接拒绝:
    //   "Qwen Image 2.1 does not support multi-reference image-to-image generation."
    // 1 张碰巧推对、多张必炸,故必须显式声明 edit。
    await p.submit({
      ...req('instruction', { model: Q21BF16, prompt: 'x', inputPath: '/in/base.png' }),
      references: refs(['/lib/a.png', '/lib/b.png']),
    });
    const cmd = lastCmd(p);
    expect(cmd).toContain('--i2i-mode');
    expect(cmd[cmd.indexOf('--i2i-mode') + 1]).toBe('edit');
  });

  it('单参考同样带 --i2i-mode edit(不依赖 CLI 的 auto 推断)', async () => {
    const p = makeProvider();
    await p.submit(req('instruction', { model: Q21BF16, prompt: 'x', inputPath: '/in/base.png' }));
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--i2i-mode') + 1]).toBe('edit');
  });

  it('无任何参考图 → 明确报错并给出换模型的指引(不静默发空命令)', async () => {
    const p = makeProvider();
    await expect(p.submit(req('instruction', { model: Q21BF16, prompt: 'x' }))).rejects.toThrow('至少 1 张参考图');
  });

  it('参考图超过 10 张 → 提交前拦截(CLI 也会拒,但文案难懂)', async () => {
    const p = makeProvider();
    const many = refs(Array.from({ length: 11 }, (_, i) => `/lib/r${i}.png`));
    await expect(
      p.submit({ ...req('instruction', { model: Q21BF16, prompt: 'x', inputPath: '/in/base.png' }), references: many }),
    ).rejects.toThrow('最多支持 10 张');
  });

  it('缺省 30 步(与检查器 DEFAULT_EDIT_STEPS 同口径),显式 steps 优先', async () => {
    // 事故回归(2026-09-29「图片编辑不改 step 直接就是 40 步」):
    // 此处原为 40,而检查器只在滑块上显示 4、不写回 data → 界面显示 4、实跑 40,
    // 用户无从察觉(2.1 上 40 步约 4 分钟,是 6 步版的 6-7 倍耗时)。
    // 现在两端统一 30;检查器负责写回 data,provider 这里的兜底只作安全网
    // (历史节点 / Agent 直传 data 未带 steps 时)。
    const p = makeProvider();
    await p.submit(req('instruction', { model: Q21BF16, prompt: 'x', inputPath: '/in/base.png' }));
    expect(lastCmd(p)[lastCmd(p).indexOf('--steps') + 1]).toBe('30');
    const p2 = makeProvider();
    await p2.submit(req('instruction', { model: Q21BF16, prompt: 'x', inputPath: '/in/base.png', steps: 12 }));
    expect(lastCmd(p2)[lastCmd(p2).indexOf('--steps') + 1]).toBe('12');
  });

  it('输出固定 .png(RGBA 硬约束:CLI 拒绝非 png/webp/tif 后缀)', async () => {
    const p = makeProvider();
    await p.submit(req('instruction', { model: Q21BF16, prompt: 'x', inputPath: '/in/base.png' }));
    expect(lastCmd(p)[lastCmd(p).indexOf('--output') + 1]).toMatch(/\.png$/);
  });

  it('本地目录名 Qwen-Image-2.1-bf16 同样按编辑路由判定(不能只看 repoId)', async () => {
    const p = makeProvider();
    await p.submit(req('instruction', { model: 'Qwen-Image-2.1-bf16', prompt: 'x', inputPath: '/in/base.png' }));
    const cmd = lastCmd(p);
    expect(cmd).toContain('--image-paths');
    expect(cmd[cmd.indexOf('--model') + 1]).toBe('Qwen-Image-2.1-bf16');
  });

  /* ── 输出尺寸必须真的进命令行(2026-10 真实事故回归) ──
     事故形态:检查器有「输出尺寸」控件、data.width/height 确实写了、渲染层 runNode 也
     一路传到了 params,但本 isQwen21Edit 分支**从不 push `--width/--height`** ——
     命令里根本没有这两个参数,引擎于是走「跟随最后一张参考图比例」的默认:
     用户设 1280×704,实得 896×1184(参考图 3:4 的比例)。
     检查器单测与 provider 单测当时都"通过",因为**没有任何断言盯这条路由上的尺寸参数**。
     引擎侧已另用真跑验证(官方文档 docs/character-four-view-operations.md §2.1):
     参考图 896×1184 竖版,请求 1280×704 → 实得 1280×704(qwen21.edit 不做源图比例改写)。 */
  it('⚠️ 显式 width/height 必须真的进命令(事故回归:此前被整段吞掉)', async () => {
    const p = makeProvider();
    await p.submit(
      req('instruction', { model: Q21BF16, prompt: 'x', inputPath: '/in/base.png', width: 1280, height: 704 }),
    );
    const cmd = lastCmd(p);
    expect(cmd).toContain('--width');
    expect(cmd[cmd.indexOf('--width') + 1]).toBe('1280');
    expect(cmd).toContain('--height');
    expect(cmd[cmd.indexOf('--height') + 1]).toBe('704');
  });

  it('未传尺寸 → 不带 --width/--height(保持「跟随最后一张参考图」的引擎默认)', async () => {
    const p = makeProvider();
    await p.submit(req('instruction', { model: Q21BF16, prompt: 'x', inputPath: '/in/base.png' }));
    const cmd = lastCmd(p);
    expect(cmd).not.toContain('--width');
    expect(cmd).not.toContain('--height');
  });

  it('只给一个尺寸 → 两个都不传(防拼出用户没预期的比例)', async () => {
    // 引擎侧:--width 有而 --height 无时,height 走「output-resolution + 参考图比例」的推导,
    // 会拼出用户没预期的比例;故与检查器 UI 的「必须成对」口径一致,单个有效值整体不传。
    for (const partial of [{ width: 1280 }, { height: 704 }]) {
      const p = makeProvider();
      await p.submit(req('instruction', { model: Q21BF16, prompt: 'x', inputPath: '/in/base.png', ...partial }));
      const cmd = lastCmd(p);
      expect(cmd, JSON.stringify(partial)).not.toContain('--width');
      expect(cmd, JSON.stringify(partial)).not.toContain('--height');
    }
  });

  it('非法尺寸(<32 / NaN)不传,交给引擎默认(不构造注定 exit 的命令)', async () => {
    // 引擎硬约束:width/height ≥ 32 且必须是 32 的倍数,否则
    // `Qwen-Image-2.1 dimensions must be positive multiples of 32.` 直接退出。
    for (const bad of [{ width: 16, height: 704 }, { width: 1280, height: 0 }, { width: NaN, height: 704 }]) {
      const p = makeProvider();
      await p.submit(req('instruction', { model: Q21BF16, prompt: 'x', inputPath: '/in/base.png', ...bad }));
      expect(lastCmd(p), JSON.stringify(bad)).not.toContain('--width');
    }
  });

  it('尺寸与像素预算可共存(尺寸决定输出画布,预算决定参考图缩放)', async () => {
    const p = makeProvider();
    await p.submit(
      req('instruction', { model: Q21BF16, prompt: 'x', inputPath: '/in/base.png', width: 1280, height: 704, outputResolution: 2048 }),
    );
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--width') + 1]).toBe('1280');
    expect(cmd[cmd.indexOf('--height') + 1]).toBe('704');
    expect(cmd[cmd.indexOf('--output-resolution') + 1]).toBe('2048');
  });

  it('已移除的 8bit 仓库名不会被当成可编辑 checkpoint(按名字判,不因别名归一化误放行)', async () => {
    const p = makeProvider();
    // 8bit 导出无 vision tower:latentOnly 判为纯文生图族 → 沿用既有「不支持指令编辑」报错。
    // (别名归一化只作用于 --model 落盘值;isQwen21EditModel 按原始 repoModel 判定,
    //  故手工填 8bit 仍会被拦,而不是发出一条必炸的命令)
    await expect(
      p.submit(req('instruction', { model: 'JoyFusionAI/Qwen-Image-2.1-MLX-8bit', prompt: 'x', inputPath: '/in/base.png' })),
    ).rejects.toThrow('不支持');
  });

  it('2.1 全量 bf16 不再被 latentOnly 误拦(本次修复的核心)', async () => {
    const p = makeProvider();
    await expect(
      p.submit(req('instruction', { model: Q21BF16, prompt: 'x', inputPath: '/in/base.png' })),
    ).resolves.toBeTruthy();
  });
});

/**
 * Qwen-Image-2.1 Uncensored 本地 8bit 包(2026-10 接入)。
 * 引擎侧:社区 abenzerps/Qwen-Image-2.1-Uncensored-GGUF 经
 * tools/build_qwen21_uncensored_package.sh 转换的 mflux prepared package。
 * 能力:text_encoder 是纯语言塔(0 个 visual.*),只有 qwen21.text + qwen21.latent,
 * **没有** qwen21.edit —— 参考编辑/inpaint/多参考必须被拦,不能发出必炸的命令。
 */
describe('submit · Qwen-Image-2.1 Uncensored(本地 8bit 包)', () => {
  const UNC = 'Qwen-Image-2.1-Uncensored-MLX';
  const root = join(tmpdir(), `bbart-mlxunc-${process.pid}`);

  beforeAll(() => {
    process.env.BIGBOTART_MODELS_DIR = root;
    mkdirSync(join(root, UNC, 'transformer'), { recursive: true });
    writeFileSync(join(root, UNC, 'transformer', '0.safetensors'), 'w');
  });
  afterAll(() => {
    delete process.env.BIGBOTART_MODELS_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  const refs = (paths: string[]) =>
    paths.map((p) => ({
      asset: { id: `ref:${p}`, kind: 'image' as const, name: p, localPath: p, tags: [], createdAt: '' },
      role: 'ref-image' as const,
      localPath: p,
    }));

  it('capabilities 清单含 Uncensored 条目(纯文生图/图生图)', async () => {
    const p = makeProvider();
    const caps = await p.capabilities();
    expect(caps.models?.some((m) => m.includes('Qwen-Image-2.1-Uncensored-MLX'))).toBe(true);
  });

  it('generate:本地目录就绪 → --model 用本地路径 + --base-model 路由提示 + 40 步默认', async () => {
    const p = makeProvider();
    await p.submit(req('generate', { prompt: '雪山日出', model: UNC }));
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--model') + 1]).toBe(join(root, UNC));
    // 不给提示会被家族兜底误路由成旧 qwen.generate(与 bf16 同因)
    expect(cmd[cmd.indexOf('--base-model') + 1]).toBe('qwen-image-2.1');
    expect(cmd[cmd.indexOf('--steps') + 1]).toBe('40');
  });

  it('短别名 qwen-image-2.1-uncensored 归一化到本地包(不归一化到 bf16)', async () => {
    const p = makeProvider();
    await p.submit(req('generate', { prompt: 'x', model: 'qwen-image-2.1-uncensored' }));
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--model') + 1]).toBe(join(root, UNC));
    expect(cmd[cmd.indexOf('--base-model') + 1]).toBe('qwen-image-2.1');
  });

  it('本地包缺失 → 提交前明确报错给构建指引(不放行给 mlxgen 去 HF 解析一个假 repoId)', async () => {
    const prev = process.env.BIGBOTART_MODELS_DIR;
    process.env.BIGBOTART_MODELS_DIR = join(tmpdir(), `bbart-mlxunc-none-${process.pid}`);
    try {
      const p = makeProvider();
      await expect(p.submit(req('generate', { prompt: 'x', model: UNC }))).rejects.toThrow(
        'build_qwen21_uncensored_package.sh',
      );
    } finally {
      process.env.BIGBOTART_MODELS_DIR = prev;
    }
  });

  it('generate + ref-image 参考图 → 拦截(无 vision tower,没有 qwen21.edit 参考能力)', async () => {
    const p = makeProvider();
    await expect(
      p.submit({ ...req('generate', { model: UNC, prompt: 'x' }), references: refs(['/lib/r1.png']) }),
    ).rejects.toThrow('多参考模型');
  });

  it('⚠️ instruction + 输入图 → 被 latentOnly 拦(绝不能走 qwen21.edit 路由,纯语言塔必炸)', async () => {
    const p = makeProvider();
    await expect(
      p.submit(req('instruction', { prompt: '换背景', inputPath: '/in/base.png', model: UNC })),
    ).rejects.toThrow('不支持「指令编辑」');
  });

  it('本地绝对路径形式同样被拦(isQwen21EditModel 按 checkpoint 判,不认路径形式)', async () => {
    const p = makeProvider();
    await expect(
      p.submit(
        req('instruction', {
          prompt: 'x',
          inputPath: '/in/base.png',
          model: join(root, UNC),
        }),
      ),
    ).rejects.toThrow('不支持「指令编辑」');
  });

  it('img2img(latent)放行:--i2i-mode latent + --image-strength(该能力不需要 vision tower)', async () => {
    const p = makeProvider();
    await p.submit(req('img2img', { prompt: '重绘', inputPath: '/in/base.png', model: UNC }));
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--i2i-mode') + 1]).toBe('latent');
    expect(cmd).toContain('--image-strength');
  });

  it('bf16 行为不受影响:同环境下 Qwen/Qwen-Image-2.1 仍走编辑路由', async () => {
    const p = makeProvider();
    await p.submit(req('instruction', { prompt: 'x', inputPath: '/in/base.png', model: 'Qwen/Qwen-Image-2.1' }));
    const cmd = lastCmd(p);
    expect(cmd).toContain('--image-paths');
    expect(cmd[cmd.indexOf('--i2i-mode') + 1]).toBe('edit');
  });
});

/**
 * Qwen-Image-2.1-Turbo(2026-10 接入):2.1 的 8 步蒸馏版。
 * 引擎侧(mlx-gen 未提交工作区):采样表 sample_sigmas 内置于 checkpoint,
 * 步数被锁成 8(--steps 被忽略);edit CLI 经 extra_keys 接受 qwen-image-2.1-turbo。
 * 本机 4bit 全量目录(13GB,带 vision tower 351 个 visual.*)→ 参考编辑可做,
 * 与 Uncensored(纯语言塔)截然相反。
 */
describe('submit · Qwen-Image-2.1-Turbo(8 步蒸馏)', () => {
  const TURBO = 'Qwen/Qwen-Image-2.1-Turbo';
  const root = join(tmpdir(), `bbart-mlxturbo-${process.pid}`);

  beforeAll(() => {
    process.env.BIGBOTART_MODELS_DIR = root;
    mkdirSync(join(root, 'Qwen-Image-2.1-Turbo', 'transformer'), { recursive: true });
    writeFileSync(join(root, 'Qwen-Image-2.1-Turbo', 'transformer', '0.safetensors'), 'w');
  });
  afterAll(() => {
    delete process.env.BIGBOTART_MODELS_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  const refs = (paths: string[]) =>
    paths.map((p) => ({
      asset: { id: `ref:${p}`, kind: 'image' as const, name: p, localPath: p, tags: [], createdAt: '' },
      role: 'ref-image' as const,
      localPath: p,
    }));

  it('generate:本地目录就绪 → --model 本地路径 + --base-model qwen-image-2.1-turbo + 默认 8 步', async () => {
    const p = makeProvider();
    await p.submit(req('generate', { prompt: '雪山日出', model: TURBO }));
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--model') + 1]).toBe(join(root, 'Qwen-Image-2.1-Turbo'));
    // ⚠️ 提示必须是 turbo 键:给 'qwen-image-2.1' 会拿到普通 2.1 的采样配置
    // (requires_sigma_shift=true),与 Turbo 的固定 sample_sigmas 冲突
    expect(cmd[cmd.indexOf('--base-model') + 1]).toBe('qwen-image-2.1-turbo');
    expect(cmd[cmd.indexOf('--steps') + 1]).toBe('8');
  });

  it('短别名 qwen-image-2.1-turbo 归一化到官方 repoId', async () => {
    const p = makeProvider();
    await p.submit(req('generate', { prompt: 'x', model: 'qwen-image-2.1-turbo' }));
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--model') + 1]).toBe(join(root, 'Qwen-Image-2.1-Turbo'));
    expect(cmd[cmd.indexOf('--base-model') + 1]).toBe('qwen-image-2.1-turbo');
  });

  it('本地目录缺失 → 回退 repoId(官方仓库,可走 mlxgen download/HF,不拦)', async () => {
    const prev = process.env.BIGBOTART_MODELS_DIR;
    process.env.BIGBOTART_MODELS_DIR = join(tmpdir(), `bbart-mlxturbo-none-${process.pid}`);
    try {
      const p = makeProvider();
      await p.submit(req('generate', { prompt: 'x', model: TURBO }));
      const cmd = lastCmd(p);
      expect(cmd[cmd.indexOf('--model') + 1]).toBe(TURBO);
      expect(cmd[cmd.indexOf('--base-model') + 1]).toBe('qwen-image-2.1-turbo');
      expect(cmd[cmd.indexOf('--steps') + 1]).toBe('8');
    } finally {
      process.env.BIGBOTART_MODELS_DIR = prev;
    }
  });

  it('instruction + 输入图 → 走 2.1 编辑路由(有 vision tower,绝不能被 latentOnly 误拦)', async () => {
    const p = makeProvider();
    await p.submit(req('instruction', { prompt: '换背景', inputPath: '/in/base.png', model: TURBO }));
    const cmd = lastCmd(p);
    expect(cmd).toContain('--image-paths');
    expect(cmd[cmd.indexOf('--i2i-mode') + 1]).toBe('edit');
    expect(cmd).not.toContain('--image-strength');
    // 编辑路由的步数兜底同样锁 8(采样表说了算)
    expect(cmd[cmd.indexOf('--steps') + 1]).toBe('8');
  });

  it('本地路径形式同样按编辑路由判定(isQwen21EditModel 认 Turbo basename)', async () => {
    const p = makeProvider();
    await p.submit(
      req('instruction', { prompt: 'x', inputPath: '/in/base.png', model: join(root, 'Qwen-Image-2.1-Turbo') }),
    );
    expect(lastCmd(p)[lastCmd(p).indexOf('--i2i-mode') + 1]).toBe('edit');
  });

  it('generate + ref-image → qwen21.edit 参考生成路由(--i2i-mode edit + --image-paths)', async () => {
    const p = makeProvider();
    await p.submit({
      ...req('generate', { model: TURBO, prompt: '角色展示图' }),
      references: refs(['/lib/r1.png', '/lib/r2.png']),
    });
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--i2i-mode') + 1]).toBe('edit');
    expect(cmd).toContain('--image-paths');
  });

  it('img2img(latent)放行:--i2i-mode latent + --image-strength', async () => {
    const p = makeProvider();
    await p.submit(req('img2img', { prompt: '重绘', inputPath: '/in/base.png', model: TURBO }));
    const cmd = lastCmd(p);
    expect(cmd[cmd.indexOf('--i2i-mode') + 1]).toBe('latent');
    expect(cmd).toContain('--image-strength');
  });

  it('⚠️ 同环境下 Uncensored 仍被拦(显式排除不被 Turbo 放宽误伤)', async () => {
    mkdirSync(join(root, 'Qwen-Image-2.1-Uncensored-MLX', 'transformer'), { recursive: true });
    writeFileSync(join(root, 'Qwen-Image-2.1-Uncensored-MLX', 'transformer', '0.safetensors'), 'w');
    const p = makeProvider();
    await expect(
      p.submit(req('instruction', { prompt: 'x', inputPath: '/in/base.png', model: 'Qwen-Image-2.1-Uncensored-MLX' })),
    ).rejects.toThrow('不支持「指令编辑」');
  });
});

describe('spawn 失败', () => {
  it('找不到 mlxgen 时记为失败,不变成未捕获异常', async () => {
    const p = new MlXGenProvider({ dryRun: false, bin: '/no/such/mlxgen-bin', outputDir: '/tmp/bba-mlxgen-missing' });
    const handle = await p.submit(req('generate', { prompt: 'x', model: 'm/z-8bit' }));
    await new Promise((r) => setTimeout(r, 50));
    const st = await p.status(handle);
    expect(st.status).toBe('FAILED');
    expect(st.error).toMatch(/找不到命令/);
  });
});
