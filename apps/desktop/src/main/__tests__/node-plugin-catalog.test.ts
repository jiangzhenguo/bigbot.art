import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodePluginManifest } from '@bigbotart/shared';

// 所有模块级 DATA_DIR/OUTPUTS_DIR 都必须在动态 import 前指向临时目录。
const testHome = mkdtempSync(join(tmpdir(), 'bbart-node-plugin-catalog-'));
process.env.BIGBOTART_HOME = testHome;
process.env.BIGBOTART_DRYRUN = '1';

const { NodePluginManager } = await import('../node-plugins.js');
const { ProjectStore } = await import('../store.js');
const { AssetStore } = await import('../assets.js');
const { TakeStore } = await import('../takes.js');

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});

/** 1×1 透明 PNG：够用来验证协议路径与后缀白名单。 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function manifestWithUi(pluginId: string): NodePluginManifest {
  return {
    apiVersion: 'bigbotart.node-plugin/v1',
    id: pluginId,
    version: '1.0.0',
    displayName: '姿势工具',
    nodes: [{
      kind: 'pose-selector',
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
        },
      },
      executor: 'runtime/index.mjs',
      ui: {
        type: 'picker',
        title: '姿势选择器',
        valueParam: 'pose',
        variantParam: 'angle',
        variantField: 'angle',
        catalog: 'catalog/poses.json',
        filterFields: ['system'],
        tabField: 'angle',
        thumbnailField: 'thumb',
      },
    }],
  };
}

const RUNTIME = 'export async function execute(ctx) { return { resultPath: ctx.outputDir }; }';

interface PluginCase {
  id: string;
  source: string;
  manager: InstanceType<typeof NodePluginManager>;
}

/** 每个用例独立数据目录 + 独立插件 id：同 id/version 重复安装本来就会被拒。 */
function makeCase(
  name: string,
  options: { catalog?: unknown; writeCatalogFile?: boolean; withUi?: boolean } = {},
): PluginCase {
  const root = join(testHome, name);
  const pluginId = `pose-${name}`;
  const source = join(root, 'source');
  mkdirSync(join(source, 'runtime'), { recursive: true });
  writeFileSync(join(source, 'runtime', 'index.mjs'), RUNTIME);

  const manifest = manifestWithUi(pluginId);
  if (options.withUi === false) delete manifest.nodes[0]!.ui;
  writeFileSync(join(source, 'manifest.json'), JSON.stringify(manifest, null, 2));

  if (options.writeCatalogFile !== false) {
    mkdirSync(join(source, 'catalog', 'thumbs'), { recursive: true });
    writeFileSync(
      join(source, 'catalog', 'poses.json'),
      JSON.stringify(
        options.catalog ?? {
          items: [
            { id: 'stand-front', label: '站立', system: '人体', angle: '正面', thumb: 'thumbs/a.png' },
            { id: 'walk-side', label: '行走', system: '人体', angle: '侧面' },
          ],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(source, 'catalog', 'thumbs', 'a.png'),
      Buffer.from(PNG_BASE64, 'base64'),
    );
  }

  const manager = new NodePluginManager({
    store: new ProjectStore(),
    assets: new AssetStore(),
    takes: new TakeStore(),
    dataDir: join(root, 'data'),
    outputsDir: join(root, 'outputs'),
  });
  return { id: pluginId, source, manager };
}

describe('插件受控 UI 清单 · 主进程加载与素材路径', () => {
  it('读取清单并把缩略图转成 bba-plugin:// URL', async () => {
    const c = makeCase('load');
    const installed = await c.manager.installFromFolder(c.source);
    expect(installed).toEqual({ ok: true });

    const kind = `plugin:${c.id}:pose-selector`;
    const result = c.manager.getCatalog(kind);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.catalog.items).toHaveLength(2);
    expect(result.catalog.items[0]!.thumb).toBe(`bba-plugin://${c.id}/1.0.0/catalog/thumbs/a.png`);
    expect(result.catalog.items[0]!.fields).toEqual({ system: '人体', angle: '正面' });
    // 没有缩略图的条目不伪造图片 URL
    expect(result.catalog.items[1]!.thumb).toBeUndefined();
    expect(result.catalog.fields).toContain('system');
  });

  it('公开定义带上 ui 声明', async () => {
    const c = makeCase('definition');
    await c.manager.installFromFolder(c.source);
    const definition = c.manager.getDefinition(`plugin:${c.id}:pose-selector`);
    expect(definition?.ui?.type).toBe('picker');
    expect(definition?.ui?.valueParam).toBe('pose');
  });

  it('素材只允许当前版本插件目录内的图片', async () => {
    const c = makeCase('asset');
    await c.manager.installFromFolder(c.source);

    const ok = c.manager.resolvePluginAsset(c.id, '1.0.0', 'catalog/thumbs/a.png');
    expect(ok).toBeTruthy();
    expect(ok!.endsWith('catalog/thumbs/a.png')).toBe(true);

    // 越界 / 版本不符 / 非图片 / 未安装 一律拒绝
    expect(c.manager.resolvePluginAsset(c.id, '1.0.0', '../../../etc/passwd')).toBeUndefined();
    expect(c.manager.resolvePluginAsset(c.id, '9.9.9', 'catalog/thumbs/a.png')).toBeUndefined();
    expect(c.manager.resolvePluginAsset(c.id, '1.0.0', 'manifest.json')).toBeUndefined();
    expect(c.manager.resolvePluginAsset('not-installed', '1.0.0', 'catalog/thumbs/a.png')).toBeUndefined();
  });

  it('清单文件缺失时插件不可运行', async () => {
    const c = makeCase('missing', { writeCatalogFile: false });
    const installed = await c.manager.installFromFolder(c.source);
    expect(installed.ok).toBe(false);
    if (installed.ok) return;
    expect(installed.error).toContain('清单文件缺失');
  });

  it('清单内容非法时给出明确错误，而不是空列表', async () => {
    const c = makeCase('invalid', { catalog: { items: [{ id: 'a' }] } });
    const installed = await c.manager.installFromFolder(c.source);
    expect(installed.ok).toBe(true);
    const result = c.manager.getCatalog(`plugin:${c.id}:pose-selector`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('清单校验失败');
  });

  it('未声明 ui 的节点读清单时明确报错', async () => {
    const c = makeCase('no-ui', { withUi: false });
    await c.manager.installFromFolder(c.source);
    const result = c.manager.getCatalog(`plugin:${c.id}:pose-selector`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('没有声明受控 UI');
  });
});
