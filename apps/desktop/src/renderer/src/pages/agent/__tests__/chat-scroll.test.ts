/**
 * Agent 消息流跟随滚动回归。
 *
 * 用户上滑后 pinToBottom=false，流式事件仍应停在原位置；只有回到底部附近才恢复跟随。
 * 本项目 Vitest 使用 node 环境且无 jsdom：滚动事件直接调用真实 AgentChatView 的 props，
 * 同时用源码护栏锁住 useAgentChat 的自动滚动调用点，防止 SSE 分支再次绕过 pinToBottom。
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { AgentChatView } from '../AgentChatView';
import type { AgentChatApi } from '../useAgentChat';

const here = dirname(fileURLToPath(import.meta.url));
const hookSrc = readFileSync(resolve(here, '../useAgentChat.ts'), 'utf8');

function section(startAnchor: string, endAnchor: string): string {
  const start = hookSrc.indexOf(startAnchor);
  const end = hookSrc.indexOf(endAnchor, start + startAnchor.length);
  expect(start, `找不到代码起点: ${startAnchor}`).toBeGreaterThan(-1);
  expect(end, `找不到代码终点: ${endAnchor}`).toBeGreaterThan(start);
  return hookSrc.slice(start, end);
}

function chatScrollHandler(pinToBottom: { current: boolean }) {
  const chat = {
    msgs: [],
    todos: [],
    todoError: null,
    send: () => true,
    askPick: () => {},
    askReset: () => {},
    chatRef: { current: null },
    pinToBottom,
    model: 'test',
    modelOverridden: false,
  } as unknown as AgentChatApi;
  const tree = AgentChatView({ chat, onLocate: () => {}, onOpenSettings: () => {} });
  const children = React.Children.toArray(tree.props.children);
  const chatElement = children.find(
    (child): child is React.ReactElement => React.isValidElement(child) && child.props.className === 'chat',
  );
  expect(chatElement, 'AgentChatView 缺少消息滚动容器').toBeDefined();
  return chatElement!.props.onScroll as (event: { currentTarget: unknown }) => void;
}

describe('Agent 聊天跟随滚动', () => {
  it('用户上滑会暂停跟随，回到底部 80px 内才恢复', () => {
    const pin = { current: true };
    const onScroll = chatScrollHandler(pin);
    const el = { scrollHeight: 1200, clientHeight: 300, scrollTop: 500 };

    onScroll({ currentTarget: el });
    expect(pin.current).toBe(false);

    el.scrollTop = 810; // 距底 90px，仍未恢复
    onScroll({ currentTarget: el });
    expect(pin.current).toBe(false);

    el.scrollTop = 825; // 距底 75px，恢复跟随
    onScroll({ currentTarget: el });
    expect(pin.current).toBe(true);
  });

  it('消息更新 effect 只在 pinToBottom=true 时自动贴底', () => {
    const effect = section('/* 消息流唯一自动贴底入口', '/* 受控与非受控之间同步 textarea 初值 */');
    expect(effect).toContain('!pinToBottom.current');
    expect(effect).toContain('el.scrollTop = el.scrollHeight');
  });

  it('实时 Agent 事件不得在末尾绕过 pinToBottom 强行贴底', () => {
    const failedBranchEnd = section("} else if (ev.kind === 'failed')", 'return off;');
    expect(failedBranchEnd, 'SSE 事件末尾的无条件贴底会把上滑用户重新拉到底部').not.toMatch(
      /chatRef\.current\.scrollTop\s*=\s*chatRef\.current\.scrollHeight/,
    );
  });

  it('对话收尾不得绕过 pinToBottom 强行贴底', () => {
    const settle = section('const settleChat = useCallback', 'const settleRef = useRef');
    expect(settle).not.toMatch(/chatRef\.current\.scrollTop\s*=\s*chatRef\.current\.scrollHeight/);
  });

  it('自动续跑保留用户的滚动位置，不重置跟随状态', () => {
    const beginAuto = section('const beginAuto = () => {', 'if (ev.threadId');
    expect(beginAuto).not.toMatch(/pinToBottom\.current\s*=\s*true/);
    expect(beginAuto).not.toMatch(/chatRef\.current\.scrollTop\s*=\s*chatRef\.current\.scrollHeight/);
  });
});
