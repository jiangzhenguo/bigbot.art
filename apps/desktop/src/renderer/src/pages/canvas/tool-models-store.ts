/**
 * 工具模型设置的渲染层缓存(2026-09-29 v1)
 *
 * 渲染层多处需要 toolModels(runNode 缺省解析 / 检查器默认显示 / 设置页回填),
 * 不想每次生成都发一次 IPC:首次访问时拉一次,之后读缓存;
 * 设置页保存成功后调用 setToolModelsCache 同步最新值。
 *
 * 2026-10-09 扩展:同一次 getSettings 顺手缓存「新建 shot 默认开启加速 LoRA」总开关
 * (accelDefaultEnabled)。它与 toolModels 同属 settings.json、同一份设置页来源,
 * 复用同一次 IPC 拉取即可,不必再开第二条链路 —— 两个缓存必须**同进同出**,
 * 否则会出现「设置页开了开关、画布上新建 shot 却读不到」的时间差。
 */
import type { ToolModelBinding } from '@bigbotart/shared';

let cache: ToolModelBinding | undefined;
let accelDefaultEnabled = false;
let loaded = false;

/** 首次调用拉取设置(之后命中缓存);失败按未配置处理(走内置默认) */
export async function ensureToolModels(): Promise<ToolModelBinding | undefined> {
  if (!loaded) {
    try {
      const s = await window.bigbotart.getSettings();
      cache = s.toolModels;
      accelDefaultEnabled = !!s.accelDefaultEnabled;
    } catch {
      cache = undefined;
      accelDefaultEnabled = false;
    }
    loaded = true;
  }
  return cache;
}

/** 同步读(可能为 undefined = 尚未加载 / 未配置;调用方按内置默认处理) */
export function getToolModelsSync(): ToolModelBinding | undefined {
  return cache;
}

/**
 * 同步读「新建 shot 默认开启加速」(未加载 / 拉取失败 = false = 不主动开,存量行为不变)。
 * 渲染层建 shot 时用它决定是否写入 data.accel;实际的 packId/steps 由主进程的
 * AccelStore.defaultShotAccel() 统一给出(渲染层不重复实现选包逻辑)。
 */
export function getAccelDefaultEnabledSync(): boolean {
  return accelDefaultEnabled;
}

/** 设置页保存成功后同步缓存,避免下次读取拿到旧值 */
export function setToolModelsCache(tm: ToolModelBinding | undefined): void {
  cache = tm;
  loaded = true;
}

/** 设置页切换「默认开启加速」后同步缓存 */
export function setAccelDefaultCache(enabled: boolean): void {
  accelDefaultEnabled = !!enabled;
}

/**
 * 取「新建 shot 默认加速配置」(选包逻辑在主进程 AccelStore,渲染层不重复实现)。
 * 总开关关闭时直接返回 null,**不发 IPC**(省一次往返;开关是唯一前置条件)。
 * 失败一律返回 null = 不写 accel —— 绝不让「取不到配置」变成「写一个坏包进节点」。
 */
export async function fetchAccelDefaultShotConfig(): Promise<
  { enabled: true; packId: string; steps: 4 | 8 } | null
> {
  await ensureToolModels();
  if (!accelDefaultEnabled) return null;
  try {
    return await window.bigbotart.accelDefaultShotConfig();
  } catch {
    return null;
  }
}
