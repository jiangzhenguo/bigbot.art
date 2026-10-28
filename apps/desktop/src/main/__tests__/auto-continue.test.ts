/**
 * 自动续跑(auto-continue)单测 —— 「Agent 提交的生成就绪后自动唤醒下一轮」的闸门与防抖。
 *
 * 背景(「飞机1」项目实测,2026-10-10):Agent 按【提交即收尾】结束本轮后,
 * 角色卡图 2 分钟就出好了,但没有任何机制触发下一轮,多步流程停在原地等用户说「继续」。
 *
 * 本测试锁四件事:
 *  1. 闸门:只认「succeeded/failed + source=agent + 有归属画布」;非终态/用户手点/缺归属不唤醒
 *  2. 防抖:同画布陆续完成的多个任务归并成一次唤醒(每次唤醒都是真实 LLM 调用)
 *  3. 防失控:连续自动轮上限;在飞对话时延后到收尾再补唤醒(技能4双图同提);用户发消息重置计数并取消待触发/延后
 *  4. 不静默:该跳过/延后却可能被误解为「没触发」的路径,都有日志留痕(红线 R6)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AutoContinueController,
  shouldAutoContinue,
  isAutoContinueNotifiable,
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
  it('队列终态入口:失败任务也必须进入控制器(2026-10-28 提前 return 事故)', () => {
    expect(isAutoContinueNotifiable(job({ status: 'failed' }))).toBe(true);
    expect(isAutoContinueNotifiable(job({ status: 'succeeded' }))).toBe(true);
    expect(isAutoContinueNotifiable(job({ status: 'running' }))).toBe(false);
    expect(isAutoContinueNotifiable(job({ status: 'failed', canvasId: undefined }))).toBe(false);
  });
  it('succeeded + agent + 归属齐全 → 放行', () => {
    expect(shouldAutoContinue(job({}), GATE_BASE).ok).toBe(true);
  });
  it('failed + agent → 放行(唤醒 Agent 按错误修复,不是静默同参重试)', () => {
    expect(shouldAutoContinue(job({ status: 'failed' }), GATE_BASE).ok).toBe(true);
  });
  it('cancelled / running 等非终态不唤醒', () => {
    expect(shouldAutoContinue(job({ status: 'cancelled' }), GATE_BASE).ok).toBe(false);
    expect(shouldAutoContinue(job({ status: 'running' }), GATE_BASE).ok).toBe(false);
  });
  it('用户手点(source 缺省/user)不唤醒', () => {
    expect(shouldAutoContinue(job({ source: undefined }), GATE_BASE).ok).toBe(false);
    expect(shouldAutoContinue(job({ source: 'user' }), GATE_BASE).ok).toBe(false);
  });
  it('缺 projectId/canvasId 不唤醒(无归属上下文)', () => {
    expect(shouldAutoContinue(job({ canvasId: undefined }), GATE_BASE).ok).toBe(false);
    expect(shouldAutoContinue(job({ projectId: undefined }), GATE_BASE).ok).toBe(false);
  });
  it('有对话在飞时闸门返回延后(Controller 会挂 deferred,不永久丢)', () => {
    const r = shouldAutoContinue(job({}), { ...GATE_BASE, inFlight: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/延后|进行中/);
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
  it('失败唤醒贴出错误并禁止同参重提(静帧 05 事故回归)', () => {
    const t = buildAutoContinueText([
      {
        nodeId: 'img-xff4',
        label: '图片生成 · 分镜静帧 05',
        error:
          '带参考图的生成需要多参考模型(当前 Qwen-Image-2.1-Uncensored-MLX 是纯文生图)',
      },
    ]);
    expect(t).toContain('生成失败');
    expect(t).toContain('Uncensored');
    expect(t).toContain('禁止用同一组参数直接重提');
    expect(t).toContain('Qwen/Qwen-Image-2.1-Turbo');
    const note = buildAutoRecallNote([
      { nodeId: 'img-xff4', label: '图片生成 · 分镜静帧 05', error: 'boom' },
    ]);
    expect(note).toContain('生成失败');
    expect(note).toContain('修复');
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

  it('agent 任务失败 → 唤醒并带上 error(让 Agent 改根因,不是静默同参重试)', () => {
    const { ctl, triggers } = makeController({});
    ctl.notifyJobFinished(job({ status: 'failed', error: '带参考图的生成需要多参考模型', nodeId: 'img-xff4' }));
    vi.advanceTimersByTime(AUTO_CONTINUE_DEBOUNCE_MS * 2);
    expect(triggers).toHaveLength(1);
    const n = triggers[0]!.notices[0] as { nodeId: string; error?: string; resultPath?: string };
    expect(n.nodeId).toBe('img-xff4');
    expect(n.error).toContain('多参考模型');
    expect(n.resultPath).toBeUndefined();
  });

  it('触发时刻画布已有对话在飞 → 改延后,对话收尾后补唤醒', () => {
    const { ctl, triggers, logs, setInFlight } = makeController({});
    ctl.notifyJobFinished(job({ nodeId: 'n1' }));
    setInFlight(true); // 防抖窗口内用户发了一条消息,对话开始
    vi.advanceTimersByTime(AUTO_CONTINUE_DEBOUNCE_MS + 1);
    expect(triggers).toHaveLength(0);
    expect(logs.some((l) => l.includes('改延后'))).toBe(true);
    setInFlight(false);
    ctl.onChatSettled(P, C);
    vi.advanceTimersByTime(AUTO_CONTINUE_DEBOUNCE_MS + 1);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.notices.map((n) => (n as { nodeId: string }).nodeId)).toEqual(['n1']);
  });

  it('技能4事故:第一张完成已唤醒、第二张在飞完成 → 对话收尾后补唤醒第二张', () => {
    const { ctl, triggers, logs, setInFlight } = makeController({});
    // 第一张:正常防抖唤醒
    ctl.notifyJobFinished(job({ id: 'job-1', nodeId: 'card-1' }));
    vi.advanceTimersByTime(AUTO_CONTINUE_DEBOUNCE_MS + 1);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.notices.map((n) => (n as { nodeId: string }).nodeId)).toEqual(['card-1']);
    // 自动轮开始(在飞)
    setInFlight(true);
    // 第二张在自动轮进行中完成 → 旧实现永久跳过;现挂 deferred
    ctl.notifyJobFinished(job({ id: 'job-2', nodeId: 'card-2', resultPath: '/tmp/scene.png' }));
    expect(logs.some((l) => l.includes('延后') && l.includes('job-2'))).toBe(true);
    expect(triggers).toHaveLength(1); // 还不能立刻再唤醒
    // 自动轮结束
    setInFlight(false);
    ctl.onChatSettled(P, C);
    vi.advanceTimersByTime(AUTO_CONTINUE_DEBOUNCE_MS + 1);
    expect(triggers).toHaveLength(2);
    expect(triggers[1]!.notices.map((n) => (n as { nodeId: string }).nodeId)).toEqual(['card-2']);
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

  it('agent 任务在飞完成时记延后日志(不静默,R6),收尾后能补唤醒', () => {
    const { ctl, triggers, logs, setInFlight } = makeController({});
    setInFlight(true);
    ctl.notifyJobFinished(job({ id: 'job-x' }));
    expect(logs.some((l) => l.includes('[auto-continue] 延后'))).toBe(true);
    setInFlight(false);
    ctl.onChatSettled(P, C);
    vi.advanceTimersByTime(AUTO_CONTINUE_DEBOUNCE_MS + 1);
    expect(triggers).toHaveLength(1);
  });

  it('用户发消息:延后队列一并清空(用户这轮会看到最新画布)', () => {
    const { ctl, triggers, setInFlight } = makeController({});
    setInFlight(true);
    ctl.notifyJobFinished(job({ nodeId: 'n1' }));
    ctl.resetOnUserMessage(P, C);
    setInFlight(false);
    ctl.onChatSettled(P, C);
    vi.advanceTimersByTime(AUTO_CONTINUE_DEBOUNCE_MS + 1);
    expect(triggers).toHaveLength(0);
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

  it('finally:先 delete inFlight 再 onChatSettled(技能4 延后补唤醒时序)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const code = readFileSync(resolve(here, '../index.ts'), 'utf8');
    const start = code.indexOf('async function executeAgentChat');
    const end = code.indexOf('async function runAutoContinueRound');
    const body = code.slice(start, end);
    const delAt = body.indexOf('inFlightChats.delete(flightKey)');
    const settleAt = body.indexOf('autoContinue.onChatSettled(opts.projectId, opts.canvasId)');
    expect(delAt).toBeGreaterThan(-1);
    expect(settleAt).toBeGreaterThan(delAt);
  });
});
