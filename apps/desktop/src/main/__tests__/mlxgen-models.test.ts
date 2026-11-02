/**
 * mlxgen 模型缓存完整性校验测试(mlxgen-models.ts)
 * - 走真实代码路径:HF_HOME 指向临时目录,调 mlxgenModelInfo() 读 downloaded 字段
 * - 覆盖:目录缺失 / 空壳 snapshot(掐断于建目录阶段)/ .incomplete 分块 / 悬空符号链接 / 完整缓存
 * - 全部在临时目录构造,绝不触碰真实 ~/.cache/huggingface
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'AbstractFramework/z-image-turbo-8bit';
const REPO_DIR = 'models--AbstractFramework--z-image-turbo-8bit';

let hfHome = '';
let lmStudioHome = '';
let localHome = '';
let M: typeof import('../mlxgen-models.js');

const repoCache = (): string => join(hfHome, 'hub', REPO_DIR);
const resetRepo = (): void => rmSync(repoCache(), { recursive: true, force: true });
const model = () => M.mlxgenModelInfo().find((m) => m.repoId === REPO)!;

/** 看图反推行:走 LM Studio 那种**扁平 MLX-VL 目录**(无 transformer/ 子层)判定就绪 */
const CAPTION_REPO = 'gavinmroy/Qwen3-VL-8B-NSFW-Caption-V4.5-affine-4bit';
const captionModel = () => M.mlxgenModelInfo().find((m) => m.repoId === CAPTION_REPO)!;
const captionDir = (): string => join(lmStudioHome, 'gavinmroy', 'Qwen3-VL-8B-NSFW-Caption-V4.5-affine-4bit');

/** 构造一份 LM Studio 风格的 MLX Qwen3-VL 目录(config 判族 + 权重真在) */
function makeCaptionCheckpoint(opts: { modelType?: string; arch?: string; withWeights?: boolean } = {}): void {
  const dir = captionDir();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      model_type: opts.modelType ?? 'qwen3_vl',
      architectures: [opts.arch ?? 'Qwen3VLForConditionalGeneration'],
    }),
  );
  if (opts.withWeights !== false) writeFileSync(join(dir, 'model.safetensors'), 'weights');
}

/** 构造一份「完整」缓存:blobs/<hash> 非空 + snapshots/<commit>/model.safetensors 符号链接 */
function makeComplete(): void {
  const dir = repoCache();
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  mkdirSync(join(dir, 'snapshots', 'abc123'), { recursive: true });
  writeFileSync(join(dir, 'blobs', 'deadbeef'), 'weights');
  symlinkSync(join('..', '..', 'blobs', 'deadbeef'), join(dir, 'snapshots', 'abc123', 'model.safetensors'));
}

beforeAll(async () => {
  hfHome = mkdtempSync(join(tmpdir(), 'bbart-mlxdl-test-'));
  lmStudioHome = mkdtempSync(join(tmpdir(), 'bbart-lmstudio-test-'));
  localHome = mkdtempSync(join(tmpdir(), 'bbart-local-models-test-'));
  process.env.HF_HOME = hfHome;
  process.env.BIGBOTART_LMSTUDIO_MODELS = lmStudioHome;
  process.env.BIGBOTART_MODELS_DIR = localHome;
  M = await import('../mlxgen-models.js');
});

afterAll(() => {
  rmSync(hfHome, { recursive: true, force: true });
  rmSync(lmStudioHome, { recursive: true, force: true });
  rmSync(localHome, { recursive: true, force: true });
  delete process.env.BIGBOTART_LMSTUDIO_MODELS;
  delete process.env.BIGBOTART_MODELS_DIR;
});


describe('mlxgenDelete 本地模型删除', () => {
  const LOCAL_REPO = 'Qwen/Qwen-Image-2.1';
  const localDir = (): string => join(localHome, 'Qwen-Image-2.1-bf16');
  const localCache = (): string => join(hfHome, 'hub', 'models--Qwen--Qwen-Image-2.1');

  it('拒绝未知 repoId，不把传入字符串当文件路径删除', async () => {
    const result = await M.mlxgenDelete('/tmp/not-an-allowlisted-model');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不在图片模型清单内');
  });

  it('同时删除 HF 缓存和本地直用副本，列表不再显示已就绪，且不动相邻目录', async () => {
    const cache = localCache();
    mkdirSync(join(cache, 'blobs'), { recursive: true });
    mkdirSync(join(cache, 'snapshots', 'abc123'), { recursive: true });
    writeFileSync(join(cache, 'blobs', 'deadbeef'), 'weights');
    symlinkSync(join('..', '..', 'blobs', 'deadbeef'), join(cache, 'snapshots', 'abc123', 'model.safetensors'));
    mkdirSync(join(localDir(), 'transformer'), { recursive: true });
    writeFileSync(join(localDir(), 'transformer', 'model.safetensors'), 'weights');
    const sibling = join(localHome, 'do-not-delete.txt');
    writeFileSync(sibling, 'keep');
    expect(M.mlxgenModelInfo().find((m) => m.repoId === LOCAL_REPO)?.downloaded).toBe(true);

    const result = await M.mlxgenDelete(LOCAL_REPO);

    expect(result).toEqual({ ok: true });
    expect(existsSync(cache)).toBe(false);
    expect(existsSync(localDir())).toBe(false);
    expect(existsSync(sibling)).toBe(true);
    expect(M.mlxgenModelInfo().find((m) => m.repoId === LOCAL_REPO)?.downloaded).toBe(false);
  });

  it('也删除设置页识别到的 LM Studio 本地副本', async () => {
    makeCaptionCheckpoint();
    expect(captionModel().downloaded).toBe(true);

    const result = await M.mlxgenDelete(CAPTION_REPO);

    expect(result).toEqual({ ok: true });
    expect(existsSync(captionDir())).toBe(false);
    expect(captionModel().downloaded).toBe(false);
  });
});

describe('看图反推行:LM Studio 扁平 MLX-VL checkpoint 就绪判定', () => {
  it('LM Studio 里有合格的 Qwen3-VL 目录 → 已就绪,且回显 localPath(不必走 HF 缓存)', () => {
    makeCaptionCheckpoint();
    const m = captionModel();
    expect(m.downloaded).toBe(true);
    expect(m.localPath).toBe(captionDir());
  });

  it('目录在但 config 判族不是 Qwen3-VL(如 llama)→ 不算就绪(不把别的东西认成模型)', () => {
    makeCaptionCheckpoint({ modelType: 'llama', arch: 'LlamaForCausalLM' });
    expect(captionModel().downloaded).toBe(false);
  });

  it('只有 config 没有权重(下了一半)→ 不算就绪', () => {
    makeCaptionCheckpoint({ withWeights: false });
    expect(captionModel().downloaded).toBe(false);
  });

  it('目录不存在 → 未下载(不假装就绪)', () => {
    rmSync(captionDir(), { recursive: true, force: true });
    const m = captionModel();
    expect(m.downloaded).toBe(false);
    expect(m.localPath).toBeUndefined();
  });
});

describe('mlxgenModelInfo 已下载判定(HF 缓存完整性校验)', () => {
  it('缓存目录不存在 → 未下载', () => {
    resetRepo();
    expect(model().downloaded).toBe(false);
  });

  it('空壳 snapshot(下载掐断于建目录阶段)→ 未下载', () => {
    resetRepo();
    // 复刻真实事故现场:blobs/snapshots 都在,snapshot 里只有空子目录
    mkdirSync(join(repoCache(), 'blobs'), { recursive: true });
    mkdirSync(join(repoCache(), 'snapshots', 'abc123', 'transformer'), { recursive: true });
    expect(model().downloaded).toBe(false);
  });

  it('blobs 存在无主 .incomplete 分块(下载中断)→ 未下载', () => {
    resetRepo();
    makeComplete();
    writeFileSync(join(repoCache(), 'blobs', 'cafe.9f8e7d6c.incomplete'), 'partial');
    expect(model().downloaded).toBe(false);
  });

  it('.incomplete 残渣但同名 blob 已完成(Xet 重试遗留)→ 已下载', () => {
    resetRepo();
    makeComplete();
    // 真实事故形态:重试成功后旧分块不清理,<blob-hash>.<8hex>.incomplete 与完整 blob 并存
    writeFileSync(join(repoCache(), 'blobs', 'deadbeef.e29c22ec.incomplete'), 'stale');
    expect(model().downloaded).toBe(true);
  });

  it('.part 残留(ModelScope 直连中断/进行中)→ 未下载', () => {
    resetRepo();
    makeComplete();
    // 真实事故形态:App 退出时权重已部分落盘(vae/0.safetensors 完整 + 其余 .part 残留),
    // 旧规则只认 .incomplete 会把这种半成品误判「已下载」
    writeFileSync(join(repoCache(), 'blobs', 'cafebabe.part'), 'partial');
    expect(model().downloaded).toBe(false);
  });

  it('snapshot 符号链接悬空(blob 缺失)→ 未下载', () => {
    resetRepo();
    const dir = repoCache();
    mkdirSync(join(dir, 'blobs'), { recursive: true });
    mkdirSync(join(dir, 'snapshots', 'abc123'), { recursive: true });
    symlinkSync(join('..', '..', 'blobs', 'missing'), join(dir, 'snapshots', 'abc123', 'model.safetensors'));
    expect(model().downloaded).toBe(false);
  });

  it('只有配置/分词器、权重为零(Qwen 掐断实测形态)→ 未下载', () => {
    resetRepo();
    const dir = repoCache();
    mkdirSync(join(dir, 'blobs'), { recursive: true });
    const snap = join(dir, 'snapshots', 'abc123');
    mkdirSync(join(snap, 'tokenizer'), { recursive: true });
    mkdirSync(join(snap, 'text_encoder'), { recursive: true });
    // tokenizer/config 小文件齐全,还有 text_encoder 的分片索引,但权重一个都没下
    writeFileSync(join(dir, 'blobs', 'tok1'), 'vocab');
    writeFileSync(join(dir, 'blobs', 'idx1'), JSON.stringify({
      weight_map: { 'model.layers.0': 'model-00001-of-00002.safetensors' },
    }));
    symlinkSync(join('..', '..', 'blobs', 'tok1'), join(snap, 'tokenizer', 'vocab.json'));
    symlinkSync(join('..', '..', 'blobs', 'idx1'), join(snap, 'text_encoder', 'model.safetensors.index.json'));
    expect(model().downloaded).toBe(false);
  });

  it('index.json 引用分片缺失 → 未下载', () => {
    resetRepo();
    const dir = repoCache();
    mkdirSync(join(dir, 'blobs'), { recursive: true });
    const snap = join(dir, 'snapshots', 'abc123');
    mkdirSync(snap, { recursive: true });
    // 2 个分片只下完第 1 个
    writeFileSync(join(dir, 'blobs', 'shard1'), 'w1');
    writeFileSync(join(dir, 'blobs', 'idx'), JSON.stringify({
      weight_map: {
        'layers.0': 'model-00001-of-00002.safetensors',
        'layers.1': 'model-00002-of-00002.safetensors',
      },
    }));
    symlinkSync(join('..', '..', 'blobs', 'shard1'), join(snap, 'model-00001-of-00002.safetensors'));
    symlinkSync(join('..', '..', 'blobs', 'idx'), join(snap, 'model.safetensors.index.json'));
    expect(model().downloaded).toBe(false);
  });

  it('index.json 分片齐全 → 已下载', () => {
    resetRepo();
    const dir = repoCache();
    mkdirSync(join(dir, 'blobs'), { recursive: true });
    const snap = join(dir, 'snapshots', 'abc123');
    mkdirSync(snap, { recursive: true });
    writeFileSync(join(dir, 'blobs', 'shard1'), 'w1');
    writeFileSync(join(dir, 'blobs', 'shard2'), 'w2');
    writeFileSync(join(dir, 'blobs', 'idx'), JSON.stringify({
      weight_map: {
        'layers.0': 'model-00001-of-00002.safetensors',
        'layers.1': 'model-00002-of-00002.safetensors',
      },
    }));
    symlinkSync(join('..', '..', 'blobs', 'shard1'), join(snap, 'model-00001-of-00002.safetensors'));
    symlinkSync(join('..', '..', 'blobs', 'shard2'), join(snap, 'model-00002-of-00002.safetensors'));
    symlinkSync(join('..', '..', 'blobs', 'idx'), join(snap, 'model.safetensors.index.json'));
    expect(model().downloaded).toBe(true);
  });

  it('完整缓存(非空 blob + 有效链接)→ 已下载', () => {
    resetRepo();
    makeComplete();
    expect(model().downloaded).toBe(true);
  });
});
