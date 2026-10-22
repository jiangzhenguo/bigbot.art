/**
 * 浏览器里的 BigBotArtApi。没有 preload 时由入口挂到 window.bigbotart。
 * 方法名与 IPC 相同;事件走一条 WebSocket,退订只发生在本地。
 */
import { API_CATALOG, type BigBotArtApi } from '@bigbotart/shared';

const RETRY_MAX_MS = 15_000;

type Listener = (payload: unknown) => void;

export function createHttpApi(): BigBotArtApi {
  const listeners = new Map<string, Set<Listener>>();
  let socket: WebSocket | null = null;
  let retryMs = 1000;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (stopped || typeof WebSocket === 'undefined') return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/events`);
    socket = ws;
    ws.onopen = () => {
      retryMs = 1000;
    };
    ws.onmessage = (ev) => {
      let msg: { channel?: string; payload?: unknown };
      try {
        msg = JSON.parse(String(ev.data)) as { channel?: string; payload?: unknown };
      } catch {
        return;
      }
      if (!msg.channel) return;
      for (const cb of listeners.get(msg.channel) ?? []) cb(msg.payload);
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      if (stopped) return;
      retryTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    };
  };

  const subscribe = (channel: string, cb: Listener): (() => void) => {
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
    }
    set.add(cb);
    if (!socket && !retryTimer) connect();
    return () => {
      set?.delete(cb);
    };
  };

  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    const res = await fetch('/rpc', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown; error?: string } | null;
    if (!res.ok || !body?.ok) {
      throw new Error(body?.error || `RPC ${method} 失败 (${res.status})`);
    }
    return body.result;
  };

  const api = {} as Record<string, unknown>;
  for (const entry of API_CATALOG) {
    if (entry.kind === 'event') api[entry.name] = (cb: Listener) => subscribe(entry.ipcChannel, cb);
    else api[entry.name] = (...args: unknown[]) => rpc(entry.name, args);
  }
  return api as unknown as BigBotArtApi;
}
