import React from 'react';
import type { NodePluginDefinition } from '@bigbotart/shared';
import type { CanvasNode } from '../types';
import { basenameOf } from '../media';
import { PluginResultPreview } from './PluginResultPreview';
import { pluginAvailability, pluginPortSummary, pluginResultMedia } from './utils';

export interface PluginNodeBodyProps {
  node: CanvasNode;
  definition?: NodePluginDefinition;
}

/** 通用插件节点卡：定义只用于展示，不在这里归一化或改写节点数据。 */
export function PluginNodeBody({ node, definition }: PluginNodeBodyProps) {
  const title = definition?.title || node.title;
  const description = definition?.description || node.extra || '';
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
      <div style={{ flex: 'none' }}>
        <div data-od-id="plugin-node-title" style={{ color: 'var(--fg)', fontSize: 12, fontWeight: 600 }}>
          {title}
        </div>
        {description ? (
          <p data-od-id="plugin-node-description" style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.5, margin: '4px 0 0' }}>
            {description}
          </p>
        ) : null}
      </div>

      {availability.message ? (
        <div
          data-od-id="plugin-node-readonly"
          role="status"
          style={{ flex: 'none', color: 'var(--warn)', fontSize: 11, lineHeight: 1.5 }}
        >
          {availability.message}
        </div>
      ) : null}

      {definition ? (
        <div style={{ flex: 'none', display: 'grid', gap: 5 }}>
          <PluginPortList label="输入" ports={definition.inputs} odId="plugin-node-inputs" />
          <PluginPortList label="输出" ports={definition.outputs} odId="plugin-node-outputs" />
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

function PluginPortList({
  label,
  ports,
  odId,
}: {
  label: string;
  ports: NodePluginDefinition['inputs'];
  odId: string;
}) {
  return (
    <section data-od-id={odId} aria-label={`插件${label}`}>
      <div className="nmeta mono" style={{ margin: 0, color: 'var(--fg)' }}>
        {label} · {ports.length}
      </div>
      {ports.length ? ports.map((port) => (
        <div key={port.id} className="nmeta mono" style={{ margin: 0 }} title={pluginPortSummary(port)}>
          <span style={{ overflowWrap: 'anywhere' }}>{pluginPortSummary(port)}</span>
          {'primary' in port && port.primary ? <span style={{ color: 'var(--accent)' }}> · 主产物</span> : null}
        </div>
      )) : (
        <div className="nmeta mono" style={{ margin: 0 }}>无声明{label}</div>
      )}
    </section>
  );
}
