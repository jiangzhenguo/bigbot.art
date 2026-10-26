import { describe, expect, it } from 'vitest';
import { appendStreamingDraft, clearStreamingDraft, rememberAgentEvent, resetStreamingDraft, shouldSettleAgentResponse } from '../stream-state';
import type { ChatMsg } from '../types';

const user: ChatMsg = { id: 1, kind: 'user', text: '你好' };
const loading: ChatMsg = { id: 2, kind: 'sys', loading: true, text: '思考中…' };

describe('Agent 事件去重', () => {
  it('超过容量只淘汰最旧 id,刚到的重复 delta 不会因全表清空而再次放行', () => {
    const seen = new Set<string>();
    for (let i = 0; i <= 200; i++) expect(rememberAgentEvent(seen, `event-${i}`)).toBe(true);
    expect(seen.size).toBe(200);
    expect(seen.has('event-0')).toBe(false);
    expect(rememberAgentEvent(seen, 'event-200')).toBe(false);
    expect(seen.size).toBe(200);
  });
});

describe('Agent 终局单一路径', () => {
  it('已推 done/failed 的回执不再二次 settle;未推事件的同步失败仍可收尾', () => {
    expect(shouldSettleAgentResponse({ ok: true, settledByEvent: true })).toBe(false);
    expect(shouldSettleAgentResponse({ ok: false, settledByEvent: true })).toBe(false);
    expect(shouldSettleAgentResponse({ ok: true, accepted: true })).toBe(false);
    expect(shouldSettleAgentResponse({ ok: false })).toBe(true);
  });
});

describe('Agent 流式草稿聚合', () => {
  it('首个 delta 替换 loading;后续正文与思考都追加到同一张卡', () => {
    let msgs = appendStreamingDraft([user, loading], 3, 'text', '你');
    msgs = appendStreamingDraft(msgs, 3, 'thinking', '分析');
    msgs = appendStreamingDraft(msgs, 3, 'text', '好');

    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual(user);
    expect(msgs[1]).toMatchObject({ id: 3, kind: 'agent', streaming: true, text: '你好', thinking: '分析' });
  });

  it('contentIndex 交错时按块号聚合,不按到达顺序拼接', () => {
    let msgs = appendStreamingDraft([user, loading], 3, 'text', 'A', 0);
    msgs = appendStreamingDraft(msgs, 3, 'text', 'X', 1);
    msgs = appendStreamingDraft(msgs, 3, 'text', 'B', 0);
    msgs = appendStreamingDraft(msgs, 3, 'text', 'Y', 1);
    msgs = appendStreamingDraft(msgs, 3, 'thinking', '想', 0);
    msgs = appendStreamingDraft(msgs, 3, 'thinking', '甲', 1);
    msgs = appendStreamingDraft(msgs, 3, 'thinking', '法', 0);
    msgs = appendStreamingDraft(msgs, 3, 'thinking', '乙', 1);

    expect(msgs[1]).toMatchObject({ text: 'ABXY', thinking: '想法甲乙' });
  });

  it('同 round 重试也会清空旧 attempt,但不误伤用户与工具卡', () => {
    const tool: ChatMsg = { id: 4, kind: 'agent', toolRuns: [{ name: 'canvas.list_nodes', args: {}, status: 'success' }] };
    const draft = appendStreamingDraft([user, tool, loading], 3, 'text', '错误草稿');
    const reset = resetStreamingDraft(draft, 3);
    const next = appendStreamingDraft(reset, 3, 'text', '正式回复');

    expect(next.find((m) => m.id === 3)?.text).toBe('正式回复');
    expect(next.find((m) => m.id === 4)).toEqual(tool);
    expect(next.find((m) => m.id === 1)).toEqual(user);
  });

  it('新一轮把草稿移到工具卡之后,最新输出保持在消息流底部', () => {
    const tool: ChatMsg = { id: 4, kind: 'agent', toolRuns: [{ name: 'canvas.list_nodes', args: {}, status: 'success' }] };
    const draft: ChatMsg = { id: 3, kind: 'agent', streaming: true, text: '上一轮', thinking: '旧思考' };
    const reset = resetStreamingDraft([user, draft, tool], 3);

    expect(reset.map((m) => m.id)).toEqual([1, 4, 3]);
    expect(reset[2]).toMatchObject({ streaming: true, text: '', thinking: '' });
  });

  it('终局只清临时草稿,保留权威回复与工具留痕', () => {
    const final: ChatMsg = { id: 5, kind: 'agent', odId: 'agent-reply', text: '最终回复' };
    const draft = appendStreamingDraft([user, loading], 3, 'text', '临时');
    const cleared = clearStreamingDraft([...draft, final]);

    expect(cleared.some((m) => m.streaming)).toBe(false);
    expect(cleared).toContainEqual(final);
    expect(cleared).toContainEqual(user);
  });
});
