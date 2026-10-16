import type { ModelOption } from './types';

/** 模型选择器兜底项(任何时候都有「全局默认」可回退) */
export const MODEL_OPTION_FALLBACK: ModelOption[] = [
  { name: '全局默认', sub: '跟随设置页 LLM 来源', reset: true },
];

/** 输入区技能快选(名称需与内置 Skill.name 对齐) */
export const COMPOSER_SKILLS = [
  '极简产品广告生成器',
  '3D动画短片生成器',
  '品牌宣传短片生成器',
  '手绘实拍融合视频生成器',
  '音乐MV动态字幕生成器',
];
