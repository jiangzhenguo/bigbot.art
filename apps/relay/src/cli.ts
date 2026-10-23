/**
 * 中继进程入口。配对密钥只在第一次生成时打印到标准输出,不进日志函数。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { redact } from './auth.js';
import { startRelay, type RelayHandle, type RelayLogger } from './server.js';

export function loadPairingKey(dataDir: string, fromEnv: string | undefined): { key: string; generated: boolean } {
  if (fromEnv) {
    if (fromEnv.length < 16) throw new Error('BBA_RELAY_PAIRING_KEY 过短');
    return { key: fromEnv, generated: false };
  }
  const file = join(dataDir, 'pairing.key');
  if (existsSync(file)) {
    const key = readFileSync(file, 'utf8').trim();
    if (key.length < 16) throw new Error('pairing.key 过短');
    return { key, generated: false };
  }
  const key = randomBytes(32).toString('base64url');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { key, generated: true };
}

export async function startFromEnv(env: NodeJS.ProcessEnv = process.env, logger?: RelayLogger): Promise<RelayHandle> {
  const dataDir = env.BBA_RELAY_DATA_DIR || '/var/lib/bigbotart-relay';
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dataDir, 0o700);
  } catch {
    /* 目录已存在且不属于当前用户时不阻断 */
  }
  const { key, generated } = loadPairingKey(dataDir, env.BBA_RELAY_PAIRING_KEY);
  if (generated) {
    console.log(`BigBotArt 中继配对密钥(只显示这一次,请抄到 Mac 的设置里): ${key}`);
  }
  const mode = env.BBA_RELAY_MODE === 'http' ? 'http' : 'https';
  const wrapped: RelayLogger = {
    log: (level, message) => {
      const safe = redact(message, [key]);
      if (logger) logger.log(level, safe);
      else if (level === 'error') console.error(safe);
      else console.log(safe);
    },
  };
  const httpPort = Number(env.BBA_RELAY_PORT || env.BBA_RELAY_HTTP_PORT || (mode === 'http' ? 8080 : 80));
  return startRelay({
    pairingKey: key,
    mode,
    listenHost: env.BBA_RELAY_LISTEN || (mode === 'http' ? '127.0.0.1' : '0.0.0.0'),
    httpPort,
    httpsPort: Number(env.BBA_RELAY_HTTPS_PORT || 443),
    challengePort: Number(env.BBA_RELAY_HTTP_PORT || 80),
    domain: env.BBA_RELAY_DOMAIN,
    email: env.BBA_RELAY_EMAIL,
    certPath: env.BBA_RELAY_CERT,
    keyPath: env.BBA_RELAY_KEY,
    dataDir,
    acmeDirectory: env.BBA_RELAY_ACME_DIRECTORY,
    logger: wrapped,
  });
}

async function main(): Promise<void> {
  const handle = await startFromEnv();
  const shutdown = () => {
    void handle.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((e: unknown) => {
    console.error(`中继启动失败: ${(e as Error).message}`);
    process.exit(1);
  });
}
