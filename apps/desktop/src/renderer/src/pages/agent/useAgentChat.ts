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
import type { Asset, LlmSource } from '@bigbotart/shared';
import type { ChatMsg, ModelOption, ToolRun } from './types';
import { MODEL_OPTION_FALLBACK } from './constants';
import { llmDisplayName } from './llm-display';

export interface UseAgentChatOptions {
  projectId: string | null;
  canvasId: string;
  /** 工具改动画布后回调(CanvasPage 重拉节点) */
  onCanvasMutated: () => void;
  toastMsg: (msg: string) => void;
}

export function useAgentChat({ projectId, canvasId, onCanvasMutated, toastMsg }: UseAgentChatOptions) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [sending, setSending] = useState(false);

  const chatRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const msgId = useRef(100);
  /** 本轮工具聚合卡(ToolRunCard)的消息 id;一轮对话一张卡,SSE 实时更新,回复到达后对账 */
  const liveToolCardId = useRef<number | null>(null);
  /** 消息流是否贴底(用户在底部附近时新消息自动跟随;往上翻则不打扰) */
  const pinToBottom = useRef(true);

  /* ── 模型选择器 ── */
  const [model, setModel] = useState('Ornith-1.5-35B · 本地');
  /** 当前显示的模型是否来自项目级覆盖(false = 全局默认) */
  const [modelOverridden, setModelOverridden] = useState(false);
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

  /* 切换项目/画布:清空对话区,真实历史由恢复 effect 填充 */
  useEffect(() => {
    setMsgs([]);
  }, [projectId, canvasId]);

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

  /* ══ 对话发送 / 打断 ══ */
  const send = useCallback(
    (overrideText?: string, attachments?: Asset[]) => {
      const v = (overrideText ?? chatInput).trim();
      const atts = attachments ?? [];
      // 有附件时允许空文本发送
      if ((!v && atts.length === 0) || sending) return;
      const pid = projectId;
      const cid = canvasId;
      if (!pid || !cid) {
        toastMsg('请先进入一个项目画布');
        return;
      }
      setMsgs((m) => [
        ...m,
        {
          id: ++msgId.current,
          kind: 'user',
          text: v || '(附件)',
          attachments: atts.length ? atts.map((a) => ({ name: a.name, kind: a.kind })) : undefined,
        },
      ]);
      setChatInput('');
      pinToBottom.current = true;
      if (inputRef.current) {
        inputRef.current.value = '';
        autoGrow(inputRef.current);
      }
      // 新一轮开始:重置聚合卡指针(SSE tool-start 会建一张新卡)
      liveToolCardId.current = null;
      // loading 气泡
      const loadingId = ++msgId.current;
      setSending(true);
      setMsgs((m) => [...m, { id: loadingId, kind: 'sys', loading: true, text: '思考中…' }]);
      if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;

      window.bigbotart
        .agentChat({
          projectId: pid,
          canvasId: cid,
          text: v,
          attachments: atts.length ? atts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, localPath: a.localPath })) : undefined,
        })
        .then((res) => {
          // StrictMode 下 setMsgs updater 会双跑:ref 的读与清必须在 updater 外完成,
          // 否则第二趟跑到时 ref 已被第一趟清空 → 对账失败 → 重复建卡
          const liveId = liveToolCardId.current;
          liveToolCardId.current = null;
          setMsgs((m) => {
            const rest = m.filter((x) => x.id !== loadingId);
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
              out.push({ id: ++msgId.current, kind: 'sys', text: '已打断 · 可直接在画布修改' });
            } else if (res.ask && res.ask.options.length >= 2) {
              // 结构化提问:渲染确认卡片(不重复推 reply 文本,卡片已含问题);思考内容折叠展示
              if (res.thinking) out.push({ id: ++msgId.current, kind: 'agent', thinking: res.thinking });
              out.push({ id: ++msgId.current, kind: 'agent', odId: 'agent-ask', ask: { question: res.ask.question, options: res.ask.options } });
            } else if (res.ok && (res.reply || res.thinking)) {
              out.push({ id: ++msgId.current, kind: 'agent', text: res.reply, thinking: res.thinking });
            } else if (!res.ok) {
              // 错误卡(LLM 不可达等):红头 + 原因 + 重试/去设置;本轮未执行的工具不受影响
              const detail = res.error ?? '未知错误';
              out.push({
                id: ++msgId.current,
                kind: 'agent',
                error: {
                  title: /不可达|不可用|超时|timeout|ECONNREFUSED|fetch failed|connect/i.test(detail) ? '对话服务不可达' : '对话失败',
                  detail,
                  retryText: v,
                },
              });
            }
            return out;
          });
        })
        .catch((e) => {
          liveToolCardId.current = null;
          const detail = e instanceof Error ? e.message : String(e);
          setMsgs((m) => [
            ...m.filter((x) => x.id !== loadingId),
            { id: ++msgId.current, kind: 'agent', error: { title: '对话服务不可达', detail, retryText: v } },
          ]);
        })
        .finally(() => {
          setSending(false);
          // 画布可能被工具改动:重新加载当前画布
          void window.bigbotart.loadProjectCanvases(pid).then(() => {
            onCanvasMutated();
          });
          if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
        });
    },
    [chatInput, projectId, canvasId, sending, autoGrow, onCanvasMutated, toastMsg],
  );

  /** 真实打断:中止 worker 内 LLM 请求 */
  const interrupt = useCallback(() => {
    if (!projectId) return;
    void window.bigbotart.agentCancel(projectId);
    setMsgs((m) => [
      ...m.filter((x) => !x.loading),
      { id: ++msgId.current, kind: 'sys', text: '已打断 · 可直接在画布修改,Agent 将基于当前画布增量重规划' },
    ]);
    setSending(false);
  }, [projectId]);

  /** 挂载时恢复当前画布的对话历史(recall;连续的 tool 记录聚合为一组 toolRuns) */
  useEffect(() => {
    if (!projectId || !canvasId) return;
    let alive = true;
    void window.bigbotart.memoryGet(projectId).then((mem) => {
      if (!alive) return;
      const recent = mem.recall.filter((r) => r.canvasId === canvasId).slice(-20);
      if (recent.length === 0) return;
      const restored: ChatMsg[] = [];
      let toolGroup: ToolRun[] | null = null;
      const flushTools = () => {
        if (toolGroup?.length) {
          restored.push({ id: ++msgId.current, kind: 'agent', odId: 'agent-tools', toolRuns: toolGroup });
        }
        toolGroup = null;
      };
      for (const r of recent) {
        if (r.role === 'tool' && r.toolName === 'ask.user') {
          // ask.user 暂停卡(被 worker 拦截,不经工具桥):恢复成可点选的确认卡,而不是丢成纯文本
          flushTools();
          const args = (r.toolArgs ?? {}) as { question?: string; options?: import('@bigbotart/shared').AskOption[] };
          if (args.question && args.options?.length) {
            // 去重:recall 里 assistant 正文与 ask 问题是同一段文本(与实时渲染「不重复推 reply」对齐)。
            // 注意 recall 顺序是 [assistant 文本, …工具记录, ask.user],要往前找最近一条同文本文本消息
            const dupIdx = restored.findLastIndex((x) => x.kind === 'agent' && x.text === args.question);
            if (dupIdx >= 0) restored.splice(dupIdx, 1);
            restored.push({ id: ++msgId.current, kind: 'agent', odId: 'agent-ask', ask: { question: args.question, options: args.options } });
          }
        } else if (r.role === 'tool' && r.toolName) {
          (toolGroup ??= []).push({ name: r.toolName, args: r.toolArgs ?? {}, status: 'success', result: r.toolResult });
        } else {
          flushTools();
          restored.push({ id: ++msgId.current, kind: r.role === 'user' ? 'user' : 'agent', text: r.content });
        }
      }
      flushTools();
      setMsgs((m) => [...restored, ...m]);
    });
    return () => {
      alive = false;
    };
  }, [projectId, canvasId]);

  /** 订阅 Agent 实时事件(工具开始/结束 → 聚合卡实时行;连续性校验 → 校验卡) */
  useEffect(() => {
    const off = window.bigbotart.onAgentEvent((ev) => {
      if (ev.projectId && projectId && ev.projectId !== projectId) return;
      if (ev.canvasId && canvasId && ev.canvasId !== canvasId) return;
      if (ev.kind === 'tool-start' && ev.toolName) {
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
      }
      if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
    });
    return off;
  }, [projectId, canvasId, onCanvasMutated]);

  return {
    msgs,
    sending,
    send,
    interrupt,
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
  };
}

export type AgentChatApi = ReturnType<typeof useAgentChat>;
