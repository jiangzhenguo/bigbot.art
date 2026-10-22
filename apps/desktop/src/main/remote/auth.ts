/**
 * 远程访问口令与会话。
 *
 * 口令明文只在生成的那一次离开这个模块。磁盘上是 scrypt 哈希,模式 0600。
 * cookie 里是 session id,不是口令。进程重启后会话清空。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;
export const SESSION_COOKIE = 'bba_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
/** 窗口内失败次数达到这个数之后,下一次登录直接 429 */
export const LOGIN_MAX_FAILS = 8;

interface PassphraseFile {
  salt: string;
  hash: string;
  n: number;
  r: number;
  p: number;
  keylen: number;
}

export function passphraseFile(dataDir: string): string {
  return join(dataDir, 'remote-access.json');
}

export function hasPassphrase(dataDir: string): boolean {
  return existsSync(passphraseFile(dataDir));
}

/** 生成新口令,覆盖旧哈希。返回明文(调用方只展示一次,不要写日志)。 */
export function rotatePassphrase(dataDir: string): string {
  const passphrase = randomBytes(32).toString('base64url');
  const salt = randomBytes(16);
  const hash = scryptSync(passphrase, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  const body: PassphraseFile = {
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    n: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    keylen: SCRYPT.keylen,
  };
  mkdirSync(dataDir, { recursive: true });
  const file = passphraseFile(dataDir);
  writeFileSync(file, JSON.stringify(body, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
  return passphrase;
}

export function verifyPassphrase(dataDir: string, passphrase: string): boolean {
  const file = passphraseFile(dataDir);
  if (!existsSync(file)) return false;
  let parsed: PassphraseFile;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as PassphraseFile;
  } catch {
    return false;
  }
  if (!parsed.salt || !parsed.hash) return false;
  const salt = Buffer.from(parsed.salt, 'base64');
  const expected = Buffer.from(parsed.hash, 'base64');
  const actual = scryptSync(passphrase, salt, parsed.keylen || SCRYPT.keylen, {
    N: parsed.n || SCRYPT.N,
    r: parsed.r || SCRYPT.r,
    p: parsed.p || SCRYPT.p,
  });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export class SessionStore {
  private sessions = new Map<string, number>();

  issue(now = Date.now()): string {
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, now + SESSION_TTL_MS);
    return id;
  }

  /** 有效则滑动续期。 */
  touch(id: string | null | undefined, now = Date.now()): boolean {
    if (!id) return false;
    const exp = this.sessions.get(id);
    if (!exp || exp <= now) {
      if (id) this.sessions.delete(id);
      return false;
    }
    this.sessions.set(id, now + SESSION_TTL_MS);
    return true;
  }

  revoke(id: string | null | undefined): void {
    if (id) this.sessions.delete(id);
  }

  clear(): void {
    this.sessions.clear();
  }
}

export class LoginLimiter {
  private fails = new Map<string, { count: number; resetAt: number }>();

  isLocked(ip: string, now = Date.now()): boolean {
    const row = this.fails.get(ip);
    if (!row) return false;
    if (row.resetAt <= now) {
      this.fails.delete(ip);
      return false;
    }
    return row.count >= LOGIN_MAX_FAILS;
  }

  fail(ip: string, now = Date.now()): number {
    const row = this.fails.get(ip);
    if (!row || row.resetAt <= now) {
      this.fails.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      return 1;
    }
    row.count += 1;
    return row.count;
  }

  succeed(ip: string): void {
    this.fails.delete(ip);
  }
}

/** Origin 缺省(非浏览器)放行;否则 host+端口必须和 Host 一致。第一期没有反代。 */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** secure 只在确认来自 HTTPS 隧道时加上。明文的 Tailscale 路径不加,浏览器会丢掉 Secure cookie。 */
export function sessionSetCookie(id: string, maxAgeSec: number, secure = false): string {
  const base = `${SESSION_COOKIE}=${encodeURIComponent(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
  return secure ? `${base}; Secure` : base;
}
