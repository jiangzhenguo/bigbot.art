import type { NodePluginDefinition } from '@bigbotart/shared';
import type { PluginResultMedia } from './PluginResultPreview';

export interface PluginAvailability {
  readOnly: boolean;
  message: string | null;
}

/** 缺失和停用都只读；已有 data、连线和产物不由展示层修改。 */
export function pluginAvailability(definition: NodePluginDefinition | undefined): PluginAvailability {
  if (!definition) return { readOnly: true, message: '插件缺失 · 仅可查看已有参数与产物' };
  if (definition.enabled === false) return { readOnly: true, message: '插件已停用 · 仅可查看已有参数与产物' };
  return { readOnly: false, message: null };
}

export function pluginPortSummary(port: NodePluginDefinition['inputs'][number]): string {
  const label = 'label' in port && typeof port.label === 'string' && port.label ? port.label : port.id;
  const cardinality = port.cardinality === 'multiple' ? '多值' : '单值';
  return `${label} · ${port.media} · ${cardinality}${port.required ? ' · 必填' : ''}`;
}

/** 主输出决定预览类型；定义缺失时仍按已有产物扩展名尽量保留预览。 */
export function pluginResultMedia(
  definition: NodePluginDefinition | undefined,
  resultPath: string,
): PluginResultMedia {
  const primary = definition?.outputs.find((output) => output.primary) ?? definition?.outputs[0];
  if (primary && isPluginResultMedia(primary.media)) return primary.media;
  if (/\.(png|jpe?g|webp|gif|avif)$/i.test(resultPath)) return 'image';
  if (/\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(resultPath)) return 'video';
  if (/\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(resultPath)) return 'audio';
  return 'document';
}

function isPluginResultMedia(media: string): media is PluginResultMedia {
  return media === 'image' || media === 'video' || media === 'audio' || media === 'document';
}
