import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EventHub } from '../event-hub';

describe('EventHub 扇出', () => {
  it('两个订阅者都收到 canvas-snapshot-updated', () => {
    const hub = new EventHub();
    const a: unknown[] = [];
    const b: unknown[] = [];
    hub.subscribe((channel, payload) => a.push({ channel, payload }));
    hub.subscribe((channel, payload) => b.push({ channel, payload }));
    const snap = { id: 'cv', version: 2 };
    hub.publish('canvas-snapshot-updated', snap);
    expect(a).toEqual([{ channel: 'canvas-snapshot-updated', payload: snap }]);
    expect(b).toEqual(a);
  });

  it('退订后不再收到;一个订阅者抛错不影响另一个', () => {
    const hub = new EventHub();
    const errors: string[] = [];
    hub.onListenerError = (err) => errors.push((err as Error).message);
    const got: string[] = [];
    const unsub = hub.subscribe(() => {
      throw new Error('boom');
    });
    hub.subscribe((channel) => got.push(channel));
    hub.publish('agent-event', { kind: 'done' });
    unsub();
    hub.publish('render-queue-changed', []);
    expect(got).toEqual(['agent-event', 'render-queue-changed']);
    expect(errors).toEqual(['boom']);
    expect(hub.subscriberCount).toBe(1);
  });
});

describe('事件不再只推给模块级 win', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const indexSrc = readFileSync(resolve(here, '../index.ts'), 'utf8');
  const surfaceSrc = readFileSync(resolve(here, '../api-surface.ts'), 'utf8');

  it('index.ts 的推送都走 hub.publish,没有 win.webContents.send', () => {
    expect(indexSrc).not.toMatch(/win\??\.webContents\.send/);
    expect(indexSrc).not.toMatch(/w\.webContents\.send/);
    for (const channel of [
      'agent-event',
      'canvas-snapshot-updated',
      'render-queue-changed',
      'style-model-progress',
      'debug-log',
    ]) {
      expect(indexSrc).toContain(`hub.publish('${channel}'`);
    }
  });

  it('视频后处理进度也进 hub,不再只发给 getWin()', () => {
    expect(surfaceSrc).not.toMatch(/webContents\.send/);
    expect(surfaceSrc).toContain("publish('video-post-progress'");
  });
});
