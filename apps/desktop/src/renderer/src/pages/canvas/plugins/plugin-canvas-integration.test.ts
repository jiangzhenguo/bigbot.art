import { describe, expect, it } from 'vitest';
import type { NodePluginDefinition } from '@bigbotart/shared';
import type { CanvasNode, Edge } from '../types.js';
import { enabledNodeTags, nodeTagForPlugin } from './NodePluginsContext.js';
import { deriveEdgeLabel, makeInitialData } from '../node-mapping.js';
import { guardEdge, resolvePortOptions } from '../connectors.js';
import { computeEdgeDerivations } from '../edge-dispatch.js';
import { directDownstreamGenIds, isCascadeRunnable, pickCascadeTargets } from '../cascade.js';
import { pluginRunFailure, pluginRunSuccess } from './plugin-run.js';

function definition(over: Partial<NodePluginDefinition> = {}): NodePluginDefinition {
  return {
    kind: 'plugin:acme:main',
    localKind: 'main',
    pluginId: 'acme',
    pluginVersion: '1.0.0',
    pluginDisplayName: 'Acme',
    enabled: true,
    title: '插件节点',
    description: '测试插件',
    inputs: [],
    outputs: [{ id: 'out', label: '主产物', media: 'image', cardinality: 'single', required: true, primary: true }],
    defaultData: {},
    parametersSchema: { type: 'object', properties: {} },
    executor: 'runtime/index.js',
    ...over,
  };
}

function node(id: string, kind: string, data: Record<string, unknown> = {}): CanvasNode {
  return { id, title: id, w: 220, x: 0, y: 0, kind: kind as CanvasNode['kind'], data };
}

function edge(from: string, to: string, label?: string): Edge {
  return { from, to, cls: '', label };
}

const targetDefinition = definition({
  kind: 'plugin:acme:target',
  localKind: 'target',
  title: '目标插件',
  inputs: [
    { id: 'source-image', label: '来源图片', media: 'image', cardinality: 'single', required: true },
    { id: 'source-video', label: '来源视频', media: 'video', cardinality: 'multiple', required: false },
  ],
  outputs: [],
});

describe('插件注册与默认 data', () => {
  it('NodeTag 携带定义，只有 enabled 标签进入新建面板', () => {
    const enabled = definition();
    const disabled = definition({ kind: 'plugin:acme:disabled', localKind: 'disabled', enabled: false });
    const tag = nodeTagForPlugin(enabled);
    expect(tag.id).toBe(enabled.kind);
    expect(tag.definition).toBe(enabled);
    expect(enabledNodeTags([enabled, disabled]).map((item) => item.id)).toEqual([enabled.kind]);
  });

  it('makeInitialData 校验 defaultData、应用 schema default 并写 mediaType/__plugin', () => {
    const d = definition({
      defaultData: { prompt: '来自默认', unknown: '剔除' },
      parametersSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          count: { type: 'integer', default: 2 },
        },
      },
    });
    expect(makeInitialData(nodeTagForPlugin(d))).toEqual({
      prompt: '来自默认',
      count: 2,
      mediaType: 'image',
      __plugin: { id: 'acme', version: '1.0.0' },
    });
  });

  it('非法默认参数明确失败，不创建带坏参数的节点', () => {
    const d = definition({
      defaultData: { count: 99 },
      parametersSchema: { type: 'object', properties: { count: { type: 'integer', maximum: 5 } } },
    });
    expect(() => makeInitialData(nodeTagForPlugin(d))).toThrow('不能大于 5');
  });
});

describe('插件连线与权威校验', () => {
  it('目标插件按输入声明和媒体过滤端口，guardEdge 使用同一批定义', () => {
    const src = node('img', 'image-gen', { resultPath: '/o/a.png' });
    const dst = node('target', targetDefinition.kind);
    const opts = resolvePortOptions(src, targetDefinition.kind, [targetDefinition]);
    expect(opts.map((item) => item.port)).toEqual(['source-image']);
    expect(opts[0]?.desc).toContain('来源图片');
    expect(deriveEdgeLabel(src, nodeTagForPlugin(targetDefinition), undefined, [targetDefinition])).toBe('source-image');
    expect(guardEdge(src, dst, 'source-image', [src, dst], [], [targetDefinition]).ok).toBe(true);
    expect(guardEdge(src, dst, 'source-video', [src, dst], [], [targetDefinition]).ok).toBe(false);
  });

  it('停用目标或停用/缺失来源插件不出现在可连接集合', () => {
    const src = node('img', 'image-gen');
    expect(resolvePortOptions(src, targetDefinition.kind, [{ ...targetDefinition, enabled: false }])).toEqual([]);
    const pluginSource = node('p', 'plugin:acme:main', { mediaType: 'image' });
    expect(resolvePortOptions(pluginSource, 'shot', [])).toEqual([]);
    expect(resolvePortOptions(pluginSource, 'shot', [definition({ enabled: false })])).toEqual([]);
  });

  it('插件 image/video/audio 主产物复用现有下游端口', () => {
    const image = definition();
    const video = definition({ kind: 'plugin:acme:video', localKind: 'video', outputs: [{ ...definition().outputs[0]!, media: 'video' }] });
    const audio = definition({ kind: 'plugin:acme:audio', localKind: 'audio', outputs: [{ ...definition().outputs[0]!, media: 'audio' }] });
    const defs = [image, video, audio];
    expect(resolvePortOptions(node('pi', image.kind, { mediaType: 'image' }), 'shot', defs).map((o) => o.port)).toContain('first-frame');
    expect(resolvePortOptions(node('pv', video.kind, { mediaType: 'video' }), 'grab', defs).map((o) => o.port)).toContain('input-video');
    expect(resolvePortOptions(node('pa', audio.kind, { mediaType: 'audio' }), 'shot', defs).map((o) => o.port)).toContain('ref-audio');
  });
});

describe('插件主产物边派生', () => {
  it('图片插件参与 shot 首帧和 image-edit 输入，目标插件不写派生态', () => {
    const source = node('p', 'plugin:acme:main', { mediaType: 'image', resultPath: '/o/plugin.png' });
    const shot = node('s', 'shot', { mode: 'text2video', refs: [] });
    const edit = node('e', 'image-edit');
    const target = node('t', targetDefinition.kind, { untouched: true });
    const result = computeEdgeDerivations(
      [source, shot, edit, target],
      [edge('p', 's', 'first-frame'), edge('p', 'e', 'input'), edge('p', 't', 'source-image')],
    );
    const shotData = result.nextNodes.find((n) => n.id === 's')?.data as { refs: unknown[]; mode: string };
    expect(shotData.refs).toContainEqual({ path: '/o/plugin.png', role: 'first-frame', auto: true });
    expect(shotData.mode).toBe('first-frame');
    expect((result.nextNodes.find((n) => n.id === 'e')?.data as { inputImageFrom?: unknown }).inputImageFrom).toEqual({ nodeId: 'p' });
    expect(result.nextNodes.find((n) => n.id === 't')).toBe(target);
  });

  it('视频插件参与 ref-video、视频增强与 timeline；音频插件参与 ref-audio 与 timeline', () => {
    const videoDef = definition({ kind: 'plugin:acme:video', localKind: 'video' });
    const audioDef = definition({ kind: 'plugin:acme:audio', localKind: 'audio' });
    const video = node('v', videoDef.kind, { mediaType: 'video', resultPath: '/o/v.mp4' });
    const audio = node('a', audioDef.kind, { mediaType: 'audio', resultPath: '/o/a.wav' });
    const shot = node('s', 'shot', { refs: [] });
    const upscale = node('u', 'video-upscale');
    const timeline = node('tl', 'timeline');
    const result = computeEdgeDerivations(
      [video, audio, shot, upscale, timeline],
      [edge('v', 's', 'ref-video'), edge('a', 's', 'ref-audio'), edge('v', 'u', 'input'), edge('v', 'tl', 'clip'), edge('a', 'tl', 'audio-track')],
    );
    const refs = (result.nextNodes.find((n) => n.id === 's')?.data as { refs: unknown[] }).refs;
    expect(refs).toContainEqual({ path: '/o/v.mp4', role: 'ref-video', auto: true });
    expect(refs).toContainEqual({ path: '/o/a.wav', role: 'ref-audio', auto: true });
    expect((result.nextNodes.find((n) => n.id === 'u')?.data as { inputVideoFrom?: unknown }).inputVideoFrom).toEqual({ nodeId: 'v' });
    expect((result.nextNodes.find((n) => n.id === 'tl')?.data as { shotNodeIds?: string[] }).shotNodeIds).toEqual(['v', 'a']);
  });
});

describe('插件运行与接力', () => {
  it('只有当前启用定义可进入 cascade', () => {
    const enabled = definition();
    const disabled = definition({ kind: 'plugin:acme:disabled', localKind: 'disabled', enabled: false });
    const nodes = [node('s', 'shot'), node('ok', enabled.kind), node('off', disabled.kind), node('missing', 'plugin:acme:missing')];
    const edges = [edge('s', 'ok'), edge('s', 'off'), edge('s', 'missing')];
    expect(isCascadeRunnable(nodes[1]!, [enabled, disabled])).toBe(true);
    expect(isCascadeRunnable(nodes[2]!, [enabled, disabled])).toBe(false);
    expect(directDownstreamGenIds('s', nodes, edges, [enabled, disabled])).toEqual(['ok']);
    expect(pickCascadeTargets('s', nodes, edges, { isBusy: () => false }, [enabled, disabled])).toEqual(['ok']);
  });

  it('成功投影回写主产物/Take/身份并清运行态，失败投影保留明确错误', () => {
    const original = node('p', 'plugin:acme:main', { prompt: 'x' });
    const running = { ...original, running: true, ghost: true, badge: '插件运行中…' };
    const succeeded = pluginRunSuccess(running, definition(), { ok: true, nodeId: 'p', resultPath: '/o/p.png', takeId: 'take-1' });
    expect(succeeded).toMatchObject({ running: false, ghost: false, stale: false, badge: undefined });
    expect(succeeded.data).toMatchObject({ resultPath: '/o/p.png', currentTakeId: 'take-1', mediaType: 'image', __plugin: { id: 'acme', version: '1.0.0' } });
    expect(running.data).toEqual({ prompt: 'x' });
    expect(pluginRunFailure(running, 'boom')).toMatchObject({ running: false, badge: '插件失败 · boom' });
  });

  it('CanvasPage 在任何内置运行分支前拦截 plugin: 并调用专用 IPC', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'CanvasPage.tsx'), 'utf8');
    const branch = src.indexOf("if (n.kind?.startsWith('plugin:'))");
    expect(branch).toBeGreaterThanOrEqual(0);
    expect(src.indexOf("if (n.kind === 'image-crop')", branch)).toBeGreaterThan(branch);
    expect(src.indexOf('window.bigbotart.submitRender', branch)).toBeGreaterThan(branch);
    expect(src).toContain('window.bigbotart.runNodePlugin({ projectId, canvasId: activeCanvasId, nodeId })');
    const contextSrc = fs.readFileSync(path.join(__dirname, 'NodePluginsContext.tsx'), 'utf8');
    expect(contextSrc.match(/listNodePlugins\(/g)).toHaveLength(1);
  });
});
