/**
 * OpenCode Go 套餐请求头。
 *
 * 官方要求(https://opencode.ai/docs/go/#where-can-i-use-it):
 * 1. 用自家 User-Agent(不要用泛用 SDK 名)
 * 2. 每个会话带稳定的 `x-opencode-session`(路由 + prompt cache)
 *
 * 缺头会 400 MissingSessionID。本 App 走自定义 bigbotart-llm 端点,
 * pi-ai 原生 opencode-go provider 不会自动替我们加这个头。
 */

/** 是否 OpenCode Go 端点(host 含 opencode.ai/zen/go)。 */
export function isOpenCodeGoUrl(baseUrl?: string): boolean {
  return /opencode\.ai\/zen\/go/i.test(baseUrl ?? '');
}

/** 产品 User-Agent(OpenCode 要求可识别的编码代理名)。 */
export const BIGBOTART_USER_AGENT = 'BigBotArt/1.0';

/** OpenCode Go 必填头。sessionId 应在同一次对话内保持稳定(推荐用 canvasId)。 */
export function openCodeGoHeaders(sessionId: string): Record<string, string> {
  return {
    'User-Agent': BIGBOTART_USER_AGENT,
    'x-opencode-session': sessionId,
  };
}

/**
 * 打 OpenCode Go 时并入必填头;其他端点原样返回。
 * 调用方自己的 Authorization / Content-Type 放在 base 里即可。
 */
export function withOpenCodeGoHeaders(
  baseUrl: string | undefined,
  sessionId: string,
  base: Record<string, string> = {},
): Record<string, string> {
  if (!isOpenCodeGoUrl(baseUrl)) return base;
  return { ...base, ...openCodeGoHeaders(sessionId) };
}
