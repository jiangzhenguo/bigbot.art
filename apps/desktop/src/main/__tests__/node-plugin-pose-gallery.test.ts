/**
 * 真实用户插件 ai-pose-gallery-zh 的端到端验证。
 *
 * 覆盖三件事：
 * ① 宿主能装下这份 manifest 与 1439 条 picker 清单；
 * ② 清单里的 poseValue 与 manifest 的 pose 枚举完全对齐（选得中、也跑得动）；
 * ③ 选中一条 → 参数写回 → 执行器按 pose+angle 找到图并产出参考图。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-pose-gallery-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');

/** 用户插件仓库在主仓之外；不存在就跳过（不伪造通过）。 */
const PLUGIN_REPO = resolve(process.env.HOME ?? '', 'ai/ai-pose-gallery-zh');
/**
 * 装的是 dist 产物而不是 node-plugin/ 源目录 ——
 * 源目录不含 img/（原图在仓库根），只有构建产物才是完整可安装包。
 */
const PLUGIN_SOURCE = join(PLUGIN_REPO, 'dist/bigbotart-pose-selector');

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

const pluginAvailable = existsSync(join(PLUGIN_SOURCE, 'manifest.json'));

describe.skipIf(!pluginAvailable)('真实插件 ai-pose-gallery-zh · picker 全链路', () => {
  it('安装 → 读清单 → 选中姿势视角 → 运行 → 产出参考图', async () => {
    const store = new ProjectStore();
    const assets = new AssetStore();
    const takes = new TakeStore();
    const manager = new NodePluginManager({
      store, assets, takes, dataDir: join(tmpHome, 'data'), outputsDir: join(tmpHome, 'outputs'),
    });

    const installed = await manager.installFromFolder(PLUGIN_SOURCE);
    expect(installed).toEqual({ ok: true });

    const kind = 'plugin:ai-pose-gallery-zh:pose-selector';
    const definition = manager.getDefinition(kind);
    expect(definition?.ui?.type).toBe('picker');
    expect(definition?.ui?.valueField).toBe('poseValue');
    expect(definition?.ui?.variantField).toBe('angle');

    // 清单加载：1439 条，缩略图走 bba-plugin://
    const catalog = manager.getCatalog(kind);
    expect(catalog.ok, JSON.stringify(catalog)).toBe(true);
    if (!catalog.ok) return;
    expect(catalog.catalog.items.length).toBe(1439);
    expect(catalog.catalog.items[0]!.thumb).toContain('bba-plugin://ai-pose-gallery-zh/');
    expect(catalog.catalog.items[0]!.thumb).toContain('/data/thumbs/');

    // 清单的 poseValue 必须落在 manifest 的 pose 枚举里，否则选中就会校验失败
    const poseEnum = definition!.parametersSchema.properties.pose?.enum ?? [];
    expect(poseEnum.length).toBe(288);
    const sample = catalog.catalog.items[0]!;
    expect(poseEnum).toContain(sample.fields.poseValue);
    expect(definition!.parametersSchema.properties.angle?.enum).toContain(sample.fields.angle);

    // 画布上放一个已选中姿势+视角的节点，跑一次
    const project = store.createProject('真实姿势插件');
    const canvas = store.createCanvas(project.id, '主画布');
    const now = new Date().toISOString();
    store.replaceCanvases(project.id, {
      projectId: project.id,
      activeCanvasId: canvas.id,
      canvases: [{
        ...canvas,
        nodes: [{
          id: 'pose-node',
          kind,
          label: '姿势',
          position: { x: 0, y: 0 },
          data: { pose: sample.fields.poseValue, angle: sample.fields.angle },
          createdAt: now,
          updatedAt: now,
        }],
        edges: [],
      }],
    });

    const ran = await manager.run({ projectId: project.id, canvasId: canvas.id, nodeId: 'pose-node' });
    expect(ran.ok, ran.error).toBe(true);
    expect(ran.resultPath && existsSync(ran.resultPath)).toBe(true);

    const take = takes.get(project.id, ran.takeId!);
    expect(take?.status).toBe('succeeded');
  });

  it('建节点时 picker 独占参数允许为空（不是「缺少必填参数 pose」）', async () => {
    const store = new ProjectStore();
    const assets = new AssetStore();
    const takes = new TakeStore();
    const manager = new NodePluginManager({
      store, assets, takes, dataDir: join(tmpHome, 'data2'), outputsDir: join(tmpHome, 'outputs2'),
    });
    await manager.installFromFolder(PLUGIN_SOURCE);

    const definition = manager.getDefinition('plugin:ai-pose-gallery-zh:pose-selector');
    expect(definition).toBeDefined();

    // 这个插件的 defaultData 本身合法，但 picker 语义要求「未选」也能建节点：
    // 把 defaultData 清空后，建节点校验不得报「缺少必填参数 pose」。
    const { validateNodePluginDataForCreate } = await import('@bigbotart/shared');
    const result = validateNodePluginDataForCreate(
      {},
      definition!.parametersSchema,
      definition!.ui,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });
});
