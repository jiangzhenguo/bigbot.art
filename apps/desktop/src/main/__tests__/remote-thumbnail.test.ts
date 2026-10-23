/**
 * 服务端缩略图 + 媒体缓存头。
 *
 * 背景:公网链路实测 ~350KB/s,首页一次要拉 19 张全尺寸原图(27.6MB),
 * 光这一项就要一分多钟,还会把 HTML/JS/接口全堵住。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, statSync, existsSync, copyFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AppSettings } from '@bigbotart/shared';

const tmpHome = mkdtempSync(join(tmpdir(), 'bba-thumb-'));
process.env.BIGBOTART_HOME = tmpHome;
process.env.BIGBOTART_H3_OUTPUTS = join(tmpHome, 'outputs');
process.env.BIGBOTART_REMOTE_LOOPBACK = '1';

const { createRemoteServer } = await import('../remote/server.js');
const { EventHub } = await import('../event-hub.js');
const { rotatePassphrase } = await import('../remote/auth.js');
const { isThumbWidth, thumbnailFor, MIN_THUMB_WIDTH, MAX_THUMB_WIDTH } = await import('../remote/thumbnail.js');
const { ASSETS_DIR } = await import('../assets.js');

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

/**
 * 放一张**真实**的大图到资产库。
 *
 * 必须是真的 PNG —— sips 解不开伪造的头,缩略图会生成失败,
 * 那测的就不是缩略图逻辑而是"降级路径"了。
 */
function writeBigPng(name: string): string {
  const file = join(ASSETS_DIR, name);
  mkdirSync(ASSETS_DIR, { recursive: true });
  const src = resolve(import.meta.dirname, '../../../resources/icon.png');
  copyFileSync(src, file);
  return file;
}

async function startServer(): Promise<{ port: number; passphrase: string }> {
  const passphrase = rotatePassphrase(tmpHome);
  const control = createRemoteServer({
    hub: new EventHub(),
    handlers: new Map(),
    logger: { log: () => {} },
    staticDir: join(tmpHome, 'renderer'),
    dataDir: tmpHome,
    lookupTailscale: async () => ({ ip: null, dns: null, selfLogin: null }),
    whois: async () => null,
  });
  openControls.push(control);
  const port = await freePort();
  await control.apply({ renderMode: 'demo', remoteAccess: { enabled: true, port } } as AppSettings);
  return { port, passphrase };
}

describe('缩略图宽度校验', () => {
  it('只接受范围内的整数宽度', () => {
    expect(isThumbWidth(480)).toBe(true);
    expect(isThumbWidth(MIN_THUMB_WIDTH)).toBe(true);
    expect(isThumbWidth(MAX_THUMB_WIDTH)).toBe(true);
    expect(isThumbWidth(MIN_THUMB_WIDTH - 1)).toBe(false);
    expect(isThumbWidth(MAX_THUMB_WIDTH + 1)).toBe(false);
    expect(isThumbWidth(0)).toBe(false);
    expect(isThumbWidth(-10)).toBe(false);
    expect(isThumbWidth(Number.NaN)).toBe(false);
    expect(isThumbWidth(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isThumbWidth('480' as unknown)).toBe(false);
  });
});

describe('服务端缩略图', () => {
  it('按最长边缩放并缓存,尺寸远小于原图', async () => {
    if (process.platform !== 'darwin') {
      // 非 macOS 没有 sips,应当优雅降级而不是崩
      const file = writeBigPng('thumb-degrade.png');
      expect(await thumbnailFor(file, 200)).toBeNull();
      return;
    }
    const file = writeBigPng('thumb-ok.png');
    const full = statSync(file).size;
    const out = await thumbnailFor(file, 200);
    expect(out, '缩略图应该生成成功').toBeTruthy();
    expect(existsSync(out!)).toBe(true);
    expect(statSync(out!).size).toBeLessThan(full);
    // 同一请求应当命中缓存(同一个路径)
    expect(await thumbnailFor(file, 200)).toBe(out);
  }, 30_000);
});

describe('远程媒体接口', () => {
  it('?w= 出缩略图,媒体带长缓存头,非法宽度回退原图', async () => {
    const { port, passphrase } = await startServer();
    const base = `http://127.0.0.1:${port}`;
    const name = 'asset-cache-check.png';
    writeBigPng(name);

    const login = await fetch(`${base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? '';
    expect(cookie).toContain('bba_session=');

    const full = await fetch(`${base}/media/asset/${name}`, { headers: { cookie } });
    expect(full.status).toBe(200);
    // 媒体文件名带 id/时间戳,内容不会变 → 长缓存
    expect(full.headers.get('cache-control')).toBe('public, max-age=604800');
    const fullBytes = (await full.arrayBuffer()).byteLength;

    if (process.platform === 'darwin') {
      const thumb = await fetch(`${base}/media/asset/${name}?w=200`, { headers: { cookie } });
      expect(thumb.status).toBe(200);
      const thumbBytes = (await thumb.arrayBuffer()).byteLength;
      expect(thumbBytes).toBeLessThan(fullBytes);
    }

    // 非法宽度 → 当作没给,发原图
    const bad = await fetch(`${base}/media/asset/${name}?w=99999`, { headers: { cookie } });
    expect(bad.status).toBe(200);
    expect((await bad.arrayBuffer()).byteLength).toBe(fullBytes);
  }, 30_000);
});
