/**
 * AccelStore — 加速 LoRA(蒸馏模型包)管理
 *
 * 背景(h3c-usage skill / docs/MiniMax-H3-加速-LoRA-使用手册.md §7):
 * h3.c CLI 不接受 `--lora` 参数(源码 0 hit);「加速 LoRA」= 换蒸馏模型目录(`-d`
 * 指向 MiniMax-H3-turbo-T8test 等)+ 少步数(4/8 步),省 60-80% 时间。
 * 因此这里管理的是**蒸馏模型包**(目录路径 + 推荐步数),不是 .safetensors 文件。
 *
 * 持久化:`~/.bigbotart/settings.json` 的 `accelPacks` 数组(仅登记,不拷贝/删除磁盘)。
 * 默认预置手册 §1.2 的两条知名 turbo 目录(与 packages/providers H3C_DEFAULTS 同口径)。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AccelPack } from '@bigbotart/shared';
import type { SettingsStore } from './settings';

/** 默认预置:手册 §1.2 知名 turbo 目录(T8test 设为默认包) */
const PRESEED: AccelPack[] = [
  {
    id: 'turbo-t8test',
    name: 'MiniMax-H3-turbo-T8test',
    path: '/Users/jiangzhenguo/ai/h3/MiniMax-H3-turbo-T8test',
    steps: 8,
    default: true,
    installedAt: 'preseed',
  },
  {
    id: 'turbo',
    name: 'MiniMax-H3-turbo',
    path: '/Users/jiangzhenguo/ai/h3/MiniMax-H3-turbo',
    steps: 8,
    installedAt: 'preseed',
  },
];

function isSteps(v: unknown): v is 4 | 8 {
  return v === 4 || v === 8;
}

/** 包目录合法性:`h3 -d` 需要目录存在且含 FL2VA/(turbo 目录结构,见手册 §1.2) */
function packValid(path: string): boolean {
  if (!existsSync(path)) return false;
  return existsSync(join(path, 'FL2VA')) || existsSync(join(path, 'model_index.json'));
}

export class AccelStore {
  constructor(private settings: SettingsStore) {}

  /** 首次读取(settings.json 尚无 accelPacks 字段)时写入预置,之后尊重用户删改 */
  private ensureSeeded(): void {
    const s = this.settings.get();
    if (s.accelPacks === undefined) this.settings.patch({ accelPacks: [...PRESEED] });
  }

  /** 列出全部登记(回填 exists 目录校验,设置页「就绪/目录缺失」用) */
  list(): AccelPack[] {
    this.ensureSeeded();
    return (this.settings.get().accelPacks ?? []).map((p) => ({ ...p, exists: packValid(p.path) }));
  }

  /** 安装:校验目录存在且合法(含 FL2VA/)后登记 */
  install(input: { name: string; path: string; steps?: number }): { ok: boolean; packs?: AccelPack[]; error?: string } {
    this.ensureSeeded();
    const name = input.name?.trim();
    const path = input.path?.trim();
    if (!name) return { ok: false, error: '请填模型包名称' };
    if (!path) return { ok: false, error: '请填模型目录路径' };
    if (!existsSync(path)) return { ok: false, error: `目录不存在: ${path}` };
    if (!packValid(path)) return { ok: false, error: '不是合法模型目录(缺 FL2VA/ 或 model_index.json)' };
    const packs = this.settings.get().accelPacks ?? [];
    if (packs.some((p) => p.path === path)) return { ok: false, error: '该目录已登记过' };
    const pack: AccelPack = {
      id: `accel-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      name,
      path,
      steps: isSteps(input.steps) ? input.steps : 8,
      installedAt: new Date().toISOString(),
    };
    this.settings.patch({ accelPacks: [...packs, pack] });
    return { ok: true, packs: this.list() };
  }

  /** 删除登记(只注销,不删磁盘文件);默认包需先换默认 */
  remove(id: string): { ok: boolean; packs?: AccelPack[]; error?: string } {
    this.ensureSeeded();
    const packs = this.settings.get().accelPacks ?? [];
    const target = packs.find((p) => p.id === id);
    if (!target) return { ok: false, error: '模型包不存在' };
    if (target.default) return { ok: false, error: '默认包不能删除,请先设其他包为默认' };
    this.settings.patch({ accelPacks: packs.filter((p) => p.id !== id) });
    return { ok: true, packs: this.list() };
  }

  /** 设默认包(id=null 清除默认 → 无默认) */
  setDefault(id: string | null): { ok: boolean; packs?: AccelPack[]; error?: string } {
    this.ensureSeeded();
    const packs = this.settings.get().accelPacks ?? [];
    if (id !== null && !packs.some((p) => p.id === id)) return { ok: false, error: '模型包不存在' };
    if (id === null && !packs.some((p) => p.default)) return { ok: true, packs: this.list() };
    this.settings.patch({ accelPacks: packs.map((p) => ({ ...p, default: p.id === id })) });
    return { ok: true, packs: this.list() };
  }

  /**
   * 设置「新建 shot 默认开启加速」总开关。
   * 只写 settings,不改任何已存在的节点 —— 已铺的 shot 保持各自 data.accel 不变
   * (否则用户一按开关,画布上所有历史镜头的加速状态都会被改写,那是意外副作用)。
   */
  setDefaultEnabled(enabled: boolean): { ok: boolean; enabled: boolean } {
    this.settings.patch({ accelDefaultEnabled: !!enabled });
    return { ok: true, enabled: !!enabled };
  }

  /** 读总开关(设置页回填用) */
  isDefaultEnabled(): boolean {
    return !!this.settings.get().accelDefaultEnabled;
  }

  /**
   * 新建 shot 时应写入的**默认加速配置**(2026-10-09 新增)。
   *
   * 为什么需要它:`settings.accelDefaultEnabled` 只是「用户希望默认开加速」的意图,
   * 真正落到节点上的是 `shot.data.accel = {enabled, packId, steps}`。两个建 shot 的
   * 入口(渲染层「+」弹层 / Agent storyboard.materialize)必须拿到**同一份**默认值,
   * 否则又会出现「从这里建的开加速、从那里建的不开」的口径分叉——
   * 本次「测试1」事故正是如此:8 个 shot 里只有 Agent 事后手动补的那个开了加速。
   *
   * 返回 null 的三种情况(调用方一律「不写 accel」,保持存量行为):
   *   ① 用户没开这个总开关;② 没有任何已登记包;③ 选中的包目录不可用(缺失/结构不对)。
   * ⚠️ ③ 必须返回 null 而不是写一个 enable 的坏包 —— 否则提交期
   * `resolveAccel` 会抛「加速 LoRA 开启但模型包不可用」,用户看到的是一开机就报错的画布。
   */
  defaultShotAccel(): { enabled: true; packId: string; steps: 4 | 8 } | null {
    if (!this.settings.get().accelDefaultEnabled) return null;
    this.ensureSeeded();
    const packs = this.settings.get().accelPacks ?? [];
    const pack = packs.find((p) => p.default) ?? packs[0];
    if (!pack || !packValid(pack.path)) return null;
    return { enabled: true, packId: pack.id, steps: isSteps(pack.steps) ? pack.steps : 8 };
  }

  /** 解析镜头加速请求 → 实际落地 { modelDir, steps }(提交前替换 h3.c -d / --steps)。
   *  未开启 / 无可用包 / 包目录缺失 → 返回 null(调用方抛错提示)。 */
  resolveAccel(accel: { enabled?: boolean; packId?: string; steps?: number } | undefined): { modelDir: string; steps: number } | null {
    if (!accel?.enabled) return null;
    const packs = this.settings.get().accelPacks ?? PRESEED;
    const pack = packs.find((p) => p.id === accel.packId)
      ?? packs.find((p) => p.default)
      ?? packs[0];
    if (!pack || !packValid(pack.path)) return null;
    const steps = isSteps(accel.steps) ? accel.steps : isSteps(pack.steps) ? pack.steps : 8;
    return { modelDir: pack.path, steps };
  }
}