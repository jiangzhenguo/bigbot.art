import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-plugin-example-'));
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

const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });

describe('真实示例插件 · 本地 ffmpeg 垂直链路', () => {
  it.skipIf(ffmpeg.error !== undefined)('安装 audio-extract → 视频资产输入 → WAV/Take/画布回写', async () => {
    const inputPath = join(tmpHome, 'input.mp4');
    const made = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
      '-t', '0.25', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', inputPath,
    ], { encoding: 'utf8' });
    expect(made.status, made.stderr).toBe(0);

    const store = new ProjectStore();
    const assets = new AssetStore();
    const takes = new TakeStore();
    const manager = new NodePluginManager({
      store, assets, takes, dataDir: join(tmpHome, 'data'), outputsDir: join(tmpHome, 'outputs'),
    });
    const installed = await manager.installFromFolder(resolve(process.cwd(), 'examples/node-plugins/audio-extract'));
    expect(installed).toEqual({ ok: true });

    const project = store.createProject('插件示例测试');
    const canvas = store.createCanvas(project.id, '主画布');
    assets.importParsed(project.id, [{
      id: 'asset-video', kind: 'video', name: '测试视频', localPath: inputPath,
      projectId: project.id, source: 'import', tags: [], createdAt: new Date().toISOString(),
    }]);
    const now = new Date().toISOString();
    store.replaceCanvases(project.id, {
      projectId: project.id,
      activeCanvasId: canvas.id,
      canvases: [{
        ...canvas,
        nodes: [
          {
            id: 'asset-node', kind: 'asset', label: '测试视频', position: { x: 0, y: 0 },
            data: { assetId: 'asset-video', mediaType: 'video' }, createdAt: now, updatedAt: now,
          },
          {
            id: 'plugin-node', kind: 'plugin:bigbotart-examples:audio-extract', label: '音轨',
            position: { x: 300, y: 0 }, data: { format: 'wav', mediaType: 'audio' }, createdAt: now, updatedAt: now,
          },
        ],
        edges: [{ id: 'edge-1', source: 'asset-node', target: 'plugin-node', label: 'input-video' }],
      }],
    });

    const ran = await manager.run({ projectId: project.id, canvasId: canvas.id, nodeId: 'plugin-node' });
    expect(ran.ok, ran.error).toBe(true);
    expect(ran.resultPath && existsSync(ran.resultPath)).toBe(true);
    const probed = spawnSync('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels',
      '-of', 'json', ran.resultPath!,
    ], { encoding: 'utf8' });
    expect(probed.status, probed.stderr).toBe(0);
    expect(probed.stdout).toContain('pcm_s16le');
    expect(probed.stdout).toContain('48000');

    const take = takes.get(project.id, ran.takeId!);
    expect(take?.status).toBe('succeeded');
    const saved = store.loadProjectCanvases(project.id).canvases[0]!;
    const node = saved.nodes.find((n) => n.id === 'plugin-node')!;
    expect(node.data).toMatchObject({
      resultPath: ran.resultPath, currentTakeId: ran.takeId, mediaType: 'audio',
      __plugin: { id: 'bigbotart-examples', version: '1.0.0' },
    });
    expect(saved.version).toBeGreaterThan(canvas.version);
  });
});
