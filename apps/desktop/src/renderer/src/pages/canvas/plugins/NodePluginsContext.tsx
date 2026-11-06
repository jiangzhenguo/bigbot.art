import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { NodePluginCatalogItem, NodePluginDefinition } from '@bigbotart/shared';
import type { NodeTag } from '../types';

export interface NodePluginCatalogState {
  items: NodePluginCatalogItem[];
  loading: boolean;
  error?: string;
}

export interface NodePluginsContextValue {
  /** 全量定义：已有节点的停用/缺失展示需要保留停用项。 */
  definitions: NodePluginDefinition[];
  /** 仅启用定义可进入新建面板与运行/接力集合。 */
  enabledTags: NodeTag[];
  definitionFor: (kind: string | undefined) => NodePluginDefinition | undefined;
  /** 受控 UI(picker)的清单数据，按节点 kind 索引。 */
  catalogFor: (kind: string | undefined) => NodePluginCatalogState | undefined;
  loading: boolean;
  error: string | null;
}

const emptyDefinitionFor = () => undefined;
const emptyCatalogFor = () => undefined;
const NodePluginsContext = createContext<NodePluginsContextValue>({
  definitions: [],
  enabledTags: [],
  definitionFor: emptyDefinitionFor,
  catalogFor: emptyCatalogFor,
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
  const [catalogs, setCatalogs] = useState<Record<string, NodePluginCatalogState>>({});

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

  // 受控 UI(picker)的数据源:只有声明了 ui 的节点才需要清单,按 kind 一次性拉取。
  useEffect(() => {
    const withUi = definitions.filter((definition) => definition.enabled && definition.ui);
    if (withUi.length === 0) {
      setCatalogs({});
      return;
    }
    let alive = true;
    void Promise.all(withUi.map(async (definition) => {
      try {
        const result = await window.bigbotart.nodePluginCatalog(definition.kind);
        return [
          definition.kind,
          result.ok
            ? { items: result.catalog.items, loading: false }
            : { items: [], loading: false, error: result.error },
        ] as const;
      } catch (cause: unknown) {
        return [
          definition.kind,
          { items: [], loading: false, error: cause instanceof Error ? cause.message : String(cause) },
        ] as const;
      }
    })).then((entries) => {
      if (!alive) return;
      setCatalogs(Object.fromEntries(entries));
    });
    return () => {
      alive = false;
    };
  }, [definitions]);

  const value = useMemo<NodePluginsContextValue>(() => {
    const byKind = new Map<string, NodePluginDefinition>(definitions.map((definition) => [definition.kind, definition]));
    return {
      definitions,
      enabledTags: enabledNodeTags(definitions),
      definitionFor: (kind) => kind ? byKind.get(kind) : undefined,
      catalogFor: (kind) => (kind ? catalogs[kind] : undefined),
      loading,
      error,
    };
  }, [definitions, catalogs, loading, error]);

  return <NodePluginsContext.Provider value={value}>{children}</NodePluginsContext.Provider>;
}

export function useNodePlugins(): NodePluginsContextValue {
  return useContext(NodePluginsContext);
}
