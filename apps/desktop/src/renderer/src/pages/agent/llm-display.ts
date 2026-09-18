import type { AppSettings, LlmSource } from '@bigbotart/shared';

/** LLM 来源 → 面板显示名(与模型选择器 ModelOption.name 的命名规则保持一致) */
export function llmDisplayName(src: LlmSource | null | undefined, settings: AppSettings | null): string {
  if (!src) return 'Ornith-1.5-35B · 本地';
  switch (src.kind) {
    case 'cloud': {
      const prov = settings?.cloudProviders?.find((p) => p.id === src.provider);
      const mid = src.model ?? prov?.models[0] ?? '';
      return `${mid} · ${prov?.name ?? src.provider}`;
    }
    case 'lmstudio':
      return `${src.model ?? settings?.lmStudioModel ?? '默认模型'} · 本地`;
    case 'ollama':
    case 'mlx-provider':
      return `${src.model ?? '默认模型'} · 本地`;
    case 'openai-compatible':
      return `${src.model ?? '默认模型'} · 自定义端点`;
    case 'none':
      return '未配置 LLM';
  }
}
