/**
 * mlxgen Provider 测试 — dry-run 下命令构造(不 spawn、不推理)
 * 覆盖:generate / upscale / edit(instruction·inpaint)三种 kind 分支;槽位校验;dry-run 状态语义
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
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

  it('无参考图 → 不带 --i2i-mode/--image(纯文生图不变)', async () => {
    const p = makeProvider();
    await p.submit(req('generate', { prompt: '晨雾森林' }));
    const cmd = lastCmd(p);
    expect(cmd).not.toContain('--i2i-mode');
    expect(cmd).not.toContain('--image');
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
    const p = makeProvider();
    await p.submit(req('instruction', { prompt: 'x', inputPath: '/tmp/a.png', model: 'AbstractFramework/flux.2-klein-9b-8bit' }));
    expect(lastCmd(p)[lastCmd(p).indexOf('--model') + 1]).toBe('AbstractFramework/flux.2-klein-9b-8bit');
  });
});
