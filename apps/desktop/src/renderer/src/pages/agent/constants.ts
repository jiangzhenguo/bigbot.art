import type { ModelOption } from './types';

/** 模型选择器兜底项(任何时候都有「全局默认」可回退) */
export const MODEL_OPTION_FALLBACK: ModelOption[] = [
  { name: '全局默认', sub: '跟随设置页 LLM 来源', reset: true },
];

/** 输入区技能快选(与设计稿 skills.js 一致) */
export const COMPOSER_SKILLS = ['纸拼贴剧情片', '剧情短片', '电商产品', '科普讲解', '水墨'];
