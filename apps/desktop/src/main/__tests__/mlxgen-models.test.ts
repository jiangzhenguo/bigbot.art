/**
 * mlxgen 模型缓存完整性校验测试(mlxgen-models.ts)
 * - 走真实代码路径:HF_HOME 指向临时目录,调 mlxgenModelInfo() 读 downloaded 字段
 * - 覆盖:目录缺失 / 空壳 snapshot(掐断于建目录阶段)/ .incomplete 分块 / 悬空符号链接 / 完整缓存
 * - 全部在临时目录构造,绝不触碰真实 ~/.cache/huggingface
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'AbstractFramework/z-image-turbo-8bit';
const REPO_DIR = 'models--AbstractFramework--z-image-turbo-8bit';

let hfHome = '';
let M: typeof import('../mlxgen-models.js');

const repoCache = (): string => join(hfHome, 'hub', REPO_DIR);
const resetRepo = (): void => rmSync(repoCache(), { recursive: true, force: true });
const model = () => M.mlxgenModelInfo().find((m) => m.repoId === REPO)!;

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
  process.env.HF_HOME = hfHome;
  M = await import('../mlxgen-models.js');
});

afterAll(() => {
  rmSync(hfHome, { recursive: true, force: true });
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
