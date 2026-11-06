import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { NodePluginDefinition } from '@bigbotart/shared';
import type { CanvasNode } from '../types.js';
import { PluginNodeBody } from './PluginNodeBody.js';
import { dispatchPluginRun, PluginNodeInspector } from './PluginNodeInspector.js';
import { PluginResultPreview } from './PluginResultPreview.js';
import { isPluginTextSchema, parsePluginNumber } from './fields.js';
import { pluginAvailability, pluginPortSummary, pluginResultMedia } from './utils.js';

function definition(over: Partial<NodePluginDefinition> = {}): NodePluginDefinition {
  return {
    kind: 'plugin:acme:audio-extract',
    localKind: 'audio-extract',
    pluginId: 'acme',
    pluginVersion: '1.2.0',
    pluginDisplayName: 'Acme 媒体工具',
    enabled: true,
    title: '音频提取',
    description: '从视频中提取音轨',
    inputs: [{ id: 'input-video', label: '输入视频', media: 'video', cardinality: 'single', required: true }],
    outputs: [{ id: 'audio', label: '音轨', media: 'audio', cardinality: 'single', required: true, primary: true }],
    defaultData: {},
    parametersSchema: { type: 'object', properties: {} },
    executor: 'runtime/index.js',
    ...over,
  };
}

function node(over: Partial<CanvasNode> = {}): CanvasNode {
  return { id: 'node-1', title: '画布节点', w: 236, x: 0, y: 0, kind: 'plain', data: {}, ...over };
}

function render<P extends object>(Component: React.FunctionComponent<P>, props: P): string {
  return renderToStaticMarkup(React.createElement(Component, props));
}

const noop = () => undefined;

describe('PluginNodeBody · 定义投影与主产物', () => {
  it('卡片只保留主输出预览，不重复显示标题、说明和端口摘要', () => {
    const html = render(PluginNodeBody, {
      node: node({ data: { resultPath: '/tmp/.bigbotart/outputs/audio/result.wav' } }),
      definition: definition(),
    });
    expect(html).toContain('data-od-id="plugin-node-body"');
    expect(html).not.toContain('data-od-id="plugin-node-title"');
    expect(html).not.toContain('data-od-id="plugin-node-description"');
    expect(html).not.toContain('data-od-id="plugin-node-inputs"');
    expect(html).not.toContain('data-od-id="plugin-node-outputs"');
    expect(html).not.toContain('从视频中提取音轨');
    expect(html).not.toContain('输入视频 · video · 单值 · 必填');
    expect(html).toContain('主产物');
    expect(html).toContain('data-od-id="plugin-result-audio"');
    expect(html).toContain('bba-output://audio/result.wav');
    expect(html).toContain('result.wav');
  });

  it('缺失和停用状态明确只读，且不改写已有产物', () => {
    const missing = render(PluginNodeBody, { node: node(), definition: undefined });
    const disabled = render(PluginNodeBody, { node: node(), definition: definition({ enabled: false }) });
    expect(missing).toContain('插件缺失');
    expect(missing).toContain('data-readonly="true"');
    expect(disabled).toContain('插件已停用');
    expect(disabled).toContain('data-readonly="true"');
  });

  it('主输出媒体优先于扩展名；定义缺失时按扩展名兜底', () => {
    const audio = definition();
    expect(pluginResultMedia(audio, '/tmp/outputs/misleading.png')).toBe('audio');
    expect(pluginResultMedia(undefined, '/tmp/outputs/a.webp')).toBe('image');
    expect(pluginResultMedia(undefined, '/tmp/outputs/a.mp4')).toBe('video');
    expect(pluginResultMedia(undefined, '/tmp/outputs/a.md')).toBe('document');
  });

  it('四类产物均走对应展示组件', () => {
    for (const [media, path, marker] of [
      ['image', '/tmp/outputs/a.png', '<img'],
      ['video', '/tmp/outputs/a.mp4', '<video'],
      ['audio', '/tmp/outputs/a.wav', '<audio'],
      ['document', '/tmp/outputs/a.md', 'plugin-result-document'],
    ] as const) {
      const html = render(PluginResultPreview, { path, media, title: '测试插件' });
      expect(html).toContain(marker);
    }
  });
});

describe('PluginNodeInspector · Schema 表单', () => {
  it('渲染 string/number/integer/boolean/enum，并只在内存中应用 default', () => {
    const setData = vi.fn();
    const runNode = vi.fn();
    const html = render(PluginNodeInspector, {
      node: node(),
      definition: definition({
        parametersSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', title: '提示词', default: '默认提示词' },
            story: { type: 'string', format: 'text', title: '多行文本', default: '多行默认' },
            ratio: { type: 'number', title: '比例', default: 0.5 },
            count: { type: 'integer', title: '数量', default: 3 },
            enabled: { type: 'boolean', title: '启用', default: true },
            format: { type: 'string', title: '格式', enum: ['wav', 'mp3'], default: 'wav' },
          },
        },
      }),
      setData,
      runNode,
    });
    expect(html).toContain('value="默认提示词"');
    expect(html).toContain('<textarea');
    expect(html).toContain('多行默认</textarea>');
    expect(html).toContain('value="0.5"');
    expect(html).toContain('value="3"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
    expect(html).toContain('<select');
    expect(html).toContain('>wav</option>');
    expect(html).toContain('>mp3</option>');
    expect(setData).not.toHaveBeenCalled();
    expect(runNode).not.toHaveBeenCalled();
  });

  it('明确显示必填、整数和范围错误，并阻止运行', () => {
    const html = render(PluginNodeInspector, {
      node: node({ data: { count: 1.5, ratio: 11 } }),
      definition: definition({
        parametersSchema: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt: { type: 'string', title: '提示词' },
            count: { type: 'integer', title: '数量', minimum: 1, maximum: 5 },
            ratio: { type: 'number', title: '比例', minimum: 0, maximum: 10 },
          },
        },
      }),
      setData: noop,
      runNode: noop,
    });
    expect(html).toContain('缺少必填参数 prompt');
    expect(html).toContain('必须是 integer 类型');
    expect(html).toContain('不能大于 10');
    expect(html).toContain('data-od-id="plugin-validation-summary"');
    expect(html).toMatch(/data-od-id="plugin-run-node"[^>]*disabled/);
  });

  it('停用后保留表单但禁用控件，缺失时只读展示原始 data', () => {
    const disabled = render(PluginNodeInspector, {
      node: node(),
      definition: definition({
        enabled: false,
        parametersSchema: { type: 'object', properties: { prompt: { type: 'string' } } },
      }),
      setData: noop,
      runNode: noop,
    });
    expect(disabled).toContain('插件已停用');
    expect(disabled).toMatch(/<input[^>]*disabled=""[^>]*data-od-id="plugin-field-prompt"/);

    const missing = render(PluginNodeInspector, {
      node: node({ data: { prompt: '保留内容' } }),
      definition: undefined,
      setData: noop,
      runNode: noop,
    });
    expect(missing).toContain('plugin-inspector-raw-data');
    expect(missing).toContain('保留内容');
    expect(missing).toMatch(/data-od-id="plugin-run-node"[^>]*disabled/);
  });

  it('运行分派只调用注入的 runNode，disabled 时不触发', () => {
    const runNode = vi.fn();
    dispatchPluginRun('node-1', runNode, true);
    expect(runNode).not.toHaveBeenCalled();
    dispatchPluginRun('node-1', runNode, false);
    expect(runNode).toHaveBeenCalledExactlyOnceWith('node-1');
  });
});

describe('插件 UI 纯助手', () => {
  it('端口摘要和可用性由定义驱动', () => {
    const d = definition();
    expect(pluginPortSummary(d.inputs[0]!)).toBe('输入视频 · video · 单值 · 必填');
    expect(pluginAvailability(d).readOnly).toBe(false);
    expect(pluginAvailability({ ...d, enabled: false }).readOnly).toBe(true);
  });

  it('数字输入不产生 NaN，text 提示选择多行文本', () => {
    expect(parsePluginNumber('')).toBeUndefined();
    expect(parsePluginNumber('abc')).toBeUndefined();
    expect(parsePluginNumber('1.25')).toBe(1.25);
    expect(isPluginTextSchema({ type: 'string' })).toBe(false);
    expect(isPluginTextSchema({ type: 'string', format: 'text' })).toBe(true);
  });
});
