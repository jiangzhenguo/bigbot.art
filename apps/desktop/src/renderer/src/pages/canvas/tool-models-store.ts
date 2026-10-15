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
import { useSyncExternalStore } from 'react';
import type { ToolModelBinding } from '@bigbotart/shared';

let cache: ToolModelBinding | undefined;
let accelDefaultEnabled = false;
let loaded = false;

/*
 * ── 可订阅化(2026-10-14「文生图节点显示 z-image」事故修复)──
 *
 * 旧实现只有「拉取 + 同步读」:缓存首次加载发生在 runNode(点生成)或设置页保存时。
 * 于是**冷启动后、首次生成之前**,检查器/节点卡用 `getToolModelsSync()` 读到的永远是
 * undefined → 缺省解析落回内置默认 Z-Image-Turbo —— 用户明明在设置页把文生图默认
 * 改成了别的模型,新建节点的模型框却显示 z-image(实际提交是对的,纯属显示说谎)。
 *
 * 修法:store 加订阅,`useToolModels()` 在首个订阅者出现时**自动触发加载**,
 * 加载完成 / 设置页保存后广播,所有订阅者(检查器、节点卡)重渲染出真实缺省值。
 */
const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}

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
    emit();
  }
  return cache;
}

/**
 * 订阅式读取(React 组件用):首个订阅者触发自动加载,缓存变化时重渲染。
 * 返回值语义与 getToolModelsSync 相同(undefined = 未加载 / 未配置 → 走内置默认)。
 */
export function useToolModels(): ToolModelBinding | undefined {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      void ensureToolModels(); // 幂等:已加载时立即返回,不发重复 IPC
      return () => listeners.delete(cb);
    },
    () => cache,
  );
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
  emit();
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
  { enabled: true; packId: string; steps: number } | null
> {
  await ensureToolModels();
  if (!accelDefaultEnabled) return null;
  try {
    return await window.bigbotart.accelDefaultShotConfig();
  } catch {
    return null;
  }
}
