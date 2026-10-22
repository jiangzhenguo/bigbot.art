/**
 * Tailscale 只通过子进程查询,不嵌 SDK。
 * 绑定地址用 `tailscale ip -4`;身份用 `tailscale whois`。
 */
import { execFile } from 'node:child_process';

export type CommandRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<string>;

export const runCommand: CommandRunner = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout ?? ''));
    });
  });

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export async function tailscaleIpv4(run: CommandRunner = runCommand): Promise<string | null> {
  try {
    const out = await run('tailscale', ['ip', '-4'], 4000);
    for (const line of out.split('\n')) {
      const ip = line.trim();
      if (IPV4.test(ip)) return ip;
    }
    return null;
  } catch {
    return null;
  }
}

/** MagicDNS 名(去掉末尾的点)。失败返回 null,调用方只显示 IP。 */
export async function tailscaleDnsName(run: CommandRunner = runCommand): Promise<string | null> {
  try {
    const out = await run('tailscale', ['status', '--json'], 4000);
    const parsed = JSON.parse(out) as { Self?: { DNSName?: string } };
    const name = parsed.Self?.DNSName?.replace(/\.$/, '').trim();
    return name || null;
  } catch {
    return null;
  }
}

/** whois 的 LoginName。查不到(命令失败或没有用户)返回 null,调用方应拒绝而不是降级。 */
export async function tailscaleLogin(ip: string, run: CommandRunner = runCommand): Promise<string | null> {
  if (!IPV4.test(ip)) return null;
  try {
    const out = await run('tailscale', ['whois', '--json', ip], 4000);
    const parsed = JSON.parse(out) as { UserProfile?: { LoginName?: string } };
    const login = parsed.UserProfile?.LoginName?.trim();
    return login || null;
  } catch {
    return null;
  }
}

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const ip = address.replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1';
}
