/**
 * crash-guard 单测 — 锁住「主进程不再弹 Electron 原生错误框」这条线。
 *
 * 背景(2026-10-12 真实弹窗事故):Electron 只在**没有别的** `uncaughtException` 监听时才弹
 * 「A JavaScript error occurred in the main process」对话框;本项目此前没有任何兜底,于是一条
 * 来自 Node 内置 undici 的竞态(ReadableStreamFrom 结束时无保护 close)就成了用户可见的弹窗。
 * 这里既测分类/兜底行为本身,也用**接线护栏**锁住两处调用点不被改回去:
 *  1. index.ts 必须真的装上兜底(否则弹窗会复活);
 *  2. assets.ts 必须用 `Readable.toWeb` 构造 body(否则又走 undici 那层无保护包装器)。
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installCrashGuard, isKnownUndiciCloseRace, describeRejection } from '../crash-guard';
import type { CrashGuardLogger, CrashGuardTarget } from '../crash-guard';

/** 真实事故里的异常形态(Node 22.22 / Electron 38.8.6 实测 stack) */
function realUndiciRaceError(): Error {
  const err = new TypeError('Invalid state: ReadableStream is already closed');
  Object.assign(err, { code: 'ERR_INVALID_STATE' });
  err.stack = [
    'TypeError [ERR_INVALID_STATE]: Invalid state: ReadableStream is already closed',
    '    at ReadableByteStreamController.close (node:internal/webstreams/readablestream:1162:13)',
    '    at node:internal/deps/undici/undici:1596:28',
    '    at node:internal/process/task_queues:151:7',
  ].join('\n');
  return err;
}

const fakeLogger = (): CrashGuardLogger & { entries: Array<{ level: string; msg: string }> } => {
  const entries: Array<{ level: string; msg: string }> = [];
  return { entries, log: (level, msg) => { entries.push({ level, msg }); } };
};

/** 取唯一一条日志(缺失时给占位,断言会以清晰文本失败而不是 undefined 崩) */
const only = (logger: { entries: Array<{ level: string; msg: string }> }): { level: string; msg: string } =>
  logger.entries[0] ?? { level: '(无日志)', msg: '(无日志)' };

const fakeProc = (): { emitter: EventEmitter; target: CrashGuardTarget } => {
  const emitter = new EventEmitter();
  return { emitter, target: emitter as unknown as CrashGuardTarget };
};

describe('isKnownUndiciCloseRace', () => {
  it('真实事故形态(消息 + undici 内部栈)→ 认作已知竞态', () => {
    expect(isKnownUndiciCloseRace(realUndiciRaceError())).toBe(true);
  });

  it('"Controller is already closed" 同族消息也算', () => {
    const err = new TypeError('Invalid state: Controller is already closed');
    err.stack = 'TypeError: x\n    at node:internal/deps/undici/undici:1596:28';
    expect(isKnownUndiciCloseRace(err)).toBe(true);
  });

  it('同样消息但栈来自我们自己的代码 → 不算(绝不能把自家 close 时序 bug 一起吞掉)', () => {
    const err = new TypeError('Invalid state: ReadableStream is already closed');
    err.stack = 'TypeError: x\n    at rangeFileResponse (apps/desktop/src/main/assets.ts:162:20)';
    expect(isKnownUndiciCloseRace(err)).toBe(false);
  });

  it('undici 内部栈但别的错误消息 → 不算', () => {
    const err = new TypeError('fetch failed');
    err.stack = 'TypeError: fetch failed\n    at node:internal/deps/undici/undici:1596:28';
    expect(isKnownUndiciCloseRace(err)).toBe(false);
  });

  it('非 Error(字符串 / undefined)→ 不算', () => {
    expect(isKnownUndiciCloseRace('Invalid state: ReadableStream is already closed')).toBe(false);
    expect(isKnownUndiciCloseRace(undefined)).toBe(false);
  });
});

describe('describeRejection', () => {
  it('Error → 名称 + 消息 + 栈', () => {
    const e = new Error('boom');
    expect(describeRejection(e)).toContain('Error: boom');
    expect(describeRejection(e)).toContain('at ');
  });

  it('非 Error 且带循环引用 → 不抛,退化成字符串(JSON.stringify 会抛 TypeError)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeRejection(circular)).not.toThrow();
    expect(describeRejection(circular)).toContain('(非 Error 拒绝)');
  });
});

describe('installCrashGuard', () => {
  it('挂上 uncaughtException / unhandledRejection 两个监听,且不污染真实 process', () => {
    const before = process.listenerCount('uncaughtException');
    const { emitter, target } = fakeProc();
    installCrashGuard(fakeLogger(), target);
    expect(emitter.listenerCount('uncaughtException')).toBe(1);
    expect(emitter.listenerCount('unhandledRejection')).toBe(1);
    expect(process.listenerCount('uncaughtException')).toBe(before);
  });

  it('未知未捕获异常 → error 级日志(含 stack),且不重新抛出(进程继续运行)', () => {
    const logger = fakeLogger();
    const { emitter, target } = fakeProc();
    installCrashGuard(logger, target);
    expect(() => emitter.emit('uncaughtException', new Error('意料之外的炸点'))).not.toThrow();
    expect(logger.entries).toHaveLength(1);
    expect(only(logger).level).toBe('error');
    expect(only(logger).msg).toContain('意料之外的炸点');
    expect(only(logger).msg).toContain('at '); // 带 stack,便于定位
  });

  it('已知 undici 竞态 → warn 级并按 upstream 口径忽略', () => {
    const logger = fakeLogger();
    const { emitter, target } = fakeProc();
    installCrashGuard(logger, target);
    emitter.emit('uncaughtException', realUndiciRaceError());
    expect(logger.entries).toHaveLength(1);
    expect(only(logger).level).toBe('warn');
    expect(only(logger).msg).toContain('忽略');
    expect(only(logger).msg).toContain('undici');
  });

  it('未处理的 Promise 拒绝(Error) → error 级', () => {
    const logger = fakeLogger();
    const { emitter, target } = fakeProc();
    installCrashGuard(logger, target);
    emitter.emit('unhandledRejection', new Error('rejected'));
    expect(only(logger).level).toBe('error');
    expect(only(logger).msg).toContain('未处理的 Promise 拒绝');
  });

  it('未处理的 Promise 拒绝(循环引用对象) → 不抛,照样留痕', () => {
    const logger = fakeLogger();
    const { emitter, target } = fakeProc();
    installCrashGuard(logger, target);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => emitter.emit('unhandledRejection', circular)).not.toThrow();
    expect(only(logger).level).toBe('error');
    expect(only(logger).msg).toContain('(非 Error 拒绝)');
  });
});

describe('接线护栏(源码级)', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('index.ts:构造 logger 后立即 installCrashGuard(logger)', () => {
    const src = read('../index.ts');
    const loggerAt = src.indexOf('const logger = new DebugLogger();');
    const guardAt = src.indexOf('installCrashGuard(logger);');
    expect(loggerAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(loggerAt);
  });

  it('assets.ts:rangeFileResponse 用 Readable.toWeb 构造 body,不再把 Node 流直塞 Response', () => {
    const src = read('../assets.ts');
    // 断言只看**代码**(注释里为解释事故会引用旧写法,不应误伤)
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).toContain('Readable.toWeb(createReadStream(');
    // 旧写法(事故根因):Node 流强转成 web 流 → undici 用无保护 close 的 ReadableStreamFrom 包一层
    expect(code).not.toMatch(/createReadStream\([^)]*\)\s*as unknown as ReadableStream/);
  });
});
