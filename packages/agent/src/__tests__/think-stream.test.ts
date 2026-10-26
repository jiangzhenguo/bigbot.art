import { describe, expect, it } from 'vitest';
import { ThinkTagStreamParser } from '../think-stream.js';

function collect(parts: Array<{ channel: string; delta: string }>, channel: string) {
  return parts.filter((p) => p.channel === channel).map((p) => p.delta).join('');
}

describe('ThinkTagStreamParser', () => {
  it('普通文本不逐段 trim,空白与换行原样保留', () => {
    const parser = new ThinkTagStreamParser();
    const parts = [...parser.push(' 你'), ...parser.push('好\n'), ...parser.flush()];
    expect(collect(parts, 'text')).toBe(' 你好\n');
    expect(collect(parts, 'thinking')).toBe('');
  });

  it('开闭标签跨多个 delta 也能正确分流', () => {
    const parser = new ThinkTagStreamParser();
    const parts = [
      ...parser.push('前<th'),
      ...parser.push('ink>思考</th'),
      ...parser.push('ink>后'),
      ...parser.flush(),
    ];
    expect(collect(parts, 'text')).toBe('前后');
    expect(collect(parts, 'thinking')).toBe('思考');
  });

  it('未闭合 think 在 flush 时归入思考,与最终 splitThink 一致', () => {
    const parser = new ThinkTagStreamParser();
    const parts = [...parser.push('<think>没有结束'), ...parser.flush()];
    expect(collect(parts, 'text')).toBe('');
    expect(collect(parts, 'thinking')).toBe('没有结束');
  });

  it('末尾小于号若只是普通文本,flush 不会丢字符', () => {
    const parser = new ThinkTagStreamParser();
    const parts = [...parser.push('1 <'), ...parser.flush()];
    expect(collect(parts, 'text')).toBe('1 <');
  });
});
