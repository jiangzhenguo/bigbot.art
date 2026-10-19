/**
 * Agent 上下文预算(纯函数)。
 *
 * 窗口跟模型走,不跟一个写死的 10 万:
 * - 本地(LM Studio / Ollama / pi-mlx / 本机 OpenAI 兼容端点):用已加载的上下文长度,
 *   留出输出预算,工作集取输入预算的 60%,预填充慢,不把窗口填满。
 * - 云端 MiniMax-M3:窗口 100 万,在 48 万输入前压缩,避开更贵的 >512k 档,也避开上下文腐烂。
 * - 其他云端:按模型已知窗口,否则 12.8 万。
 *
 * 设了 BIGBOTART_AGENT_CONTEXT_WINDOW 时,它是上限,不是另一套默认值。
 */
import type { LlmSource } from '@bigbotart/shared';

/** 单轮输出预算。与 pi-chat 的默认 maxTokens 对齐,从窗口里留出来。 */
export const OUTPUT_RESERVE_CAP = 32_000;
/** 探不到本地加载长度时的保守窗口(常见 32k 档)。 */
export const LOCAL_UNKNOWN_WINDOW = 32_768;
/** 未知云端模型的窗口。 */
export const OTHER_CLOUD_WINDOW = 128_000;
export const MINIMAX_M3_WINDOW = 1_000_000;
/** M3 在 512k 输入后计费跳档;压缩线留在这之前。 */
export const MINIMAX_M3_COMPACT_AT = 480_000;
export const MINIMAX_M2_WINDOW = 204_800;
/** 系统提示把历史预算吃光时,仍给最近几轮留这么多 token。 */
export const MIN_HISTORY_TOKENS = 2_000;

export interface ContextPlan {
  placement: 'local' | 'cloud';
  /** 声明给框架 / 端点的上下文窗口 */
  windowTokens: number;
  /** 输入侧预算(窗口减去输出预留) */
  inputBudget: number;
  /**
   * 自动压缩线,也是本轮输入工作集上限(含系统提示)。
   * 历史按「这条线减去系统提示」装最近若干轮。
   */
  compactAt: number;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0;
  const rest = Math.max(0, text.length - cjk);
  return Math.max(1, Math.ceil(cjk / 1.5 + rest / 4));
}

export function isMinimaxM3(model?: string): boolean {
  return /minimax[-_ ]?m3(\b|[.-]|$)/i.test(model ?? '');
}

export function isMinimaxM2(model?: string): boolean {
  return /minimax[-_ ]?m2(\b|[.-]|$)/i.test(model ?? '');
}

function isLoopback(url?: string): boolean {
  return /localhost|127\.0\.0\.1|\[::1\]/i.test(url ?? '');
}

/** 本地推理 vs 云端。OpenAI 兼容端点看主机:回环算本地。 */
export function placementOf(source: LlmSource | undefined, baseUrl?: string): 'local' | 'cloud' {
  if (!source || source.kind === 'lmstudio' || source.kind === 'ollama' || source.kind === 'mlx-provider' || source.kind === 'none') {
    return 'local';
  }
  if (source.kind === 'openai-compatible') return isLoopback(source.baseUrl || baseUrl) ? 'local' : 'cloud';
  return 'cloud';
}

function envWindowCap(): number | undefined {
  const raw = process.env.BIGBOTART_AGENT_CONTEXT_WINDOW;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function planContext(input: {
  placement: 'local' | 'cloud';
  model?: string;
  /** 本地运行时已加载的上下文长度;没有则用保守窗口 */
  loadedContextTokens?: number;
}): ContextPlan {
  const cap = envWindowCap();
  let windowTokens: number;
  if (input.placement === 'local') {
    const loaded = input.loadedContextTokens;
    windowTokens = loaded && loaded > 0 ? Math.floor(loaded) : LOCAL_UNKNOWN_WINDOW;
  } else if (isMinimaxM3(input.model)) {
    windowTokens = MINIMAX_M3_WINDOW;
  } else if (isMinimaxM2(input.model)) {
    windowTokens = MINIMAX_M2_WINDOW;
  } else {
    windowTokens = OTHER_CLOUD_WINDOW;
  }
  if (cap) windowTokens = Math.min(windowTokens, cap);

  const outputReserve = Math.min(OUTPUT_RESERVE_CAP, Math.floor(windowTokens * 0.25));
  const inputBudget = Math.max(4_000, windowTokens - outputReserve);
  let compactAt: number;
  if (input.placement === 'local') {
    compactAt = Math.floor(inputBudget * 0.6);
  } else if (isMinimaxM3(input.model) && windowTokens >= MINIMAX_M3_COMPACT_AT) {
    compactAt = Math.min(inputBudget, MINIMAX_M3_COMPACT_AT);
  } else {
    compactAt = Math.floor(inputBudget * 0.75);
  }
  compactAt = Math.max(4_000, Math.min(compactAt, inputBudget));
  return { placement: input.placement, windowTokens, inputBudget, compactAt };
}

/** 系统提示占掉预算之后,历史还能用多少 token。 */
export function historyRoom(compactAt: number, systemTokens: number): number {
  return Math.max(MIN_HISTORY_TOKENS, compactAt - systemTokens);
}

/**
 * 从最新一条往回装,直到 token 预算用完。至少保留最新一条。
 */
export function packByTokens<T extends { content: string }>(items: T[], budget: number): T[] {
  if (items.length === 0) return [];
  const packed: T[] = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    const cost = estimateTokens(item.content) + 4;
    if (packed.length > 0 && used + cost > budget) break;
    packed.push(item);
    used += cost;
  }
  return packed.reverse();
}

/**
 * 自动压缩时从尾部保留多少条原始记录。
 * 工具留痕不占 token,但跟着相邻消息一起留下,避免把一对调用拆开。
 * 至少保留 minKeep 条(记录不够则全留)。
 */
export function tailKeepCount(
  entries: Array<{ role: string; content: string }>,
  tokenBudget: number,
  minKeep = 4,
): number {
  let used = 0;
  let n = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    const add = e.role === 'tool' ? 0 : estimateTokens(e.content);
    if (n >= minKeep && used + add > tokenBudget) break;
    used += add;
    n += 1;
  }
  return n;
}

/** 自动压缩用的确定性摘要。规则、技能、当前任务由系统提示每轮从磁盘再注入,不进这段。 */
export function foldRecallSummary(
  msgs: Array<{ role: string; content: string; toolName?: string }>,
): string {
  const lines = msgs.map((r) => {
    const who =
      r.role === 'user' ? '用户' : r.role === 'assistant' ? '助手' : r.role === 'system' ? '系统' : `工具(${r.toolName ?? '?'})`;
    return `${who} ${r.content}`.slice(0, 160);
  });
  return `【对话自动摘要】\n${lines.join('\n')}`.slice(0, 4_000);
}

/** 从 LM Studio /api/v0/models 的 JSON 里读已加载上下文长度。 */
export function readLmStudioContext(payload: unknown, modelId: string): number | undefined {
  const arr = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? ((payload as { data?: unknown; models?: unknown }).data ?? (payload as { models?: unknown }).models)
      : undefined;
  if (!Array.isArray(arr)) return undefined;
  const row = arr.find((m) => m && typeof m === 'object' && (m as { id?: string }).id === modelId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  const direct = num(row.loaded_context_length) ?? num(row.max_context_length);
  const instances = Array.isArray(row.loaded_instances) ? row.loaded_instances : [];
  for (const inst of instances) {
    if (!inst || typeof inst !== 'object') continue;
    const cfg = (inst as { config?: Record<string, unknown> }).config ?? {};
    const n =
      num((inst as Record<string, unknown>).context_length) ??
      num((inst as Record<string, unknown>).contextLength) ??
      num(cfg.context_length) ??
      num(cfg.contextLength) ??
      num(cfg.context_length_tokens);
    if (n) return n;
  }
  return direct;
}

/** 从 Ollama /api/show 的 model_info 里读 context_length。 */
export function readOllamaContext(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const info = (payload as { model_info?: Record<string, unknown> }).model_info;
  if (!info) return undefined;
  for (const [k, v] of Object.entries(info)) {
    if (/context_length$/i.test(k)) {
      const n = num(v);
      if (n) return n;
    }
  }
  return undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
