/**
 * 中继配对密钥。不进 settings.json,getSettings() 也拿不到。
 * 系统钥匙串可用时用 safeStorage;否则落到数据目录的 0600 文件。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';

const FILE = 'relay-pairing.bin';

function fileOf(dataDir: string): string {
  return join(dataDir, FILE);
}

export function readPairingKey(dataDir: string): string | null {
  const file = fileOf(dataDir);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file);
    const tag = raw.subarray(0, 1).toString('utf8');
    const rest = raw.subarray(1);
    if (tag === 'S') {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const text = safeStorage.decryptString(rest);
      return text || null;
    }
    if (tag === 'P') {
      const text = rest.toString('utf8');
      return text || null;
    }
    return null;
  } catch {
    return null;
  }
}

export function writePairingKey(
  dataDir: string,
  key: string,
): { ok: true; encrypted: boolean } | { ok: false; error: string } {
  const file = fileOf(dataDir);
  if (!key) {
    rmSync(file, { force: true });
    return { ok: true, encrypted: true };
  }
  if (key.length < 16 || key.length > 256) return { ok: false, error: '配对密钥长度应为 16 到 256 个字符' };
  let encrypted = false;
  let body: Buffer;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      body = Buffer.concat([Buffer.from('S'), safeStorage.encryptString(key)]);
      encrypted = true;
    } else {
      body = Buffer.concat([Buffer.from('P'), Buffer.from(key, 'utf8')]);
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { ok: true, encrypted };
}
