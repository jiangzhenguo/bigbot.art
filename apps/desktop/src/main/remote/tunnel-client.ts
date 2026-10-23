/**
 * 主进程里的隧道客户端。没有外部二进制。
 * 把中继转来的请求打到 127.0.0.1 上的远程服务,并带上进程内密钥。
 * 公网请求头按白名单复制,调用方无法自己声明“我是隧道”。
 */
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { WebSocket, type RawData } from 'ws';
import {
  CLIENT_IP_HEADER,
  FORWARD_REQUEST_HEADERS,
  FrameDecoder,
  FrameType,
  MAX_PAYLOAD,
  PROTO_HEADER,
  TUNNEL_PATH,
  TUNNEL_SECRET_HEADER,
  encodeFrame,
  encodeWsChunk,
  parseJson,
  safeCloseCode,
  splitPayload,
  type ReqHead,
  type WsClose,
  type WsOpen,
} from '@bigbotart/relay/protocol';

const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 512 * 1024;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade']);
const ALLOW = new Set<string>(FORWARD_REQUEST_HEADERS);

export interface TunnelClientOptions {
  relayUrl: string;
  pairingKey: string;
  localPort: number;
  tunnelSecret: string;
  logger: { log: (level: 'info' | 'warn' | 'error', message: string) => void };
  onStatus: (status: { connected: boolean; error?: string }) => void;
}

interface HttpStream {
  kind: 'http';
  req: ClientRequest;
  res?: IncomingMessage;
  sentHead: boolean;
}

interface WsStream {
  kind: 'ws';
  ws: WebSocket;
  buf: Buffer;
}

type Stream = HttpStream | WsStream;

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export function connectTunnel(opts: TunnelClientOptions): { stop: () => void } {
  const scrub = (message: string) => (opts.pairingKey.length >= 8 ? message.split(opts.pairingKey).join('[redacted]') : message);
  let relay: URL;
  try {
    relay = new URL(opts.relayUrl);
  } catch {
    opts.onStatus({ connected: false, error: '中继地址不是合法的 URL' });
    return { stop() {} };
  }
  if (relay.protocol !== 'https:' && relay.protocol !== 'http:') {
    opts.onStatus({ connected: false, error: '中继地址需要 http 或 https' });
    return { stop() {} };
  }
  if (opts.pairingKey.length < 16) {
    opts.onStatus({ connected: false, error: '配对密钥过短' });
    return { stop() {} };
  }
  // 中继地址可能带公网路径前缀(例如 https://bigbot.art/bba)。
  // 隧道握手走的是同一个前缀 —— 反代按前缀把流量转进来,这里必须原样带上,
  // 只取 host 会把请求打到公网根路径,结果 404。
  const relayBase = relay.pathname.replace(/\/+$/, '');
  const wsUrl = `${relay.protocol === 'https:' ? 'wss:' : 'ws:'}//${relay.host}${relayBase}${TUNNEL_PATH}`;
  const streams = new Map<number, Stream>();
  let stopped = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let socket: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let lastPong = 0;
  let lastError = '';

  const localHeaders = (head: { headers: Record<string, string>; clientIp: string; scheme: 'http' | 'https' }) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(head.headers)) {
      const key = name.toLowerCase();
      if (!ALLOW.has(key) || key === 'host') continue;
      if (key === TUNNEL_SECRET_HEADER || key === CLIENT_IP_HEADER || key === PROTO_HEADER || key === 'x-forwarded-for') continue;
      headers[key] = value;
    }
    if (typeof head.headers.host === 'string' && head.headers.host) headers.host = head.headers.host;
    headers[TUNNEL_SECRET_HEADER] = opts.tunnelSecret;
    headers[PROTO_HEADER] = head.scheme;
    const ip = head.clientIp.replace(/^::ffff:/, '');
    if (isIP(ip)) headers[CLIENT_IP_HEADER] = ip;
    return headers;
  };

  const send = (type: number, id: number, payload: Buffer) => {
    const ws = socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(encodeFrame(type, id, payload), { binary: true }, () => {
      if (!ws || ws.bufferedAmount >= LOW_WATER) return;
      for (const stream of streams.values()) {
        if (stream.kind === 'http') stream.res?.resume();
      }
    });
  };

  const sendJson = (type: number, id: number, value: unknown) => {
    const payload = Buffer.from(JSON.stringify(value));
    if (payload.length > MAX_PAYLOAD) {
      opts.logger.log('warn', '隧道响应头超过帧上限');
      return;
    }
    send(type, id, payload);
  };

  const dropLocal = () => {
    for (const stream of streams.values()) {
      if (stream.kind === 'http') stream.req.destroy();
      else stream.ws.terminate();
    }
    streams.clear();
  };

  const onReqHead = (id: number, payload: Buffer) => {
    const head = parseJson<ReqHead>(payload);
    if (!head || typeof head.path !== 'string' || typeof head.method !== 'string') {
      send(FrameType.abort, id, Buffer.alloc(0));
      return;
    }
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: opts.localPort,
      method: head.method,
      path: head.path.startsWith('/') ? head.path : `/${head.path}`,
      headers: localHeaders(head),
    });
    const stream: HttpStream = { kind: 'http', req, sentHead: false };
    streams.set(id, stream);
    req.on('response', (res) => {
      stream.res = res;
      const headers: Record<string, string> = {};
      const setCookies: string[] = [];
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        const name = res.rawHeaders[i];
        const value = res.rawHeaders[i + 1];
        if (!name || value === undefined) continue;
        const lower = name.toLowerCase();
        if (lower === 'set-cookie') {
          setCookies.push(value);
          continue;
        }
        if (HOP.has(lower)) continue;
        headers[lower] = headers[lower] ? `${headers[lower]}, ${value}` : value;
      }
      sendJson(FrameType.resHead, id, {
        status: res.statusCode ?? 502,
        headers,
        ...(setCookies.length ? { setCookies } : {}),
      });
      stream.sentHead = true;
      res.on('data', (chunk: Buffer) => {
        for (const part of splitPayload(chunk)) send(FrameType.resData, id, Buffer.from(part));
        if (socket && socket.bufferedAmount > HIGH_WATER) res.pause();
      });
      res.on('end', () => {
        send(FrameType.resEnd, id, Buffer.alloc(0));
        streams.delete(id);
      });
    });
    req.on('error', (err) => {
      if (!stream.sentHead) {
        const body = Buffer.from('本机服务不可达');
        sendJson(FrameType.resHead, id, {
          status: 502,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(body.length) },
        });
        send(FrameType.resData, id, body);
      }
      send(FrameType.resEnd, id, Buffer.alloc(0));
      streams.delete(id);
      opts.logger.log('warn', scrub(`隧道转发失败: ${err.message}`));
    });
  };

  const onWsOpen = (id: number, payload: Buffer) => {
    const open = parseJson<WsOpen>(payload);
    if (!open || typeof open.path !== 'string') {
      sendJson(FrameType.wsClose, id, { httpStatus: 400, reason: 'bad open' });
      return;
    }
    const local = new WebSocket(`ws://127.0.0.1:${opts.localPort}${open.path.startsWith('/') ? open.path : `/${open.path}`}`, {
      headers: localHeaders(open),
    });
    const stream: WsStream = { kind: 'ws', ws: local, buf: Buffer.alloc(0) };
    streams.set(id, stream);
    local.on('open', () => sendJson(FrameType.wsReady, id, {}));
    local.on('unexpected-response', (_req, res) => {
      res.resume();
      if (!streams.has(id)) return;
      streams.delete(id);
      sendJson(FrameType.wsClose, id, { httpStatus: res.statusCode || 401, reason: 'local rejected' });
      local.terminate();
    });
    local.on('message', (data, isBinary) => {
      const buf = toBuffer(data);
      const parts = splitPayload(buf, MAX_PAYLOAD - 1);
      if (parts.length === 0) {
        send(FrameType.wsData, id, encodeWsChunk(isBinary, true, Buffer.alloc(0)));
        return;
      }
      parts.forEach((part, index) => {
        send(FrameType.wsData, id, encodeWsChunk(isBinary, index === parts.length - 1, Buffer.from(part)));
      });
    });
    local.on('close', (code, reason) => {
      if (!streams.has(id)) return;
      streams.delete(id);
      sendJson(FrameType.wsClose, id, { code, reason: reason.toString() });
    });
    local.on('error', (err) => {
      opts.logger.log('warn', scrub(`隧道 WebSocket 转发失败: ${err.message}`));
    });
  };

  const onWsData = (id: number, payload: Buffer) => {
    const stream = streams.get(id);
    if (!stream || stream.kind !== 'ws' || payload.length < 1) return;
    const flag = payload[0] ?? 0;
    const data = payload.subarray(1);
    stream.buf = stream.buf.length === 0 ? Buffer.from(data) : Buffer.concat([stream.buf, data]);
    if ((flag & 2) === 0) return;
    const message = stream.buf;
    stream.buf = Buffer.alloc(0);
    if (stream.ws.readyState === WebSocket.OPEN) stream.ws.send(message, { binary: (flag & 1) === 1 });
  };

  const dispatch = (type: number, id: number, payload: Buffer) => {
    if (type === FrameType.ping) {
      send(FrameType.pong, id, payload.subarray(0, MAX_PAYLOAD));
      return;
    }
    if (type === FrameType.pong) {
      lastPong = Date.now();
      return;
    }
    if (type === FrameType.reqHead) {
      onReqHead(id, payload);
      return;
    }
    if (type === FrameType.reqData) {
      const stream = streams.get(id);
      if (stream?.kind === 'http') stream.req.write(payload);
      return;
    }
    if (type === FrameType.reqEnd) {
      const stream = streams.get(id);
      if (stream?.kind === 'http') stream.req.end();
      return;
    }
    if (type === FrameType.abort) {
      const stream = streams.get(id);
      streams.delete(id);
      if (!stream) return;
      if (stream.kind === 'http') stream.req.destroy();
      else stream.ws.terminate();
      return;
    }
    if (type === FrameType.wsOpen) {
      onWsOpen(id, payload);
      return;
    }
    if (type === FrameType.wsData) {
      onWsData(id, payload);
      return;
    }
    if (type === FrameType.wsClose) {
      const stream = streams.get(id);
      if (!stream || stream.kind !== 'ws') return;
      streams.delete(id);
      const info = parseJson<WsClose>(payload);
      // 码要先规整:异常断开(1006)是保留码,直接 close 会抛 TypeError
      stream.ws.close(safeCloseCode(info?.code), info?.reason ?? '');
    }
  };

  const armRetry = () => {
    if (stopped || retryTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      openSocket();
    }, delay);
  };

  const openSocket = () => {
    if (stopped) return;
    const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${opts.pairingKey}` } });
    socket = ws;
    const decoder = new FrameDecoder();
    ws.on('open', () => {
      attempt = 0;
      lastError = '';
      lastPong = Date.now();
      opts.onStatus({ connected: true });
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (Date.now() - lastPong > 50_000) {
          ws.terminate();
          return;
        }
        send(FrameType.ping, 0, Buffer.alloc(0));
      }, 20_000);
    });
    ws.on('message', (data) => {
      let frames;
      try {
        frames = decoder.push(toBuffer(data));
      } catch (e) {
        opts.logger.log('warn', scrub(`隧道帧无效: ${(e as Error).message}`));
        ws.terminate();
        return;
      }
      for (const frame of frames) dispatch(frame.type, frame.streamId, frame.payload);
    });
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      lastError = res.statusCode === 401 ? '配对密钥被拒绝' : res.statusCode === 429 ? '配对失败次数过多,稍后重试' : `中继拒绝连接 ${res.statusCode ?? ''}`.trim();
    });
    ws.on('error', (err) => {
      opts.logger.log('warn', scrub(`中继连接失败: ${err.message}`));
    });
    ws.on('close', () => {
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = undefined;
      if (socket !== ws) return;
      socket = null;
      dropLocal();
      if (stopped) return;
      opts.onStatus({ connected: false, error: lastError || '中继连接已断开,正在重连' });
      armRetry();
    });
  };

  openSocket();

  return {
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      if (pingTimer) clearInterval(pingTimer);
      const ws = socket;
      socket = null;
      dropLocal();
      ws?.terminate();
    },
  };
}
