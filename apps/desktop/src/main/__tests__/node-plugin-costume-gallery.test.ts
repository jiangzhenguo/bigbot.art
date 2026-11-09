/**
 * 真实衣服图库插件 ai-costume-gallery-zh 的宿主端到端验证。
 *
 * 安装完整 dist 包，检查 1,407 条 picker 清单与参数枚举一致，
 * 再把选中衣服跑成真实 PNG 主产物，并核对产物与原图字节一致。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-costume-gallery-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');

/** 完整安装包由衣服图库仓库的 scripts/build_node_plugin.py 生成。 */
const PLUGIN_REPO = resolve(process.env.HOME ?? '', 'ai/ai-costume-gallery-zh');
const PLUGIN_SOURCE = join(PLUGIN_REPO, 'dist/bigbotart-costume-selector');

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

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe.skipIf(!pluginAvailable)('真实插件 ai-costume-gallery-zh · picker 全链路', () => {
  it('安装 → 读 1407 条清单 → 选衣服 → 运行 → 原图逐字节一致', async () => {
    const store = new ProjectStore();
    const assets = new AssetStore();
    const takes = new TakeStore();
    const manager = new NodePluginManager({
      store, assets, takes, dataDir: join(tmpHome, 'data'), outputsDir: join(tmpHome, 'outputs'),
    });

    const installed = await manager.installFromFolder(PLUGIN_SOURCE);
    expect(installed).toEqual({ ok: true });

    const kind = 'plugin:ai-costume-gallery-zh:costume-selector';
    const definition = manager.getDefinition(kind);
    expect(definition?.ui?.type).toBe('picker');
    expect(definition?.ui?.valueParam).toBe('costume');
    expect(definition?.ui?.tabField).toBe('category');

    const catalog = manager.getCatalog(kind);
    expect(catalog.ok, JSON.stringify(catalog)).toBe(true);
    if (!catalog.ok) return;
    expect(catalog.catalog.items).toHaveLength(1407);
    expect(new Set(catalog.catalog.items.map((item) => item.id)).size).toBe(1407);
    const sample = catalog.catalog.items[0]!;
    expect(sample.thumb).toContain('bba-plugin://ai-costume-gallery-zh/1.0.0/data/thumbs/');
    expect(sample.fields.category).toBe('春季');

    const costumeEnum = definition!.parametersSchema.properties.costume?.enum ?? [];
    expect(costumeEnum).toHaveLength(1407);
    expect(costumeEnum).toContain(sample.id);

    // picker 接管的必填参数允许建节点后再选；运行前仍必须有值。
    const { validateNodePluginDataForCreate } = await import('@bigbotart/shared');
    const initial = validateNodePluginDataForCreate({}, definition!.parametersSchema, definition!.ui);
    expect(initial.ok, JSON.stringify(initial)).toBe(true);

    const project = store.createProject('真实衣服插件');
    const canvas = store.createCanvas(project.id, '主画布');
    const now = new Date().toISOString();
    store.replaceCanvases(project.id, {
      projectId: project.id,
      activeCanvasId: canvas.id,
      canvases: [{
        ...canvas,
        nodes: [{
          id: 'costume-node',
          kind,
          label: '衣服',
          position: { x: 0, y: 0 },
          data: { costume: sample.id },
          createdAt: now,
          updatedAt: now,
        }],
        edges: [],
      }],
    });

    const ran = await manager.run({ projectId: project.id, canvasId: canvas.id, nodeId: 'costume-node' });
    expect(ran.ok, ran.error).toBe(true);
    expect(ran.resultPath && existsSync(ran.resultPath)).toBe(true);
    expect(ran.resultPath!.endsWith(`${sample.id}.png`)).toBe(true);
    expect(takes.get(project.id, ran.takeId!)?.status).toBe('succeeded');

    const original = join(PLUGIN_SOURCE, 'png', `${sample.id}.png`);
    expect(sha256(ran.resultPath!)).toBe(sha256(original));
  });
});
