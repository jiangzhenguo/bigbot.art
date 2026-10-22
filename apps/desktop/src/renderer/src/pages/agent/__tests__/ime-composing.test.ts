import { describe, expect, it } from 'vitest';
import { isImeComposingKey } from '../ime-composing';

describe('isImeComposingKey', () => {
  it('组词中 isComposing=true → 视为 IME', () => {
    expect(isImeComposingKey({ nativeEvent: { isComposing: true }, keyCode: 13 })).toBe(true);
  });

  it('组词期 keyCode 229 → 视为 IME(兼容 Chromium/Electron)', () => {
    expect(isImeComposingKey({ nativeEvent: { isComposing: false }, keyCode: 229 })).toBe(true);
  });

  it('普通回车 → 不是 IME', () => {
    expect(isImeComposingKey({ nativeEvent: { isComposing: false }, keyCode: 13 })).toBe(false);
  });

  it('缺省字段按非 IME', () => {
    expect(isImeComposingKey({ nativeEvent: {} })).toBe(false);
  });
});
