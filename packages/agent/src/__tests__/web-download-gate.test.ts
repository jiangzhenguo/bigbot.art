/**
 * 图片下载确认闸接线:地址不在用户原文里时不执行,弹确认卡;
 * 用户点「下载」后同一调用才真正到达工具桥。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let script: Array<{ text?: string; calls?: Array<{ name: string; args: unknown }> }> = [];
let roundIndex = 0;

vi.mock('@earendil-works/pi-ai', () => {
  return {
    createProvider: () => ({}),
    createModels: () => ({
      setProvider: () => {},
      getModel: () => ({}),
      complete: async () => {
        const step = script[roundIndex] ?? { text: '好了' };
        roundIndex += 1;
        const content: unknown[] = [];
        if (step.text !== undefined) content.push({ type: 'text', text: step.text });
        for (const c of step.calls ?? []) {
          content.push({ type: 'toolCall', id: `call-${roundIndex}-${c.name}`, name: c.name, arguments: c.args });
        }
        return { content, stopReason: 'stop' };
      },
    }),
  };
});
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({}),
}));

const { PiChatSession } = await import('../pi-chat.js');

const IMG = 'https://cdn.example.com/ref.png';

function params(text: string, history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = []) {
  return {
    projectId: 'p1',
    canvasId: 'c1',
    text,
    context: { systemPrompt: 'sys', messages: history },
  } as never;
}

function recorder() {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const onToolCall = async (req: { params: { tool: string; args: Record<string, unknown> } }) => {
    calls.push({ tool: req.params.tool, args: req.params.args });
    return { id: 1, result: { ok: true, result: '已下载', nodeId: 'asset-1' } };
  };
  return { calls, onToolCall: onToolCall as never };
}

beforeEach(() => {
  script = [];
  roundIndex = 0;
});

describe('web.fetch_image 确认闸', () => {
  it('用户消息里已有地址 → 直接下载,不弹卡', async () => {
    script = [
      { calls: [{ name: 'web.fetch_image', args: { url: IMG } }] },
      { text: '已放到画布上' },
    ];
    const { calls, onToolCall } = recorder();
    const s = new PiChatSession();
    s.onToolCall = onToolCall;
    const res = await s.chat(params(`用这张 ${IMG} 当参考`));
    expect(res.ask).toBeUndefined();
    expect(calls.map((c) => c.tool)).toEqual(['web.fetch_image']);
  });

  it('地址只出现在系统记录里 → 弹下载确认,工具不执行', async () => {
    script = [{ calls: [{ name: 'web.fetch_image', args: { url: IMG } }] }];
    const { calls, onToolCall } = recorder();
    const s = new PiChatSession();
    s.onToolCall = onToolCall;
    const res = await s.chat(params('下载吧', [{ role: 'system', content: `搜索到 ${IMG}` }]));
    expect(calls).toHaveLength(0);
    expect(res.ask?.options.map((o) => o.label)).toEqual(['下载', '先不下载']);
    expect(res.ask?.question).toContain('cdn.example.com/ref.png');
  });

  it('同一轮里的搜索也不会在未确认下载时被顺带执行', async () => {
    script = [{
      calls: [
        { name: 'web.search', args: { query: '庭院' } },
        { name: 'web.fetch_image', args: { url: IMG } },
      ],
    }];
    const { calls, onToolCall } = recorder();
    const s = new PiChatSession();
    s.onToolCall = onToolCall;
    const res = await s.chat(params('搜一张庭院图并下载'));
    expect(calls).toHaveLength(0);
    expect(res.ask).toBeDefined();
  });

  it('用户点「下载」后,同一地址才真正执行', async () => {
    const { calls, onToolCall } = recorder();
    const s = new PiChatSession();
    s.onToolCall = onToolCall;
    script = [{ calls: [{ name: 'web.fetch_image', args: { url: IMG } }] }];
    const first = await s.chat(params('找一张参考图'));
    expect(first.ask?.options[0]?.label).toBe('下载');
    expect(calls).toHaveLength(0);

    script = [
      { calls: [{ name: 'web.fetch_image', args: { url: IMG } }] },
      { text: '已下载到画布' },
    ];
    roundIndex = 0;
    const second = await s.chat(params('下载'));
    expect(second.ask).toBeUndefined();
    expect(calls.map((c) => c.tool)).toEqual(['web.fetch_image']);
    expect(calls[0]!.args.url).toBe(IMG);
  });

  it('用户点「先不下载」后,模型再调一次仍然不执行', async () => {
    const { calls, onToolCall } = recorder();
    const s = new PiChatSession();
    s.onToolCall = onToolCall;
    script = [{ calls: [{ name: 'web.fetch_image', args: { url: IMG } }] }];
    await s.chat(params('找一张参考图'));
    script = [{ calls: [{ name: 'web.fetch_image', args: { url: IMG } }] }];
    roundIndex = 0;
    const second = await s.chat(params('先不下载'));
    expect(calls).toHaveLength(0);
    expect(second.ask?.options[1]?.label).toBe('先不下载');
  });
});
