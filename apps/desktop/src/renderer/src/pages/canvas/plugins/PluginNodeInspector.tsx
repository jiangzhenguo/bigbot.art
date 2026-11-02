import React, { useId } from 'react';
import {
  normalizeNodePluginData,
  validateNodePluginData,
  type NodePluginDefinition,
} from '@bigbotart/shared';
import type { CanvasNode } from '../types';
import { PluginField } from './fields';
import { pluginAvailability } from './utils';

export interface PluginNodeInspectorProps {
  node: CanvasNode;
  definition?: NodePluginDefinition;
  setData: (patch: Record<string, unknown>) => void;
  runNode: (nodeId: string) => void;
  isRunning?: boolean;
}

/** 纯参数分派助手：只在可运行时调用容器注入的运行入口。 */
export function dispatchPluginRun(
  nodeId: string,
  runNode: (nodeId: string) => void,
  disabled: boolean,
): void {
  if (!disabled) runNode(nodeId);
}

export function PluginNodeInspector({
  node,
  definition,
  setData,
  runNode,
  isRunning = false,
}: PluginNodeInspectorProps) {
  const formId = useId();
  const availability = pluginAvailability(definition);
  const values = definition
    ? normalizeNodePluginData(node.data ?? {}, definition.parametersSchema)
    : {};
  const validation = definition
    ? validateNodePluginData(values, definition.parametersSchema)
    : null;
  const errors = validation && !validation.ok ? validation.errors : [];
  const properties = definition?.parametersSchema.properties ?? {};
  const required = new Set(definition?.parametersSchema.required ?? []);
  const disabled = availability.readOnly || isRunning || errors.length > 0;

  return (
    <div
      data-od-id="plugin-node-inspector"
      data-plugin-kind={definition?.kind ?? node.kind ?? 'plugin'}
      data-readonly={availability.readOnly ? 'true' : 'false'}
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <div style={{ flex: 'none' }}>
        <div style={{ color: 'var(--fg)', fontSize: 12, fontWeight: 600 }}>
          {definition?.title || node.title}
        </div>
        {definition?.description ? (
          <div className="mut" style={{ fontSize: 11, lineHeight: 1.5, marginTop: 4 }}>
            {definition.description}
          </div>
        ) : null}
        {definition ? (
          <div className="mono mut" style={{ fontSize: 10, marginTop: 4 }}>
            {definition.pluginDisplayName} · v{definition.pluginVersion}
          </div>
        ) : null}
      </div>

      {availability.message ? (
        <div
          data-od-id="plugin-inspector-readonly"
          role="status"
          style={{ flex: 'none', color: 'var(--warn)', fontSize: 11, lineHeight: 1.5 }}
        >
          {availability.message}
        </div>
      ) : null}

      {definition ? (
        <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {Object.entries(properties).length ? Object.entries(properties).map(([name, schema]) => (
            <PluginField
              key={name}
              name={name}
              schema={schema}
              value={values[name]}
              required={required.has(name)}
              readOnly={availability.readOnly}
              controlId={`${formId}-${name}`}
              error={errorAtPath(errors, name)}
              onChange={(value) => setData({ [name]: value })}
            />
          )) : (
            <div className="mut" style={{ fontSize: 11 }}>此插件无可配置参数</div>
          )}
        </div>
      ) : (
        <pre
          data-od-id="plugin-inspector-raw-data"
          aria-label="已有节点参数（只读）"
          className="mono"
          style={{
            flex: 'none',
            margin: 0,
            padding: 10,
            maxHeight: 240,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            color: 'var(--muted)',
            background: 'var(--surface-warm)',
            border: '1px solid var(--border-soft)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 10,
          }}
        >
          {JSON.stringify(node.data ?? {}, null, 2)}
        </pre>
      )}

      {errors.length ? (
        <div data-od-id="plugin-validation-summary" role="alert" style={{ flex: 'none', color: 'var(--danger)', fontSize: 11 }}>
          请先修正 {errors.length} 个参数错误
        </div>
      ) : null}

      <button
        type="button"
        className="btn btn-s btn-sm"
        data-od-id="plugin-run-node"
        disabled={disabled}
        title={availability.message ?? (errors.length ? '请先修正参数错误' : undefined)}
        onClick={() => dispatchPluginRun(node.id, runNode, disabled)}
        style={{ flex: 'none', width: '100%' }}
      >
        {isRunning ? '运行中…' : '运行插件'}
      </button>
    </div>
  );
}

function errorAtPath(errors: Array<{ path: string; message: string }>, name: string): string | undefined {
  return errors.find((error) => error.path === name || error.path === `/${name}` || error.path === `$.${name}`)?.message;
}
