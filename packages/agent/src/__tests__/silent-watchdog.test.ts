/**
 * 批次1 任务化单测 — 覆盖 manager.ts 的静默看门狗常量与契约语义。
 *
 * 背景(真实事故 2026-09-28):
 *   用户「反推提示词」链路跑了 11 轮 / 249 秒,最后生成回复时撞穿 manager 的**固定 5 分钟总超时**,
 *   主进程判「agent 无响应(本地 LLM 加载中或已崩溃)」并把整轮报成失败 ——
 *   而实际上任务早已成功:提示词已经写进节点(日志 `✓ 已更新节点「图片生成 02」`)。
 *   这是**假失败**:比真失败更糟,用户会以为白干了而重复操作。
 *
 * 修复:①chat 改为「静默超时」—— 只要 worker 还有活动就续期,跑多久都不杀;
 *       ②终局结果改由 agent-event 的 done/failed 推送,不再依赖单次请求不超时;
 *       ③失败文案带上「已完成 N 个操作」摘要,明确告知画布改动是否已生效。
 *
 * 2026-09-28 二次修正(主画布对话再次假失败):
 *   实测本机 35B 本地模型**单轮**真实规模请求(30 工具定义 + 13 节点画布 + 历史 ≈ 75KB,
 *   thinking + maxTokens 12000)耗时 **78 秒**,连「你好」都要 30 秒;而心跳原本只有轮首一次,
 *   整个推理期间零信号,180s 阈值在多步任务正常推进中就会被撞穿。
 *   故:①默认阈值 180s → 600s;②pi-chat 补**轮内心跳**把最长无信号间隔压到 15 秒级。
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SILENT_TIMEOUT_MS,
  WORKER_ENTRY,
  resolveSilentTimeoutMs,
} from '../manager.js';
import {
  DEFAULT_HEARTBEAT_MS,
  PiChatSession,
  resolveHeartbeatMs,
} from '../pi-chat.js';

describe('manager — 静默看门狗(批次1)', () => {
  it('worker 入口仍可解析(改动未破坏模块加载)', () => {
    expect(typeof WORKER_ENTRY).toBe('string');
    expect(WORKER_ENTRY.endsWith('worker.js')).toBe(true);
  });

  it('静默超时默认 10 分钟(必须 > 单轮真实推理耗时,实测单轮 78s)', () => {
    const defaultMs = resolveSilentTimeoutMs({});
    expect(DEFAULT_SILENT_TIMEOUT_MS).toBe(600_000);
    expect(defaultMs).toBeGreaterThanOrEqual(600_000);
    expect(resolveSilentTimeoutMs({ BIGBOTART_AGENT_SILENT_TIMEOUT_MS: '900000' })).toBe(900_000);
    expect(resolveSilentTimeoutMs({ BIGBOTART_AGENT_SILENT_TIMEOUT_MS: 'bad' })).toBe(DEFAULT_SILENT_TIMEOUT_MS);
  });

  it('轮内心跳间隔存在且远小于看门狗阈值(把最长无信号间隔压到秒级)', () => {
    const beatMs = resolveHeartbeatMs({});
    expect(DEFAULT_HEARTBEAT_MS).toBe(15_000);
    expect(beatMs).toBeGreaterThan(0);
    expect(beatMs).toBeLessThanOrEqual(30_000);
    expect(resolveHeartbeatMs({ BIGBOTART_AGENT_HEARTBEAT_MS: '5000' })).toBe(5_000);
    expect(resolveHeartbeatMs({ BIGBOTART_AGENT_HEARTBEAT_MS: '0' })).toBe(DEFAULT_HEARTBEAT_MS);
  });

  it('PiChatSession 暴露 onTick 钩子(轮内心跳的注入点)', () => {
    const s = new PiChatSession();
    expect(s.onTick).toBeNull(); // 默认不注入;worker 启动时赋值
    expect('onTick' in s).toBe(true);
  });
});
