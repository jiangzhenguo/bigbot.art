import type { AgentChatResponse } from '@bigbotart/shared';
import type { ChatMsg } from './types';

export type StreamingDraftChannel = 'text' | 'thinking';

const emptySegments = () => ({ text: {} as Record<number, string>, thinking: {} as Record<number, string> });
const joinSegments = (segments: Record<number, string>) =>
  Object.entries(segments)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, text]) => text)
    .join('');

/** 新一轮 LLM 输出复用同一张草稿卡,清掉旧 attempt 并移到活动卡片之后。 */
export function resetStreamingDraft(msgs: ChatMsg[], id: number): ChatMsg[] {
  const draft = msgs.find((m) => m.id === id && m.streaming);
  if (!draft) return msgs;
  return [...msgs.filter((m) => m !== draft), { ...draft, text: '', thinking: '', streamSegments: emptySegments() }];
}

/**
 * 追加一个正文/思考增量。首个增量移除 loading;同一时刻只保留 id 指定的草稿,
 * 避免 StrictMode 重订阅或切换轮次留下重复气泡。函数保持纯,便于 StrictMode 双跑 updater。
 */
export function appendStreamingDraft(
  msgs: ChatMsg[],
  id: number,
  channel: StreamingDraftChannel,
  delta: string,
  contentIndex = 0,
): ChatMsg[] {
  if (!delta) return msgs;
  const rest = msgs.filter((m) => !m.loading && (!m.streaming || m.id === id));
  const index = rest.findIndex((m) => m.id === id && m.streaming);
  const previous = index >= 0 ? rest[index] : undefined;
  const previousSegments: { text: Record<number, string>; thinking: Record<number, string> } = previous?.streamSegments ?? {
    text: previous?.text ? { 0: previous.text } : {},
    thinking: previous?.thinking ? { 0: previous.thinking } : {},
  };
  const previousChannel = previousSegments[channel];
  const streamSegments = {
    ...previousSegments,
    [channel]: {
      ...previousChannel,
      [contentIndex]: `${previousChannel[contentIndex] ?? ''}${delta}`,
    },
  };
  const draft: ChatMsg = {
    id,
    kind: 'agent',
    streaming: true,
    text: joinSegments(streamSegments.text),
    thinking: joinSegments(streamSegments.thinking),
    streamSegments,
  };
  if (index < 0) return [...rest, draft];
  const next = [...rest];
  next[index] = draft;
  return next;
}

/** 稳定事件 id 的有界去重;超限时只淘汰最旧项,绝不清空后重新放进刚到的重复事件。 */
export function rememberAgentEvent(seen: Set<string>, eventId: string, limit = 200): boolean {
  if (seen.has(eventId)) return false;
  seen.add(eventId);
  if (seen.size > limit) {
    const oldest = seen.values().next().value;
    if (oldest) seen.delete(oldest);
  }
  return true;
}

/** 终局只认事件或 Promise 其中一路,防止旧轮 done 在新一轮开始后二次 settle。 */
export function shouldSettleAgentResponse(res: Pick<AgentChatResponse, 'ok' | 'accepted' | 'settledByEvent'>): boolean {
  if (res.accepted && res.ok) return false;
  return !res.settledByEvent;
}

/** 终局(done/failed/打断)删除临时草稿;权威回复或错误卡由调用方另外追加。 */
export function clearStreamingDraft(msgs: ChatMsg[]): ChatMsg[] {
  return msgs.filter((m) => !m.streaming);
}
