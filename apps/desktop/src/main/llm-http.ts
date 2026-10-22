/**
 * 主进程侧「一次性 LLM 调用」的协议适配(chat/completions ⇄ responses)。
 *
 * 为什么需要单独一层:`packages/agent` 里的 pi-chat / pi-planner 走 pi-ai,
 * 报文差异由 pi-ai 吃掉;但主进程有三处**自己 fetch** 的调用:
 *   - `h3-prompt.ts`(h3.write_prompt 写镜头提示词)
 *   - `vision.ts`(看图反推端点通道)
 *   - `selfcheck.ts`(引导向导第 4 步的 LLM 工具回环自检)
 * 它们此前都写死 `/chat/completions`,于是把 LLM 来源切到只开 `/responses` 的模型
 * (OpenCode Go 的 grok-4.6/4.7)时,对话能跑、这三个功能却 400 `ModelProtocolUnsupported`
 * (2026-10-20 实测:h3.write_prompt 连挂 5 次,模型只能空着 prompt 提交)。
 *
 * 本模块只做**纯数据变换**(URL / 请求体 / 取文本),不碰网络,便于单测。
 */
import type { LlmProtocol } from '@bigbotart/shared';

/** 端点声明「不支持这套协议」(与 pi-chat 的降级判定同口径) */
export const PROTOCOL_UNSUPPORTED_RE =
  /ModelProtocolUnsupported|does not support this protocol|unsupported (?:api|protocol)|unknown (?:endpoint|url)/i;

export interface LlmHttpTarget {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** chat = /v1/chat/completions(缺省),responses = /v1/responses */
  protocol?: LlmProtocol;
}

export type LlmToolSpec = { name: string; description?: string; parameters?: unknown };

export interface TextCallRequest {
  system?: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  tools?: LlmToolSpec[];
}

export function protocolOf(t: { protocol?: LlmProtocol }): LlmProtocol {
  return t.protocol === 'responses' ? 'responses' : 'chat';
}

/** 协议对应的 URL(基址的尾斜杠会被归一化) */
export function textCallUrl(baseUrl: string, protocol: LlmProtocol): string {
  const base = baseUrl.replace(/\/+$/, '');
  return protocol === 'responses' ? `${base}/responses` : `${base}/chat/completions`;
}

const DEFAULT_PARAMS = { type: 'object', properties: {} } as const;

/** 文本请求体:两套协议的消息/工具形状不同,这里统一收口 */
export function textCallBody(target: LlmHttpTarget, req: TextCallRequest): Record<string, unknown> {
  const protocol = protocolOf(target);
  const common = {
    model: target.model,
    ...(req.maxTokens ? (protocol === 'responses' ? { max_output_tokens: req.maxTokens } : { max_tokens: req.maxTokens }) : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  };
  if (protocol === 'responses') {
    return {
      ...common,
      ...(req.system ? { instructions: req.system } : {}),
      input: req.user,
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              name: t.name,
              description: t.description ?? '',
              parameters: t.parameters ?? DEFAULT_PARAMS,
            })),
          }
        : {}),
    };
  }
  return {
    ...common,
    messages: [
      ...(req.system ? [{ role: 'system', content: req.system }] : []),
      { role: 'user', content: req.user },
    ],
    ...(req.tools?.length
      ? {
          tools: req.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description ?? '', parameters: t.parameters ?? DEFAULT_PARAMS },
          })),
        }
      : {}),
  };
}

/** 多模态请求体(图片 + 指令):responses 用 input_image + input_text,chat 用 image_url + text */
export function visionCallBody(
  target: LlmHttpTarget,
  dataUrl: string,
  instruction: string,
  maxTokens = 700,
): Record<string, unknown> {
  const protocol = protocolOf(target);
  if (protocol === 'responses') {
    return {
      model: target.model,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: instruction },
            { type: 'input_image', image_url: dataUrl },
          ],
        },
      ],
      max_output_tokens: maxTokens,
      temperature: 0.2,
    };
  }
  return {
    model: target.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: instruction },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: maxTokens,
    temperature: 0.2,
  };
}

export interface TextCallResult {
  text: string;
  /** 被 max_tokens 截断(调用方不得把半截结果当真) */
  truncated: boolean;
}

/** 从响应里取纯文本:responses 的类型化 output item / chat 的 choices[0].message */
export function extractTextResult(json: unknown, protocol: LlmProtocol): TextCallResult {
  if (!json || typeof json !== 'object') return { text: '', truncated: false };
  const j = json as Record<string, unknown>;
  if (protocol === 'responses') {
    const out = Array.isArray(j.output) ? (j.output as Array<Record<string, unknown>>) : [];
    const parts: string[] = [];
    for (const item of out) {
      if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
      for (const c of item.content as Array<Record<string, unknown>>) {
        if (typeof c?.text === 'string') parts.push(c.text);
      }
    }
    // 某些网关非流式直接给 output_text 便捷字段
    if (parts.length === 0 && typeof j.output_text === 'string') parts.push(j.output_text);
    const incomplete = j.incomplete_details as { reason?: string } | undefined;
    const truncated = j.status === 'incomplete' && incomplete?.reason === 'max_output_tokens';
    return { text: parts.join('').trim(), truncated };
  }
  const choices = Array.isArray(j.choices) ? (j.choices as Array<Record<string, unknown>>) : [];
  const choice = choices[0];
  const message = (choice?.message ?? {}) as { content?: unknown };
  const content = message.content;
  const text =
    typeof content === 'string'
      ? content.trim()
      : Array.isArray(content)
        ? (content as Array<Record<string, unknown>>)
            .map((b) => (typeof b?.text === 'string' ? b.text : ''))
            .join('')
            .trim()
        : '';
  return { text, truncated: choice?.finish_reason === 'length' };
}

/** 响应里是否带 error(两套协议的 error 形状不一致,统一判空) */
export function responseError(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const j = json as { error?: unknown; type?: string; message?: string };
  if (j.error) {
    if (typeof j.error === 'string') return j.error;
    const m = (j.error as { message?: unknown }).message;
    return typeof m === 'string' ? m : JSON.stringify(j.error).slice(0, 200);
  }
  // responses 出错时可能 status=error + 顶层 message
  if (j.type === 'error' && typeof j.message === 'string') return j.message;
  return undefined;
}
