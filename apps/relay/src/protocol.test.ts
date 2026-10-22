import { describe, expect, it } from 'vitest';
import {
  FrameDecoder,
  FrameType,
  MAX_PAYLOAD,
  encodeFrame,
  encodeJson,
  encodeWsChunk,
  keysEqual,
  splitPayload,
} from './protocol.js';

describe('隧道帧', () => {
  it('往返,并在半包拼接后解出', () => {
    const frame = encodeJson(FrameType.reqHead, 7, { method: 'GET', path: '/a?b=1' });
    const dec = new FrameDecoder();
    expect(dec.push(frame.subarray(0, 3))).toEqual([]);
    expect(dec.push(frame.subarray(3, 8))).toEqual([]);
    const rest = dec.push(frame.subarray(8));
    expect(rest).toHaveLength(1);
    expect(rest[0]?.type).toBe(FrameType.reqHead);
    expect(rest[0]?.streamId).toBe(7);
    expect(JSON.parse(rest[0]!.payload.toString())).toEqual({ method: 'GET', path: '/a?b=1' });
  });

  it('一块缓冲里的两帧按顺序解出', () => {
    const a = encodeFrame(FrameType.ping, 0, Buffer.from('a'));
    const b = encodeFrame(FrameType.pong, 0, Buffer.from('b'));
    const frames = new FrameDecoder().push(Buffer.concat([a, b]));
    expect(frames.map((f) => f.type)).toEqual([FrameType.ping, FrameType.pong]);
    expect(frames.map((f) => f.payload.toString())).toEqual(['a', 'b']);
  });

  it('拒绝过短、超长和声明超限的长度', () => {
    expect(() => encodeFrame(1, 1, Buffer.alloc(MAX_PAYLOAD + 1))).toThrow(/上限/);
    const dec = new FrameDecoder();
    const tiny = Buffer.alloc(4);
    tiny.writeUInt32BE(4, 0);
    expect(() => dec.push(tiny)).toThrow(/非法帧长度/);
    const huge = Buffer.alloc(4);
    huge.writeUInt32BE(5 + MAX_PAYLOAD + 1, 0);
    expect(() => new FrameDecoder().push(huge)).toThrow(/非法帧长度/);
  });

  it('载荷按上限切开,WebSocket 块带结束位', () => {
    const parts = splitPayload(Buffer.alloc(MAX_PAYLOAD + 10), MAX_PAYLOAD);
    expect(parts.map((p) => p.length)).toEqual([MAX_PAYLOAD, 10]);
    const chunk = encodeWsChunk(true, true, Buffer.from('xyz'));
    expect(chunk[0]).toBe(3);
    expect(chunk.subarray(1).toString()).toBe('xyz');
  });

  it('密钥比较不因长度不同而跳过哈希', () => {
    expect(keysEqual('same-key-same-key', 'same-key-same-key')).toBe(true);
    expect(keysEqual('same-key-same-key', 'same-key-same-keY')).toBe(false);
    expect(keysEqual('short', 'much-longer-secret')).toBe(false);
  });
});
