import { describe, expect, it } from 'vitest';
import { resolveLlmEndpoint, toChatLlm } from '../llm.js';

describe('Cursor CLI LLM 来源', () => {
  it('保留 cursor-cli 后端和模型，不转换成 HTTP 端点', async () => {
    const resolved = await resolveLlmEndpoint({} as never, { kind: 'cursor-cli', model: 'composer-2.5' });
    expect(resolved).toEqual({
      baseUrl: 'cursor-cli://local',
      model: 'composer-2.5',
      label: 'Cursor CLI(cursor-agent)',
      protocol: 'chat',
      backend: 'cursor-cli',
    });
    expect(toChatLlm(resolved)).toEqual({ kind: 'cursor-cli', model: 'composer-2.5' });
  });

  it('模型留空时使用 Cursor 默认模型，且不需要凭据', async () => {
    const resolved = await resolveLlmEndpoint({} as never, { kind: 'cursor-cli' });
    expect(toChatLlm(resolved)).toEqual({ kind: 'cursor-cli', model: undefined });
  });
});
