/**
 * 对话 Agent 的任务清单与多镜真跑确认(纯函数)。
 *
 * todo:整表替换,同时只能有一项进行中。清单存在画布记忆里,每轮重新注入,
 * 不靠工具调用历史(那些原文不进上下文窗口)。
 *
 * 多镜:未出片镜头达到 2 个时,engine.submit 这些镜头前必须先 plan.present,
 * 用户点「按此执行」后才放行。单镜不拦。
 */

import type { AgentTodoItem, AgentTodoStatus } from './domain.js';

export const PLAN_APPROVE_LABEL = '按此执行';
export const PLAN_REVISE_LABEL = '修改计划';

const TODO_STATUSES: readonly AgentTodoStatus[] = ['pending', 'in_progress', 'completed'];
const MAX_TODOS = 12;
const MAX_TODO_CHARS = 80;

const STATUS_LABEL: Record<AgentTodoStatus, string> = {
  in_progress: '进行中',
  pending: '待办',
  completed: '已完成',
};

export interface ShotRef {
  id: string;
  kind: string;
  label?: string;
  /** 节点 data。只读 resultPath,其余形状忽略。 */
  data?: unknown;
}

export function validateTodoList(raw: unknown): { ok: true; todos: AgentTodoItem[] } | { ok: false; error: string } {
  let value = raw;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return { ok: true, todos: [] };
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, error: 'todos 必须是数组。若被包成字符串,内容需是合法 JSON 数组。' };
    }
  }
  if (!Array.isArray(value)) return { ok: false, error: 'todos 必须是数组,整表替换上一份清单。' };
  if (value.length > MAX_TODOS) return { ok: false, error: `清单最多 ${MAX_TODOS} 条,请把步骤合并后再写。` };
  const todos: AgentTodoItem[] = [];
  const seen = new Set<string>();
  let inProgress = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: '每一项必须是 { content, status }。' };
    }
    const rec = item as Record<string, unknown>;
    const content = typeof rec.content === 'string' ? rec.content.trim() : '';
    if (!content) return { ok: false, error: 'content 不能为空。' };
    if (content.length > MAX_TODO_CHARS) {
      return { ok: false, error: `「${content.slice(0, 24)}…」太长。每项写成一句短任务(不超过 ${MAX_TODO_CHARS} 字)。` };
    }
    if (seen.has(content)) return { ok: false, error: `任务重复:「${content}」。` };
    seen.add(content);
    const status = rec.status;
    if (typeof status !== 'string' || !TODO_STATUSES.includes(status as AgentTodoStatus)) {
      return { ok: false, error: `「${content}」的 status 必须是 pending、in_progress 或 completed。` };
    }
    if (status === 'in_progress') inProgress += 1;
    todos.push({ content, status: status as AgentTodoStatus });
  }
  if (inProgress > 1) {
    return { ok: false, error: `同时只能有一项 in_progress(现在有 ${inProgress} 项)。` };
  }
  return { ok: true, todos };
}

/** 注入系统提示的清单段。空清单不注入。 */
export function formatTodoPrompt(todos: AgentTodoItem[] | undefined): string | undefined {
  if (!todos || todos.length === 0) return undefined;
  const order: AgentTodoStatus[] = ['in_progress', 'pending', 'completed'];
  const lines = order.flatMap((status) =>
    todos.filter((t) => t.status === status).map((t) => `- ${STATUS_LABEL[status]}:${t.content}`),
  );
  const open = todos.some((t) => t.status !== 'completed');
  const tail = open
    ? '未完成项继续做。状态变化时用 todo.write 整表替换。用户改了任务就重写清单。'
    : '清单已全部完成。用户给出新任务后再整表替换,不要为了清清单把做过的步骤再做一遍。';
  return ['【当前任务清单】', ...lines, tail].join('\n');
}

export function todoCounts(todos: AgentTodoItem[]): { pending: number; inProgress: number; completed: number } {
  return {
    pending: todos.filter((t) => t.status === 'pending').length,
    inProgress: todos.filter((t) => t.status === 'in_progress').length,
    completed: todos.filter((t) => t.status === 'completed').length,
  };
}

export function formatTodoResult(todos: AgentTodoItem[]): string {
  if (todos.length === 0) return '任务清单已清空。';
  const c = todoCounts(todos);
  return `任务清单已更新:待办 ${c.pending},进行中 ${c.inProgress},已完成 ${c.completed}。`;
}

function hasResult(node: ShotRef): boolean {
  const data = node.data;
  if (!data || typeof data !== 'object') return false;
  const path = (data as { resultPath?: unknown }).resultPath;
  return typeof path === 'string' && path.trim().length > 0;
}

/** 还没有产物的镜头,按 id 排序。 */
export function openShots(nodes: ShotRef[]): Array<{ id: string; label: string }> {
  return nodes
    .filter((n) => n.kind === 'shot' && !hasResult(n))
    .map((n) => ({ id: n.id, label: (n.label ?? '').trim() || n.id }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function validatePlanMarkdown(markdown: string): { ok: true } | { ok: false; error: string } {
  const text = markdown.trim();
  if (!text.startsWith('#')) return { ok: false, error: '计划正文须以 Markdown 标题开头(第一行是 # )。' };
  const body = text.replace(/^#+.*$/m, '').trim();
  if (body.length < 8) return { ok: false, error: '计划太短。写清要建的节点、要连的线、要提交的镜头(用标题)。' };
  return { ok: true };
}

function idKey(ids: string[]): string {
  return [...ids].sort().join('\0');
}

export function sameShotSet(a: string[], b: string[]): boolean {
  return idKey(a) === idKey(b);
}

/**
 * 用户点「按此执行」时,待确认的镜头集合必须仍等于当前未出片镜头。
 * 没有待确认计划时静默跳过(用户只是打了这四个字)。
 */
export function decideShotPlanApproval(
  pendingIds: string[] | undefined,
  openIds: string[],
): { ok: true; approvedShotIds: string[] } | { ok: false; silent: true } | { ok: false; silent: false; reason: string } {
  if (!pendingIds || pendingIds.length === 0) return { ok: false, silent: true };
  if (!sameShotSet(pendingIds, openIds)) {
    return {
      ok: false,
      silent: false,
      reason: `未出片镜头已经变了(提交计划时 ${pendingIds.length} 个,现在 ${openIds.length} 个),这次点头没有生效。请按当前镜头重新 plan.present。`,
    };
  }
  return { ok: true, approvedShotIds: [...pendingIds].sort() };
}

/** 提交单个镜头前的硬闸。未出片不足 2 个,或该镜头已在批准集合里,则放行。 */
export function shotSubmitAllowed(opts: {
  nodeId: string;
  nodes: ShotRef[];
  approvedShotIds: string[] | undefined;
}): { ok: true } | { ok: false; reason: string } {
  const open = openShots(opts.nodes);
  if (open.length < 2) return { ok: true };
  if (opts.approvedShotIds?.includes(opts.nodeId)) return { ok: true };
  const list = open.map((s) => `「${s.label}」`).join('、');
  return {
    ok: false,
    reason:
      `未出片镜头有 ${open.length} 个(${list}),真跑前必须先 plan.present,等用户点「${PLAN_APPROVE_LABEL}」。` +
      `计划里写清要建的节点、连线和要提交的镜头。不要在同一轮里提交。`,
  };
}
