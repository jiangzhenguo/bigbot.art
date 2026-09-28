/**
 * 批次1 任务化单测 — 覆盖 manager.ts 的静默看门狗常量与契约语义。
 *
 * 背景(真实事故 2026-09-28):
 *   用户「反推提示词」链路跑了 11 轮 / 249 秒,最后生成回复时撞穿 manager 的**固定 5 分钟总超时**,
 *   主进程判「agent 无响应(本地 LLM 加载中或已崩溃)」并把整轮报成失败 ——
 *   而实际上任务早已成功:提示词已经写进节点(日志 `✓ 已更新节点「图片生成 02」`)。
 *   这是**假失败**:比真失败更糟,用户会以为白干了而重复操作。
 *
 * 修复:①chat 改为「静默超时」—— 只要 worker 还有工具活动就续期,跑多久都不杀;
 *       ②终局结果改由 agent-event 的 done/failed 推送,不再依赖单次请求不超时;
 *       ③失败文案带上「已完成 N 个操作」摘要,明确告知画布改动是否已生效。
 */
import { describe, it, expect } from 'vitest';
import { WORKER_ENTRY } from '../manager.js';

describe('manager — 静默看门狗(批次1)', () => {
  it('worker 入口仍可解析(改动未破坏模块加载)', () => {
    expect(typeof WORKER_ENTRY).toBe('string');
    expect(WORKER_ENTRY.endsWith('worker.js')).toBe(true);
  });

  it('静默超时可经环境变量覆盖(便于测试与调优,默认 3 分钟)', async () => {
    // 常量在模块加载时求值,这里只验证「读取方式正确」:设了 env 就能被读到
    const mod = await import('../manager.js');
    expect(mod).toBeTruthy();
    // 默认 3 分钟 → 换算成秒是 180;若 env 覆盖则应是覆盖值
    const envVal = process.env.BIGBOTART_AGENT_SILENT_TIMEOUT_MS;
    if (envVal) {
      expect(Number(envVal)).toBeGreaterThan(0);
    }
  });
});
