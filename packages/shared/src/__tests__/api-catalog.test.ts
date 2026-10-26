/**
 * 远程访问与桌面 IPC 共用一份目录。漏登记一个方法,这里和类型断言都会红。
 */
import { describe, expect, it } from 'vitest';
import { API_CATALOG, EVENT_CATALOG, RPC_CATALOG } from '../api-catalog.js';

describe('API 目录', () => {
  it('121 个 RPC + 6 个事件,名字不重复', () => {
    expect(RPC_CATALOG).toHaveLength(121);
    expect(EVENT_CATALOG).toHaveLength(6);
    expect(API_CATALOG).toHaveLength(127);
    const names = API_CATALOG.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('事件频道沿用现有 IPC 字符串,不是方法名的 kebab-case', () => {
    expect(EVENT_CATALOG.map((e) => [e.name, e.ipcChannel])).toEqual([
      ['onQueueChanged', 'render-queue-changed'],
      ['onCanvasSnapshotUpdated', 'canvas-snapshot-updated'],
      ['onVideoPostProgress', 'video-post-progress'],
      ['onStyleModelProgress', 'style-model-progress'],
      ['onAgentEvent', 'agent-event'],
      ['onDebugLog', 'debug-log'],
    ]);
  });

  it('runSelfCheck 仍是历史频道 run-selfcheck', () => {
    expect(RPC_CATALOG.find((e) => e.name === 'runSelfCheck')?.ipcChannel).toBe('run-selfcheck');
  });

  it('本地模型包选择与 LoRA 融合安装仅桌面可用，并声明 dialog/long', () => {
    const pick = RPC_CATALOG.find((e) => e.name === 'accelPickSource');
    expect(pick?.ipcChannel).toBe('accel-pick-source');
    expect(pick?.flags).toEqual(['dialog', 'desktopOnly']);
    const install = RPC_CATALOG.find((e) => e.name === 'accelInstallLora');
    expect(install?.ipcChannel).toBe('accel-install-lora');
    expect(install?.flags).toEqual(['pathArg', 'long', 'desktopOnly']);
  });
});
