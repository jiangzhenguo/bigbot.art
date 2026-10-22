/**
 * 隧道配对失败计数。和桌面登录限流分开,只认中继看到的对端地址。
 */
export const PAIRING_WINDOW_MS = 15 * 60 * 1000;
export const PAIRING_MAX_FAILS = 8;

export class FailWindow {
  private fails = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private max = PAIRING_MAX_FAILS,
    private windowMs = PAIRING_WINDOW_MS,
  ) {}

  isLocked(ip: string, now = Date.now()): boolean {
    const row = this.fails.get(ip);
    if (!row) return false;
    if (row.resetAt <= now) {
      this.fails.delete(ip);
      return false;
    }
    return row.count >= this.max;
  }

  fail(ip: string, now = Date.now()): number {
    const row = this.fails.get(ip);
    if (!row || row.resetAt <= now) {
      this.fails.set(ip, { count: 1, resetAt: now + this.windowMs });
      return 1;
    }
    row.count += 1;
    return row.count;
  }

  succeed(ip: string): void {
    this.fails.delete(ip);
  }
}

/** 日志里去掉密钥。短串不替换,避免误伤普通单词。 */
export function redact(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  return out;
}
