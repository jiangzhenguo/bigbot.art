/**
 * 公网端到端验收:走 nginx → 中继 → 隧道 → Mac 本机远程服务。
 * 用法:node scripts/verify-relay-public.mjs https://bigbot.art/bba <网页登录口令>
 */
import { WebSocket } from 'ws';

const base = (process.argv[2] ?? 'https://bigbot.art/bba').replace(/\/+$/, '');
const passphrase = process.argv[3] ?? '';
const ORIGIN = new URL(base).origin;

let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  else {
    failed += 1;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

console.log(`验收目标: ${base}\n`);

// 1) 页面
console.log('[1] 网页端');
const page = await fetch(`${base}/`);
const html = await page.text();
ok('GET / 返回 200', page.status === 200, `status=${page.status}`);
ok('是应用页面(有 #root 与标题)', html.includes('<div id="root">') && html.includes('<title>BigBotArt</title>'));
const asset = html.match(/src="\.\/assets\/([^"]+\.js)"/);
ok('资源引用是相对路径', !!asset, asset ? `./assets/${asset[1]}` : html.slice(0, 200));

// 2) 静态资源(前缀要跟文档一致)
if (asset) {
  const js = await fetch(`${base}/assets/${asset[1]}`);
  ok('GET /assets/*.js 返回 200', js.status === 200, `status=${js.status}`);
}

// 3) 登录
console.log('\n[2] 登录');
const bad = await fetch(`${base}/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: ORIGIN },
  body: JSON.stringify({ passphrase: 'wrong-passphrase' }),
});
ok('错误口令被拒(401)', bad.status === 401, `status=${bad.status}`);

const login = await fetch(`${base}/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: ORIGIN },
  body: JSON.stringify({ passphrase }),
});
const setCookie = login.headers.getSetCookie?.() ?? [];
const cookie = (setCookie[0] ?? '').split(';')[0] ?? '';
ok('正确口令登录成功(200)', login.status === 200, `status=${login.status}`);
ok('拿到会话 cookie', cookie.startsWith('bba_session='), cookie.slice(0, 24));
ok('cookie 带 Secure(公网是 https)', /;\s*Secure/i.test(setCookie[0] ?? ''), setCookie[0] ?? '');
ok('cookie HttpOnly', /;\s*HttpOnly/i.test(setCookie[0] ?? ''));

// 4) RPC
console.log('\n[3] RPC');
const rpc = await fetch(`${base}/rpc`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
  body: JSON.stringify({ method: 'listProjects', params: [] }),
});
const rpcBody = await rpc.json().catch(() => null);
ok('listProjects 返回 200', rpc.status === 200, `status=${rpc.status}`);
ok('返回结构正确', !!rpcBody && rpcBody.ok === true && Array.isArray(rpcBody.result), JSON.stringify(rpcBody)?.slice(0, 120));

const noAuth = await fetch(`${base}/rpc`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: ORIGIN },
  body: JSON.stringify({ method: 'listProjects', params: [] }),
});
ok('没带 cookie 的 RPC 被拒(401)', noAuth.status === 401, `status=${noAuth.status}`);

// 5) 事件流(WebSocket)
console.log('\n[4] 事件流');
const wsUrl = `${ORIGIN.replace(/^http/, 'ws')}${base.replace(ORIGIN, '')}/events`;
await new Promise((resolve) => {
  const sock = new WebSocket(wsUrl, { headers: { cookie, origin: ORIGIN } });
  const timer = setTimeout(() => {
    console.log(`  ✗ 事件流 5 秒内没连上 (${wsUrl})`);
    failed += 1;
    sock.close();
    resolve();
  }, 5000);
  sock.on('open', () => {
    clearTimeout(timer);
    console.log(`  ✓ 事件流已连接 — ${wsUrl}`);
    sock.close();
    resolve();
  });
  sock.on('error', (e) => {
    clearTimeout(timer);
    console.log(`  ✗ 事件流连不上 — ${e.message}`);
    failed += 1;
    resolve();
  });
});

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
