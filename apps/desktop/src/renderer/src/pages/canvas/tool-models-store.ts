/**
 * 工具模型设置的渲染层缓存(2026-09-29 v1)
 *
 * 渲染层多处需要 toolModels(runNode 缺省解析 / 检查器默认显示 / 设置页回填),
 * 不想每次生成都发一次 IPC:首次访问时拉一次,之后读缓存;
 * 设置页保存成功后调用 setToolModelsCache 同步最新值。
 */
import type { ToolModelBinding } from '@bigbotart/shared';

let cache: ToolModelBinding | undefined;
let loaded = false;

/** 首次调用拉取设置(之后命中缓存);失败按未配置处理(走内置默认) */
export async function ensureToolModels(): Promise<ToolModelBinding | undefined> {
  if (!loaded) {
    try {
      cache = (await window.bigbotart.getSettings()).toolModels;
    } catch {
      cache = undefined;
    }
    loaded = true;
  }
  return cache;
}

/** 同步读(可能为 undefined = 尚未加载 / 未配置;调用方按内置默认处理) */
export function getToolModelsSync(): ToolModelBinding | undefined {
  return cache;
}

/** 设置页保存成功后同步缓存,避免下次读取拿到旧值 */
export function setToolModelsCache(tm: ToolModelBinding | undefined): void {
  cache = tm;
  loaded = true;
}
