import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { NodePluginDefinition } from '@bigbotart/shared';
import { isDesktopShell } from '../api/shell';
import { useT } from '../i18n';

export interface NodePluginGroup {
  pluginId: string;
  displayName: string;
  version: string;
  nodeCount: number;
  enabled: boolean;
  error?: string;
}

/** 将节点定义按插件聚合；同一插件的错误只展示一次，启停状态取所有节点的交集。 */
export function groupNodePlugins(definitions: readonly NodePluginDefinition[]): NodePluginGroup[] {
  const groups = new Map<string, NodePluginGroup & { errors: string[] }>();
  for (const definition of definitions) {
    const current = groups.get(definition.pluginId);
    if (!current) {
      groups.set(definition.pluginId, {
        pluginId: definition.pluginId,
        displayName: definition.pluginDisplayName,
        version: definition.pluginVersion,
        nodeCount: 1,
        enabled: definition.enabled,
        ...(definition.error ? { error: definition.error } : {}),
        errors: definition.error ? [definition.error] : [],
      });
      continue;
    }
    current.nodeCount += 1;
    current.enabled = current.enabled && definition.enabled;
    if (definition.error && !current.errors.includes(definition.error)) {
      current.errors.push(definition.error);
      current.error = current.errors.join('\n');
    }
  }
  return [...groups.values()].map(({ errors: _errors, ...group }) => group);
}

type NodePluginActionResult = { ok: boolean; canceled?: boolean; error?: string };

/** 取消目录选择不是失败；其它失败优先保留主进程返回的真实错误。 */
export function nodePluginActionError(result: NodePluginActionResult, fallback: string): string | null {
  if (result.ok || result.canceled) return null;
  return result.error ?? fallback;
}

type BusyAction = 'install' | 'refresh' | 'toggle' | 'remove' | null;

export interface NodePluginsSettingsViewProps {
  groups: readonly NodePluginGroup[];
  loading: boolean;
  busy: BusyAction;
  error: string | null;
  onInstall: () => void;
  onRefresh: () => void;
  onToggle: (plugin: NodePluginGroup) => void;
  onRemove: (plugin: NodePluginGroup) => void;
}

/** 纯展示组件：不读取 window.bigbotart，所有操作由容器注入。 */
export function NodePluginsSettingsView({
  groups,
  loading,
  busy,
  error,
  onInstall,
  onRefresh,
  onToggle,
  onRemove,
}: NodePluginsSettingsViewProps): React.ReactElement {
  const t = useT();
  const disabled = busy !== null;
  return (
    <>
      <div className="gh">
        <b>{t('节点插件')}</b>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-g btn-sm"
          data-od-id="settings-node-plugins-refresh"
          disabled={disabled || loading}
          onClick={onRefresh}
        >
          {busy === 'refresh' ? t('刷新中…') : t('刷新')}
        </button>
        <button
          type="button"
          className="btn btn-p btn-sm"
          data-od-id="settings-node-plugins-install"
          disabled={disabled || loading}
          onClick={onInstall}
        >
          {busy === 'install' ? t('安装中…') : t('安装本地插件…')}
        </button>
      </div>
      <div className="srow" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <b>{t('可信本地代码')}</b>
          <div className="sub">{t('仅安装可信本地插件；执行代码在主进程运行，不会加载第三方 React UI')}</div>
          {error ? (
            <div
              className="sub"
              role="alert"
              data-od-id="settings-node-plugins-error"
              style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap' }}
            >
              {error}
            </div>
          ) : null}
        </div>
      </div>
      {loading ? (
        <div className="srow">
          <span className="spin" />
          <span className="mut">{t('正在读取节点插件…')}</span>
        </div>
      ) : groups.length === 0 ? (
        <div className="srow">
          <div className="grow mut">{t('尚未安装节点插件')}</div>
        </div>
      ) : (
        groups.map((plugin) => (
          <div
            className="mdl-row"
            key={plugin.pluginId}
            data-od-id={`settings-node-plugin-${plugin.pluginId}`}
            style={{ alignItems: 'flex-start', flexWrap: 'wrap', flex: 'none' }}
          >
            <div className="grow" style={{ minWidth: 0 }}>
              <b>{plugin.displayName}</b>
              <div className="sub mono">
                v{plugin.version} · {t('{n} 个节点', { n: plugin.nodeCount })} · {plugin.pluginId}
              </div>
              {plugin.error ? (
                <div
                  className="sub"
                  role="alert"
                  data-od-id={`settings-node-plugin-error-${plugin.pluginId}`}
                  style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap' }}
                >
                  {plugin.error}
                </div>
              ) : null}
            </div>
            <span className={`badge${plugin.error ? ' err' : plugin.enabled ? ' ok' : ''}`}>
              {plugin.error
                ? `${t('异常')} · ${plugin.enabled ? t('已启用') : t('已停用')}`
                : plugin.enabled ? t('已启用') : t('已停用')}
            </span>
            <button
              type="button"
              className="btn btn-s btn-sm"
              role="switch"
              aria-checked={plugin.enabled}
              data-od-id={`settings-node-plugin-toggle-${plugin.pluginId}`}
              disabled={disabled}
              onClick={() => onToggle(plugin)}
            >
              {plugin.enabled ? t('停用') : t('启用')}
            </button>
            <button
              type="button"
              className="btn btn-s btn-sm"
              data-od-id={`settings-node-plugin-remove-${plugin.pluginId}`}
              style={{ color: 'var(--danger)' }}
              disabled={disabled}
              onClick={() => onRemove(plugin)}
            >
              {busy === 'remove' ? t('移除中…') : t('移除')}
            </button>
          </div>
        ))
      )}
    </>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 设置页容器：独占 IPC、确认、刷新与卸载保护。 */
export default function NodePluginsSettings(): React.ReactElement | null {
  const t = useT();
  const desktop = isDesktopShell();
  const [definitions, setDefinitions] = useState<NodePluginDefinition[]>([]);
  const [loading, setLoading] = useState(desktop);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const mounted = useRef(false);
  const busyRef = useRef<BusyAction>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.bigbotart.listNodePlugins();
      if (!mounted.current) return;
      setDefinitions(next);
      setLoadError(null);
    } catch (error) {
      if (mounted.current) setLoadError(errorText(error));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!desktop) return;
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [desktop, refresh]);

  const runAction = async (
    action: Exclude<BusyAction, 'refresh' | null>,
    fallback: string,
    invoke: () => Promise<NodePluginActionResult>,
  ): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = action;
    setBusy(action);
    setActionError(null);
    try {
      const result = await invoke();
      if (!mounted.current) return;
      const message = nodePluginActionError(result, fallback);
      if (message) setActionError(message);
    } catch (error) {
      if (mounted.current) setActionError(errorText(error));
    } finally {
      // 成功、失败及取消目录选择后都以主进程当前列表为准。
      await refresh();
      if (mounted.current) {
        busyRef.current = null;
        setBusy(null);
      }
    }
  };

  const install = (): void => {
    void runAction('install', t('安装插件失败'), () => window.bigbotart.installNodePlugin());
  };

  const manualRefresh = async (): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = 'refresh';
    setBusy('refresh');
    setActionError(null);
    await refresh();
    if (mounted.current) {
      busyRef.current = null;
      setBusy(null);
    }
  };

  const toggle = (plugin: NodePluginGroup): void => {
    void runAction(
      'toggle',
      plugin.enabled ? t('停用插件失败') : t('启用插件失败'),
      () => window.bigbotart.setNodePluginEnabled(plugin.pluginId, !plugin.enabled),
    );
  };

  const remove = (plugin: NodePluginGroup): void => {
    if (busyRef.current) return;
    const confirmed = window.confirm(
      t('确定移除「{name}」吗？\n\n仅移除插件注册，不会删除插件文件或已生成的产物。', { name: plugin.displayName }),
    );
    if (!confirmed) return;
    void runAction('remove', t('移除插件失败'), () => window.bigbotart.removeNodePlugin(plugin.pluginId));
  };

  if (!desktop) return null;
  return (
    <NodePluginsSettingsView
      groups={groupNodePlugins(definitions)}
      loading={loading}
      busy={busy}
      error={actionError ?? loadError}
      onInstall={install}
      onRefresh={() => void manualRefresh()}
      onToggle={toggle}
      onRemove={remove}
    />
  );
}
