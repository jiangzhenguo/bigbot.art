/**
 * 远程静态资源的缓存策略。
 *
 * 公网链路上首屏要下 1.4MB 的 JS,慢链路上这是体感最大的那一笔。
 * 这里钉死三件事:带 hash 的产物长期缓存、index.html 每次校验、
 * 客户端已经有内容时回 304 而不是重发一遍。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppSettings } from '@bigbotart/shared';

const tmpHome = mkdtempSync(join(tmpdir(), 'bba-static-cache-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');
delete process.env.BIGBOTART_REMOTE_LOOPBACK;
// 测试机没有 Tailscale,只绑回环
process.env.BIGBOTART_REMOTE_LOOPBACK = '1';

const { createRemoteServer } = await import('../remote/server.js');
const { EventHub } = await import('../event-hub.js');
const { rotatePassphrase } = await import('../remote/auth.js');

const staticDir = join(tmpHome, 'renderer');
mkdirSync(join(staticDir, 'assets'), { recursive: true });
writeFileSync(join(staticDir, 'index.html'), '<!doctype html><div id="root"></div>');
writeFileSync(join(staticDir, 'assets', 'index-abc123.js'), 'console.log(1)');
writeFileSync(join(staticDir, 'assets', 'icon-xyz.png'), 'not-really-a-png');

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
      server.close(() => resolvePort(typeof addr === 'object' && addr ? addr.port : 0));
    });
  });
}

async function startServer(): Promise<number> {
  // 没有口令远程服务不会监听
  rotatePassphrase(tmpHome);
  const control = createRemoteServer({
    hub: new EventHub(),
    handlers: new Map(),
    logger: { log: () => {} },
    staticDir,
    dataDir: tmpHome,
    lookupTailscale: async () => ({ ip: null, dns: null, selfLogin: null }),
    whois: async () => null,
  });
  openControls.push(control);
  const port = await freePort();
  await control.apply({
    renderMode: 'demo',
    remoteAccess: { enabled: true, port },
  } as AppSettings);
  return port;
}

describe('远程静态资源缓存', () => {
  it('带 hash 的产物长期缓存,index.html 每次校验', async () => {
    const port = await startServer();
    const base = `http://127.0.0.1:${port}`;

    const asset = await fetch(`${base}/assets/index-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(asset.headers.get('etag')).toMatch(/^W\/"/);
    expect(asset.headers.get('last-modified')).toBeTruthy();
    expect(await asset.text()).toBe('console.log(1)');

    const html = await fetch(`${base}/`);
    expect(html.status).toBe(200);
    // index.html 引用着带 hash 的产物名,缓存住旧版会要不到新资源
    expect(html.headers.get('cache-control')).toBe('no-cache');
    expect(html.headers.get('etag')).toMatch(/^W\/"/);
  });

  it('条件请求回 304,不再重发内容', async () => {
    const port = await startServer();
    const base = `http://127.0.0.1:${port}`;

    const first = await fetch(`${base}/assets/icon-xyz.png`);
    const etag = first.headers.get('etag')!;
    const lastModified = first.headers.get('last-modified')!;
    expect(first.status).toBe(200);

    const byEtag = await fetch(`${base}/assets/icon-xyz.png`, { headers: { 'if-none-match': etag } });
    expect(byEtag.status).toBe(304);
    expect(await byEtag.text()).toBe('');

    const byDate = await fetch(`${base}/assets/icon-xyz.png`, { headers: { 'if-modified-since': lastModified } });
    expect(byDate.status).toBe(304);

    // 换了 ETag 就要真发内容
    const stale = await fetch(`${base}/assets/icon-xyz.png`, { headers: { 'if-none-match': 'W/"deadbeef-1"' } });
    expect(stale.status).toBe(200);
  });

  it('文件改动后 ETag 跟着变,旧缓存不会被当成还新鲜', async () => {
    const port = await startServer();
    const base = `http://127.0.0.1:${port}`;
    const file = join(staticDir, 'assets', 'index-abc123.js');

    const first = await fetch(`${base}/assets/index-abc123.js`);
    const etag = first.headers.get('etag')!;

    // 内容变了、mtime 也变了 → ETag 必须不同
    writeFileSync(file, 'console.log(2)');
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);

    const second = await fetch(`${base}/assets/index-abc123.js`);
    expect(second.headers.get('etag')).not.toBe(etag);
    expect(await second.text()).toBe('console.log(2)');

    // 拿旧 ETag 再问,应重新发内容
    const revalidate = await fetch(`${base}/assets/index-abc123.js`, { headers: { 'if-none-match': etag } });
    expect(revalidate.status).toBe(200);
  });
});
