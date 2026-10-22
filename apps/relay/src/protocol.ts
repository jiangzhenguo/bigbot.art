/**
 * 桌面与中继之间的隧道帧。两边共用这一份,避免各写一套。
 *
 * 布局:uint32be 长度(不含这 4 字节)| uint8 类型 | uint32be 流 id | 载荷。
 * 长度至少 5,至多 5 + MAX_PAYLOAD。超长或残缺都交给解码器拒绝。
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const TUNNEL_PATH = '/bba-tunnel';
export const MAX_PAYLOAD = 256 * 1024;
export const BODY_LIMIT = 32 * 1024 * 1024;
export const TUNNEL_SECRET_HEADER = 'x-bba-tunnel-secret';
export const CLIENT_IP_HEADER = 'x-bba-client-ip';
export const PROTO_HEADER = 'x-forwarded-proto';

/** 公网请求里允许穿过隧道的头。密钥、转发头一律不在此列。 */
export const FORWARD_REQUEST_HEADERS = [
  'cookie',
  'origin',
  'content-type',
  'accept',
  'accept-language',
  'range',
  'if-none-match',
  'if-modified-since',
  'cache-control',
  'host',
] as const;

export const FrameType = {
  reqHead: 1,
  reqData: 2,
  reqEnd: 3,
  resHead: 4,
  resData: 5,
  resEnd: 6,
  wsOpen: 7,
  wsReady: 8,
  wsData: 9,
  wsClose: 10,
  ping: 11,
  pong: 12,
  abort: 13,
} as const;

export type FrameTypeId = (typeof FrameType)[keyof typeof FrameType];

export interface TunnelFrame {
  type: number;
  streamId: number;
  payload: Buffer;
}

export interface ReqHead {
  method: string;
  /** 含 query 的原始路径 */
  path: string;
  headers: Record<string, string>;
  clientIp: string;
  scheme: 'http' | 'https';
}

export interface ResHead {
  status: number;
  headers: Record<string, string>;
  setCookies?: string[];
}

export interface WsOpen {
  path: string;
  headers: Record<string, string>;
  clientIp: string;
  scheme: 'http' | 'https';
}

export interface WsClose {
  code?: number;
  reason?: string;
  /** 本地还没升级成功时,中继用这个状态码回给浏览器 */
  httpStatus?: number;
}

const HEADER_LEN = 4;
const PREFIX_LEN = 5;

export function encodeFrame(type: number, streamId: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length > MAX_PAYLOAD) throw new Error('帧载荷超过上限');
  const length = PREFIX_LEN + payload.length;
  const buf = Buffer.allocUnsafe(HEADER_LEN + length);
  buf.writeUInt32BE(length, 0);
  buf.writeUInt8(type, 4);
  buf.writeUInt32BE(streamId >>> 0, 5);
  payload.copy(buf, 9);
  return buf;
}

export function encodeJson(type: number, streamId: number, value: unknown): Buffer {
  return encodeFrame(type, streamId, Buffer.from(JSON.stringify(value)));
}

/** WebSocket 消息:首字节 bit0=二进制,bit1=本消息最后一块。 */
export function encodeWsChunk(isBinary: boolean, fin: boolean, data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(1 + data.length);
  out[0] = (isBinary ? 1 : 0) | (fin ? 2 : 0);
  data.copy(out, 1);
  return out;
}

export function splitPayload(buf: Buffer, max = MAX_PAYLOAD): Buffer[] {
  if (buf.length === 0) return [];
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length; i += max) out.push(buf.subarray(i, Math.min(i + max, buf.length)));
  return out;
}

export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): TunnelFrame[] {
    const incoming = Buffer.from(chunk);
    this.buf = this.buf.length === 0 ? incoming : Buffer.concat([this.buf, incoming]);
    const out: TunnelFrame[] = [];
    while (this.buf.length >= HEADER_LEN) {
      const length = this.buf.readUInt32BE(0);
      if (length < PREFIX_LEN || length > PREFIX_LEN + MAX_PAYLOAD) {
        this.buf = Buffer.alloc(0);
        throw new Error('非法帧长度');
      }
      if (this.buf.length < HEADER_LEN + length) break;
      const type = this.buf.readUInt8(4);
      const streamId = this.buf.readUInt32BE(5);
      const payload = Buffer.from(this.buf.subarray(9, HEADER_LEN + length));
      this.buf = Buffer.from(this.buf.subarray(HEADER_LEN + length));
      out.push({ type, streamId, payload });
    }
    return out;
  }
}

/** 先哈希再比较,长度不同也不会提前返回。 */
export function keysEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

export function parseJson<T>(payload: Buffer): T | null {
  try {
    return JSON.parse(payload.toString('utf8')) as T;
  } catch {
    return null;
  }
}
