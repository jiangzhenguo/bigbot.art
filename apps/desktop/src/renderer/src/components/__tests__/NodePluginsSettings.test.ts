import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { NodePluginDefinition } from '@bigbotart/shared';
import NodePluginsSettings, {
  groupNodePlugins,
  nodePluginActionError,
  NodePluginsSettingsView,
} from '../NodePluginsSettings';
import { I18nProvider } from '../../i18n';

function definition(over: Partial<NodePluginDefinition> = {}): NodePluginDefinition {
  return {
    kind: 'plugin:acme:image-clean',
    localKind: 'image-clean',
    pluginId: 'acme',
    pluginVersion: '1.2.0',
    pluginDisplayName: 'Acme 图像工具',
    enabled: true,
    title: '图像清理',
    description: '清理图像',
    inputs: [],
    outputs: [],
    defaultData: {},
    parametersSchema: { type: 'object', properties: {} },
    executor: 'runtime/index.js',
    ...over,
  };
}

const noop = (): void => undefined;

describe('NodePluginsSettings · 插件分组', () => {
  it('按 pluginId 聚合名称、版本、节点数和启停状态', () => {
    const groups = groupNodePlugins([
      definition(),
      definition({ kind: 'plugin:acme:image-resize', localKind: 'image-resize' }),
      definition({
        kind: 'plugin:other:video-info',
        localKind: 'video-info',
        pluginId: 'other',
        pluginDisplayName: '其它工具',
        pluginVersion: '2.0.0',
        enabled: false,
      }),
    ]);
    expect(groups).toEqual([
      {
        pluginId: 'acme',
        displayName: 'Acme 图像工具',
        version: '1.2.0',
        nodeCount: 2,
        enabled: true,
      },
      {
        pluginId: 'other',
        displayName: '其它工具',
        version: '2.0.0',
        nodeCount: 1,
        enabled: false,
      },
    ]);
  });

  it('组内任一节点停用则整组停用，并去重保留真实错误', () => {
    const groups = groupNodePlugins([
      definition({ enabled: false, error: 'manifest.json 读取失败' }),
      definition({ kind: 'plugin:acme:image-resize', localKind: 'image-resize', enabled: false, error: 'manifest.json 读取失败' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ nodeCount: 2, enabled: false, error: 'manifest.json 读取失败' });
  });
});

describe('NodePluginsSettingsView', () => {
  it('展示版本、节点数、状态、错误、安全提示及全部管理入口', () => {
    const view = React.createElement(NodePluginsSettingsView, {
      groups: [{
        pluginId: 'acme',
        displayName: 'Acme 图像工具',
        version: '1.2.0',
        nodeCount: 3,
        enabled: false,
        error: '执行入口不存在',
      }],
      loading: false,
      busy: null,
      error: null,
      onInstall: noop,
      onRefresh: noop,
      onToggle: noop,
      onRemove: noop,
    });
    const html = renderToStaticMarkup(
      React.createElement(I18nProvider, { lang: 'zh-CN', setLang: noop, children: view }),
    );
    expect(html).toContain('Acme 图像工具');
    expect(html).toContain('v1.2.0');
    expect(html).toContain('3 个节点');
    expect(html).toContain('已停用');
    expect(html).toContain('执行入口不存在');
    expect(html).toContain('仅安装可信本地插件；执行代码在主进程运行，不会加载第三方 React UI');
    expect(html).toContain('data-od-id="settings-node-plugins-install"');
    expect(html).toContain('data-od-id="settings-node-plugins-refresh"');
    expect(html).toContain('data-od-id="settings-node-plugin-toggle-acme"');
    expect(html).toContain('data-od-id="settings-node-plugin-remove-acme"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
  });

  it('取消目录选择不生成错误，真实安装失败原样显示', () => {
    expect(nodePluginActionError({ ok: false, canceled: true, error: '用户取消' }, '安装失败')).toBeNull();
    expect(nodePluginActionError({ ok: false, error: 'manifest 校验失败: nodes 为空' }, '安装失败')).toBe('manifest 校验失败: nodes 为空');
    expect(nodePluginActionError({ ok: true }, '安装失败')).toBeNull();
  });

  it('网页端不渲染插件安装与管理界面', () => {
    vi.stubGlobal('window', { bigbotartShell: false });
    try {
      expect(renderToStaticMarkup(React.createElement(NodePluginsSettings))).toBe('');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
