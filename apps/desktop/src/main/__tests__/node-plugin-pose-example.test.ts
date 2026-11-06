import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-plugin-pose-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');

let ProjectStore: typeof import('../store').ProjectStore;
let AssetStore: typeof import('../assets').AssetStore;
let TakeStore: typeof import('../takes').TakeStore;
let NodePluginManager: typeof import('../node-plugins').NodePluginManager;

beforeAll(async () => {
  ({ ProjectStore } = await import('../store'));
  ({ AssetStore } = await import('../assets'));
  ({ TakeStore } = await import('../takes'));
  ({ NodePluginManager } = await import('../node-plugins'));
});
afterAll(() => rmSync(tmpHome, { recursive: true, force: true }));

describe('pose-selector 示例插件 · 受控 UI 清单与执行链路', () => {
  it('安装 → 读清单 → 用选中参数运行 → 产出参考图与 Take', async () => {
    const store = new ProjectStore();
    const assets = new AssetStore();
    const takes = new TakeStore();
    const manager = new NodePluginManager({
      store, assets, takes, dataDir: join(tmpHome, 'data'), outputsDir: join(tmpHome, 'outputs'),
    });

    const installed = await manager.installFromFolder(
      resolve(process.cwd(), 'examples/node-plugins/pose-selector'),
    );
    expect(installed).toEqual({ ok: true });

    // 受控 UI 声明与清单
    const definition = manager.getDefinition('plugin:bigbotart-pose-demo:pose-selector');
    expect(definition?.ui?.type).toBe('picker');
    expect(definition?.ui?.valueParam).toBe('pose');

    const catalog = manager.getCatalog('plugin:bigbotart-pose-demo:pose-selector');
    expect(catalog.ok, JSON.stringify(catalog)).toBe(true);
    if (!catalog.ok) return;
    expect(catalog.catalog.items.length).toBeGreaterThan(3);
    expect(catalog.catalog.items[0]!.thumb).toContain('bba-plugin://bigbotart-pose-demo/1.0.0/');

    // 画布上放一个已选中姿势的节点
    const project = store.createProject('姿势示例测试');
    const canvas = store.createCanvas(project.id, '主画布');
    const now = new Date().toISOString();
    store.replaceCanvases(project.id, {
      projectId: project.id,
      activeCanvasId: canvas.id,
      canvases: [{
        ...canvas,
        nodes: [{
          id: 'pose-node',
          kind: 'plugin:bigbotart-pose-demo:pose-selector',
          label: '姿势',
          position: { x: 0, y: 0 },
          data: { pose: 'stand-front', angle: '正面' },
          createdAt: now,
          updatedAt: now,
        }],
        edges: [],
      }],
    });

    const ran = await manager.run({ projectId: project.id, canvasId: canvas.id, nodeId: 'pose-node' });
    expect(ran.ok, ran.error).toBe(true);
    expect(ran.resultPath && existsSync(ran.resultPath)).toBe(true);
    expect(ran.resultPath!.endsWith('stand-front.png')).toBe(true);

    const take = takes.get(project.id, ran.takeId!);
    expect(take?.status).toBe('succeeded');

    const saved = store.loadProjectCanvases(project.id).canvases[0]!;
    const node = saved.nodes.find((n) => n.id === 'pose-node')!;
    expect(node.data).toMatchObject({
      resultPath: ran.resultPath,
      currentTakeId: ran.takeId,
      mediaType: 'image',
      __plugin: { id: 'bigbotart-pose-demo', version: '1.0.0' },
    });
  });

  it('没选姿势时明确失败，不产出假结果', async () => {
    const store = new ProjectStore();
    const assets = new AssetStore();
    const takes = new TakeStore();
    const manager = new NodePluginManager({
      store, assets, takes, dataDir: join(tmpHome, 'data2'), outputsDir: join(tmpHome, 'outputs2'),
    });
    await manager.installFromFolder(resolve(process.cwd(), 'examples/node-plugins/pose-selector'));

    const project = store.createProject('姿势示例测试2');
    const canvas = store.createCanvas(project.id, '主画布');
    const now = new Date().toISOString();
    store.replaceCanvases(project.id, {
      projectId: project.id,
      activeCanvasId: canvas.id,
      canvases: [{
        ...canvas,
        nodes: [{
          id: 'pose-node',
          kind: 'plugin:bigbotart-pose-demo:pose-selector',
          label: '姿势',
          position: { x: 0, y: 0 },
          data: {},
          createdAt: now,
          updatedAt: now,
        }],
        edges: [],
      }],
    });

    const ran = await manager.run({ projectId: project.id, canvasId: canvas.id, nodeId: 'pose-node' });
    expect(ran.ok).toBe(false);
    // 宿主在调用执行器前就拦下缺失的必填参数，不产出假结果
    expect(ran.error).toContain('缺少必填参数');
    expect(ran.resultPath).toBeUndefined();
  });
});
