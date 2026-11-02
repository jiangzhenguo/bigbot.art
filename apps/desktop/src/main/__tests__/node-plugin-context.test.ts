import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NODE_PLUGIN_API_VERSION,
  publicNodePluginDefinition,
  type NodePluginManifest,
} from '@bigbotart/shared';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-plugin-context-'));
process.env.BIGBOTART_HOME = tmpHome;
let MemoryStore: typeof import('../memory').MemoryStore;

beforeAll(async () => {
  ({ MemoryStore } = await import('../memory'));
});
afterAll(() => rmSync(tmpHome, { recursive: true, force: true }));

const manifest: NodePluginManifest = {
  apiVersion: NODE_PLUGIN_API_VERSION,
  id: 'acme-media',
  version: '1.0.0',
  displayName: 'Acme 媒体工具',
  nodes: [{
    kind: 'audio-extract', title: '音频提取', description: '从视频中提取音轨',
    inputs: [{ id: 'input-video', label: '输入视频', media: 'video', cardinality: 'single', required: true }],
    outputs: [{ id: 'audio', label: '音频', media: 'audio', cardinality: 'single', required: true, primary: true }],
    defaultData: { format: 'wav' },
    parametersSchema: { type: 'object', properties: { format: { type: 'string', default: 'wav' } } },
    executor: 'runtime/index.js',
  }],
};
const definition = publicNodePluginDefinition(manifest, manifest.nodes[0]!);

describe('Agent 系统提示的插件发现', () => {
  it('buildContext 注入启用插件的精确 kind 和通用工具说明', () => {
    const memory = new MemoryStore();
    const ctx = memory.buildContext('p', 'c', '提取声音', undefined, undefined, { nodePlugins: [definition] });
    expect(ctx.systemPrompt).toContain('【已安装插件节点】');
    expect(ctx.systemPrompt).toContain(definition.kind);
    expect(ctx.systemPrompt).toContain('plugins.read');
  });

  it('停用或缺失插件不进入 Agent 能力说明', () => {
    const memory = new MemoryStore();
    const disabled = memory.buildContext('p', 'c', '继续', undefined, undefined, {
      nodePlugins: [{ ...definition, enabled: false }],
    });
    expect(disabled.systemPrompt).not.toContain('【已安装插件节点】');
    const none = memory.buildContext('p', 'c', '继续');
    expect(none.systemPrompt).not.toContain('【已安装插件节点】');
  });
});
