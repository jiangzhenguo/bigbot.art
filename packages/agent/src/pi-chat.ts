/**
 * PiChatSession — 画布页 Agent 多轮对话 + 工具调用循环
 *
 * 流程:
 *   1. buildContext(主进程组装) → messages + tools 发给 LLM
 *   2. LLM 返回 toolUse → 通过反向 RPC 调主进程执行工具 → toolResult 追加进 messages → 再调 LLM
 *   3. 直到 LLM 不再调工具(stop)或达到最大轮数 → 返回 reply + toolCalls
 *   4. AbortSignal 随时可中止(103ms 内生效,已 spike 验证)
 *
 * 端点解析与 pi-planner 一致(远端 env > LM Studio 本地)。
 */
import { createModels, createProvider, type Context, type Message, type AssistantMessage, type ToolCall } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { LlmSource } from '@bigbotart/shared';
import type { ChatParams, ChatResult, ToolCallRequest, ToolCallResponse } from './protocol.js';
import { PiPlanner } from './pi-planner.js';
import { toolDefinitions } from '@bigbotart/shared';

const MAX_TOOL_ROUNDS = 8;

export class PiChatSession {
  private planner = new PiPlanner();
  private abort: AbortController | null = null;
  private toolCallSeq = 0;
  /** worker → 主进程的工具调用回调(由 worker.ts 注入) */
  onToolCall: ((req: ToolCallRequest) => Promise<ToolCallResponse>) | null = null;

  /** 中止当前对话(真实打断) */
  cancel(): void {
    this.abort?.abort();
  }

  async chat(params: ChatParams): Promise<ChatResult> {
    const ep = this.planner['resolveEndpoint'](params.llm);
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const toolCalls: ChatResult['toolCalls'] = [];

    const model = {
      id: ep.modelId, name: ep.modelId, api: 'openai-completions' as const,
      provider: 'bigbotart-llm' as const, baseUrl: ep.baseUrl, reasoning: false,
      input: ['text'] as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32000, maxTokens: 4000,
    };
    const provider = createProvider({
      id: 'bigbotart-llm', name: 'BigBotArt LLM', baseUrl: ep.baseUrl,
      auth: { apiKey: { name: 'BigBotArt LLM', resolve: async () => ({ auth: {} }) } },
      models: [model], api: openAICompletionsApi(),
    });
    const models = createModels();
    models.setProvider(provider);

    // 历史消息:pi-ai 的 AssistantMessage.content 必须是块数组(string 会触发 flatMap 错误)
    const messages: Message[] = [
      ...params.context.messages.map((m) => {
        if (m.role === 'assistant') {
          return {
            role: 'assistant',
            content: [{ type: 'text', text: m.content }],
            timestamp: Date.now(),
          } as unknown as Message;
        }
        return { role: 'user', content: m.content, timestamp: Date.now() } as Message;
      }),
      { role: 'user', content: params.text, timestamp: Date.now() } as Message,
    ];

    const tools = toolDefinitions() as never;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (signal.aborted) return { reply: '', toolCalls, aborted: true };
      const context: Context = { systemPrompt: params.context.systemPrompt, messages, tools };
      let assistant: AssistantMessage;
      try {
        assistant = await models.complete(models.getModel('bigbotart-llm', ep.modelId)!, context, {
          maxTokens: 4000,
          temperature: 0.4,
          apiKey: ep.apiKey ?? 'unused',
          signal,
        });
      } catch (e) {
        if (signal.aborted) return { reply: '', toolCalls, aborted: true };
        // LLM 请求失败(401/超时/不可达)必须向上抛,让主进程返回 {ok:false, error}
        // ——静默吞掉会让错误端点表现为"成功但空回复"
        throw e;
      }
      if (assistant.stopReason === 'aborted') return { reply: '', toolCalls, aborted: true };
      if (assistant.stopReason === 'error' || assistant.errorMessage) {
        throw new Error(`LLM 返回错误: ${assistant.errorMessage ?? assistant.stopReason}`);
      }

      // 调试:记录本轮 LLM 返回结构
      const blocks = assistant.content ?? [];
      console.error(`[pi-chat] round=${round} stop=${assistant.stopReason} blocks=${blocks.map((b) => b.type).join(',')} err=${assistant.errorMessage ?? ''}`);

      // 收集本轮 toolCalls 并执行
      const calls = blocks.filter((c): c is ToolCall => c.type === 'toolCall');
      if (calls.length === 0) {
        // 无工具调用 → 最终回复(text 块;thinking 模型若 text 空则回退 thinking 摘要)
        let reply = blocks
          .filter((c) => c.type === 'text')
          .map((c) => ('text' in c ? c.text : ''))
          .join('');
        if (!reply.trim()) {
          const thinking = blocks
            .filter((c) => c.type === 'thinking')
            .map((c) => ('thinking' in c ? c.thinking : ''))
            .join('');
          reply = thinking.trim() ? `(思考中) ${thinking.slice(0, 400)}` : '';
        }
        return { reply, toolCalls };
      }

      // 执行每个工具调用(反向 RPC 到主进程)
      messages.push(assistant);
      for (const call of calls) {
        const args = (call.arguments ?? {}) as Record<string, unknown>;
        const req: ToolCallRequest = {
          id: ++this.toolCallSeq,
          method: 'tool',
          params: {
            tool: call.name,
            args,
            projectId: params.projectId,
            canvasId: params.canvasId,
          },
        };
        let res: ToolCallResponse;
        if (this.onToolCall) {
          res = await this.onToolCall(req);
        } else {
          res = { id: req.id, error: { code: 'NO_BRIDGE', message: '工具桥未注入' } };
        }
        const tr = res.result ?? { ok: false, result: res.error?.message ?? '工具调用失败' };
        toolCalls.push({ name: call.name, args, ok: tr.ok, result: tr.result, nodeId: tr.nodeId });
        // toolResult 追加进 messages(OpenAI 协议)
        messages.push({
          role: 'toolResult' as const,
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: 'text' as const, text: tr.result }],
          isError: !tr.ok,
          timestamp: Date.now(),
        } as never);
      }
    }
    return { reply: '已达到最大工具调用轮数,请拆小任务继续。', toolCalls };
  }


}