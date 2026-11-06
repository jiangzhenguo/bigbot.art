/**
 * 工具调用轮数上限:默认 50、环境变量可配、达到上限后可从当前进度继续。
 *
 * 上限计的是「LLM ↔ 工具」往返轮数,不是工具总次数:一轮返回多个工具调用时,
 * 这些调用仍全部执行。提交后轮询等无进展循环由专门闸门处理,不靠烧光总轮数收尾。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_LIMIT = process.env.BIGBOTART_AGENT_MAX_TOOL_ROUNDS;
let script: Array<{ text?: string; calls?: Array<{ name: string; args: unknown }> }> = [];
let roundIndex = 0;

vi.mock('@earendil-works/pi-ai', () => ({
  createProvider: () => ({}),
  createModels: () => ({
    setProvider: () => {},
    getModel: () => ({}),
    complete: async () => {
      const step = script[roundIndex] ?? { text: '(脚本用尽)' };
      roundIndex += 1;
      const content: unknown[] = [];
      if (step.text !== undefined) content.push({ type: 'text', text: step.text });
      for (const c of step.calls ?? []) {
        content.push({ type: 'toolCall', id: `call-${roundIndex}-${c.name}`, name: c.name, arguments: c.args });
      }
      return { content, stopReason: 'stop' };
    },
  }),
}));
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({}),
}));
vi.mock('@earendil-works/pi-ai/api/openai-responses.lazy', () => ({
  openAIResponsesApi: () => ({}),
}));

const { DEFAULT_MAX_TOOL_ROUNDS, PiChatSession, resolveMaxToolRounds } = await import('../pi-chat.js');

function mkParams() {
  return {
    projectId: 'p1',
    canvasId: 'c1',
    text: '继续完成任务',
    context: { systemPrompt: 'sys', messages: [] },
  } as never;
}

function toolRecorder() {
  const names: string[] = [];
  const onToolCall = async (req: { id: number; params: { tool: string } }) => {
    names.push(req.params.tool);
    return { id: req.id, result: { ok: true, result: 'ok' } };
  };
  return { names, onToolCall: onToolCall as never };
}

beforeEach(() => {
  delete process.env.BIGBOTART_AGENT_MAX_TOOL_ROUNDS;
  script = [];
  roundIndex = 0;
});

afterAll(() => {
  if (ORIGINAL_LIMIT === undefined) delete process.env.BIGBOTART_AGENT_MAX_TOOL_ROUNDS;
  else process.env.BIGBOTART_AGENT_MAX_TOOL_ROUNDS = ORIGINAL_LIMIT;
});

describe('工具轮数配置', () => {
  it('默认 50 轮,可用 BIGBOTART_AGENT_MAX_TOOL_ROUNDS 覆盖', () => {
    expect(DEFAULT_MAX_TOOL_ROUNDS).toBe(50);
    expect(resolveMaxToolRounds({})).toBe(50);
    expect(resolveMaxToolRounds({ BIGBOTART_AGENT_MAX_TOOL_ROUNDS: '100' })).toBe(100);
  });

  it('非法值、非正数和小数回退默认,避免失效或意外缩短', () => {
    for (const value of ['bad', '', '0', '-1', '2.5', 'Infinity']) {
      expect(resolveMaxToolRounds({ BIGBOTART_AGENT_MAX_TOOL_ROUNDS: value })).toBe(DEFAULT_MAX_TOOL_ROUNDS);
    }
  });
});

describe('工具轮数主循环', () => {
  it('达到配置上限后如实报告已执行数量,并提示可回复「继续」', async () => {
    process.env.BIGBOTART_AGENT_MAX_TOOL_ROUNDS = '3';
    script = [
      { calls: [{ name: 'canvas.list_nodes', args: {} }] },
      { calls: [{ name: 'canvas.list_nodes', args: {} }] },
      { calls: [{ name: 'canvas.list_nodes', args: {} }] },
      { text: '不应再请求这一轮' },
    ];
    const { names, onToolCall } = toolRecorder();
    const s = new PiChatSession();
    s.onToolCall = onToolCall;
    const res = await s.chat(mkParams());

    expect(roundIndex).toBe(3);
    expect(names).toHaveLength(3);
    expect(res.toolCalls).toHaveLength(3);
    expect(res.reply).toContain('上限(3 轮)');
    expect(res.reply).toContain('已执行 3 个工具操作');
    expect(res.reply).toContain('回复「继续」');
    expect(res.reply).toContain('BIGBOTART_AGENT_MAX_TOOL_ROUNDS');
  });

  it('一轮多个工具会全部执行,不按工具总次数提前截断', async () => {
    process.env.BIGBOTART_AGENT_MAX_TOOL_ROUNDS = '2';
    script = [
      {
        calls: [
          { name: 'canvas.list_nodes', args: {} },
          { name: 'canvas.get_node', args: { nodeId: 'n1' } },
        ],
      },
      { text: '完成' },
    ];
    const { names, onToolCall } = toolRecorder();
    const s = new PiChatSession();
    s.onToolCall = onToolCall;
    const res = await s.chat(mkParams());

    expect(roundIndex).toBe(2);
    expect(names).toEqual(['canvas.list_nodes', 'canvas.get_node']);
    expect(res.reply).toBe('完成');
  });
});
