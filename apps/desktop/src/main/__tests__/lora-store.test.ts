/**
 * AccelStore(lora.ts)模型包管理单测 —— 风格包(mystic)+ 风格加速包(mystic-turbo)接入
 *
 * 锁定行为:
 *  ① 新库首启 seed 全量预置(turbo-t8test 默认 / turbo / mystic style 20 步 / mystic-turbo style-accel 8 步);
 *  ② 波次迁移:v2 补 mystic、v3 补 mystic-turbo;被用户删过的旧波次条目一律不复活;
 *  ③ install 的步数按 kind 校验(accel / style-accel 4|8;style 4-50);
 *  ④ resolveAccel 透传 kind(provider ETA 依据);
 *  ⑤ defaultShotAccel 排除纯风格包,但**包含**风格加速包(它带 turbo 提速)。
 *
 * ⚠️ SettingsStore 的 settings.json 路径在**模块加载时**按 BIGBOTART_HOME 求值,
 *    故 env 必须在 import 前设好(与 project-cover-store.test.ts 同口径)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-lora-store-'));
process.env.BIGBOTART_HOME = tmpHome;

let SettingsStore: typeof import('../settings.js').SettingsStore;
let AccelStore: typeof import('../lora.js').AccelStore;

/** 造一个合法包目录(含 FL2VA/) */
function fakePackDir(name: string): string {
  const dir = join(tmpHome, 'packs', name);
  mkdirSync(join(dir, 'FL2VA'), { recursive: true });
  return dir;
}

beforeAll(async () => {
  SettingsStore = (await import('../settings.js')).SettingsStore;
  AccelStore = (await import('../lora.js')).AccelStore;
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/**
 * 同进程内所有 SettingsStore 实例共享同一 settings.json(DATA_DIR 模块级固定),
 * 隔离靠每个用例开头 patch 出目标初始态(等价于手写 settings.json)。
 */
function freshStore(): { settings: InstanceType<typeof SettingsStore>; accel: InstanceType<typeof AccelStore> } {
  const settings = new SettingsStore();
  const accel = new AccelStore(settings);
  return { settings, accel };
}

describe('AccelStore · 预置与 v2/v3 迁移', () => {
  it('新库(accelPacks 未定义)→ seed 四条预置,mystic 风格 20 步 / mystic-turbo 风格加速 8 步,标记迁移完成', () => {
    const { settings, accel } = freshStore();
    settings.patch({ accelPacks: undefined, accelPreseedV2: undefined, accelPreseedV3: undefined });
    const packs = accel.list();
    expect(packs.map((p) => p.id)).toEqual(['turbo-t8test', 'turbo', 'mystic', 'mystic-turbo']);
    const mystic = packs.find((p) => p.id === 'mystic')!;
    expect(mystic.kind).toBe('style');
    expect(mystic.steps).toBe(20);
    expect(mystic.path).toBe('/Users/jiangzhenguo/ai/h3/MiniMax-H3-mystic');
    const mt = packs.find((p) => p.id === 'mystic-turbo')!;
    expect(mt.kind).toBe('style-accel');
    expect(mt.steps).toBe(8);
    expect(mt.path).toBe('/Users/jiangzhenguo/ai/h3/MiniMax-H3-mystic-turbo');
    expect(packs.find((p) => p.id === 'turbo-t8test')?.default).toBe(true);
    expect(settings.get().accelPreseedV2).toBe(true);
    expect(settings.get().accelPreseedV3).toBe(true);
  });

  it('老库迁移:追加新预置;被用户删过的 v1 包(turbo)不复活', () => {
    const { settings, accel } = freshStore();
    // 老库形态:有 accelPacks(用户删过 turbo,只剩 turbo-t8test),无 v2/v3 标记
    settings.patch({
      accelPacks: [
        { id: 'turbo-t8test', name: 'MiniMax-H3-turbo-T8test', path: '/x/t8', steps: 8, default: true },
      ],
      accelPreseedV2: undefined,
      accelPreseedV3: undefined,
    });
    const packs = accel.list();
    expect(packs.map((p) => p.id)).toEqual(['turbo-t8test', 'mystic', 'mystic-turbo']); // turbo 不复活
    expect(settings.get().accelPreseedV2).toBe(true);
    expect(settings.get().accelPreseedV3).toBe(true);
    // 再 list 不重复追加
    expect(accel.list().filter((p) => p.id === 'mystic')).toHaveLength(1);
    expect(accel.list().filter((p) => p.id === 'mystic-turbo')).toHaveLength(1);
  });

  it('v2→v3 迁移:v2 已迁过的库只补 mystic-turbo;v2 时代被删的 mystic 不复活', () => {
    const { settings, accel } = freshStore();
    // v2 已迁(用户随后删了 mystic),v3 未迁
    settings.patch({
      accelPacks: [{ id: 'turbo-t8test', name: 't8', path: '/x/t8', steps: 8, default: true }],
      accelPreseedV2: true,
      accelPreseedV3: undefined,
    });
    const packs = accel.list();
    expect(packs.map((p) => p.id)).toEqual(['turbo-t8test', 'mystic-turbo']); // mystic 不复活
    expect(settings.get().accelPreseedV3).toBe(true);
  });

  it('迁移后用户删除 mystic / mystic-turbo → 不复活(标记为 true,迁移只跑一次)', () => {
    const { settings, accel } = freshStore();
    settings.patch({ accelPacks: undefined, accelPreseedV2: undefined, accelPreseedV3: undefined });
    accel.list(); // 触发 seed
    expect(accel.remove('mystic').ok).toBe(true);
    expect(accel.remove('mystic-turbo').ok).toBe(true);
    expect(accel.list().some((p) => p.id === 'mystic')).toBe(false);
    expect(accel.list().some((p) => p.id === 'mystic-turbo')).toBe(false);
  });
});

describe('AccelStore · install 的 kind 与步数校验', () => {
  it('风格包:20/30 步合法;3 步拒绝', () => {
    const { settings, accel } = freshStore();
    settings.patch({ accelPacks: [], accelPreseedV2: true, accelPreseedV3: true });
    const ok = accel.install({ name: 'mystic-copy', path: fakePackDir('m1'), kind: 'style', steps: 20 });
    expect(ok.ok).toBe(true);
    const bad = accel.install({ name: 'bad', path: fakePackDir('m2'), kind: 'style', steps: 3 });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('4-50');
  });

  it('加速包:只认 4|8,20 步拒绝(防把风格包参数塞进加速包)', () => {
    const { settings, accel } = freshStore();
    settings.patch({ accelPacks: [], accelPreseedV2: true, accelPreseedV3: true });
    const bad = accel.install({ name: 'turbo-x', path: fakePackDir('t1'), kind: 'accel', steps: 20 });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('4 或 8');
    const ok = accel.install({ name: 'turbo-x', path: fakePackDir('t1'), kind: 'accel', steps: 4 });
    expect(ok.ok).toBe(true);
  });

  it('风格加速包:4|8 合法(turbo 语义);20 步拒绝', () => {
    const { settings, accel } = freshStore();
    settings.patch({ accelPacks: [], accelPreseedV2: true, accelPreseedV3: true });
    const bad = accel.install({ name: 'sa-bad', path: fakePackDir('sa1'), kind: 'style-accel', steps: 20 });
    expect(bad.ok).toBe(false);
    const ok = accel.install({ name: 'sa-ok', path: fakePackDir('sa1'), kind: 'style-accel', steps: 8 });
    expect(ok.ok).toBe(true);
    expect(ok.packs?.find((p) => p.name === 'sa-ok')?.kind).toBe('style-accel');
  });

  it('kind 缺省 = accel(兼容存量调用方)', () => {
    const { settings, accel } = freshStore();
    settings.patch({ accelPacks: [], accelPreseedV2: true, accelPreseedV3: true });
    const r = accel.install({ name: 'legacy', path: fakePackDir('l1'), steps: 8 });
    expect(r.ok).toBe(true);
    expect(r.packs?.find((p) => p.name === 'legacy')?.kind).toBe('accel');
  });

  it('Ref2VA 单目标本地融合目录也可登记并显示就绪', () => {
    const { settings, accel } = freshStore();
    settings.patch({ accelPacks: [], accelPreseedV2: true, accelPreseedV3: true });
    const dir = join(tmpHome, 'packs', 'ref2va-only');
    mkdirSync(join(dir, 'Ref2VA'), { recursive: true });
    const r = accel.install({ name: 'ref-only', path: dir, kind: 'style', steps: 20 });
    expect(r.ok).toBe(true);
    expect(r.packs?.find((p) => p.name === 'ref-only')?.exists).toBe(true);
  });
});

describe('AccelStore · resolveAccel / defaultShotAccel 的 kind 语义', () => {
  it('resolveAccel:风格包返回 kind=style 与包步数;显式 30 步覆盖', () => {
    const { settings, accel } = freshStore();
    const dir = fakePackDir('mystic-live');
    settings.patch({
      accelPacks: [{ id: 'mystic', name: 'mystic', path: dir, steps: 20, kind: 'style' }],
      accelPreseedV2: true,
      accelPreseedV3: true,
    });
    const r1 = accel.resolveAccel({ enabled: true, packId: 'mystic' });
    expect(r1).toEqual({ modelDir: dir, steps: 20, kind: 'style' });
    const r2 = accel.resolveAccel({ enabled: true, packId: 'mystic', steps: 30 });
    expect(r2?.steps).toBe(30);
    // 目录缺失 → null(调用方明确报错,不静默回退)
    settings.patch({ accelPacks: [{ id: 'mystic', name: 'mystic', path: '/no/such/dir', steps: 20, kind: 'style' }] });
    expect(accel.resolveAccel({ enabled: true, packId: 'mystic' })).toBeNull();
  });

  it('resolveAccel:风格加速包返回 kind=style-accel 与 8 步;非法步数回落包推荐', () => {
    const { settings, accel } = freshStore();
    const dir = fakePackDir('mystic-turbo-live');
    settings.patch({
      accelPacks: [{ id: 'mystic-turbo', name: 'mt', path: dir, steps: 8, kind: 'style-accel' }],
      accelPreseedV2: true,
      accelPreseedV3: true,
    });
    expect(accel.resolveAccel({ enabled: true, packId: 'mystic-turbo' })).toEqual({ modelDir: dir, steps: 8, kind: 'style-accel' });
    // 风格加速包按 turbo 语义:20 步不合法 → 回落包推荐 8
    expect(accel.resolveAccel({ enabled: true, packId: 'mystic-turbo', steps: 20 })?.steps).toBe(8);
    expect(accel.resolveAccel({ enabled: true, packId: 'mystic-turbo', steps: 4 })?.steps).toBe(4);
  });

  it('defaultShotAccel:总开关开启但只有纯风格包可用 → null(纯风格包不参与「默认加速」)', () => {
    const { settings, accel } = freshStore();
    settings.patch({
      accelPacks: [{ id: 'mystic', name: 'mystic', path: fakePackDir('mystic-only'), steps: 20, kind: 'style', default: true }],
      accelPreseedV2: true,
      accelPreseedV3: true,
      accelDefaultEnabled: true,
    });
    expect(accel.defaultShotAccel()).toBeNull();
  });

  it('defaultShotAccel:风格加速包参与默认加速(带 turbo 提速,用户设为默认即认可画风)', () => {
    const { settings, accel } = freshStore();
    settings.patch({
      accelPacks: [
        { id: 'mystic', name: 'mystic', path: fakePackDir('m3'), steps: 20, kind: 'style' },
        { id: 'mystic-turbo', name: 'mt', path: fakePackDir('mt8'), steps: 8, kind: 'style-accel', default: true },
      ],
      accelPreseedV2: true,
      accelPreseedV3: true,
      accelDefaultEnabled: true,
    });
    const r = accel.defaultShotAccel();
    expect(r).toMatchObject({ enabled: true, packId: 'mystic-turbo', steps: 8 });
  });

  it('defaultShotAccel:有可用加速包时正常返回(存量行为不变)', () => {
    const { settings, accel } = freshStore();
    settings.patch({
      accelPacks: [
        { id: 'mystic', name: 'mystic', path: fakePackDir('m4'), steps: 20, kind: 'style' },
        { id: 't8', name: 'turbo', path: fakePackDir('t8'), steps: 8, kind: 'accel', default: true },
      ],
      accelPreseedV2: true,
      accelPreseedV3: true,
      accelDefaultEnabled: true,
    });
    const r = accel.defaultShotAccel();
    expect(r).toMatchObject({ enabled: true, packId: 't8', steps: 8 });
  });
});
