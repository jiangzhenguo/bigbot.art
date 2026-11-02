import type { NodePluginDefinition, NodePluginRunResult } from '@bigbotart/shared';
import type { CanvasNode } from '../types';
import { basenameOf } from '../media';

/** 插件成功结果的纯投影，供 setNodes updater 使用；不在 updater 内做 IPC/ref 操作。 */
export function pluginRunSuccess(
  node: CanvasNode,
  definition: NodePluginDefinition,
  result: NodePluginRunResult,
): CanvasNode {
  const resultPath = result.resultPath ?? '';
  const primary = definition.outputs.find((output) => output.primary) ?? definition.outputs[0];
  return {
    ...node,
    running: false,
    ghost: false,
    stale: false,
    badge: undefined,
    extra: `✓ ${basenameOf(resultPath)}`,
    data: {
      ...(node.data ?? {}),
      resultPath,
      currentTakeId: result.takeId,
      ...(primary ? { mediaType: primary.media } : {}),
      __plugin: { id: definition.pluginId, version: definition.pluginVersion },
    },
  };
}

export function pluginRunFailure(node: CanvasNode, message: string): CanvasNode {
  return { ...node, running: false, ghost: false, badge: `插件失败 · ${message}` };
}
