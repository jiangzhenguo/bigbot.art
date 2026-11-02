import { beforeEach, describe, expect, it } from 'vitest';
import {
  NODE_PLUGIN_API_VERSION,
  publicNodePluginDefinition,
  type CanvasSnapshot,
  type NodePluginManifest,
} from '@bigbotart/shared';
import { ToolHandlers } from '../tool-handlers';

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
      properties: { format: { type: 'string', enum: ['wav', 'mp3'], default: 'wav' } },
    },
    executor: 'runtime/index.js',
  }],
};
const definition = publicNodePluginDefinition(manifest, manifest.nodes[0]!);
const ctx = { projectId: 'p', canvasId: 'c' };

let canvas: CanvasSnapshot;
let runCalls: string[];
let manager: {
  listDefinitions(opts?: { includeDisabled?: boolean }): typeof definition[];
  listInstalled(): unknown[];
  run(req: { nodeId: string }): Promise<{ ok: true; nodeId: string; resultPath: string; takeId: string }>;
};

function makeHandlers(): ToolHandlers {
  const store = {
    loadProjectCanvases: () => ({ projectId: 'p', canvasId: 'c', canvases: [canvas], activeCanvasId: 'c' }),
    saveCanvasSnapshot: () => ({ ok: true }),
  };
  return new ToolHandlers(
    store as never,
    { get: () => undefined } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { nodePlugins: manager as never },
  );
}

beforeEach(() => {
  canvas = {
    id: 'c', projectId: 'p', name: '测试画布', nodes: [], edges: [], version: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  runCalls = [];
  manager = {
    listDefinitions: () => [definition],
    listInstalled: () => [{ id: 'acme-media', version: '1.0.0', displayName: 'Acme 媒体工具', enabled: true, nodes: [definition] }],
    run: async (req) => {
      runCalls.push(req.nodeId);
      return { ok: true, nodeId: req.nodeId, resultPath: '/tmp/audio.wav', takeId: 'take-1' };
    },
  };
});

describe('Agent 节点插件发现与通用工具', () => {
  it('plugins.list/read 返回真实 kind 与完整 Schema', async () => {
    const h = makeHandlers();
    const listed = await h.call('plugins.list', {}, ctx);
    expect(listed.ok).toBe(true);
    expect(listed.result).toContain(definition.kind);
    const read = await h.call('plugins.read', { kind: definition.kind }, ctx);
    expect(read.ok).toBe(true);
    expect(read.result).toContain('parametersSchema');
    expect(read.result).toContain('input-video');
  });

  it('canvas.create_node 应用插件默认参数与身份元数据', async () => {
    const h = makeHandlers();
    const res = await h.call('canvas.create_node', { kind: definition.kind }, ctx);
    expect(res.ok).toBe(true);
    expect(canvas.nodes).toHaveLength(1);
    expect(canvas.nodes[0]).toMatchObject({ kind: definition.kind, label: '音频提取' });
    expect(canvas.nodes[0]!.data).toMatchObject({
      format: 'wav', mediaType: 'audio', __plugin: { id: 'acme-media', version: '1.0.0' },
    });
  });

  it('未知插件 kind 和非法参数都明确拒绝，不留下半建成节点', async () => {
    const h = makeHandlers();
    const unknown = await h.call('canvas.create_node', { kind: 'plugin:acme-media:not-real' }, ctx);
    expect(unknown.ok).toBe(false);
    expect(unknown.result).toContain('plugins.list');
    const invalid = await h.call('canvas.create_node', { kind: definition.kind, data: { format: 'flac' } }, ctx);
    expect(invalid.ok).toBe(false);
    expect(invalid.result).toContain('参数不合法');
    expect(canvas.nodes).toHaveLength(0);
  });

  it('canvas.connect 使用插件 manifest 的输入端口', async () => {
    const created = await makeHandlers().call('canvas.create_node', { kind: definition.kind }, ctx);
    canvas.nodes.push({
      id: 'shot-1', kind: 'shot', label: '镜头 01', position: { x: 0, y: 0 },
      data: { resultPath: '/tmp/shot.mp4' } as never,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const h = makeHandlers();
    const res = await h.call('canvas.connect', {
      from: 'shot-1', to: created.nodeId, label: 'input-video',
    }, ctx);
    expect(res.ok).toBe(true);
    expect(canvas.edges[0]).toMatchObject({ source: 'shot-1', target: created.nodeId, label: 'input-video' });
  });

  it('engine.submit 进入统一插件执行器，不落入 h3c/Provider 路由', async () => {
    const created = await makeHandlers().call('canvas.create_node', { kind: definition.kind }, ctx);
    const h = makeHandlers();
    const res = await h.call('engine.submit', { nodeId: created.nodeId }, ctx);
    expect(res.ok).toBe(true);
    expect(res.result).toContain('已完成');
    expect(runCalls).toEqual([created.nodeId]);
  });

  it.each(['plugin:bad', 'plugin:acme:bad:extra', 'totally-unknown'])('非法/未知 kind %s 不会落入内置节点默认路径', async (kind) => {
    const h = makeHandlers();
    const res = await h.call('canvas.create_node', { kind }, ctx);
    expect(res.ok).toBe(false);
    expect(canvas.nodes).toHaveLength(0);
  });

  it('停用定义不能创建或读取为可用能力', async () => {
    manager.listDefinitions = () => [{ ...definition, enabled: false }];
    const h = makeHandlers();
    const created = await h.call('canvas.create_node', { kind: definition.kind }, ctx);
    expect(created.ok).toBe(false);
    expect(created.result).toContain('停用');
    const read = await h.call('plugins.read', { kind: definition.kind }, ctx);
    expect(read.ok).toBe(false);
  });
});
