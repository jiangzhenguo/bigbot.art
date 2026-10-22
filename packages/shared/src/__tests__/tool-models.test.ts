/**
 * tool-models 真源单测(2026-09-29 v1)
 * 锁:能力映射 / 三级解析 / 归一化三种写法等价 / 矩阵与默认值一致性。
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TOOL_MODELS,
  MODEL_CAPABILITIES,
  capabilityOf,
  defaultGenerateSteps,
  normalizeModelId,
  resolveImageModel,
  supportsCapability,
  type ImageCapability,
} from '../tool-models.js';

describe('capabilityOf:节点 kind + mode → 能力', () => {
  it('image-gen:无参考图 → 文生图;有参考图 → 参考编辑(不是 Klein multi-reference)', () => {
    expect(capabilityOf('image-gen')).toBe('image.generate');
    // 2026-10-22:连参考图的常见意图是 edit-reference(2.1),不是 flux2.multi-reference
    expect(capabilityOf('image-gen', undefined, true)).toBe('image.instruction');
    expect(resolveImageModel(undefined, capabilityOf('image-gen', undefined, true))).toBe(
      'Qwen/Qwen-Image-2.1',
    );
  });

  it('image-edit:按 mode 细分;未知 mode 回退 instruction(与 Provider 缺省同口径)', () => {
    expect(capabilityOf('image-edit', 'instruction')).toBe('image.instruction');
    expect(capabilityOf('image-edit', 'img2img')).toBe('image.img2img');
    expect(capabilityOf('image-edit', 'inpaint')).toBe('image.inpaint');
    expect(capabilityOf('image-edit', 'outpaint')).toBe('image.outpaint');
    expect(capabilityOf('image-edit')).toBe('image.instruction'); // 未设 mode
    expect(capabilityOf('image-edit', 'whatever')).toBe('image.instruction');
  });

  it('image-upscale → 超分;纯 ffmpeg 节点 / 视频节点 → undefined(无模型)', () => {
    expect(capabilityOf('image-upscale')).toBe('image.upscale');
    for (const k of ['image-crop', 'image-stitch', 'image-split', 'frame-grab', 'video-upscale', 'shot', 'asset']) {
      expect(capabilityOf(k), k).toBeUndefined();
    }
  });
});

describe('normalizeModelId:同一模型三种写法等价(缺陷 A 根因锁定)', () => {
  it('2.1:repoId / 短别名 / 本地目录路径 → 同一 id', () => {
    const forms = ['Qwen/Qwen-Image-2.1', 'qwen-image-2.1', 'qwen-2.1', '/Users/x/ai/models/Qwen-Image-2.1-bf16', 'Qwen-Image-2.1-bf16'];
    for (const f of forms) expect(normalizeModelId(f), f).toBe('Qwen/Qwen-Image-2.1');
  });

  it('历史 8bit 标识收敛到 bf16(向后兼容)', () => {
    expect(normalizeModelId('JoyFusionAI/Qwen-Image-2.1-MLX-8bit')).toBe('Qwen/Qwen-Image-2.1');
  });

  it('Qwen Image Edit / klein / seedvr2 的目录名同样归一化', () => {
    expect(normalizeModelId('/models/Qwen-Image-Edit-8bit')).toBe('mlx-community/Qwen-Image-Edit-8bit');
    expect(normalizeModelId('/models/flux2-klein-9b-8bit')).toBe('AbstractFramework/flux.2-klein-9b-8bit');
  });

  it('Uncensored 本地包:repoId / 短别名 / 本地路径 → 同一 id(独立于 bf16,不归一化过去)', () => {
    const forms = [
      'Qwen-Image-2.1-Uncensored-MLX',
      'qwen-image-2.1-uncensored',
      '/Users/x/ai/models/Qwen-Image-2.1-Uncensored-MLX',
    ];
    for (const f of forms) expect(normalizeModelId(f), f).toBe('Qwen-Image-2.1-Uncensored-MLX');
  });

  it('Turbo:repoId / 短别名 / 本地目录路径 → 同一 id', () => {
    const forms = [
      'Qwen/Qwen-Image-2.1-Turbo',
      'qwen-image-2.1-turbo',
      'qwen-2.1-turbo',
      '/Users/x/ai/models/Qwen-Image-2.1-Turbo',
    ];
    for (const f of forms) expect(normalizeModelId(f), f).toBe('Qwen/Qwen-Image-2.1-Turbo');
  });

  it('自定义 repoId 原样返回(用户自行负责);空串安全', () => {
    expect(normalizeModelId('someone/custom')).toBe('someone/custom');
    expect(normalizeModelId('')).toBe('');
  });
});

describe('supportsCapability:按实测矩阵判定', () => {
  it('2.1:文生图/图生图/指令编辑 ✓;多参考/inpaint/outpaint/超分 ✗', () => {
    for (const f of ['Qwen/Qwen-Image-2.1', 'qwen-image-2.1', '/m/Qwen-Image-2.1-bf16']) {
      expect(supportsCapability(f, 'image.generate'), f).toBe(true);
      expect(supportsCapability(f, 'image.img2img'), f).toBe(true);
      expect(supportsCapability(f, 'image.instruction'), f).toBe(true);
      expect(supportsCapability(f, 'image.inpaint'), f).toBe(false);
      expect(supportsCapability(f, 'image.outpaint'), f).toBe(false);
      expect(supportsCapability(f, 'image.multiReference'), f).toBe(false);
    }
  });

  it('klein 全能(除超分);seedvr2 只有超分;z-image 无指令编辑', () => {
    expect(supportsCapability('AbstractFramework/flux.2-klein-9b-8bit', 'image.multiReference')).toBe(true);
    expect(supportsCapability('AbstractFramework/flux.2-klein-9b-8bit', 'image.upscale')).toBe(false);
    expect(supportsCapability('AbstractFramework/seedvr2-3b-8bit', 'image.upscale')).toBe(true);
    expect(supportsCapability('AbstractFramework/seedvr2-3b-8bit', 'image.generate')).toBe(false);
    expect(supportsCapability('AbstractFramework/z-image-turbo-8bit', 'image.instruction')).toBe(false);
  });

  it('未知模型一律 false(防呆交给提交层)', () => {
    expect(supportsCapability('someone/custom', 'image.generate')).toBe(false);
  });

  it('Uncensored:仅文生图/图生图(纯语言塔,无 vision tower → 无参考编辑/inpaint/outpaint/多参考)', () => {
    for (const f of ['Qwen-Image-2.1-Uncensored-MLX', '/m/Qwen-Image-2.1-Uncensored-MLX']) {
      expect(supportsCapability(f, 'image.generate'), f).toBe(true);
      expect(supportsCapability(f, 'image.img2img'), f).toBe(true);
      expect(supportsCapability(f, 'image.instruction'), f).toBe(false);
      expect(supportsCapability(f, 'image.inpaint'), f).toBe(false);
      expect(supportsCapability(f, 'image.outpaint'), f).toBe(false);
      expect(supportsCapability(f, 'image.multiReference'), f).toBe(false);
      expect(supportsCapability(f, 'image.upscale'), f).toBe(false);
    }
  });

  it('Turbo:能力面与 bf16 相同(全量带 vision tower → 参考编辑 ✓;多参考/inpaint/outpaint ✗)', () => {
    for (const f of ['Qwen/Qwen-Image-2.1-Turbo', 'qwen-image-2.1-turbo', '/m/Qwen-Image-2.1-Turbo']) {
      expect(supportsCapability(f, 'image.generate'), f).toBe(true);
      expect(supportsCapability(f, 'image.img2img'), f).toBe(true);
      expect(supportsCapability(f, 'image.instruction'), f).toBe(true);
      expect(supportsCapability(f, 'image.inpaint'), f).toBe(false);
      expect(supportsCapability(f, 'image.outpaint'), f).toBe(false);
      expect(supportsCapability(f, 'image.multiReference'), f).toBe(false);
    }
  });
});

describe('resolveImageModel:设置值 > 内置默认', () => {
  it('未配置 → 内置默认(存量行为)', () => {
    expect(resolveImageModel(undefined, 'image.instruction')).toBe('Qwen/Qwen-Image-2.1');
    expect(resolveImageModel({}, 'image.generate')).toBe('AbstractFramework/z-image-turbo-8bit');
    expect(resolveImageModel({ image: {} }, 'image.upscale')).toBe('AbstractFramework/seedvr2-3b-8bit');
  });

  it('设置值覆盖默认;空字符串不算配置', () => {
    const tm = { image: { 'image.instruction': 'mlx-community/Qwen-Image-Edit-8bit', 'image.generate': '  ' } };
    expect(resolveImageModel(tm, 'image.instruction')).toBe('mlx-community/Qwen-Image-Edit-8bit');
    expect(resolveImageModel(tm, 'image.generate')).toBe('AbstractFramework/z-image-turbo-8bit');
  });

  it('无模型节点(undefined cap)→ undefined', () => {
    expect(resolveImageModel({ image: {} }, undefined)).toBeUndefined();
  });
});

describe('真源自洽性(防表漂移)', () => {
  it('DEFAULT_TOOL_MODELS 的每个默认值都支持它被指派的能力', () => {
    for (const [cap, model] of Object.entries(DEFAULT_TOOL_MODELS)) {
      expect(supportsCapability(model, cap as ImageCapability), `${cap} → ${model}`).toBe(true);
    }
  });

  it('矩阵中的每个模型都能被 normalizeModelId 稳定命中', () => {
    for (const id of Object.keys(MODEL_CAPABILITIES)) {
      expect(normalizeModelId(id)).toBe(id);
    }
  });

  it('能力 key 全集一致:DEFAULT 与矩阵值不出现表外能力', () => {
    const caps = new Set([...Object.keys(DEFAULT_TOOL_MODELS)]);
    for (const list of Object.values(MODEL_CAPABILITIES)) {
      for (const c of list) expect(caps.has(c), c).toBe(true);
    }
  });
});

describe('defaultGenerateSteps:缺省步数按模型(2026-10-14 Turbo=8 修复)', () => {
  it('Qwen-Image-2.1-Turbo → 8(采样表内置,引擎锁步,UI 必须说真话)', () => {
    expect(defaultGenerateSteps('Qwen/Qwen-Image-2.1-Turbo')).toBe(8);
    expect(defaultGenerateSteps('qwen-image-2.1-turbo')).toBe(8);
    // 本地目录路径也要命中(provider 传的就是目录名)
    expect(defaultGenerateSteps('/Users/x/ai/models/Qwen-Image-2.1-Turbo')).toBe(8);
  });

  it('Qwen-Image-2.1 其余(bf16 / Uncensored)→ 40(官方推荐)', () => {
    expect(defaultGenerateSteps('Qwen/Qwen-Image-2.1')).toBe(40);
    expect(defaultGenerateSteps('Qwen-Image-2.1-Uncensored-MLX')).toBe(40);
    expect(defaultGenerateSteps('/Users/x/ai/models/Qwen-Image-2.1-bf16')).toBe(40);
  });

  it('其它模型 / 空值 → 24(既有默认,存量行为不变)', () => {
    expect(defaultGenerateSteps('AbstractFramework/z-image-turbo-8bit')).toBe(24);
    expect(defaultGenerateSteps('AbstractFramework/flux.2-klein-9b-8bit')).toBe(24);
    expect(defaultGenerateSteps(undefined)).toBe(24);
    expect(defaultGenerateSteps('')).toBe(24);
  });

  it('防表漂移:provider generate 分支的缺省步数必须调本函数', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../../../providers/src/mlxgen.ts', import.meta.url),
      'utf8',
    );
    expect(src).toContain('defaultGenerateSteps(repoModel)');
  });
});
