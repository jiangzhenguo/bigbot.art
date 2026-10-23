/**
 * Let's Encrypt HTTP-01。测试不走这里;调用方要先把 80 端口的质询路由挂上。
 * 账户密钥和证书落在数据目录,模式 0600。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import * as acme from 'acme-client';

export const RENEW_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;
export const LETSENCRYPT_PRODUCTION = acme.directory.letsencrypt.production;

export interface CertMaterial {
  cert: string;
  key: string;
}

function pem(value: string | Buffer): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}

function writeSecret(file: string, body: string | Buffer): void {
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function loadCertFiles(certPath: string, keyPath: string): CertMaterial {
  return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') };
}

export function readStoredCert(dataDir: string): CertMaterial | null {
  const certPath = join(dataDir, 'cert.pem');
  const keyPath = join(dataDir, 'key.pem');
  if (!existsSync(certPath) || !existsSync(keyPath)) return null;
  return loadCertFiles(certPath, keyPath);
}

export function needsRenewal(certPem: string, now = Date.now()): boolean {
  const exp = new Date(new X509Certificate(certPem).validTo).getTime();
  if (Number.isNaN(exp)) return true;
  return exp - now < RENEW_WITHIN_MS;
}

export async function obtainCertificate(opts: {
  domain: string;
  email: string;
  directoryUrl: string;
  dataDir: string;
  onChallenge: (token: string, keyAuthorization: string) => void;
  removeChallenge: (token: string) => void;
}): Promise<CertMaterial> {
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  const accountPath = join(opts.dataDir, 'acme-account.pem');
  const accountKey = existsSync(accountPath) ? readFileSync(accountPath) : await acme.crypto.createPrivateKey();
  if (!existsSync(accountPath)) writeSecret(accountPath, accountKey);
  const client = new acme.Client({ directoryUrl: opts.directoryUrl, accountKey });
  const [key, csr] = await acme.crypto.createCsr({ commonName: opts.domain, altNames: [opts.domain] });
  const issued = await client.auto({
    csr,
    email: opts.email,
    termsOfServiceAgreed: true,
    challengePriority: ['http-01'],
    challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
      if (challenge.type !== 'http-01') throw new Error(`只支持 http-01,收到 ${challenge.type}`);
      opts.onChallenge(challenge.token, keyAuthorization);
    },
    challengeRemoveFn: async (_authz, challenge) => {
      opts.removeChallenge(challenge.token);
    },
  });
  const material = { cert: pem(issued), key: pem(key) };
  writeSecret(join(opts.dataDir, 'cert.pem'), material.cert);
  writeSecret(join(opts.dataDir, 'key.pem'), material.key);
  return material;
}
