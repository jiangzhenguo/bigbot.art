/**
 * auto-continue — Agent 生成完成后的「自动续跑」(2026-10-10)
 *
 * 背景(「飞机1」项目实测):Agent 按【提交即收尾 — 禁轮询】规则,engine.submit 之后就
 * 结束本轮;而队列任务完成后整条链路里**没有任何机制唤醒 Agent** —— onJobFinish 只做
 * Take 归档 + continuity.check 展示卡。于是多步流程(角色卡 → 下一张卡 → 分镜 → 渲染)
 * 在第一步生成完成后就停在原地:图 2 分钟就出好了,Agent 却在干等用户说「继续」。
 *
 * 本模块:queue.onJobFinish 对「Agent 提交且成功」的任务做防抖归集,满足闸门条件时
 * 在主进程内部发起一轮 agent chat(合成系统通知作为本轮输入),让 Agent 验收产物并
 * 推进任务链;没有后续时它只需一句话向用户汇报。
 *
 * 防失控闸(全部宁可漏触发、不可误触发):
 *   ① 只认 source==='agent'(用户在画布手点的生成不唤醒 Agent);
 *   ② 只认 succeeded(失败走既有 Take/日志通道,不自动重试 —— 自动重试是另一种假成功温床);
 *   ③ 该画布有对话在跑时跳过(在跑的那轮经 buildContext 就能看到最新画布状态);
 *   ④ 同一画布**连续**自动轮上限 maxRounds(用户发消息即重置计数);
 *   ⑤ 短防抖归集:一轮里批量提交的多个任务陆续完成时,合并成一次唤醒,而不是每完成一个
 *      就叫醒一次(每个唤醒都是一次真实 LLM 调用)。
 */
import type { RenderJob } from '@bigbotart/shared';

/** 连续自动轮上限默认值(env BIGBOTART_AGENT_AUTO_CONTINUE_MAX 可覆盖;0 = 整体禁用) */
export const AUTO_CONTINUE_MAX_DEFAULT = 5;
/** 防抖窗口:同画布的连续完成在这个窗口内归并为一次唤醒 */
export const AUTO_CONTINUE_DEBOUNCE_MS = 2500;

/** 一次「任务完成」通知(触发唤醒时由调用方补 label) */
export interface AutoNotice {
  nodeId: string;
  label?: string;
  resultPath?: string;
}

export interface AutoGateState {
  enabled: boolean;
  /** 该画布当前是否有对话轮次在进行(手动或自动) */
  inFlight: boolean;
  /** 该画布已连续自动推进的轮数 */
  roundsUsed: number;
  maxRounds: number;
}

export type AutoGateResult = { ok: true } | { ok: false; reason: string };

/**
 * 闸门判定(纯函数)。reason 用于日志留痕 —— 跳过自动推进不是错误,但**不能静默**,
 * 否则「Agent 又没动」会回到最难查的「不知道是没触发还是被拦下」状态。
 */
export function shouldAutoContinue(
  job: Pick<RenderJob, 'status' | 'source' | 'projectId' | 'canvasId'>,
  st: AutoGateState,
): AutoGateResult {
  if (!st.enabled) return { ok: false, reason: '自动续跑已禁用(BIGBOTART_AGENT_AUTO_CONTINUE=0)' };
  if (job.status !== 'succeeded') return { ok: false, reason: `任务未成功(${job.status}),失败不自动重试` };
  if (job.source !== 'agent') return { ok: false, reason: '非 Agent 提交的任务(用户手点),不自动推进' };
  if (!job.projectId || !job.canvasId) return { ok: false, reason: '任务缺 projectId/canvasId,无归属上下文' };
  if (st.inFlight) return { ok: false, reason: '该画布有对话进行中,跳过(进行中那轮会看到最新画布状态)' };
  if (st.roundsUsed >= st.maxRounds) return { ok: false, reason: `连续自动推进已达上限 ${st.maxRounds} 轮` };
  return { ok: true };
}

/**
 * 合成唤醒 Agent 的本轮输入(作为 user 角色消息发给模型;recall 里另以 system 留痕)。
 * 必须说清三件事:①发生了什么(哪些节点出产物了);②该做什么(验收并推进);
 * ③边界(任务链完成就收尾汇报,不要再提交;这是系统唤醒不是用户新消息)。
 */
export function buildAutoContinueText(notices: AutoNotice[]): string {
  const lines = notices.map(
    (n) => `- 节点「${n.label || n.nodeId}」(${n.nodeId})已生成完成${n.resultPath ? `,产物:${n.resultPath}` : ''}`,
  );
  return [
    '[系统通知 · 生成完成,自动推进]',
    '以下由你提交的生成任务已完成,画布已自动刷新:',
    ...lines,
    '请验收结果(必要时用 canvas.get_node 查看节点产物),然后按既定计划推进下一步;',
    '若任务链已全部完成,用一句话向用户汇报成果即可,不要再提交新的生成任务。',
    '注意:本轮是系统在完成生成后自动唤醒你,不是用户发来新消息;需要用户决策时用 ask.user 提问。',
  ].join('\n');
}

/** recall 留痕文案(role=system;渲染层历史恢复会把它回显为一条说明气泡) */
export function buildAutoRecallNote(notices: AutoNotice[]): string {
  return `[自动推进] 生成完成:${notices.map((n) => `「${n.label || n.nodeId}」`).join('、')} —— 系统自动唤醒 Agent 继续任务链`;
}

export interface AutoContinueDeps {
  /** 该画布是否有对话轮次在进行(`${projectId}:${canvasId}` 键) */
  isInFlight: (canvasKey: string) => boolean;
  /** 真正发起一轮自动 chat(实现方负责补 label、组装文本、调用 agent) */
  trigger: (projectId: string, canvasId: string, notices: AutoNotice[]) => void;
  /** 连续自动轮达上限时的兜底告知(实现方可推一张界面卡;不得再触发 chat) */
  onCapReached?: (projectId: string, canvasId: string) => void;
  logger?: { log(level: 'info' | 'warn' | 'error', msg: string): void };
  enabled?: boolean;
  maxRounds?: number;
  debounceMs?: number;
}

interface PendingBurst {
  projectId: string;
  canvasId: string;
  notices: AutoNotice[];
  timer: NodeJS.Timeout;
}

export class AutoContinueController {
  private pending = new Map<string, PendingBurst>();
  private rounds = new Map<string, number>();
  /** 达上限提示按画布只推一次(批量完成的任务陆续终态时不连刷同一文案);用户发消息重置 */
  private capNotified = new Set<string>();
  private readonly enabled: boolean;
  private readonly maxRounds: number;
  private readonly debounceMs: number;

  constructor(private deps: AutoContinueDeps) {
    this.enabled = deps.enabled ?? true;
    this.maxRounds = deps.maxRounds ?? AUTO_CONTINUE_MAX_DEFAULT;
    this.debounceMs = deps.debounceMs ?? AUTO_CONTINUE_DEBOUNCE_MS;
  }

  /** 队列任务终态入口(onJobFinish 调用;每个终态任务都会进来,闸门在内部) */
  notifyJobFinished(job: RenderJob): void {
    const key = `${job.projectId ?? ''}:${job.canvasId ?? ''}`;
    const gate = shouldAutoContinue(job, {
      enabled: this.enabled && this.maxRounds > 0,
      inFlight: this.deps.isInFlight(key),
      roundsUsed: this.rounds.get(key) ?? 0,
      maxRounds: this.maxRounds,
    });
    if (!gate.ok) {
      /* 留痕口径:只对「本来可能触发」的任务(agent 来源)记录跳过原因,
         用户手点的渲染是常态,刷屏没有意义;达上限额外走 onCapReached 让用户可见。 */
      if (job.source === 'agent' && job.status === 'succeeded') {
        this.deps.logger?.log('info', `[auto-continue] 跳过 ${job.id}: ${gate.reason}`);
        if (/已达上限/.test(gate.reason) && job.projectId && job.canvasId && !this.capNotified.has(key)) {
          this.capNotified.add(key);
          this.deps.onCapReached?.(job.projectId, job.canvasId);
        }
      }
      return;
    }
    // 防抖归并:窗口内陆续完成的任务合并为一次唤醒
    const notice: AutoNotice = { nodeId: job.nodeId, resultPath: job.resultPath };
    const cur = this.pending.get(key);
    if (cur) {
      cur.notices.push(notice);
      clearTimeout(cur.timer);
      cur.timer = setTimeout(() => this.fire(key), this.debounceMs);
    } else {
      this.pending.set(key, {
        projectId: job.projectId!,
        canvasId: job.canvasId!,
        notices: [notice],
        timer: setTimeout(() => this.fire(key), this.debounceMs),
      });
    }
  }

  /** 用户发来新消息:连续自动轮计数重置;待触发的防抖取消(用户这轮会看到最新画布) */
  resetOnUserMessage(projectId: string, canvasId: string): void {
    const key = `${projectId}:${canvasId}`;
    this.rounds.delete(key);
    this.capNotified.delete(key);
    const cur = this.pending.get(key);
    if (cur) {
      clearTimeout(cur.timer);
      this.pending.delete(key);
    }
  }

  /** 防抖窗口到点:再查一次闸门(窗口内可能已有对话开始/计数已变),通过才触发 */
  private fire(key: string): void {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    if (this.deps.isInFlight(key)) {
      this.deps.logger?.log('info', `[auto-continue] 触发时画布已有对话在进行,取消本次唤醒 ${key}`);
      return;
    }
    const used = this.rounds.get(key) ?? 0;
    if (used >= this.maxRounds) {
      this.deps.logger?.log('info', `[auto-continue] 连续自动推进已达上限 ${this.maxRounds} 轮 ${key}`);
      if (!this.capNotified.has(key)) {
        this.capNotified.add(key);
        this.deps.onCapReached?.(p.projectId, p.canvasId);
      }
      return;
    }
    this.rounds.set(key, used + 1);
    this.deps.trigger(p.projectId, p.canvasId, p.notices);
  }

  /** 测试/退出用:清掉所有待触发计时器 */
  dispose(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}
