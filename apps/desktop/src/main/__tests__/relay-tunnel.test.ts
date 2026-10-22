/**
 * 中继 + 本机远程服务:登录、RPC、WebSocket、Range。
 * 目录常量在 import 时按 BIGBOTART_HOME 求值,必须先指到临时目录。
 * 不申请证书,中继跑在 HTTP 测试模式。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { AppSettings } from '@bigbotart/shared';

const tmpHome = mkdtempSync(join(tmpdir(), 'bba-relay-e2e-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');
delete process.env.BIGBOTART_REMOTE_LOOPBACK;

const { createRemoteServer } = await import('../remote/server.js');
const { EventHub } = await import('../event-hub.js');
const { ASSETS_DIR } = await import('../assets.js');
const { rotatePassphrase } = await import('../remote/auth.js');
const { connectTunnel } = await import('../remote/tunnel-client.js');
const { readPairingKey, writePairingKey } = await import('../remote/relay-secret.js');
const { randomBytes } = await import('node:crypto');
const { startRelay } = await import('@bigbotart/relay');

const passphrase = rotatePassphrase(tmpHome);
const pairingKey = 'e2e-pairing-key-0123456789';
const tunnelSecret = randomBytes(32).toString('base64url');
const bodyMarker = 'BODYMARKER-e2e-77c1';
const lines: string[] = [];
const logger = {
  log: (_level: string, message: string) => {
    lines.push(message);
  },
};

function cookieOf(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [];
  const line = raw[0] ?? '';
  const pair = line.split(';')[0] ?? '';
  if (!pair.startsWith('bba_session=')) throw new Error(`没有会话 cookie: ${line}`);
  return pair;
}

function rawPost(
  port: number,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; setCookie: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/session',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const setCookie = res.rawHeaders
            .map((value, index) => (index % 2 === 1 && res.rawHeaders[index - 1]?.toLowerCase() === 'set-cookie' ? value : ''))
            .filter(Boolean)
            .join('; ');
          resolve({ status: res.statusCode ?? 0, setCookie, body: Buffer.concat(chunks).toString() });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('中继隧道端到端', () => {
  const stops: Array<() => Promise<void> | void> = [];

  afterAll(async () => {
    for (const stop of stops.reverse()) await stop();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('经隧道登录、调用、收事件、按 Range 读媒体,并且回环不能冒充免登录', async () => {
    const saved = writePairingKey(tmpHome, pairingKey);
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.encrypted).toBe(false);
    expect(readPairingKey(tmpHome)).toBe(pairingKey);
    expect(statSync(join(tmpHome, 'relay-pairing.bin')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(tmpHome, 'remote-access.json'), 'utf8')).not.toContain(pairingKey);

    const staticDir = join(tmpHome, 'renderer');
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>app</title><p>canvas-stage</p>');
    mkdirSync(ASSETS_DIR, { recursive: true });
    writeFileSync(join(ASSETS_DIR, 'asset-ok.txt'), 'RANGESECRET-and-more');

    const relayLogs: string[] = [];
    const relay = await startRelay({
      pairingKey,
      mode: 'http',
      listenHost: '127.0.0.1',
      httpPort: 0,
      logger: { log: (_level, message) => relayLogs.push(message) },
    });
    stops.push(() => relay.close());

    const before = await fetch(relay.url);
    expect(before.status).toBe(503);
    expect(await before.text()).toContain('隧道还没连上');

    let whoisCalls = 0;
    let coverCalls = 0;
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    handlers.set('list-projects', () => [{ id: 'p1' }]);
    handlers.set('upload-project-cover', () => {
      coverCalls += 1;
      return { ok: true };
    });
    const hub = new EventHub();
    const control = createRemoteServer({
      hub,
      handlers,
      logger,
      staticDir,
      dataDir: tmpHome,
      tunnelSecret,
      lookupTailscale: async () => ({ ip: null, dns: null, selfLogin: null }),
      whois: async () => {
        whoisCalls += 1;
        return null;
      },
    });
    stops.push(() => control.close());
    const localPort = 0;
    await control.apply({
      renderMode: 'demo',
      remoteAccess: { enabled: true, relayEnabled: true, relayUrl: relay.url, port: localPort },
    } as AppSettings);
    const listening = control.status();
    expect(listening.listening).toBe(true);
    expect(listening.urls.join(' ')).toContain('127.0.0.1');
    expect(listening.urls.join(' ')).not.toContain('0.0.0.0');
    expect(JSON.stringify(listening)).not.toContain(pairingKey);
    expect(JSON.stringify(listening)).not.toContain(tunnelSecret);

    const tunnel = connectTunnel({
      relayUrl: relay.url,
      pairingKey,
      localPort: listening.port,
      tunnelSecret,
      logger,
      onStatus: () => {},
    });
    stops.push(() => tunnel.stop());
    const started = Date.now();
    while (!relay.connected()) {
      if (Date.now() - started > 3000) throw new Error('隧道没有连上');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const origin = relay.url;
    const badOrigin = await fetch(`${origin}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ passphrase }),
    });
    expect(badOrigin.status).toBe(403);

    const spoof = await fetch(`${origin}/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        'x-bba-client-ip': '203.0.113.50',
        'x-forwarded-proto': 'https',
        'x-bba-tunnel-secret': tunnelSecret,
      },
      body: JSON.stringify({ passphrase: 'wrong-passphrase-value' }),
    });
    expect(spoof.status).toBe(401);
    expect(lines.join('\n')).toContain('远程登录失败 127.0.0.1');
    expect(lines.join('\n')).not.toContain('203.0.113.50');

    const loginRes = await fetch(`${origin}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ passphrase }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = cookieOf(loginRes);
    expect(loginRes.headers.get('set-cookie') ?? '').not.toMatch(/;\s*Secure/i);

    const page = await fetch(origin);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('canvas-stage');

    const rpc = await fetch(`${origin}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie },
      body: JSON.stringify({ method: 'listProjects', params: [] }),
    });
    expect(rpc.status).toBe(200);
    expect(await rpc.json()).toEqual({ ok: true, result: [{ id: 'p1' }] });

    const marked = await fetch(`${origin}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie },
      body: JSON.stringify({ method: 'listProjects', params: [bodyMarker] }),
    });
    expect(marked.status).toBe(200);

    const blocked = await fetch(`${origin}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie },
      body: JSON.stringify({ method: 'uploadProjectCover', params: ['p1'] }),
    });
    expect(blocked.status).toBe(403);
    expect(coverCalls).toBe(0);

    const anon = await fetch(`${origin}/media/asset/asset-ok.txt`);
    expect(anon.status).toBe(401);
    expect(await anon.text()).not.toContain('RANGESECRET');
    const anonRpc = await fetch(`${origin}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ method: 'listProjects', params: [] }),
    });
    expect(anonRpc.status).toBe(401);

    const ranged = await fetch(`${origin}/media/asset/asset-ok.txt`, { headers: { cookie, range: 'bytes=0-3' } });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe('RANG');

    const ws = new WebSocket(`${origin.replace('http', 'ws')}/events`, { headers: { cookie, origin } });
    stops.push(() => ws.close());
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const event = new Promise<string>((resolve, reject) => {
      ws.once('message', (data) => resolve(Buffer.isBuffer(data) ? data.toString() : String(data)));
      ws.once('error', reject);
    });
    hub.publish('render-queue-changed', { marker: 'q1' });
    expect(JSON.parse(await event)).toEqual({ channel: 'render-queue-changed', payload: { marker: 'q1' } });

    expect(whoisCalls).toBe(0);

    const secure = await rawPost(
      listening.port,
      {
        origin: 'https://art.example.com',
        host: 'art.example.com',
        'x-bba-tunnel-secret': tunnelSecret,
        'x-forwarded-proto': 'https',
        'x-bba-client-ip': '203.0.113.8',
      },
      JSON.stringify({ passphrase }),
    );
    expect(secure.status).toBe(200);
    expect(secure.setCookie).toMatch(/;\s*Secure/i);
    expect(secure.setCookie).toMatch(/HttpOnly/i);
    expect(secure.setCookie).toMatch(/SameSite=Strict/i);

    const plain = await rawPost(
      listening.port,
      {
        origin: `http://127.0.0.1:${listening.port}`,
        host: `127.0.0.1:${listening.port}`,
        'x-forwarded-proto': 'https',
        'x-bba-client-ip': '203.0.113.8',
      },
      JSON.stringify({ passphrase }),
    );
    expect(plain.status).toBe(200);
    expect(plain.setCookie).not.toMatch(/;\s*Secure/i);

    const joined = `${lines.join('\n')}\n${relayLogs.join('\n')}`;
    expect(joined).not.toContain(passphrase);
    expect(joined).not.toContain(pairingKey);
    expect(joined).not.toContain(tunnelSecret);
    expect(joined).not.toContain(bodyMarker);
  });

  it('经隧道的口令失败 8 次后锁定该地址', async () => {
    const relay = await startRelay({ pairingKey, mode: 'http', listenHost: '127.0.0.1', httpPort: 0, logger });
    stops.push(() => relay.close());
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const control = createRemoteServer({
      hub: new EventHub(),
      handlers,
      logger,
      staticDir: join(tmpHome, 'renderer'),
      dataDir: tmpHome,
      tunnelSecret,
      lookupTailscale: async () => ({ ip: null, dns: null, selfLogin: null }),
      whois: async () => null,
    });
    stops.push(() => control.close());
    await control.apply({
      renderMode: 'demo',
      remoteAccess: { enabled: true, relayEnabled: true, relayUrl: relay.url, port: 0 },
    } as AppSettings);
    const port = control.status().port;
    const tunnel = connectTunnel({
      relayUrl: relay.url,
      pairingKey,
      localPort: port,
      tunnelSecret,
      logger,
      onStatus: () => {},
    });
    stops.push(() => tunnel.stop());
    const started = Date.now();
    while (!relay.connected()) {
      if (Date.now() - started > 3000) throw new Error('隧道没有连上');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const origin = relay.url;
    for (let i = 0; i < 8; i++) {
      const res = await fetch(`${origin}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ passphrase: 'nope' }),
      });
      expect(res.status).toBe(401);
    }
    const locked = await fetch(`${origin}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ passphrase }),
    });
    expect(locked.status).toBe(429);
  });
});
