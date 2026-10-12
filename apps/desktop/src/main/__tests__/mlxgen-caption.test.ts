/**
 * 本地看图通道 mlxgen-caption 单测(2026-10 对接)
 *
 * 覆盖:
 *  1. 命令解析:`BIGBOTART_CAPTION_BIN` → PATH 里的 `mlxgen-caption` → **从 mlxgen 的 shebang
 *     反查 venv python + `-m` 模块**(引擎的 console script 是新增的,旧 venv 里没有 ——
 *     这条回退是本机能跑起来的关键,必须有测试钉住)
 *  2. checkpoint 发现:LM Studio / ~/ai/models 两层目录 + HF 缓存 snapshots;
 *     判族看 config.json(model_type/architectures),「下了一半」的目录要排除
 *  3. 绑定解析:设置页 model > env > 自动发现;任何一环缺 → 明确不可用(不编造)
 *  4. 参数构造:与引擎 caption.py 的参数面一一对应(temperature 固定 0 = 贪心)
 *  5. 执行:成功(读 --output 文件)/ 非零退出 / 命令缺失给安装指引 / 空产物报错 / 模型目录不存在
 *  6. 探测:probeLocalCaption 的可用性判定
 *
 * 全部用注入的假 which/exists/listDir/readText/run —— 不加载真模型、不碰用户目录。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCaptionCliArgs,
  captionCommandHint,
  discoverCaptionModels,
  probeLocalCaption,
  resolveCaptionCommand,
  resolveCaptionConfig,
  resolveCaptionConfigDetailed,
  runMlxgenCaption,
  type CaptionDeps,
  type MlxgenCaptionConfig,
} from '../mlxgen-caption.js';

const MODEL_DIR = '/fake/models/gavinmroy/Qwen3-VL-8B-NSFW-Caption-V4.5-affine-4bit';
const CMD = { bin: '/fake/bin/mlxgen-caption', prefixArgs: [], label: '/fake/bin/mlxgen-caption' };

/** 假文件树(LM Studio 布局 + 一个非 VL 目录 + 一个「下了一半」的 VL 目录);extra 用于追加 HF 缓存布局 */
function fakeTree(extra: { dirs?: Record<string, string[]>; files?: Record<string, string> } = {}): CaptionDeps {
  const dirs: Record<string, string[]> = {
    '/fake/models': ['gavinmroy', 'someone'],
    '/fake/models/gavinmroy': ['Qwen3-VL-8B-NSFW-Caption-V4.5-affine-4bit'],
    [MODEL_DIR]: ['config.json', 'model.safetensors', 'tokenizer.json'],
    '/fake/models/someone': ['Llama-3-8B', 'Qwen3-VL-4B-no-weights'],
    '/fake/models/someone/Llama-3-8B': ['config.json', 'model.safetensors'],
    '/fake/models/someone/Qwen3-VL-4B-no-weights': ['config.json'],
    ...(extra.dirs ?? {}),
  };
  const files: Record<string, string> = {
    [`${MODEL_DIR}/config.json`]: JSON.stringify({ model_type: 'qwen3_vl', architectures: ['Qwen3VLForConditionalGeneration'] }),
    ['/fake/models/someone/Llama-3-8B/config.json']: JSON.stringify({ model_type: 'llama' }),
    ['/fake/models/someone/Qwen3-VL-4B-no-weights/config.json']: JSON.stringify({ model_type: 'qwen3_vl' }),
    ...(extra.files ?? {}),
  };
  return {
    exists: (p) => p in dirs || p in files,
    listDir: (p) => dirs[p] ?? [],
    readText: (p) => {
      if (p in files) return files[p]!;
      throw new Error(`ENOENT: ${p}`);
    },
  };
}

/** model 目录视为存在,其余交给真实 fs(用于 runMlxgenCaption:--output 临时文件要真的能读回) */
const existsForModel = (p: string): boolean => p === MODEL_DIR || existsSync(p);

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/* ── 1. 命令解析 ── */
describe('resolveCaptionCommand', () => {
  it('BIGBOTART_CAPTION_BIN 显式指定(存在才认)', async () => {
    const deps: CaptionDeps = { exists: (p) => p === '/my/mlxgen-caption', which: async () => undefined };
    const cmd = await resolveCaptionCommand({ BIGBOTART_CAPTION_BIN: '/my/mlxgen-caption' }, deps);
    expect(cmd?.bin).toBe('/my/mlxgen-caption');
    expect(cmd?.prefixArgs).toEqual([]);
  });

  it('显式指定 + BIGBOTART_CAPTION_MODULE → 走 python -m 形态', async () => {
    const deps: CaptionDeps = { exists: () => true, which: async () => undefined };
    const cmd = await resolveCaptionCommand(
      { BIGBOTART_CAPTION_BIN: '/my/venv/bin/python', BIGBOTART_CAPTION_MODULE: '1' },
      deps,
    );
    expect(cmd?.bin).toBe('/my/venv/bin/python');
    expect(cmd?.prefixArgs).toEqual(['-m', 'mflux.models.qwen3_vl_caption.cli.caption']);
  });

  it('显式指定但文件不存在 → undefined(不假装可用)', async () => {
    const deps: CaptionDeps = { exists: () => false, which: async () => undefined };
    expect(await resolveCaptionCommand({ BIGBOTART_CAPTION_BIN: '/gone' }, deps)).toBeUndefined();
  });

  it('PATH 里有 mlxgen-caption → 直接用', async () => {
    const deps: CaptionDeps = { which: async (b) => (b === 'mlxgen-caption' ? '/usr/local/bin/mlxgen-caption' : undefined) };
    const cmd = await resolveCaptionCommand({}, deps);
    expect(cmd?.bin).toBe('/usr/local/bin/mlxgen-caption');
  });

  /* 关键回退:引擎新加了 console script,但用户机器上的 uv tool venv 是旧的
     (`command -v mlxgen-caption` 为空)。此时用 mlxgen 的 shebang 反查解释器跑模块入口。 */
  it('无 console script 时从 mlxgen 的 shebang 反查 venv python 跑模块', async () => {
    const deps: CaptionDeps = {
      which: async (b) => (b === 'mlxgen' ? '/fake/bin/mlxgen' : undefined),
      exists: (p) => p === '/fake/venv/bin/python',
      readText: () => '#!/fake/venv/bin/python\n# -*- coding: utf-8 -*-\nimport sys\n',
    };
    const cmd = await resolveCaptionCommand({}, deps);
    expect(cmd?.bin).toBe('/fake/venv/bin/python');
    expect(cmd?.prefixArgs).toEqual(['-m', 'mflux.models.qwen3_vl_caption.cli.caption']);
    expect(cmd?.label).toContain('mlxgen');
  });

  it('shebang 指向的解释器不存在 → undefined(回退不许瞎猜)', async () => {
    const deps: CaptionDeps = {
      which: async (b) => (b === 'mlxgen' ? '/fake/bin/mlxgen' : undefined),
      exists: () => false,
      readText: () => '#!/fake/venv/bin/python\n',
    };
    expect(await resolveCaptionCommand({}, deps)).toBeUndefined();
  });

  it('mlxgen 也没有 → undefined', async () => {
    expect(await resolveCaptionCommand({}, { which: async () => undefined })).toBeUndefined();
  });
});

/* ── 2. checkpoint 发现 ── */
describe('discoverCaptionModels', () => {
  it('认出 MLX Qwen3-VL,排除非 VL 与「下了一半」的目录', () => {
    const found = discoverCaptionModels({ BIGBOTART_CAPTION_MODEL_ROOTS: '/fake/models' }, fakeTree(), '/fake/home');
    expect(found).toEqual([MODEL_DIR]); // Llama 不是 VL;Qwen3-VL-4B 没权重
  });

  it('同时扫 HF 缓存 snapshots(mlxgen download 落盘处)', () => {
    const snap = '/fake/hub/models--org--vl/snapshots/abc123';
    const deps = fakeTree({
      dirs: {
        '/fake/hub': ['models--org--vl', 'models--other--x'],
        '/fake/hub/models--org--vl': ['snapshots'],
        '/fake/hub/models--org--vl/snapshots': ['abc123'],
        [snap]: ['config.json', 'weights.safetensors'],
      },
      files: { [`${snap}/config.json`]: JSON.stringify({ model_type: 'qwen3_vl' }) },
    });
    const found = discoverCaptionModels({ HF_HUB_CACHE: '/fake/hub', BIGBOTART_CAPTION_MODEL_ROOTS: '/nonexistent' }, deps, '/fake/home');
    expect(found).toContain(snap);
  });

  it('caption 微调排在最前(提示词反推质量最好)', () => {
    const deps = fakeTree();
    const base = '/fake/models/someone/Qwen3-VL-4B';
    deps.exists = (p) => p === base || p === join(base, 'config.json') || p === join(base, 'w.safetensors') || fakeTree().exists!(p);
    deps.listDir = (p) => (p === '/fake/models/someone' ? ['Qwen3-VL-4B'] : p === base ? ['config.json', 'w.safetensors'] : fakeTree().listDir!(p));
    const rf = fakeTree().readText!;
    deps.readText = (p) => (p === join(base, 'config.json') ? JSON.stringify({ model_type: 'qwen3_vl' }) : rf(p));
    const found = discoverCaptionModels({ BIGBOTART_CAPTION_MODEL_ROOTS: '/fake/models' }, deps, '/fake/home');
    expect(found[0]).toBe(MODEL_DIR);
    expect(found).toContain(base);
  });

  it('目录读不动 → 空结果而不是抛错', () => {
    const found = discoverCaptionModels({}, { exists: () => true, listDir: () => { throw new Error('EACCES'); } }, '/fake/home');
    expect(found).toEqual([]);
  });
});

/* ── 3. 绑定解析 ── */
describe('resolveCaptionConfig', () => {
  const envBase = { BIGBOTART_CAPTION_MODEL_ROOTS: '/fake/models' };

  it('自动发现 + 默认预算(640000 / 1024)', async () => {
    const cfg = await resolveCaptionConfig(envBase, undefined, { ...fakeTree(), which: async () => CMD.bin });
    expect(cfg?.model).toBe(MODEL_DIR);
    expect(cfg?.maxPixels).toBe(640_000);
    expect(cfg?.maxTokens).toBe(1024);
  });

  it('设置页绑定优先于 env,且预算可覆盖', async () => {
    const cfg = await resolveCaptionConfig(
      { ...envBase, BIGBOTART_CAPTION_MODEL: '/from/env' },
      { model: MODEL_DIR, maxPixels: 100_000, maxTokens: 256 },
      { ...fakeTree(), which: async () => CMD.bin, exists: (p) => p === MODEL_DIR || fakeTree().exists!(p) },
    );
    expect(cfg?.model).toBe(MODEL_DIR);
    expect(cfg?.maxPixels).toBe(100_000);
    expect(cfg?.maxTokens).toBe(256);
  });

  it('显式给的本地目录不存在 → 不可用(不静默降级到别的 checkpoint)', async () => {
    const cfg = await resolveCaptionConfig({}, { model: '/nope/dir' }, { ...fakeTree(), which: async () => CMD.bin, exists: () => false });
    expect(cfg).toBeUndefined();
  });

  it('给 repo id(非绝对路径)时不做存在性检查,交给引擎去缓存找', async () => {
    const cfg = await resolveCaptionConfig({}, { model: 'mlx-community/Qwen3-VL-4B-Instruct-4bit' }, { which: async () => CMD.bin });
    expect(cfg?.model).toBe('mlx-community/Qwen3-VL-4B-Instruct-4bit');
  });

  /* ⚠️ 真实事故 2026-10-12:用户在设置页填的不是路径也不是仓库 id,而是 **LM Studio 的模型名**
     (`qwen3-vl-8b-nsfw-caption-v4.5-affine`)。旧实现会把它原样当 `--model` 丢给引擎 →
     「MLX-Gen will not download model files」失败。现按归一化名字反查本机 checkpoint。 */
  it('裸模型名(LM Studio 的模型名)→ 反查匹配到本机 checkpoint 目录', async () => {
    const deps = { ...fakeTree(), which: async () => CMD.bin };
    const cfg = await resolveCaptionConfig(envBase, { model: 'qwen3-vl-8b-nsfw-caption-v4.5-affine' }, deps);
    expect(cfg?.model).toBe(MODEL_DIR); // 不是把裸名字丢给引擎
  });

  it('裸名字匹配不到 → 明确说是「既不是目录也不是仓库 id」并列出本机候选', async () => {
    const deps = { ...fakeTree(), which: async () => CMD.bin };
    const r = await resolveCaptionConfigDetailed(envBase, { model: 'totally-unknown-model' }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('既不是目录路径也不是仓库 id');
    expect(r.reason).toContain(MODEL_DIR); // 列出本机已发现
    expect(r.reason).toContain('留空则自动发现');
  });

  it('填的绝对路径不存在 → 点名「目录不存在」而不是笼统说通道不可用', async () => {
    const deps = { ...fakeTree(), which: async () => CMD.bin, exists: () => false };
    const r = await resolveCaptionConfigDetailed(envBase, { model: '/nope/checkpoint' }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('模型目录不存在');
    expect(r.reason).toContain('/nope/checkpoint');
  });

  it('路径在但不是合格 MLX Qwen3-VL 目录(如指到 torch 布局/别的东西)→ 说出具体判据', async () => {
    const deps = {
      ...fakeTree(),
      which: async () => CMD.bin,
      exists: (p: string) => p === '/bad/dir' || p === '/bad/dir/config.json',
      listDir: () => [],
      readText: () => JSON.stringify({ model_type: 'llama', architectures: ['LlamaForCausalLM'] }),
    };
    const r = await resolveCaptionConfigDetailed(envBase, { model: '/bad/dir' }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('不是合格的 MLX 格式 dense Qwen3-VL');
  });

  it('本机一个 checkpoint 都没有且留空 → 说清自动发现范围', async () => {
    const deps: CaptionDeps = { which: async () => CMD.bin, exists: () => false, listDir: () => [] };
    const r = await resolveCaptionConfigDetailed({}, undefined, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('没有找到 MLX 格式的 Qwen3-VL checkpoint');
    expect(r.reason).toContain('~/.lmstudio/models');
  });

  it('没有命令 → 不可用', async () => {
    expect(await resolveCaptionConfig(envBase, undefined, { ...fakeTree(), which: async () => undefined })).toBeUndefined();
  });

  it('没有 checkpoint → 不可用', async () => {
    const cfg = await resolveCaptionConfig(envBase, undefined, { which: async () => CMD.bin, exists: () => false, listDir: () => [] });
    expect(cfg).toBeUndefined();
  });
});

/* ── 4. 参数构造 ── */
describe('buildCaptionCliArgs', () => {
  const cfg: MlxgenCaptionConfig = {
    cmd: { bin: '/p', prefixArgs: ['-m', 'mod'], label: 'p -m mod' },
    model: MODEL_DIR,
    maxPixels: 640_000,
    maxTokens: 1024,
    timeoutMs: 1000,
  };

  it('参数面与引擎 caption.py 一一对应,且 temperature 固定 0(贪心)', () => {
    const args = buildCaptionCliArgs(cfg, '/img/a.png', '写提示词', '/tmp/out.txt');
    expect(args.slice(0, 2)).toEqual(['-m', 'mod']); // 前缀参数在最前
    const pick = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
    expect(pick('--model')).toBe(MODEL_DIR);
    expect(pick('--image-path')).toBe('/img/a.png');
    expect(pick('--prompt')).toBe('写提示词');
    expect(pick('--max-tokens')).toBe('1024');
    expect(pick('--max-pixels')).toBe('640000');
    expect(pick('--temperature')).toBe('0');
    expect(pick('--output')).toBe('/tmp/out.txt');
    // 不传引擎不认识/不该用的开关
    expect(args).not.toContain('--backend');
    expect(args).not.toContain('--prompt-preset');
  });
});

/* ── 5. 执行 ── */
describe('runMlxgenCaption', () => {
  const cfg = (over: Partial<MlxgenCaptionConfig> = {}): MlxgenCaptionConfig => ({
    cmd: CMD,
    model: MODEL_DIR,
    maxPixels: 640_000,
    maxTokens: 1024,
    timeoutMs: 5000,
    ...over,
  });

  it('成功:CLI 写 --output 文件,读回文本并回显 checkpoint 目录名', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bba-cap-'));
    tmpDirs.push(dir);
    const seen: string[] = [];
    const res = await runMlxgenCaption(cfg(), '/img/a.png', 'desc', {
      exists: existsForModel,
      makeTmpDir: () => dir,
      run: async (cmd, args) => {
        seen.push(cmd, ...args);
        writeFileSync(args[args.indexOf('--output') + 1]!, '一只戴帽子的猫\n');
        return { code: 0, stdout: 'caption: 594 prompt tokens', stderr: '' };
      },
    });
    expect(res.ok, res.error).toBe(true);
    expect(res.caption).toBe('一只戴帽子的猫'); // 只取文件内容,不掺 stdout 的统计行
    expect(res.model).toBe('Qwen3-VL-8B-NSFW-Caption-V4.5-affine-4bit');
    expect(seen[0]).toBe(CMD.bin);
  });

  it('非零退出 → 带退出码与 stderr 尾部(不静默返回空)', async () => {
    const res = await runMlxgenCaption(cfg(), '/img/a.png', 'desc', {
      exists: existsForModel,
      run: async () => ({ code: 2, stdout: '', stderr: 'Unsupported Qwen3-VL decoder checkpoint: 3 weight(s) do not map' }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('退出码 2');
    expect(res.error).toContain('do not map');
  });

  it('命令不存在(ENOENT)→ 给安装指引,而不是裸报错', async () => {
    const res = await runMlxgenCaption(cfg(), '/img/a.png', 'desc', {
      exists: existsForModel,
      run: async () => ({ code: -1, stdout: '', stderr: 'spawn mlxgen-caption ENOENT' }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('uv tool install');
    expect(res.error).toBe(captionCommandHint());
  });

  it('退出码 0 但没有产物 → 明确失败(绝不返回空提示词当成功)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bba-cap-'));
    tmpDirs.push(dir);
    const res = await runMlxgenCaption(cfg(), '/img/a.png', 'desc', {
      exists: existsForModel,
      makeTmpDir: () => dir,
      run: async () => ({ code: 0, stdout: '   ', stderr: 'no output' }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('未产出文本');
  });

  it('checkpoint 目录不存在 → 提前报错并给出改路径的指引', async () => {
    const res = await runMlxgenCaption(cfg({ model: '/nope/checkpoint' }), '/img/a.png', 'desc', { exists: () => false });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('模型目录不存在');
  });

  it('超时(stderr 带超时说明)按失败处理', async () => {
    const res = await runMlxgenCaption(cfg(), '/img/a.png', 'desc', {
      exists: existsForModel,
      run: async () => ({ code: -1, stdout: '', stderr: '[caption] 超时 300s,已终止进程' }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('超时');
  });
});

/* ── 6. 探测 ── */
describe('probeLocalCaption', () => {
  it('命令 + checkpoint 齐 → available 且回显命令与模型', async () => {
    const p = await probeLocalCaption(
      { BIGBOTART_CAPTION_MODEL_ROOTS: '/fake/models' },
      undefined,
      { ...fakeTree(), which: async () => CMD.bin, isDir: () => true },
    );
    expect(p.available).toBe(true);
    expect(p.model).toBe(MODEL_DIR);
    expect(p.command).toBe(CMD.bin);
  });

  it('命令缺失 → available=false(不用抛错表达不可用)', async () => {
    const p = await probeLocalCaption({}, undefined, { ...fakeTree(), which: async () => undefined });
    expect(p.available).toBe(false);
  });

  it('配置了但盘上没有该目录 → available=false 且带原因', async () => {
    const p = await probeLocalCaption({}, { model: MODEL_DIR }, { which: async () => CMD.bin, exists: () => false });
    expect(p.available).toBe(false);
    expect(p.reason).toContain('模型目录不存在');
    expect(existsSync(MODEL_DIR)).toBe(false); // 防呆:确认这里真的是假路径
  });
});
