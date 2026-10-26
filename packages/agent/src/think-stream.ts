/**
 * 把文本块里的 <think>…</think> 增量拆成正文/思考两路。
 *
 * 标签可能横跨任意 token 边界(例如 "<th" + "ink>"),所以不能对每个 delta
 * 单独 replace。每个 contentIndex 使用一个解析器,流结束或 text_end 时 flush。
 */
export type ThinkStreamChannel = 'text' | 'thinking';
export interface ThinkStreamDelta {
  channel: ThinkStreamChannel;
  delta: string;
}

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

/** 末尾有多少字符可能是标签的开头;这些字符必须留到下一个 delta 再判定。 */
function partialTagSuffixLength(value: string, tag: string): number {
  const max = Math.min(tag.length - 1, value.length);
  for (let len = max; len > 0; len--) {
    if (tag.startsWith(value.slice(-len))) return len;
  }
  return 0;
}

export class ThinkTagStreamParser {
  private channel: ThinkStreamChannel = 'text';
  private buffer = '';

  push(chunk: string): ThinkStreamDelta[] {
    if (!chunk) return [];
    this.buffer += chunk;
    const out: ThinkStreamDelta[] = [];

    while (this.buffer) {
      const tag = this.channel === 'text' ? OPEN_TAG : CLOSE_TAG;
      const tagIndex = this.buffer.indexOf(tag);
      if (tagIndex >= 0) {
        const before = this.buffer.slice(0, tagIndex);
        if (before) out.push({ channel: this.channel, delta: before });
        this.buffer = this.buffer.slice(tagIndex + tag.length);
        this.channel = this.channel === 'text' ? 'thinking' : 'text';
        continue;
      }

      const hold = partialTagSuffixLength(this.buffer, tag);
      const emitLength = this.buffer.length - hold;
      if (emitLength > 0) out.push({ channel: this.channel, delta: this.buffer.slice(0, emitLength) });
      this.buffer = hold > 0 ? this.buffer.slice(-hold) : '';
      break;
    }
    return out;
  }

  /** 未闭合的 <think> 与最终响应 splitThink 同口径:余下内容全部归为思考。 */
  flush(): ThinkStreamDelta[] {
    if (!this.buffer) return [];
    const out = [{ channel: this.channel, delta: this.buffer }];
    this.buffer = '';
    return out;
  }
}
