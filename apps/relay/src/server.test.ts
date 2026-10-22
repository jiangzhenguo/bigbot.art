/**
 * 中继:配对认证、503、分帧复用。不访问 Let's Encrypt。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import { DOWN_PAGE, startRelay, type RelayHandle } from './server.js';
import { FrameDecoder, FrameType, TUNNEL_PATH, encodeFrame, encodeJson, encodeWsChunk, type TunnelFrame } from './protocol.js';

const KEY = 'super-secret-pairing-key-xyz';
const open: RelayHandle[] = [];

afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function connect(port: number, key: string): Promise<{ ws?: WebSocket; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${TUNNEL_PATH}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    ws.once('open', () => resolve({ ws }));
    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    ws.once('error', () => {});
  });
}

function reader(ws: WebSocket) {
  const dec = new FrameDecoder();
  const frames: TunnelFrame[] = [];
  const waiters: Array<(frame: TunnelFrame) => void> = [];
  ws.on('message', (data) => {
    let parsed: TunnelFrame[];
    try {
      parsed = dec.push(toBuffer(data));
    } catch {
      ws.terminate();
      return;
    }
    for (const frame of parsed) {
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    }
  });
  const next = () => {
    const queued = frames.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<TunnelFrame>((resolve) => waiters.push(resolve));
  };
  return { next };
}

async function replyText(ws: WebSocket, id: number, status: number, body: string, extra?: Record<string, string>) {
  const payload = Buffer.from(body);
  ws.send(encodeJson(FrameType.resHead, id, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(payload.length), ...extra },
  }));
  if (payload.length) ws.send(encodeFrame(FrameType.resData, id, payload));
  ws.send(encodeFrame(FrameType.resEnd, id, Buffer.alloc(0)));
}

describe('中继认证与转发', () => {
  it('错误密钥 401,连续失败后 429,日志不含密钥和请求体', async () => {
    const logs: string[] = [];
    const relay = await startRelay({
      pairingKey: KEY,
      mode: 'http',
      listenHost: '127.0.0.1',
      httpPort: 0,
      logger: { log: (_level, message) => logs.push(message) },
    });
    open.push(relay);
    const marker = 'BODYMARKER-relay-9f3a';
    const down = await fetch(relay.url, { method: 'POST', body: marker });
    expect(down.status).toBe(503);
    expect(await down.text()).toContain('隧道还没连上');
    expect(logs.join('\n')).not.toContain(marker);
    expect(logs.join('\n')).not.toContain(KEY);

    for (let i = 0; i < 8; i++) {
      const res = await connect(relay.port, 'wrong-key-0123456789');
      expect(res.status).toBe(401);
    }
    const locked = await connect(relay.port, 'wrong-key-0123456789');
    expect(locked.status).toBe(429);
    expect(logs.join('\n')).not.toContain('wrong-key-0123456789');
    expect(logs.join('\n')).not.toContain(KEY);
  });

  it('隧道未连上时仍回答 ACME 质询', async () => {
    const relay = await startRelay({ pairingKey: KEY, mode: 'http', listenHost: '127.0.0.1', httpPort: 0 });
    open.push(relay);
    relay.putChallenge('tok-1', 'tok-1.thumbprint');
    const res = await fetch(`${relay.url}/.well-known/acme-challenge/tok-1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('tok-1.thumbprint');
    expect(DOWN_PAGE).toContain('隧道还没连上');
  });

  it('两条 HTTP 与一条 WebSocket 在同一条隧道上复用', async () => {
    const relay = await startRelay({ pairingKey: KEY, mode: 'http', listenHost: '127.0.0.1', httpPort: 0 });
    open.push(relay);
    const { ws } = await connect(relay.port, KEY);
    if (!ws) throw new Error('隧道没有连上');
    const { next } = reader(ws);
    const paths = new Map<number, { path: string; headers: Record<string, string> }>();
    const pump = (async () => {
      for (;;) {
        const frame = await next();
        if (frame.type === FrameType.ping) {
          ws.send(encodeFrame(FrameType.pong, 0, Buffer.alloc(0)));
          continue;
        }
        if (frame.type === FrameType.reqHead) {
          paths.set(frame.streamId, JSON.parse(frame.payload.toString()) as { path: string; headers: Record<string, string> });
          continue;
        }
        if (frame.type === FrameType.reqEnd) {
          const head = paths.get(frame.streamId);
          const path = head?.path ?? '';
          const ranged = path.includes('range-check');
          await replyText(ws, frame.streamId, ranged ? 206 : 200, ranged ? 'ABCD' : path);
          continue;
        }
        if (frame.type === FrameType.wsOpen) {
          ws.send(encodeJson(FrameType.wsReady, frame.streamId, {}));
          ws.send(encodeFrame(FrameType.wsData, frame.streamId, encodeWsChunk(false, true, Buffer.from('evt-1'))));
        }
      }
    })();
    void pump.catch(() => {});

    const [one, two] = await Promise.all([
      fetch(`${relay.url}/one`),
      fetch(`${relay.url}/two?x=1`, { headers: { range: 'bytes=0-3', 'x-bba-tunnel-secret': 'spoof' } }),
    ]);
    expect(await one.text()).toBe('/one');
    expect(two.status).toBe(200);
    expect(await two.text()).toBe('/two?x=1');
    const forwarded = [...paths.values()].find((head) => head.path.startsWith('/two'));
    expect(forwarded?.headers.range).toBe('bytes=0-3');
    expect(forwarded?.headers['x-bba-tunnel-secret']).toBeUndefined();
    expect(forwarded?.headers['x-forwarded-proto']).toBeUndefined();

    const browser = new WebSocket(`${relay.url.replace('http', 'ws')}/events`);
    const message = await new Promise<string>((resolve, reject) => {
      browser.once('message', (data) => resolve(toBuffer(data).toString()));
      browser.once('error', reject);
    });
    expect(message).toBe('evt-1');
    browser.close();

    const ranged = await fetch(`${relay.url}/range-check`, { headers: { range: 'bytes=0-3' } });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe('ABCD');
    expect([...paths.values()].some((item) => item.path === '/range-check' && item.headers.range === 'bytes=0-3')).toBe(true);
    ws.terminate();
  });

  it('新的隧道替换旧连接;非法帧会断开', async () => {
    const relay = await startRelay({ pairingKey: KEY, mode: 'http', listenHost: '127.0.0.1', httpPort: 0 });
    open.push(relay);
    const first = await connect(relay.port, KEY);
    const second = await connect(relay.port, KEY);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(first.ws?.readyState).not.toBe(WebSocket.OPEN);
    expect(relay.connected()).toBe(true);
    const bad = Buffer.alloc(4);
    bad.writeUInt32BE(3, 0);
    second.ws?.send(bad);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(relay.connected()).toBe(false);
    const down = await fetch(relay.url);
    expect(down.status).toBe(503);
    second.ws?.terminate();
  });

  it('指定证书时用 HTTPS 终止,且不发起 ACME', async () => {
    let openssl = true;
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
    } catch {
      openssl = false;
    }
    if (!openssl) return;
    const dir = mkdtempSync(join(tmpdir(), 'bba-relay-cert-'));
    const keyPath = join(dir, 'key.pem');
    const certPath = join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '2', '-nodes', '-subj', '/CN=localhost']);
    const logs: string[] = [];
    const relay = await startRelay({
      pairingKey: KEY,
      mode: 'https',
      listenHost: '127.0.0.1',
      httpsPort: 0,
      challengePort: 0,
      certPath,
      keyPath,
      logger: { log: (_level, message) => logs.push(message) },
    });
    open.push(relay);
    expect(logs.join('\n')).toContain('不会自动续期');
    expect(logs.join('\n')).not.toContain(KEY);
    const body = await new Promise<string>((resolve, reject) => {
      https.get({ hostname: '127.0.0.1', port: relay.port, path: '/', rejectUnauthorized: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      }).on('error', reject);
    });
    expect(body).toContain('隧道还没连上');
  });
});
