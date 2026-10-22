/**
 * 公网 HTTPS(或测试用 HTTP)反向隧道。
 *
 * 只接受一条已通过配对密钥的 WSS。浏览器的 HTTP 与 WebSocket 在这条连接上分帧转发。
 * 隧道不在时返回明确的 503。日志不包含请求体、cookie 或配对密钥。
 */
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { BODY_LIMIT, CLIENT_IP_HEADER, FORWARD_REQUEST_HEADERS, FrameType, MAX_PAYLOAD, PROTO_HEADER, TUNNEL_PATH, TUNNEL_SECRET_HEADER, encodeFrame, encodeWsChunk, FrameDecoder, keysEqual, parseJson, splitPayload, type ReqHead, type ResHead, type TunnelFrame, type WsClose, type WsOpen } from './protocol.js';
import { FailWindow, PAIRING_MAX_FAILS, redact } from './auth.js';
import { LETSENCRYPT_PRODUCTION, loadCertFiles, needsRenewal, obtainCertificate, readStoredCert, type CertMaterial } from './acme.js';

export const DOWN_PAGE =
  '<!doctype html><meta charset="utf-8"><title>BigBotArt</title><p>隧道还没连上。请在 Mac 上打开 BigBotArt,并在设置里开启中继。</p>';

const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 512 * 1024;
const WS_READY_MS = 8_000;
const PING_MS = 20_000;
const PONG_DEAD_MS = 50_000;
const RENEW_EVERY_MS = 12 * 60 * 60 * 1000;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade']);

export interface RelayLogger {
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface RelayOptions {
  pairingKey: string;
  mode: 'http' | 'https';
  listenHost?: string;
  /** http 模式的监听端口,0 为临时端口 */
  httpPort?: number;
  httpsPort?: number;
  /** ACME HTTP-01 端口。https 模式默认 80 */
  challengePort?: number;
  domain?: string;
  email?: string;
  certPath?: string;
  keyPath?: string;
  dataDir?: string;
  acmeDirectory?: string;
  logger?: RelayLogger;
}

export interface RelayHandle {
  url: string;
  tunnelUrl: string;
  port: number;
  close: () => Promise<void>;
  putChallenge: (token: string, keyAuthorization: string) => void;
  connected: () => boolean;
}

interface HttpStream {
  kind: 'http';
  req: IncomingMessage;
  res: ServerResponse;
  bytes: number;
  alive: boolean;
  headed: boolean;
  ended: boolean;
  blocked: boolean;
  queue: Buffer[];
  queued: number;
}

interface WsStream {
  kind: 'ws';
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  pub: WebSocket | null;
  ready: boolean;
  timer: ReturnType<typeof setTimeout>;
  buf: Buffer;
}

type Stream = HttpStream | WsStream;

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function clientIp(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
}

function pickHeaders(req: IncomingMessage): Record<string, string> {
  const allow = new Set<string>(FORWARD_REQUEST_HEADERS);
  const out: Record<string, string> = {};
  for (const name of allow) {
    if (name === 'host') continue;
    const value = req.headers[name];
    if (typeof value === 'string' && value) out[name] = value;
    else if (Array.isArray(value) && value[0]) out[name] = value.join(', ');
  }
  if (typeof req.headers.host === 'string') out.host = req.headers.host;
  delete out[TUNNEL_SECRET_HEADER];
  delete out[CLIENT_IP_HEADER];
  delete out[PROTO_HEADER];
  return out;
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  const reason = status === 401 ? 'Unauthorized' : status === 429 ? 'Too Many Requests' : status === 503 ? 'Service Unavailable' : status === 504 ? 'Gateway Timeout' : 'Error';
  const len = Buffer.byteLength(text);
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${len}\r\nConnection: close\r\n\r\n${text}`);
  socket.destroy();
}

function listen(server: HttpServer | HttpsServer, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onErr = (err: Error) => {
      server.off('listening', onOk);
      reject(err);
    };
    const onOk = () => {
      server.off('error', onErr);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, host);
  });
}

function closeServer(server: HttpServer | HttpsServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export async function startRelay(opts: RelayOptions): Promise<RelayHandle> {
  if (opts.pairingKey.length < 16) throw new Error('配对密钥过短');
  const listenHost = opts.listenHost ?? (opts.mode === 'http' ? '127.0.0.1' : '0.0.0.0');
  const log = (level: 'info' | 'warn' | 'error', message: string) => {
    opts.logger?.log(level, redact(message, [opts.pairingKey]));
  };
  const challenges = new Map<string, string>();
  const fails = new FailWindow();
  const wss = new WebSocketServer({ noServer: true });
  const streams = new Map<number, Stream>();
  const servers: Array<HttpServer | HttpsServer> = [];
  let tunnel: WebSocket | null = null;
  let seq = 0;
  let notePong = () => {};
  let stopped = false;

  const nextId = () => {
    seq = (seq + 1) >>> 0;
    if (seq === 0) seq = 1;
    return seq;
  };

  const send = (type: number, id: number, payload: Buffer) => {
    const ws = tunnel;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(encodeFrame(type, id, payload), { binary: true }, () => {
      if (ws.bufferedAmount >= LOW_WATER) return;
      for (const stream of streams.values()) {
        if (stream.kind === 'http') stream.req.resume();
      }
    });
  };

  const dropStreams = () => {
    for (const [id, stream] of streams) {
      streams.delete(id);
      if (stream.kind === 'http') {
        stream.alive = false;
        if (!stream.res.headersSent) {
          stream.res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          stream.res.end('隧道已断开');
        } else stream.res.destroy();
      } else {
        clearTimeout(stream.timer);
        if (stream.pub) stream.pub.close(1011, 'tunnel closed');
        else stream.socket.destroy();
      }
    }
  };

  const abortHttp = (id: number, stream: HttpStream, status: number, text: string) => {
    stream.alive = false;
    streams.delete(id);
    send(FrameType.abort, id, Buffer.alloc(0));
    if (!stream.res.headersSent) {
      stream.res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      stream.res.end(text);
    } else stream.res.destroy();
  };

  const writeBody = (stream: HttpStream, part: Buffer) => {
    stream.blocked = stream.res.write(part) === false;
  };

  const flush = (id: number, stream: HttpStream) => {
    while (stream.alive && stream.headed && !stream.blocked && stream.queue.length > 0) {
      const part = stream.queue.shift();
      if (!part) break;
      stream.queued -= part.length;
      writeBody(stream, part);
    }
    if (stream.alive && stream.ended && stream.headed && !stream.blocked && stream.queue.length === 0) {
      stream.alive = false;
      streams.delete(id);
      stream.res.end();
    }
  };

  const onResHead = (id: number, payload: Buffer) => {
    const stream = streams.get(id);
    if (!stream || stream.kind !== 'http' || !stream.alive) return;
    const head = parseJson<ResHead>(payload);
    if (!head || typeof head.status !== 'number') {
      abortHttp(id, stream, 502, '上游响应无效');
      return;
    }
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [name, value] of Object.entries(head.headers ?? {})) {
      if (HOP.has(name.toLowerCase())) continue;
      headers[name] = value;
    }
    if (head.setCookies && head.setCookies.length > 0) headers['set-cookie'] = head.setCookies;
    stream.res.writeHead(head.status, headers);
    stream.headed = true;
    stream.res.on('drain', () => {
      stream.blocked = false;
      flush(id, stream);
    });
    flush(id, stream);
  };

  const onResData = (id: number, payload: Buffer) => {
    const stream = streams.get(id);
    if (!stream || stream.kind !== 'http' || !stream.alive) return;
    if (!stream.headed || stream.blocked || stream.queue.length > 0) {
      stream.queue.push(payload);
      stream.queued += payload.length;
      if (stream.queued > 8 * 1024 * 1024) abortHttp(id, stream, 502, '下游读取过慢');
      return;
    }
    writeBody(stream, payload);
  };

  const onResEnd = (id: number) => {
    const stream = streams.get(id);
    if (!stream || stream.kind !== 'http' || !stream.alive) return;
    stream.ended = true;
    flush(id, stream);
  };

  const onWsReady = (id: number) => {
    const stream = streams.get(id);
    if (!stream || stream.kind !== 'ws' || stream.ready) return;
    clearTimeout(stream.timer);
    stream.ready = true;
    wss.handleUpgrade(stream.req, stream.socket, stream.head, (pub) => {
      stream.pub = pub;
      pub.on('message', (data, isBinary) => {
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
      pub.on('close', (code, reason) => {
        send(FrameType.wsClose, id, Buffer.from(JSON.stringify({ code, reason: reason.toString() } satisfies WsClose)));
        streams.delete(id);
      });
      pub.on('error', (err) => {
        log('warn', `浏览器 WebSocket 错误: ${err.message}`);
        pub.terminate();
      });
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
    if (stream.pub && stream.pub.readyState === WebSocket.OPEN) stream.pub.send(message, { binary: (flag & 1) === 1 });
  };

  const onWsClose = (id: number, payload: Buffer) => {
    const stream = streams.get(id);
    if (!stream || stream.kind !== 'ws') return;
    clearTimeout(stream.timer);
    streams.delete(id);
    const info = parseJson<WsClose>(payload) ?? {};
    if (!stream.ready || !stream.pub) {
      if (!stream.socket.destroyed) rejectUpgrade(stream.socket, info.httpStatus ?? 401, '未授权');
      return;
    }
    stream.pub.close(info.code && info.code >= 1000 ? info.code : 1000, info.reason ?? '');
  };

  const dispatch = (frame: TunnelFrame) => {
    if (frame.type === FrameType.ping) {
      send(FrameType.pong, frame.streamId, frame.payload.subarray(0, MAX_PAYLOAD));
      return;
    }
    if (frame.type === FrameType.pong) {
      notePong();
      return;
    }
    if (frame.type === FrameType.resHead) onResHead(frame.streamId, frame.payload);
    else if (frame.type === FrameType.resData) onResData(frame.streamId, frame.payload);
    else if (frame.type === FrameType.resEnd) onResEnd(frame.streamId);
    else if (frame.type === FrameType.wsReady) onWsReady(frame.streamId);
    else if (frame.type === FrameType.wsData) onWsData(frame.streamId, frame.payload);
    else if (frame.type === FrameType.wsClose) onWsClose(frame.streamId, frame.payload);
    else if (frame.type === FrameType.abort) {
      const stream = streams.get(frame.streamId);
      if (!stream) return;
      streams.delete(frame.streamId);
      if (stream.kind === 'http') {
        stream.alive = false;
        if (!stream.res.headersSent) {
          stream.res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          stream.res.end('上游中断');
        } else stream.res.destroy();
      } else {
        clearTimeout(stream.timer);
        if (stream.pub) stream.pub.close(1011, 'aborted');
        else if (!stream.socket.destroyed) rejectUpgrade(stream.socket, 502, '上游中断');
      }
    }
  };

  const adopt = (ws: WebSocket, ip: string) => {
    const prev = tunnel;
    tunnel = ws;
    if (prev && prev !== ws) {
      prev.removeAllListeners();
      prev.terminate();
    }
    dropStreams();
    const decoder = new FrameDecoder();
    let lastPong = Date.now();
    notePong = () => {
      lastPong = Date.now();
    };
    const pingTimer = setInterval(() => {
      if (Date.now() - lastPong > PONG_DEAD_MS) {
        log('warn', '隧道心跳超时');
        ws.terminate();
        return;
      }
      send(FrameType.ping, 0, Buffer.alloc(0));
    }, PING_MS);
    ws.on('message', (data) => {
      let frames: TunnelFrame[];
      try {
        frames = decoder.push(toBuffer(data));
      } catch (e) {
        log('warn', `隧道帧无效: ${(e as Error).message}`);
        ws.terminate();
        return;
      }
      for (const frame of frames) dispatch(frame);
    });
    ws.on('close', () => {
      clearInterval(pingTimer);
      if (tunnel !== ws) return;
      tunnel = null;
      notePong = () => {};
      dropStreams();
      log('info', `隧道断开 ${ip}`);
    });
    ws.on('error', (err) => {
      log('warn', `隧道错误: ${err.message}`);
    });
    log('info', `隧道已连接 ${ip}`);
  };

  const acceptTunnel = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const ip = clientIp(req) || 'unknown';
    if (fails.isLocked(ip)) {
      log('warn', `隧道认证已锁定 ${ip}(15 分钟内失败达到 ${PAIRING_MAX_FAILS} 次)`);
      rejectUpgrade(socket, 429, '认证失败次数过多');
      return;
    }
    const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const match = /^Bearer\s+(\S+)\s*$/.exec(header);
    const presented = match?.[1] ?? '';
    if (!keysEqual(presented, opts.pairingKey)) {
      const count = fails.fail(ip);
      log('warn', `隧道认证失败 ${ip} · 第 ${count} 次`);
      rejectUpgrade(socket, 401, '配对密钥不正确');
      return;
    }
    fails.succeed(ip);
    wss.handleUpgrade(req, socket, head, (ws) => adopt(ws, ip));
  };

  const openHttp = (req: IncomingMessage, res: ServerResponse, scheme: 'http' | 'https') => {
    if (!tunnel || tunnel.readyState !== WebSocket.OPEN) {
      req.resume();
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(DOWN_PAGE);
      return;
    }
    const id = nextId();
    const head: ReqHead = {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: pickHeaders(req),
      clientIp: clientIp(req),
      scheme,
    };
    const payload = Buffer.from(JSON.stringify(head));
    if (payload.length > MAX_PAYLOAD) {
      res.writeHead(431, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('请求头过大');
      return;
    }
    const stream: HttpStream = {
      kind: 'http',
      req,
      res,
      bytes: 0,
      alive: true,
      headed: false,
      ended: false,
      blocked: false,
      queue: [],
      queued: 0,
    };
    streams.set(id, stream);
    send(FrameType.reqHead, id, payload);
    req.on('data', (chunk: Buffer) => {
      if (!stream.alive) return;
      stream.bytes += chunk.length;
      if (stream.bytes > BODY_LIMIT) {
        abortHttp(id, stream, 413, '请求体超过 32MB');
        return;
      }
      for (const part of splitPayload(chunk)) send(FrameType.reqData, id, Buffer.from(part));
      if (tunnel && tunnel.bufferedAmount > HIGH_WATER) req.pause();
    });
    req.on('end', () => {
      if (stream.alive) send(FrameType.reqEnd, id, Buffer.alloc(0));
    });
    req.on('close', () => {
      if (!stream.alive || req.complete) return;
      stream.alive = false;
      streams.delete(id);
      send(FrameType.abort, id, Buffer.alloc(0));
    });
    res.on('close', () => {
      if (!stream.alive || res.writableEnded) return;
      stream.alive = false;
      streams.delete(id);
      send(FrameType.abort, id, Buffer.alloc(0));
    });
  };

  const openPublicWs = (req: IncomingMessage, socket: Duplex, head: Buffer, scheme: 'http' | 'https') => {
    if (!tunnel || tunnel.readyState !== WebSocket.OPEN) {
      rejectUpgrade(socket, 503, '隧道还没连上');
      return;
    }
    const id = nextId();
    const timer = setTimeout(() => {
      const cur = streams.get(id);
      if (!cur || cur.kind !== 'ws' || cur.ready) return;
      streams.delete(id);
      send(FrameType.abort, id, Buffer.alloc(0));
      if (!socket.destroyed) rejectUpgrade(socket, 504, '隧道超时');
    }, WS_READY_MS);
    const open: WsOpen = { path: req.url ?? '/', headers: pickHeaders(req), clientIp: clientIp(req), scheme };
    streams.set(id, { kind: 'ws', req, socket, head, pub: null, ready: false, timer, buf: Buffer.alloc(0) });
    send(FrameType.wsOpen, id, Buffer.from(JSON.stringify(open)));
  };

  const serveChallenge = (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || !url.pathname.startsWith('/.well-known/acme-challenge/')) return false;
    const token = decodeURIComponent(url.pathname.slice('/.well-known/acme-challenge/'.length));
    const body = challenges.get(token);
    if (!body) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return true;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
    return true;
  };

  const onRequest = (req: IncomingMessage, res: ServerResponse, scheme: 'http' | 'https') => {
    try {
      if (serveChallenge(req, res)) return;
      if (req.method === 'CONNECT') {
        res.writeHead(405, { allow: 'GET, POST, HEAD' });
        res.end();
        return;
      }
      openHttp(req, res, scheme);
    } catch (e) {
      log('error', `中继请求失败: ${(e as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('中继内部错误');
      }
    }
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, scheme: 'http' | 'https') => {
    let path = '/';
    try {
      path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      rejectUpgrade(socket, 400, '路径无效');
      return;
    }
    if (path === TUNNEL_PATH) {
      acceptTunnel(req, socket, head);
      return;
    }
    openPublicWs(req, socket, head, scheme);
  };

  const attach = (server: HttpServer | HttpsServer, scheme: 'http' | 'https') => {
    server.on('request', (req, res) => onRequest(req, res, scheme));
    server.on('upgrade', (req, socket, head) => onUpgrade(req, socket, head, scheme));
    server.on('clientError', (_err, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
  };

  let httpsServer: HttpsServer | null = null;
  let currentCert = '';
  let renewTimer: ReturnType<typeof setInterval> | undefined;
  let publicPort = 0;
  let publicScheme: 'http' | 'https' = opts.mode === 'https' ? 'https' : 'http';

  if (opts.mode === 'http') {
    const server = createHttpServer();
    attach(server, 'http');
    publicPort = await listen(server, opts.httpPort ?? 0, listenHost);
    servers.push(server);
  } else {
    const domain = opts.domain ?? '';
    const challenge = createHttpServer((req, res) => {
      if (serveChallenge(req, res)) return;
      if (domain) {
        const portSuffix = (opts.httpsPort ?? 443) === 443 ? '' : `:${opts.httpsPort}`;
        res.writeHead(301, { location: `https://${domain}${portSuffix}${req.url ?? '/'}` });
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });
    await listen(challenge, opts.challengePort ?? 80, listenHost);
    servers.push(challenge);
    let material: CertMaterial;
    if (opts.certPath && opts.keyPath) {
      material = loadCertFiles(opts.certPath, opts.keyPath);
      log('info', '使用指定证书,不会自动续期');
    } else {
      if (!opts.domain || !opts.email || !opts.dataDir) throw new Error('HTTPS 需要域名、邮箱和数据目录,或同时提供证书与私钥路径');
      const stored = readStoredCert(opts.dataDir);
      if (stored && !needsRenewal(stored.cert)) material = stored;
      else {
        material = await obtainCertificate({
          domain: opts.domain,
          email: opts.email,
          directoryUrl: opts.acmeDirectory || LETSENCRYPT_PRODUCTION,
          dataDir: opts.dataDir,
          onChallenge: (token, keyAuthorization) => challenges.set(token, keyAuthorization),
          removeChallenge: (token) => challenges.delete(token),
        });
        log('info', '已签发证书');
      }
    }
    currentCert = material.cert;
    httpsServer = createHttpsServer({ cert: material.cert, key: material.key });
    attach(httpsServer, 'https');
    publicPort = await listen(httpsServer, opts.httpsPort ?? 443, listenHost);
    servers.push(httpsServer);
    if (!opts.certPath && opts.domain && opts.email && opts.dataDir) {
      const dataDir = opts.dataDir;
      const domain = opts.domain;
      const email = opts.email;
      renewTimer = setInterval(() => {
        void (async () => {
          try {
            if (!needsRenewal(currentCert)) return;
            const next = await obtainCertificate({
              domain,
              email,
              directoryUrl: opts.acmeDirectory || LETSENCRYPT_PRODUCTION,
              dataDir,
              onChallenge: (token, keyAuthorization) => challenges.set(token, keyAuthorization),
              removeChallenge: (token) => challenges.delete(token),
            });
            httpsServer?.setSecureContext({ cert: next.cert, key: next.key });
            currentCert = next.cert;
            log('info', '证书已续期');
          } catch (e) {
            log('error', `证书续期失败: ${(e as Error).message}`);
          }
        })();
      }, RENEW_EVERY_MS);
      renewTimer.unref?.();
    }
  }

  const hostShown = listenHost === '0.0.0.0' || listenHost === '::' ? '127.0.0.1' : listenHost;
  const httpsHost = opts.domain || hostShown;
  const url =
    publicScheme === 'https'
      ? `https://${httpsHost}${publicPort === 443 ? '' : `:${publicPort}`}`
      : `http://${hostShown}:${publicPort}`;
  log('info', `中继已监听 ${url}`);

  return {
    url,
    tunnelUrl: `${publicScheme === 'https' ? 'wss' : 'ws'}://${hostShown}:${publicPort}${TUNNEL_PATH}`,
    port: publicPort,
    connected: () => tunnel?.readyState === WebSocket.OPEN,
    putChallenge: (token, keyAuthorization) => {
      challenges.set(token, keyAuthorization);
    },
    close: async () => {
      if (stopped) return;
      stopped = true;
      if (renewTimer) clearInterval(renewTimer);
      if (tunnel) {
        const ws = tunnel;
        tunnel = null;
        ws.removeAllListeners();
        ws.terminate();
      }
      dropStreams();
      wss.close();
      await Promise.all(servers.map((server) => closeServer(server)));
    },
  };
}
