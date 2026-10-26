import { describe, expect, it } from 'vitest';
import { isAccelPickSource } from '../accel-source.js';

describe('accel-pick-source 入参白名单', () => {
  it('只接受 directory / lora', () => {
    expect(isAccelPickSource('directory')).toBe(true);
    expect(isAccelPickSource('lora')).toBe(true);
  });

  it('非法字符串、空值与非字符串都拒绝', () => {
    for (const value of ['', 'file', 'DIRECTORY', null, undefined, 0, {}]) {
      expect(isAccelPickSource(value)).toBe(false);
    }
  });
});
