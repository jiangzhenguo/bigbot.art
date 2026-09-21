/**
 * 运行时安装 — 真实执行 / 提示两类
 *
 * - mlxgen:真实执行 `uv tool install --upgrade mlx-gen`(spawn,带超时与 stderr 尾部诊断)
 * - 其余(lmstudio / ollama / comfyui / h3c):仍为「提示命令」—— h3c 需编译、lmstudio 是 GUI 应用,
 *   一键安装不属于本应用职责,提示用户手动执行
 */
import { spawn } from 'node:child_process';
import type { DebugLogger } from './logger';

const INSTALL_HINTS: Record<string, string> = {
  lmstudio: '请手动安装:open -a "LM Studio" 或官网 https://lmstudio.ai 下载',
  ollama: '请手动安装:brew install ollama',
  comfyui: '请手动安装:https://github.com/comfyanonymous/ComfyUI',
  h3c: '请手动编译 h3.c:在 h3.c 仓库执行 make -j8,再把二进制路径配到设置页',
};

let mlxgenInstallRunning = false;

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
  logger?.log('info', 'install-runtime mlxgen: uv tool install --upgrade mlx-gen');
  return new Promise((resolve) => {
    const child = spawn('uv', ['tool', 'install', '--upgrade', 'mlx-gen'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const eat = (d: Buffer): void => {
      out = (out + d.toString()).slice(-4000);
    };
    child.stdout.on('data', eat);
    child.stderr.on('data', eat);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      mlxgenInstallRunning = false;
      resolve({ ok: false, message: '安装超时(10 分钟)· 请手动执行:uv tool install --upgrade mlx-gen' });
    }, 10 * 60_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      mlxgenInstallRunning = false;
      resolve({ ok: false, message: `无法执行 uv:${e.message} · 请先安装 uv(brew install uv)` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      mlxgenInstallRunning = false;
      if (code === 0) {
        logger?.log('info', 'install-runtime mlxgen 完成');
        resolve({ ok: true, message: 'mlxgen 已安装(uv tool install mlx-gen) · 可点「重新探测」确认就绪' });
      } else {
        const tail = out
          .split(/\r|\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-4)
          .join(' | ')
          .slice(0, 300);
        resolve({ ok: false, message: `安装失败(exit ${code}): ${tail || '见日志'}` });
      }
    });
  });
}