/**
 * AgentTodoPanel — 固定在对话区底部、输入框上方的任务进度。
 *
 * 与聊天滚动解耦：todos 来自 CanvasMemory.todos（useAgentChat 负责加载与实时刷新），
 * 不从工具卡历史猜测进度。空清单不占空间；非空清单默认展开，可手动收起。
 */
import React, { useState } from 'react';
import { todoCounts } from '@bigbotart/shared';
import type { AgentTodoItem, AgentTodoStatus } from '@bigbotart/shared';

const STATUS_LABEL: Record<AgentTodoStatus, string> = {
  pending: '待办',
  in_progress: '进行中',
  completed: '已完成',
};

function StatusIcon({ status }: { status: AgentTodoStatus }) {
  return (
    <span className="agent-todo-item-icon" role="img" aria-label={STATUS_LABEL[status]} title={STATUS_LABEL[status]}>
      {status === 'completed' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" />
          <path d="m8 12.2 2.6 2.6L16.5 9" />
        </svg>
      ) : status === 'in_progress' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" />
          <path d="m10 8.8 5 3.2-5 3.2Z" fill="currentColor" stroke="none" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" />
        </svg>
      )}
    </span>
  );
}

export function AgentTodoPanel({ todos, error }: { todos: AgentTodoItem[]; error?: string | null }) {
  const [expanded, setExpanded] = useState(true);
  if (error) {
    return (
      <section className="agent-todo-panel" data-od-id="agent-todo-error" role="alert" style={{ color: 'var(--warn)' }}>
        {error}
      </section>
    );
  }
  if (todos.length === 0) return null;

  const counts = todoCounts(todos);
  const percent = Math.round((counts.completed / todos.length) * 100);

  return (
    <section
      className={`agent-todo-panel${expanded ? ' open' : ''}`}
      data-od-id="agent-todo-panel"
      aria-label="任务进度"
    >
      <button
        type="button"
        className="agent-todo-head"
        aria-expanded={expanded}
        aria-controls="agent-todo-list"
        title={expanded ? '收起任务清单' : '展开任务清单'}
        onClick={() => setExpanded((value) => !value)}
      >
        <svg className="agent-todo-head-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="m4.5 6 1.5 1.5L8.5 5M4.5 12 6 13.5 8.5 11M4.5 18 6 19.5 8.5 17" />
          <path d="M11.5 6h8M11.5 12h8M11.5 18h8" />
        </svg>
        <span className="agent-todo-heading">任务进度</span>
        <span className="agent-todo-count" aria-live="polite">
          <b>{counts.completed}</b>/{todos.length} 已完成
        </span>
        <svg className="agent-todo-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div
        className="agent-todo-meter"
        role="progressbar"
        aria-label="任务完成进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${counts.completed}/${todos.length} 已完成`}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <ul className="agent-todo-list" id="agent-todo-list" data-od-id="agent-todos">
        {todos.map((todo) => (
          <li key={todo.content} data-status={todo.status}>
            <StatusIcon status={todo.status} />
            <span className="agent-todo-content">{todo.content}</span>
            {todo.status === 'in_progress' ? <span className="agent-todo-active-label">进行中</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default AgentTodoPanel;
