/**
 * 对话协议支持(2026-10-20「OpenCode Go grok-4.6 每轮 400 ModelProtocolUnsupported」)
 *
 * 背景:OpenCode Go 按模型分协议 —— deepseek/glm 走 `/v1/chat/completions`,
 * grok-4.6/4.7 只开 `/v1/responses`。App 此前写死 chat,选到 grok 必然失败。
 *
 * 修复两层:
 *  ① 主进程 `resolveModelProtocol` 判定协议 → 经 `toChatLlm` 传给 worker → pi-chat 选
 *    pi-ai 的 `openAIResponsesApi()`(消息/工具形状由 pi-ai 归一化,上层代码不变)。
 *  ② 兜底:端点回「不支持该协议」时自动换另一套协议重试本轮(两个方向各一次,绝不无限翻)。
 *
 * 本文件锁住上面两层:默认 chat、显式 responses、双向自动切换、只翻一次。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let script: Array<
  | { text?: string; calls?: Array<{ name: string; args: unknown }>; stopReason?: string; errorMessage?: string }
  | { throwMessage: string }
> = [];
let roundIndex = 0;
/** createProvider 收到的配置(断言 api 实现与 model.api 用) */
let seenProviders: Array<{ api?: { api?: string }; models?: Array<{ api?: string }> }> = [];

vi.mock('@earendil-works/pi-ai', () => ({
  createProvider: (cfg: unknown) => {
    seenProviders.push(cfg as never);
    return {};
  },
  createModels: () => ({
    setProvider: () => {},
    getModel: () => ({}),
    complete: async () => {
      const step = script[roundIndex] ?? { text: '(脚本用尽)' };
      roundIndex += 1;
      if ('throwMessage' in step) throw new Error(step.throwMessage);
      if (step.errorMessage) return { content: [], stopReason: 'error', errorMessage: step.errorMessage };
      const content: unknown[] = [];
      if (step.text !== undefined) content.push({ type: 'text', text: step.text });
      for (const c of step.calls ?? []) {
        content.push({ type: 'toolCall', id: `call-${roundIndex}`, name: c.name, arguments: c.args });
      }
      return { content, stopReason: step.stopReason ?? 'stop' };
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

function mkParams(protocol?: 'chat' | 'responses') {
  return {
    projectId: 'p1',
    canvasId: 'c1',
    text: '你好',
    context: { systemPrompt: 'sys', messages: [] },
    llm: {
      kind: 'openai-compatible',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: 'k',
      model: 'grok-4.6',
      ...(protocol ? { protocol } : {}),
    },
  } as never;
}

describe('对话协议:选择 pi-ai 的对应实现', () => {
  beforeEach(() => {
    script = [];
    roundIndex = 0;
    seenProviders = [];
  });

  it('缺省 → chat(/v1/chat/completions)', async () => {
    script = [{ text: '好' }];
    const r = await new PiChatSession().chat(mkParams());
    expect(r.reply).toBe('好');
    expect(seenProviders[0]!.api?.api).toBe('openai-completions');
    expect(seenProviders[0]!.models![0]!.api).toBe('openai-completions');
  });

  it('显式 responses → openAIResponsesApi + model.api=openai-responses', async () => {
    script = [{ text: '好' }];
    const r = await new PiChatSession().chat(mkParams('responses'));
    expect(r.reply).toBe('好');
    expect(seenProviders[0]!.api?.api).toBe('openai-responses');
    expect(seenProviders[0]!.models![0]!.api).toBe('openai-responses');
  });
});

describe('对话协议:端点拒绝时自动换协议(两个方向)', () => {
  beforeEach(() => {
    script = [];
    roundIndex = 0;
    seenProviders = [];
  });

  it('chat 被 ModelProtocolUnsupported 拒 → 切 responses 重试并收尾', async () => {
    script = [
      {
        errorMessage:
          '400: {"type":"ModelProtocolUnsupported","message":"Model does not support this protocol."}',
      },
      { calls: [{ name: 'canvas.list_nodes', args: {} }] },
      { text: '画布有 2 个节点' },
    ];
    const s = new PiChatSession();
    const bridged: string[] = [];
    s.onToolCall = async (req: { id: number; params: { tool: string } }) => {
      bridged.push(req.params.tool);
      return { id: req.id, result: { ok: true, result: '节点 A\n节点 B' } } as never;
    };
    const r = await s.chat(mkParams());
    expect(r.reply).toBe('画布有 2 个节点');
    // 第 1 次 provider 是 chat,重试时换成 responses
    expect(seenProviders.map((p) => p.api?.api)).toEqual(['openai-completions', 'openai-responses']);
    expect(bridged).toEqual(['canvas.list_nodes']);
  });

  it('responses 被拒 → 翻回 chat(自建端点可能只认 chat)', async () => {
    script = [
      { errorMessage: '404: {"type":"ModelProtocolUnsupported","message":"Model does not support this protocol."}' },
      { text: '好' },
    ];
    const r = await new PiChatSession().chat(mkParams('responses'));
    expect(r.reply).toBe('好');
    expect(seenProviders.map((p) => p.api?.api)).toEqual(['openai-responses', 'openai-completions']);
  });

  it('抛异常形态(complete throws)也触发切换', async () => {
    script = [
      { throwMessage: '400: {"type":"ModelProtocolUnsupported","message":"Model does not support this protocol."}' },
      { text: '好' },
    ];
    const r = await new PiChatSession().chat(mkParams());
    expect(r.reply).toBe('好');
    expect(seenProviders.map((p) => p.api?.api)).toEqual(['openai-completions', 'openai-responses']);
  });

  it('两套协议都不认 → 只翻一次,如实抛出(不是无限循环)', async () => {
    const unsupported = {
      errorMessage: '400: {"type":"ModelProtocolUnsupported","message":"Model does not support this protocol."}',
    };
    script = [unsupported, unsupported, unsupported];
    const s = new PiChatSession();
    await expect(s.chat(mkParams())).rejects.toThrow(/ModelProtocolUnsupported/);
    // 只尝试两套协议,不重复翻
    expect(seenProviders.map((p) => p.api?.api)).toEqual(['openai-completions', 'openai-responses']);
  });

  it('其他错误(401)不会触发协议切换', async () => {
    script = [{ errorMessage: '401: {"message":"Incorrect API key provided"}' }];
    await expect(new PiChatSession().chat(mkParams())).rejects.toThrow(/401/);
    expect(seenProviders.length).toBe(1);
  });
});
