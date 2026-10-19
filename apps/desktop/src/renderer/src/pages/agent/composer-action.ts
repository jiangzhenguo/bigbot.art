/** 输入区右下角唯一主按钮:空闲发送,执行中打断,执行中又写了新指令则打断并发送。 */
export type ComposerActionKind = 'send' | 'interrupt' | 'interrupt-send';

export function composerPrimaryAction(
  /** 有一轮 Agent 对话还没收尾(点了打断、worker 还没停也算) */
  busy: boolean,
  /** 输入框或附件里已经有下一条要发的内容 */
  hasDraft: boolean,
): { label: string; kind: ComposerActionKind; glyph: 'arrow' | 'stop' } {
  if (!busy) return { label: '发送', kind: 'send', glyph: 'arrow' };
  if (hasDraft) return { label: '打断并发送', kind: 'interrupt-send', glyph: 'arrow' };
  return { label: '打断并改画布', kind: 'interrupt', glyph: 'stop' };
}
