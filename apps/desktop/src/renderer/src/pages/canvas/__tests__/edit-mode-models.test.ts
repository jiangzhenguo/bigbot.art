/**
 * 缺陷 B 锁定测试(2026-09-29,docs/工具模型选择-产品设计与技术方案.md §2.1.3):
 * ImageEditInspector 的 MODE_MODELS 此前漏掉 Qwen-Image-2.1 ——
 * 用户显式选了 2.1 后切模式,会被误判「不支持」并自动改回 Qwen Image Edit(实测它支持,还更强)。
 *
 * 依据 = mlxgen capabilities 实测(docs/evidence/mlxgen-capabilities-qwen-image-2.1.json):
 *   qwen21.text / qwen21.latent / qwen21.edit(1-10 张参考图);无 mask / outpaint。
 */
import { describe, it, expect } from 'vitest';
import { modeSwitchDecision } from '../inspector/ImageEditInspector';

const QWEN21 = 'Qwen/Qwen-Image-2.1';
const QWEN_EDIT = 'mlx-community/Qwen-Image-Edit-8bit';
const ZIMAGE = 'AbstractFramework/z-image-turbo-8bit';
const KLEIN = 'AbstractFramework/flux.2-klein-9b-8bit';

describe('缺陷 B:2.1 在 instruction 模式不被自动切走', () => {
  it('2.1 → instruction:不切(缺陷修复前会被切到 Qwen Image Edit)', () => {
    expect(modeSwitchDecision(QWEN21, 'instruction')).toBeNull();
  });

  it('2.1 的短别名 → instruction:同样不切(别名归一化)', () => {
    expect(modeSwitchDecision('qwen-image-2.1', 'instruction')).toBeNull();
  });

  it('Qwen Edit / klein → instruction:不切(既有行为不变)', () => {
    expect(modeSwitchDecision(QWEN_EDIT, 'instruction')).toBeNull();
    expect(modeSwitchDecision(KLEIN, 'instruction')).toBeNull();
  });
});

describe('2.1 在不支持的模式上仍应被切换(实测无该能力)', () => {
  it('2.1 → inpaint:切到 Qwen Image Edit(2.1 无 mask 能力)', () => {
    expect(modeSwitchDecision(QWEN21, 'inpaint')).toEqual({ recommend: QWEN_EDIT });
  });

  it('2.1 → outpaint:切到 Qwen Image Edit(2.1 无 outpaint 能力)', () => {
    expect(modeSwitchDecision(QWEN21, 'outpaint')).toEqual({ recommend: QWEN_EDIT });
  });

  it('2.1 → img2img:不切(缺陷 A 已修,2.1 的 qwen21.latent 可用)', () => {
    expect(modeSwitchDecision(QWEN21, 'img2img')).toBeNull();
  });
});

describe('既有切换行为回归', () => {
  it('z-image → instruction:切到 Qwen Image Edit(z-image 无 edit-reference)', () => {
    expect(modeSwitchDecision(ZIMAGE, 'instruction')).toEqual({ recommend: QWEN_EDIT });
  });

  it('Qwen Edit → img2img:切到 z-image-turbo(Provider 侧实测 exit 2)', () => {
    expect(modeSwitchDecision(QWEN_EDIT, 'img2img')).toEqual({ recommend: ZIMAGE });
  });

  it('自定义 repoId(matchModel 匹配不到):不动,由用户负责', () => {
    expect(modeSwitchDecision('someone/custom-model', 'img2img')).toBeNull();
  });

  it('未知模式:不动', () => {
    expect(modeSwitchDecision(QWEN_EDIT, 'no-such-mode')).toBeNull();
  });
});
