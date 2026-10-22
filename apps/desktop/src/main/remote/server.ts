/**
 * 可选的远程访问 HTTP 服务。默认不监听。
 *
 * 绑 Tailscale IPv4 + 127.0.0.1。没有 Tailscale 时不对外监听。
 * BIGBOTART_REMOTE_LOOPBACK=1 只绑回环,给没有 Tailscale 的 dry-run 冒烟用,绝不绑 0.0.0.0。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { WebSocket, WebSocketServer, type WebSocket as WebSocketSocket } from 'ws';
import { DEFAULT_REMOTE_PORT, type AppSettings, type RemoteAccessStatus } from '@bigbotart/shared';
import { DATA_DIR } from '../workspace-paths';
import { rangeFileResponse } from '../assets';
import type { DebugLogger } from '../logger';
import type { EventHub } from '../event-hub';
import {
  LOGIN_MAX_FAILS,
  LoginLimiter,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SessionStore,
  hasPassphrase,
  originAllowed,
  readCookie,
  rotatePassphrase,
  sessionSetCookie,
  verifyPassphrase,
} from './auth';
import { resolveAssetFile, resolveOutputFile } from './media';
import { dispatchRpc, type IpcHandler } from './rpc';
import { isLoopback, tailscaleDnsName, tailscaleIpv4, tailscaleLogin } from './tailscale';

const BODY_LIMIT = 32 * 1024 * 1024;
const PING_MS = 25_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export interface RemoteServerDeps {
  hub: EventHub;
  handlers: Map<string, IpcHandler>;
  logger: Pick<DebugLogger, 'log'>;
  /** 构建好的渲染层目录(out/renderer)。可以不存在。 */
  staticDir: string;
  dataDir?: string;
  /** 测试注入,跳过真实 tailscale 子进程 */
  lookupTailscale?: () => Promise<{ ip: string | null; dns: string | null; selfLogin: string | null }>;
  /** 测试注入 whois。缺省走 `tailscale whois`。 */
  whois?: (ip: string) => Promise<string | null>;
}

export interface RemoteControl {
  apply(settings: AppSettings): Promise<void>;
  status(): RemoteAccessStatus;
  rotatePassphrase(): { ok: true; passphrase: string } | { ok: false; error: string };
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('请求体超过 32MB'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function clientIp(req: IncomingMessage): string {
  const addr = req.socket.remoteAddress ?? '';
  return addr.replace(/^::ffff:/, '');
}

async function pipeWebResponse(res: ServerResponse, web: Response): Promise<void> {
  const headers: Record<string, string> = {};
  web.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(web.status, headers);
  if (!web.body) {
    res.end();
    return;
  }
  await new Promise<void>((resolvePromise, reject) => {
    Readable.fromWeb(web.body as import('stream/web').ReadableStream).pipe(res);
    res.on('finish', () => resolvePromise());
    res.on('error', reject);
  });
}

function safeStatic(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const rel = decoded.replace(/^\/+/, '');
  const file = resolve(root, rel);
  const fromRoot = relative(root, file);
  if (fromRoot.startsWith('..') || fromRoot.includes(`..${sep}`)) return null;
  return file;
}

export function createRemoteServer(deps: RemoteServerDeps): RemoteControl {
  const dataDir = deps.dataDir ?? DATA_DIR;
  const sessions = new SessionStore();
  const limiter = new LoginLimiter();
  const sockets = new Set<WebSocketSocket>();
  const servers: Array<ReturnType<typeof createServer>> = [];
  let hosts: string[] = [];
  let port = DEFAULT_REMOTE_PORT;
  let listening = false;
  let urls: string[] = [];
  let error: string | undefined;
  let enabled = false;
  let selfLogin: string | null = null;
  const loopbackOnly = process.env.BIGBOTART_REMOTE_LOOPBACK === '1';
  const wss = new WebSocketServer({ noServer: true });

  const unsub = deps.hub.subscribe((channel, payload) => {
    const frame = JSON.stringify({ channel, payload });
    for (const sock of sockets) {
      if (sock.readyState === WebSocket.OPEN) {
        try {
          sock.send(frame);
        } catch (e) {
          deps.logger.log('warn', `远程事件发送失败 ${channel}: ${(e as Error).message}`);
        }
      }
    }
  });

  function pageReady(): boolean {
    return existsSync(join(deps.staticDir, 'index.html'));
  }

  function status(): RemoteAccessStatus {
    return {
      enabled,
      port,
      listening,
      urls: [...urls],
      hasPassphrase: hasPassphrase(dataDir),
      pageReady: pageReady(),
      ...(error ? { error } : {}),
    };
  }

  async function closeServers(): Promise<void> {
    for (const sock of sockets) {
      try {
        sock.close();
      } catch {
        /* 关闭中的 socket */
      }
    }
    sockets.clear();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolvePromise) => {
            server.close(() => resolvePromise());
          }),
      ),
    );
    listening = false;
    urls = [];
    hosts = [];
  }

  function authed(req: IncomingMessage): boolean {
    return sessions.touch(readCookie(req.headers.cookie, SESSION_COOKIE));
  }

  async function allowPeer(req: IncomingMessage): Promise<boolean> {
    const ip = clientIp(req);
    if (isLoopback(ip) || loopbackOnly) return true;
    if (!selfLogin) return false;
    const login = await (deps.whois ?? tailscaleLogin)(ip);
    return !!login && login === selfLogin;
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!(await allowPeer(req))) {
        json(res, 403, { ok: false, error: 'Tailscale 身份不匹配' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      if (req.method === 'POST' && (path === '/session' || path === '/rpc' || path === '/session/logout')) {
        if (!originAllowed(req.headers.origin, req.headers.host)) {
          json(res, 403, { ok: false, error: 'Origin 与 Host 不一致' });
          return;
        }
      }
      if (req.method === 'GET' && path === '/session') {
        json(res, authed(req) ? 200 : 401, authed(req) ? { ok: true } : { ok: false, error: '未登录' });
        return;
      }
      if (req.method === 'POST' && path === '/session') {
        await handleLogin(req, res);
        return;
      }
      if (req.method === 'POST' && path === '/session/logout') {
        sessions.revoke(readCookie(req.headers.cookie, SESSION_COOKIE));
        json(res, 200, { ok: true }, { 'set-cookie': sessionSetCookie('', 0) });
        return;
      }
      if (path === '/rpc' || path.startsWith('/media/') || path === '/events') {
        if (!authed(req)) {
          json(res, 401, { ok: false, error: '未登录' });
          return;
        }
      }
      if (req.method === 'POST' && path === '/rpc') {
        await handleRpc(req, res);
        return;
      }
      if (req.method === 'GET' && path.startsWith('/media/asset/')) {
        await handleMedia(res, 'asset', path.slice('/media/asset/'.length), req.headers.range);
        return;
      }
      if (req.method === 'GET' && path.startsWith('/media/output/')) {
        await handleMedia(res, 'output', path.slice('/media/output/'.length), req.headers.range);
        return;
      }
      if (req.method === 'GET') {
        serveStatic(res, path);
        return;
      }
      json(res, 404, { ok: false, error: '未找到' });
    } catch (e) {
      const statusCode = (e as { statusCode?: number }).statusCode ?? 500;
      const message = (e as Error).message || '服务器错误';
      if (statusCode >= 500) deps.logger.log('error', `远程请求失败: ${message}`);
      if (!res.headersSent) json(res, statusCode, { ok: false, error: message });
    }
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = clientIp(req);
    if (limiter.isLocked(ip)) {
      deps.logger.log('warn', `远程登录已锁定 ${ip}(15 分钟内失败达到 ${LOGIN_MAX_FAILS} 次)`);
      json(res, 429, { ok: false, error: '登录失败次数过多,请 15 分钟后再试' });
      return;
    }
    if (!(await allowPeer(req))) {
      json(res, 403, { ok: false, error: 'Tailscale 身份不匹配' });
      return;
    }
    const raw = await readBody(req);
    let passphrase = '';
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as { passphrase?: unknown };
      passphrase = typeof parsed.passphrase === 'string' ? parsed.passphrase : '';
    } catch {
      json(res, 400, { ok: false, error: '登录请求不是 JSON' });
      return;
    }
    if (!verifyPassphrase(dataDir, passphrase)) {
      const count = limiter.fail(ip);
      deps.logger.log('warn', `远程登录失败 ${ip} · 第 ${count} 次`);
      json(res, 401, { ok: false, error: '口令不正确' });
      return;
    }
    limiter.succeed(ip);
    const id = sessions.issue();
    json(res, 200, { ok: true }, { 'set-cookie': sessionSetCookie(id, Math.floor(SESSION_TTL_MS / 1000)) });
  }

  async function handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    let parsed: { method?: unknown; params?: unknown };
    try {
      parsed = JSON.parse(raw.toString('utf8')) as { method?: unknown; params?: unknown };
    } catch {
      json(res, 400, { ok: false, error: 'RPC 请求不是 JSON' });
      return;
    }
    const outcome = await dispatchRpc(parsed.method, parsed.params, deps.handlers, deps.logger);
    json(res, outcome.status, outcome.body);
  }

  async function handleMedia(res: ServerResponse, kind: 'asset' | 'output', name: string, range: string | undefined): Promise<void> {
    const hit = kind === 'asset' ? resolveAssetFile(name) : resolveOutputFile(name);
    if (!hit.ok) {
      json(res, hit.status, { ok: false, error: hit.error });
      return;
    }
    await pipeWebResponse(res, rangeFileResponse(hit.file, range ?? null));
  }

  function serveStatic(res: ServerResponse, urlPath: string): void {
    if (!pageReady()) {
      const html = '<!doctype html><meta charset="utf-8"><title>BigBotArt</title><p>远程页面还没构建。请在 Mac 上先完成一次渲染层构建(pnpm build),再刷新。</p>';
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    const root = resolve(deps.staticDir);
    let file = safeStatic(root, urlPath === '/' ? '/index.html' : urlPath);
    if (!file) {
      json(res, 403, { ok: false, error: '静态路径越界' });
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (urlPath === '/' || urlPath === '/index.html') file = join(root, 'index.html');
      else {
        json(res, 404, { ok: false, error: '未找到' });
        return;
      }
    }
    const body = readFileSync(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    res.end(body);
  }

  function attach(server: ReturnType<typeof createServer>): void {
    server.on('request', (req, res) => {
      void onRequest(req, res);
    });
    server.on('upgrade', (req, socket, head) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const deny = (status: number) => {
          socket.write(`HTTP/1.1 ${status} Unauthorized\r\nConnection: close\r\n\r\n`);
          socket.destroy();
        };
        if (url.pathname !== '/events') {
          deny(404);
          return;
        }
        if (!originAllowed(req.headers.origin, req.headers.host)) {
          deny(403);
          return;
        }
        if (!(await allowPeer(req)) || !authed(req)) {
          deny(401);
          return;
        }
        wss.handleUpgrade(req, socket, head, (sock) => {
          sockets.add(sock);
          const timer = setInterval(() => {
            if (sock.readyState === WebSocket.OPEN) sock.ping();
          }, PING_MS);
          sock.on('close', () => {
            clearInterval(timer);
            sockets.delete(sock);
          });
          sock.on('error', (e) => {
            deps.logger.log('warn', `远程 WebSocket 错误: ${(e as Error).message}`);
          });
        });
      })().catch((e) => {
        deps.logger.log('error', `远程升级 WebSocket 失败: ${(e as Error).message}`);
        socket.destroy();
      });
    });
  }

  async function listenOn(host: string, listenPort: number): Promise<void> {
    const server = createServer();
    attach(server);
    await new Promise<void>((resolvePromise, reject) => {
      const onErr = (err: Error) => {
        server.off('listening', onOk);
        reject(err);
      };
      const onOk = () => {
        server.off('error', onErr);
        resolvePromise();
      };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(listenPort, host);
    });
    const addr = server.address();
    if (addr && typeof addr === 'object') port = addr.port;
    servers.push(server);
  }

  async function apply(settings: AppSettings): Promise<void> {
    enabled = settings.remoteAccess?.enabled === true;
    const requested = settings.remoteAccess?.port ?? DEFAULT_REMOTE_PORT;
    if (!enabled) {
      await closeServers();
      error = undefined;
      deps.logger.log('info', '远程访问关');
      return;
    }
    if (!hasPassphrase(dataDir)) {
      await closeServers();
      error = '还没有口令。请先在设置页生成口令,再打开远程访问。';
      deps.logger.log('warn', '远程访问未启动:未设置口令');
      return;
    }
    let bindHosts: string[] = [];
    let dns: string | null = null;
    if (loopbackOnly) {
      bindHosts = ['127.0.0.1'];
      selfLogin = null;
    } else if (deps.lookupTailscale) {
      const found = await deps.lookupTailscale();
      if (!found.ip) {
        await closeServers();
        error = '未检测到 Tailscale,远程访问未启动';
        deps.logger.log('warn', error);
        return;
      }
      bindHosts = [found.ip, '127.0.0.1'];
      dns = found.dns;
      selfLogin = found.selfLogin;
    } else {
      const ip = await tailscaleIpv4();
      if (!ip) {
        await closeServers();
        error = '未检测到 Tailscale,远程访问未启动';
        deps.logger.log('warn', error);
        return;
      }
      bindHosts = [ip, '127.0.0.1'];
      dns = await tailscaleDnsName();
      selfLogin = await tailscaleLogin(ip);
      if (!selfLogin) deps.logger.log('warn', 'Tailscale whois 未得到本机用户,非回环连接会被拒绝');
    }
    const same =
      listening &&
      port === requested &&
      hosts.length === bindHosts.length &&
      hosts.every((h, i) => h === bindHosts[i]);
    if (same) return;
    port = requested;
    await closeServers();
    try {
      for (const host of bindHosts) await listenOn(host, requested);
      hosts = bindHosts;
      listening = true;
      error = undefined;
      const shown = new Set<string>();
      for (const host of bindHosts) shown.add(`http://${host}:${port}/`);
      if (dns) shown.add(`http://${dns}:${port}/`);
      urls = [...shown];
      deps.logger.log('info', `远程访问开 · ${urls.join(' ')}`);
    } catch (e) {
      await closeServers();
      error = `端口 ${requested} 无法监听: ${(e as Error).message}`;
      deps.logger.log('error', `远程访问未启动: ${error}`);
    }
  }

  return {
    apply,
    status,
    rotatePassphrase: () => {
      try {
        const passphrase = rotatePassphrase(dataDir);
        sessions.clear();
        deps.logger.log('info', '远程访问口令已轮换,旧会话失效');
        return { ok: true, passphrase };
      } catch (e) {
        deps.logger.log('error', `远程访问口令写入失败: ${(e as Error).message}`);
        return { ok: false, error: (e as Error).message };
      }
    },
    close: async () => {
      unsub();
      wss.close();
      await closeServers();
    },
  };
}
