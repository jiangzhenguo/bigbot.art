/**
 * Qwen3-TTS VoiceDesign 的「音色类型」与语言枚举(单一事实源)。
 *
 * 引擎侧(`mlxgen voice-design --list-voice-profiles`)内置 6 个 profile,
 * 它们就是产品意义上的「声音类型」:沉稳男旁白 / 温暖女旁白 / 纪录片 / 新闻播音 /
 * 温柔气声女声 / 明亮年轻声线。描述文字来自引擎内置定义,必须与引擎保持一致
 * —— 这里只用于 UI 提示,真正下发的是 `voiceProfile` id(由引擎解析描述)。
 */
import type { TtsLanguage, TtsVoiceMode } from './domain';

export interface TtsVoiceProfile {
  /** 引擎 profile id(下发给 `--voice-profile`) */
  id: string;
  /** 中文显示名(音色类型) */
  label: string;
  /** 中文说明(UI 副标题) */
  hint: string;
  /** 引擎内置英文描述(仅用于展示/自定义预填,不下发) */
  description: string;
}

export const QWEN3_TTS_PROFILES: TtsVoiceProfile[] = [
  {
    id: 'narrator-male',
    label: '沉稳男旁白',
    hint: '低沉温暖 · 平稳不急',
    description: 'a deep, warm male narrator voice, steady and unhurried',
  },
  {
    id: 'narrator-female',
    label: '温暖女旁白',
    hint: '三十多岁 · 平静清晰',
    description: 'a warm female narrator voice in her thirties, calm and clear',
  },
  {
    id: 'documentary',
    label: '纪录片解说',
    hint: '低沉克制 · 略带沙哑',
    description: 'a calm male documentary voice, low and measured, with a hint of gravel',
  },
  {
    id: 'news-anchor',
    label: '新闻播音',
    hint: '中性专业 · 吐字清楚',
    description: 'a clear female news-anchor voice, neutral and professional',
  },
  {
    id: 'warm-female',
    label: '温柔女声',
    hint: '气声 · 带笑意',
    description: 'a gentle female voice with a warm, slightly breathy timbre, smiling',
  },
  {
    id: 'energetic-young',
    label: '明亮年轻',
    hint: '语速偏快 · 有活力',
    description: 'a bright, energetic young voice, quick and enthusiastic',
  },
];

export const QWEN3_TTS_LANGUAGES: Array<{ id: TtsLanguage; label: string }> = [
  { id: 'auto', label: '自动识别' },
  { id: 'chinese', label: '中文' },
  { id: 'english', label: 'English' },
  { id: 'japanese', label: '日本語' },
  { id: 'korean', label: '한국어' },
  { id: 'german', label: 'Deutsch' },
  { id: 'french', label: 'Français' },
  { id: 'russian', label: 'Русский' },
  { id: 'portuguese', label: 'Português' },
  { id: 'spanish', label: 'Español' },
  { id: 'italian', label: 'Italiano' },
];

/** 音色模式缺省值(存量节点没有该字段时按 clone 处理) */
export function normalizeVoiceMode(v: unknown): TtsVoiceMode {
  return v === 'design' ? 'design' : 'clone';
}

/** 该 profile id 是否是引擎内置的音色类型 */
export function isBuiltinVoiceProfile(id: string | undefined | null): boolean {
  return Boolean(id) && QWEN3_TTS_PROFILES.some((p) => p.id === id);
}
