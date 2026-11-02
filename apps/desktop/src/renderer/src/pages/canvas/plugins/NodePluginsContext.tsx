import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { NodePluginDefinition } from '@bigbotart/shared';
import type { NodeTag } from '../types';

export interface NodePluginsContextValue {
  /** 全量定义：已有节点的停用/缺失展示需要保留停用项。 */
  definitions: NodePluginDefinition[];
  /** 仅启用定义可进入新建面板与运行/接力集合。 */
  enabledTags: NodeTag[];
  definitionFor: (kind: string | undefined) => NodePluginDefinition | undefined;
  loading: boolean;
  error: string | null;
}

const emptyDefinitionFor = () => undefined;
const NodePluginsContext = createContext<NodePluginsContextValue>({
  definitions: [],
  enabledTags: [],
  definitionFor: emptyDefinitionFor,
  loading: false,
  error: null,
});

export function nodeTagForPlugin(definition: NodePluginDefinition): NodeTag {
  return {
    id: definition.kind,
    kind: definition.kind,
    name: definition.title,
    sub: definition.description,
    definition,
  };
}

export function enabledNodeTags(definitions: NodePluginDefinition[]): NodeTag[] {
  return definitions.filter((definition) => definition.enabled).map(nodeTagForPlugin);
}

/** 画布级唯一定义来源；节点卡/检查器只读 Context，不各自发 IPC。 */
export function NodePluginsProvider({ children }: { children: React.ReactNode }) {
  const [definitions, setDefinitions] = useState<NodePluginDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.bigbotart.listNodePlugins().then(
      (items) => {
        if (!alive) return;
        setDefinitions(items);
        setError(null);
        setLoading(false);
      },
      (cause: unknown) => {
        if (!alive) return;
        setDefinitions([]);
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const value = useMemo<NodePluginsContextValue>(() => {
    const byKind = new Map<string, NodePluginDefinition>(definitions.map((definition) => [definition.kind, definition]));
    return {
      definitions,
      enabledTags: enabledNodeTags(definitions),
      definitionFor: (kind) => kind ? byKind.get(kind) : undefined,
      loading,
      error,
    };
  }, [definitions, loading, error]);

  return <NodePluginsContext.Provider value={value}>{children}</NodePluginsContext.Provider>;
}

export function useNodePlugins(): NodePluginsContextValue {
  return useContext(NodePluginsContext);
}
