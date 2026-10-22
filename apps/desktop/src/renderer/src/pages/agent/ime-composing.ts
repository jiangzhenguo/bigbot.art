/**
 * 判断按键是否发生在输入法组词过程中。
 * - `nativeEvent.isComposing`:标准信号
 * - `keyCode === 229`:部分浏览器/Electron 在组词期给的兼容码(Unidentified)
 * 组词中的 Enter 是「上屏选词」,不是「发送」。
 */
export function isImeComposingKey(e: {
  nativeEvent: { isComposing?: boolean };
  keyCode?: number;
}): boolean {
  return Boolean(e.nativeEvent.isComposing) || e.keyCode === 229;
}
