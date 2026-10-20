import { join } from 'node:path';

/**
 * 访达 / Dock 启动的安装包只继承 /usr/bin:/bin。
 * uv 把 mlxgen 放在 ~/.local/bin;ffmpeg / ffprobe 常在 Homebrew。
 * 缺 ~/.local/bin 时 `spawn('mlxgen')` 直接 ENOENT(2026-10 安装包真实事故)。
 */
export function packagedToolPath(current: string | undefined, home: string): string {
  const parts = (current ?? '').split(':').filter(Boolean);
  const extra = [join(home, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];
  for (const dir of extra) {
    if (!parts.includes(dir)) parts.unshift(dir);
  }
  return parts.join(':');
}
