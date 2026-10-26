/**
 * todo.write 的展示分流：任务进度固定在输入区上方，不再混入聊天消息流。
 * 数据真源仍是 CanvasMemory.todos；这里只负责识别需要从聊天里摘掉的展示记录。
 */
import type { ToolRun } from './types';

export const TODO_TOOL_NAME = 'todo.write';

const TODO_ACTIVITY_RE = /^(?:已更新任务清单\s*[（(]\s*\d+\s*项\s*[)）]|已清空任务清单)$/;

export function isTodoToolName(name: string): boolean {
  return name === TODO_TOOL_NAME;
}

/** 保留其他工具行；若一轮只有 todo.write，调用方应连同空工具卡一起隐藏。 */
export function withoutTodoToolRuns(runs: ToolRun[]): ToolRun[] {
  return runs.filter((run) => !isTodoToolName(run.name));
}

/** 主进程写入 recall 的 todo 系统摘要，与工具卡一样不再占据聊天内容。 */
export function isTodoActivityText(text: string | undefined): boolean {
  return !!text && TODO_ACTIVITY_RE.test(text.trim());
}
