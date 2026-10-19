/**
 * 同画布已有对话占坑时,用户的下一条要等它收尾再开。
 *
 * 调用方必须先确认「当前占着坑」再 await 本函数。
 * 空闲时如果无条件 await,会让出事件循环,两条消息可能都通过占坑检查(2026-10 并发串写)。
 */
export async function waitUntilFlightFree(args: {
  isInFlight: () => boolean;
  cancel: () => void;
  /** 当前占坑那一轮的收尾承诺;没有则视为已经能接手,避免空转 */
  currentTail: () => Promise<void> | undefined;
}): Promise<void> {
  while (args.isInFlight()) {
    args.cancel();
    const tail = args.currentTail();
    if (!tail) return;
    await tail;
  }
}
