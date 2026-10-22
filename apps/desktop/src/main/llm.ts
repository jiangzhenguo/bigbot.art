/**
 * LLM 来源运行时支撑(设置页五档单选的真实后端)
 * - 本地运行时:LM Studio / Ollama / pi-mlx(mlx_lm.server)的模型枚举与加载
 * - 远端:/v1/models 枚举 + 连接检查
 * - 凭据:macOS 钥匙串(security CLI),key 绝不落盘/回传渲染进程
 * - resolveLlmEndpoint:把 LlmSource 解析成可直接对话的 {baseUrl, apiKey, model}
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  AppSettings,
  CloudProviderEntry,
  LlmConnectionTest,
  LlmProtocol,
  LlmSource,
  LocalModelInfo,
  LocalRuntimeModels,
} from '@bigbotart/shared';
import { isOpenCodeGoUrl } from '@bigbotart/shared';
import { readLmStudioContext, readOllamaContext } from './context-budget.js';

const execFileP = promisify(execFile);

const LMS_BASE = process.env.BIGBOTART_LMSTUDIO_URL ?? 'http://127.0.0.1:1234/v1';
const LMS_API = LMS_BASE.replace(/\/v1\/?$/, '') + '/api/v0';
const OLLAMA_BASE = process.env.BIGBOTART_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const PIMLX_PORT = Number(process.env.BIGBOTART_PIMLX_PORT ?? 8099);
export const PIMLX_ENDPOINT = `http://127.0.0.1:${PIMLX_PORT}/v1`;

/* ---------- 统一内存总量 ---------- */
let cachedMemGb = 0;
export async function memTotalGb(): Promise<number> {
  if (cachedMemGb) return cachedMemGb;
  try {
    const { stdout } = await execFileP('/usr/sbin/sysctl', ['-n', 'hw.memsize']);
    cachedMemGb = Math.round(Number(stdout.trim()) / 1e9);
  } catch {
    cachedMemGb = 64;
  }
  return cachedMemGb;
}

/** 显存预估:权重 + KV cache + Metal 开销 ≈ 体积 × 1.13 */
const vramOf = (sizeBytes?: number): number | undefined =>
  sizeBytes ? Math.round((sizeBytes / 1e9) * 1.13 * 10) / 10 : undefined;

const fmtGb = (sizeBytes?: number): string | undefined =>
  sizeBytes ? `${(sizeBytes / 1e9).toFixed(1)} GB` : undefined;

/* ---------- 工具调用能力启发式(运行时不暴露时用名字判断) ---------- */
const NO_TOOL_RE = /embed|whisper|tts|bge|nomic|minilm|rerank/i;
function guessSupportsTools(id: string): boolean {
  return !NO_TOOL_RE.test(id);
}

async function getJson(url: string, apiKey?: string, timeoutMs = 4000): Promise<any> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ═══ LM Studio ═══ */

/**
 * `lms ls --json` 的真实清单(补 sizeBytes / 工具调用标记 —— REST 的 `/api/v0/models`
 * 常缺这两项)。
 *
 * ⚠️ **只在 LM Studio 已在运行时才允许调用**。LM Studio 的 `lms` CLI 自带「唤醒」逻辑
 * (二进制里是 `wakeUpServiceFromLocation` → `LM Studio started (PID …)`):服务没跑时,
 * 执行任何 `lms` 子命令都会把 LM Studio 拉起来。而本文件的探测函数全部被设置页 / 对话页 /
 * 引导页的**被动探测**调用(只想看清有哪些模型),绝不该有这种副作用。
 * 2026-10-21 用户反馈「进设置 → LLM 来源总是先闪一下 LM Studio,然后它被自动启动」,
 * 根因正是这里在服务未运行时也 exec 了 `lms ls`。
 */
async function readLmsCliModels(): Promise<Map<string, { size?: number; name?: string; tools?: boolean }>> {
  const cliInfo = new Map<string, { size?: number; name?: string; tools?: boolean }>();
  for (const cli of ['lms', join(homedir(), '.lmstudio', 'bin', 'lms')]) {
    try {
      const { stdout } = await execFileP(cli, ['ls', '--json'], { timeout: 10_000 });
      for (const m of JSON.parse(stdout) as any[]) {
        cliInfo.set(m.modelKey, {
          size: m.sizeBytes,
          name: m.displayName,
          tools: m.trainedForToolUse,
        });
      }
      break;
    } catch { /* 下个路径 */ }
  }
  return cliInfo;
}

export async function listLmStudio(): Promise<LocalRuntimeModels> {
  const mem = await memTotalGb();
  // ① 无副作用探活:`/v1/models` 新旧版本都有。服务没跑就到此为止 —— 绝不 exec lms。
  let probe: any;
  try {
    probe = await getJson(`${LMS_BASE}/models`, undefined, 3000);
  } catch (e) {
    return {
      kind: 'lmstudio', available: false, endpoint: LMS_BASE, models: [], memTotalGb: mem,
      detail: `未检测到 LM Studio(${LMS_BASE}):${(e as Error).message}`,
    };
  }
  // ② 服务确认在跑:此时 lms CLI 只是「连上去问一句」,不会再拉起任何东西
  const cliInfo = await readLmsCliModels();
  try {
    // 新版 REST API:全量已下载模型 + 加载状态
    const data = await getJson(`${LMS_API}/models`);
    const arr: any[] = Array.isArray(data) ? data : (data.data ?? data.models ?? []);
    const models: LocalModelInfo[] = arr
      .filter((m) => (m.type ?? 'llm') === 'llm' || m.type === 'vlm')
      .map((m): LocalModelInfo => {
        const cli = cliInfo.get(m.id);
        const size = m.size_bytes ?? m.sizeBytes ?? cli?.size;
        // capabilities 为字符串数组(如 ["tool_use"]);缺失时用 CLI 标记/名字启发式
        const tools = Array.isArray(m.capabilities)
          ? m.capabilities.includes('tool_use')
          : (m.capabilities?.trained_for_tool_use ?? m.trained_for_tool_use ?? cli?.tools ?? guessSupportsTools(m.id));
        const quant = m.quantization ? ` · ${m.quantization}` : '';
        return {
          id: m.id,
          displayName: (cli?.name ?? m.display_name ?? m.displayName ?? m.id) + quant,
          sizeBytes: size,
          vramGb: vramOf(size),
          supportsTools: !!tools,
          loaded: (m.loaded_instances?.length ?? 0) > 0 || m.state === 'loaded',
        };
      })
      .filter((m) => m.supportsTools);
    return { kind: 'lmstudio', available: true, endpoint: LMS_BASE, models, memTotalGb: mem };
  } catch {
    // 旧版兜底:仅 /v1/models(只有已加载模型)。复用 ① 的响应,不再二次请求
    const models: LocalModelInfo[] = (probe?.data ?? []).map((m: any) => ({
      id: m.id,
      supportsTools: guessSupportsTools(m.id),
      loaded: true,
    }));
    return { kind: 'lmstudio', available: true, endpoint: LMS_BASE, models, memTotalGb: mem };
  }
}

export async function loadLmStudio(modelId: string): Promise<{ ok: boolean; error?: string }> {
  // 首选 REST API(仅新版 LM Studio 有;注意旧版对该路径返回 HTTP 200 + 错误 JSON)
  try {
    const res = await fetch(`${LMS_API}/models/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId }),
      signal: AbortSignal.timeout(120_000),
    });
    const body: any = await res.json().catch(() => null);
    if (res.ok && body && !body.error) return { ok: true };
    if (res.ok || res.status !== 404) {
      console.warn(`[llm] LM Studio REST load 不可用(${body?.error ?? res.status}),回退 lms CLI`);
    }
  } catch {
    // 服务不可达,继续尝试 CLI
  }
  // 兜底:lms CLI(PATH 与默认安装路径都试)
  const cliPaths = ['lms', join(homedir(), '.lmstudio', 'bin', 'lms')];
  let lastErr = 'lms CLI 不可用';
  for (const cli of cliPaths) {
    try {
      await execFileP(cli, ['load', modelId, '--yes'], { timeout: 180_000 });
      return { ok: true };
    } catch (e) {
      lastErr = (e as Error).message.slice(0, 200);
    }
  }
  return { ok: false, error: `模型加载失败: ${lastErr}` };
}

/* ═══ Ollama ═══ */
export async function listOllama(): Promise<LocalRuntimeModels> {
  const mem = await memTotalGb();
  try {
    const [tags, ps] = await Promise.all([
      getJson(`${OLLAMA_BASE}/api/tags`),
      getJson(`${OLLAMA_BASE}/api/ps`).catch(() => ({ models: [] })),
    ]);
    const loadedSet = new Set<string>((ps.models ?? []).map((m: any) => m.name ?? m.model));
    const models: LocalModelInfo[] = (tags.models ?? [])
      .map((m: any): LocalModelInfo => ({
        id: m.name,
        displayName: m.name,
        sizeBytes: m.size,
        vramGb: vramOf(m.size),
        supportsTools: guessSupportsTools(m.name),
        loaded: loadedSet.has(m.name) || loadedSet.has(m.model ?? m.name),
      }))
      .filter((m: LocalModelInfo) => m.supportsTools);
    return {
      kind: 'ollama', available: true, endpoint: `${OLLAMA_BASE}/v1`, models, memTotalGb: mem,
    };
  } catch (e) {
    return {
      kind: 'ollama', available: false, endpoint: `${OLLAMA_BASE}/v1`, models: [], memTotalGb: mem,
      detail: `未检测到 Ollama(${OLLAMA_BASE}):${(e as Error).message}`,
    };
  }
}

export async function loadOllama(modelId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    // 空 prompt 热加载并驻留 30 分钟
    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, keep_alive: '30m' }),
      signal: AbortSignal.timeout(180_000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 404) {
      return { ok: false, error: `模型未安装,请先执行: ollama pull ${modelId}` };
    }
    return { ok: false, error: `Ollama 加载失败 HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: `Ollama 不可达: ${(e as Error).message}` };
  }
}

/* ═══ pi-mlx(mlx_lm.server 直跑,模型按需从 HuggingFace 下载) ═══ */

/** pi-mlx 候选清单(mlx-community 常用工具调用模型;本机 HF 缓存里已下载的优先) */
const PIMLX_PRESETS: Array<{ hf: string; note?: string; sizeGb: number }> = [
  { hf: 'mlx-community/Qwen2.5-7B-Instruct-4bit', note: '推荐', sizeGb: 4.3 },
  { hf: 'mlx-community/Qwen2.5-VL-7B-Instruct-4bit', note: '识图', sizeGb: 4.7 },
  { hf: 'mlx-community/Llama-3.2-3B-Instruct-4bit', sizeGb: 1.9 },
];

let pimlxProc: ChildProcess | null = null;
let pimlxModel: string | null = null;

function hfCacheModels(): Map<string, number> {
  // ~/.cache/huggingface/hub/models--<org>--<name> → 体积
  const dir = join(homedir(), '.cache', 'huggingface', 'hub');
  const out = new Map<string, number>();
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith('models--')) continue;
    const id = entry.replace(/^models--/, '').replace(/--/g, '/');
    let size = 0;
    try {
      const walk = (p: string, depth: number): void => {
        if (depth > 4) return;
        for (const f of readdirSync(p, { withFileTypes: true })) {
          const fp = join(p, f.name);
          if (f.isDirectory()) walk(fp, depth + 1);
          else if (!f.name.endsWith('.part')) {
            try { size += statSync(fp).size; } catch { /* 忽略 */ }
          }
        }
      };
      walk(join(dir, entry, 'snapshots'), 0);
    } catch { /* 单个模型统计失败不影响整体 */ }
    out.set(id, size);
  }
  return out;
}

async function mlxLmAvailable(): Promise<boolean> {
  try {
    await execFileP('python3', ['-c', 'import mlx_lm'], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

export async function listPiMlx(): Promise<LocalRuntimeModels> {
  const mem = await memTotalGb();
  const ok = await mlxLmAvailable();
  if (!ok) {
    return {
      kind: 'pimlx', available: false, endpoint: PIMLX_ENDPOINT, models: [], memTotalGb: mem,
      detail: '未检测到 Python mlx_lm(pip install mlx-lm 后可用)',
    };
  }
  const cache = hfCacheModels();
  const models: LocalModelInfo[] = PIMLX_PRESETS.map((p) => {
    const size = cache.get(p.hf);
    return {
      id: p.hf,
      displayName: p.hf.split('/')[1],
      sizeBytes: size || p.sizeGb * 1e9,
      vramGb: vramOf(size || p.sizeGb * 1e9),
      supportsTools: true,
      loaded: pimlxModel === p.hf && !!pimlxProc,
      note: p.note,
      needsDownload: !size,
    };
  });
  return { kind: 'pimlx', available: true, endpoint: PIMLX_ENDPOINT, models, memTotalGb: mem };
}

export async function loadPiMlx(modelId: string): Promise<{ ok: boolean; error?: string }> {
  if (!(await mlxLmAvailable())) {
    return { ok: false, error: '未检测到 mlx_lm,请先 pip install mlx-lm' };
  }
  // 切换模型:先停旧 server
  if (pimlxProc) {
    pimlxProc.kill('SIGTERM');
    pimlxProc = null;
    pimlxModel = null;
  }
  const proc = spawn('python3', [
    '-m', 'mlx_lm.server', '--model', modelId, '--port', String(PIMLX_PORT), '--host', '127.0.0.1',
  ], { stdio: 'ignore', detached: false });
  pimlxProc = proc;
  proc.on('exit', () => {
    if (pimlxProc === proc) { pimlxProc = null; pimlxModel = null; }
  });
  // 等待端口就绪(首次需从 HuggingFace 下载,给 10 分钟)
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      pimlxProc = null;
      return { ok: false, error: 'mlx_lm.server 启动失败(查看主进程日志)' };
    }
    try {
      await getJson(`${PIMLX_ENDPOINT}/models`, undefined, 2000);
      pimlxModel = modelId;
      return { ok: true };
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return { ok: false, error: '等待 mlx_lm.server 就绪超时(模型较大时首次下载较慢)' };
}

/* ═══ 钥匙串(macOS security CLI;key 绝不落盘 settings.json) ═══ */
const KC_SERVICE = 'bigbotart';
const kcAccount = (providerId: string): string => `llm:${providerId}`;

export async function credentialSet(providerId: string, apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileP('security', [
      'add-generic-password', '-U', '-s', KC_SERVICE, '-a', kcAccount(providerId), '-w', apiKey,
    ]);
    return { ok: true };
  } catch (e) {
    // security CLI 失败时 message 会带上 argv,其中有 apiKey。不能原样回到渲染层或远程响应。
    const message = (e as Error).message.split(apiKey).join('***');
    return { ok: false, error: message };
  }
}

export async function credentialGet(providerId: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('security', [
      'find-generic-password', '-s', KC_SERVICE, '-a', kcAccount(providerId), '-w',
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function credentialDelete(providerId: string): Promise<{ ok: boolean }> {
  try {
    await execFileP('security', [
      'delete-generic-password', '-s', KC_SERVICE, '-a', kcAccount(providerId),
    ]);
    return { ok: true };
  } catch {
    return { ok: true }; // 不存在也算删除成功
  }
}

/* ═══ 远端:/v1/models 枚举 + 连接检查 ═══ */
async function resolveKey(input: { apiKey?: string; providerId?: string }): Promise<string | undefined> {
  if (input.apiKey) return input.apiKey;
  if (input.providerId) return (await credentialGet(input.providerId)) ?? undefined;
  return undefined;
}

export async function testConnection(input: {
  baseUrl: string; apiKey?: string; providerId?: string;
}): Promise<LlmConnectionTest> {
  const base = input.baseUrl.replace(/\/+$/, '');
  const t0 = Date.now();
  try {
    const key = await resolveKey(input);
    const data = await getJson(`${base}/models`, key, 8000);
    const count = Array.isArray(data?.data) ? data.data.length : undefined;
    return { ok: true, latencyMs: Date.now() - t0, modelCount: count, detail: 'v1 兼容' };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, detail: (e as Error).message };
  }
}

/**
 * OpenCode Go 里只提供 `/v1/responses` 的模型(官方 docs/go Endpoints 表)。
 *
 * 2026-10-20 起本 App **已支持该协议**(pi-chat 按 `resolveModelProtocol` 选 pi-ai 的
 * `openAIResponsesApi`),所以它们不再被过滤 —— 选它们会自动改走 /v1/responses。
 * 名单随官方变更;未知新模型默认仍按 chat 试探,撞上 ModelProtocolUnsupported 会自动切换(见 pi-chat)。
 */
export const OPENCODE_GO_RESPONSES_MODELS = new Set([
  'grok-4.7', 'grok-4.6',
  'gpt-6-luna', 'gpt-5.6-luna',
  'muse-spark-1.3-contributor', 'muse-spark-1.2-contributor',
]);

/**
 * OpenCode Go 里只提供 `/v1/messages`(Anthropic 形状)的模型(官方 docs/go Endpoints 表)。
 * 本 App 目前只实现 chat / responses 两套协议 —— 这些选了必失败,拉清单时滤掉。
 * 名单随官方变更;未知新模型默认放行(允许试探)。
 */
export const OPENCODE_GO_NON_CHAT_MODELS = new Set([
  // /v1/messages(Anthropic)
  'claude-haiku-5-5',
  'minimax-m3', 'minimax-m2.7', 'minimax-m2.5', 'minimax-m3.1-flash-free',
  'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus', 'qwen3.7-max', 'qwen3.6-plus',
  // Gemini 族
  'gemini-4-argon-contributor',
]);

/** 是否 OpenCode Go 端点(按 providerId 或 host 识别)。host 判定与 shared.isOpenCodeGoUrl 同口径。 */
export function isOpenCodeGoEndpoint(input: { providerId?: string; baseUrl?: string }): boolean {
  if (input.providerId === 'opencode-go') return true;
  return isOpenCodeGoUrl(input.baseUrl);
}

/** 该模型是否只提供 `/v1/responses`(本 App 已支持,会改走新协议)。 */
export function isOpenCodeGoResponsesModel(model: string | undefined): boolean {
  if (!model) return false;
  return OPENCODE_GO_RESPONSES_MODELS.has(model.trim().toLowerCase());
}

/** 过滤出本 App 可用的 OpenCode Go 模型。 */
export function filterOpenCodeGoModels(models: string[]): string[] {
  return models.filter((id) => !OPENCODE_GO_NON_CHAT_MODELS.has(id));
}

/** 该模型在 OpenCode Go 上是否只能走 /responses 或 /messages(即不能直接按 chat 发)。 */
export function isOpenCodeGoNonChatModel(model: string | undefined): boolean {
  return isOpenCodeGoResponsesModel(model) || (model ? OPENCODE_GO_NON_CHAT_MODELS.has(model.trim().toLowerCase()) : false);
}

/**
 * 决定某个模型该走哪套协议。优先级:
 * ① 显式选择(`LlmSource.protocol`)> ② 供应商 `modelProtocols[model]` > ③ 供应商 `protocol`
 * > ④ 内置知识表(OpenCode Go 的 responses 模型)> ⑤ 默认 `chat`。
 *
 * 为什么需要「单模型」粒度:同一供应商会混协议(OpenCode Go:deepseek/glm 走 chat、
 * grok/gpt-luna 走 responses),一个供应商级开关表达不了。
 */
export function resolveModelProtocol(
  input: {
    providerId?: string;
    baseUrl?: string;
    protocol?: LlmProtocol;
    modelProtocols?: Record<string, LlmProtocol>;
  },
  model: string | undefined,
): LlmProtocol {
  if (model && input.modelProtocols?.[model]) return input.modelProtocols[model]!;
  if (input.protocol) return input.protocol;
  if (isOpenCodeGoEndpoint({ providerId: input.providerId, baseUrl: input.baseUrl }) && isOpenCodeGoResponsesModel(model)) {
    return 'responses';
  }
  return 'chat';
}


/**
 * 存量设置自愈:清掉 OpenCode Go 供应商里「本 App 打不通」的模型,并把失效的选中模型落到首个可用模型。
 *
 * 为什么需要:`OPENCODE_GO_NON_CHAT_MODELS` 是后加的(官方把模型迁到 /responses、/messages 时),
 * 老 settings.json 不会自己更新 —— 2026-10-20 实测:设置里选着 `grok-4.6`,每轮对话都被端点
 * 400 `ModelProtocolUnsupported` 拒掉,而报错文案完全看不出「模型选错了协议」。
 * 纯函数(不写盘、不读钥匙串):返回 `{ next, fixes }`,由 SettingsStore 落盘 + 写日志。
 */
export function sanitizeOpenCodeGoSettings(settings: AppSettings): { next: AppSettings; fixes: string[] } {
  const fixes: string[] = [];
  const providers = settings.cloudProviders;
  if (!providers?.length) return { next: settings, fixes };

  let changed = false;
  const nextProviders = providers.map((p) => {
    if (!isOpenCodeGoEndpoint({ providerId: p.id, baseUrl: p.host })) return p;
    const all = p.models ?? [];
    const kept = filterOpenCodeGoModels(all);
    const dropped = all.filter((m) => !kept.includes(m));
    // 全被滤光时保留原列表:至少让用户看见自己配过什么;提交期由 resolveLlmEndpoint 明确报错
    if (!dropped.length || !kept.length) return p;
    changed = true;
    // 只滤 /v1/messages 模型(new-chat 家族);responses 模型已支持,不再清除
    fixes.push(`供应商「${p.name}」移除本应用未实现协议(/v1/messages)的模型:${dropped.join(' / ')}`);
    return { ...p, models: kept };
  });

  let next: AppSettings = changed ? { ...settings, cloudProviders: nextProviders } : settings;

  // 已选中的模型若失效,落到该供应商首个可用模型 —— 否则每次对话都撞同一个 400
  const llm = next.llm;
  if (llm?.kind === 'cloud' && llm.provider) {
    const prov = nextProviders.find((p) => p.id === llm.provider);
    if (prov && isOpenCodeGoEndpoint({ providerId: prov.id, baseUrl: prov.host })) {
      const usable = filterOpenCodeGoModels(prov.models ?? []);
      const cur = llm.model;
      // 只改「确定不可用」的选中项:只提供 /v1/messages 的模型(本 App 未实现) / 未选模型。
      // ⚠️ 这里刻意用 OPENCODE_GO_NON_CHAT_MODELS(messages 名单)而不是 isOpenCodeGoNonChatModel ——
      // 后者把 responses 模型也算「非 chat」,而 responses 已支持,误用会把 grok 的选中项又踢走。
      const broken = !!cur && OPENCODE_GO_NON_CHAT_MODELS.has(cur.trim().toLowerCase());
      if (usable.length && (!cur || broken)) {
        next = { ...next, llm: { ...llm, model: usable[0] } };
        fixes.push(
          `LLM 来源「${prov.name}」原来的模型「${cur ?? '(空)'}」不可用` +
            `(该模型只提供 /v1/messages 协议),已切换到「${usable[0]}」`,
        );
      }
    }
  }
  return { next, fixes };
}

export async function listRemoteModels(input: {
  baseUrl: string; apiKey?: string; providerId?: string;
}): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const base = input.baseUrl.replace(/\/+$/, '');
  try {
    const key = await resolveKey(input);
    const data = await getJson(`${base}/models`, key, 10_000);
    let models: string[] = (data?.data ?? []).map((m: any) => m.id).filter(Boolean);
    if (isOpenCodeGoEndpoint({ providerId: input.providerId, baseUrl: base })) {
      models = filterOpenCodeGoModels(models);
    }
    return { ok: true, models };
  } catch (e) {
    return { ok: false, models: [], error: (e as Error).message };
  }
}

/* ═══ LlmSource → 可直接对话的端点(主进程解析钥匙串;key 仅经单次 RPC 传 worker,不写 worker env) ═══ */
export interface ResolvedLlm {
  baseUrl: string;
  apiKey?: string;
  model: string;
  label: string; // 日志/报错用(不含 key)
  /** 该模型应使用的对话协议:chat = /v1/chat/completions,responses = /v1/responses */
  protocol: LlmProtocol;
}

/**
 * ResolvedLlm → worker 侧 LlmSource(单一收口)。
 * 为什么收口:此前 5 处调用点各写一份 `{kind:'openai-compatible', baseUrl, apiKey, model}`,
 * 新增字段(protocol)时漏一处的表现是「某个入口悄悄退回 chat 协议」——正是本次要消灭的故障形态。
 */
export function toChatLlm(ep: ResolvedLlm): LlmSource {
  return {
    kind: 'openai-compatible',
    baseUrl: ep.baseUrl,
    apiKey: ep.apiKey,
    model: ep.model,
    protocol: ep.protocol,
  };
}

export async function resolveLlmEndpoint(
  settings: AppSettings,
  llm: LlmSource | undefined,
): Promise<ResolvedLlm> {
  const src = llm ?? settings.llm ?? { kind: 'lmstudio' as const };
  switch (src.kind) {
    case 'lmstudio':
      return {
        baseUrl: LMS_BASE,
        model: src.model ?? settings.lmStudioModel ?? 'ornith-1.5-35b-a3b-abliterated-mlx',
        label: `LM Studio(${LMS_BASE})`,
        protocol: 'chat',
      };
    case 'ollama':
      if (!src.model) throw new Error('Ollama 未选择模型,请到设置页「加载模型」');
      return { baseUrl: `${OLLAMA_BASE}/v1`, model: src.model, label: `Ollama(${OLLAMA_BASE})`, protocol: 'chat' };
    case 'mlx-provider': {
      if (!pimlxProc || pimlxModel !== src.model) {
        throw new Error(`pi-mlx 模型未加载(${src.model}),请到设置页「加载模型」`);
      }
      return { baseUrl: PIMLX_ENDPOINT, model: src.model, label: `pi-mlx(:${PIMLX_PORT})`, protocol: 'chat' };
    }
    case 'openai-compatible':
      return {
        baseUrl: src.baseUrl,
        apiKey: src.apiKey ?? (await credentialGet('openai-compat')) ?? undefined,
        model: src.model ?? '',
        label: `OpenAI 兼容端点(${src.baseUrl})`,
        // 自建端点默认 chat;用户显式声明 responses(或该 host 是 OpenCode Go)时按知识表判定
        protocol: resolveModelProtocol(
          { baseUrl: src.baseUrl, protocol: src.protocol },
          src.model,
        ),
      };
    case 'cloud': {
      const prov: CloudProviderEntry | undefined = settings.cloudProviders?.find(
        (p) => p.id === src.provider,
      );
      if (!prov) throw new Error(`云端供应商不存在:${src.provider}`);
      if (!prov.enabled) throw new Error(`云端供应商已停用:${prov.name}`);
      const picked = src.model ?? prov.models[0];
      if (!picked) throw new Error(`供应商「${prov.name}」尚未添加模型`);
      const protocol = resolveModelProtocol(
        {
          providerId: prov.id,
          baseUrl: prov.host,
          protocol: src.protocol ?? prov.protocol,
          modelProtocols: prov.modelProtocols,
        },
        picked,
      );
      // 协议闸(2026-10-20):只拦**本 App 尚未实现**的 /v1/messages 模型(responses 已支持,不再拦)。
      // 放在取钥匙串之前 —— 这是配置错误,不是凭据错误,先给能直接执行的说法。
      if (
        protocol === 'chat' &&
        isOpenCodeGoEndpoint({ providerId: prov.id, baseUrl: prov.host }) &&
        isOpenCodeGoNonChatModel(picked) &&
        !isOpenCodeGoResponsesModel(picked)
      ) {
        const usable = filterOpenCodeGoModels(prov.models ?? []).slice(0, 6);
        throw new Error(
          `「${picked}」在 OpenCode Go 只提供 /v1/messages(Anthropic 形状)协议,` +
            `本应用目前支持 Chat Completions 与 Responses 两套。请到设置页「LLM 来源」改选:${
              usable.length ? usable.join(' / ') : '该供应商暂无可用模型,请添加'
            }`,
        );
      }
      const apiKey = await credentialGet(prov.id);
      if (!apiKey) throw new Error(`供应商「${prov.name}」未配置 API Key(设置页 → LLM 来源)`);
      return { baseUrl: prov.host, apiKey, model: picked, label: `云端 ${prov.name}`, protocol };
    }
    case 'none':
      throw new Error('未配置 LLM 来源');
  }
}

const contextLenCache = new Map<string, { tokens?: number; at: number }>();

/**
 * 读本地运行时已经加载的上下文长度。探不到返回 undefined,调用方用保守窗口。
 * 60 秒内同一端点+模型不重复打。失败不抛。
 */
export async function probeLoadedContextTokens(baseUrl: string, model: string): Promise<number | undefined> {
  const key = `${baseUrl}|${model}`;
  const hit = contextLenCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.tokens;
  const tokens = await probeLoadedContextUncached(baseUrl, model);
  contextLenCache.set(key, { tokens, at: Date.now() });
  return tokens;
}

async function probeLoadedContextUncached(baseUrl: string, model: string): Promise<number | undefined> {
  const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  try {
    const data = await getJson(`${root}/api/v0/models`, undefined, 1_500);
    const n = readLmStudioContext(data, model);
    if (n) return n;
  } catch {
    /* 不是 LM Studio,或服务没开这条路由 */
  }
  try {
    const res = await fetch(`${root}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(1_500),
    });
    if (!res.ok) return undefined;
    return readOllamaContext(await res.json());
  } catch {
    return undefined;
  }
}
