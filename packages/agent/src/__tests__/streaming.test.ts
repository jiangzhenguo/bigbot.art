import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatStreamEvent } from '../protocol.js';

type FakeEvent = { type: string; contentIndex?: number; delta?: string; [key: string]: unknown };
type FakeStep = {
  events?: FakeEvent[];
  content?: unknown[];
  stopReason?: string;
  errorMessage?: string;
  waitForAbort?: boolean;
};

let script: FakeStep[] = [];
let roundIndex = 0;
let completedStreams = 0;

vi.mock('@earendil-works/pi-ai', () => ({
  createProvider: () => ({}),
  createModels: () => ({
    setProvider: () => {},
    getModel: () => ({}),
    complete: async () => {
      throw new Error('本测试应走 stream 分支');
    },
    stream: (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => {
      const step = script[roundIndex] ?? { content: [{ type: 'text', text: '(脚本用尽)' }] };
      roundIndex += 1;
      return {
        async *[Symbol.asyncIterator]() {
          for (const event of step.events ?? []) yield event;
          if (step.waitForAbort && !options.signal?.aborted) {
            await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
          }
        },
        result: async () => {
          completedStreams += 1;
          return {
            content: step.content ?? [],
            stopReason: step.stopReason ?? 'stop',
            errorMessage: step.errorMessage,
          };
        },
      };
    },
  }),
}));
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({ api: 'openai-completions' }),
}));
vi.mock('@earendil-works/pi-ai/api/openai-responses.lazy', () => ({
  openAIResponsesApi: () => ({ api: 'openai-responses' }),
}));

const { PiChatSession } = await import('../pi-chat.js');

function mkParams() {
  return {
    projectId: 'p1',
    canvasId: 'c1',
    threadId: 't1',
    text: '你好',
    context: { systemPrompt: 'sys', messages: [] },
    llm: { kind: 'openai-compatible', baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'm1' },
  } as never;
}

const deltas = (events: ChatStreamEvent[], kind: 'text-delta' | 'thinking-delta') =>
  events.filter((e) => e.kind === kind).map((e) => ('delta' in e ? e.delta : ''));

describe('PiChatSession · 模型流式输出', () => {
  beforeEach(() => {
    script = [];
    roundIndex = 0;
    completedStreams = 0;
  });

  it('逐段转发正文与原生 thinking;text_end/done 不重复发完整内容', async () => {
    script = [{
      events: [
        { type: 'thinking_delta', contentIndex: 0, delta: '先分析' },
        { type: 'text_delta', contentIndex: 1, delta: '你' },
        { type: 'text_delta', contentIndex: 1, delta: '好' },
        { type: 'text_end', contentIndex: 1, content: '你好' },
        { type: 'done', reason: 'stop' },
      ],
      content: [{ type: 'thinking', thinking: '先分析' }, { type: 'text', text: '你好' }],
    }];
    const events: ChatStreamEvent[] = [];
    const result = await new PiChatSession().chat(mkParams(), (e) => events.push(e));

    expect(result.reply).toBe('你好');
    expect(result.thinking).toBe('先分析');
    expect(deltas(events, 'text-delta')).toEqual(['你', '好']);
    expect(deltas(events, 'thinking-delta')).toEqual(['先分析']);
    expect(events.filter((e) => e.kind === 'text-delta').map((e) => ('contentIndex' in e ? e.contentIndex : -1))).toEqual([1, 1]);
    expect(events.filter((e) => e.kind === 'thinking-delta').map((e) => ('contentIndex' in e ? e.contentIndex : -1))).toEqual([0]);
    expect(events[0]).toEqual({ kind: 'round-start', round: 0 });
  });

  it('跨 token 的 <think> 标签被拆到思考区,不泄漏标签或吞掉空白', async () => {
    script = [{
      events: [
        { type: 'text_delta', contentIndex: 0, delta: '<th' },
        { type: 'text_delta', contentIndex: 0, delta: 'ink>秘密</th' },
        { type: 'text_delta', contentIndex: 0, delta: 'ink> 正文\n' },
      ],
      content: [{ type: 'text', text: '<think>秘密</think> 正文\n' }],
    }];
    const events: ChatStreamEvent[] = [];
    const result = await new PiChatSession().chat(mkParams(), (e) => events.push(e));

    expect(result.reply).toBe('正文');
    expect(result.thinking).toBe('秘密');
    expect(deltas(events, 'thinking-delta')).toEqual(['秘密']);
    expect(deltas(events, 'text-delta')).toEqual([' 正文\n']);
    expect(events.every((e) => !('delta' in e) || !e.delta.includes('think>'))).toBe(true);
  });

  it('不同 contentIndex 交错时各自保留 <think> 解析状态', async () => {
    script = [{
      events: [
        { type: 'text_delta', contentIndex: 0, delta: '<th' },
        { type: 'text_delta', contentIndex: 1, delta: '答' },
        { type: 'text_delta', contentIndex: 0, delta: 'ink>想' },
        { type: 'text_delta', contentIndex: 1, delta: '案' },
        { type: 'text_delta', contentIndex: 0, delta: '</think>' },
      ],
      content: [{ type: 'text', text: '<think>想</think>' }, { type: 'text', text: '答案' }],
    }];
    const events: ChatStreamEvent[] = [];
    const result = await new PiChatSession().chat(mkParams(), (e) => events.push(e));

    expect(result.reply).toBe('答案');
    expect(deltas(events, 'text-delta')).toEqual(['答', '案']);
    expect(deltas(events, 'thinking-delta')).toEqual(['想']);
  });

  it('toolcall_end 不提前执行工具;完整 assistant 对账后才进入既有工具桥', async () => {
    script = [
      {
        events: [
          { type: 'text_delta', contentIndex: 0, delta: '先查看' },
          { type: 'toolcall_end', contentIndex: 1, toolCall: { id: 'call-1', name: 'canvas.list_nodes', arguments: {} } },
        ],
        content: [
          { type: 'text', text: '先查看' },
          { type: 'toolCall', id: 'call-1', name: 'canvas.list_nodes', arguments: {} },
        ],
        stopReason: 'toolUse',
      },
      {
        events: [{ type: 'text_delta', contentIndex: 0, delta: '画布有 2 个节点' }],
        content: [{ type: 'text', text: '画布有 2 个节点' }],
      },
    ];
    const session = new PiChatSession();
    const bridged: string[] = [];
    session.onToolCall = async (req) => {
      // 第一个 result() 已 resolve,证明完整流/assistant 已收尾,而非 toolcall_end 触发。
      expect(completedStreams).toBe(1);
      expect(req.params.threadId).toBe('t1');
      bridged.push(req.params.tool);
      return { id: req.id, result: { ok: true, result: '节点 A\n节点 B' } };
    };
    const events: ChatStreamEvent[] = [];
    const result = await session.chat(mkParams(), (e) => events.push(e));

    expect(result.reply).toBe('画布有 2 个节点');
    expect(bridged).toEqual(['canvas.list_nodes']);
    expect(events.filter((e) => e.kind === 'round-start').map((e) => e.round)).toEqual([0, 1]);
  });

  it('同 round 的协议纠错重试也重新发 round-start,界面可丢弃失败 attempt', async () => {
    script = [
      {
        events: [{ type: 'text_delta', contentIndex: 0, delta: '错误草稿' }],
        content: [{ type: 'text', text: '错误草稿' }],
        stopReason: 'error',
        errorMessage: '400 ModelProtocolUnsupported',
      },
      {
        events: [{ type: 'text_delta', contentIndex: 0, delta: '正式回复' }],
        content: [{ type: 'text', text: '正式回复' }],
      },
    ];
    const events: ChatStreamEvent[] = [];
    const result = await new PiChatSession().chat(mkParams(), (e) => events.push(e));

    expect(result.reply).toBe('正式回复');
    expect(events.filter((e) => e.kind === 'round-start')).toHaveLength(2);
    expect(deltas(events, 'text-delta')).toEqual(['错误草稿', '正式回复']);
  });

  it('工具执行中取消:保留当前工具结果,但不继续执行后续调用', async () => {
    script = [{
      content: [
        { type: 'toolCall', id: 'call-1', name: 'canvas.list_nodes', arguments: {} },
        { type: 'toolCall', id: 'call-2', name: 'canvas.list_nodes', arguments: {} },
      ],
      stopReason: 'toolUse',
    }];
    const session = new PiChatSession();
    const bridged: number[] = [];
    session.onToolCall = async (req) => {
      bridged.push(req.id);
      session.cancel();
      return { id: req.id, result: { ok: true, result: '已完成当前调用' } };
    };
    const result = await session.chat(mkParams(), () => {});

    expect(result.aborted).toBe(true);
    expect(bridged).toHaveLength(1);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.result).toBe('已完成当前调用');
  });

  it('失败流不在末尾补发半个 think 标签或 parser 残余', async () => {
    script = [{
      events: [{ type: 'text_delta', contentIndex: 0, delta: '<th' }],
      content: [{ type: 'text', text: '<th' }],
      stopReason: 'error',
      errorMessage: '500 upstream failed',
    }];
    const events: ChatStreamEvent[] = [];
    await expect(new PiChatSession().chat(mkParams(), (e) => events.push(e))).rejects.toThrow('upstream failed');

    expect(deltas(events, 'text-delta')).toEqual([]);
    expect(deltas(events, 'thinking-delta')).toEqual([]);
  });

  it('流中取消复用 AbortSignal;abort 后不再转发缓冲 delta', async () => {
    script = [{
      events: [
        { type: 'text_delta', contentIndex: 0, delta: '部分' },
        { type: 'text_delta', contentIndex: 0, delta: '不应显示' },
      ],
      content: [{ type: 'text', text: '部分不应显示' }],
      stopReason: 'aborted',
      waitForAbort: true,
    }];
    const session = new PiChatSession();
    const events: ChatStreamEvent[] = [];
    const result = await session.chat(mkParams(), (e) => {
      events.push(e);
      if (e.kind === 'text-delta') session.cancel();
    });

    expect(result.aborted).toBe(true);
    expect(deltas(events, 'text-delta')).toEqual(['部分']);
  });
});
