/**
 * 联网搜索与图片下载(纯函数 + 打桩 fetch,不访问外网)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clampSearchLimit,
  downloadImage,
  formatSearchHits,
  imageLabelFromUrl,
  isPrivateIp,
  parseBraveWebJson,
  parseDuckDuckGoHtml,
  parsePublicHttpUrl,
  resolveSearchProvider,
  searchWeb,
  sniffImageExt,
  unwrapDdgHref,
  webToolsEnabled,
} from '../web-fetch.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const publicLookup = async (host: string): Promise<string[]> => {
  if (host === 'evil.example.com') return ['10.0.0.5'];
  if (host === '127.0.0.1' || host === 'localhost') return ['127.0.0.1'];
  return ['1.1.1.1'];
};

describe('地址与内网判定', () => {
  it('只接受公网 http(s)', () => {
    expect(parsePublicHttpUrl('https://cdn.example.com/a.png').ok).toBe(true);
    expect(parsePublicHttpUrl('http://cdn.example.com/a.jpg').ok).toBe(true);
    for (const bad of ['', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@cdn.example.com/a.png', 'http://127.0.0.1/a.png', 'http://10.1.2.3/a.png', 'http://192.168.1.1/a.png', 'http://169.254.169.254/latest', 'http://localhost/a.png', 'http://[::1]/a.png']) {
      expect(parsePublicHttpUrl(bad).ok, bad).toBe(false);
    }
  });

  it('私网边界:172.16/12、CGNAT、组播算内网,8.8.8.8 与 172.15 不算', () => {
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('172.15.0.1')).toBe(false);
    expect(isPrivateIp('172.32.0.1')).toBe(false);
    expect(isPrivateIp('100.64.0.1')).toBe(true);
    expect(isPrivateIp('100.63.0.1')).toBe(false);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('224.0.0.1')).toBe(true);
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('2001:4860:4860::8888')).toBe(false);
  });
});

describe('搜索解析', () => {
  it('解开 DuckDuckGo 的 uddg 跳转,丢弃非 http 链接', () => {
    expect(unwrapDdgHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1%26y%3D2&rut=abc'))
      .toBe('https://example.com/a?x=1&y=2');
    expect(unwrapDdgHref('https://example.com/direct')).toBe('https://example.com/direct');
    expect(unwrapDdgHref('javascript:alert(1)')).toBe('');
  });

  it('从 HTML 抽出标题、真实链接和摘要', () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=1">Example Title</a>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">A short snippet.</a>
      <a href="https://zh.example.com/direct" class="result__a">中文标题</a>
      <a class="result__snippet">第二段摘要</a>
    `;
    const hits = parseDuckDuckGoHtml(html, 5);
    expect(hits).toEqual([
      { title: 'Example Title', url: 'https://example.com/page', snippet: 'A short snippet.' },
      { title: '中文标题', url: 'https://zh.example.com/direct', snippet: '第二段摘要' },
    ]);
  });

  it('Brave JSON 只收带标题的 http 结果,并按 limit 截断', () => {
    const hits = parseBraveWebJson({
      web: {
        results: [
          { title: '甲', url: 'https://a.example/1', description: '摘要甲' },
          { title: '', url: 'https://a.example/2', description: '无标题' },
          { title: '乙', url: 'ftp://a.example/3', description: '协议不对' },
          { title: '丙', url: 'https://a.example/4', description: '摘要丙' },
        ],
      },
    }, 1);
    expect(hits).toEqual([{ title: '甲', url: 'https://a.example/1', snippet: '摘要甲' }]);
  });

  it('结果文案声明不要自动下载', () => {
    const text = formatSearchHits('庭院', [{ title: '甲', url: 'https://a.example', snippet: '' }], 'DuckDuckGo');
    expect(text).toContain('不要自动下载');
    expect(text).toContain('https://a.example');
  });

  it('搜索源:默认 DuckDuckGo,brave 缺密钥则报错', () => {
    expect(resolveSearchProvider({}).provider).toBe('duckduckgo');
    expect(resolveSearchProvider({ BIGBOTART_SEARCH_PROVIDER: 'ddg' }).provider).toBe('duckduckgo');
    const missing = resolveSearchProvider({ BIGBOTART_SEARCH_PROVIDER: 'brave' });
    expect(missing.provider).toBe('error');
    const brave = resolveSearchProvider({ BIGBOTART_SEARCH_PROVIDER: 'brave', BIGBOTART_SEARCH_API_KEY: 'k' });
    expect(brave).toEqual({ provider: 'brave', apiKey: 'k' });
    expect(clampSearchLimit('9')).toBe(8);
    expect(clampSearchLimit('0')).toBe(1);
    expect(clampSearchLimit(undefined)).toBe(5);
    expect(webToolsEnabled({ BIGBOTART_WEB: '0' })).toBe(false);
    expect(webToolsEnabled({})).toBe(true);
  });
});

describe('searchWeb(打桩)', () => {
  it('DuckDuckGo:把检索词发出去,并格式化结果', async () => {
    let body = '';
    const res = await searchWeb('中式庭院', 3, {
      env: {},
      lookup: publicLookup,
      fetch: async (_url, init) => {
        body = String(init?.body ?? '');
        const html = `<a class="result__a" href="https://example.com/yuan">庭院</a><a class="result__snippet">白墙</a>`;
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
      },
    });
    expect(body).toContain('q=');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain('https://example.com/yuan');
      expect(res.text).toContain('DuckDuckGo');
    }
  });

  it('Brave:带密钥请求,401 时说明是鉴权失败', async () => {
    const headers: string[] = [];
    const denied = await searchWeb('猫', 2, {
      env: { BIGBOTART_SEARCH_PROVIDER: 'brave', BIGBOTART_SEARCH_API_KEY: 'secret' },
      lookup: publicLookup,
      fetch: async (_url, init) => {
        const h = new Headers(init?.headers);
        headers.push(h.get('X-Subscription-Token') ?? '');
        return new Response('no', { status: 401 });
      },
    });
    expect(headers).toEqual(['secret']);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain('鉴权');
  });

  it('BIGBOTART_WEB=0 时不发请求', async () => {
    let called = false;
    const res = await searchWeb('猫', 2, {
      env: { BIGBOTART_WEB: '0' },
      fetch: async () => {
        called = true;
        return new Response('no');
      },
    });
    expect(called).toBe(false);
    expect(res.ok).toBe(false);
  });
});

describe('图片嗅探与下载', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('按文件头识别 jpg/png/gif/webp/bmp,HTML 不算图片', () => {
    expect(sniffImageExt(PNG)).toBe('png');
    expect(sniffImageExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(sniffImageExt(Buffer.from('GIF89a'))).toBe('gif');
    const webp = Buffer.alloc(12);
    webp.write('RIFF', 0);
    webp.write('WEBP', 8);
    expect(sniffImageExt(webp)).toBe('webp');
    expect(sniffImageExt(Buffer.from('BM'))).toBe('bmp');
    expect(sniffImageExt(Buffer.from('<html>'))).toBe(null);
  });

  it('下载 PNG 落到 dataDir/downloads,并按 URL 起标题', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bbart-web-dl-'));
    dirs.push(dir);
    const res = await downloadImage('https://cdn.example.com/ref%20shot.png', {
      env: {},
      dataDir: dir,
      lookup: publicLookup,
      fetch: async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.path.startsWith(join(dir, 'downloads'))).toBe(true);
      expect(existsSync(res.path)).toBe(true);
      expect(readFileSync(res.path).equals(PNG)).toBe(true);
    }
    expect(imageLabelFromUrl('https://cdn.example.com/ref%20shot.png')).toBe('ref shot');
  });

  it('网页、超限、跳进内网都拒绝,且不落文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bbart-web-bad-'));
    dirs.push(dir);
    const html = await downloadImage('https://example.com/page', {
      env: {},
      dataDir: dir,
      lookup: publicLookup,
      fetch: async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    expect(html.ok).toBe(false);
    if (!html.ok) expect(html.error).toContain('不是图片');

    const big = await downloadImage('https://cdn.example.com/huge.png', {
      env: {},
      dataDir: dir,
      lookup: publicLookup,
      fetch: async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(20 * 1024 * 1024) } }),
    });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error).toContain('15MB');

    let secondHop = false;
    const redirected = await downloadImage('https://start.example.com/go', {
      env: {},
      dataDir: dir,
      lookup: publicLookup,
      fetch: async (input) => {
        const url = String(input);
        if (url.includes('start.example.com')) {
          return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret.png' } });
        }
        secondHop = true;
        return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
      },
    });
    expect(secondHop).toBe(false);
    expect(redirected.ok).toBe(false);
    if (!redirected.ok) expect(redirected.error).toContain('拒绝访问');

    const dnsPrivate = await downloadImage('https://evil.example.com/a.png', {
      env: {},
      dataDir: dir,
      lookup: publicLookup,
      fetch: async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    expect(dnsPrivate.ok).toBe(false);
    if (!dnsPrivate.ok) expect(dnsPrivate.error).toContain('内网');
  });

  it('公网重定向后仍下载到最终图片', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bbart-web-redir-'));
    dirs.push(dir);
    const res = await downloadImage('https://start.example.com/go', {
      env: {},
      dataDir: dir,
      lookup: publicLookup,
      fetch: async (input) => {
        if (String(input).includes('start.example.com')) {
          return new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/a.png' } });
        }
        return new Response(PNG, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      },
    });
    expect(res.ok).toBe(true);
  });
});
