/**
 * Agent 工具 `vision.caption`(看图反推提示词)单测
 *
 * 覆盖:
 *  1. 端点解析:`BIGBOTART_VL_*` 优先 → 回退主 LLM 端点 → 回退 LM Studio 默认(纯函数)
 *  2. 指令组装:四种 style 的出稿侧重不同;extra 追加生效(纯函数)
 *  3. 请求体构造:OpenAI 兼容多模态格式(text + image_url data URL)
 *  4. 集成:tool handler 走通「节点 → 视觉端点 → 反推文本」全链路(fetch 打桩,不碰真模型)
 *  5. 错误面:来源缺失 / 节点无产物 / style 非法 / 白名单外路径 / 端点报错 —— 全部显式失败不静默
 *
 * 关键:vision.ts / assets.ts 的模块级常量按 env 求值 → 必须在模块顶层先设 env,再在测试内动态 import。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ⚠️ 先于任何主进程模块加载:目录全部指向临时 HOME,绝不触碰真实用户数据(R5)
const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-vision-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');

const outDir = join(tmpHome, 'outputs');
const assetDir = join(tmpHome, 'assets');

let vision: typeof import('../vision.js');
let ToolHandlers: typeof import('../tool-handlers.js').ToolHandlers;

const PROJECT = 'p-vision';
const CANVAS = 'c-vision';

/** 造一张最小合法 PNG(1×1),内容不重要——fetch 被打桩,不走真视觉模型 */
function writePng(path: string): void {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  writeFileSync(path, png);
}

beforeAll(async () => {
  mkdirSync(outDir, { recursive: true });
  mkdirSync(assetDir, { recursive: true });
  writePng(join(assetDir, 'sample.png'));

  vision = await import('../vision.js');
  ({ ToolHandlers } = await import('../tool-handlers.js'));
  void (await import('../assets.js'));
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/* ── 1. 端点解析(纯函数) ── */
describe('resolveVisionEndpoint', () => {
  it('BIGBOTART_VL_* 优先于主 LLM 端点', () => {
    const ep = vision.resolveVisionEndpoint({
      BIGBOTART_VL_BASE_URL: 'http://127.0.0.1:9999/v1/',
      BIGBOTART_VL_MODEL: 'my-vl',
      BIGBOTART_VL_API_KEY: 'k1',
      BIGBOTART_LLM_BASE_URL: 'https://api.example.com/v1',
      BIGBOTART_LLM_MODEL: 'text-only',
    });
    expect(ep.baseUrl).toBe('http://127.0.0.1:9999/v1'); // 尾部斜杠归一化
    expect(ep.model).toBe('my-vl');
    expect(ep.apiKey).toBe('k1');
  });

  it('未配 VL 时回退主 LLM 端点(主端点本身支持视觉的场景)', () => {
    const ep = vision.resolveVisionEndpoint({
      BIGBOTART_LLM_BASE_URL: 'https://api.example.com/v1',
      BIGBOTART_LLM_MODEL: 'vision-model',
      BIGBOTART_LLM_API_KEY: 'k2',
    });
    expect(ep.baseUrl).toBe('https://api.example.com/v1');
    expect(ep.model).toBe('vision-model');
    expect(ep.apiKey).toBe('k2');
  });

  it('什么都没有时回退本地 LM Studio 默认视觉模型', () => {
    const ep = vision.resolveVisionEndpoint({});
    expect(ep.baseUrl).toBe('http://127.0.0.1:1234/v1');
    expect(ep.model).toBe('qwen3-vl-8b-nsfw-caption-v4.5-affine');
    expect(ep.apiKey).toBeUndefined();
  });
});

/* ── 2. 指令组装(纯函数) ── */
describe('buildCaptionInstruction', () => {
  it('四种 style 的出稿要求互不相同', () => {
    const p = vision.buildCaptionInstruction('prompt');
    const z = vision.buildCaptionInstruction('zimage');
    const h = vision.buildCaptionInstruction('h3');
    const j = vision.buildCaptionInstruction('json');
    expect(p).toContain('English');
    expect(z).toContain('Z-Image');
    expect(h).toContain('H3');
    expect(j).toContain('JSON');
    expect(new Set([p, z, h, j]).size).toBe(4);
  });

  it('未知 style 落通用分支(不抛错)', () => {
    expect(vision.buildCaptionInstruction('whatever')).toContain('English');
  });

  it('extra 追加到指令末尾;空白 extra 不追加', () => {
    expect(vision.buildCaptionInstruction('prompt', '强调光影')).toContain('强调光影');
    expect(vision.buildCaptionInstruction('prompt', '   ')).not.toContain('Additional requirement');
  });
});

/* ── 3. 请求体构造(纯函数) ── */
describe('buildVisionRequest', () => {
  it('输出 OpenAI 兼容多模态格式(text + image_url)', () => {
    const body = vision.buildVisionRequest('m1', 'data:image/png;base64,AAA', 'desc') as any;
    expect(body.model).toBe('m1');
    expect(body.messages[0].content[0]).toEqual({ type: 'text', text: 'desc' });
    expect(body.messages[0].content[1].image_url.url).toBe('data:image/png;base64,AAA');
  });

  it('max_tokens 可覆盖,默认 700', () => {
    expect((vision.buildVisionRequest('m', 'd', 'i') as any).max_tokens).toBe(700);
    expect((vision.buildVisionRequest('m', 'd', 'i', 123) as any).max_tokens).toBe(123);
  });
});

/* ── 4/5. captionImage 与 handler 集成(fetch 打桩) ── */
describe('captionImage', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('文件不存在 → 显式失败', async () => {
    const r = await vision.captionImage(join(assetDir, 'nope.png'));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不存在');
  });

  it('白名单外路径 → 拒绝读取(防任意读)', async () => {
    const outside = join(tmpdir(), 'bbart-outside-secret.png');
    writePng(outside);
    const r = await vision.captionImage(outside);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('允许目录');
    rmSync(outside, { force: true });
  });

  it('非图片扩展名 → 显式失败', async () => {
    const txt = join(assetDir, 'note.txt');
    writeFileSync(txt, 'hello');
    const r = await vision.captionImage(txt);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不支持的图片格式');
  });

  /* ③ 对视频/音频传错源时,错误信息必须给出「可直接执行的下一步」,而不是干巴巴报错。
     真实事故:对 mp4 调本工具报错后,模型又试了 get_node、再调一次,共 3 轮才想到 frames.extract */
  it('视频文件 → 错误里指引先用 frames.extract 取帧', async () => {
    const mp4 = join(assetDir, 'clip.mp4');
    writeFileSync(mp4, 'not-a-real-video');
    const r = await vision.captionImage(mp4);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('视频');
    expect(r.error).toContain('frames.extract'); // 关键:给出下一步工具
    expect(r.error).not.toContain('不支持的图片格式'); // 不该混进通用文案
  });

  it('音频文件 → 明确说明无法分析音频', async () => {
    const mp3 = join(assetDir, 'voice.mp3');
    writeFileSync(mp3, 'not-a-real-audio');
    const r = await vision.captionImage(mp3);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('音频');
  });

  it('端点 500 → 带状态码与响应片段报错(不静默)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const r = await vision.captionImage(join(assetDir, 'sample.png'));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('500');
    expect(r.error).toContain('boom');
  });

  it('端点返回空 content → 明确报错而非返回空串', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [{ message: { content: '  ' } }] })));
    const r = await vision.captionImage(join(assetDir, 'sample.png'));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('空内容');
  });

  it('成功:content 为字符串 → 返回 caption 与 model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [{ message: { content: 'a cat' } }] })));
    const r = await vision.captionImage(join(assetDir, 'sample.png'), 'prompt', undefined, {
      baseUrl: 'http://x/v1', model: 'vl-test',
    });
    expect(r.ok).toBe(true);
    expect(r.caption).toBe('a cat');
    expect(r.model).toBe('vl-test');
  });

  it('成功:content 为多模态块数组 → 拼接文本', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ choices: [{ message: { content: [{ type: 'text', text: 'Par' }, { type: 'text', text: 'tial' }] } }] })),
    );
    const r = await vision.captionImage(join(assetDir, 'sample.png'));
    expect(r.ok).toBe(true);
    expect(r.caption).toBe('Partial');
  });

  it('发出的请求体是 data URL 且带正确 mime', async () => {
    let sent: any;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
      sent = JSON.parse(init.body);
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    }));
    await vision.captionImage(join(assetDir, 'sample.png'), 'prompt', undefined, { baseUrl: 'http://x/v1', model: 'm' });
    expect(sent.messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  });
});

/* ── 6. tool handler 路由(+ 集成) ── */
const ctx = { projectId: PROJECT, canvasId: CANVAS };

/** 造一个只实现 loadProjectCanvases 的 store stub(vision.caption 只读画布,不写盘) */
function makeStore(nodes: Array<Record<string, unknown>>): import('../store.js').ProjectStore {
  return {
    loadProjectCanvases: () => ({
      projectId: PROJECT,
      canvases: [{ id: CANVAS, name: '主画布', version: 1, nodes, edges: [], groups: [], updatedAt: new Date().toISOString() }],
    }),
  } as unknown as import('../store.js').ProjectStore;
}

/** 资产 stub:只实现 get */
function makeAssets(map: Record<string, { id: string; name: string; localPath: string }>) {
  return { get: (id: string) => map[id] } as unknown as import('../assets.js').AssetStore;
}

/** 其余依赖在本工具路径上不会被触碰,给空对象即可 */
function makeHandlers(storeImpl: import('../store.js').ProjectStore, assetsImpl: import('../assets.js').AssetStore) {
  return new ToolHandlers(storeImpl, assetsImpl, {} as never, {} as never, {} as never, {} as never);
}

describe('vision.caption tool handler', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('既无 nodeId 也无 assetId → 报错(不调端点)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const h = makeHandlers(makeStore([]), makeAssets({}));
    const r = await h.call('vision.caption', {}, ctx);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('nodeId');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('节点不存在 → 报错', async () => {
    const h = makeHandlers(makeStore([]), makeAssets({}));
    const r = await h.call('vision.caption', { nodeId: 'ghost' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('不存在');
  });

  it('节点没有图片产物 → 提示先生成(不调端点)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const h = makeHandlers(
      makeStore([{ id: 'n1', kind: 'image-gen', label: '空图', position: { x: 0, y: 0 }, data: {} }]),
      makeAssets({}),
    );
    const r = await h.call('vision.caption', { nodeId: 'n1' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('没有可读的图片产物');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('assetId 指向不存在的资产 → 报错并指引改用 nodeId / assets.list', async () => {
    const h = makeHandlers(makeStore([]), makeAssets({}));
    const r = await h.call('vision.caption', { assetId: 'nope' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('不存在');
    // 真实事故:模型把「节点 id」当 assetId 传,撞错后绕道 assets.list 翻全库找 id
    expect(r.result).toContain('nodeId');
    expect(r.result).toContain('assets.list');
  });

  it('nodeId 不存在 → 提示先 canvas.list_nodes,禁止用标题拼 id', async () => {
    const h = makeHandlers(makeStore([]), makeAssets({}));
    const r = await h.call('vision.caption', { nodeId: '人物参考图-1790509845606-00a2' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('canvas.list_nodes');
    expect(r.result).toContain('标题拼 id');
  });

  it('style 非法 → 明确拒绝(白名单外不静默落通用分支)', async () => {
    const h = makeHandlers(makeStore([]), makeAssets({}));
    const r = await h.call('vision.caption', { assetId: 'a1', style: 'bogus' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('style 非法');
  });

  it('asset 节点全链路:解析资产路径 → 端点 → 返回反推文本', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [{ message: { content: 'A green field at dawn.' } }] })));
    const h = makeHandlers(
      makeStore([{ id: 'asset-node-1', kind: 'asset', label: '参考图', position: { x: 0, y: 0 }, data: { assetId: 'asset-1' } }]),
      makeAssets({ 'asset-1': { id: 'asset-1', name: '参考图.png', localPath: join(assetDir, 'sample.png') } }),
    );
    const r = await h.call('vision.caption', { nodeId: 'asset-node-1' }, ctx);
    expect(r.ok, r.result).toBe(true);
    expect(r.result).toContain('A green field at dawn.');
    expect(r.result).toContain('参考图');
  });

  it('图片节点走 data.resultPath 全链路', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [{ message: { content: 'A red cube.' } }] })));
    const h = makeHandlers(
      makeStore([{ id: 'img-1', kind: 'image-gen', label: '商品图', position: { x: 0, y: 0 }, data: { resultPath: join(assetDir, 'sample.png') } }]),
      makeAssets({}),
    );
    const r = await h.call('vision.caption', { nodeId: 'img-1', style: 'zimage' }, ctx);
    expect(r.ok, r.result).toBe(true);
    expect(r.result).toContain('A red cube.');
  });

  it('端点失败 → 工具返回失败并带上原因(不静默吞)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    const h = makeHandlers(
      makeStore([{ id: 'img-2', kind: 'image-gen', label: '图', position: { x: 0, y: 0 }, data: { resultPath: join(assetDir, 'sample.png') } }]),
      makeAssets({}),
    );
    const r = await h.call('vision.caption', { nodeId: 'img-2' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('反推失败');
  });
});
