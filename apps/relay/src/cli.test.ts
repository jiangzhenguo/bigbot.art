import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPairingKey, startFromEnv } from './cli.js';
import type { RelayHandle } from './server.js';

const open: RelayHandle[] = [];

afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

describe('中继命令入口', () => {
  it('环境变量里的密钥不打印', async () => {
    const key = 'env-pairing-key-not-printed';
    const dir = mkdtempSync(join(tmpdir(), 'bba-relay-cli-'));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handle = await startFromEnv({
      BBA_RELAY_MODE: 'http',
      BBA_RELAY_PORT: '0',
      BBA_RELAY_DATA_DIR: dir,
      BBA_RELAY_PAIRING_KEY: key,
      BBA_RELAY_LISTEN: '127.0.0.1',
    });
    open.push(handle);
    const text = spy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(text).not.toContain(key);
    expect(text).toContain('中继已监听');
    spy.mockRestore();
  });

  it('第一次生成密钥并写入 0600,第二次不再打印', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bba-relay-key-'));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const first = loadPairingKey(dir, undefined);
    expect(first.generated).toBe(true);
    console.log(`BigBotArt 中继配对密钥(只显示这一次,请抄到 Mac 的设置里): ${first.key}`);
    const mode = statSync(join(dir, 'pairing.key')).mode & 0o777;
    expect(mode).toBe(0o600);
    const second = loadPairingKey(dir, undefined);
    expect(second.generated).toBe(false);
    expect(second.key).toBe(first.key);
    const printed = spy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(printed).toContain(first.key);
    expect(printed.match(/只显示这一次/g)).toHaveLength(1);
    spy.mockRestore();
  });
});
