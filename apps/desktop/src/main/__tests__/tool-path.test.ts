import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packagedToolPath } from '../tool-path';

describe('packagedToolPath', () => {
  it('把 uv 的 ~/.local/bin 和 Homebrew 补进安装包 PATH', () => {
    const path = packagedToolPath('/usr/bin:/bin', '/Users/me');
    const parts = path.split(':');
    expect(parts).toContain('/Users/me/.local/bin');
    expect(parts).toContain('/opt/homebrew/bin');
    expect(parts).toContain('/usr/local/bin');
    expect(parts).toContain('/usr/bin');
  });

  it('已有的目录不重复', () => {
    const path = packagedToolPath('/opt/homebrew/bin:/usr/bin', '/Users/me');
    expect(path.split(':').filter((p) => p === '/opt/homebrew/bin')).toHaveLength(1);
  });

  it('主进程启动时真的用这份 PATH', () => {
    const src = readFileSync(join(__dirname, '../index.ts'), 'utf-8');
    expect(src).toContain('packagedToolPath');
  });
});
