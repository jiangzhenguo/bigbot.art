/** 桌面模型包来源选择器允许值;IPC 入参不可信,必须先做运行时校验再打开对话框。 */
export type AccelPickSource = 'directory' | 'lora';

export function isAccelPickSource(value: unknown): value is AccelPickSource {
  return value === 'directory' || value === 'lora';
}
