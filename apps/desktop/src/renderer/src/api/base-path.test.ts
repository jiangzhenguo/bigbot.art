/**
 * 网页模式的公网路径前缀:由文档自己的 URL 目录推导。
 *
 * 为什么要有前缀:公网域名上通常还挂着别的东西(官网)。
 * 应用整体放在一个路径前缀下(例如 https://host/bba/)时,
 * 页面资源是相对引用(./assets/…),接口必须跟着同一个前缀走。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { apiPath, basePath } from './base-path';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubWeb(pathname: string): void {
  vi.stubGlobal('window', { bigbotartShell: false, location: { pathname } });
}

describe('网页路径前缀', () => {
  it('文档在 /bba/ 下时,接口与媒体都带上前缀', () => {
    stubWeb('/bba/');
    expect(basePath()).toBe('/bba');
    expect(apiPath('/rpc')).toBe('/bba/rpc');
    expect(apiPath('/events')).toBe('/bba/events');
    expect(apiPath('/media/output/a.png')).toBe('/bba/media/output/a.png');
    expect(apiPath('/media/asset/asset-1.png')).toBe('/bba/media/asset/asset-1.png');
  });

  it('多层前缀也认(反代把 /a/b 整段转进来)', () => {
    stubWeb('/a/b/');
    expect(basePath()).toBe('/a/b');
    expect(apiPath('/rpc')).toBe('/a/b/rpc');
  });

  it('文档在根路径时原样返回', () => {
    stubWeb('/');
    expect(basePath()).toBe('');
    expect(apiPath('/rpc')).toBe('/rpc');
  });

  it('文档是 /index.html 时按根路径算', () => {
    stubWeb('/index.html');
    expect(basePath()).toBe('');
    expect(apiPath('/rpc')).toBe('/rpc');
  });

  it('桌面模式(没有 bigbotartShell=false)不加前缀', () => {
    vi.stubGlobal('window', { location: { pathname: '/bba/' } });
    expect(basePath()).toBe('');
    expect(apiPath('/rpc')).toBe('/rpc');
  });

  it('没有 window 时不炸', () => {
    vi.stubGlobal('window', undefined);
    expect(basePath()).toBe('');
    expect(apiPath('/rpc')).toBe('/rpc');
  });
});
