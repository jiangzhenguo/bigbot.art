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
import { WORKER_ENTRY } from '../manager.js';
import { PiChatSession } from '../pi-chat.js';

describe('manager — 静默看门狗(批次1)', () => {
  it('worker 入口仍可解析(改动未破坏模块加载)', () => {
    expect(typeof WORKER_ENTRY).toBe('string');
    expect(WORKER_ENTRY.endsWith('worker.js')).toBe(true);
  });

  it('静默超时默认 10 分钟(必须 > 单轮真实推理耗时,实测单轮 78s)', async () => {
    // 常量在模块加载时求值:未设 env 时应为 600_000(2026-09 由 180_000 调大)
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../manager.ts', import.meta.url), 'utf-8'),
    );
    const m = /BIGBOTART_AGENT_SILENT_TIMEOUT_MS\s*\?\?\s*([\d_]+)/.exec(src);
    expect(m, '未找到 SILENT_TIMEOUT_MS 默认值定义').toBeTruthy();
    const defaultMs = Number(m![1]!.replace(/_/g, ''));
    // 单轮实测 78 秒;阈值至少要给它一个量级的余量,否则多步任务会被误杀
    expect(defaultMs).toBeGreaterThanOrEqual(600_000);
  });

  it('轮内心跳间隔存在且远小于看门狗阈值(把最长无信号间隔压到秒级)', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../pi-chat.ts', import.meta.url), 'utf-8'),
    );
    const m = /BIGBOTART_AGENT_HEARTBEAT_MS\s*\?\?\s*([\d_]+)/.exec(src);
    expect(m, '未找到 LLM_HEARTBEAT_MS 默认值定义').toBeTruthy();
    const beatMs = Number(m![1]!.replace(/_/g, ''));
    expect(beatMs).toBeGreaterThan(0);
    expect(beatMs).toBeLessThanOrEqual(30_000); // 秒级,不依赖长阈值
  });

  it('PiChatSession 暴露 onTick 钩子(轮内心跳的注入点)', () => {
    const s = new PiChatSession();
    expect(s.onTick).toBeNull(); // 默认不注入;worker 启动时赋值
    expect('onTick' in s).toBe(true);
  });
});
