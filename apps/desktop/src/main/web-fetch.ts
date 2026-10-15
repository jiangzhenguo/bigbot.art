/**
 * Agent 联网:搜索(只读)与图片直链下载。
 *
 * 搜索默认走 DuckDuckGo HTML(无需密钥);设 BIGBOTART_SEARCH_PROVIDER=brave
 * 且 BIGBOTART_SEARCH_API_KEY 时改用 Brave Search API。
 * 图片下载只收 http(s) 直链,拒绝内网地址(含 DNS 解析到内网)、拒绝网页/视频,
 * 单张上限 15MB,按文件头判定格式而不是只信 Content-Type。
 * BIGBOTART_WEB=0 时两个入口都明确拒绝。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
export const WEB_TIMEOUT_MS = 20_000;
export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_MAX_LIMIT = 8;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export type HostLookup = (hostname: string) => Promise<string[]>;

export interface WebDeps {
  fetch?: typeof fetch;
  lookup?: HostLookup;
  /** 覆盖进程环境(测试用) */
  env?: NodeJS.ProcessEnv;
  /** 图片暂存目录;缺省 ~/.bigbotart/downloads(在导入白名单内) */
  dataDir?: string;
}

export function webToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BIGBOTART_WEB !== '0';
}

export function clampSearchLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return SEARCH_DEFAULT_LIMIT;
  return Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.floor(n)));
}

/** 节点标题:用户没给 label 时用 URL 文件名,再不行用主机名 */
export function imageLabelFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
    const clean = base.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[^\p{L}\p{N}._ -]/gu, '').trim().slice(0, 40);
    if (clean) return clean;
    return u.host || '网络图片';
  } catch {
    return '网络图片';
  }
}

export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  return true;
}

function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map((x) => Number(x));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const a = p[0]!;
  const b = p[1]!;
  const c = p[2]!;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateV6(ip: string): boolean {
  const n = ip.toLowerCase();
  if (n === '::1' || n === '::') return true;
  const mapped = n.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateV4(mapped[1]);
  if (n.startsWith('fc') || n.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(n)) return true;
  return false;
}

/** Node 的 URL.hostname 对 IPv6 会保留方括号(`[::1]`),isIP 认不出,先剥掉 */
function hostKey(url: URL): string {
  return url.hostname.replace(/\.$/, '').replace(/^\[|\]$/g, '').toLowerCase();
}

function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h === 'localhost.localdomain' || h === 'metadata' || h === 'metadata.google.internal') {
    return true;
  }
  return h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal');
}

/** 只接受 http(s),拒绝账号密码、本机名。不解析 DNS(那一步在 assertPublicHttpUrl)。 */
export function parsePublicHttpUrl(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: false, error: '缺少图片地址' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: '地址不是合法的 URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: '只接受 http 或 https 图片直链' };
  }
  if (url.username || url.password) return { ok: false, error: '地址里不能带账号密码' };
  const host = hostKey(url);
  if (!host) return { ok: false, error: '地址缺少主机名' };
  if (isBlockedHost(host)) return { ok: false, error: `拒绝访问 ${host}(本机或内网名称)` };
  if (isIP(host) && isPrivateIp(host)) return { ok: false, error: `拒绝访问 ${host}(内网地址)` };
  return { ok: true, url };
}

async function defaultLookup(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows.map((r) => r.address);
}

async function assertPublicHttpUrl(raw: string, lookup: HostLookup): Promise<string> {
  const parsed = parsePublicHttpUrl(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  const host = hostKey(parsed.url);
  let ips: string[];
  try {
    ips = isIP(host) ? [host] : await lookup(host);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith('拒绝') || msg.startsWith('无法解析') || msg.startsWith('地址')) throw e;
    throw new Error(`无法解析域名 ${host}`);
  }
  if (!ips.length) throw new Error(`无法解析域名 ${host}`);
  for (const ip of ips) {
    if (!isIP(ip) || isPrivateIp(ip)) throw new Error(`拒绝访问 ${host}(解析到内网地址)`);
  }
  return parsed.url.toString();
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

function stripTags(s: string): string {
  return decodeHtml(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function attr(attrs: string, name: string): string {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = attrs.match(re);
  return decodeHtml(m?.[1] ?? m?.[2] ?? '');
}

/** DuckDuckGo 把外链包在 /l/?uddg= 里,这里还原成真实 http(s) 地址 */
export function unwrapDdgHref(href: string): string {
  if (!href) return '';
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    const target = uddg
      || ((u.protocol === 'http:' || u.protocol === 'https:') && !u.hostname.endsWith('duckduckgo.com') ? u.toString() : '');
    if (!target) return '';
    const parsed = new URL(target);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

export function parseDuckDuckGoHtml(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const anchorRe = /<a\b([^>]*?)>([\s\S]*?)<\/a>/gi;
  const anchors: Array<{ attrs: string; text: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html))) anchors.push({ attrs: m[1] ?? '', text: m[2] ?? '' });
  for (let i = 0; i < anchors.length && hits.length < limit; i++) {
    const a = anchors[i]!;
    if (!/\bresult__a\b/.test(a.attrs)) continue;
    const url = unwrapDdgHref(attr(a.attrs, 'href'));
    const title = stripTags(a.text);
    if (!url || !title) continue;
    let snippet = '';
    for (let j = i + 1; j < anchors.length && j < i + 6; j++) {
      if (/\bresult__a\b/.test(anchors[j]!.attrs)) break;
      if (/\bresult__snippet\b/.test(anchors[j]!.attrs)) {
        snippet = stripTags(anchors[j]!.text);
        break;
      }
    }
    hits.push({ title, url, snippet });
  }
  return hits;
}

export function parseBraveWebJson(body: unknown, limit: number): SearchHit[] {
  const web = (body as { web?: { results?: unknown } } | null)?.web?.results;
  if (!Array.isArray(web)) return [];
  const hits: SearchHit[] = [];
  for (const item of web) {
    if (hits.length >= limit) break;
    if (!item || typeof item !== 'object') continue;
    const r = item as { title?: unknown; url?: unknown; description?: unknown };
    const url = String(r.url ?? '').trim();
    const title = String(r.title ?? '').trim();
    if (!title || !/^https?:\/\//i.test(url)) continue;
    hits.push({ title, url, snippet: String(r.description ?? '').trim() });
  }
  return hits;
}

export function formatSearchHits(query: string, hits: SearchHit[], source: string): string {
  if (hits.length === 0) return `搜索「${query}」没有结果(来源:${source})。`;
  const lines = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet || '(无摘要)'}`);
  return [
    `搜索「${query}」${hits.length} 条(来源:${source})。这些结果只供回答和写提示词,不要自动下载或改画布。`,
    ...lines,
  ].join('\n');
}

export type SearchProvider =
  | { provider: 'duckduckgo' }
  | { provider: 'brave'; apiKey: string }
  | { provider: 'error'; error: string };

export function resolveSearchProvider(env: NodeJS.ProcessEnv = process.env): SearchProvider {
  const name = (env.BIGBOTART_SEARCH_PROVIDER ?? '').trim().toLowerCase();
  const key = (env.BIGBOTART_SEARCH_API_KEY ?? '').trim();
  if (name === 'brave') {
    if (!key) return { provider: 'error', error: '已指定 Brave 搜索,但没有设置 BIGBOTART_SEARCH_API_KEY' };
    return { provider: 'brave', apiKey: key };
  }
  if (name === '' || name === 'duckduckgo' || name === 'ddg') return { provider: 'duckduckgo' };
  return { provider: 'error', error: `未知搜索源「${name}」(可选 duckduckgo / brave)` };
}

export function sniffImageExt(buf: Uint8Array): 'jpg' | 'png' | 'webp' | 'gif' | 'bmp' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return 'webp';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return null;
}

function envOf(deps?: WebDeps): NodeJS.ProcessEnv {
  return deps?.env ?? process.env;
}

function fetchOf(deps?: WebDeps): typeof fetch {
  return deps?.fetch ?? fetch;
}

function lookupOf(deps?: WebDeps): HostLookup {
  return deps?.lookup ?? defaultLookup;
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  const len = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(len) && len > max) {
    throw new Error(`图片超过 ${Math.round(max / (1024 * 1024))}MB 上限`);
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) throw new Error(`图片超过 ${Math.round(max / (1024 * 1024))}MB 上限`);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`图片超过 ${Math.round(max / (1024 * 1024))}MB 上限`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function fetchChecked(rawUrl: string, init: RequestInit, deps: WebDeps): Promise<Response> {
  const doFetch = fetchOf(deps);
  const lookup = lookupOf(deps);
  let current = await assertPublicHttpUrl(rawUrl, lookup);
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;
  const headers = init.headers;
  for (let hop = 0; hop <= 4; hop++) {
    const res = await doFetch(current, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      redirect: 'manual',
      signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('重定向缺少 Location');
      current = await assertPublicHttpUrl(new URL(loc, current).toString(), lookup);
      if (res.status === 301 || res.status === 302 || res.status === 303) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    return res;
  }
  throw new Error('重定向次数过多');
}

function failNet(e: unknown, timeoutLabel: string): string {
  const err = e as Error;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return timeoutLabel;
  return err?.message || '网络请求失败';
}

export async function searchWeb(
  query: string,
  limitRaw: unknown,
  deps?: WebDeps,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const env = envOf(deps);
  if (!webToolsEnabled(env)) return { ok: false, error: '联网已关闭(BIGBOTART_WEB=0)' };
  const q = query.trim();
  if (!q) return { ok: false, error: '检索词为空' };
  if (q.length > 300) return { ok: false, error: '检索词过长(上限 300 字)' };
  const limit = clampSearchLimit(limitRaw);
  const provider = resolveSearchProvider(env);
  if (provider.provider === 'error') return { ok: false, error: provider.error };
  const ddgHint = '。若访问不到 DuckDuckGo,可改 BIGBOTART_SEARCH_PROVIDER=brave 并设置 BIGBOTART_SEARCH_API_KEY';
  try {
    if (provider.provider === 'brave') {
      const u = new URL('https://api.search.brave.com/res/v1/web/search');
      u.searchParams.set('q', q);
      u.searchParams.set('count', String(limit));
      u.searchParams.set('search_lang', 'zh-hans');
      const res = await fetchChecked(u.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': provider.apiKey,
        },
      }, deps ?? {});
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: 'Brave 搜索鉴权失败,请检查 BIGBOTART_SEARCH_API_KEY' };
      }
      if (!res.ok) return { ok: false, error: `搜索失败:HTTP ${res.status}` };
      const json = await res.json() as unknown;
      return { ok: true, text: formatSearchHits(q, parseBraveWebJson(json, limit), 'Brave') };
    }
    const res = await fetchChecked('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5',
        'User-Agent': UA,
      },
      body: new URLSearchParams({ q }),
    }, deps ?? {});
    if (!res.ok) return { ok: false, error: `搜索失败:HTTP ${res.status}${ddgHint}` };
    const html = await res.text();
    const hits = parseDuckDuckGoHtml(html, limit);
    if (hits.length === 0 && /captcha|anomaly|unfortunately/i.test(html)) {
      return {
        ok: false,
        error: `搜索被拦截${ddgHint}`,
      };
    }
    return { ok: true, text: formatSearchHits(q, hits, 'DuckDuckGo') };
  } catch (e) {
    const msg = failNet(e, '搜索超时(20 秒)');
    console.error(`[web.search] ${msg}`);
    const hint = provider.provider === 'duckduckgo' ? ddgHint : '';
    return { ok: false, error: `搜索失败:${msg}${hint}` };
  }
}

function rejectByContentType(ctype: string): string | null {
  if (ctype.includes('text/html') || ctype.includes('application/xhtml') || ctype.includes('text/plain') || ctype.includes('application/json')) {
    return '链接返回的不是图片(是网页或文本)。请给图片文件的直链';
  }
  if (ctype.includes('svg')) return '不支持 SVG,请给 jpg/png/webp/gif/bmp 直链';
  if (ctype.startsWith('video/') || ctype.startsWith('audio/')) return '这不是图片(当前只下载图片,不下载视频或音频)';
  return null;
}

export async function downloadImage(
  rawUrl: string,
  deps?: WebDeps,
): Promise<{ ok: true; path: string; bytes: number } | { ok: false; error: string }> {
  const env = envOf(deps);
  if (!webToolsEnabled(env)) return { ok: false, error: '联网已关闭(BIGBOTART_WEB=0)' };
  try {
    const res = await fetchChecked(rawUrl, {
      method: 'GET',
      headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif,image/bmp,*/*;q=0.1', 'User-Agent': UA },
    }, deps ?? {});
    if (!res.ok) return { ok: false, error: `下载失败:HTTP ${res.status}` };
    const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
    const rejected = rejectByContentType(ctype);
    if (rejected) return { ok: false, error: rejected };
    const buf = await readCapped(res, IMAGE_MAX_BYTES);
    if (buf.length === 0) return { ok: false, error: '图片内容是空的' };
    const ext = sniffImageExt(buf);
    if (!ext) return { ok: false, error: '文件内容不是受支持的图片(仅 jpg/png/webp/gif/bmp)' };
    const root = deps?.dataDir ?? env.BIGBOTART_HOME ?? join(homedir(), '.bigbotart');
    const dir = join(root, 'downloads');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
    writeFileSync(path, buf);
    return { ok: true, path, bytes: buf.length };
  } catch (e) {
    const msg = failNet(e, '下载超时(20 秒)');
    console.error(`[web.fetch_image] ${msg}`);
    return { ok: false, error: msg.startsWith('下载') || msg.startsWith('拒绝') || msg.startsWith('只接受') || msg.startsWith('地址') || msg.startsWith('无法') || msg.startsWith('图片') || msg.startsWith('重定向') || msg.startsWith('缺少')
      ? msg
      : `下载失败:${msg}` };
  }
}
