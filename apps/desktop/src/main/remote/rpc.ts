/**
 * POST /rpc 分发。业务函数就是 IPC 注册的那一份。
 * 会弹系统对话框的调用在进 handler 之前拒绝,不靠客户端自报。
 */
import { catalogByName } from '@bigbotart/shared';
import type { DebugLogger } from '../logger';

export type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

export interface RpcOutcome {
  status: number;
  body: { ok: true; result: unknown } | { ok: false; error: string };
}

const DIALOG_ERROR = '远程不支持系统对话框';

/** 这些调用在桌面会弹打开/保存框或 Finder。有明确 path 的导入导出仍走原 handler。 */
export function remoteDialogBlock(method: string, params: unknown[]): string | null {
  if (method === 'uploadProjectCover' || method === 'importSkill' || method === 'saveExportAs' || method === 'revealInFinder') {
    return DIALOG_ERROR;
  }
  if (method === 'remoteAccessRotatePassphrase') return '远程不能轮换口令';
  if (method === 'importAssets') {
    const opts = params[0] as { paths?: unknown } | undefined;
    const paths = opts?.paths;
    if (!Array.isArray(paths) || paths.length === 0) return DIALOG_ERROR;
  }
  if (method === 'exportProjectPackage') {
    const req = params[0] as { path?: unknown } | undefined;
    if (typeof req?.path !== 'string' || !req.path) return DIALOG_ERROR;
  }
  if (method === 'importProjectPackage') {
    const input = params[0] as { path?: unknown } | undefined;
    if (typeof input?.path !== 'string' || !input.path) return DIALOG_ERROR;
  }
  return null;
}

function stripRemoteAccess(params: unknown[]): unknown[] {
  const patch = params[0];
  if (!patch || typeof patch !== 'object') return params;
  if (!('remoteAccess' in patch)) return params;
  const next = { ...(patch as Record<string, unknown>) };
  delete next.remoteAccess;
  return [next];
}

export async function dispatchRpc(
  method: unknown,
  params: unknown,
  handlers: Map<string, IpcHandler>,
  logger: Pick<DebugLogger, 'log'>,
): Promise<RpcOutcome> {
  if (typeof method !== 'string' || !method) {
    return { status: 400, body: { ok: false, error: '缺少 method' } };
  }
  if (!Array.isArray(params)) {
    return { status: 400, body: { ok: false, error: 'params 必须是数组' } };
  }
  const entry = catalogByName(method);
  if (!entry || entry.kind !== 'rpc') {
    return { status: 404, body: { ok: false, error: `未知方法: ${method}` } };
  }
  const blocked = remoteDialogBlock(method, params);
  if (blocked) return { status: 403, body: { ok: false, error: blocked } };
  const handler = handlers.get(entry.ipcChannel);
  if (!handler) return { status: 404, body: { ok: false, error: `方法未注册: ${method}` } };
  const args = method === 'setSettings' ? stripRemoteAccess(params) : params;
  try {
    const result = await handler({}, ...args);
    return { status: 200, body: { ok: true, result } };
  } catch (e) {
    const message = (e as Error).message || '调用失败';
    logger.log('error', `远程 RPC ${method} 失败: ${message}`);
    return { status: 500, body: { ok: false, error: message } };
  }
}
