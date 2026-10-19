import { describe, it, expect } from 'vitest';
import { composerPrimaryAction } from '../composer-action';

describe('composerPrimaryAction', () => {
  it('空闲时只有发送', () => {
    expect(composerPrimaryAction(false, false)).toEqual({ label: '发送', kind: 'send', glyph: 'arrow' });
    expect(composerPrimaryAction(false, true)).toEqual({ label: '发送', kind: 'send', glyph: 'arrow' });
  });

  it('执行中没写新内容时是打断', () => {
    expect(composerPrimaryAction(true, false)).toEqual({ label: '打断并改画布', kind: 'interrupt', glyph: 'stop' });
  });

  it('执行中已经写了新指令时,一次点击打断并发送', () => {
    expect(composerPrimaryAction(true, true)).toEqual({ label: '打断并发送', kind: 'interrupt-send', glyph: 'arrow' });
  });
});
