#!/usr/bin/env node
/**
 * Agent Worker(子进程入口)— 通过 stdio JSON-Lines 与主进程通信。
 * 已确认:pi 以子进程隔离运行。本 worker 内嵌 @earendil-works/pi-ai,
 * 用 LM Studio(Ornith-1.5)做真 LLM 规划/对话;失败回退确定性规划。
 *
 * 方法:
 * - ping: 健康检查
 * - plan: 一句话起活(单轮规划)
 * - chat: 多轮对话 + 工具调用循环(工具执行通过反向 RPC 回主进程)
 * - cancel: 中止当前 chat(AbortSignal)
 */
import readline from 'node:readline';
import type { AgentRequest, AgentResponse, ToolCallRequest, ToolCallResponse } from './protocol.js';
import { PiPlanner } from './pi-planner.js';
import { PiChatSession } from './pi-chat.js';

const rl = readline.createInterface({ input: process.stdin, terminal: false });
const startedAt = new Date().toISOString();
const planner = new PiPlanner({
  lmStudio: {
    baseUrl: process.env.BIGBOTART_LMSTUDIO_URL ?? 'http://127.0.0.1:1234/v1',
    modelId: process.env.BIGBOTART_LMSTUDIO_MODEL ?? 'ornith-1.5-35b-a3b-abliterated-mlx',
  },
});
const chatSession = new PiChatSession();

/** 主进程调用工具的反向 RPC:worker 写出 tool 请求,等主进程回结果 */
const pendingTools = new Map<number, (res: ToolCallResponse) => void>();
chatSession.onToolCall = (req: ToolCallRequest) =>
  new Promise<ToolCallResponse>((resolve) => {
    pendingTools.set(req.id, resolve);
    process.stdout.write(JSON.stringify(req) + '\n');
  });

function respond(msg: AgentResponse) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

rl.on('line', async (line) => {
  let req: AgentRequest | ToolCallResponse;
  try {
    req = JSON.parse(line) as AgentRequest;
  } catch {
    respond({ id: -1, error: { code: 'BAD_JSON', message: '无法解析请求' } });
    return;
  }
  // 主进程回传的工具执行结果(没有 method 字段,有 id + result/error)
  if (!('method' in req) && 'id' in req && ('result' in req || 'error' in req)) {
    const pending = pendingTools.get((req as ToolCallResponse).id);
    if (pending) {
      pendingTools.delete((req as ToolCallResponse).id);
      pending(req as ToolCallResponse);
      return;
    }
  }
  const r = req as AgentRequest;
  try {
    switch (r.method) {
      case 'ping':
        respond({ id: r.id, result: { ok: true as const, startedAt, pid: process.pid } });
        break;
      case 'plan': {
        const params = r.params as { brief: string; projectName?: string; existingNodeIds?: string[]; llm?: import('@bigbotart/shared').LlmSource };
        const result = await planner.plan(
          { brief: params?.brief ?? '', projectName: params?.projectName, existingNodeIds: params?.existingNodeIds },
          params?.llm,
        );
        respond({ id: r.id, result });
        break;
      }
      case 'chat': {
        const params = r.params as Parameters<PiChatSession['chat']>[0];
        const result = await chatSession.chat(params);
        respond({ id: r.id, result });
        break;
      }
      case 'cancel': {
        chatSession.cancel();
        respond({ id: r.id, result: { ok: true } });
        break;
      }
      default:
        respond({ id: r.id, error: { code: 'NO_METHOD', message: `unknown method ${r.method}` } });
    }
  } catch (e) {
    respond({ id: r.id, error: { code: 'INTERNAL', message: (e as Error).message } });
  }
});

process.on('SIGTERM', () => process.exit(0));