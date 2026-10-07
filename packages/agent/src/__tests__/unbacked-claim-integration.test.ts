/**
 * 「承诺未兑现」闸的**端到端**集成测试(2026-10-07 「舞蹈」主画布假成功事故)
 *
 * 纯函数判定已由 unbacked-claim.test.ts 覆盖;本文件验证**主循环里的接线真的生效**:
 * 模型第一轮只回文本不调工具 → 必须被塞回纠正指令重试一次;
 * 模型第二轮真发了 engine.submit → 该调用必须真的执行到主进程。
 *
 * 做法:mock `@earendil-works/pi-ai` 的 createProvider/createModels,让 `models.complete`
 * 按脚本返回预设的 AssistantMessage 序列,不碰真模型(与 vision-caption 测试同口径)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** 每轮 LLM 返回的脚本(由各用例设置) */
let script: Array<{ text?: string; calls?: Array<{ name: string; args: unknown }>; stopReason?: string }> = [];
let roundIndex = 0;
/** 每次 complete 调用时收到的 messages(用于断言纠正指令真的塞进去了) */
let seenMessages: unknown[][] = [];

vi.mock('@earendil-works/pi-ai', () => {
  return {
    createProvider: () => ({}),
    createModels: () => ({
      setProvider: () => {},
      getModel: () => ({}),
      complete: async (_m: unknown, ctx: { messages: unknown[] }) => {
        seenMessages.push(ctx.messages);
        const step = script[roundIndex] ?? { text: '(脚本用尽)' };
        roundIndex += 1;
        const content: unknown[] = [];
        if (step.text !== undefined) content.push({ type: 'text', text: step.text });
        for (const c of step.calls ?? []) {
          content.push({ type: 'toolCall', id: `call-${roundIndex}-${c.name}`, name: c.name, arguments: c.args });
        }
        return { content, stopReason: step.stopReason ?? 'stop' };
      },
    }),
  };
});
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({}),
}));

const { PiChatSession } = await import('../pi-chat.js');

/** 造一个最小可用的 ChatParams */
function mkParams() {
  return {
    projectId: 'p1',
    canvasId: 'c1',
    text: '生成',
    context: { systemPrompt: 'sys', messages: [] },
  } as never;
}

/** 收集所有工具调用 */
function recorder() {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const onToolCall = async (req: { params: { tool: string; args: Record<string, unknown> } }) => {
    calls.push({ tool: req.params.tool, args: req.params.args });
    return { id: 1, result: { ok: true, result: `已提交生成 ${req.params.args.nodeId}`, nodeId: String(req.params.args.nodeId ?? '') } };
  };
  return { calls, onToolCall: onToolCall as never };
}

beforeEach(() => {
  script = [];
  roundIndex = 0;
  seenMessages = [];
});

describe('集成:模型只说不做 → 自动塞回纠正指令并重试', () => {
  it('事故重现:第1轮谎称「已提交生成」→ 第2轮真发 engine.submit,必须执行到主进程', async () => {
    script = [
      // 第 1 轮:事故原话,零工具调用
      { text: '已提交生成,完成后画布会自动刷新。' },
      // 第 2 轮:被纠正后真的调用
      { calls: [{ name: 'engine.submit', args: { nodeId: 'new24-ix8p' } }] },
      { text: '已提交生成 new24-ix8p。' },
    ];
    const { calls, onToolCall } = recorder();
    const s = new PiChatSession();
    s.onToolCall = onToolCall;
    const res = await s.chat(mkParams());

    // ① engine.submit 真的执行了 —— 这是修复的核心价值
    expect(calls.map((c) => c.tool)).toEqual(['engine.submit']);
    expect(calls[0]!.args).toEqual({ nodeId: 'new24-ix8p' });
    // ② 结果里带的是真提交的 toolCall 记录
    expect(res.toolCalls.map((t) => t.name)).toEqual(['engine.submit']);
    // ③ 收尾文案不应再是「未执行」标记
    expect(res.reply).not.toMatch(/未实际执行/);
  });

  it('纠正指令确实以 user 消息塞进了第 2 轮的上下文', async () => {
    script = [
      { text: '已提交生成,完成后画布会自动刷新。' },
      { calls: [{ name: 'engine.submit', args: { nodeId: 'n1' } }] },
      { text: 'ok' },
    ];
    const { onToolCall } = recorder();
    const s = new PiChatSession();
    s.onToolCall = onToolCall;
    await s.chat(mkParams());

    // 第 2 轮(下标 1)的 messages 里必须有系统纠正指令
    expect(seenMessages.length).toBeGreaterThanOrEqual(2);
    const secondRound = JSON.stringify(seenMessages[1]);
    expect(secondRound).toMatch(/没有发出任何工具调用/);
    expect(secondRound).toMatch(/engine\.submit/);
  });

  it('重试后仍只说不做 → 以「未实际执行」收尾,绝不冒充成功', async () => {
    script = [
      { text: '已提交生成,完成后画布会自动刷新。' },
      // 被明确点名后**依然**只回文本,不发工具
      { text: '已提交生成,完成后画布会自动刷新。' },
      { text: '已提交生成' },
    ];
    const { calls, onToolCall } = recorder();
    const s = new PiChatSession();
    s.onToolCall = onToolCall;
    const res = await s.chat(mkParams());

    // 自始至终没有任何工具调用
    expect(calls).toEqual([]);
    // 收尾必须带未执行标记(否则又是一次假成功)
    expect(res.reply).toMatch(/未实际执行/);
    expect(res.reply).toMatch(/没有发出任何工具调用|仍未发出/);
  });

  it('只重试一次,不会无限循环(脚本用尽也不该再喂一次)', async () => {
    // 全程谎报:只有 1 次重试机会,故 complete 总调用次数应为 2(首轮 + 重试)
    script = [
      { text: '已提交生成 a' },
      { text: '已提交生成 b' },
      { text: '已提交生成 c' },
      { text: '已提交生成 d' },
    ];
    const { onToolCall } = recorder();
    const s = new PiChatSession();
    s.onToolCall = onToolCall;
    await s.chat(mkParams());
    expect(roundIndex).toBe(2);
  });
});

describe('集成:正常路径不受影响(不误伤)', () => {
  it('征询语气「要现在提交生成吗?」直接收尾,不做重试', async () => {
    script = [{ text: '已写好背视图提示词。要现在提交生成吗?' }, { text: '不该走到这里' }];
    const { onToolCall } = recorder();
    const s = new PiChatSession();
    s.onToolCall = onToolCall;
    const res = await s.chat(mkParams());
    expect(roundIndex).toBe(1); // 只调了一次 LLM
    expect(res.reply).toContain('要现在提交生成吗');
    expect(res.reply).not.toMatch(/未实际执行/);
  });

  it('普通闲聊直接收尾', async () => {
    script = [{ text: '你好,有什么可以帮你?' }];
    const { onToolCall } = recorder();
    const s = new PiChatSession();
    s.onToolCall = onToolCall;
    const res = await s.chat(mkParams());
    expect(roundIndex).toBe(1);
    expect(res.reply).toBe('你好,有什么可以帮你?');
  });

  it('带工具调用的正常轮次:说明文字与调用并存时不触发重试', async () => {
    script = [
      { text: '', calls: [{ name: 'canvas.update_node', args: { nodeId: 'n1', prompt: 'x' } }] },
      // 收尾用征询/说明语气(不含完成声明),避免误触发本闸
      { text: '提示词已写好,要现在提交生成吗?' },
    ];
    const { calls, onToolCall } = recorder();
    const s = new PiChatSession();
    s.onToolCall = onToolCall;
    await s.chat(mkParams());
    expect(calls.map((c) => c.tool)).toEqual(['canvas.update_node']);
    expect(roundIndex).toBe(2); // 正常两轮,没有额外重试
  });

  it('已成功提交过以后,复述「已提交生成」不再被当成谎报', async () => {
    // 回归:纠正成功后第 3 轮的收尾致辞若无条件按「本轮无调用」判,
    // 会把一次**成功**提交污蔑成「未实际执行」—— 用户会去重复提交。
    script = [
      { text: '已提交生成 n1。' }, // 谎报 → 触发重试
      { calls: [{ name: 'engine.submit', args: { nodeId: 'n1' } }] }, // 真提交成功
      { text: '已提交生成 n1,完成后画布会自动刷新。' }, // 收尾复述
    ];
    const { calls, onToolCall } = recorder();
    const s = new PiChatSession();
    s.onToolCall = onToolCall;
    const res = await s.chat(mkParams());
    expect(calls.map((c) => c.tool)).toEqual(['engine.submit']);
    // 复述是事实,不能被扣上「未实际执行」
    expect(res.reply).not.toMatch(/未实际执行/);
  });
});

describe('集成:与既有「截断」防护共存', () => {
  it('stopReason=length 仍走截断文案,不被新的闸抢走', async () => {
    script = [{ text: '已提交生成,完成后画布会自动刷新。', stopReason: 'length' }];
    const { onToolCall } = recorder();
    const s = new PiChatSession();
    s.onToolCall = onToolCall;
    const res = await s.chat(mkParams());
    // 截断优先:文案带「截断」,且不额外重试
    expect(res.reply).toMatch(/截断/);
    expect(roundIndex).toBe(1);
  });
});
