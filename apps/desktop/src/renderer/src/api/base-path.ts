/**
 * 网页模式的公网路径前缀。
 *
 * 推导自**文档自己的 URL 目录**,不靠配置也不靠注入:
 * 网页端的静态资源是相对路径(./assets/…),由文档 URL 解析;
 * 所以资源与 API 必须共用同一个基目录,否则会出现
 * 「资源在 /assets/ 而 API 在 /bba/rpc」这种两边对不上的局面。
 *
 * 例:
 *   文档 https://bigbot.art/bba/   → 前缀 /bba  → /rpc 变成 /bba/rpc
 *   文档 http://127.0.0.1:47321/    → 前缀空     → /rpc 不变
 *
 * ⚠️ 本应用没有前端路由(无 react-router,页面切换走 state),
 * 所以 location.pathname 恒等于文档目录。若将来引入客户端路由
 * (pathname 会随页面变),这里必须改成从服务端注入的固定值。
 */

/** 网页模式的基目录前缀(空串 = 根路径)。 */
export function basePath(): string {
  if (typeof window === 'undefined') return '';
  // 桌面(Electron)不走这条路:preload 已经挂了 IPC 版 API。
  if (window.bigbotartShell !== false) return '';
  // 取文档所在目录:'/bba/' → '/bba/' ,'/index.html' → '/'
  const dir = window.location.pathname.replace(/[^/]*$/, '');
  const trimmed = dir.replace(/\/+$/, '');
  return trimmed === '' ? '' : trimmed;
}

/** 给绝对路径加基目录前缀。非网页模式原样返回。 */
export function apiPath(p: string): string {
  const b = basePath();
  if (!b) return p;
  return p.startsWith('/') ? `${b}${p}` : `${b}/${p}`;
}
