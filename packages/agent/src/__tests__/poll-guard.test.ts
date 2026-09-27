/**
 * 轮询抑制闸单测 — 覆盖 pi-chat.ts 的「提交即收尾」结构兜底。
 *
 * 真实事故(2026-09-27,项目 proj-1790491667525-ee3x5):
 *   用户指令「连给 image-gen 的 ref-image」,模型建节点 / 连线 / engine.submit 全部成功,
 *   但提交后开始反复轮询 engine.queue_status / canvas.get_node / canvas.list_nodes,
 *   20 轮 MAX_TOOL_ROUNDS 被空转烧光,最终回复「已达到最大工具调用轮数,请拆小任务继续。」
 *   ——用户看到的是失败,实际任务已成功入队(Take 状态 queued)。
 *
 * 本测试锁定修复后的判定语义:只读轮询在提交后被限额,且收尾话术不得说成失败。
 */
import { describe, it, expect } from 'vitest';
import { isPollingRound, isPollingExhausted, POLL_ABORT_MESSAGE } from '../pi-chat.js';

describe('isPollingRound — 空转轮询判定', () => {
  it('未提交过生成时,任何轮询都不算空转', () => {
    expect(isPollingRound(false, ['engine.queue_status'])).toBe(false);
    expect(isPollingRound(false, ['canvas.list_nodes', 'canvas.get_node'])).toBe(false);
  });

  it('提交成功后,纯轮询轮次判定为空转', () => {
    expect(isPollingRound(true, ['engine.queue_status'])).toBe(true);
    expect(isPollingRound(true, ['canvas.get_node'])).toBe(true);
    expect(isPollingRound(true, ['canvas.list_nodes'])).toBe(true);
    expect(isPollingRound(true, ['canvas.list_nodes', 'canvas.get_node'])).toBe(true);
  });

  it('混合轮次即使含轮询也不算空转(避免误伤「查一下再改」的正常工作)', () => {
    expect(isPollingRound(true, ['canvas.list_nodes', 'canvas.connect'])).toBe(false);
    expect(isPollingRound(true, ['engine.queue_status', 'canvas.create_node'])).toBe(false);
    expect(isPollingRound(true, ['canvas.get_node', 'engine.submit'])).toBe(false);
  });

  it('空调用列表不算空转(不该因空数组误触发收尾)', () => {
    expect(isPollingRound(true, [])).toBe(false);
  });

  it('写操作单独出现不算空转', () => {
    expect(isPollingRound(true, ['canvas.update_node'])).toBe(false);
    expect(isPollingRound(true, ['storyboard.materialize'])).toBe(false);
  });
});

describe('isPollingExhausted — 阈值判定', () => {
  it('限额内不强制收尾(前两次轮询仍放行,给模型自查机会)', () => {
    expect(isPollingExhausted(1)).toBe(false);
    expect(isPollingExhausted(2)).toBe(false);
  });

  it('超过限额即强制收尾', () => {
    expect(isPollingExhausted(3)).toBe(true);
    expect(isPollingExhausted(20)).toBe(true);
  });

  it('0 次不触发', () => {
    expect(isPollingExhausted(0)).toBe(false);
  });
});

describe('POLL_ABORT_MESSAGE — 收尾话术', () => {
  it('措辞为「已提交成功」而非失败,不能出现最大轮数兜底话术', () => {
    expect(POLL_ABORT_MESSAGE).toContain('已提交');
    expect(POLL_ABORT_MESSAGE).not.toContain('最大工具调用轮数');
    expect(POLL_ABORT_MESSAGE).not.toContain('失败');
  });
});

describe('回归:真实事故轨迹', () => {
  it('提交后连续只读轮询 → 第 3 轮触发强制收尾(并立即结束,不再继续轮询)', () => {
    // 复现 recall 里第 80→102 条的轮询序列
    const rounds: string[][] = [
      ['engine.queue_status'],
      ['canvas.get_node'],
      ['engine.queue_status'],
      ['canvas.list_nodes'],
      ['engine.queue_status'],
    ];
    let polls = 0;
    let abortedAt = -1;
    for (let i = 0; i < rounds.length; i++) {
      const names = rounds[i] ?? [];
      if (isPollingRound(true, names)) {
        polls += 1;
        // 真实实现:超阈值即 return 结束循环,后续轮次不再发生
        if (isPollingExhausted(polls)) {
          abortedAt = i;
          break;
        }
      }
    }
    // 前两轮放行(计数 1、2),第 3 轮(索引 2)计数到 3 → 收尾并中止
    expect(abortedAt).toBe(2);
    expect(polls).toBe(3);
  });

  it('提交后立刻收尾(无轮询)不受闸门影响', () => {
    let polls = 0;
    // 模型正确行为:提交后直接结束,没有任何后续调用
    const rounds: string[][] = [];
    for (const names of rounds) {
      if (isPollingRound(true, names)) polls += 1;
    }
    expect(polls).toBe(0);
    expect(isPollingExhausted(polls)).toBe(false);
  });
});
