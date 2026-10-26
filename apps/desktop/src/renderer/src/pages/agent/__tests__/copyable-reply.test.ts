/**
 * 复制按钮闸:只有每轮最终回答可复制,「已执行 vision.caption」等系统记录不行。
 */
import { describe, expect, it } from 'vitest';
import type { RecallMessage } from '@bigbotart/shared';
import { isCopyableReply } from '../ChatMessageList';
import { restoreMsgsFromRecall } from '../restore-msgs';
import type { ChatMsg } from '../types';

function msg(partial: Partial<ChatMsg> & Pick<ChatMsg, 'id' | 'kind'>): ChatMsg {
  return partial as ChatMsg;
}

let seq = 0;
function rec(role: RecallMessage['role'], content: string): RecallMessage {
  seq += 1;
  return {
    canvasId: 'cA',
    role,
    content,
    id: `m${seq}`,
    createdAt: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
  };
}

describe('isCopyableReply', () => {
  it('agent-reply 有正文 → 可复制', () => {
    expect(
      isCopyableReply(msg({ id: 1, kind: 'agent', odId: 'agent-reply', text: '已出图并验收合格 ✅' })),
    ).toBe(true);
  });

  it('已执行 vision.caption(未打标旧气泡) → 不可复制', () => {
    expect(isCopyableReply(msg({ id: 2, kind: 'agent', text: '已执行 vision.caption' }))).toBe(false);
  });

  it('工具卡 / 确认卡 → 不可复制', () => {
    expect(
      isCopyableReply(msg({ id: 3, kind: 'agent', odId: 'agent-tools', toolRuns: [], text: 'x' })),
    ).toBe(false);
    expect(
      isCopyableReply(
        msg({
          id: 4,
          kind: 'agent',
          odId: 'agent-ask',
          ask: { question: '选?', options: [{ label: 'A' }, { label: 'B' }] },
          text: '选?',
        }),
      ),
    ).toBe(false);
  });

  it('流式临时草稿 → 不可复制(终局权威回复才开放复制)', () => {
    expect(isCopyableReply(msg({ id: 7, kind: 'agent', streaming: true, text: '尚未收尾' }))).toBe(false);
  });

  it('用户 / 系统不算 agent-reply(用户气泡另挂复制)', () => {
    expect(isCopyableReply(msg({ id: 5, kind: 'user', text: '生成一个美女' }))).toBe(false);
    expect(isCopyableReply(msg({ id: 6, kind: 'sys', text: '已执行 vision.caption' }))).toBe(false);
  });
});

describe('restoreMsgsFromRecall · 复制相关标记', () => {
  it('assistant 正文打 agent-reply;system「已执行」落 sys', () => {
    seq = 0;
    let n = 0;
    const recall: RecallMessage[] = [
      rec('user', '生成一个美女'),
      rec('system', '已执行 vision.caption'),
      rec('assistant', '正面白日版已出图并验收合格 ✅'),
    ];
    const out = restoreMsgsFromRecall(recall, () => ++n);
    expect(out.map((m) => ({ kind: m.kind, odId: m.odId, text: m.text }))).toEqual([
      { kind: 'user', odId: undefined, text: '生成一个美女' },
      { kind: 'sys', odId: undefined, text: '已执行 vision.caption' },
      { kind: 'agent', odId: 'agent-reply', text: '正面白日版已出图并验收合格 ✅' },
    ]);
    expect(isCopyableReply(out[2]!)).toBe(true);
    expect(isCopyableReply(out[1]!)).toBe(false);
  });
});
