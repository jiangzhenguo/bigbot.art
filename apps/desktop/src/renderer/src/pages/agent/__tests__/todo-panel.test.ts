/**
 * 固定 todo 进度面板：清单位于聊天下方/输入区上方，工具卡与系统摘要不再重复占用消息流。
 * node 环境用 react-dom/server 验证真实组件输出，不引入额外 DOM 测试依赖。
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentTodoItem } from '@bigbotart/shared';
import { AgentChatView } from '../AgentChatView';
import type { AgentChatApi } from '../useAgentChat';
import type { ChatMsg, ToolRun } from '../types';
import { isTodoActivityText, withoutTodoToolRuns } from '../todo-display';

const TODO_RUN: ToolRun = {
  name: 'todo.write',
  args: { todos: [{ content: '验收', status: 'in_progress' }] },
  status: 'success',
  result: '任务清单已更新:待办 0,进行中 1,已完成 0。',
};

function renderView(msgs: ChatMsg[], todos: AgentTodoItem[]): string {
  const chat = {
    msgs,
    todos,
    send: () => true,
    askPick: () => {},
    askReset: () => {},
    chatRef: { current: null },
    pinToBottom: { current: true },
    model: 'grok-4.7 · opencode go',
    modelOverridden: false,
  } as unknown as AgentChatApi;
  return renderToStaticMarkup(
    React.createElement(AgentChatView, {
      chat,
      onLocate: () => {},
      onOpenSettings: () => {},
    }),
  );
}

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

describe('todo 展示分流', () => {
  it('只过滤 todo.write，保留其他工具行', () => {
    const vision: ToolRun = { name: 'vision.caption', args: { nodeId: 'n1' }, status: 'success' };
    expect(withoutTodoToolRuns([TODO_RUN, vision])).toEqual([vision]);
  });

  it('识别主进程写入 recall 的任务清单系统摘要', () => {
    expect(isTodoActivityText('已更新任务清单(5 项)')).toBe(true);
    expect(isTodoActivityText('已更新任务清单（5 项）')).toBe(true);
    expect(isTodoActivityText('已清空任务清单')).toBe(true);
    expect(isTodoActivityText('已执行 vision.caption')).toBe(false);
    expect(isTodoActivityText(undefined)).toBe(false);
  });
});

describe('AgentChatView · 固定任务进度', () => {
  it('面板固定在聊天之后并显示最新清单；混合工具卡只保留其他工具', () => {
    const html = renderView(
      [
        {
          id: 1,
          kind: 'agent',
          toolRuns: [TODO_RUN, { name: 'vision.caption', args: { nodeId: 'n1' }, status: 'success' }],
        },
        { id: 2, kind: 'sys', text: '已更新任务清单(3 项)' },
      ],
      [
        { content: '完成任务', status: 'completed' },
        { content: '正在验收', status: 'in_progress' },
        { content: '等待导出', status: 'pending' },
      ],
    );
    const text = textOf(html);

    expect(html).toContain('data-od-id="agent-todo-panel"');
    expect(html.indexOf('class="chat"')).toBeLessThan(html.indexOf('data-od-id="agent-todo-panel"'));
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="33"');
    expect(text).toContain('1/3 已完成');
    expect(text).toContain('完成任务');
    expect(text).toContain('正在验收');
    expect(text).toContain('等待导出');
    expect(text).toContain('本轮执行 1 个工具');
    expect(text).toContain('vision.caption');
    expect(text).not.toContain('todo.write');
    expect(text).not.toContain('已更新任务清单');
  });

  it('只有 todo 的旧/新工具记录与摘要全部隐藏；空清单不占底部空间', () => {
    const html = renderView(
      [
        { id: 1, kind: 'agent', toolRuns: [TODO_RUN] },
        { id: 2, kind: 'agent', toolCall: TODO_RUN },
        { id: 3, kind: 'sys', text: '已清空任务清单' },
      ],
      [],
    );
    expect(html).not.toContain('data-od-id="agent-todo-panel"');
    expect(html).not.toContain('data-od-id="agent-tools"');
    expect(html).not.toContain('todo.write');
    expect(html).not.toContain('已清空任务清单');
  });
});
