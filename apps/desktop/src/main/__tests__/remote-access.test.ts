/**
 * 远程访问:口令、Origin、路径守卫、对话框拒绝、事件扇出。
 * 目录常量在 import 时按 BIGBOTART_HOME 求值,必须先指到临时目录。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { RPC_CATALOG, type AppSettings } from '@bigbotart/shared';

const tmpHome = mkdtempSync(join(tmpdir(), 'bba-remote-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');
delete process.env.BIGBOTART_REMOTE_LOOPBACK;

const { createRemoteServer } = await import('../remote/server.js');
const { resolveAssetFile, resolveOutputFile } = await import('../remote/media.js');
const { EventHub } = await import('../event-hub.js');
const { ASSETS_DIR, OUTPUTS_DIR } = await import('../assets.js');
const { rotatePassphrase } = await import('../remote/auth.js');
const { isLoopback, tailscaleDnsName, tailscaleIpv4, tailscaleLogin } = await import('../remote/tailscale.js');

type Control = Awaited<ReturnType<typeof startServer>>['control'];
const openControls: Array<{ close: () => Promise<void> }> = [];

afterAll(async () => {
  for (const c of openControls) await c.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

function lanIpv4(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

function loggerOf(lines: string[]) {
  return {
    log: (_level: string, message: string) => {
      lines.push(message);
    },
  };
}

async function startServer(opts: {
  loopback?: boolean;
  dataDir?: string;
  handlers?: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
  lookupTailscale?: () => Promise<{ ip: string | null; dns: string | null; selfLogin: string | null }>;
  whois?: (ip: string) => Promise<string | null>;
  staticDir?: string;
  enabled?: boolean;
  port?: number;
  withPassphrase?: boolean;
}) {
  if (opts.loopback) process.env.BIGBOTART_REMOTE_LOOPBACK = '1';
  else delete process.env.BIGBOTART_REMOTE_LOOPBACK;
  const lines: string[] = [];
  const hub = new EventHub();
  const handlers = opts.handlers ?? new Map();
  const dataDir = opts.dataDir ?? tmpHome;
  const control = createRemoteServer({
    hub,
    handlers,
    logger: loggerOf(lines),
    staticDir: opts.staticDir ?? join(tmpHome, 'no-renderer'),
    dataDir,
    lookupTailscale: opts.lookupTailscale,
    whois: opts.whois,
  });
  openControls.push(control);
  const port = opts.port ?? (await freePort());
  await control.apply({
    renderMode: 'demo',
    remoteAccess: { enabled: opts.enabled !== false, port },
  } as AppSettings);
  return { control, hub, lines, port, handlers };
}

const passphrase = rotatePassphrase(tmpHome);

function cookieOf(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [];
  const line = raw[0] ?? '';
  const pair = line.split(';')[0] ?? '';
  if (!pair.startsWith('bba_session=')) throw new Error(`没有会话 cookie: ${line}`);
  return pair;
}

async function login(port: number, secret = passphrase, origin?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/session`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host: `127.0.0.1:${port}`,
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({ passphrase: secret }),
  });
}

describe('Tailscale 查询', () => {
  it('解析 ip / DNS / whois,失败返回 null 而不是抛出', async () => {
    const run = async (cmd: string, args: string[]) => {
      expect(cmd).toBe('tailscale');
      if (args[0] === 'ip') return '100.64.1.2\n';
      if (args[0] === 'status') return JSON.stringify({ Self: { DNSName: 'studio.tailnet.ts.net.' } });
      if (args[0] === 'whois') return JSON.stringify({ UserProfile: { LoginName: 'owner@example.com' } });
      throw new Error('boom');
    };
    await expect(tailscaleIpv4(run)).resolves.toBe('100.64.1.2');
    await expect(tailscaleDnsName(run)).resolves.toBe('studio.tailnet.ts.net');
    await expect(tailscaleLogin('100.64.1.2', run)).resolves.toBe('owner@example.com');
    await expect(tailscaleLogin('100.64.1.2', async () => { throw new Error('whois 失败'); })).resolves.toBeNull();
    await expect(tailscaleIpv4(async () => { throw new Error('没有 tailscale'); })).resolves.toBeNull();
  });

  it('回环地址识别 ::ffff:127.0.0.1 与 ::1', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('100.64.1.2')).toBe(false);
  });
});

describe('监听范围', () => {
  it('没有口令时不监听', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'bba-remote-empty-'));
    const { control } = await startServer({ loopback: true, dataDir: empty, withPassphrase: false });
    expect(control.status().listening).toBe(false);
    expect(control.status().error).toMatch(/口令/);
    rmSync(empty, { recursive: true, force: true });
  });

  it('没有 Tailscale 时不监听,也不绑 0.0.0.0', async () => {
    const { control } = await startServer({
      loopback: false,
      lookupTailscale: async () => ({ ip: null, dns: null, selfLogin: null }),
    });
    expect(control.status().listening).toBe(false);
    expect(control.status().error).toMatch(/Tailscale/);
    expect(control.status().urls.join(' ')).not.toContain('0.0.0.0');
  });

  it('端口被占用时保持关闭,不改去别的端口', async () => {
    const port = await freePort();
    const blocker = createNetServer();
    await new Promise<void>((resolveListen, reject) => {
      blocker.once('error', reject);
      blocker.listen(port, '127.0.0.1', () => resolveListen());
    });
    try {
      const { control } = await startServer({ loopback: true, port });
      expect(control.status().listening).toBe(false);
      expect(control.status().port).toBe(port);
      expect(control.status().error).toMatch(/无法监听/);
    } finally {
      await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
    }
  });

  it('回环模式只公布 127.0.0.1', async () => {
    const { control, port } = await startServer({ loopback: true });
    const status = control.status();
    expect(status.listening).toBe(true);
    expect(status.urls).toEqual([`http://127.0.0.1:${port}/`]);
    expect(status.urls.join(' ')).not.toContain('0.0.0.0');
    await control.close();
  });
});

describe('口令与会话', () => {
  it('哈希落在 remote-access.json,响应和日志都不含明文', async () => {
    const stored = readFileSync(join(tmpHome, 'remote-access.json'), 'utf8');
    expect(stored).not.toContain(passphrase);
    expect(stored).toContain('"hash"');
    const { port, lines } = await startServer({ loopback: true });
    const wrong = await login(port, 'not-the-passphrase');
    expect(wrong.status).toBe(401);
    const ok = await login(port);
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toEqual({ ok: true });
    const setCookie = (ok.headers.getSetCookie?.() ?? []).join(';');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).not.toMatch(/;\s*Secure/i);
    expect(JSON.stringify(body) + setCookie).not.toContain(passphrase);
    expect(lines.join('\n')).not.toContain(passphrase);
  });

  it('无 cookie 时 /rpc 与 /media 都是 401', async () => {
    mkdirSync(ASSETS_DIR, { recursive: true });
    writeFileSync(join(ASSETS_DIR, 'asset-secret.txt'), 'secret-bytes');
    const { port } = await startServer({ loopback: true });
    const rpc = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'listProjects', params: [] }),
    });
    expect(rpc.status).toBe(401);
    const media = await fetch(`http://127.0.0.1:${port}/media/asset/asset-secret.txt`);
    expect(media.status).toBe(401);
    expect(await media.text()).not.toContain('secret-bytes');
  });

  it('错误口令记 8 次,第 9 次 429', async () => {
    const { port } = await startServer({ loopback: true });
    for (let i = 1; i <= 8; i++) {
      const res = await login(port, `bad-${i}`);
      expect(res.status).toBe(401);
    }
    const locked = await login(port, passphrase);
    expect(locked.status).toBe(429);
  });

  it('Origin 与 Host 不一致时拒绝登录', async () => {
    const { port } = await startServer({ loopback: true });
    const res = await login(port, passphrase, 'http://evil.example');
    expect(res.status).toBe(403);
  });

  it('正确口令之后可以调用 listProjects;轮换口令使旧会话失效', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bba-remote-rotate-'));
    const secret = rotatePassphrase(dir);
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    handlers.set('list-projects', () => [{ id: 'p1', name: '冒烟' }]);
    const { port, control } = await startServer({ loopback: true, handlers, dataDir: dir });
    const ok = await login(port, secret);
    const cookie = cookieOf(ok);
    const rpc = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ method: 'listProjects', params: [] }),
    });
    expect(rpc.status).toBe(200);
    expect(await rpc.json()).toEqual({ ok: true, result: [{ id: 'p1', name: '冒烟' }] });
    const rotated = control.rotatePassphrase();
    expect(rotated.ok).toBe(true);
    if (rotated.ok) expect(rotated.passphrase).not.toBe(passphrase);
    const again = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ method: 'listProjects', params: [] }),
    });
    expect(again.status).toBe(401);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('远程不能弹系统对话框', () => {
  it('封面、Finder、无路径导入被拒绝且 handler 未被调用;带路径的导入仍进入 handler', async () => {
    const calls: string[] = [];
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const touch = (name: string) => () => {
      calls.push(name);
      return { ok: true };
    };
    handlers.set('upload-project-cover', touch('upload'));
    handlers.set('reveal-in-finder', touch('reveal'));
    handlers.set('import-assets', (_e, opts: unknown) => {
      calls.push('import');
      return { canceled: false, assets: [{ id: 'a' }], failed: [], echo: opts };
    });
    handlers.set('set-settings', (_e, patch: unknown) => patch);
    const { port } = await startServer({ loopback: true, handlers });
    const ok = await login(port);
    const cookie = cookieOf(ok);
    const post = (method: string, params: unknown[]) =>
      fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ method, params }),
      });
    expect((await post('uploadProjectCover', ['p1'])).status).toBe(403);
    expect((await post('revealInFinder', [{ path: '/tmp/x' }])).status).toBe(403);
    expect((await post('importAssets', [{}])).status).toBe(403);
    expect((await post('remoteAccessRotatePassphrase', [])).status).toBe(403);
    expect((await post('relaySetPairingKey', ['not-the-real-key'])).status).toBe(403);
    const imported = await post('importAssets', [{ paths: ['/tmp/ref.png'] }]);
    expect(imported.status).toBe(200);
    const settings = await post('setSettings', [{ language: 'en', remoteAccess: { enabled: true, port: 1 } }]);
    expect(await settings.json()).toEqual({ ok: true, result: { language: 'en' } });
    expect(calls).toEqual(['import']);
  });

  it('handler 抛错只回 message', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    handlers.set('list-projects', () => {
      throw new Error('项目库打不开');
    });
    const { port } = await startServer({ loopback: true, handlers });
    const cookie = cookieOf(await login(port));
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ method: 'listProjects', params: [] }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: '项目库打不开' });
    expect(JSON.stringify(body)).not.toContain('remote-access.test');
  });
});

describe('媒体路径守卫', () => {
  it('白名单内的文件可 Range;符号链接跳出、穿越、中文名按规则处理', async () => {
    mkdirSync(ASSETS_DIR, { recursive: true });
    mkdirSync(OUTPUTS_DIR, { recursive: true });
    const outside = join(tmpHome, 'outside-secret.txt');
    writeFileSync(outside, 'TOP-SECRET');
    writeFileSync(join(ASSETS_DIR, 'asset-ok.txt'), 'abcdEFGH');
    symlinkSync(outside, join(ASSETS_DIR, 'asset-link.txt'));
    writeFileSync(join(OUTPUTS_DIR, '飞机1-demo.mp4'), Buffer.from('0123456789'));
    symlinkSync(outside, join(OUTPUTS_DIR, '逃.mp4'));
    const { port } = await startServer({ loopback: true });
    const cookie = cookieOf(await login(port));
    const headers = { cookie, range: 'bytes=0-3' };
    const ranged = await fetch(`http://127.0.0.1:${port}/media/asset/asset-ok.txt`, { headers });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('accept-ranges')).toBe('bytes');
    expect(await ranged.text()).toBe('abcd');
    const link = await fetch(`http://127.0.0.1:${port}/media/asset/asset-link.txt`, { headers: { cookie } });
    expect(link.status).toBe(403);
    expect(await link.text()).not.toContain('TOP-SECRET');
    const chinese = await fetch(`http://127.0.0.1:${port}/media/output/${encodeURIComponent('飞机1-demo.mp4')}`, {
      headers: { cookie },
    });
    expect(chinese.status).toBe(200);
    expect(await chinese.text()).toBe('0123456789');
    const escaped = await fetch(`http://127.0.0.1:${port}/media/output/${encodeURIComponent('逃.mp4')}`, { headers: { cookie } });
    expect(escaped.status).toBe(403);
    expect(resolveOutputFile('../outside-secret.txt').ok).toBe(false);
    expect(resolveOutputFile('../outside-secret.txt')).toMatchObject({ status: 400 });
    expect(resolveAssetFile('asset-link.txt')).toMatchObject({ ok: false, status: 403 });
    const traversal = await fetch(`http://127.0.0.1:${port}/media/output/${encodeURIComponent('../outside-secret.txt')}`, {
      headers: { cookie },
    });
    expect(await traversal.text()).not.toContain('TOP-SECRET');
    expect([400, 403, 404]).toContain(traversal.status);
  });
});

describe('事件扇出', () => {
  it('两个已登录的 WebSocket 都收到 agent-event / canvas-snapshot / video-post-progress', async () => {
    const { port, hub } = await startServer({ loopback: true });
    const cookie = cookieOf(await login(port));
    const open = (headerCookie: string | null) =>
      new Promise<WebSocket>((resolveWs, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/events`, {
          headers: {
            host: `127.0.0.1:${port}`,
            origin: `http://127.0.0.1:${port}`,
            ...(headerCookie ? { cookie: headerCookie } : {}),
          },
        });
        ws.once('open', () => resolveWs(ws));
        ws.once('error', reject);
        ws.once('unexpected-response', (_req, res) => {
          reject(new Error(`升级被拒绝 ${res.statusCode}`));
        });
      });
    await expect(open(null)).rejects.toThrow(/401/);
    const a = await open(cookie);
    const b = await open(cookie);
    const buffers = new Map<WebSocket, unknown[]>([[a, []], [b, []]]);
    const waiters = new Map<WebSocket, Array<(msg: unknown) => void>>([[a, []], [b, []]]);
    for (const ws of [a, b]) {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data));
        const waiter = waiters.get(ws)?.shift();
        if (waiter) waiter(msg);
        else buffers.get(ws)?.push(msg);
      });
    }
    const next = (ws: WebSocket) => {
      const buf = buffers.get(ws)!;
      if (buf.length) return Promise.resolve(buf.shift());
      return new Promise((resolveMsg) => waiters.get(ws)!.push(resolveMsg));
    };
    const pending = Promise.all([next(a), next(b)]);
    const snap = { id: 'cv', version: 3 };
    hub.publish('canvas-snapshot-updated', snap);
    const [left, right] = await pending;
    expect(left).toEqual({ channel: 'canvas-snapshot-updated', payload: snap });
    expect(right).toEqual(left);
    const more = Promise.all([next(a), next(b), next(a), next(b)]);
    hub.publish('agent-event', { kind: 'done' });
    hub.publish('video-post-progress', { jobId: 'v', pct: 40 });
    const frames = await more;
    expect(frames[0]).toEqual({ channel: 'agent-event', payload: { kind: 'done' } });
    expect(frames[1]).toEqual(frames[0]);
    expect(frames[2]).toEqual({ channel: 'video-post-progress', payload: { jobId: 'v', pct: 40 } });
    expect(frames[3]).toEqual(frames[2]);
    a.close();
    b.close();
  });
});

describe('非回环连接要过 whois', () => {
  const lan = lanIpv4();
  it.skipIf(!lan)('whois 不一致或失败时拒绝,一致时放行;回环不调用 whois', async () => {
    const seen: string[] = [];
    let answer: string | null = 'someone-else@mac';
    const { port } = await startServer({
      loopback: false,
      lookupTailscale: async () => ({ ip: lan, dns: 'studio.tailnet.ts.net', selfLogin: 'owner@mac' }),
      whois: async (ip) => {
        seen.push(ip);
        return answer;
      },
    });
    const mismatch = await fetch(`http://${lan}:${port}/session`);
    expect(mismatch.status).toBe(403);
    answer = null;
    const failed = await fetch(`http://${lan}:${port}/session`);
    expect(failed.status).toBe(403);
    answer = 'owner@mac';
    const matched = await fetch(`http://${lan}:${port}/session`);
    expect(matched.status).toBe(401);
    seen.length = 0;
    const loop = await fetch(`http://127.0.0.1:${port}/session`);
    expect(loop.status).toBe(401);
    expect(seen).toEqual([]);
  });
});

describe('目录与 IPC 频道一致', () => {
  it('api-surface 注册的频道与 RPC 目录相同', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../api-surface.ts'), 'utf8');
    const channels = [...src.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(channels).toHaveLength(RPC_CATALOG.length);
    expect(new Set(channels)).toEqual(new Set(RPC_CATALOG.map((e) => e.ipcChannel)));
  });
});
