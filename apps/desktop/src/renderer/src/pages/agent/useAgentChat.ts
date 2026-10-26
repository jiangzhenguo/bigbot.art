/**
 * useAgentChat — Agent 对话面板的全部状态与副作用(容器逻辑)
 *
 * 职责:消息流(msgs)、发送/打断、SSE 工具事件实时聚合、历史恢复(recall)、
 *       模型选择器清单与项目级 LLM 回显、贴底滚动。
 * 视图层(AgentChatView / cards/*)只接这里的返回值,不直接碰 window.bigbotart。
 *
 * ⚠️ React 规范(AGENTS.md §8):setState updater 必须纯——ref/自增 id 一律在 updater 外完成
 *    (StrictMode 下 updater 双跑,updater 内改 ref 会导致重复建卡,本项目真实事故)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { AgentChatResponse, Asset, ChatThreadListItem, LlmSource } from '@bigbotart/shared';
import type { ChatMsg, ModelOption, ToolRun } from './types';
import { MODEL_OPTION_FALLBACK } from './constants';
import { restoreMsgsFromRecall } from './restore-msgs';
import { appendStreamingDraft, clearStreamingDraft, rememberAgentEvent, resetStreamingDraft, shouldSettleAgentResponse } from './stream-state';
import { llmDisplayName } from './llm-display';

/** 错误卡标题:模板类错误(本地模型 Prompt Template 损坏,pi-chat 已附修复指引)/ 不可达 / 其他对话失败 */
function errorCardTitle(detail: string): string {
  if (/jinja|prompt\s*template|no user query|修复指引/i.test(detail)) return '本地模型提示词模板异常';
  if (/不可达|不可用|超时|timeout|ECONNREFUSED|fetch failed|connect/i.test(detail)) return '对话服务不可达';
  return '对话失败';
}

export interface UseAgentChatOptions {
  projectId: string | null;
  canvasId: string;
  /** 工具改动画布后回调(CanvasPage 重拉节点) */
  onCanvasMutated: () => void;
  toastMsg: (msg: string) => void;
  /** 聊天关注节点列表(ref 稳定引用,避免关注变化重建 send;随对话请求注入让 Agent 感知,标题供用户气泡回显。
   *  2026-10 起为多节点数组:右键「添加到聊天窗口」累积 + 发送时可再叠 @ 提及) */
  focusNodesRef?: RefObject<Array<{ id: string; title: string }>>;
}

export function useAgentChat({ projectId, canvasId, onCanvasMutated, toastMsg, focusNodesRef }: UseAgentChatOptions) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  /** 同步写 ref,避免「打断后立刻再发」读到旧的 sending 闭包 */
  const markSending = useCallback((on: boolean) => {
    sendingRef.current = on;
    setSending(on);
  }, []);
  /**
   * 有一轮 Agent 对话尚未收尾。点了「打断」只是发出取消,worker 停下前仍算忙,
   * 这段时间再发消息要排队,不能另开一轮把收尾事件写错对话。
   * 压缩对话只占 sending,不算这里。
   */
  const [agentBusy, setAgentBusy] = useState(false);
  const agentBusyRef = useRef(false);
  const markAgentBusy = useCallback((on: boolean) => {
    agentBusyRef.current = on;
    setAgentBusy(on);
  }, []);
  /** 执行中发出的下一条还在等上一轮停下 */
  const [replacing, setReplacing] = useState(false);
  const replacingRef = useRef(false);
  const pendingReplace = useRef<{
    text: string;
    attachments?: Asset[];
    mentions?: Array<{ id: string; title: string }>;
  } | null>(null);
  /** 这次收尾是为了接上一条新指令 */
  const preemptingRef = useRef(false);
  /** 纯打断已经写过系统行,收尾时不要再写一行 */
  const interruptNoted = useRef(false);
  /** 当前轮次代号。旧请求的回执晚到时不得改新一轮的忙状态 */
  const roundGen = useRef(0);
  const flushReplaceRef = useRef<() => void>(() => {});
  /** 本画布会话列表 + 活跃会话(历史聊天) */
  const [threads, setThreads] = useState<ChatThreadListItem[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const activeThreadIdRef = useRef<string | null>(null);
  activeThreadIdRef.current = activeThreadId;

  const chatRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const msgId = useRef(100);
  /** 本轮工具聚合卡(ToolRunCard)的消息 id;一轮对话一张卡,SSE 实时更新,回复到达后对账 */
  const liveToolCardId = useRef<number | null>(null);
  /** 本轮模型流式草稿的消息 id;round-start 重置,done/failed 时由权威结果替换 */
  const liveStreamMsgId = useRef<number | null>(null);
  /**
   * 本轮是否已收尾(settleChat 幂等闸)。
   * `done`/`failed` 终局事件在 dev StrictMode 或 effect 重订阅竞态下可能被投递两次,
   * 第二次会因 liveToolCardId 已清空而再补一张卡(真实事故:识别提示词显示两次)。
   * 发送新消息时重置为 false,收尾时置 true。
   */
  const settleGuard = useRef(false);
  /** 最近处理过的实时事件指纹(防止同一事件被重复订阅的监听器投递两次,见事件订阅 effect) */
  const seenEvents = useRef<Set<string>>(new Set());
  /** 消息流是否贴底(用户在底部附近时新消息自动跟随;往上翻则不打扰) */
  const pinToBottom = useRef(true);

  /* ── 模型选择器 ── */
  const [model, setModel] = useState('Ornith-1.5-35B · 本地');
  /** 当前显示的模型是否来自项目级覆盖(false = 全局默认) */
  const [modelOverridden, setModelOverridden] = useState(false);
  /* 🆕 当前画布激活技能(触发技能注入卡/输入区 chip;进入页面经 skill-active 查询恢复) */
  const [activeSkill, setActiveSkill] = useState<{ skillId: string; name: string; inject?: 'full' | 'summary' } | null>(null);
  /* 模型选择器:真实清单(已加载本地模型 + 已启用云端供应商模型),打开弹层时刷新 */
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(MODEL_OPTION_FALLBACK);
  const loadModelOptions = useCallback(async (): Promise<void> => {
    const opts: ModelOption[] = [];
    try {
      const kinds = [
        ['lmstudio', 'LM Studio', 'lmstudio'],
        ['ollama', 'Ollama', 'ollama'],
        ['pimlx', 'pi-mlx', 'mlx-provider'],
      ] as const;
      const runtimes = await Promise.all(kinds.map(([k]) => window.bigbotart.llmLocalModels(k).catch(() => null)));
      runtimes.forEach((rt, i) => {
        const k = kinds[i];
        if (!rt?.available || !k) return;
        const [, label, sourceKind] = k;
        rt.models
          .filter((m) => m.loaded)
          .forEach((m) => {
            const dn = m.displayName ?? m.id;
            opts.push({
              name: `${dn} · 本地`,
              sub: `${dn} · ${label}`,
              source: { kind: sourceKind, model: m.id } as LlmSource,
            });
          });
      });
      const s = await window.bigbotart.getSettings();
      for (const p of s.cloudProviders ?? []) {
        if (!p.enabled || !p.models.length) continue;
        p.models.forEach((mid) =>
          opts.push({
            name: `${mid} · ${p.name}`,
            sub: `${mid} · ${p.name}${p.hasKey ? '' : ' · 缺 Key'}`,
            source: { kind: 'cloud', provider: p.id, model: mid },
          }),
        );
      }
    } catch {
      /* 清单拉取失败:保留全局默认兜底 */
    }
    opts.push(...MODEL_OPTION_FALLBACK);
    setModelOptions(opts);
  }, []);

  /* 模型回显:进入项目时读取持久化的项目级覆盖(无则回退全局设置),修复「重启后丢回默认」 */
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    void Promise.all([window.bigbotart.listProjects(), window.bigbotart.getSettings()])
      .then(([projects, s]) => {
        if (!alive) return;
        const proj = projects.find((p) => p.id === projectId);
        if (proj?.llmOverride) {
          setModel(llmDisplayName(proj.llmOverride, s));
          setModelOverridden(true);
        } else {
          setModel(s.llm ? llmDisplayName(s.llm, s) : 'Ornith-1.5-35B · 本地');
          setModelOverridden(false);
        }
      })
      .catch((e) => console.error('读取项目 LLM 配置失败', e));
    return () => {
      alive = false;
    };
  }, [projectId]);

  /** 选择模型(模型弹层点选):m.reset = 回退全局默认 */
  const pickModel = useCallback(
    (m: ModelOption) => {
      setModelOverridden(!m.reset);
      if (m.reset) {
        // 回退全局:显示真实的全局模型名,而不是「全局默认」占位
        void window.bigbotart
          .getSettings()
          .then((s) => setModel(s.llm ? llmDisplayName(s.llm, s) : 'Ornith-1.5-35B · 本地'))
          .catch(() => setModel(m.name));
      } else {
        setModel(m.name);
      }
      if (!projectId) return;
      void window.bigbotart
        .setProjectLlm(projectId, m.reset ? null : (m.source ?? null))
        .then(() => toastMsg(m.reset ? '已回退全局 LLM 默认' : `项目级 LLM 已切换 · ${m.name}`))
        .catch((e) => console.error('设置项目 LLM 失败', e));
    },
    [projectId, toastMsg],
  );

  /* 切换项目/画布:清空对话区与会话态,真实历史由恢复 effect 填充 */
  useEffect(() => {
    liveStreamMsgId.current = null;
    setMsgs([]);
    setThreads([]);
    setActiveThreadId(null);
    setHistoryOpen(false);
  }, [projectId, canvasId]);

  const refreshThreads = useCallback(async (): Promise<ChatThreadListItem[]> => {
    if (!projectId || !canvasId) return [];
    try {
      const list = await window.bigbotart.chatThreadsList(projectId, canvasId);
      setThreads(list);
      return list;
    } catch (e) {
      console.error('拉取会话列表失败', e);
      return [];
    }
  }, [projectId, canvasId]);

  const loadThreadMessages = useCallback(
    async (threadId: string, opts?: { prepend?: boolean }) => {
      if (!projectId) return;
      const prepend = opts?.prepend ?? false;
      if (!prepend) liveStreamMsgId.current = null;
      try {
        const recall = await window.bigbotart.chatThreadMessages(projectId, threadId);
        // 慢回执不得覆盖已经切走的会话;auto-start 的 prepend 也不得覆盖实时草稿/终局。
        if (activeThreadIdRef.current !== threadId) return;
        const restored = restoreMsgsFromRecall(recall, () => ++msgId.current);
        if (prepend) setMsgs((current) => [...restored, ...current]);
        else setMsgs(restored);
        pinToBottom.current = true;
      } catch (e) {
        console.error('恢复会话消息失败', e);
        if (!prepend) setMsgs([]);
      }
    },
    [projectId],
  );

  /* 消息流自动贴底:用户在底部附近时,新消息(回复/工具行/loading)到达即滚到底;往上翻查历史则不打扰 */
  useEffect(() => {
    const el = chatRef.current;
    if (!el || !pinToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [msgs]);

  /* 受控与非受控之间同步 textarea 初值 */
  useEffect(() => {
    const el = inputRef.current;
    if (el) el.value = chatInput;
  }, [chatInput]);

  const autoGrow = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  /** 追加一条消息(供画布侧规划落地等场景注入;id 在这里统一分配) */
  const pushMsg = useCallback((msg: Omit<ChatMsg, 'id'>) => {
    setMsgs((m) => [...m, { ...msg, id: ++msgId.current }]);
  }, []);

  /** /clear 命令:清空**当前活跃会话**(UI + 持久化 recall/压缩摘要;画布/产物与其他会话不受影响) */
  const clearChat = useCallback(() => {
    if (!projectId || !canvasId) {
      toastMsg('请先进入一个项目画布');
      return;
    }
    liveStreamMsgId.current = null;
    setMsgs([]);
    pinToBottom.current = true;
    void window.bigbotart
      .memoryClear(projectId, canvasId)
      .then((res) => {
        toastMsg(res.ok ? `已清空当前对话 · 移除 ${res.cleared} 条记录` : `清空失败:${res.error ?? '未知错误'}`);
        void refreshThreads();
      })
      .catch((e) => toastMsg(`清空失败:${e instanceof Error ? e.message : String(e)}`));
  }, [projectId, canvasId, toastMsg, refreshThreads]);

  /** /compact 命令:把旧对话压成摘要(LLM 总结 + 裁剪 recall),保留最近若干条承接上下文 */
  const compactChat = useCallback(() => {
    if (!projectId || !canvasId) {
      toastMsg('请先进入一个项目画布');
      return;
    }
    const loadingId = ++msgId.current;
    markSending(true);
    setMsgs((m) => [...m, { id: loadingId, kind: 'sys', loading: true, text: '正在压缩对话…' }]);
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
    window.bigbotart
      .memoryCompact(projectId, canvasId)
      .then((res) => {
        // updater 外一次分配 id(StrictMode 下 updater 双跑,ref 改动必须在 updater 外)
        const doneId = ++msgId.current;
        setMsgs((m) => {
          const rest = m.filter((x) => x.id !== loadingId);
          if (res.ok && res.skipped) {
            return [...rest, { id: doneId, kind: 'sys', text: '对话太短,无需压缩' }];
          }
          if (res.ok && res.summary) {
            return [
              ...rest,
              { id: doneId, kind: 'sys', text: `已压缩 ${res.replaced ?? 0} 条旧消息${res.fallback ? ' · LLM 不可用,使用兜底摘要' : ''}:\n${res.summary}` },
            ];
          }
          return [...rest, { id: doneId, kind: 'agent', error: { title: '压缩失败', detail: res.error ?? '未知错误' } }];
        });
        if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
      })
      .catch((e) => {
        const errId = ++msgId.current;
        const detail = e instanceof Error ? e.message : String(e);
        setMsgs((m) => [...m.filter((x) => x.id !== loadingId), { id: errId, kind: 'agent', error: { title: '压缩失败', detail } }]);
      })
      .finally(() => markSending(false));
  }, [projectId, canvasId, markSending]);

  /* ══ 对话发送 / 打断 ══ */
  const send = useCallback(
    (overrideText?: string, attachments?: Asset[], mentions?: Array<{ id: string; title: string }>): boolean => {
      const v = (overrideText ?? chatInput).trim();
      const atts = attachments ?? [];
      // 有附件时允许空文本发送
      if (!v && atts.length === 0) return false;
      const pid = projectId;
      const cid = canvasId;
      if (!pid || !cid) {
        toastMsg('请先进入一个项目画布');
        return false;
      }
      // 上一轮还没停:先打断,等收尾后再真正发出(输入区「打断并发送」)
      if (agentBusyRef.current) {
        pendingReplace.current = { text: v, attachments: atts, mentions };
        preemptingRef.current = true;
        if (!replacingRef.current) {
          replacingRef.current = true;
          setReplacing(true);
          void window.bigbotart.agentCancel(pid);
        }
        setChatInput('');
        if (inputRef.current) {
          inputRef.current.value = '';
          autoGrow(inputRef.current);
        }
        return true;
      }
      // 压缩进行中:不插队
      if (sendingRef.current) return false;
      // ✂️ 斜杠命令(仅纯文本时识别;带附件视为普通消息):/clear 清空对话 · /compact 压缩上下文
      if (atts.length === 0) {
        const cmd = v.match(/^\/(clear|compact)(?:\s|$)/)?.[1];
        if (cmd === 'clear') {
          clearChat();
          setChatInput('');
          if (inputRef.current) inputRef.current.value = '';
          return true;
        }
        if (cmd === 'compact') {
          compactChat();
          setChatInput('');
          if (inputRef.current) inputRef.current.value = '';
          return true;
        }
      }
      // 本轮引用节点 = 常驻关注(右键添加) + 本条消息 @ 提及,按 id 去重;
      // updater 外一次读取(StrictMode 双跑安全),记入用户消息供回显
      const ctxNodes: Array<{ id: string; title: string }> = [];
      for (const n of [...(focusNodesRef?.current ?? []), ...(mentions ?? [])]) {
        if (!ctxNodes.some((x) => x.id === n.id)) ctxNodes.push(n);
      }
      setMsgs((m) => [
        ...m,
        {
          id: ++msgId.current,
          kind: 'user',
          text: v || '(附件)',
          attachments: atts.length ? atts.map((a) => ({ name: a.name, kind: a.kind, localPath: a.localPath })) : undefined,
          contextNodes: ctxNodes.length ? ctxNodes : undefined,
        },
      ]);
      setChatInput('');
      pinToBottom.current = true;
      if (inputRef.current) {
        inputRef.current.value = '';
        autoGrow(inputRef.current);
      }
      // 新一轮开始:重置聚合卡与流式草稿指针(SSE tool-start / text-delta 会建新卡)
      liveToolCardId.current = null;
      liveStreamMsgId.current = null;
      settleGuard.current = false; // 新一轮:打开收尾闸(见 settleGuard 声明)
      const myGen = ++roundGen.current;
      // loading 气泡
      const loadingId = ++msgId.current;
      markAgentBusy(true);
      markSending(true);
      setMsgs((m) => [...m, { id: loadingId, kind: 'sys', loading: true, text: '思考中…' }]);
      if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;

      window.bigbotart
        .agentChat({
          projectId: pid,
          canvasId: cid,
          threadId: activeThreadIdRef.current ?? undefined,
          text: v,
          attachments: atts.length ? atts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, localPath: a.localPath })) : undefined,
          selectedNodeIds: ctxNodes.length ? ctxNodes.map((n) => n.id) : undefined,
        })
        .then((res) => {
          // 本轮已被新一轮取代(打断后发出的下一条):旧回执作废
          if (roundGen.current !== myGen) return;
          // 批次1 任务化:主进程立即回执 {ok:true,accepted:true},真正结果走 agent-event
          // 的 done/failed。收到回执时**只切状态、不收尾**(否则会在工具还在跑时就把卡片封死);
          // 若主进程走了同步失败路径(带 error 且非 accepted),则在这里直接收尾。
          if (res.accepted && res.ok) {
            setMsgs((m) => m.map((x) => (x.id === loadingId ? { ...x, text: '执行中…' } : x)));
            return;
          }
          // 主进程已推 done/failed 时只走事件终局;否则旧 Promise 先收尾、旧 done 后到,
          // 会在新一轮已开始时误清新草稿/loading。只有未推事件的同步失败才用回执收尾。
          if (!shouldSettleAgentResponse(res)) return;
          settleRef.current(res);
        })
        .catch((e) => {
          if (roundGen.current !== myGen) return;
          // 若终局事件已经收过尾,不再补错误卡(防双开)。解锁留给那次收尾,
          // 避免把「打断后已经发出的下一轮」的忙状态清掉。
          if (settleGuard.current) return;
          settleGuard.current = true;
          liveToolCardId.current = null;
          liveStreamMsgId.current = null;
          const detail = e instanceof Error ? e.message : String(e);
          setMsgs((m) => [
            ...clearStreamingDraft(m).filter((x) => x.id !== loadingId),
            { id: ++msgId.current, kind: 'agent', error: { title: errorCardTitle(detail), detail, retryText: v } },
          ]);
          // 请求本身失败(IPC 断开等)是终局,必须解锁;正常路径的解锁在 settleChat 的 done 分支
          if (pendingReplace.current) {
            sendingRef.current = false;
            agentBusyRef.current = false;
          } else {
            markSending(false);
            markAgentBusy(false);
          }
          flushReplaceRef.current();
        });
      return true;
    },
    [chatInput, projectId, canvasId, autoGrow, onCanvasMutated, toastMsg, clearChat, compactChat, focusNodesRef, markSending, markAgentBusy],
  );

  /** 上一轮收尾后,把排队的下一条真正发出。微任务发出,让同一次 done 的重复投递仍看见收尾闸。 */
  flushReplaceRef.current = () => {
    const pending = pendingReplace.current;
    pendingReplace.current = null;
    preemptingRef.current = false;
    replacingRef.current = false;
    setReplacing(false);
    if (!pending) return;
    agentBusyRef.current = false;
    sendingRef.current = false;
    queueMicrotask(() => {
      send(pending.text, pending.attachments, pending.mentions);
    });
  };

  /**
   * 终局收尾:把 AgentChatResponse 落成消息卡片。
   * done/failed 事件是正常执行的唯一终局;agentChat Promise 只处理未推事件的同步失败
   * (主进程回执 settledByEvent=true 时绝不再走这里,防止旧轮双终局误伤新轮)。
   * accepted 回执仅切「执行中」,不触发收尾。
   *
   * ⚠️ 幂等保护:`done` 事件在 dev StrictMode(或 effect 重订阅竞态)下可能被投递两次,
   * 若不加闸,第二次会因 liveToolCardId 已被清空而**再补一张卡**(真实事故:识别提示词
   * 在 UI 上显示两次)。用 settleGuard.current 记住「本轮的收尾已完成」,重复调用直接忽略。
   */
  const settleChat = useCallback(
    (res: AgentChatResponse) => {
      if (settleGuard.current) return; // 本轮已收尾 → 忽略重复投递
      settleGuard.current = true;
      const liveId = liveToolCardId.current;
      liveToolCardId.current = null;
      liveStreamMsgId.current = null;
      const preempting = preemptingRef.current;
      const noted = interruptNoted.current;
      interruptNoted.current = false;
      // id 在 updater 外分配:StrictMode 会把 updater 跑两遍
      const interruptLine =
        res.aborted && !noted
          ? {
              id: ++msgId.current,
              kind: 'sys' as const,
              text: preempting ? '已打断 · 按新指令继续' : '已打断 · 可直接在画布修改',
            }
          : null;
      setMsgs((m) => {
        const rest = clearStreamingDraft(m).filter((x) => !x.loading);
        const out: ChatMsg[] = [...rest];
        // 工具调用聚合卡:res.toolCalls 为权威列表——实时卡已存在则原地对账替换(避免与 SSE 行重复),否则补一张
        if (res.toolCalls?.length) {
          const runs: ToolRun[] = res.toolCalls.map((tc) => ({
            name: tc.name,
            args: tc.args,
            status: tc.ok ? 'success' : 'error',
            result: tc.result,
            nodeId: tc.nodeId,
          }));
          const li = liveId != null ? out.findIndex((x) => x.id === liveId && x.toolRuns) : -1;
          const liveCard = li >= 0 ? out[li] : undefined;
          if (liveCard) out[li] = { ...liveCard, toolRuns: runs };
          else out.push({ id: ++msgId.current, kind: 'agent', odId: 'agent-tools', toolRuns: runs });
        }
        if (res.aborted) {
          // 打断:把仍 running 的行标为失败,避免永久转圈
          for (let i = 0; i < out.length; i++) {
            const msg = out[i];
            if (!msg?.toolRuns?.some((r) => r.status === 'running')) continue;
            out[i] = {
              ...msg,
              toolRuns: msg.toolRuns.map((r) => (r.status === 'running' ? { ...r, status: 'error' as const, result: '已打断' } : r)),
            };
          }
          if (interruptLine) out.push(interruptLine);
        } else if (res.ask && res.ask.options.length >= 2) {
          // 结构化提问:渲染确认卡片(不重复推 reply 文本,卡片已含问题);思考内容折叠展示
          if (res.thinking) out.push({ id: ++msgId.current, kind: 'agent', thinking: res.thinking });
          out.push({ id: ++msgId.current, kind: 'agent', odId: 'agent-ask', ask: { question: res.ask.question, options: res.ask.options } });
        } else if (res.ok && (res.reply || res.thinking)) {
          // odId=agent-reply:本轮最终回答(有正文才挂复制;纯思考不挂)
          out.push({
            id: ++msgId.current,
            kind: 'agent',
            odId: res.reply?.trim() ? 'agent-reply' : undefined,
            text: res.reply,
            thinking: res.thinking,
          });
        } else if (!res.ok) {
          const detail = res.error ?? '未知错误';
          out.push({
            id: ++msgId.current,
            kind: 'agent',
            error: { title: errorCardTitle(detail), detail },
          });
        }
        return out;
      });
      // 有排队的下一条时,可见忙状态先留着,避免按钮闪回「发送」;ref 放行交给 flush
      if (pendingReplace.current) {
        sendingRef.current = false;
        agentBusyRef.current = false;
      } else {
        markSending(false);
        markAgentBusy(false);
      }
      void window.bigbotart.loadProjectCanvases(projectId ?? '').then(() => {
        onCanvasMutated();
      });
      void refreshThreads();
      if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
      // 执行中发来的下一条:等这次收尾落完再开,避免旧 done 把新一轮收掉
      flushReplaceRef.current();
    },
    [projectId, onCanvasMutated, refreshThreads, markSending, markAgentBusy],
  );

  /** 终局收尾的稳定引用(事件订阅的 effect 依赖它,避免因函数重建而反复退订) */
  const settleRef = useRef(settleChat);
  settleRef.current = settleChat;

  /** 真实打断:中止 worker 内 LLM 请求。忙状态留到收尾事件,避免立刻再发和旧 done 撞车。 */
  const interrupt = useCallback(() => {
    if (!projectId || !agentBusyRef.current) return;
    void window.bigbotart.agentCancel(projectId);
    if (interruptNoted.current) return;
    interruptNoted.current = true;
    const noteId = ++msgId.current;
    setMsgs((m) => [
      ...m.filter((x) => !x.loading),
      { id: noteId, kind: 'sys', text: '已打断 · 可直接在画布修改,Agent 将基于当前画布增量重规划' },
    ]);
  }, [projectId]);

  /** ask 确认卡点选:①把选择写回消息数据(ask.picked,记录——重进页面/恢复历史后仍回显);②以选项文案继续对话 */
  const askPick = useCallback(
    (msgId: number, label: string) => {
      // updater 纯:只做数据映射;副作用 send 在 updater 外
      setMsgs((m) => m.map((x) => (x.id === msgId && x.ask ? { ...x, ask: { ...x.ask, picked: label } } : x)));
      send(label);
    },
    [send],
  );

  /** ask 确认卡「重新选择」:清除已记录的点选(ask.picked),回到可点选状态(之前已回传的答复不撤销) */
  const askReset = useCallback((msgId: number) => {
    setMsgs((m) => m.map((x) => (x.id === msgId && x.ask ? { ...x, ask: { ...x.ask, picked: undefined } } : x)));
  }, []);

  /** 挂载/切画布:拉会话列表 → 活跃会话 → 恢复该会话消息。
   *  若会话 IPC 不可用(主进程未重启 / 旧构建),回退到 memoryGet 按 canvasId 恢复,
   *  避免「数据还在、面板空白」的假丢历史。 */
  useEffect(() => {
    if (!projectId || !canvasId) return;
    let alive = true;
    void (async () => {
      try {
        const active = await window.bigbotart.chatThreadActive(projectId, canvasId);
        if (!alive) return;
        setActiveThreadId(active.threadId);
        const list = await window.bigbotart.chatThreadsList(projectId, canvasId);
        if (!alive) return;
        setThreads(list);
        const recall = await window.bigbotart.chatThreadMessages(projectId, active.threadId);
        if (!alive) return;
        const restored = restoreMsgsFromRecall(recall, () => ++msgId.current);
        if (restored.length) setMsgs((m) => [...restored, ...m]);
      } catch (e) {
        console.error('恢复会话失败,回退 memoryGet', e);
        try {
          const mem = await window.bigbotart.memoryGet(projectId);
          if (!alive) return;
          const restored = restoreMsgsFromRecall(
            mem.recall.filter((r) => r.canvasId === canvasId),
            () => ++msgId.current,
          );
          if (restored.length) setMsgs((m) => [...restored, ...m]);
          toastMsg('历史会话功能需重启应用后生效 · 已按旧方式恢复本画布对话');
        } catch (e2) {
          console.error('回退恢复也失败', e2);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId, canvasId, toastMsg]);

  /** 订阅 Agent 实时事件(工具开始/结束 → 聚合卡实时行;连续性校验 → 校验卡) */
  useEffect(() => {
    const off = window.bigbotart.onAgentEvent((ev) => {
      // 事件去重:dev StrictMode 双挂载 / effect 重订阅竞态下,同一事件可能被投递两次。
      // 工具/终局沿用旧的轻量指纹;流式增量必须按 requestId:seq 精确去重。
      // 旧指纹若用于 delta,会把同一 2ms 内的不同 token 全误判成重复。
      const isStreamEvent = ev.kind === 'round-start' || ev.kind === 'text-delta' || ev.kind === 'thinking-delta';
      const sig = ev.eventId ?? (isStreamEvent ? null : `${ev.kind}|${ev.toolName ?? ''}|${ev.nodeId ?? ''}|${Math.floor(Date.now() / 2)}`);
      if (sig && !rememberAgentEvent(seenEvents.current, sig)) return;
      if (ev.projectId && projectId && ev.projectId !== projectId) return;
      if (ev.canvasId && canvasId && ev.canvasId !== canvasId) return;
      // 多会话:事件带 threadId 时只收当前展示会话的(避免切走后旧 done 污染新会话 UI)。
      // auto-start 例外:主进程已切回提交时的会话,这里跟随切 UI 再收事件。
      if (
        ev.kind !== 'auto-start' &&
        ev.threadId &&
        activeThreadIdRef.current &&
        ev.threadId !== activeThreadIdRef.current
      ) {
        return;
      }
      if (ev.kind === 'round-start') {
        // 每次 models.stream 调用都会发(包括同 round 的协议/参数纠错重试),因此无条件重置,
        // 不依赖 round 数字变化;这样被驳回的 attempt 不会拼进下一次输出。
        const liveId = liveStreamMsgId.current;
        if (liveId != null) setMsgs((m) => resetStreamingDraft(m, liveId));
      } else if ((ev.kind === 'text-delta' || ev.kind === 'thinking-delta') && ev.delta) {
        const liveId = liveStreamMsgId.current ?? ++msgId.current;
        liveStreamMsgId.current = liveId;
        const channel = ev.kind === 'text-delta' ? 'text' : 'thinking';
        const delta = ev.delta;
        setMsgs((m) => appendStreamingDraft(m, liveId, channel, delta, ev.contentIndex ?? 0));
      } else if (ev.kind === 'tool-start' && ev.toolName) {
        const row: ToolRun = { name: ev.toolName, args: ev.toolArgs ?? {}, status: 'running' };
        // StrictMode 下 updater 双跑:id 与 ref 在 updater 外一次分配,避免重复建卡
        const liveId = liveToolCardId.current;
        const newId = liveId == null ? ++msgId.current : null;
        if (newId != null) liveToolCardId.current = newId;
        setMsgs((m) => {
          const li = liveId != null ? m.findIndex((x) => x.id === liveId && x.toolRuns) : -1;
          const card = li >= 0 ? m[li] : undefined;
          if (card?.toolRuns) {
            // 本轮聚合卡已存在 → 追加一行
            const next = [...m];
            next[li] = { ...card, toolRuns: [...card.toolRuns, row] };
            return next;
          }
          // 本轮第一张聚合卡:插在「思考中」loading 之前——加载指示始终停在流底部,直到整轮完全结束
          const cardMsg: ChatMsg = { id: newId ?? ++msgId.current, kind: 'agent', odId: 'agent-tools', toolRuns: [row] };
          const loadingIdx = m.findIndex((x) => x.loading);
          if (loadingIdx >= 0) return [...m.slice(0, loadingIdx), cardMsg, ...m.slice(loadingIdx)];
          return [...m, cardMsg];
        });
      } else if (ev.kind === 'tool-end' && ev.toolName) {
        const tName = ev.toolName; // 闭包内窄化丢失防御(updater 里类型收窄不可靠)
        setMsgs((m) => {
          // 找本轮聚合卡中最后一条同名 running 行,更新为 success/error
          const liveId = liveToolCardId.current;
          const li = liveId != null ? m.findIndex((x) => x.id === liveId && x.toolRuns) : -1;
          const card = li >= 0 ? m[li] : undefined;
          if (!card?.toolRuns) return m;
          const runs = [...card.toolRuns];
          const rev = [...runs].reverse().findIndex((r) => r.name === ev.toolName && r.status === 'running');
          if (rev < 0) return m;
          const ri = runs.length - 1 - rev;
          const prev = runs[ri];
          if (!prev) return m;
          runs[ri] = { ...prev, status: ev.ok ? ('success' as const) : ('error' as const), result: ev.result, nodeId: ev.nodeId };
          const next = [...m];
          next[li] = { ...card, toolRuns: runs };
          return next;
        });
        // 工具改了画布:刷新节点
        if (ev.toolName.startsWith('canvas.')) onCanvasMutated();
        // 🆕 技能工具联动:激活/停用/读取 → 独立「技能注入卡」(配置事件)+ 同步 activeSkill
        if (tName.startsWith('skills.')) {
          // 从本轮聚合卡取该工具行的 args(激活/读取需要 skillId;行数据在 toolRuns 里)
          let args: Record<string, unknown> = {};
          setMsgs((m) => {
            const li = liveToolCardId.current != null ? m.findIndex((x) => x.id === liveToolCardId.current && x.toolRuns) : -1;
            const runs = li >= 0 ? m[li]?.toolRuns ?? [] : [];
            const row = [...runs].reverse().find((r) => r.name === tName);
            if (row?.args) args = row.args;
            if (!['skills.activate', 'skills.deactivate', 'skills.read'].includes(tName) || !ev.ok) return m;
            const skillId = String(args.skillId ?? '');
            const name = String(args.skillName ?? skillId);
            const card: ChatMsg = {
              id: ++msgId.current,
              kind: 'agent',
              odId: 'agent-skill',
              skill: tName === 'skills.activate'
                ? { action: 'activate', skillId, name, inject: args.inject === 'summary' ? 'summary' : 'full', preview: ev.result?.slice(0, 120) }
                : tName === 'skills.deactivate'
                  ? { action: 'deactivate', skillId, name }
                  : { action: 'read', skillId, name, instructionsText: ev.result ?? undefined },
            };
            return [...m.filter((x) => !x.skill), card]; // 常驻一行:替换旧技能卡
          });
          if (ev.ok) {
            if (ev.toolName === 'skills.activate') setActiveSkill({ skillId: String(args.skillId ?? ''), name: String(args.skillName ?? ''), inject: args.inject === 'summary' ? 'summary' : 'full' });
            if (ev.toolName === 'skills.deactivate') setActiveSkill(null);
          }
        }
      } else if (ev.kind === 'auto-start') {
        /* 自动续跑(2026-10-10):Agent 提交的生成完成后,主进程自动发起一轮 chat 推进任务链。
           这里等价于 send() 的「开局」动作:开新一轮收尾闸、重置聚合卡指针、
           放系统说明 + loading 气泡、锁定输入;随后 tool-start/end 与 done/failed 照旧流转。
           ⚠️ updater 纯:id 自增在 updater 外一次完成(StrictMode 双跑安全)。
           若用户已切到别的历史会话,先跟主进程切回提交时的会话再开局。 */
        const beginAuto = () => {
          roundGen.current += 1;
          settleGuard.current = false;
          liveToolCardId.current = null;
          liveStreamMsgId.current = null;
          pinToBottom.current = true;
          const sysId = ++msgId.current;
          const loadId = ++msgId.current;
          setMsgs((m) => [
            ...clearStreamingDraft(m).filter((x) => !x.loading),
            { id: sysId, kind: 'sys', text: ev.note || '⚙️ 生成完成 · Agent 自动推进任务链…' },
            { id: loadId, kind: 'sys', loading: true, text: '思考中…' },
          ]);
          markAgentBusy(true);
          markSending(true);
          if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
        };
        if (ev.threadId && ev.threadId !== activeThreadIdRef.current) {
          setActiveThreadId(ev.threadId);
          activeThreadIdRef.current = ev.threadId;
          // 先同步建立 auto round,后续 delta/done 才有正确收尾闸;历史恢复只 prepend,
          // 不再等待恢复后才 beginAuto(旧顺序会覆盖实时事件并卡死 busy)。
          setMsgs([]);
          beginAuto();
          void loadThreadMessages(ev.threadId, { prepend: true }).then(() => {
            void refreshThreads();
            toastMsg('已切回生成完成的对话继续');
          });
        } else {
          beginAuto();
        }
      } else if (ev.kind === 'continuity') {
        setMsgs((m) => [
          ...m,
          {
            id: ++msgId.current,
            kind: 'agent',
            odId: 'agent-check',
            check: { issues: ev.issues ?? [], result: ev.result },
          },
        ]);
      } else if (ev.kind === 'aborted') {
        setMsgs((m) => m.filter((x) => !x.loading));
      } else if (ev.kind === 'done' && ev.final) {
        // 批次1 任务化:终局结果从事件流回来(不再依赖请求不超时)。
        // 主进程已把 recall 写好,这里只负责 UI 收尾。
        settleRef.current(ev.final);
      } else if (ev.kind === 'failed') {
        // 失败:清掉 loading 与实时卡的转圈,给错误卡(文案已含「已完成 N 个操作」摘要)
        // 同样走 settleGuard 幂等闸:重复投递不得再补第二张错误卡
        if (settleGuard.current) return;
        settleGuard.current = true;
        const detail = ev.error ?? '未知错误';
        liveToolCardId.current = null;
        liveStreamMsgId.current = null;
        setMsgs((m) => [
          ...clearStreamingDraft(m)
            .filter((x) => !x.loading)
            .map((x) =>
              x.toolRuns?.some((r) => r.status === 'running')
                ? { ...x, toolRuns: x.toolRuns.map((r) => (r.status === 'running' ? { ...r, status: 'error' as const, result: '未完成(本轮中断)' } : r)) }
                : x,
            ),
          { id: ++msgId.current, kind: 'agent', error: { title: errorCardTitle(detail), detail } },
        ]);
        if (pendingReplace.current) {
          sendingRef.current = false;
          agentBusyRef.current = false;
        } else {
          markSending(false);
          markAgentBusy(false);
        }
        void window.bigbotart.loadProjectCanvases(projectId ?? '').then(() => {
          onCanvasMutated();
        });
        flushReplaceRef.current();
      }
      if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
    });
    return off;
  }, [projectId, canvasId, onCanvasMutated, loadThreadMessages, refreshThreads, toastMsg, markSending, markAgentBusy]);

  /** 🆕 手动激活技能(输入区快选 / 技能页共用):调 IPC + 落「技能注入卡」+ 同步 chip */
  const activateSkill = useCallback(
    (skill: { skillId: string; name: string; inject?: 'full' | 'summary' }) => {
      if (!projectId) {
        toastMsg('请先打开项目再激活技能');
        return;
      }
      void window.bigbotart
        .skillActivate(projectId, canvasId, skill.skillId)
        .then((r) => {
          if (!r.ok) {
            toastMsg(r.error ?? '激活技能失败');
            return;
          }
          setActiveSkill({ skillId: skill.skillId, name: skill.name, inject: r.hasInstructions ? skill.inject ?? 'full' : undefined });
          setMsgs((m) => [
            ...m.filter((x) => !x.skill),
            {
              id: ++msgId.current,
              kind: 'agent',
              odId: 'agent-skill',
              skill: {
                action: 'activate',
                skillId: skill.skillId,
                name: skill.name,
                inject: r.hasInstructions ? skill.inject ?? 'full' : undefined,
                preview: r.preview ?? undefined,
              },
            },
          ]);
          toastMsg(`已加载技能「${skill.name}」的操作指令${r.hasInstructions ? '' : '(该技能无指令段)'}`);
        })
        .catch(() => toastMsg('激活技能失败:主进程通道异常'));
    },
    [projectId, canvasId, toastMsg],
  );

  /** 🆕 手动停用技能(输入区 chip ✕) */
  const deactivateSkill = useCallback(() => {
    if (!projectId) return;
    const prev = activeSkill;
    void window.bigbotart
      .skillDeactivate(projectId, canvasId)
      .then(() => {
        setActiveSkill(null);
        setMsgs((m) => [
          ...m.filter((x) => !x.skill),
          { id: ++msgId.current, kind: 'agent', odId: 'agent-skill', skill: { action: 'deactivate', skillId: prev?.skillId ?? '', name: prev?.name ?? '当前技能' } },
        ]);
        toastMsg('已停用技能,后续对话不再注入指令');
      })
      .catch(() => toastMsg('停用技能失败'));
  }, [projectId, canvasId, activeSkill, toastMsg]);

  /* 🆕 恢复画布激活技能(进入页面 chip 与注入状态一致)。
   *  首页「生成」会先 skillActivate 再进画布,并可能经 sessionStorage `bba.homeSkill` 播种;
   *  同时监听 bba-newchat-ready:覆盖「挂载瞬间 IPC 尚未可见 / 晚于挂载才写盘」的竞态。 */
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    const apply = (s: { skillId: string; name: string; inject?: 'full' | 'summary' } | null) => {
      if (!alive || !s) return;
      setActiveSkill({ skillId: s.skillId, name: s.name, inject: s.inject });
    };
    const refresh = () => {
      try {
        const raw = sessionStorage.getItem('bba.homeSkill');
        if (raw) {
          sessionStorage.removeItem('bba.homeSkill');
          const seeded = JSON.parse(raw) as { skillId?: string; name?: string; inject?: 'full' | 'summary' };
          if (seeded?.skillId && seeded.name) {
            apply({ skillId: seeded.skillId, name: seeded.name, inject: seeded.inject });
            return;
          }
        }
      } catch {
        /* 播种损坏则回退 IPC */
      }
      void window.bigbotart
        .skillActive(projectId, canvasId)
        .then((s) => apply(s))
        .catch(() => {});
    };
    refresh();
    window.addEventListener('bba-newchat-ready', refresh);
    return () => {
      alive = false;
      window.removeEventListener('bba-newchat-ready', refresh);
    };
  }, [projectId, canvasId]);

  const guardBusy = useCallback((): boolean => {
    if (sending) {
      toastMsg('请先等待本轮结束或打断');
      return true;
    }
    return false;
  }, [sending, toastMsg]);

  const switchThread = useCallback(
    async (threadId: string) => {
      if (!projectId || !canvasId) return;
      if (threadId === activeThreadIdRef.current) {
        setHistoryOpen(false);
        return;
      }
      if (guardBusy()) return;
      const res = await window.bigbotart.chatThreadSwitch(projectId, canvasId, threadId);
      if (!res.ok || !res.thread) {
        toastMsg(res.error ?? '切换会话失败');
        return;
      }
      setActiveThreadId(threadId);
      activeThreadIdRef.current = threadId;
      await loadThreadMessages(threadId);
      await refreshThreads();
      setHistoryOpen(false);
      toastMsg(`已切换对话 · ${res.thread.title || '新对话'}`);
    },
    [projectId, canvasId, guardBusy, loadThreadMessages, refreshThreads, toastMsg],
  );

  const newThread = useCallback(
    async (opts?: { parentThreadId?: string }) => {
      if (!projectId || !canvasId) return;
      if (guardBusy()) return;
      const res = await window.bigbotart.chatThreadCreate(projectId, canvasId, opts);
      if (!res.ok || !res.thread) {
        toastMsg(res.error ?? '新建会话失败');
        return;
      }
      const reused = res.thread.id === activeThreadIdRef.current;
      setActiveThreadId(res.thread.id);
      activeThreadIdRef.current = res.thread.id;
      if (reused && !opts?.parentThreadId) {
        setHistoryOpen(false);
        toastMsg('当前已是空会话 · 直接输入即可');
        return;
      }
      liveStreamMsgId.current = null;
      setMsgs([]);
      pinToBottom.current = true;
      await refreshThreads();
      setHistoryOpen(false);
      toastMsg(opts?.parentThreadId ? '已从所选会话派生新对话' : '已新建对话 · 上一会话保留在历史列表');
    },
    [projectId, canvasId, guardBusy, refreshThreads, toastMsg],
  );

  const renameThread = useCallback(
    async (threadId: string, title: string) => {
      if (!projectId) return;
      const res = await window.bigbotart.chatThreadRename(projectId, threadId, title);
      if (!res.ok) {
        toastMsg(res.error ?? '重命名失败');
        return;
      }
      await refreshThreads();
      toastMsg(title.trim() ? `已重命名为「${title.trim()}」` : '标题已清空 · 将用首条消息生成');
    },
    [projectId, refreshThreads, toastMsg],
  );

  const deleteThread = useCallback(
    async (threadId: string) => {
      if (!projectId || !canvasId) return;
      if (guardBusy()) return;
      const res = await window.bigbotart.chatThreadDelete(projectId, threadId);
      if (!res.ok || !res.activeThreadId) {
        toastMsg(res.error ?? '删除失败');
        return;
      }
      setActiveThreadId(res.activeThreadId);
      activeThreadIdRef.current = res.activeThreadId;
      await loadThreadMessages(res.activeThreadId);
      await refreshThreads();
      toastMsg('已删除会话');
    },
    [projectId, canvasId, guardBusy, loadThreadMessages, refreshThreads, toastMsg],
  );

  const activeThreadTitle = threads.find((t) => t.id === activeThreadId)?.title || '新对话';

  return {
    msgs,
    sending,
    /** 有一轮对话还没收尾(打断之后、worker 停下之前也算) */
    agentBusy,
    /** 已打断,正在等上一轮停下再发送输入框里的新指令 */
    replacing,
    send,
    askPick,
    askReset,
    interrupt,
    clearChat,
    compactChat,
    pushMsg,
    chatInput,
    setChatInput,
    chatRef,
    inputRef,
    autoGrow,
    pinToBottom,
    model,
    modelOverridden,
    modelOptions,
    loadModelOptions,
    pickModel,
    activeSkill,
    activateSkill,
    deactivateSkill,
    /* 历史会话 */
    threads,
    activeThreadId,
    activeThreadTitle,
    historyOpen,
    setHistoryOpen,
    switchThread,
    newThread,
    renameThread,
    deleteThread,
    refreshThreads,
  };
}

export type AgentChatApi = ReturnType<typeof useAgentChat>;
