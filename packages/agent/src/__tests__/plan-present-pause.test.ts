/**
 * plan.present 在对话循环里暂停:成功则出确认卡,同一批里的 engine.submit 不执行。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const { PiChatSession } = await import('../pi-chat.js');

const PLAN = '# 出片\n\n提交镜头 01 和镜头 02。';

function params(text = '做两条镜头') {
  return {
    projectId: 'p1',
    canvasId: 'c1',
    text,
    context: { systemPrompt: 'sys', messages: [] },
  } as never;
}

describe('plan.present 暂停', () => {
  beforeEach(() => {
    script = [];
    roundIndex = 0;
  });

  it('成功时返回确认卡,同一批的 engine.submit 不进工具桥', async () => {
    script = [{
      calls: [
        { name: 'engine.submit', args: { nodeId: 'a' } },
        { name: 'plan.present', args: { markdown: PLAN } },
      ],
    }];
    const bridged: string[] = [];
    const s = new PiChatSession();
    s.onToolCall = async (req: { id: number; params: { tool: string } }) => {
      bridged.push(req.params.tool);
      return { id: req.id, result: { ok: true, result: '计划已交给用户确认。' } } as never;
    };
    const r = await s.chat(params());
    expect(bridged).toEqual(['plan.present']);
    expect(r.ask?.options.map((o) => o.label)).toEqual(['按此执行', '修改计划']);
    expect(r.reply).toBe(PLAN);
    expect(r.toolCalls.map((c) => c.name)).toEqual(['plan.present']);
  });

  it('主进程拒绝时不暂停,模型还能继续回复', async () => {
    script = [
      { calls: [{ name: 'plan.present', args: { markdown: PLAN } }] },
      { text: '那只提交这一镜' },
    ];
    const s = new PiChatSession();
    s.onToolCall = async (req: { id: number }) =>
      ({ id: req.id, result: { ok: false, result: '未出片镜头只有 1 个,不必计划确认。' } }) as never;
    const r = await s.chat(params());
    expect(r.ask).toBeUndefined();
    expect(r.reply).toBe('那只提交这一镜');
  });

  it('用户已点头后又原样交同一份计划,不再打工具桥', async () => {
    script = [
      { calls: [{ name: 'plan.present', args: { markdown: PLAN } }] },
      { calls: [{ name: 'plan.present', args: { markdown: PLAN } }] },
      { text: '开始提交' },
    ];
    const bridged: string[] = [];
    const s = new PiChatSession();
    s.onToolCall = async (req: { id: number; params: { tool: string } }) => {
      bridged.push(req.params.tool);
      return { id: req.id, result: { ok: true, result: '已交' } } as never;
    };
    const first = await s.chat(params());
    expect(first.ask).toBeDefined();
    const second = await s.chat(params('按此执行'));
    expect(bridged).toEqual(['plan.present']);
    expect(second.ask).toBeUndefined();
    expect(second.reply).toBe('开始提交');
    expect(second.toolCalls.some((c) => c.ok === false && c.result.includes('直接 engine.submit'))).toBe(true);
  });
});
