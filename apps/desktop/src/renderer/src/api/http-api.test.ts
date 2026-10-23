/**
 * 浏览器客户端:方法名走 POST /rpc,事件走一条 WebSocket,退订只发生在本地。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { API_CATALOG } from '@bigbotart/shared';
import { createHttpApi } from './http-api';

type Listener = (ev: { data: string }) => void;

class FakeSocket {
  static instances: FakeSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: Listener | null = null;
  onclose: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
}

afterEach(() => {
  FakeSocket.instances = [];
  vi.unstubAllGlobals();
});

function installGlobals() {
  vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:47321' });
  vi.stubGlobal('WebSocket', FakeSocket);
}

describe('HTTP BigBotArtApi', () => {
  it('目录里的每个方法都是函数', () => {
    installGlobals();
    vi.stubGlobal('fetch', vi.fn());
    const api = createHttpApi();
    for (const entry of API_CATALOG) {
      expect(typeof api[entry.name]).toBe('function');
    }
  });

  it('RPC 成功解包 result;失败抛出服务端 error,不带堆栈', async () => {
    installGlobals();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string };
      if (body.method === 'listProjects') {
        return new Response(JSON.stringify({ ok: true, result: [{ id: 'p1' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, error: '远程不支持系统对话框' }), { status: 403 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi();
    await expect(api.listProjects()).resolves.toEqual([{ id: 'p1' }]);
    await expect(api.revealInFinder({ path: '/tmp/x' })).rejects.toThrow('远程不支持系统对话框');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(String(init.body))).toEqual({ method: 'listProjects', params: [] });
  });

  it('WebSocket 帧按频道分发,退订后不再调用', async () => {
    installGlobals();
    vi.stubGlobal('fetch', vi.fn());
    const api = createHttpApi();
    const got: unknown[] = [];
    const unsub = api.onQueueChanged((jobs) => got.push(jobs));
    const sock = FakeSocket.instances[0];
    expect(sock?.url).toBe('ws://127.0.0.1:47321/events');
    sock?.onmessage?.({ data: JSON.stringify({ channel: 'render-queue-changed', payload: [{ id: 'j1' }] }) });
    sock?.onmessage?.({ data: JSON.stringify({ channel: 'agent-event', payload: { kind: 'done' } }) });
    unsub();
    sock?.onmessage?.({ data: JSON.stringify({ channel: 'render-queue-changed', payload: [{ id: 'j2' }] }) });
    expect(got).toEqual([[{ id: 'j1' }]]);
  });

  it('文档在路径前缀下时,RPC 与 WebSocket 都走同一个前缀', async () => {
    vi.stubGlobal('location', { protocol: 'https:', host: 'bigbot.art', pathname: '/bba/' });
    vi.stubGlobal('window', { bigbotartShell: false, location: { pathname: '/bba/' } });
    vi.stubGlobal('WebSocket', FakeSocket);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi();
    await api.listProjects();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/bba/rpc');
    api.onQueueChanged(() => {});
    expect(FakeSocket.instances[0]?.url).toBe('wss://bigbot.art/bba/events');
  });
});
