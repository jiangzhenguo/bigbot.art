/**
 * 进程内事件扇出。
 *
 * Electron 窗口和已登录的 WebSocket 都从这里订阅。
 * 频道字符串与 IPC 一致(render-queue-changed / agent-event / …)。
 * 一个订阅者抛错不影响其余订阅者。
 */
export type HubListener = (channel: string, payload: unknown) => void;

export class EventHub {
  private listeners = new Set<HubListener>();
  /** 订阅者抛错时回调;不要在这里再 publish 同一条,避免环 */
  onListenerError: (err: unknown, channel: string) => void = () => {};

  subscribe(fn: HubListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  publish(channel: string, payload: unknown): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(channel, payload);
      } catch (err) {
        try {
          this.onListenerError(err, channel);
        } catch {
          /* 错误回调自身失败不能打断发布 */
        }
      }
    }
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}
