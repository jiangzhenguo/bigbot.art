import { describe, expect, it } from 'vitest';
import {
  NODE_PLUGIN_API_VERSION,
  allowedPortLabels,
  deriveShotRefsFromEdges,
  publicNodePluginDefinition,
  validateEdge,
  type EdgeNodeMin,
  type NodePluginManifest,
} from '../index';

const manifest: NodePluginManifest = {
  apiVersion: NODE_PLUGIN_API_VERSION,
  id: 'acme-media',
  version: '1.0.0',
  displayName: 'Acme 媒体工具',
  nodes: [{
    kind: 'audio-extract',
    title: '音频提取',
    description: '从视频中提取音轨',
    inputs: [{ id: 'input-video', label: '输入视频', media: 'video', cardinality: 'single', required: true }],
    outputs: [{ id: 'audio', label: '音频', media: 'audio', cardinality: 'single', required: true, primary: true }],
    defaultData: { format: 'wav' },
    parametersSchema: {
      type: 'object',
      properties: { format: { type: 'string', enum: ['wav'], default: 'wav' } },
    },
    executor: 'runtime/index.js',
  }],
};

const definition = publicNodePluginDefinition(manifest, manifest.nodes[0]!);
const pluginNode: EdgeNodeMin = {
  id: 'plugin-1',
  kind: definition.kind,
  label: '音轨',
  data: { format: 'wav', mediaType: 'audio', resultPath: '/outputs/audio.wav' },
};
const videoNode: EdgeNodeMin = { id: 'video-1', kind: 'shot', label: '镜头', data: { resultPath: '/outputs/shot.mp4' } };
const imageNode: EdgeNodeMin = { id: 'image-1', kind: 'image-gen', label: '图片', data: { resultPath: '/outputs/image.png' } };
const shotTarget: EdgeNodeMin = { id: 'shot-2', kind: 'shot', label: '下游镜头', data: {} };
const opts = { nodePlugins: [definition] };

describe('插件节点连线与媒体矩阵', () => {
  it('视频产物可以连接插件声明的视频输入', () => {
    expect(allowedPortLabels(videoNode, definition.kind, opts)).toEqual(['input-video']);
    const res = validateEdge([videoNode, pluginNode], [], {
      source: videoNode.id,
      target: pluginNode.id,
      label: 'input-video',
    }, opts);
    expect(res.ok).toBe(true);
  });

  it('图片产物不能冒充插件的视频输入', () => {
    expect(allowedPortLabels(imageNode, definition.kind, opts)).toEqual([]);
    const res = validateEdge([imageNode, pluginNode], [], {
      source: imageNode.id,
      target: pluginNode.id,
      label: 'input-video',
    }, opts);
    expect(res.ok).toBe(false);
    expect(res.errors[0]?.message).toContain('不被允许');
  });

  it('插件单值输入冲突返回可替换语义', () => {
    const secondVideo: EdgeNodeMin = { ...videoNode, id: 'video-2' };
    const res = validateEdge([secondVideo, pluginNode], [{
      source: 'video-1', target: pluginNode.id, label: 'input-video',
    }], {
      source: secondVideo.id,
      target: pluginNode.id,
      label: 'input-video',
    }, opts);
    expect(res.ok).toBe(false);
    expect(res.errors[0]?.replaceable).toBe(true);
  });

  it('插件音频产物可复用资产规则连接镜头 ref-audio，但不能作为 ref-video', () => {
    expect(allowedPortLabels(pluginNode, 'shot', opts)).toContain('ref-audio');
    expect(allowedPortLabels(pluginNode, 'shot', opts)).not.toContain('ref-video');
    expect(validateEdge([pluginNode, shotTarget], [], {
      source: pluginNode.id, target: shotTarget.id, label: 'ref-audio',
    }, opts).ok).toBe(true);
  });

  it('停用插件不允许建立新边', () => {
    const disabled = { ...definition, enabled: false };
    expect(allowedPortLabels(videoNode, definition.kind, { nodePlugins: [disabled] })).toEqual([]);
  });

  it('shot 引用派生读取插件音频的真实 resultPath', () => {
    const refs = deriveShotRefsFromEdges([pluginNode, shotTarget], [{
      source: pluginNode.id, target: shotTarget.id, label: 'ref-audio',
    }], shotTarget.id);
    expect(refs).toEqual([{ path: '/outputs/audio.wav', role: 'ref-audio', auto: true }]);
  });
});
