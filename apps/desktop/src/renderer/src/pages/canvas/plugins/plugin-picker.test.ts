import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { NodePluginCatalogItem, NodePluginDefinition, NodePluginUiDeclaration } from '@bigbotart/shared';
import type { CanvasNode } from '../types.js';
import { PluginNodeInspector } from './PluginNodeInspector.js';
import { PluginPicker } from './PluginPicker.js';
import {
  filterPickerItems,
  pickerFacetValues,
  pickerSelectedItem,
  pickerSelectionPatch,
  pickerTabItems,
  pickerTabs,
} from './picker-logic.js';

function ui(over: Partial<NodePluginUiDeclaration> = {}): NodePluginUiDeclaration {
  return {
    type: 'picker',
    title: '姿势选择器',
    valueParam: 'pose',
    variantParam: 'angle',
    variantField: 'angle',
    catalog: 'catalog/poses.json',
    searchFields: ['id', 'label'],
    filterFields: ['system', 'category'],
    tabField: 'angle',
    thumbnailField: 'thumb',
    ...over,
  };
}

function item(over: Partial<NodePluginCatalogItem> = {}): NodePluginCatalogItem {
  return {
    id: 'stand-front',
    label: '站立',
    fields: { system: '人体', category: '站姿', angle: '正面' },
    ...over,
  };
}

const items: NodePluginCatalogItem[] = [
  item({ id: 'stand-front', label: '站立', thumb: 'bba-plugin://pose/1.0.0/catalog/thumbs/a.png' }),
  item({ id: 'stand-side', label: '侧身站立', fields: { system: '人体', category: '站姿', angle: '侧面' } }),
  item({ id: 'walk-front', label: '行走', fields: { system: '动物', category: '动姿', angle: '正面' } }),
];

function render<P extends object>(Component: React.FunctionComponent<P>, props: P): string {
  return renderToStaticMarkup(React.createElement(Component, props));
}

const noop = () => {};

function definition(over: Partial<NodePluginDefinition> = {}): NodePluginDefinition {
  return {
    kind: 'plugin:pose-tools:pose-selector',
    localKind: 'pose-selector',
    pluginId: 'pose-tools',
    pluginVersion: '1.0.0',
    pluginDisplayName: '姿势工具',
    enabled: true,
    title: '姿势选择',
    description: '从姿势库中选择姿势与视角',
    inputs: [],
    outputs: [{ id: 'image', label: '结果图', media: 'image', cardinality: 'single', required: true, primary: true }],
    defaultData: {},
    parametersSchema: {
      type: 'object',
      properties: {
        pose: { type: 'string', title: '姿势' },
        angle: { type: 'string', title: '视角' },
        seed: { type: 'number', title: '种子' },
      },
    },
    executor: 'runtime/index.mjs',
    ...over,
  };
}

function node(over: Partial<CanvasNode> = {}): CanvasNode {
  return { id: 'node-1', title: '姿势节点', w: 236, x: 0, y: 0, kind: 'plugin:pose-tools:pose-selector', data: {}, ...over };
}

describe('picker 纯逻辑 · 搜索 / 筛选 / 分组', () => {
  it('搜索命中名称与 ID', () => {
    expect(filterPickerItems(items, ui(), '行走', {}).map((row) => row.id)).toEqual(['walk-front']);
    expect(filterPickerItems(items, ui(), 'stand', {}).map((row) => row.id)).toEqual(['stand-front', 'stand-side']);
    expect(filterPickerItems(items, ui(), '', {})).toHaveLength(3);
  });

  it('筛选按字段精确匹配，可叠加', () => {
    expect(filterPickerItems(items, ui(), '', { system: '人体' }).map((row) => row.id))
      .toEqual(['stand-front', 'stand-side']);
    expect(filterPickerItems(items, ui(), '', { system: '人体', category: '站姿' }).map((row) => row.id))
      .toEqual(['stand-front', 'stand-side']);
    expect(filterPickerItems(items, ui(), '', { system: '人体', category: '动姿' })).toHaveLength(0);
  });

  it('分组 tab 取自 tabField，facet 值去重且保持顺序', () => {
    expect(pickerTabs(items, ui())).toEqual(['正面', '侧面']);
    expect(pickerFacetValues(items, ui(), 'system')).toEqual(['人体', '动物']);
    expect(pickerTabItems(items, ui(), '正面').map((row) => row.id)).toEqual(['stand-front', 'walk-front']);
    expect(pickerTabs(items, ui({ tabField: undefined }))).toEqual([]);
  });

  it('选中项按 id 匹配，回写 valueParam 与 variantParam', () => {
    expect(pickerSelectedItem(items, ui(), 'stand-side')?.label).toBe('侧身站立');
    expect(pickerSelectedItem(items, ui(), undefined)).toBeUndefined();
    expect(pickerSelectionPatch(ui(), items[1]!)).toEqual({ pose: 'stand-side', angle: '侧面' });
    // 没给 variantField 时回退到 tabField
    expect(pickerSelectionPatch(ui({ variantField: undefined }), items[0]!)).toEqual({ pose: 'stand-front', angle: '正面' });
  });
});

describe('PluginPicker · 宿主渲染的通用选择器', () => {
  it('渲染搜索、筛选、网格、tab 与选中预览', () => {
    const html = render(PluginPicker, {
      ui: ui(),
      items,
      value: 'stand-front',
      readOnly: false,
      onSelect: () => undefined,
    });
    expect(html).toContain('data-od-id="plugin-picker"');
    expect(html).toContain('data-od-id="plugin-picker-search"');
    expect(html).toContain('data-od-id="plugin-picker-filter-system"');
    expect(html).toContain('data-od-id="plugin-picker-filter-category"');
    expect(html).toContain('data-od-id="plugin-picker-item-stand-front"');
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('bba-plugin://pose/1.0.0/catalog/thumbs/a.png');
    expect(html).toContain('data-od-id="plugin-picker-tab-正面"');
    expect(html).toContain('data-od-id="plugin-picker-preview"');
  });

  it('只读态不渲染可选交互，且缺图条目降级为文字卡片', () => {
    const html = render(PluginPicker, {
      ui: ui(),
      items,
      value: undefined,
      readOnly: true,
      onSelect: () => undefined,
    });
    expect(html).toContain('disabled');
    expect(html).toContain('data-od-id="plugin-picker-preview-empty"');
    // 没有缩略图的条目不渲染 <img>
    expect(html).not.toContain('stand-side.png');
  });
});

describe('PluginNodeInspector · 受控 UI 接管参数', () => {
  it('渲染选择器，并隐藏由选择器接管的原生字段', () => {
    const html = render(PluginNodeInspector, {
      node: node({ data: { pose: 'stand-front', angle: '正面' } }),
      definition: definition({ ui: ui() }),
      catalog: { items },
      setData: vi.fn(),
      runNode: vi.fn(),
    });
    expect(html).toContain('data-od-id="plugin-picker"');
    // pose / angle 由选择器接管，不再渲染成下拉框
    expect(html).not.toContain('plugin-field-pose');
    expect(html).not.toContain('plugin-field-angle');
    // 其余参数仍走原生控件
    expect(html).toContain('plugin-field-seed');
    expect(html).toContain('data-od-id="plugin-run-node"');
  });

  it('清单加载失败时明确报错，不静默空列表', () => {
    const html = render(PluginNodeInspector, {
      node: node(),
      definition: definition({ ui: ui() }),
      catalog: { items: [], loading: false, error: '清单文件缺失: catalog/poses.json' },
      setData: vi.fn(),
      runNode: vi.fn(),
    });
    expect(html).toContain('data-od-id="plugin-picker-error"');
    expect(html).toContain('清单文件缺失');
  });
});

describe('picker 的 valueField 回写', () => {
  const valueUi = ui({ valueField: 'poseValue' });
  const valueItem = item({
    id: 'full_sexy_P001__front',
    label: 'S形站姿',
    fields: {
      system: '性感系',
      category: '站姿',
      angle: '正面',
      poseValue: 'full_sexy_P001 | 全身单人・性感系 | 站姿 | S形站姿・胯部侧顶',
    },
  });

  it('声明 valueField 时把该字段的值写进 valueParam', () => {
    expect(pickerSelectionPatch(valueUi, valueItem)).toEqual({
      pose: 'full_sexy_P001 | 全身单人・性感系 | 站姿 | S形站姿・胯部侧顶',
      angle: '正面',
    });
  });

  it('未声明 valueField 时仍然写条目 id', () => {
    expect(pickerSelectionPatch(ui(), items[0]!)).toEqual({ pose: 'stand-front', angle: '正面' });
  });

  it('按 valueField 的值匹配选中项', () => {
    const selected = pickerSelectedItem([valueItem], valueUi, 'full_sexy_P001 | 全身单人・性感系 | 站姿 | S形站姿・胯部侧顶');
    expect(selected?.id).toBe('full_sexy_P001__front');
    // 用条目 id 匹配不上（这正是 valueField 存在的理由）
    expect(pickerSelectedItem([valueItem], valueUi, 'full_sexy_P001__front')).toBeUndefined();
  });
});

describe('picker 参数尚未选择时的检查器提示', () => {
  it('提示去选择器里选，而不是报「参数错误」', () => {
    const html = render(PluginNodeInspector, {
      node: { id: 'n1', kind: 'plugin:pose-tools:pose-selector', title: '姿势选择', data: {}, x: 0, y: 0, w: 200, h: 120 } as CanvasNode,
      definition: definition({
        parametersSchema: {
          type: 'object',
          required: ['pose'],
          properties: {
            pose: { type: 'string', title: '姿势' },
            angle: { type: 'string', title: '视角' },
          },
        },
        ui: ui(),
      }),
      setData: noop,
      runNode: noop,
    });
    expect(html).toContain('请在「姿势选择器」中选择一项后再运行');
    expect(html).not.toContain('请先修正');
    expect(html).toMatch(/data-od-id="plugin-run-node"[^>]*disabled/);
  });

  it('其它参数真的写错了仍然报参数错误', () => {
    const html = render(PluginNodeInspector, {
      node: { id: 'n1', kind: 'plugin:pose-tools:pose-selector', title: '姿势选择', data: { count: 99 }, x: 0, y: 0, w: 200, h: 120 } as CanvasNode,
      definition: definition({
        parametersSchema: {
          type: 'object',
          required: ['pose'],
          properties: {
            pose: { type: 'string', title: '姿势' },
            count: { type: 'integer', title: '数量', maximum: 5 },
          },
        },
        ui: ui(),
      }),
      setData: noop,
      runNode: noop,
    });
    expect(html).toContain('请先修正 1 个参数错误');
  });
});

describe('picker 选中态 · 同一姿势的多视角条目', () => {
  const multiUi = ui({ valueField: 'poseValue' });
  const poseValue = 'full_sexy_P001 | 全身单人・性感系 | 站姿 | S形站姿・胯部侧顶';
  const multiItems: NodePluginCatalogItem[] = [
    item({ id: 'full_sexy_P001__front', label: 'S形站姿', fields: { angle: '正面', poseValue } }),
    item({ id: 'full_sexy_P001__side', label: 'S形站姿', fields: { angle: '侧面', poseValue } }),
    item({ id: 'full_sexy_P001__high', label: 'S形站姿', fields: { angle: '俯视', poseValue } }),
  ];

  it('按 value + variant 定位到正确视角的条目', () => {
    // 回归：poseValue 相同，只有 angle 不同；不带 variant 时永远命中第一条。
    expect(pickerSelectedItem(multiItems, multiUi, poseValue, '侧面')?.id).toBe('full_sexy_P001__side');
    expect(pickerSelectedItem(multiItems, multiUi, poseValue, '俯视')?.id).toBe('full_sexy_P001__high');
  });

  it('没有 variant 时退化为按 value 匹配第一条', () => {
    expect(pickerSelectedItem(multiItems, multiUi, poseValue)?.id).toBe('full_sexy_P001__front');
  });

  it('variant 对不上时仍能按 value 兜底，不让预览整个消失', () => {
    expect(pickerSelectedItem(multiItems, multiUi, poseValue, '不存在的视角')?.id).toBe('full_sexy_P001__front');
  });
});
