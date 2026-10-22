/**
 * 主进程一次性 LLM 调用的协议适配(chat/completions ⇄ responses)
 *
 * 背景(2026-10-20):h3.write_prompt / 看图反推 / 自检这三处是**自己 fetch** 的,
 * 此前写死 `/chat/completions`;把 LLM 来源切到只开 `/responses` 的 grok-4.6 后,
 * 对话能跑、这三个功能全 400 `ModelProtocolUnsupported`(实测写提示词连挂 5 次)。
 * 本文件锁 URL、请求体形状与取文本三件事。
 */
import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_UNSUPPORTED_RE,
  extractTextResult,
  protocolOf,
  responseError,
  textCallBody,
  textCallUrl,
  visionCallBody,
} from '../llm-http.js';

describe('textCallUrl', () => {
  it('chat → /chat/completions,responses → /responses(尾斜杠归一化)', () => {
    expect(textCallUrl('https://oc/v1/', 'chat')).toBe('https://oc/v1/chat/completions');
    expect(textCallUrl('https://oc/v1', 'responses')).toBe('https://oc/v1/responses');
  });
});

describe('textCallBody', () => {
  const req = { system: 'SYS', user: 'USER', maxTokens: 8000, temperature: 0.2 };

  it('chat:system 消息 + max_tokens + messages', () => {
    const b = textCallBody({ baseUrl: 'x', model: 'groq', protocol: 'chat' }, req);
    expect(b.model).toBe('groq');
    expect(b.max_tokens).toBe(8000);
    expect(b.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USER' },
    ]);
    expect(b.max_output_tokens).toBeUndefined();
  });

  it('responses:instructions + input + max_output_tokens(没有 messages/max_tokens)', () => {
    const b = textCallBody({ baseUrl: 'x', model: 'grok-4.6', protocol: 'responses' }, req);
    expect(b.instructions).toBe('SYS');
    expect(b.input).toBe('USER');
    expect(b.max_output_tokens).toBe(8000);
    expect(b.messages).toBeUndefined();
    expect(b.max_tokens).toBeUndefined();
  });

  it('工具声明两套形状不同', () => {
    const tools = [{ name: 'ping', description: 'd', parameters: { type: 'object', properties: {} } }];
    const chat = textCallBody({ baseUrl: 'x', model: 'm' }, { user: 'u', tools }) as { tools: Array<Record<string, unknown>> };
    expect(chat.tools[0]).toMatchObject({ type: 'function', function: { name: 'ping' } });
    const resp = textCallBody({ baseUrl: 'x', model: 'm', protocol: 'responses' }, { user: 'u', tools }) as {
      tools: Array<Record<string, unknown>>;
    };
    expect(resp.tools[0]).toEqual({ type: 'function', name: 'ping', description: 'd', parameters: { type: 'object', properties: {} } });
  });
});

describe('visionCallBody', () => {
  it('chat 用 image_url,responses 用 input_image', () => {
    const chat = visionCallBody({ baseUrl: 'x', model: 'm' }, 'data:image/png;base64,AAA', 'describe');
    expect(JSON.stringify(chat)).toContain('image_url');
    expect(chat.max_tokens).toBe(700);
    const resp = visionCallBody({ baseUrl: 'x', model: 'm', protocol: 'responses' }, 'data:image/png;base64,AAA', 'describe');
    expect(JSON.stringify(resp)).toContain('input_image');
    expect(resp.max_output_tokens).toBe(700);
  });
});

describe('extractTextResult', () => {
  it('chat:choices[0].message.content(字符串/数组都兜住)', () => {
    expect(extractTextResult({ choices: [{ message: { content: ' 嗨 ' } }] }, 'chat')).toEqual({ text: '嗨', truncated: false });
    expect(
      extractTextResult({ choices: [{ message: { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] } }] }, 'chat'),
    ).toEqual({ text: 'AB', truncated: false });
  });

  it('chat:finish_reason=length → truncated', () => {
    expect(extractTextResult({ choices: [{ finish_reason: 'length', message: { content: 'x' } }] }, 'chat').truncated).toBe(true);
  });

  it('responses:从 output 的 message item 的 content 取文本', () => {
    const json = {
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', content: [{ type: 'output_text', text: '镜头缓缓推近' }] },
      ],
    };
    expect(extractTextResult(json, 'responses')).toEqual({ text: '镜头缓缓推近', truncated: false });
  });

  it('responses:status=incomplete + max_output_tokens → truncated', () => {
    const json = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] };
    expect(extractTextResult(json, 'responses').truncated).toBe(true);
  });

  it('responses:极少数网关直接给 output_text', () => {
    expect(extractTextResult({ output_text: 'hi' }, 'responses').text).toBe('hi');
  });
});

describe('错误与协议判定', () => {
  it('PROTOCOL_UNSUPPORTED_RE 认 OpenCode Go 原话', () => {
    expect(
      PROTOCOL_UNSUPPORTED_RE.test('{"type":"error","error":{"type":"ModelProtocolUnsupported","message":"Model does not support this protocol."}}'),
    ).toBe(true);
    expect(PROTOCOL_UNSUPPORTED_RE.test('{"message":"invalid temperature: only 1 is allowed"}')).toBe(false);
  });

  it('responseError 两套形状都能取到', () => {
    expect(responseError({ error: { message: 'boom' } })).toBe('boom');
    expect(responseError({ type: 'error', message: 'bad' })).toBe('bad');
    expect(responseError({ choices: [] })).toBeUndefined();
  });

  it('protocolOf 缺省 chat', () => {
    expect(protocolOf({})).toBe('chat');
    expect(protocolOf({ protocol: 'responses' })).toBe('responses');
  });
});
