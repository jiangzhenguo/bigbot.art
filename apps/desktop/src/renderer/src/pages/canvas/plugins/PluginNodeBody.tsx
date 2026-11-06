import React from 'react';
import type { NodePluginDefinition } from '@bigbotart/shared';
import type { CanvasNode } from '../types';
import { basenameOf } from '../media';
import { PluginResultPreview } from './PluginResultPreview';
import { pluginAvailability, pluginResultMedia } from './utils';

export interface PluginNodeBodyProps {
  node: CanvasNode;
  definition?: NodePluginDefinition;
}

/** 通用插件节点卡：定义只用于展示，不在这里归一化或改写节点数据。 */
export function PluginNodeBody({ node, definition }: PluginNodeBodyProps) {
  const title = definition?.title || node.title;
  const resultPath = typeof node.data?.resultPath === 'string' ? node.data.resultPath : '';
  const availability = pluginAvailability(definition);

  return (
    <div
      className="nb plugin-node-body"
      data-od-id="plugin-node-body"
      data-plugin-kind={definition?.kind ?? node.kind ?? 'plugin'}
      data-readonly={availability.readOnly ? 'true' : 'false'}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      {availability.message ? (
        <div
          data-od-id="plugin-node-readonly"
          role="status"
          style={{ flex: 'none', color: 'var(--warn)', fontSize: 11, lineHeight: 1.5 }}
        >
          {availability.message}
        </div>
      ) : null}

      {resultPath ? (
        <div style={{ flex: 'none' }}>
          <PluginResultPreview
            path={resultPath}
            media={pluginResultMedia(definition, resultPath)}
            title={title}
          />
          <div className="nmeta mono" data-od-id="plugin-node-result-name">
            主产物 · {basenameOf(resultPath)}
          </div>
        </div>
      ) : definition?.outputs.length ? (
        <div className="nmeta mono" data-od-id="plugin-node-result-empty" style={{ flex: 'none', marginTop: 0 }}>
          主产物 · 尚未生成
        </div>
      ) : null}
    </div>
  );
}
