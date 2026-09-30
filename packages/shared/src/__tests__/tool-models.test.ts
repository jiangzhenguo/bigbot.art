/**
 * tool-models 真源单测(2026-09-29 v1)
 * 锁:能力映射 / 三级解析 / 归一化三种写法等价 / 矩阵与默认值一致性。
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TOOL_MODELS,
  MODEL_CAPABILITIES,
  capabilityOf,
  normalizeModelId,
  resolveImageModel,
  supportsCapability,
  type ImageCapability,
} from '../tool-models.js';

describe('capabilityOf:节点 kind + mode → 能力', () => {
  it('image-gen:无参考图 → 文生图;有参考图 → 多参考生成', () => {
    expect(capabilityOf('image-gen')).toBe('image.generate');
    expect(capabilityOf('image-gen', undefined, true)).toBe('image.multiReference');
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
