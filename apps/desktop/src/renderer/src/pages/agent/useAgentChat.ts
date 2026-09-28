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
import type { AgentChatResponse, Asset, LlmSource } from '@bigbotart/shared';
import type { ChatMsg, ModelOption, ToolRun } from './types';
import { MODEL_OPTION_FALLBACK } from './constants';
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
  /** 画布当前选中节点(ref 稳定引用,避免选中变化重建 send;随对话请求注入让 Agent 感知,标题供用户气泡回显) */
  selectedNodeRef?: RefObject<{ id: string; title: string } | null>;
}

export function useAgentChat({ projectId, canvasId, onCanvasMutated, toastMsg, selectedNodeRef }: UseAgentChatOptions) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [sending, setSending] = useState(false);

  const chatRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const msgId = useRef(100);
  /** 本轮工具聚合卡(ToolRunCard)的消息 id;一轮对话一张卡,SSE 实时更新,回复到达后对账 */
  const liveToolCardId = useRef<number | null>(null);
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

  /** /clear 命令:清空当前画布对话(UI + 持久化 recall/压缩摘要;画布/产物不受影响) */
  const clearChat = useCallback(() => {
    if (!projectId || !canvasId) {
      toastMsg('请先进入一个项目画布');
      return;
    }
    setMsgs([]);
    pinToBottom.current = true;
    void window.bigbotart
      .memoryClear(projectId, canvasId)
      .then((res) => toastMsg(res.ok ? `已清空对话 · 移除 ${res.cleared} 条记录` : `清空失败:${res.error ?? '未知错误'}`))
      .catch((e) => toastMsg(`清空失败:${e instanceof Error ? e.message : String(e)}`));
  }, [projectId, canvasId, toastMsg]);

  /** /compact 命令:把旧对话压成摘要(LLM 总结 + 裁剪 recall),保留最近若干条承接上下文 */
  const compactChat = useCallback(() => {
    if (!projectId || !canvasId) {
      toastMsg('请先进入一个项目画布');
      return;
    }
    const loadingId = ++msgId.current;
    setSending(true);
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
      .finally(() => setSending(false));
  }, [projectId, canvasId]);

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
      // ✂️ 斜杠命令(仅纯文本时识别;带附件视为普通消息):/clear 清空对话 · /compact 压缩上下文
      if (atts.length === 0) {
        const cmd = v.match(/^\/(clear|compact)(?:\s|$)/)?.[1];
        if (cmd === 'clear') {
          clearChat();
          setChatInput('');
          if (inputRef.current) inputRef.current.value = '';
          return;
        }
        if (cmd === 'compact') {
          compactChat();
          setChatInput('');
          if (inputRef.current) inputRef.current.value = '';
          return;
        }
      }
      // 本轮关注节点:updater 外一次读取(StrictMode 双跑安全),记入用户消息供回显
      const ctxNode = selectedNodeRef?.current ?? null;
      setMsgs((m) => [
        ...m,
        {
          id: ++msgId.current,
          kind: 'user',
          text: v || '(附件)',
          attachments: atts.length ? atts.map((a) => ({ name: a.name, kind: a.kind })) : undefined,
          contextNode: ctxNode ?? undefined,
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
      settleGuard.current = false; // 新一轮:打开收尾闸(见 settleGuard 声明)
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
          selectedNodeId: ctxNode?.id ?? undefined,
        })
        .then((res) => {
          // 批次1 任务化:主进程立即回执 {ok:true,accepted:true},真正结果走 agent-event
          // 的 done/failed。收到回执时**只切状态、不收尾**(否则会在工具还在跑时就把卡片封死);
          // 若主进程走了同步失败路径(带 error 且非 accepted),则在这里直接收尾。
          if (res.accepted && res.ok) {
            setMsgs((m) => m.map((x) => (x.id === loadingId ? { ...x, text: '执行中…' } : x)));
            return;
          }
          settleRef.current(res);
        })
        .catch((e) => {
          // 若终局事件已经收过尾,这里只解锁,不再补错误卡(防双开)
          if (settleGuard.current) {
            setSending(false);
            return;
          }
          settleGuard.current = true;
          liveToolCardId.current = null;
          const detail = e instanceof Error ? e.message : String(e);
          setMsgs((m) => [
            ...m.filter((x) => x.id !== loadingId),
            { id: ++msgId.current, kind: 'agent', error: { title: errorCardTitle(detail), detail, retryText: v } },
          ]);
          // 请求本身失败(IPC 断开等)是终局,必须解锁;正常路径的解锁在 settleChat 的 done 分支
          setSending(false);
        });
    },
    [chatInput, projectId, canvasId, sending, autoGrow, onCanvasMutated, toastMsg, clearChat, compactChat, selectedNodeRef],
  );

  /**
   * 终局收尾(批次1 任务化):把 AgentChatResponse 落成消息卡片。
   * 由 agentChat 的 Promise 返回值与 agent-event 的 done 事件共用:
   *  - accepted 回执(仅 {ok:true,accepted:true})不触发收尾,只把 loading 文案切成执行中
   *  - 真正结果(带 reply/toolCalls/ask)才收尾
   * 这样长任务不再依赖请求不超时 —— 结果从事件流回来,UI 全程有工具卡实时反馈。
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
      setMsgs((m) => {
        const rest = m.filter((x) => !x.loading);
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
          const detail = res.error ?? '未知错误';
          out.push({
            id: ++msgId.current,
            kind: 'agent',
            error: { title: errorCardTitle(detail), detail },
          });
        }
        return out;
      });
      setSending(false);
      void window.bigbotart.loadProjectCanvases(projectId ?? '').then(() => {
        onCanvasMutated();
      });
      if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
    },
    [projectId, onCanvasMutated],
  );

  /** 终局收尾的稳定引用(事件订阅的 effect 依赖它,避免因函数重建而反复退订) */
  const settleRef = useRef(settleChat);
  settleRef.current = settleChat;

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
      for (let i = 0; i < recent.length; i++) {
        const r = recent[i];
        if (!r) continue; // noUncheckedIndexedAccess:recent[i] 可能为 undefined
        if (r.role === 'tool' && r.toolName === 'ask.user') {
          // ask.user 暂停卡(被 worker 拦截,不经工具桥):恢复成可点选的确认卡,而不是丢成纯文本
          flushTools();
          const args = (r.toolArgs ?? {}) as { question?: string; options?: unknown };
          // 容错:LLM 可能把 options 序列化成 JSON 字符串(真实事故:字符串有 .length 属性,
          // 旧判定误放行 → AskCard options.map 崩溃白屏);非数组一律降级为纯文本
          let opts: unknown = args.options;
          if (typeof opts === 'string') {
            try {
              opts = JSON.parse(opts);
            } catch {
              opts = null;
            }
          }
          if (args.question && Array.isArray(opts) && opts.length >= 2) {
            // 去重:recall 里 assistant 正文与 ask 问题是同一段文本(与实时渲染「不重复推 reply」对齐)。
            // 注意 recall 顺序是 [assistant 文本, …工具记录, ask.user],要往前找最近一条同文本文本消息
            const dupIdx = restored.findLastIndex((x) => x.kind === 'agent' && x.text === args.question);
            if (dupIdx >= 0) restored.splice(dupIdx, 1);
            // 恢复「已点选」:ask.user 之后紧邻的用户消息恰为某个选项文案 → 视为用户当时的点选,
            // 卡片直接回显「已选择 · X」,而不是退回等待确认(修复:点选未记录,重进页面状态丢失)
            const askOpts = opts as Array<{ label: string }>;
            const nxt = recent[i + 1];
            const picked =
              nxt?.role === 'user' && nxt.content && askOpts.some((o) => o.label.trim() === nxt.content.trim())
                ? nxt.content.trim()
                : undefined;
            restored.push({
              id: ++msgId.current,
              kind: 'agent',
              odId: 'agent-ask',
              ask: { question: args.question, options: opts as import('@bigbotart/shared').AskOption[], picked },
            });
          } else if (args.question) {
            // options 不可解析(被截断/非数组):仍能拿到 question → 降级为纯文本提问,不暴露工具调用原文
            restored.push({ id: ++msgId.current, kind: 'agent', text: args.question });
          } else {
            /* 脏记录(旧版本 ask.user 未被 worker 拦截,落到工具桥报「未知工具:ask.user」,
               options 被 JSON.stringify 截断成非法 JSON):没有 question 可展示,
               原样 push 会在对话里留一条 `ask.user({...` 的裸文本气泡,看着像调用失败。
               这类记录是历史噪音,直接丢弃(本轮真正的提问卡由 index.ts 那条 ask 记录负责)。 */
            continue;
          }
        } else if (r.role === 'tool' && r.toolName) {
          (toolGroup ??= []).push({ name: r.toolName, args: r.toolArgs ?? {}, status: 'success', result: r.toolResult });
        } else {
          flushTools();
          restored.push({
            id: ++msgId.current,
            kind: r.role === 'user' ? 'user' : 'agent',
            text: r.content,
            // 关注节点徽标还原(recall 留痕,2026-09 起新记录才有;旧记录无字段则不回显)
            contextNode:
              r.role === 'user' && r.selectedNodeId
                ? { id: r.selectedNodeId, title: r.selectedNodeTitle ?? r.selectedNodeId }
                : undefined,
          });
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
      // 事件去重:dev StrictMode 双挂载 / effect 重订阅竞态下,同一事件可能被投递两次。
      // 同一毫秒内 kind+toolName+nodeId 完全相同的事件视为重复(事件本身没有 id,
      // 用「时间片 + 工具名」做轻量指纹;真实事件间隔远大于 1ms,不会误伤)。
      const sig = `${ev.kind}|${ev.toolName ?? ''}|${ev.nodeId ?? ''}|${Math.floor(Date.now() / 2)}`;
      if (seenEvents.current.has(sig)) return;
      seenEvents.current.add(sig);
      if (seenEvents.current.size > 200) seenEvents.current.clear(); // 防无限增长
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
        setMsgs((m) => [
          ...m
            .filter((x) => !x.loading)
            .map((x) =>
              x.toolRuns?.some((r) => r.status === 'running')
                ? { ...x, toolRuns: x.toolRuns.map((r) => (r.status === 'running' ? { ...r, status: 'error' as const, result: '未完成(本轮中断)' } : r)) }
                : x,
            ),
          { id: ++msgId.current, kind: 'agent', error: { title: errorCardTitle(detail), detail } },
        ]);
        setSending(false);
        void window.bigbotart.loadProjectCanvases(projectId ?? '').then(() => {
          onCanvasMutated();
        });
      }
      if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
    });
    return off;
  }, [projectId, canvasId, onCanvasMutated]);

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

  /* 🆕 挂载时恢复画布激活技能(进入页面 chip 与注入状态一致) */
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    void window.bigbotart
      .skillActive(projectId, canvasId)
      .then((s) => {
        if (alive && s) setActiveSkill({ skillId: s.skillId, name: s.name, inject: s.inject });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [projectId, canvasId]);

  return {
    msgs,
    sending,
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
  };
}

export type AgentChatApi = ReturnType<typeof useAgentChat>;
