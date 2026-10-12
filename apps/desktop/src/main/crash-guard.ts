/**
 * 崩溃兜底 — 主进程未捕获异常 / 未处理的 Promise 拒绝
 *
 * 背景(2026-10-12 真实弹窗事故):Electron 自带一个默认的 `uncaughtException` 处理器,
 * **只要应用自己没有注册同名监听**,它就把异常弹成原生对话框 —— 标题
 * 「A JavaScript error occurred in the main process」,正文 `Uncaught Exception:\n<stack>`。
 * 本项目此前没有任何兜底,于是 Node 内置 undici 的一条竞态(见下)就把一个「调用方根本拦不住、
 * 也不影响功能」的异常变成了吓人的弹窗(用户实测截图:ERR_INVALID_STATE: Invalid state:
 * ReadableStream is already closed)。
 *
 * 这里做两件事:
 *  1. **注册监听 → 弹窗消失**(Electron 判 `listenerCount('uncaughtException') > 1`,有人接管就不再弹),
 *     异常改走 DebugLogger(调试面板 + 终端双份留痕,符合「不许静默」的项目红线);
 *  2. 对**上游 undici 自己都已经吞掉**的那条竞态(ReadableStreamFrom 的 pull 结束时无保护
 *     `queueMicrotask(() => controller.close())`,调用点见 assets.ts `rangeFileResponse` 注释)
 *     降级为 warn 并按 upstream 口径忽略 —— 它既不是我们的 bug,也无法在调用方 try/catch 里捕获。
 *
 * ⚠️ 未知异常**只记日志、不杀进程**:与 Electron 默认行为一致(它也只是弹框,不退出),
 *    但换成可检索的日志。`unhandledRejection` 同理:Node 22 默认把未处理拒绝抛成
 *    uncaughtException,在 Electron 主进程里同样会弹框,不拦就是同一个坑的另一半。
 */
import type { DebugLogger } from './logger';

/**
 * 是否为上游 undici 的 ReadableStream 关闭竞态。
 *
 * 判定 = 消息 **且** 栈两处都对上:
 *  - 消息:`Invalid state: ReadableStream is already closed` / `Controller is already closed`
 *    (Node 的 ReadableByteStreamController.close 抛这两种);
 *  - 栈里出现 `internal/deps/undici/undici` —— 异常来自 undici 内部而非我们的代码。
 *
 * 只按消息判会把「我们自己写错 close 时序」的 bug 一起吞掉,故必须同时看栈。
 */
export function isKnownUndiciCloseRace(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const knownMessage = /ReadableStream is already closed|Controller is already closed/.test(err.message);
  return knownMessage && /internal\/deps\/undici\/undici/.test(err.stack ?? '');
}

/** 只依赖 DebugLogger 的 log 能力,便于测试注入假 logger */
export type CrashGuardLogger = Pick<DebugLogger, 'log'>;

/** 只依赖 EventEmitter 的 on,便于测试注入假 process(不碰真实进程监听) */
export interface CrashGuardTarget {
  on(event: 'uncaughtException', listener: (err: Error) => void): unknown;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

/** 把任意拒绝原因转成可读文本(JSON.stringify 遇循环引用会抛,故兜底 String) */
export function describeRejection(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ? `${reason.name}: ${reason.message}\n${reason.stack}` : `${reason.name}: ${reason.message}`;
  }
  try {
    return `(非 Error 拒绝) ${JSON.stringify(reason)}`;
  } catch {
    return `(非 Error 拒绝) ${String(reason)}`;
  }
}

const KNOWN_RACE_NOTE =
  '上游 undici 已知竞态(ReadableStreamFrom 结束时重复 close),按 upstream 口径忽略,不影响运行';

/** 装上兜底监听(默认挂真实 process;测试可注入假 target) */
export function installCrashGuard(logger: CrashGuardLogger, target: CrashGuardTarget = process): void {
  target.on('uncaughtException', (err: Error) => {
    if (isKnownUndiciCloseRace(err)) {
      logger.log('warn', `[crash-guard] ${KNOWN_RACE_NOTE}:${err.message}`);
      return;
    }
    logger.log('error', `[crash-guard] 主进程未捕获异常(已拦截,不再弹原生错误框):${err?.stack ?? String(err)}`);
  });

  target.on('unhandledRejection', (reason: unknown) => {
    if (isKnownUndiciCloseRace(reason)) {
      logger.log('warn', `[crash-guard] ${KNOWN_RACE_NOTE}:${(reason as Error).message}`);
      return;
    }
    logger.log('error', `[crash-guard] 未处理的 Promise 拒绝(已拦截):${describeRejection(reason)}`);
  });
}
