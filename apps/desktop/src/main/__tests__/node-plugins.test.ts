import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type {
  Asset,
  CanvasNode,
  CanvasSnapshot,
  NodePluginManifest,
  Take,
} from '@bigbotart/shared';

// 所有模块级 DATA_DIR/OUTPUTS_DIR 都必须在动态 import 前指向临时目录。
const testHome = mkdtempSync(join(tmpdir(), 'bbart-node-plugins-'));
process.env.BIGBOTART_HOME = testHome;
process.env.BIGBOTART_DRYRUN = '1';

const { NodePluginManager } = await import('../node-plugins.js');
const { ProjectStore } = await import('../store.js');
const { validateNodePluginManifest } = await import('@bigbotart/shared');

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});

const SUCCESS_RUNTIME = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export async function execute(ctx) {
  writeFileSync(join(ctx.outputDir, 'captured.json'), JSON.stringify({
    parameters: ctx.parameters,
    inputs: ctx.inputs,
    projectId: ctx.projectId,
    canvasId: ctx.canvasId,
    nodeId: ctx.nodeId,
    dryRun: ctx.dryRun,
    contextKeys: Object.keys(ctx).sort(),
  }));
  ctx.log('临时执行器开始');
  ctx.reportProgress(50, '一半');
  writeFileSync(join(ctx.outputDir, 'audio.wav'), 'non-empty-audio');
  return {
    resultPath: 'audio.wav',
    data: { kind: 'plugin:attacker:changed', resultPath: '/fake', note: 'from-plugin' },
    outputs: { audio: 'audio.wav' },
  };
}
`;

function baseManifest(): NodePluginManifest {
  return {
    apiVersion: 'bigbotart.node-plugin/v1',
    id: 'test-plugin',
    version: '1.0.0',
    displayName: '临时测试插件',
    nodes: [{
      kind: 'audio-extract',
      title: '音频提取',
      description: '临时执行器，不做 AI 推理',
      inputs: [{
        id: 'input-video', label: '输入视频', media: 'video', cardinality: 'single', required: true,
      }],
      outputs: [{
        id: 'audio', label: '音频', media: 'audio', cardinality: 'single', required: true, primary: true,
      }],
      defaultData: { format: 'wav' },
      parametersSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['wav'], default: 'wav' },
        },
      },
      executor: 'runtime/index.mjs',
    }],
  };
}

function writePluginSource(
  caseRoot: string,
  runtime = SUCCESS_RUNTIME,
  mutate?: (manifest: NodePluginManifest) => void,
): { source: string; manifestPath: string; runtimePath: string } {
  const source = join(caseRoot, 'source');
  const manifestPath = join(source, 'manifest.json');
  const runtimePath = join(source, 'runtime', 'index.mjs');
  mkdirSync(dirname(runtimePath), { recursive: true });
  const manifest = baseManifest();
  mutate?.(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  writeFileSync(runtimePath, runtime);
  return { source, manifestPath, runtimePath };
}

class MemoryTakeStore {
  readonly rows: Take[] = [];
  private seq = 0;

  append(projectId: string, partial: Omit<Take, 'id' | 'attempt' | 'createdAt'>): Take {
    void projectId;
    const take: Take = {
      id: `take-${++this.seq}`,
      attempt: this.rows.filter((row) => row.shotNodeId === partial.shotNodeId).length + 1,
      createdAt: new Date().toISOString(),
      ...partial,
    };
    this.rows.push(take);
    return take;
  }

  async patch(projectId: string, takeId: string, patch: Partial<Take>): Promise<Take | null> {
    void projectId;
    const row = this.rows.find((item) => item.id === takeId);
    if (!row) return null;
    Object.assign(row, patch);
    if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'cancelled') {
      row.finishedAt = new Date().toISOString();
    }
    return row;
  }
}

function makeNode(id: string, kind: CanvasNode['kind'], data: Record<string, unknown>): CanvasNode {
  const now = new Date().toISOString();
  return { id, kind, label: id, position: { x: 0, y: 0 }, data, createdAt: now, updatedAt: now };
}

function makeHarness(pluginData: Record<string, unknown> = {}) {
  const caseRoot = mkdtempSync(join(testHome, 'case-'));
  const dataDir = join(caseRoot, 'data');
  const outputsDir = join(caseRoot, 'outputs');
  const store = new ProjectStore();
  const project = store.createProject('插件测试');
  const canvas = store.createCanvas(project.id, '主画布');
  const videoPath = join(caseRoot, 'input.mp4');
  writeFileSync(videoPath, 'fake-video-bytes');
  const asset: Asset = {
    id: 'video-1', kind: 'video', name: '输入视频', localPath: videoPath, tags: [], createdAt: new Date().toISOString(),
  };
  const assetMap = new Map([[asset.id, asset]]);
  const assets = { get: (id: string) => assetMap.get(id) };
  const takes = new MemoryTakeStore();
  const pluginNode = makeNode('plugin-node', 'plugin:test-plugin:audio-extract', pluginData);
  const assetNode = makeNode('asset-node', 'asset', { assetId: asset.id, mediaType: 'video' });
  canvas.nodes = [assetNode, pluginNode];
  canvas.edges = [{ id: 'edge-video', source: assetNode.id, target: pluginNode.id, label: 'input-video' }];
  expect(store.saveCanvasSnapshot(canvas).ok).toBe(true);
  const manager = new NodePluginManager({
    store,
    assets: assets as never,
    takes: takes as never,
    dataDir,
    outputsDir,
    logger: { log: () => {} },
  });
  return { caseRoot, dataDir, outputsDir, store, project, canvas, manager, takes, assets: assetMap, videoPath };
}

type Harness = ReturnType<typeof makeHarness>;

function mutateCanvas(h: Harness, mutate: (canvas: CanvasSnapshot) => void): void {
  const current = h.store.loadProjectCanvases(h.project.id).canvases.find((item) => item.id === h.canvas.id)!;
  mutate(current);
  expect(h.store.saveCanvasSnapshot(current).ok).toBe(true);
}

async function install(h: Harness, runtime = SUCCESS_RUNTIME): Promise<string> {
  const { source } = writePluginSource(h.caseRoot, runtime);
  const result = await h.manager.installFromFolder(source);
  expect(result).toEqual({ ok: true });
  return source;
}

function currentPluginNode(h: Harness): CanvasNode {
  const canvas = h.store.loadProjectCanvases(h.project.id).canvases.find((item) => item.id === h.canvas.id)!;
  return canvas.nodes.find((node) => node.id === 'plugin-node')!;
}

describe('NodePluginManager 安装与注册状态', () => {
  it('audio-extract 示例 manifest 符合真实共享契约', () => {
    const manifestPath = resolve('examples/node-plugins/audio-extract/manifest.json');
    const validated = validateNodePluginManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    expect(validated.ok).toBe(true);
  });

  it('版本化安装、不覆盖旧版本、不修改源目录，并可从 plugins.json 恢复', async () => {
    const h = makeHarness();
    const { source, manifestPath, runtimePath } = writePluginSource(h.caseRoot);
    expect(await h.manager.installFromFolder(source)).toEqual({ ok: true });
    const v1Dir = join(h.dataDir, 'plugins', 'test-plugin', '1.0.0');
    expect(existsSync(join(v1Dir, 'runtime', 'index.mjs'))).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(runtimePath)).toBe(true);
    expect(h.manager.listDefinitions().map((d) => d.kind)).toEqual(['plugin:test-plugin:audio-extract']);
    expect(h.manager.listDefinitions()[0]?.executor).toBe('runtime/index.mjs');
    expect(JSON.stringify(h.manager.listDefinitions())).not.toContain(h.dataDir);
    expect(h.manager.revision).toBe(1);

    // 同版本即使源文件变了也绝不覆盖。
    writeFileSync(runtimePath, '// changed source');
    expect((await h.manager.installFromFolder(source)).ok).toBe(false);
    expect(readFileSync(join(v1Dir, 'runtime', 'index.mjs'), 'utf8')).toBe(SUCCESS_RUNTIME);

    // 升级切换注册记录，旧目录仍保留。
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as NodePluginManifest;
    manifest.version = '2.0.0';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(await h.manager.installFromFolder(source)).toEqual({ ok: true });
    expect(existsSync(v1Dir)).toBe(true);
    expect(existsSync(join(h.dataDir, 'plugins', 'test-plugin', '2.0.0'))).toBe(true);
    expect(h.manager.listInstalled()[0]?.version).toBe('2.0.0');

    const restored = new NodePluginManager({
      store: h.store, assets: { get: () => undefined } as never, takes: h.takes as never,
      dataDir: h.dataDir, outputsDir: h.outputsDir, logger: { log: () => {} },
    });
    expect(restored.listInstalled()[0]?.version).toBe('2.0.0');
    expect(restored.getDefinition('plugin:test-plugin:audio-extract')?.enabled).toBe(true);
  });

  it('缺 manifest、无效 manifest 和 executor 路径穿越都明确拒绝且不入注册表', async () => {
    const h = makeHarness();
    const empty = join(h.caseRoot, 'empty');
    mkdirSync(empty);
    expect((await h.manager.installFromFolder(empty)).error).toContain('安装插件失败');

    const invalid = writePluginSource(h.caseRoot, SUCCESS_RUNTIME, (manifest) => {
      manifest.nodes = [];
    });
    const invalidResult = await h.manager.installFromFolder(invalid.source);
    expect(invalidResult.ok).toBe(false);
    expect(invalidResult.error).toContain('manifest 校验失败');

    const traversalRoot = mkdtempSync(join(h.caseRoot, 'traversal-'));
    const traversal = writePluginSource(traversalRoot, SUCCESS_RUNTIME, (manifest) => {
      manifest.nodes[0]!.executor = '../outside.mjs';
    });
    const traversalResult = await h.manager.installFromFolder(traversal.source);
    expect(traversalResult.ok).toBe(false);
    expect(traversalResult.error).toContain('executor');
    expect(h.manager.listInstalled()).toEqual([]);
  });

  it('执行器缺失会落 disabled+error 状态，而非静默安装成功', async () => {
    const h = makeHarness();
    const { source, runtimePath } = writePluginSource(h.caseRoot);
    rmSync(runtimePath);
    const result = await h.manager.installFromFolder(source);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('执行器缺失');
    const installed = h.manager.listInstalled()[0];
    expect(installed?.enabled).toBe(false);
    expect(installed?.error).toContain('runtime/index.mjs');
    const publicDefinition = h.manager.listDefinitions({ includeDisabled: true })[0];
    expect(publicDefinition?.enabled).toBe(false);
    expect(publicDefinition?.error).toContain('执行器');
    expect(JSON.stringify(publicDefinition)).not.toContain(h.dataDir);
    expect(existsSync(join(h.dataDir, 'plugins.json'))).toBe(true);
    expect(h.manager.setEnabled('test-plugin', true).ok).toBe(false);
  });

  it('启停控制公开定义，remove 只移除注册并保留文件', async () => {
    const h = makeHarness();
    const source = await install(h);
    expect(h.manager.setEnabled('test-plugin', false)).toEqual({ ok: true });
    expect(h.manager.listDefinitions()).toEqual([]);
    expect(h.manager.listDefinitions({ includeDisabled: true })[0]?.enabled).toBe(false);
    expect(h.manager.setEnabled('test-plugin', true)).toEqual({ ok: true });
    expect(h.manager.listDefinitions()[0]?.enabled).toBe(true);
    expect(h.manager.remove('test-plugin')).toEqual({ ok: true });
    expect(h.manager.listInstalled()).toEqual([]);
    expect(existsSync(join(h.dataDir, 'plugins', 'test-plugin', '1.0.0'))).toBe(true);
    expect(existsSync(join(source, 'manifest.json'))).toBe(true);
  });
});

describe('NodePluginManager 执行、输入与 Take', () => {
  it('归一化参数，解析资产输入，写真实产物并回写最新节点数据', async () => {
    const h = makeHarness({ unknown: '应被剔除' });
    await install(h);
    const versionBeforeRun = h.store.loadProjectCanvases(h.project.id).canvases.find((item) => item.id === h.canvas.id)!.version;
    const saveSpy = vi.spyOn(h.store, 'saveCanvasSnapshot');
    const result = await h.manager.run({ projectId: h.project.id, canvasId: h.canvas.id, nodeId: 'plugin-node' });
    expect(result.ok).toBe(true);
    // 管理器保存前先推进版本；ProjectStore 落盘时再推进一次，等版本旧内容不能覆盖本次结果。
    expect(saveSpy.mock.calls.at(-1)?.[0].version).toBe(versionBeforeRun + 1);
    const savedCanvas = h.store.loadProjectCanvases(h.project.id).canvases.find((item) => item.id === h.canvas.id)!;
    expect(savedCanvas.version).toBe(versionBeforeRun + 2);
    expect(result.takeId).toBe('take-1');
    expect(result.resultPath).toBe(join(realpathSync(h.outputsDir), 'plugins', 'test-plugin', 'plugin-node', 'take-1', 'audio.wav'));
    expect(existsSync(result.resultPath!)).toBe(true);

    const captured = JSON.parse(readFileSync(join(dirname(result.resultPath!), 'captured.json'), 'utf8')) as {
      parameters: Record<string, unknown>;
      inputs: Record<string, string[]>;
      dryRun: boolean;
      contextKeys: string[];
    };
    expect(captured.parameters).toEqual({ format: 'wav' });
    expect(captured.inputs).toEqual({ 'input-video': [h.videoPath] });
    expect(captured.dryRun).toBe(true);
    expect(captured.contextKeys).not.toEqual(expect.arrayContaining(['store', 'assets', 'takes', 'electron']));

    const node = currentPluginNode(h);
    const data = node.data as Record<string, any>;
    expect(node.kind).toBe('plugin:test-plugin:audio-extract');
    expect(data.note).toBe('from-plugin');
    expect(data.resultPath).toBe(result.resultPath);
    expect(data.currentTakeId).toBe('take-1');
    expect(data.mediaType).toBe('audio');
    expect(data.outputs).toEqual({ audio: result.resultPath });
    expect(data.__plugin).toEqual({ id: 'test-plugin', version: '1.0.0' });
    expect(h.takes.rows).toHaveLength(1);
    expect(h.takes.rows[0]?.status).toBe('succeeded');
    expect(h.takes.rows[0]?.resultPath).toBe(result.resultPath);
    expect(h.takes.rows[0]?.params).toMatchObject({ parameters: { format: 'wav' }, dryRun: true });
  });

  it('非资产上游通过 resultPath+mediaType 提供输入', async () => {
    const h = makeHarness();
    await install(h);
    mutateCanvas(h, (canvas) => {
      const source = canvas.nodes.find((node) => node.id === 'asset-node')!;
      source.kind = 'shot';
      source.data = { resultPath: h.videoPath, mediaType: 'video' };
    });
    const result = await h.manager.run({ projectId: h.project.id, canvasId: h.canvas.id, nodeId: 'plugin-node' });
    expect(result.ok).toBe(true);
    const captured = JSON.parse(readFileSync(join(dirname(result.resultPath!), 'captured.json'), 'utf8')) as {
      inputs: Record<string, string[]>;
    };
    expect(captured.inputs['input-video']).toEqual([h.videoPath]);
  });

  it('支持 default.execute(CommonJS)，失败时 Take 为 failed 且不伪造产物', async () => {
    const h = makeHarness();
    await install(h, `
      const { writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      module.exports = { execute(ctx) {
        writeFileSync(join(ctx.outputDir, 'audio.wav'), 'audio');
        return { resultPath: 'audio.wav' };
      } };
    `);
    const ok = await h.manager.run({ projectId: h.project.id, canvasId: h.canvas.id, nodeId: 'plugin-node' });
    expect(ok.ok).toBe(true);
    expect(h.takes.rows[0]?.status).toBe('succeeded');

    const failure = makeHarness();
    await install(failure, 'export async function execute() { throw new Error("executor boom"); }');
    const failed = await failure.manager.run({ projectId: failure.project.id, canvasId: failure.canvas.id, nodeId: 'plugin-node' });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('executor boom');
    expect(failed.takeId).toBe('take-1');
    expect(failure.takes.rows[0]?.status).toBe('failed');
    expect(failure.takes.rows[0]?.error).toContain('executor boom');
    expect((currentPluginNode(failure).data as Record<string, unknown>).resultPath).toBeUndefined();
    expect(existsSync(join(failure.outputsDir, 'plugins', 'test-plugin', 'plugin-node', 'take-1', 'audio.wav'))).toBe(false);
  });

  it('动态 import 失败会持久化 disabled+error，同时 Take 进入 failed', async () => {
    const h = makeHarness();
    await install(h, 'export async function execute(');
    const result = await h.manager.run({ projectId: h.project.id, canvasId: h.canvas.id, nodeId: 'plugin-node' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('执行器加载失败');
    expect(h.takes.rows[0]?.status).toBe('failed');
    expect(h.manager.listInstalled()[0]?.enabled).toBe(false);
    expect(h.manager.listInstalled()[0]?.error).toContain('执行器加载失败');
    const persisted = JSON.parse(readFileSync(join(h.dataDir, 'plugins.json'), 'utf8')) as {
      plugins: Array<{ enabled: boolean; error?: string }>;
    };
    expect(persisted.plugins[0]?.enabled).toBe(false);
    expect(persisted.plugins[0]?.error).toContain('执行器加载失败');
  });

  it('参数、必填输入、媒体类型、single 边数和悬空资产都指名拒绝，且不创建 Take', async () => {
    const invalidParam = makeHarness({ format: 'mp3' });
    await install(invalidParam);
    const badParam = await invalidParam.manager.run({ projectId: invalidParam.project.id, canvasId: invalidParam.canvas.id, nodeId: 'plugin-node' });
    expect(badParam.error).toContain('format');
    expect(invalidParam.takes.rows).toHaveLength(0);

    const missingInput = makeHarness();
    await install(missingInput);
    mutateCanvas(missingInput, (canvas) => { canvas.edges = []; });
    const missing = await missingInput.manager.run({ projectId: missingInput.project.id, canvasId: missingInput.canvas.id, nodeId: 'plugin-node' });
    expect(missing.error).toContain('input-video');
    expect(missingInput.takes.rows).toHaveLength(0);

    const wrongMedia = makeHarness();
    await install(wrongMedia);
    wrongMedia.assets.get('video-1')!.kind = 'image';
    const wrong = await wrongMedia.manager.run({ projectId: wrongMedia.project.id, canvasId: wrongMedia.canvas.id, nodeId: 'plugin-node' });
    expect(wrong.error).toContain('需要 video');
    expect(wrong.error).toContain('edge-video');

    const tooMany = makeHarness();
    await install(tooMany);
    mutateCanvas(tooMany, (canvas) => {
      canvas.edges.push({ id: 'edge-video-2', source: 'asset-node', target: 'plugin-node', label: 'input-video' });
    });
    const single = await tooMany.manager.run({ projectId: tooMany.project.id, canvasId: tooMany.canvas.id, nodeId: 'plugin-node' });
    expect(single.error).toContain('single');
    expect(single.error).toContain('input-video');

    const orphan = makeHarness();
    await install(orphan);
    orphan.assets.delete('video-1');
    const unresolved = await orphan.manager.run({ projectId: orphan.project.id, canvasId: orphan.canvas.id, nodeId: 'plugin-node' });
    expect(unresolved.error).toContain('input-video');
    expect(unresolved.error).toContain('edge-video');
    expect(unresolved.error).toContain('video-1');
    expect(orphan.takes.rows).toHaveLength(0);
  });

  it('主产物必须非空且位于本次 outputDir，越界与空文件都使 Take 失败', async () => {
    const outside = makeHarness();
    await install(outside, `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      export async function execute(ctx) {
        writeFileSync(join(ctx.outputDir, '..', 'outside.wav'), 'real-but-outside');
        return { resultPath: '../outside.wav' };
      }
    `);
    const escaped = await outside.manager.run({ projectId: outside.project.id, canvasId: outside.canvas.id, nodeId: 'plugin-node' });
    expect(escaped.ok).toBe(false);
    expect(escaped.error).toContain('越出本次输出目录');
    expect(outside.takes.rows[0]?.status).toBe('failed');
    expect((currentPluginNode(outside).data as Record<string, unknown>).resultPath).toBeUndefined();

    const empty = makeHarness();
    await install(empty, `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      export async function execute(ctx) {
        writeFileSync(join(ctx.outputDir, 'audio.wav'), '');
        return { resultPath: 'audio.wav' };
      }
    `);
    const emptyResult = await empty.manager.run({ projectId: empty.project.id, canvasId: empty.canvas.id, nodeId: 'plugin-node' });
    expect(emptyResult.ok).toBe(false);
    expect(emptyResult.error).toContain('非空文件');
    expect(empty.takes.rows[0]?.status).toBe('failed');
  });

  it('同 nodeId 防重入；执行期间的并发画布保存不会被旧快照覆盖', async () => {
    const h = makeHarness();
    await install(h, `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      export async function execute(ctx) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        writeFileSync(join(ctx.outputDir, 'audio.wav'), 'audio');
        return { resultPath: 'audio.wav' };
      }
    `);
    const req = { projectId: h.project.id, canvasId: h.canvas.id, nodeId: 'plugin-node' };
    const first = h.manager.run(req);
    const duplicate = await h.manager.run(req);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error).toContain('正在运行');
    expect(h.takes.rows).toHaveLength(1);

    // 模拟执行中 renderer 新加节点并保存；完成后管理器必须重载这份最新快照。
    mutateCanvas(h, (canvas) => {
      canvas.nodes.push(makeNode('concurrent-doc', 'document', { markdown: '运行期间新增' }));
    });
    expect((await first).ok).toBe(true);
    const final = h.store.loadProjectCanvases(h.project.id).canvases.find((item) => item.id === h.canvas.id)!;
    expect(final.nodes.some((node) => node.id === 'concurrent-doc')).toBe(true);
    expect(final.nodes.some((node) => node.id === 'plugin-node')).toBe(true);
  });

  it('画布保存结果被检查；保存失败会把已执行 Take 改为 failed', async () => {
    const h = makeHarness();
    await install(h);
    vi.spyOn(h.store, 'saveCanvasSnapshot').mockReturnValue({ ok: false, stale: true });
    const result = await h.manager.run({ projectId: h.project.id, canvasId: h.canvas.id, nodeId: 'plugin-node' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('画布结果保存失败');
    expect(h.takes.rows[0]?.status).toBe('failed');
    expect(h.takes.rows[0]?.error).toContain('版本已过期');
  });
});
