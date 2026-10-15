/**
 * H3StyleModelBuilder(h3-style-model.ts)单测 —— 风格包(mystic)下载 + 融合构建
 *
 * ⚠️ 模块级 STYLE_MODEL_SOURCES 在 import 时按 BIGBOTART_H3_ROOT 求值,
 *    故 env 必须在 import 前设好(与 lora-store.test.ts 同口径)。
 *
 * 锁定行为:
 *  ① status():LoRA/基础模型/脚本/产物逐项检测;HTML 错误页不认作 LoRA;
 *  ② 未登记的 packId → buildable=false,不假装能构建;
 *  ③ build() 早期失败:基础模型/脚本缺失时**不启动**任何子进程;
 *  ④ e2e(假 merge 脚本 + 真 cp):非 transformer 组件复制、两个 transformer 各融合一次、
 *     **merge 前先清产物侧 transformer**(幂等红线:对已融合目录重跑会双重叠加 LoRA);
 *  ⑤ 无构建进行中时 cancel 返回 ok:false。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'bbart-style-model-'));
const H3_ROOT = join(tmpRoot, 'h3');
const BASE = join(H3_ROOT, 'MiniMax-H3');
const SCRIPT = join(H3_ROOT, 'merge_lora_h3.py');
const LORA_DIR = join(H3_ROOT, 'mysticxxx-lora');
const OUT = join(H3_ROOT, 'MiniMax-H3-mystic');

process.env.BIGBOTART_H3_ROOT = H3_ROOT;
process.env.BIGBOTART_H3_MODEL = BASE;
process.env.BIGBOTART_H3_MERGE_PY = SCRIPT;

let H3StyleModelBuilder: typeof import('../h3-style-model.js').H3StyleModelBuilder;

/** 造一个合法的 safetensors 假文件(>1MB + 合法 header 头,过 looksLikeSafetensors) */
function writeFakeSafetensors(path: string): void {
  const header = Buffer.from('{"x":{"dtype":"BF16","shape":[1],"data_offsets":[0,2]}}   ');
  const buf = Buffer.alloc(2 * 1024 * 1024);
  buf.writeBigUInt64LE(BigInt(header.length), 0);
  header.copy(buf, 8);
  writeFileSync(path, buf);
}

/** 造基础模型骨架:FL2VA/Ref2VA 各含 transformer(2 个 shard)+ 非 transformer 组件 */
function makeBaseModel(): void {
  for (const sub of ['FL2VA', 'Ref2VA']) {
    mkdirSync(join(BASE, sub, 'transformer'), { recursive: true });
    writeFileSync(join(BASE, sub, 'transformer', 'shard-1.safetensors'), `base-${sub}-1`);
    writeFileSync(join(BASE, sub, 'transformer', 'shard-2.safetensors'), `base-${sub}-2`);
    writeFileSync(join(BASE, sub, 'model_index.json'), '{}');
    mkdirSync(join(BASE, sub, 'tokenizer'), { recursive: true });
    writeFileSync(join(BASE, sub, 'tokenizer', 'tokenizer.json'), '{}');
  }
}

/** 假融合脚本:建 dst 目录、写 marker(内容 = LoRA 文件名)、复制 src shard(模拟 copy+patch) */
const FAKE_SCRIPT = `import sys, os, shutil
a = sys.argv
lora = a[a.index('--lora') + 1]
src = a[a.index('--src') + 1]
dst = a[a.index('--dst') + 1]
os.makedirs(dst, exist_ok=True)
for f in os.listdir(src):
    shutil.copyfile(os.path.join(src, f), os.path.join(dst, f))
open(os.path.join(dst, 'merged.marker'), 'w').write(os.path.basename(lora))
open(os.path.join(dst, 'merges.log'), 'a').write(os.path.basename(lora) + '\\n')
print('fake merge done', flush=True)
`;

beforeAll(async () => {
  H3StyleModelBuilder = (await import('../h3-style-model.js')).H3StyleModelBuilder;
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('styleModelStatus · 逐项检测', () => {
  it('未登记的 packId → buildable=false 并给手动指引', () => {
    const b = new H3StyleModelBuilder(() => {});
    const st = b.status('no-such-pack');
    expect(st.buildable).toBe(false);
    expect(st.missing.join()).toContain('手动');
  });

  it('mystic 全缺 → missing 列出基础模型/脚本/两个 LoRA', () => {
    rmSync(H3_ROOT, { recursive: true, force: true });
    const b = new H3StyleModelBuilder(() => {});
    const st = b.status('mystic');
    expect(st.buildable).toBe(true);
    expect(st.mergedReady).toBe(false);
    expect(st.baseReady).toBe(false);
    expect(st.scriptReady).toBe(false);
    expect(st.loras).toHaveLength(2);
    expect(st.missing.join()).toContain('MysticXXX_MMH3-V4.safetensors');
    expect(st.missing.join()).toContain('ref2va');
  });

  it('HTML 错误页(403 登录页)不认作 LoRA(safetensors 轻校验)', () => {
    mkdirSync(LORA_DIR, { recursive: true });
    writeFileSync(join(LORA_DIR, 'MysticXXX_MMH3-V4.safetensors'), '<html><body>403 Forbidden — please log in</body></html>');
    const b = new H3StyleModelBuilder(() => {});
    const st = b.status('mystic');
    const fl2va = st.loras.find((l) => l.target === 'FL2VA')!;
    expect(fl2va.exists).toBe(false);
    expect(st.missing.join()).toContain('MysticXXX_MMH3-V4.safetensors');
  });
});

describe('styleModelBuild · 前置校验', () => {
  it('基础模型未就绪 → 直接报错,不启动下载/融合', async () => {
    rmSync(BASE, { recursive: true, force: true });
    writeFileSync(SCRIPT, FAKE_SCRIPT);
    const b = new H3StyleModelBuilder(() => {});
    const r = await b.build('mystic');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('基础模型未就绪');
  });

  it('融合脚本缺失 → 直接报错', async () => {
    makeBaseModel();
    rmSync(SCRIPT, { force: true });
    const b = new H3StyleModelBuilder(() => {});
    const r = await b.build('mystic');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('融合脚本不存在');
  });

  it('无构建进行中时 cancel → ok:false', () => {
    const b = new H3StyleModelBuilder(() => {});
    expect(b.cancel().ok).toBe(false);
  });
});

describe('styleModelBuild · e2e(假 merge 脚本 + 真 cp,LoRA 预置合法)', () => {
  it('复制非 transformer 组件 + 两个 transformer 各融合一次 + 产物就绪', async () => {
    // 材料齐备:基础模型 + 脚本 + 两个合法 LoRA
    makeBaseModel();
    writeFileSync(SCRIPT, FAKE_SCRIPT);
    mkdirSync(LORA_DIR, { recursive: true });
    writeFakeSafetensors(join(LORA_DIR, 'MysticXXX_MMH3-V4.safetensors'));
    writeFakeSafetensors(join(LORA_DIR, 'MysticXXX_MMH3-V4-ref2va.safetensors'));
    // 预置「脏」产物 transformer(上次中断的半成品)→ 验证 merge 前被清掉(幂等红线)
    mkdirSync(join(OUT, 'FL2VA', 'transformer'), { recursive: true });
    writeFileSync(join(OUT, 'FL2VA', 'transformer', 'STALE.safetensors'), 'stale-double-lora');

    const events: string[] = [];
    const b = new H3StyleModelBuilder((ev) => events.push(`${ev.stage}:${ev.message}`));
    const r = await b.build('mystic');
    expect(r.ok).toBe(true);

    // 非 transformer 组件被复制到产物
    expect(existsSync(join(OUT, 'FL2VA', 'model_index.json'))).toBe(true);
    expect(existsSync(join(OUT, 'Ref2VA', 'tokenizer', 'tokenizer.json'))).toBe(true);
    // 两个 transformer 各自融合了正确的 LoRA(FL2VA ↔ V4,Ref2VA ↔ V4-ref2va)
    expect(readFileSync(join(OUT, 'FL2VA', 'transformer', 'merged.marker'), 'utf-8')).toBe('MysticXXX_MMH3-V4.safetensors');
    expect(readFileSync(join(OUT, 'Ref2VA', 'transformer', 'merged.marker'), 'utf-8')).toBe('MysticXXX_MMH3-V4-ref2va.safetensors');
    // ⚠️ 脏 transformer 被清(STALE 文件不存在)= 重跑不会双重叠加 LoRA
    expect(existsSync(join(OUT, 'FL2VA', 'transformer', 'STALE.safetensors'))).toBe(false);
    // src shard 被 merge 脚本复制过来
    expect(readFileSync(join(OUT, 'FL2VA', 'transformer', 'shard-1.safetensors'), 'utf-8')).toBe('base-FL2VA-1');
    // 进度事件流含各阶段并以 done 收尾
    const stages = events.map((e) => e.split(':')[0]);
    expect(stages).toContain('copy');
    expect(stages).toContain('merge-FL2VA');
    expect(stages).toContain('merge-Ref2VA');
    expect(stages[stages.length - 1]).toBe('done');

    // 构建完成后 status 报产物就绪
    const st = b.status('mystic');
    expect(st.mergedReady).toBe(true);
    expect(st.missing).toEqual([]);
  });

  it('已有构建进行中 → 第二个 build 拒绝(防重入)', async () => {
    // 上一个用例已把产物建齐;这里把脚本换成「阻塞版」制造进行中的窗口
    writeFileSync(SCRIPT, 'import time\ntime.sleep(30)\n');
    const b = new H3StyleModelBuilder(() => {});
    const first = b.build('mystic'); // 不 await:让它跑起来
    // 等它进入 merge 阶段(轮询 isRunning)
    for (let i = 0; i < 200 && !b.isRunning(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(b.isRunning()).toBe(true);
    const second = await b.build('mystic');
    expect(second.ok).toBe(false);
    expect(second.error).toContain('进行中');
    // 收尾:取消第一个,避免测试悬挂
    b.cancel();
    const r1 = await first;
    expect(r1.ok).toBe(false);
  });
});

describe('styleModelBuild · 双融合包(mystic-turbo):先风格后 turbo,transformer 只删一次', () => {
  const OUT_MT = join(H3_ROOT, 'MiniMax-H3-mystic-turbo');
  const TURBO_DIR = join(H3_ROOT, 'turbo-lora');

  it('顺序两次 merge(风格 → turbo),第一次的成果不被第二次清掉,脏目录先清一次', async () => {
    makeBaseModel();
    writeFileSync(SCRIPT, FAKE_SCRIPT);
    mkdirSync(LORA_DIR, { recursive: true });
    writeFakeSafetensors(join(LORA_DIR, 'MysticXXX_MMH3-V4.safetensors'));
    writeFakeSafetensors(join(LORA_DIR, 'MysticXXX_MMH3-V4-ref2va.safetensors'));
    mkdirSync(TURBO_DIR, { recursive: true });
    writeFakeSafetensors(join(TURBO_DIR, 'minimax_h3_turbo_v4_step600_ema.safetensors'));
    // 脏产物(上次中断半成品)
    mkdirSync(join(OUT_MT, 'FL2VA', 'transformer'), { recursive: true });
    writeFileSync(join(OUT_MT, 'FL2VA', 'transformer', 'STALE.safetensors'), 'stale');

    const b = new H3StyleModelBuilder(() => {});
    const r = await b.build('mystic-turbo');
    expect(r.ok).toBe(true);

    // 融合顺序:先风格 LoRA,后 turbo LoRA(两个 transformer 同口径;turbo 文件两 target 共用)
    const fl2vaLog = readFileSync(join(OUT_MT, 'FL2VA', 'transformer', 'merges.log'), 'utf-8').trim().split('\n');
    expect(fl2vaLog).toEqual(['MysticXXX_MMH3-V4.safetensors', 'minimax_h3_turbo_v4_step600_ema.safetensors']);
    const ref2vaLog = readFileSync(join(OUT_MT, 'Ref2VA', 'transformer', 'merges.log'), 'utf-8').trim().split('\n');
    expect(ref2vaLog).toEqual(['MysticXXX_MMH3-V4-ref2va.safetensors', 'minimax_h3_turbo_v4_step600_ema.safetensors']);
    // 脏文件被清(每个 transformer 只在融合前删一次)
    expect(existsSync(join(OUT_MT, 'FL2VA', 'transformer', 'STALE.safetensors'))).toBe(false);
    // ⚠️ 关键:第一次 merge 的成果在第二次 merge 后还在(顺序删除会把风格融进去的成果清掉)
    expect(existsSync(join(OUT_MT, 'FL2VA', 'transformer', 'merges.log'))).toBe(true);
    expect(readFileSync(join(OUT_MT, 'FL2VA', 'transformer', 'shard-1.safetensors'), 'utf-8')).toBe('base-FL2VA-1');
    // 最后一次融合是 turbo
    expect(readFileSync(join(OUT_MT, 'FL2VA', 'transformer', 'merged.marker'), 'utf-8')).toBe('minimax_h3_turbo_v4_step600_ema.safetensors');
    // status 视角:四条 LoRA 条目,turbo 按 dir 解析到 turbo-lora/
    const st = b.status('mystic-turbo');
    expect(st.mergedReady).toBe(true);
    expect(st.loras).toHaveLength(4);
    expect(st.loras.filter((l) => l.fileName.startsWith('minimax_h3_turbo')).every((l) => l.exists)).toBe(true);
  });
});
