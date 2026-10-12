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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ⚠️ 先于任何主进程模块加载:目录全部指向临时 HOME,绝不触碰真实用户数据(R5)
const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-vision-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');
// ⚠️ 测试机若**恰好**装了 MLX 格式 Qwen3-VL,auto 模式会去走本地 mlxgen-caption
// (真加载 6GB 模型!)—— 故本文件默认钉死端点通道,本地通道的用例自己临时切 env。
// 这也保证「同一份用例在任何机器上跑,走的是同一条通道」。
process.env.BIGBOTART_CAPTION_BACKEND = 'endpoint';

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
  /* ⚠️ 2026-10-12 用户反馈「反推出来的提示词都是英文」→ 默认风格必须**写死中文**,
     不能靠模型自己猜语言(同一张图会时中时英)。英文走显式 style=prompt-en。 */
  it('默认 style=prompt → 中文详述命令(不再是英文)', () => {
    const p = vision.buildCaptionInstruction('prompt');
    expect(p).toContain('中文');
    expect(p).not.toContain('English'); // 回归:旧实现这里写的是 "detailed English ... prompt"
    expect(p).toContain('文生图');
  });

  it('五种 style 的出稿要求互不相同', () => {
    const p = vision.buildCaptionInstruction('prompt');
    const en = vision.buildCaptionInstruction('prompt-en');
    const z = vision.buildCaptionInstruction('zimage');
    const h = vision.buildCaptionInstruction('h3');
    const j = vision.buildCaptionInstruction('json');
    expect(en).toContain('English');
    expect(z).toContain('Z-Image');
    expect(z).toContain('中文');
    expect(h).toContain('H3');
    expect(j).toContain('JSON');
    expect(j).toContain('值一律用中文');
    expect(new Set([p, en, z, h, j]).size).toBe(5);
  });

  it('未知 style 落通用分支(不抛错,同样是中文)', () => {
    const x = vision.buildCaptionInstruction('whatever');
    expect(x).toContain('中文');
    expect(x).not.toContain('English');
  });

  it('extra 追加到指令末尾(中文前缀);英文风格用英文前缀;空白 extra 不追加', () => {
    const zh = vision.buildCaptionInstruction('prompt', '强调光影');
    expect(zh).toContain('附加要求:强调光影');
    expect(vision.buildCaptionInstruction('prompt-en', 'emphasize lighting')).toContain('Additional requirement:emphasize lighting');
    const blank = vision.buildCaptionInstruction('prompt', '   ');
    expect(blank).not.toContain('附加要求');
    expect(blank).not.toContain('Additional requirement');
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

  it('默认发给端点的指令是**中文**成稿要求(2026-10-12 事故回归)', async () => {
    let sent: any;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
      sent = JSON.parse(init.body);
      return Response.json({ choices: [{ message: { content: '一只猫' } }] });
    }));
    await vision.captionImage(join(assetDir, 'sample.png'), 'prompt', undefined, { baseUrl: 'http://x/v1', model: 'm' });
    const text = sent.messages[0].content[0].text;
    expect(text).toContain('中文');
    expect(text).not.toContain('English');
  });

  it('style=prompt-en → 指令显式要英文(英文能力没被砍掉,只是不再默认)', async () => {
    let sent: any;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
      sent = JSON.parse(init.body);
      return Response.json({ choices: [{ message: { content: 'a cat' } }] });
    }));
    await vision.captionImage(join(assetDir, 'sample.png'), 'prompt-en', undefined, { baseUrl: 'http://x/v1', model: 'm' });
    expect(sent.messages[0].content[0].text).toContain('English');
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

  it('style=prompt-en → 通过白名单(新增风格没漏接线)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [{ message: { content: 'a cat' } }] })));
    const h = makeHandlers(
      makeStore([{ id: 'asset-node-en', kind: 'asset', label: '参考图', position: { x: 0, y: 0 }, data: { assetId: 'a1' } }]),
      makeAssets({ a1: { id: 'a1', name: '参考图.png', localPath: join(assetDir, 'sample.png') } }),
    );
    const r = await h.call('vision.caption', { nodeId: 'asset-node-en', style: 'prompt-en' }, ctx);
    expect(r.ok, r.result).toBe(true);
    expect(r.result).toContain('a cat');
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

/* ═══ 7. 本地引擎通道 mlxgen-caption(2026-10 对接)═══ */

/** 假 checkpoint 树 + 假命令:把「本机可用」这件事做成可控的注入,不碰真模型 */
function fakeLocalDeps(over: Partial<import('../mlxgen-caption.js').CaptionDeps> = {}) {
  const modelDir = '/fake/models/gavinmroy/Qwen3-VL-8B-NSFW-Caption-V4.5-affine-4bit';
  const tree: Record<string, string[]> = {
    '/fake/models': ['gavinmroy'],
    '/fake/models/gavinmroy': ['Qwen3-VL-8B-NSFW-Caption-V4.5-affine-4bit'],
    [modelDir]: ['config.json', 'model.safetensors'],
    '/fake/.cache/huggingface/hub': [],
  };
  const files: Record<string, string> = {
    [`${modelDir}/config.json`]: JSON.stringify({ model_type: 'qwen3_vl', architectures: ['Qwen3VLForConditionalGeneration'] }),
  };
  return {
    modelDir,
    /** 假 roots 必须落在 process.env 上:captionImage 内部读的是 process.env,不是测试局部 env */
    env: { BIGBOTART_CAPTION_MODEL_ROOTS: '/fake/models' },
    deps: {
      which: async (bin: string) => (bin === 'mlxgen-caption' ? '/fake/bin/mlxgen-caption' : undefined),
      // 假树 ∪ 真盘:caption 的 --output 临时文件是真实写入的,存在性必须落到真实 fs
      exists: (p: string) => p in tree || p in files || existsSync(p),
      listDir: (p: string) => tree[p] ?? [],
      // 同理:假树 ∪ 真盘 —— caption 的 --output 文件要能真读回来;不存在时 readFileSync 自然抛 ENOENT
      readText: (p: string) => (p in files ? files[p]! : readFileSync(p, 'utf8')),
      ...over,
    } as import('../mlxgen-caption.js').CaptionDeps,
  };
}

describe('resolveVisionRoute / planFallback(纯逻辑)', () => {
  it('BIGBOTART_CAPTION_BACKEND=endpoint → 端点通道(即使本机有本地模型)', async () => {
    const { deps } = fakeLocalDeps();
    const route = await vision.resolveVisionRoute({ ...process.env, BIGBOTART_CAPTION_BACKEND: 'endpoint' }, deps);
    expect(route.kind).toBe('endpoint');
  });

  it('=mlxgen → 本地通道,且 checkpoint 自动发现到 caption 微调', async () => {
    const { deps, modelDir } = fakeLocalDeps();
    const env = { ...process.env, BIGBOTART_CAPTION_BACKEND: 'mlxgen', BIGBOTART_CAPTION_MODEL_ROOTS: '/fake/models' };
    const route = await vision.resolveVisionRoute(env, deps);
    expect(route.kind).toBe('mlxgen');
    if (route.kind !== 'mlxgen') return;
    expect(route.config?.model).toBe(modelDir);
    expect(route.config?.cmd.bin).toBe('/fake/bin/mlxgen-caption');
  });

  it('=mlxgen 但本机没有命令 → 返回带原因的空 route(不回退,让用户看到真因)', async () => {
    const { deps } = fakeLocalDeps({ which: async () => undefined });
    const route = await vision.resolveVisionRoute({ ...process.env, BIGBOTART_CAPTION_BACKEND: 'mlxgen' }, deps);
    expect(route.kind).toBe('mlxgen');
    if (route.kind !== 'mlxgen') return;
    expect(route.config).toBeUndefined();
    expect(route.reason).toContain('mlxgen-caption');
  });

  it('auto + 本机可用 → 本地;auto + 本机不可用 → 端点(存量行为不变)', async () => {
    const { deps, modelDir } = fakeLocalDeps();
    const env = { ...process.env, BIGBOTART_CAPTION_BACKEND: 'auto', BIGBOTART_CAPTION_MODEL_ROOTS: '/fake/models' };
    const local = await vision.resolveVisionRoute(env, deps);
    expect(local.kind).toBe('mlxgen');
    if (local.kind === 'mlxgen') expect(local.config?.model).toBe(modelDir);

    const none = await vision.resolveVisionRoute(env, fakeLocalDeps({ which: async () => undefined }).deps);
    expect(none.kind).toBe('endpoint');
  });

  it('planFallback:auto 下端点→本地可回退;显式指定通道/关闭开关 → 不回退', () => {
    const ep: import('../vision.js').VisionRoute = { kind: 'endpoint', endpoint: { baseUrl: 'http://x/v1', model: 'm' } };
    const local: import('../vision.js').VisionRoute = { kind: 'mlxgen', config: undefined };
    expect(vision.planFallback(ep, { BIGBOTART_CAPTION_BACKEND: 'auto' } as NodeJS.ProcessEnv)).toBe('mlxgen');
    expect(vision.planFallback(local, { BIGBOTART_CAPTION_BACKEND: 'auto' } as NodeJS.ProcessEnv)).toBe('endpoint');
    // 用户显式选了通道 = 他的选择,失败就报失败
    expect(vision.planFallback(ep, { BIGBOTART_CAPTION_BACKEND: 'endpoint' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(vision.planFallback(local, { BIGBOTART_CAPTION_BACKEND: 'mlxgen' } as NodeJS.ProcessEnv)).toBeUndefined();
    // 设置页传入的 route 也是显式选择:env 仍是 auto 也不许换通道
    expect(vision.planFallback(ep, { BIGBOTART_CAPTION_BACKEND: 'auto' } as NodeJS.ProcessEnv, true)).toBeUndefined();
    expect(vision.planFallback(local, {} as NodeJS.ProcessEnv, true)).toBeUndefined();
    // 显式关掉回退
    expect(vision.planFallback(ep, { BIGBOTART_CAPTION_BACKEND: 'auto', BIGBOTART_CAPTION_FALLBACK: '0' } as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe('captionImage 本地通道与回退', () => {
  const img = (): string => join(assetDir, 'sample.png');
  const savedBackend = process.env.BIGBOTART_CAPTION_BACKEND;

  beforeEach(() => vi.unstubAllGlobals());
  afterAll(() => {
    if (savedBackend === undefined) delete process.env.BIGBOTART_CAPTION_BACKEND;
    else process.env.BIGBOTART_CAPTION_BACKEND = savedBackend;
    delete process.env.BIGBOTART_CAPTION_MODEL_ROOTS;
  });

  /** 假执行器:写 --output 文件(与真 CLI 同契约),并把收到的参数回传给断言 */
  function fakeRunner(caption = '一只猫坐在窗台上'): { run: NonNullable<import('../mlxgen-caption.js').CaptionDeps['run']>; calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      run: async (_cmd, args) => {
        calls.push([_cmd, ...args]);
        const i = args.indexOf('--output');
        writeFileSync(args[i + 1]!, caption);
        return { code: 0, stdout: '', stderr: '' };
      },
    };
  }

  it('route=mlxgen → 走本地引擎,返回 caption 与 backend 标记', async () => {
    process.env.BIGBOTART_CAPTION_BACKEND = 'mlxgen';
    process.env.BIGBOTART_CAPTION_MODEL_ROOTS = '/fake/models';
    const { deps, modelDir } = fakeLocalDeps();
    const { run, calls } = fakeRunner();
    const r = await vision.captionImage(img(), 'zimage', undefined, undefined, { ...deps, run });
    expect(r.ok, r.error).toBe(true);
    expect(r.caption).toBe('一只猫坐在窗台上');
    expect(r.backend).toBe('mlxgen');
    expect(r.model).toContain('Qwen3-VL-8B-NSFW-Caption'); // 回显目录名,不是模型名
    // 参数面:--model 指真目录、--image-path 指图、--prompt 收到 zimage 指令、temperature 0
    const argv = calls[0]!;
    expect(argv[argv.indexOf('--model') + 1]).toBe(modelDir);
    expect(argv[argv.indexOf('--image-path') + 1]).toBe(img());
    expect(argv[argv.indexOf('--prompt') + 1]).toContain('Z-Image');
    expect(argv[argv.indexOf('--temperature') + 1]).toBe('0');
  });

  it('route=mlxgen 但通道不可用 → 显式失败并说明原因(不偷偷换端点)', async () => {
    process.env.BIGBOTART_CAPTION_BACKEND = 'mlxgen';
    process.env.BIGBOTART_CAPTION_MODEL_ROOTS = '/fake/models';
    const { deps } = fakeLocalDeps({ which: async () => undefined });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await vision.captionImage(img(), 'prompt', undefined, undefined, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('本地看图通道不可用');
    expect(fetchSpy).not.toHaveBeenCalled(); // 关键:没有偷偷回退到端点
  });

  it('设置页显式绑定端点失败 → 不回退本地(env 仍是 auto 也尊重这次选择)', async () => {
    delete process.env.BIGBOTART_CAPTION_BACKEND;
    process.env.BIGBOTART_CAPTION_MODEL_ROOTS = '/fake/models';
    const { deps } = fakeLocalDeps();
    const { run, calls } = fakeRunner('不该出现的本地描述');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('lmstudio down', { status: 503 })));
    const boundEndpoint: import('../vision.js').VisionRoute = { kind: 'endpoint', endpoint: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'vl' } };
    const r = await vision.captionImage(img(), 'prompt', undefined, boundEndpoint, { ...deps, run });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('503');
    expect(r.note).toBeUndefined();
    expect(calls.length).toBe(0);
  });

  it('设置页显式绑定本地通道但不可用 → 不回退端点', async () => {
    delete process.env.BIGBOTART_CAPTION_BACKEND;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await vision.captionImage(img(), 'prompt', undefined, {
      kind: 'mlxgen',
      reason: '没有可用的 checkpoint',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('没有可用的 checkpoint');
    expect(r.note).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('auto 且未显式绑定:本地失败后再试端点,两条错误都报出来', async () => {
    process.env.BIGBOTART_CAPTION_BACKEND = 'auto';
    process.env.BIGBOTART_CAPTION_MODEL_ROOTS = '/fake/models';
    const { deps } = fakeLocalDeps();
    const run = async (): Promise<{ code: number; stdout: string; stderr: string }> => ({
      code: 1,
      stdout: '',
      stderr: 'MLX-Gen will not download model files during generation',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('lmstudio down', { status: 503 })));
    const r = await vision.captionImage(img(), 'prompt', undefined, undefined, { ...deps, run });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('mlxgen-caption 退出码');
    expect(r.error).toContain('回退endpoint 也失败');
    expect(r.error).toContain('503');
  });

  it('显式指定端点通道 → 端点失败时不回退(尊重用户选择)', async () => {
    process.env.BIGBOTART_CAPTION_BACKEND = 'endpoint';
    const { deps } = fakeLocalDeps();
    const { run, calls } = fakeRunner();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const r = await vision.captionImage(img(), 'prompt', undefined, undefined, { ...deps, run });
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(0); // 本地执行器一次都没被调用
  });
});
