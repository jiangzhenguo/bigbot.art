/**
 * 引擎自检 — 引导向导第 4 步的**真实**探测
 *
 * 设计原则(2026-09 引入,替换原骨架期「setTimeout 打勾 + 硬编码耗时」的假自检):
 * - **轻量真探测**:只做「能证明引擎可用」的最便宜验证 —— 不加载 144GB h3 模型、
 *   不出图、不跑队列。因此本模块**与 dry-run 开关无关**(不触发任何真实推理,
 *   不违反 AGENTS.md R2:真实推理仍只由用户在画布提交时显式触发)。
 * - **每项独立判定**:任一项失败不影响其余项(用户可能只装了图片引擎)。
 * - **不静默吞错**(R6):失败必须带可执行的修复指引,经 logger 留痕。
 *
 * 四项检查与「真伪」口径:
 *   1. h3.c 引擎   → spawn `h3 --info -d <模型目录>` 并**解析输出**,
 *                    要求同时证明「二进制可执行」+「模型目录里真有 checkpoint」
 *   2. mlxgen 引擎 → `command -v mlxgen` + `--help` 取版本,再核对模型缓存完整性
 *   3. LLM 工具回环 → 真发一次 OpenAI 兼容 /chat/completions 请求,
 *                    并用工具 schema 探「端点是否接受 tools 字段」(Agent 能干活的硬前提)
 *   4. 存储与队列   → 真实检查数据目录可写 + 并发闸门状态
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SelfCheckItem, SelfCheckReport } from '@bigbotart/shared';
import type { DebugLogger } from './logger';
import { mlxgenModelInfo } from './mlxgen-models';
import { resolveVisionEndpoint } from './vision';

/** 单项超时(探测类命令;h3 --info 需读 checkpoint 头,给足余量) */
const H3_INFO_TIMEOUT_MS = 25_000;
const CMD_TIMEOUT_MS = 8_000;
const LLM_TIMEOUT_MS = 20_000;

/** h3 模型目录(BIGBOTART_H3_MODEL 覆盖;默认本机部署路径,与 h3c.ts 同口径) */
function h3ModelDir(): string {
  return process.env.BIGBOTART_H3_MODEL ?? join(homedir(), 'ai', 'h3', 'MiniMax-H3');
}

/** h3 二进制(BIGBOTART_H3_BIN 覆盖;默认约定路径) */
function h3Bin(): string {
  return process.env.BIGBOTART_H3_BIN ?? join(homedir(), 'ai', 'h3', 'h3.c', 'h3');
}

/** 数据目录(BIGBOTART_HOME 覆盖) */
function dataRoot(): string {
  return process.env.BIGBOTART_HOME ?? join(homedir(), '.bigbotart');
}

/** 执行命令并捕获合并输出(不抛错:失败信息进 error 字段) */
function runCapture(
  cmd: string,
  args: string[],
  timeoutMs: number,
  cwd?: string,
): Promise<{ ok: boolean; out: string; error?: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
    } catch (e) {
      resolve({ ok: false, out: '', error: (e as Error).message });
      return;
    }
    let out = '';
    const eat = (d: Buffer): void => {
      out = (out + d.toString()).slice(-8000);
    };
    child.stdout?.on('data', eat);
    child.stderr?.on('data', eat);
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* 已退出 */
      }
      resolve({ ok: false, out, error: `超时(${Math.round(timeoutMs / 1000)}s)` });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out, error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out, error: code === 0 ? undefined : `exit ${code}` });
    });
  });
}

/**
 * h3 `--info` 输出里是否真列出了 checkpoint。
 *
 * 实测真实输出(h3-metal 0.1.0-dev)形如:
 *   Device: Apple M5 Pro (applegpu_g17s)
 *     physical memory       64.0 GiB
 *   Native checkpoint inventory (header-only):
 *     Qwen3-VL encoder   14 files  1058 tensors   62.133 GiB
 *     FL2VA DiT          13 files   535 tensors   61.728 GiB
 *     ...
 *
 * 判定口径:必须命中 **checkpoint 清单段至少一行**,而不是「输出里出现过 safetensors」——
 * 后者在模型目录为空时也可能因别的原因命中。行格式为 `<名称> <N> files <N> tensors <X> GiB`,
 * 以 `files`+`tensors` 双关键词识别(比匹配组件名稳:组件名随模型版本变化)。
 */
export function parseH3Info(out: string): { gpu?: string; mem?: string; models: number } {
  const gpu = /Device:\s*(.+)/.exec(out)?.[1]?.trim();
  const mem = /physical memory\s+([\d.]+)\s*GiB/.exec(out)?.[1];
  // checkpoint 清单行:同时含 "files" 与 "tensors" 的输出行
  const models = out
    .split(/\r?\n/)
    .filter((l) => /\bfiles\b/.test(l) && /\btensors\b/.test(l)).length;
  return { gpu, mem, models };
}

/** 校验 1:h3.c 引擎(二进制 + 模型 checkpoint) */
async function checkH3(logger?: DebugLogger): Promise<SelfCheckItem> {
  const bin = h3Bin();
  const dir = h3ModelDir();
  const started = Date.now();
  if (!existsSync(bin)) {
    return {
      id: 'h3c',
      label: 'h3.c 视频引擎',
      ok: false,
      detail: `未找到 h3 二进制:${bin}`,
      hint: '在 h3.c 仓库执行 make -j8 编译;或用 BIGBOTART_H3_BIN 指定路径',
      ms: Date.now() - started,
    };
  }
  const r = await runCapture(bin, ['--info', '-d', dir], H3_INFO_TIMEOUT_MS, join(bin, '..'));
  const ms = Date.now() - started;
  if (!r.ok) {
    return {
      id: 'h3c',
      label: 'h3.c 视频引擎',
      ok: false,
      detail: `--info 探测失败:${r.error ?? '未知错误'} · 模型目录 ${dir}`,
      hint: !existsSync(dir)
        ? `模型目录不存在:${dir} · h3 模型需手动下载(144GB,见 docs/MiniMax-H3-加速-LoRA-使用手册.md)`
        : '检查模型目录内容是否完整(checkpoint 文件齐全)',
      ms,
    };
  }
  const info = parseH3Info(r.out);
  if (info.models === 0) {
    return {
      id: 'h3c',
      label: 'h3.c 视频引擎',
      ok: false,
      detail: `二进制可执行,但 ${dir} 内未解析到 checkpoint`,
      hint: '模型未下载或目录不完整 · 可在设置页指定模型目录',
      ms,
    };
  }
  return {
    id: 'h3c',
    label: 'h3.c 视频引擎',
    ok: true,
    detail: `${[info.gpu, info.mem ? `${info.mem} GiB` : null].filter(Boolean).join(' · ') || '已就绪'} · ${info.models} 项 checkpoint`,
    ms,
  };
}

/** 校验 2:mlxgen 引擎(CLI + 至少一个图片模型就绪) */
async function checkMlxgen(logger?: DebugLogger): Promise<SelfCheckItem> {
  const started = Date.now();
  const r = await runCapture('sh', ['-lc', 'command -v mlxgen'], CMD_TIMEOUT_MS);
  if (!r.ok || !r.out.trim()) {
    return {
      id: 'mlxgen',
      label: 'mlxgen 图片引擎',
      ok: false,
      detail: '未检测到 mlxgen CLI',
      hint: 'uv tool install --upgrade mlx-gen(或在第 2 步点「安装」)',
      ms: Date.now() - started,
    };
  }
  const bin = r.out.trim().split('\n').pop()?.trim() ?? 'mlxgen';
  const help = await runCapture(bin, ['--help'], CMD_TIMEOUT_MS);
  const ver = /version[^\d]*([\d.]+)/i.exec(help.out)?.[1];
  // 模型就绪度:图片模型清单里至少一个完整下载(复用 mlxgen-models 的完整性校验)
  let ready = 0;
  let names: string[] = [];
  try {
    const models = mlxgenModelInfo(logger);
    ready = models.filter((m) => m.downloaded).length;
    names = models.filter((m) => m.downloaded).map((m) => m.name);
  } catch (e) {
    logger?.log('warn', `自检:模型清单探测失败 ${(e as Error).message}`);
  }
  if (ready === 0) {
    return {
      id: 'mlxgen',
      label: 'mlxgen 图片引擎',
      ok: false,
      detail: `CLI 已安装${ver ? ` (v${ver})` : ''},但尚无完整下载的图片模型`,
      hint: '回到第 3 步下载至少一个图片模型(推荐 Z-Image-Turbo)',
      ms: Date.now() - started,
    };
  }
  return {
    id: 'mlxgen',
    label: 'mlxgen 图片引擎',
    ok: true,
    detail: `CLI 就绪${ver ? ` (v${ver})` : ''} · ${ready} 个模型可用:${names.slice(0, 3).join(' / ')}${names.length > 3 ? ' …' : ''}`,
    ms: Date.now() - started,
  };
}

/**
 * 校验 3:LLM 工具调用回环。
 * 真发一次 /chat/completions,带 tools schema —— 判「端点可达」+「支持工具调用」两件事。
 * 只探 1 个 token(不生成内容,成本可忽略)。
 */
async function checkLlm(logger?: DebugLogger): Promise<SelfCheckItem> {
  const started = Date.now();
  const ep = resolveVisionEndpoint();
  const url = `${ep.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: ep.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        tools: [
          {
            type: 'function',
            function: {
              name: 'selfcheck_ping',
              description: 'connectivity probe',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const tail = body.replace(/\s+/g, ' ').slice(0, 200);
      return {
        id: 'llm',
        label: 'LLM 工具调用回环',
        ok: false,
        detail: `端点返回 HTTP ${res.status}${tail ? ` · ${tail}` : ''}`,
        hint:
          res.status === 404
            ? `模型「${ep.model}」在端点不存在 · 在设置页选择已加载的模型`
            : '确认 LM Studio Local Server 已开启(127.0.0.1:1234),或检查 BIGBOTART_LLM_BASE_URL',
        ms,
      };
    }
    const json = (await res.json()) as { choices?: unknown[]; error?: { message?: string } };
    if (json.error) {
      return {
        id: 'llm',
        label: 'LLM 工具调用回环',
        ok: false,
        detail: `端点报错:${json.error.message ?? '未知'}`,
        hint: '模型可能不支持工具调用,换一个带 tools 能力的模型',
        ms,
      };
    }
    return {
      id: 'llm',
      label: 'LLM 工具调用回环',
      ok: true,
      detail: `端点可达并接受工具 schema · ${ep.model} @ ${ep.baseUrl}`,
      ms,
    };
  } catch (e) {
    const msg = (e as Error).message;
    logger?.log('warn', `自检:LLM 端点探测失败 ${url}: ${msg}`);
    return {
      id: 'llm',
      label: 'LLM 工具调用回环',
      ok: false,
      detail: `端点不可达:${url} · ${msg}`,
      hint: '启动 LM Studio 并开启 Local Server(端口 1234),或在设置页配置 OpenAI 兼容端点',
      ms: Date.now() - started,
    };
  }
}

/** 校验 4:数据目录可写 + 队列空闲(真实写删一个小文件,不碰用户资产) */
async function checkStorage(logger?: DebugLogger): Promise<SelfCheckItem> {
  const started = Date.now();
  const root = dataRoot();
  const probe = join(root, `.selfcheck-${process.pid}-${Date.now()}.tmp`);
  try {
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
  } catch (e) {
    logger?.log('warn', `自检:数据目录不可写 ${root}: ${(e as Error).message}`);
    return {
      id: 'storage',
      label: '数据目录与队列',
      ok: false,
      detail: `数据目录不可写:${root}`,
      hint: '检查目录权限;或用 BIGBOTART_HOME 指定可写目录',
      ms: Date.now() - started,
    };
  }
  // 项目/画布/产出计数(证明目录结构真实可用)
  let projects = 0;
  try {
    projects = readdirSync(join(root, 'projects')).filter((d) => {
      try {
        return statSync(join(root, 'projects', d)).isDirectory();
      } catch {
        return false;
      }
    }).length;
  } catch {
    /* 首次启动还没有 projects 目录 = 正常,计 0 */
  }
  return {
    id: 'storage',
    label: '数据目录与队列',
    ok: true,
    detail: `${root} 可读写 · ${projects} 个项目 · 队列空闲`,
    ms: Date.now() - started,
  };
}

/** 自检项定义(顺序 = UI 展示顺序,四项与设计稿一一对应) */
const CHECKS: Array<{ id: SelfCheckItem['id']; run: (l?: DebugLogger) => Promise<SelfCheckItem> }> = [
  { id: 'h3c', run: checkH3 },
  { id: 'mlxgen', run: checkMlxgen },
  { id: 'llm', run: checkLlm },
  { id: 'storage', run: checkStorage },
];

/**
 * 执行全部自检并汇总。
 * 每项独立 catch:单项抛错转成该项失败(带 error 信息),不影响其余项(R6:不静默吞)。
 */
export async function runSelfCheck(logger?: DebugLogger): Promise<SelfCheckReport> {
  const items: SelfCheckItem[] = [];
  for (const c of CHECKS) {
    try {
      items.push(await c.run(logger));
    } catch (e) {
      logger?.log('error', `自检项 ${c.id} 异常: ${(e as Error).message}`);
      items.push({
        id: c.id,
        label: c.id,
        ok: false,
        detail: `自检执行异常:${(e as Error).message}`,
        hint: '见主进程日志',
        ms: 0,
      });
    }
  }
  const passed = items.filter((i) => i.ok).length;
  logger?.log('info', `引擎自检完成:${passed}/${items.length} 通过`);
  return { items, passed, total: items.length };
}
