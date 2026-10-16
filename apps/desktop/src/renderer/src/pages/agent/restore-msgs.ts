/**
 * 把 recall 窗口还原成 ChatMsg[](与 useAgentChat 挂载恢复同口径)。
 * 切会话 / 进画布共用,避免两套恢复逻辑分叉。
 */
import type { RecallMessage } from '@bigbotart/shared';
import type { ChatMsg, ToolRun } from './types';
import { selectRestoreWindow } from './restore-window';

export function restoreMsgsFromRecall(
  recall: RecallMessage[],
  nextId: () => number,
): ChatMsg[] {
  const recent = selectRestoreWindow(recall);
  if (recent.length === 0) return [];
  const restored: ChatMsg[] = [];
  let toolGroup: ToolRun[] | null = null;
  const flushTools = () => {
    if (toolGroup?.length) {
      restored.push({ id: nextId(), kind: 'agent', odId: 'agent-tools', toolRuns: toolGroup });
    }
    toolGroup = null;
  };
  for (let i = 0; i < recent.length; i++) {
    const r = recent[i];
    if (!r) continue;
    if (r.role === 'tool' && r.toolName === 'ask.user') {
      flushTools();
      const args = (r.toolArgs ?? {}) as { question?: string; options?: unknown };
      let opts: unknown = args.options;
      if (typeof opts === 'string') {
        try {
          opts = JSON.parse(opts);
        } catch {
          opts = null;
        }
      }
      if (args.question && Array.isArray(opts) && opts.length >= 2) {
        const dupIdx = restored.findLastIndex((x) => x.kind === 'agent' && x.text === args.question);
        if (dupIdx >= 0) restored.splice(dupIdx, 1);
        const askOpts = opts as Array<{ label: string }>;
        const nxt = recent[i + 1];
        const picked =
          nxt?.role === 'user' && nxt.content && askOpts.some((o) => o.label.trim() === nxt.content.trim())
            ? nxt.content.trim()
            : undefined;
        restored.push({
          id: nextId(),
          kind: 'agent',
          odId: 'agent-ask',
          ask: { question: args.question, options: opts as import('@bigbotart/shared').AskOption[], picked },
        });
      } else if (args.question) {
        restored.push({ id: nextId(), kind: 'agent', text: args.question });
      } else {
        continue;
      }
    } else if (r.role === 'tool' && r.toolName) {
      (toolGroup ??= []).push({
        name: r.toolName,
        args: r.toolArgs ?? {},
        status: 'success',
        result: r.toolResult,
      });
    } else {
      flushTools();
      restored.push({
        id: nextId(),
        kind: r.role === 'user' ? 'user' : 'agent',
        text: r.content,
        contextNodes:
          r.role === 'user'
            ? r.selectedNodeIds?.length
              ? r.selectedNodeIds.map((id, i) => ({ id, title: r.selectedNodeTitles?.[i] ?? id }))
              : r.selectedNodeId
                ? [{ id: r.selectedNodeId, title: r.selectedNodeTitle ?? r.selectedNodeId }]
                : undefined
            : undefined,
      });
    }
  }
  flushTools();
  return restored;
}
