/**
 * 图片编辑默认步数一致性 —— 「界面显示几步 = 实际跑几步」。
 *
 * 历史事故:检查器默认 4 且不写回 data,provider 硬兜底 40 → 界面 4、实跑 40。
 * 2026-09-29 修:默认 30 且显式写回 data;2026-10-14 Turbo 补 8。
 * 现在默认值单一来源在 shared `defaultEditSteps`,provider 与检查器都调它;
 * 本测试只断言行为,不再读实现源码文本。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_EDIT_STEPS as SHARED_DEFAULT_EDIT_STEPS, defaultEditSteps } from '@bigbotart/shared';
import {
  DEFAULT_EDIT_STEPS,
  DEFAULT_STEPS_EFFECT_DEPS,
  EDIT_STEPS_MAX,
  EDIT_STEPS_MIN,
  defaultEditStepsForModel,
  defaultEditStepsPatch,
} from '../inspector/ImageEditInspector';

describe('图片编辑默认步数:单一来源 + 写回行为', () => {
  it('默认值为 30(用户 2026-09-29 指定;不再是 4 或 40)', () => {
    expect(SHARED_DEFAULT_EDIT_STEPS).toBe(30);
    expect(DEFAULT_EDIT_STEPS).toBe(SHARED_DEFAULT_EDIT_STEPS);
  });

  it('检查器与 shared 对 Turbo / 本地目录 / 其它模型同口径', () => {
    const cases = [
      'Qwen/Qwen-Image-2.1-Turbo',
      'qwen-image-2.1-turbo',
      '/Users/x/ai/models/Qwen-Image-2.1-Turbo',
      'Qwen/Qwen-Image-2.1',
      'Qwen-Image-2.1-Uncensored-MLX',
      'Qwen/Qwen-Image-Edit',
      'AbstractFramework/flux.2-klein-9b-8bit',
      'AbstractFramework/z-image-turbo-8bit',
      '',
    ];
    for (const model of cases) {
      expect(defaultEditStepsForModel(model), model).toBe(defaultEditSteps(model));
    }
    expect(defaultEditSteps('Qwen/Qwen-Image-2.1-Turbo')).toBe(8);
    expect(defaultEditSteps('Qwen/Qwen-Image-2.1')).toBe(30);
  });

  it('未显式设置 steps 时写回按模型算出的默认值', () => {
    expect(defaultEditStepsPatch('Qwen/Qwen-Image-2.1-Turbo', false)).toEqual({ steps: 8 });
    expect(defaultEditStepsPatch('Qwen/Qwen-Image-2.1', false)).toEqual({ steps: 30 });
    expect(defaultEditStepsPatch('Qwen/Qwen-Image-2.1-Turbo', true)).toBeNull();
  });

  it('补写 steps 的 effect 依赖保持稳定(nodeId only)', () => {
    expect([...DEFAULT_STEPS_EFFECT_DEPS]).toEqual(['nodeId']);
  });

  it('滑块区间覆盖 Turbo(8)与其它(30)', () => {
    expect(EDIT_STEPS_MIN).toBeLessThanOrEqual(8);
    expect(EDIT_STEPS_MAX).toBeGreaterThanOrEqual(30);
  });
});
