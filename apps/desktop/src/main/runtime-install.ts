/**
 * 运行时安装 — 真实执行 / 提示两类
 *
 * - mlxgen:真实执行 `uv tool install --upgrade mlx-gen-jzg`(spawn,带超时与 stderr 尾部诊断)。
 *   包名是本 fork;上游 PyPI `mlx-gen` 没有 Qwen-Image-2.1 参考编辑和 mlxgen-caption。
 *   旧工具名 `mlx-gen` 与新包都会写 `~/.local/bin/mlxgen`,入口冲突时先卸载旧工具再重试一次。
 * - 其余(lmstudio / ollama / comfyui / h3c):仍为「提示命令」—— h3c 需编译、lmstudio 是 GUI 应用,
 *   一键安装不属于本应用职责,提示用户手动执行
 */
import { spawn } from 'node:child_process';
import type { DebugLogger } from './logger';

/** fork 的 PyPI 包名。CLI 入口仍叫 mlxgen,不要改成这个名字去 spawn。 */
const MLXGEN_PACKAGE = 'mlx-gen-jzg';
/** 改名之前的 uv 工具名(上游包也叫这个)。占着 mlxgen 入口时必须先卸。 */
const MLXGEN_LEGACY_TOOL = 'mlx-gen';
const INSTALL_CMD = `uv tool install --upgrade ${MLXGEN_PACKAGE}`;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const UNINSTALL_TIMEOUT_MS = 60_000;

const INSTALL_HINTS: Record<string, string> = {
  lmstudio: '请手动安装:open -a "LM Studio" 或官网 https://lmstudio.ai 下载',
  ollama: '请手动安装:brew install ollama',
  comfyui: '请手动安装:https://github.com/comfyanonymous/ComfyUI',
  h3c: '请手动编译 h3.c:在 h3.c 仓库执行 make -j8,再把二进制路径配到设置页',
};

let mlxgenInstallRunning = false;

interface UvResult {
  code: number | null;
  out: string;
  /** timeout = 到点杀进程;其它字符串 = spawn 本身失败(典型是找不到 uv) */
  spawnError?: 'timeout' | string;
}

function spawnUv(args: string[], timeoutMs: number): Promise<UvResult> {
  return new Promise((resolve) => {
    const child = spawn('uv', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const eat = (d: Buffer): void => {
      out = (out + d.toString()).slice(-4000);
    };
    child.stdout.on('data', eat);
    child.stderr.on('data', eat);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ code: null, out, spawnError: 'timeout' });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, out, spawnError: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/**
 * 安装 mlx-gen-jzg 失败是不是因为旧工具 `mlx-gen` 占着同名入口。
 * 新包名含 `mlx-gen` 前缀,判定时必须排除 `mlx-gen-jzg`,否则「包没找到」也会被当成冲突去卸工具。
 */
export function legacyMlxgenToolConflict(out: string): boolean {
  const mentionsLegacy = /(?:^|[^a-z0-9])mlx-gen(?!-jzg)/i.test(out);
  const conflict = /already|conflict|entry point|provided by|exists/i.test(out);
  if (mentionsLegacy && conflict) return true;
  // 有的 uv 版本只说可执行文件已存在,不点名旧工具
  return /mlxgen/.test(out) && /already (?:exists|installed|provided)/i.test(out);
}

function tailOf(out: string): string {
  return out
    .split(/\r|\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-4)
    .join(' | ')
    .slice(0, 300);
}

function installFailure(result: UvResult): { ok: false; message: string } | null {
  if (result.spawnError === 'timeout') {
    return { ok: false, message: `安装超时(10 分钟)· 请手动执行:${INSTALL_CMD}` };
  }
  if (result.spawnError) {
    return { ok: false, message: `无法执行 uv:${result.spawnError} · 请先安装 uv(brew install uv)` };
  }
  if (result.code === 0) return null;
  return { ok: false, message: `安装失败(exit ${result.code}): ${tailOf(result.out) || '见日志'}` };
}

export async function installRuntime(
  id: string,
  logger?: DebugLogger,
): Promise<{ ok: boolean; message: string }> {
  if (id !== 'mlxgen') {
    return { ok: false, message: INSTALL_HINTS[id] ?? `未知运行时 ${id}` };
  }
  if (mlxgenInstallRunning) {
    return { ok: false, message: 'mlxgen 安装已在执行中,请稍候…' };
  }
  mlxgenInstallRunning = true;
  logger?.log('info', `install-runtime mlxgen: ${INSTALL_CMD}`);
  try {
    let result = await spawnUv(['tool', 'install', '--upgrade', MLXGEN_PACKAGE], INSTALL_TIMEOUT_MS);
    if (result.code !== 0 && !result.spawnError && legacyMlxgenToolConflict(result.out)) {
      logger?.log('info', 'install-runtime: 旧工具 mlx-gen 占用 mlxgen 入口,先卸载再装 mlx-gen-jzg');
      const removed = await spawnUv(['tool', 'uninstall', MLXGEN_LEGACY_TOOL], UNINSTALL_TIMEOUT_MS);
      if (removed.spawnError || removed.code !== 0) {
        const why = removed.spawnError === 'timeout' ? '卸载超时' : (tailOf(removed.out) || removed.spawnError || '见日志');
        return {
          ok: false,
          message: `旧工具 mlx-gen 占用入口且卸载失败: ${why} · 请手动执行 uv tool uninstall mlx-gen && ${INSTALL_CMD}`,
        };
      }
      result = await spawnUv(['tool', 'install', '--upgrade', MLXGEN_PACKAGE], INSTALL_TIMEOUT_MS);
      const retried = installFailure(result);
      if (retried) {
        return { ok: false, message: `${retried.message} · 旧工具 mlx-gen 已卸载,请手动执行:${INSTALL_CMD}` };
      }
      logger?.log('info', 'install-runtime mlxgen 完成');
      return { ok: true, message: `mlxgen 已安装(${INSTALL_CMD}) · 可点「重新探测」确认就绪` };
    }
    const failed = installFailure(result);
    if (failed) return failed;
    logger?.log('info', 'install-runtime mlxgen 完成');
    return { ok: true, message: `mlxgen 已安装(${INSTALL_CMD}) · 可点「重新探测」确认就绪` };
  } finally {
    mlxgenInstallRunning = false;
  }
}
