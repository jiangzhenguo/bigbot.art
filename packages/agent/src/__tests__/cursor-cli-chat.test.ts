import { beforeEach, describe, expect, it, vi } from 'vitest';

const completeCursorCli = vi.fn();
const createModels = vi.fn();

vi.mock('../cursor-cli.js', () => ({ completeCursorCli }));
vi.mock('@earendil-works/pi-ai', () => ({
  createProvider: () => ({}),
  createModels,
}));
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({ openAICompletionsApi: () => ({}) }));
vi.mock('@earendil-works/pi-ai/api/openai-responses.lazy', () => ({ openAIResponsesApi: () => ({}) }));

const { PiChatSession } = await import('../pi-chat.js');

function params() {
  return {
    projectId: 'p1', canvasId: 'c1', text: '看看画布',
    context: { systemPrompt: 'sys', messages: [] },
    llm: { kind: 'cursor-cli', model: 'composer-2.5' },
  } as never;
}

describe('Cursor CLI 对话模式', () => {
  beforeEach(() => {
    completeCursorCli.mockReset();
    createModels.mockReset();
  });

  it('复用 BigBotArt 工具桥完成多轮调用，不创建 HTTP Models', async () => {
    completeCursorCli
      .mockResolvedValueOnce({
        role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'canvas.list_nodes', arguments: {} }],
        stopReason: 'stop', timestamp: 1,
      })
      .mockResolvedValueOnce({
        role: 'assistant', content: [{ type: 'text', text: '画布有 2 个节点' }],
        stopReason: 'stop', timestamp: 2,
      });
    const session = new PiChatSession();
    session.onToolCall = async (req) => ({
      id: req.id,
      result: { ok: true, result: '节点 A\n节点 B' },
    });
    const result = await session.chat(params());
    expect(result.reply).toBe('画布有 2 个节点');
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ name: 'canvas.list_nodes', ok: true, result: '节点 A\n节点 B' }),
    ]);
    expect(completeCursorCli).toHaveBeenCalledTimes(2);
    expect(completeCursorCli.mock.calls[0]![1]).toEqual({ model: 'composer-2.5', signal: expect.any(AbortSignal) });
    expect(createModels).not.toHaveBeenCalled();
  });

  it('把适配器文本增量接入现有 ChatStreamEvent', async () => {
    completeCursorCli.mockImplementation(async (_context, opts) => {
      opts.onTextDelta('你');
      opts.onTextDelta('好');
      return {
        role: 'assistant', content: [{ type: 'text', text: '你好' }], stopReason: 'stop', timestamp: 1,
      };
    });
    const events: Array<Record<string, unknown>> = [];
    const result = await new PiChatSession().chat(params(), (event) => events.push(event as never));
    expect(result.reply).toBe('你好');
    expect(events.filter((event) => event.kind === 'text-delta')).toEqual([
      expect.objectContaining({ round: 0, contentIndex: 0, delta: '你' }),
      expect.objectContaining({ round: 0, contentIndex: 0, delta: '好' }),
    ]);
  });

  it('CLI 错误如实向上抛出', async () => {
    completeCursorCli.mockRejectedValue(new Error('无法启动 Cursor CLI'));
    await expect(new PiChatSession().chat(params())).rejects.toThrow('无法启动 Cursor CLI');
  });
});
