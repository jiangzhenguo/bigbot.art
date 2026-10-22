import { describe, expect, it } from 'vitest';
import {
  BIGBOTART_USER_AGENT,
  isOpenCodeGoUrl,
  openCodeGoHeaders,
  withOpenCodeGoHeaders,
} from '../opencode-go.js';

describe('isOpenCodeGoUrl', () => {
  it('认 zen/go 端点', () => {
    expect(isOpenCodeGoUrl('https://opencode.ai/zen/go/v1')).toBe(true);
    expect(isOpenCodeGoUrl('https://opencode.ai/zen/go/v1/')).toBe(true);
  });

  it('不误伤其他端点', () => {
    expect(isOpenCodeGoUrl('https://api.deepseek.com/v1')).toBe(false);
    expect(isOpenCodeGoUrl('https://opencode.ai/inference/openai/v1')).toBe(false);
    expect(isOpenCodeGoUrl(undefined)).toBe(false);
  });
});

describe('withOpenCodeGoHeaders', () => {
  it('Go 端点补上 x-opencode-session 与 User-Agent', () => {
    const h = withOpenCodeGoHeaders('https://opencode.ai/zen/go/v1', 'canvas-abc', {
      Authorization: 'Bearer sk-x',
    });
    expect(h['x-opencode-session']).toBe('canvas-abc');
    expect(h['User-Agent']).toBe(BIGBOTART_USER_AGENT);
    expect(h.Authorization).toBe('Bearer sk-x');
  });

  it('非 Go 端点不改 headers', () => {
    const base = { Authorization: 'Bearer sk-x' };
    expect(withOpenCodeGoHeaders('https://api.deepseek.com/v1', 'c1', base)).toEqual(base);
  });

  it('openCodeGoHeaders 字段齐全', () => {
    expect(openCodeGoHeaders('s1')).toEqual({
      'User-Agent': BIGBOTART_USER_AGENT,
      'x-opencode-session': 's1',
    });
  });
});
