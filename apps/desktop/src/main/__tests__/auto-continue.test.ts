/**
 * 自动续跑(auto-continue)单测 —— 「Agent 提交的生成就绪后自动唤醒下一轮」的闸门与防抖。
 *
 * 背景(「飞机1」项目实测,2026-10-10):Agent 按【提交即收尾】结束本轮后,
 * 角色卡图 2 分钟就出好了,但没有任何机制触发下一轮,多步流程停在原地等用户说「继续」。
 *
 * 本测试锁四件事:
 *  1. 闸门:只认「succeeded + source=agent + 有归属画布」;失败/用户手点/缺归属一律不唤醒
 *  2. 防抖:同画布陆续完成的多个任务归并成一次唤醒(每次唤醒都是真实 LLM 调用)
 *  3. 防失控:连续自动轮上限;在飞对话时跳过;用户发消息重置计数并取消待触发
 *  4. 不静默:该跳过却可能被误解为「没触发」的路径,都有日志留痕(红线 R6)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AutoContinueController,
  shouldAutoContinue,
  buildAutoContinueText,
  buildAutoRecallNote,
  AUTO_CONTINUE_DEBOUNCE_MS,
} from '../auto-continue';
import { RenderQueue } from '../render-queue';
import type { RenderJob } from '@bigbotart/shared';

const P = 'p-auto';
const C = 'c-auto';

function job(patch: Partial<RenderJob>): RenderJob {
  return {
    id: `job-${Math.random().toString(36).slice(2, 8)}`,
    nodeId: 'n1',
    provider: 'mlxgen',
    status: 'succeeded',
    slot: 'image',
    projectId: P,
    canvasId: C,
    source: 'agent',
    resultPath: '/tmp/out.png',
    createdAt: '',
    updatedAt: '',
    ...patch,
  };
}

const GATE_BASE = { enabled: true, inFlight: false, roundsUsed: 0, maxRounds: 5 };

describe('shouldAutoContinue 闸门', () => {
  it('succeeded + agent + 归属齐全 → 放行', () => {
    expect(shouldAutoContinue(job({}), GATE_BASE).ok).toBe(true);
  });
  it('failed 不自动重试(失败走既有 Take/日志通道)', () => {
    const r = shouldAutoContinue(job({ status: 'failed' }), GATE_BASE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('未成功');
  });
  it('用户手点(source 缺省/user)不唤醒', () => {
    expect(shouldAutoContinue(job({ source: undefined }), GATE_BASE).ok).toBe(false);
    expect(shouldAutoContinue(job({ source: 'user' }), GATE_BASE).ok).toBe(false);
  });
  it('缺 projectId/canvasId 不唤醒(无归属上下文)', () => {
    expect(shouldAutoContinue(job({ canvasId: undefined }), GATE_BASE).ok).toBe(false);
    expect(shouldAutoContinue(job({ projectId: undefined }), GATE_BASE).ok).toBe(false);
  });
  it('有对话在飞时跳过', () => {
    const r = shouldAutoContinue(job({}), { ...GATE_BASE, inFlight: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('进行中');
  });
  it('连续自动轮达上限后不再触发', () => {
    const r = shouldAutoContinue(job({}), { ...GATE_BASE, roundsUsed: 5, maxRounds: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('上限');
  });
  it('整体禁用时不触发', () => {
    expect(shouldAutoContinue(job({}), { ...GATE_BASE, enabled: false }).ok).toBe(false);
  });
});

describe('buildAutoContinueText / buildAutoRecallNote', () => {
  it('唤醒文本含节点标题、产物路径与行为边界', () => {
    const t = buildAutoContinueText([
      { nodeId: 'img-1', label: '角色卡 · 苏青', resultPath: '/tmp/a.png' },
      { nodeId: 'img-2' },
    ]);
    expect(t).toContain('角色卡 · 苏青');
    expect(t).toContain('img-1');
    expect(t).toContain('/tmp/a.png');
    expect(t).toContain('img-2'); // 无标题时回退 id
    expect(t).toContain('不要再提交新的生成任务'); // 任务链完成的收尾边界
    expect(t).toContain('ask.user'); // 需要决策时的出口
    expect(t).toContain('不是用户发来新消息'); // 防误读为用户指令
  });
  it('recall 留痕含节点标题(system 角色,不占用户指令位)', () => {
    const t = buildAutoRecallNote([{ nodeId: 'img-1', label: '角色卡 · 苏青' }]);
    expect(t).toContain('自动推进');
    expect(t).toContain('角色卡 · 苏青');
  });
});

describe('AutoContinueController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeController(overrides: Record<string, unknown>) {
    const triggers: Array<{ projectId: string; canvasId: string; notices: unknown[] }> = [];
    const caps: string[] = [];
    const logs: string[] = [];
    let inFlight = false;
    const ctl = new AutoContinueController({
      isInFlight: () => inFlight,
      trigger: (projectId, canvasId, notices) => triggers.push({ projectId, canvasId, notices }),
      onCapReached: (p, c) => caps.push(`${p}:${c}`),
      logger: { log: (lv, m) => logs.push(`${lv}:${m}`) },
      ...(overrides as object),
    });
    return {
      ctl,
      triggers,
      caps,
      logs,
      setInFlight: (v: boolean) => {
        inFlight = v;
      },
    };
  }

  it('agent 任务成功 → 防抖后触发一次唤醒', () => {
    const { ctl, triggers } = makeController({});
    ctl.notifyJobFinished(job({}));
    expect(triggers).toHaveLength(0); // 防抖窗口内不触发
    vi.advanceTimersByTime(AUTO_CONTINUE_DEBOUNCE_MS + 1);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.projectId).toBe(P);
    expect(triggers[0]!.notices).toHaveLength(1);
  });

  it('窗口内陆续完成的多个任务归并成一次唤醒(批跑场景)', () => {
    const { ctl, triggers } = makeController({});
    ctl.notifyJobFinished(job({ nodeId: 'n1' }));
    vi.advanceTimersByTime(1000);
    ctl.notifyJobFinished(job({ nodeId: 'n2' }));
    vi.advanceTimersByTime(1000);
    ctl.notifyJobFinished(job({ nodeId: 'n3' }));
    vi.advanceTimersByTime(AUTO_CONTINUE_DEBOUNCE_MS + 1);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.notices.map((n) => (n as { nodeId: string }).nodeId)).toEqual(['n1', 'n2', 'n3']);
  });

  it('用户手点的任务不触发,也不留跳过日志(常态不刷屏)', () => {
    const { ctl, triggers, logs } = makeController({});
    ctl.notifyJobFinished(job({ source: undefined }));
    ctl.notifyJobFinished(job({ source: 'user' }));
    vi.advanceTimersByTime(AUTO_CONTINUE_DEBOUNCE_MS * 2);
    expect(triggers).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it('agent 任务失败不触发自动重试', () => {
    const { ctl, triggers } = makeController({});
    ctl.notifyJobFinished(job({ status: 'failed' }));
    vi.advanceTimersByTime(AUTO_CONTINUE_DEBOUNCE_MS * 2);
    expect(triggers).toHaveLength(0);
  });

  it('触发时刻画布已有对话在飞 → 取消本次唤醒并留痕', () => {
    const { ctl, triggers, logs, setInFlight } = makeController({});
    ctl.notifyJobFinished(job({}));
    setInFlight(true); // 防抖窗口内用户发了一条消息,对话开始
    vi.advanceTimersByTime(AUTO_CONTINUE_DEBOUNCE_MS + 1);
    expect(triggers).toHaveLength(0);
    expect(logs.some((l) => l.includes('取消本次唤醒'))).toBe(true);
  });

  it('连续自动轮达上限:不再触发,走 onCapReached 让用户可见', () => {
    const { ctl, triggers, caps } = makeController({ maxRounds: 1 });
    ctl.notifyJobFinished(job({ nodeId: 'n1' }));
    vi.advanceTimersByTime(AUTO_CONTINUE_DEBOUNCE_MS + 1);
    expect(triggers).toHaveLength(1);
    // 第二轮(上一轮的 engine.submit 又出产物了)→ 达上限
    ctl.notifyJobFinished(job({ nodeId: 'n2' }));
    vi.advanceTimersByTime(AUTO_CONTINUE_DEBOUNCE_MS + 1);
    expect(triggers).toHaveLength(1);
    expect(caps).toEqual([`${P}:${C}`]);
    // 达上限后批量任务陆续终态,不连刷同一提示卡(按画布只推一次)
    ctl.notifyJobFinished(job({ nodeId: 'n3' }));
    ctl.notifyJobFinished(job({ nodeId: 'n4' }));
    vi.advanceTimersByTime(AUTO_CONTINUE_DEBOUNCE_MS + 1);
    expect(caps).toHaveLength(1);
    // 用户发消息后重置:新一轮上限周期,提示卡可再推
    ctl.resetOnUserMessage(P, C);
    ctl.notifyJobFinished(job({ nodeId: 'n5' }));
    vi.advanceTimersByTime(AUTO_CONTINUE_DEBOUNCE_MS + 1);
    expect(triggers).toHaveLength(2); // 计数已重置,恢复触发
  });

  it('用户发消息:重置连续计数 + 取消待触发的防抖', () => {
    const { ctl, triggers } = makeController({ maxRounds: 1 });
    ctl.notifyJobFinished(job({ nodeId: 'n1' }));
    ctl.resetOnUserMessage(P, C); // 防抖还没 firing,用户说话了
    vi.advanceTimersByTime(AUTO_CONTINUE_DEBOUNCE_MS + 1);
    expect(triggers).toHaveLength(0); // 待触发被取消(用户这轮会看到最新画布)
    // 之后新的完成又能触发(计数已重置)
    ctl.notifyJobFinished(job({ nodeId: 'n2' }));
    vi.advanceTimersByTime(AUTO_CONTINUE_DEBOUNCE_MS + 1);
    expect(triggers).toHaveLength(1);
  });

  it('整体禁用(enabled=false):agent 成功任务也不触发', () => {
    const { ctl, triggers } = makeController({ enabled: false });
    ctl.notifyJobFinished(job({}));
    vi.advanceTimersByTime(AUTO_CONTINUE_DEBOUNCE_MS * 2);
    expect(triggers).toHaveLength(0);
  });

  it('agent 任务被跳过(在飞)时有日志留痕(不静默,R6)', () => {
    const { ctl, logs, setInFlight } = makeController({});
    setInFlight(true);
    ctl.notifyJobFinished(job({}));
    expect(logs.some((l) => l.includes('[auto-continue] 跳过'))).toBe(true);
  });
});

describe('RenderQueue.source 透传', () => {
  it('submit 把 req.source 带到 job 上(onJobFinish 据它判定是否唤醒)', () => {
    const provider = {
      id: 'mlxgen',
      check: async () => ({ ready: true }),
      submit: async () => ({ providerTaskId: 'h-1' }),
      status: async () => ({ status: 'RUNNING' }),
      cancel: async () => {},
    };
    const registry = { get: () => provider } as never;
    const settings = { get: () => ({ renderMode: 'real', ssdStreaming: false }) } as never;
    const q = new RenderQueue(registry, settings);
    q.submit({
      provider: 'mlxgen',
      nodeId: 'n1',
      slot: 'image',
      projectId: P,
      canvasId: C,
      takeId: 't-1',
      source: 'agent',
      params: {},
    });
    expect(q.list()[0]?.source).toBe('agent');
    // 渲染层手点路径不传 source → undefined(不会被误当 agent)
    q.submit({ provider: 'mlxgen', nodeId: 'n2', slot: 'image', params: {} });
    expect(q.list()[1]?.source).toBeUndefined();
  });
});

describe('executeAgentChat 占坑时序', () => {
  it('inFlight 在 resolveLlmEndpoint 之前占上,自动轮被拒时有日志', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const code = readFileSync(resolve(here, '../index.ts'), 'utf8');
    const start = code.indexOf('async function executeAgentChat');
    const end = code.indexOf('async function runAutoContinueRound');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = code.slice(start, end);
    const addAt = body.indexOf('inFlightChats.add(flightKey)');
    const awaitAt = body.indexOf('await resolveLlmEndpoint');
    expect(addAt).toBeGreaterThan(-1);
    expect(awaitAt).toBeGreaterThan(addAt);
    expect(body).toContain('[auto-continue] 自动推进放弃:该画布有对话正在进行');
  });
});
