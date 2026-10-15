/**
 * 图片下载确认闸的纯判定。
 *
 * 用户消息里已经出现过的 http(s) 地址视为「用户指定了这张图」,可以直接下载。
 * 搜索结果、系统记录、模型自己拼出来的地址不在用户原文里,必须先弹确认卡。
 * 只认 role=user 的历史和本轮用户输入,不认系统记录(那里会回放工具摘要,容易把搜索到的链接误当成用户授权)。
 */

export function userCorpusFromChat(
  currentText: string,
  history: Array<{ role: string; content: string }>,
): string {
  return [...history.filter((m) => m.role === 'user').map((m) => m.content), currentText].join('\n');
}

/** 去掉空白和末尾斜杠,便于「用户少打了一个 /」时仍能对上 */
function fold(s: string): string {
  return s.replace(/\s+/g, '').replace(/\/+$/, '');
}

/**
 * 用户原文是否包含这张图的地址。
 * 完整 URL 优先;用户省略协议时,用 host+path 兜底(过短的片段不对,避免 `a.com` 误放行)。
 */
export function userSuppliedImageUrl(corpus: string, url: unknown): boolean {
  const raw = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  const folded = fold(corpus);
  if (folded.includes(fold(raw)) || folded.includes(fold(parsed.toString()))) return true;
  const hostPath = `${parsed.host}${parsed.pathname}${parsed.search}`;
  return hostPath.length >= 12 && folded.includes(fold(hostPath));
}

/**
 * web.fetch_image 是否要先弹确认卡。
 * 非法地址返回 false:让工具自己报错,不必让用户对一个打不开的链接点确认。
 */
export function fetchImageNeedsConfirm(args: Record<string, unknown>, corpus: string): boolean {
  const raw = String(args.url ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) return false;
  return !userSuppliedImageUrl(corpus, raw);
}
