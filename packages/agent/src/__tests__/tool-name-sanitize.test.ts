/**
 * 工具名净化(2026-10-10「kimi-coding 对话 400」事故)
 *
 * 事故形态:Kimi coding 端点(api.kimi.com/coding)只接受 [a-zA-Z0-9_-] 的 function 名,
 * 本项目工具名全是「域.动作」(canvas.list_nodes),首轮请求即被
 * 400「function name is invalid…」拒绝,对话直接失败。
 *
 * 修复:首次撞上该错误时,本会话把工具定义切换为短横线别名(canvas-list_nodes)重试,
 * 模型回传的调用名映射还原后再走闸判与工具桥;assistant 历史块与 toolResult 保持别名。
 *
 * 本文件覆盖:
 *  - sanitize/desanitize 纯函数:全部工具名可逆、幂等、无短横线(映射前提锁定)
 *  - 集成:第一轮 400 → 第二轮工具定义已是别名 → 模型用别名调用 → 桥收到内部名、
 *    历史 toolResult 用别名 → 正常收尾
 *  - 反例:非工具名类错误(401)不触发重试,直接抛出
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toolDefinitions } from '@bigbotart/shared';
import { sanitizeToolName, desanitizeToolName } from '../pi-chat.js';

describe('工具名净化纯函数', () => {
  const names = toolDefinitions().map((t) => t.name);

  it('全部工具名都是「单点号、无短横线」(映射可逆的前提)', () => {
    expect(names.length).toBeGreaterThan(20);
    for (const n of names) {
      expect(n.split('.').length, `${n} 应恰好一个点号`).toBe(2);
      expect(n.includes('-'), `${n} 不应含短横线`).toBe(false);
    }
  });

  it('sanitize → desanitize 对全部工具名可逆', () => {
    for (const n of names) {
      const alias = sanitizeToolName(n);
      expect(alias.includes('.')).toBe(false);
      expect(/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(alias), `${alias} 应符合端点命名校验`).toBe(true);
      expect(desanitizeToolName(alias)).toBe(n);
    }
  });

  it('desanitize 幂等:无短横线的名字原样返回', () => {
    expect(desanitizeToolName('canvas.list_nodes')).toBe('canvas.list_nodes');
    expect(desanitizeToolName('ask.user')).toBe('ask.user');
  });

  it('sanitize 把每个点号都换成短横线', () => {
    expect(sanitizeToolName('canvas.list_nodes')).toBe('canvas-list_nodes');
    expect(sanitizeToolName('ask.user')).toBe('ask-user');
  });
});

/* ═══ 集成:主循环接线验证(mock pi-ai,不碰真模型) ═══ */

let script: Array<{
  text?: string;
  calls?: Array<{ name: string; args: unknown }>;
  stopReason?: string;
  errorMessage?: string;
}> = [];
let roundIndex = 0;
/** 每次 complete 收到的 ctx(断言 tools 声明名与 history 用) */
let seenContexts: Array<{ messages: unknown[]; tools?: Array<{ name: string }> }> = [];
/** 每次 complete 收到的 opts(断言 temperature 降级用) */
let seenOptions: Array<Record<string, unknown>> = [];

vi.mock('@earendil-works/pi-ai', () => ({
  createProvider: () => ({}),
  createModels: () => ({
    setProvider: () => {},
    getModel: () => ({}),
    complete: async (
      _m: unknown,
      ctx: { messages: unknown[]; tools?: Array<{ name: string }> },
      opts?: Record<string, unknown>,
    ) => {
      seenContexts.push(ctx);
      seenOptions.push(opts ?? {});
      const step = script[roundIndex] ?? { text: '(脚本用尽)' };
      roundIndex += 1;
      if (step.errorMessage) {
        return { content: [], stopReason: 'error', errorMessage: step.errorMessage };
      }
      const content: unknown[] = [];
      if (step.text !== undefined) content.push({ type: 'text', text: step.text });
      for (const c of step.calls ?? []) {
        content.push({ type: 'toolCall', id: `call-${roundIndex}-${c.name}`, name: c.name, arguments: c.args });
      }
      return { content, stopReason: step.stopReason ?? 'stop' };
    },
  }),
}));
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({}),
}));

const { PiChatSession } = await import('../pi-chat.js');

function mkParams() {
  return {
    projectId: 'p1',
    canvasId: 'c1',
    text: '看看画布',
    context: { systemPrompt: 'sys', messages: [] },
  } as never;
}

describe('端点拒绝点号工具名 → 自动切换短横线别名', () => {
  beforeEach(() => {
    script = [];
    roundIndex = 0;
    seenContexts = [];
    seenOptions = [];
  });

  it('400 function name is invalid → 重试时工具定义无点号,桥收到内部名,toolResult 用别名', async () => {
    script = [
      // 第 0 轮:端点拒绝(事故原话)
      {
        errorMessage:
          '400: {"message":"function name is invalid, must start with a letter and can contain letters, numbers, underscores, and dashes","type":"invalid_request_error"}',
      },
      // 重试轮:模型用别名调用(端点视角的名字)
      { calls: [{ name: 'canvas-list_nodes', args: {} }] },
      // 收尾轮:纯文本
      { text: '画布上有 2 个节点' },
    ];
    const s = new PiChatSession();
    const bridged: string[] = [];
    s.onToolCall = async (req: { id: number; params: { tool: string } }) => {
      bridged.push(req.params.tool);
      return { id: req.id, result: { ok: true, result: '节点 A\n节点 B' } } as never;
    };
    const r = await s.chat(mkParams());

    // 正常收尾
    expect(r.reply).toBe('画布上有 2 个节点');
    // 重试确实发生:第 0 轮失败 + 重试 + 收尾 = 3 次 complete
    expect(seenContexts.length).toBe(3);
    // 重试轮起,工具定义全部是别名(无点号、含短横线)
    for (const t of seenContexts[1]!.tools ?? []) {
      expect(t.name.includes('.')).toBe(false);
      expect(/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(t.name)).toBe(true);
    }
    // 工具桥收到的是还原后的内部名
    expect(bridged).toEqual(['canvas.list_nodes']);
    // UI 留痕也用内部名
    expect(r.toolCalls.map((c) => c.name)).toEqual(['canvas.list_nodes']);
    // history:assistant 块保持别名 + toolResult 用别名(协议一致性,否则下轮又 400)
    const finalCtx = seenContexts[2]!;
    const assistantMsg = finalCtx.messages.find((m) => {
      const c = (m as { content?: unknown }).content;
      return Array.isArray(c) && c.some((b) => (b as { type?: string }).type === 'toolCall');
    }) as { content: Array<{ type: string; name?: string }> } | undefined;
    const histCall = assistantMsg?.content.find((b) => b.type === 'toolCall');
    expect(histCall?.name).toBe('canvas-list_nodes');
    const toolResult = finalCtx.messages.find(
      (m) => (m as { role?: string }).role === 'toolResult',
    ) as { toolName?: string } | undefined;
    expect(toolResult?.toolName).toBe('canvas-list_nodes');
  });

  it('非工具名类错误(401)不触发别名重试,直接抛出', async () => {
    script = [{ errorMessage: '401: {"message":"Incorrect API key provided"}' }];
    const s = new PiChatSession();
    await expect(s.chat(mkParams())).rejects.toThrow(/401/);
    // 只调用一次:没有重试
    expect(seenContexts.length).toBe(1);
  });

  it('400 invalid temperature(Kimi k3 原话)→ 重试起不再下发 temperature 字段', async () => {
    script = [
      { errorMessage: '400: {"message":"invalid temperature: only 1 is allowed for this model","type":"invalid_request_error"}' },
      { text: '你好' },
    ];
    const s = new PiChatSession();
    const r = await s.chat(mkParams());
    expect(r.reply).toBe('你好');
    expect(seenOptions.length).toBe(2);
    // 第 0 轮带 0.4;重试轮不再携带该字段(走端点默认 1)
    expect(seenOptions[0]!.temperature).toBe(0.4);
    expect('temperature' in seenOptions[1]!).toBe(false);
  });

  it('k3 真实形态:先拒工具名再拒 temperature,两个降级在同一会话先后生效', async () => {
    script = [
      { errorMessage: '400: {"message":"function name is invalid, must start with a letter and can contain letters, numbers, underscores, and dashes"}' },
      { errorMessage: '400: {"message":"invalid temperature: only 1 is allowed for this model"}' },
      { calls: [{ name: 'canvas-list_nodes', args: {} }] },
      { text: '完成' },
    ];
    const s = new PiChatSession();
    const bridged: string[] = [];
    s.onToolCall = async (req: { id: number; params: { tool: string } }) => {
      bridged.push(req.params.tool);
      return { id: req.id, result: { ok: true, result: 'ok' } } as never;
    };
    const r = await s.chat(mkParams());
    expect(r.reply).toBe('完成');
    expect(bridged).toEqual(['canvas.list_nodes']);
    expect(seenOptions.length).toBe(4);
    // 前两次带 temperature;自 temperature 降级那次起不再携带
    expect(seenOptions[0]!.temperature).toBe(0.4);
    expect(seenOptions[1]!.temperature).toBe(0.4);
    expect('temperature' in seenOptions[2]!).toBe(false);
    expect('temperature' in seenOptions[3]!).toBe(false);
    // 工具名降级同样生效
    const names = (seenContexts[3]!.tools ?? []).map((t) => t.name);
    expect(names).toContain('canvas-list_nodes');
  });

  it('正常端点(不报错)工具定义保持点号原名,行为不变', async () => {
    script = [
      { calls: [{ name: 'canvas.list_nodes', args: {} }] },
      { text: '完成' },
    ];
    const s = new PiChatSession();
    const bridged: string[] = [];
    s.onToolCall = async (req: { id: number; params: { tool: string } }) => {
      bridged.push(req.params.tool);
      return { id: req.id, result: { ok: true, result: 'ok' } } as never;
    };
    const r = await s.chat(mkParams());
    expect(r.reply).toBe('完成');
    expect(bridged).toEqual(['canvas.list_nodes']);
    // 第 0 轮工具定义就是点号原名
    const names = (seenContexts[0]!.tools ?? []).map((t) => t.name);
    expect(names).toContain('canvas.list_nodes');
    expect(names.some((n) => n.includes('-'))).toBe(false);
  });
});
