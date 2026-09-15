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
  LlmSource,
  LocalModelInfo,
  LocalRuntimeModels,
} from '@bigbotart/shared';

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
export async function listLmStudio(): Promise<LocalRuntimeModels> {
  const mem = await memTotalGb();
  // lms CLI 有体积/参数/工具调用标记(API 的 /api/v0/models 常缺 sizeBytes),先拉来 enrich
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
    // 旧版兜底:仅 /v1/models(只有已加载模型)
    try {
      const data = await getJson(`${LMS_BASE}/models`);
      const models: LocalModelInfo[] = (data.data ?? []).map((m: any) => ({
        id: m.id,
        supportsTools: guessSupportsTools(m.id),
        loaded: true,
      }));
      return { kind: 'lmstudio', available: true, endpoint: LMS_BASE, models, memTotalGb: mem };
    } catch (e) {
      return {
        kind: 'lmstudio', available: false, endpoint: LMS_BASE, models: [], memTotalGb: mem,
        detail: `未检测到 LM Studio(${LMS_BASE}):${(e as Error).message}`,
      };
    }
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
    return { ok: false, error: (e as Error).message };
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

export async function listRemoteModels(input: {
  baseUrl: string; apiKey?: string; providerId?: string;
}): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const base = input.baseUrl.replace(/\/+$/, '');
  try {
    const key = await resolveKey(input);
    const data = await getJson(`${base}/models`, key, 10_000);
    const models: string[] = (data?.data ?? []).map((m: any) => m.id).filter(Boolean);
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
      };
    case 'ollama':
      if (!src.model) throw new Error('Ollama 未选择模型,请到设置页「加载模型」');
      return { baseUrl: `${OLLAMA_BASE}/v1`, model: src.model, label: `Ollama(${OLLAMA_BASE})` };
    case 'mlx-provider': {
      if (!pimlxProc || pimlxModel !== src.model) {
        throw new Error(`pi-mlx 模型未加载(${src.model}),请到设置页「加载模型」`);
      }
      return { baseUrl: PIMLX_ENDPOINT, model: src.model, label: `pi-mlx(:${PIMLX_PORT})` };
    }
    case 'openai-compatible':
      return {
        baseUrl: src.baseUrl,
        apiKey: src.apiKey ?? (await credentialGet('openai-compat')) ?? undefined,
        model: src.model ?? '',
        label: `OpenAI 兼容端点(${src.baseUrl})`,
      };
    case 'cloud': {
      const prov: CloudProviderEntry | undefined = settings.cloudProviders?.find(
        (p) => p.id === src.provider,
      );
      if (!prov) throw new Error(`云端供应商不存在:${src.provider}`);
      if (!prov.enabled) throw new Error(`云端供应商已停用:${prov.name}`);
      const apiKey = await credentialGet(prov.id);
      if (!apiKey) throw new Error(`供应商「${prov.name}」未配置 API Key(设置页 → LLM 来源)`);
      const model = src.model ?? prov.models[0];
      if (!model) throw new Error(`供应商「${prov.name}」尚未添加模型`);
      return { baseUrl: prov.host, apiKey, model, label: `云端 ${prov.name}` };
    }
    case 'none':
      throw new Error('未配置 LLM 来源');
  }
}
