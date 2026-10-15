/**
 * AccelStore — h3 模型包(加速 / 风格 / 风格加速)管理
 *
 * 背景(h3c-usage skill / docs/MiniMax-H3-加速-LoRA-使用手册.md §7):
 * h3.c CLI 不接受 `--lora` 参数(源码 0 hit);「LoRA」一律离线融合成完整模型目录后换 `-d`:
 *  - **加速包**(kind='accel',缺省)= 蒸馏模型目录(MiniMax-H3-turbo-T8test 等)+ 4/8 步,省 60-80% 时间;
 *  - **风格包**(kind='style',2026-10 新增)= 风格 LoRA 离线融合目录(MiniMax-H3-mystic 等,
 *    merge_lora_h3.py 烤入)+ 正常步数(20/30),**不省时间**;
 *  - **风格加速包**(kind='style-accel',2026-10-13 新增)= 风格 LoRA + turbo LoRA 双融合目录
 *    (MiniMax-H3-mystic-turbo)+ 4/8 步,**画风与提速兼得**。
 * 三者互斥:都是换 -d 模型目录,一个镜头同一时刻只能选一个包。
 *
 * 持久化:`~/.bigbotart/settings.json` 的 `accelPacks` 数组(仅登记,不拷贝/删除磁盘)。
 * 预置:首启 seed 全量 PRESEED;老库按波次迁移(`accelPreseedV2`/`accelPreseedV3` 标记,
 * 每波只迁一次,用户之后删除不复活 —— 与技能 tombstone 同目的)。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AccelPack, AccelPackKind } from '@bigbotart/shared';
import type { SettingsStore } from './settings';

/** v1 既有预置 id(老库里它们要么存在、要么被用户删过 —— 迁移时一律不再补) */
const PRESEED_V1_IDS = new Set(['turbo-t8test', 'turbo']);
/** v2 已发预置 id(v3 起同样不补 —— 用户可能删过) */
const PRESEED_V2_IDS = new Set(['mystic']);

/** 默认预置:turbo 两条(加速)+ mystic(风格,v2)+ mystic-turbo(风格加速,v3) */
const PRESEED: AccelPack[] = [
  {
    id: 'turbo-t8test',
    name: 'MiniMax-H3-turbo-T8test',
    path: '/Users/jiangzhenguo/ai/h3/MiniMax-H3-turbo-T8test',
    steps: 8,
    kind: 'accel',
    default: true,
    installedAt: 'preseed',
  },
  {
    id: 'turbo',
    name: 'MiniMax-H3-turbo',
    path: '/Users/jiangzhenguo/ai/h3/MiniMax-H3-turbo',
    steps: 8,
    kind: 'accel',
    installedAt: 'preseed',
  },
  {
    id: 'mystic',
    name: 'MiniMax-H3-mystic',
    path: '/Users/jiangzhenguo/ai/h3/MiniMax-H3-mystic',
    steps: 20,
    kind: 'style',
    installedAt: 'preseed',
  },
  {
    /* 风格+加速双融合(2026-10-13):mystic 画风 LoRA + turbo v4 step600 LoRA 先后融进同一目录
     * (本机构建配方做过张量级逐位验证:mystic-turbo == mystic + turbo,FL2VA/Ref2VA 都融)。 */
    id: 'mystic-turbo',
    name: 'MiniMax-H3-mystic-turbo',
    path: '/Users/jiangzhenguo/ai/h3/MiniMax-H3-mystic-turbo',
    steps: 8,
    kind: 'style-accel',
    installedAt: 'preseed',
  },
];

/** kind 缺省 = accel(兼容存量数据) */
export function packKind(p: Pick<AccelPack, 'kind'>): AccelPackKind {
  return p.kind === 'style' ? 'style' : p.kind === 'style-accel' ? 'style-accel' : 'accel';
}

/** 步数合法性:加速类包(accel / style-accel)4|8;纯风格包 4..50 整数(融合权重需正常步数,推荐 20/30) */
function validSteps(kind: AccelPackKind, v: unknown): v is number {
  if (typeof v !== 'number' || !Number.isInteger(v)) return false;
  return kind === 'style' ? v >= 4 && v <= 50 : v === 4 || v === 8;
}

/** 包目录合法性:`h3 -d` 需要目录存在且含 FL2VA/(turbo/mystic 目录结构,见手册 §1.2) */
function packValid(path: string): boolean {
  if (!existsSync(path)) return false;
  return existsSync(join(path, 'FL2VA')) || existsSync(join(path, 'model_index.json'));
}

export class AccelStore {
  constructor(private settings: SettingsStore) {}

  /** 首次读取(settings.json 尚无 accelPacks 字段)时写入预置,之后尊重用户删改 */
  private ensureSeeded(): void {
    const s = this.settings.get();
    if (s.accelPacks === undefined) {
      this.settings.patch({ accelPacks: [...PRESEED], accelPreseedV2: true, accelPreseedV3: true });
      return;
    }
    /* 波次迁移(每波一次性):把该波新增预置补上;此前波次的条目不补 —— 老用户若删过,复活是意外副作用。 */
    let packs = s.accelPacks;
    if (!s.accelPreseedV2) {
      const existing = new Set(packs.map((p) => p.id));
      const additions = PRESEED.filter((p) => !PRESEED_V1_IDS.has(p.id) && !existing.has(p.id));
      packs = additions.length > 0 ? [...packs, ...additions] : packs;
      this.settings.patch({ accelPacks: packs, accelPreseedV2: true });
    }
    if (!this.settings.get().accelPreseedV3) {
      const existing = new Set(packs.map((p) => p.id));
      const additions = PRESEED.filter((p) => !PRESEED_V1_IDS.has(p.id) && !PRESEED_V2_IDS.has(p.id) && !existing.has(p.id));
      this.settings.patch({
        accelPacks: additions.length > 0 ? [...packs, ...additions] : packs,
        accelPreseedV3: true,
      });
    }
  }

  /** 列出全部登记(回填 exists 目录校验,设置页「就绪/目录缺失」用) */
  list(): AccelPack[] {
    this.ensureSeeded();
    return (this.settings.get().accelPacks ?? []).map((p) => ({ ...p, exists: packValid(p.path) }));
  }

  /** 安装:校验目录存在且合法(含 FL2VA/)后登记;kind 缺省 accel,步数按 kind 校验 */
  install(input: { name: string; path: string; steps?: number; kind?: AccelPackKind }): { ok: boolean; packs?: AccelPack[]; error?: string } {
    this.ensureSeeded();
    const name = input.name?.trim();
    const path = input.path?.trim();
    const kind: AccelPackKind = input.kind === 'style' ? 'style' : input.kind === 'style-accel' ? 'style-accel' : 'accel';
    if (!name) return { ok: false, error: '请填模型包名称' };
    if (!path) return { ok: false, error: '请填模型目录路径' };
    if (!existsSync(path)) return { ok: false, error: `目录不存在: ${path}` };
    if (!packValid(path)) return { ok: false, error: '不是合法模型目录(缺 FL2VA/ 或 model_index.json)' };
    if (input.steps !== undefined && !validSteps(kind, input.steps)) {
      return { ok: false, error: kind === 'style' ? '风格包步数须为 4-50 的整数(推荐 20/30)' : '加速类包步数只支持 4 或 8' };
    }
    const packs = this.settings.get().accelPacks ?? [];
    if (packs.some((p) => p.path === path)) return { ok: false, error: '该目录已登记过' };
    const pack: AccelPack = {
      id: `accel-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      name,
      path,
      steps: input.steps ?? (kind === 'style' ? 20 : 8),
      kind,
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
   * ⚠️ 排除纯风格包(kind='style'):它不省时间、改变画风,「默认开启加速」语义是给提速用的;
   * 风格加速包(style-accel)含 turbo 提速,**参与**默认加速(用户把它设为默认包即视为认可画风)。
   *
   * 返回 null 的三种情况(调用方一律「不写 accel」,保持存量行为):
   *   ① 用户没开这个总开关;② 没有任何已登记加速类包;③ 选中的包目录不可用(缺失/结构不对)。
   * ⚠️ ③ 必须返回 null 而不是写一个 enable 的坏包 —— 否则提交期
   * `resolveAccel` 会抛「模型包开启但目录不可用」,用户看到的是一开机就报错的画布。
   */
  defaultShotAccel(): { enabled: true; packId: string; steps: number } | null {
    if (!this.settings.get().accelDefaultEnabled) return null;
    this.ensureSeeded();
    const packs = (this.settings.get().accelPacks ?? []).filter((p) => packKind(p) !== 'style');
    const pack = packs.find((p) => p.default) ?? packs[0];
    if (!pack || !packValid(pack.path)) return null;
    const kind = packKind(pack);
    return { enabled: true, packId: pack.id, steps: validSteps(kind, pack.steps) ? pack.steps : 8 };
  }

  /** 解析镜头模型包请求 → 实际落地 { modelDir, steps, kind }(提交前替换 h3.c -d / --steps)。
   *  未开启 / 无可用包 / 包目录缺失 → 返回 null(调用方抛错提示)。
   *  kind 透传给 provider 做 ETA 换算(风格包不打加速折扣)。 */
  resolveAccel(accel: { enabled?: boolean; packId?: string; steps?: number } | undefined): { modelDir: string; steps: number; kind: AccelPackKind } | null {
    if (!accel?.enabled) return null;
    const packs = this.settings.get().accelPacks ?? PRESEED;
    const pack = packs.find((p) => p.id === accel.packId)
      ?? packs.find((p) => p.default)
      ?? packs[0];
    if (!pack || !packValid(pack.path)) return null;
    const kind = packKind(pack);
    const steps = validSteps(kind, accel.steps) ? (accel.steps as number) : validSteps(kind, pack.steps) ? (pack.steps as number) : kind === 'style' ? 20 : 8;
    return { modelDir: pack.path, steps, kind };
  }
}
