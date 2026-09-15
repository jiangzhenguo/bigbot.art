/**
 * DebugLogger — 主进程日志总线(调试面板用)
 * - 内存环形缓冲(最近 DEBUG_MAX 条),订阅者实时推送(渲染层面板)
 * - 同级总是双写 console.error,dev 时 /tmp/bigbotart-dev.log 也能看
 */

export interface DebugLogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error' | 'h3';
  msg: string;
}

const DEBUG_MAX = 500;

export class DebugLogger {
  private entries: DebugLogEntry[] = [];
  private listeners = new Set<(e: DebugLogEntry) => void>();

  log(level: DebugLogEntry['level'], msg: string): void {
    const e: DebugLogEntry = { ts: new Date().toISOString(), level, msg };
    this.entries.push(e);
    if (this.entries.length > DEBUG_MAX) this.entries.splice(0, this.entries.length - DEBUG_MAX);
    console.error(`[dbg:${level}] ${msg}`);
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* 订阅者异常不影响总线 */
      }
    }
  }

  /** 渲染层订阅实时日志;返回退订函数 */
  subscribe(cb: (e: DebugLogEntry) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  list(): DebugLogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
    this.log('info', '日志已清空');
  }
}