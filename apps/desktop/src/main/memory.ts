/**
 * MemoryStore — Agent 分层记忆(MemGPT 式)
 * 持久化 ~/.bigbotart/memory-<projectId>.json
 *
 * 四层:
 * - core: 核心记忆(项目目标/风格/约束/偏好),始终全量注入 system prompt
 * - canvasMemory: 每个画布的总结(切换画布时写入;其他画布以 summary 注入当前会话)
 * - recall: 全部对话消息(按 canvasId 检索最近 N 条注入)
 * - archival: 长期事实(生成产物/关键决定),关键字检索注入
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProjectMemory, RecallMessage, ArchivalEntry } from '@bigbotart/shared';

const DATA_DIR = process.env.BIGBOTART_HOME ?? join(homedir(), '.bigbotart');

const RECALL_INJECT_LIMIT = 12; // 当前画布最近 N 条消息注入
const ARCHIVAL_INJECT_LIMIT = 3; // archival 检索 top N
const SUMMARY_FALLBACK_LEN = 200; // summary 生成的保底截断

function memFile(projectId: string): string {
  return join(DATA_DIR, `memory-${projectId}.json`);
}

function emptyMemory(projectId: string): ProjectMemory {
  return {
    projectId,
    core: { projectGoal: '', styleGuide: '', constraints: '', userPreferences: '' },
    canvasMemory: {},
    recall: [],
    archival: [],
  };
}

export class MemoryStore {
  private cache = new Map<string, ProjectMemory>();

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  get(projectId: string): ProjectMemory {
    const cached = this.cache.get(projectId);
    if (cached) return cached;
    const f = memFile(projectId);
    if (existsSync(f)) {
      try {
        const m = JSON.parse(readFileSync(f, 'utf-8')) as ProjectMemory;
        this.cache.set(projectId, m);
        return m;
      } catch {
        /* 损坏则重建 */
      }
    }
    const m = emptyMemory(projectId);
    this.cache.set(projectId, m);
    return m;
  }

  private persist(projectId: string): void {
    const m = this.cache.get(projectId);
    if (m) writeFileSync(memFile(projectId), JSON.stringify(m, null, 2));
  }

  /** 追加对话消息到 recall */
  addRecall(projectId: string, msg: Omit<RecallMessage, 'id' | 'createdAt'>): RecallMessage {
    const m = this.get(projectId);
    const entry: RecallMessage = {
      ...msg,
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
    };
    m.recall.push(entry);
    this.persist(projectId);
    return entry;
  }

  /** 写归档记忆 */
  addArchival(projectId: string, text: string, tags: string[], sourceCanvasId?: string): ArchivalEntry {
    const m = this.get(projectId);
    const entry: ArchivalEntry = {
      id: `arc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text,
      tags,
      sourceCanvasId,
      createdAt: new Date().toISOString(),
    };
    m.archival.push(entry);
    this.persist(projectId);
    return entry;
  }

  /** 更新核心记忆某段 */
  updateCore(projectId: string, section: keyof ProjectMemory['core'], content: string): void {
    const m = this.get(projectId);
    m.core[section] = content;
    this.persist(projectId);
  }

  /** 更新画布总结(切换画布/关键变化时调用) */
  updateCanvasSummary(projectId: string, canvasId: string, summary: string, nodeCount: number, keyDecision?: string): void {
    const m = this.get(projectId);
    const cur = m.canvasMemory[canvasId] ?? {
      summary: '', nodeCount: 0, lastActive: '', keyDecisions: [] as string[],
    };
    cur.summary = summary;
    cur.nodeCount = nodeCount;
    cur.lastActive = new Date().toISOString();
    if (keyDecision) cur.keyDecisions.push(keyDecision);
    m.canvasMemory[canvasId] = cur;
    this.persist(projectId);
  }

  /** 检索 recall(当前画布最近 N 条) */
  recentRecall(projectId: string, canvasId: string, limit = RECALL_INJECT_LIMIT): RecallMessage[] {
    const m = this.get(projectId);
    return m.recall.filter((r) => r.canvasId === canvasId).slice(-limit);
  }

  /** archival 关键字检索(简单包含匹配 + 时间倒序) */
  searchArchival(projectId: string, query: string, limit = ARCHIVAL_INJECT_LIMIT): ArchivalEntry[] {
    const m = this.get(projectId);
    const q = query.toLowerCase();
    const hits = m.archival.filter((a) =>
      a.text.toLowerCase().includes(q) || a.tags.some((t) => q.includes(t.toLowerCase())),
    );
    const rest = m.archival.filter((a) => !hits.includes(a));
    return [...hits.reverse(), ...rest.reverse()].slice(0, limit);
  }

  /**
   * 组装发给 LLM 的上下文:
   * system prompt(core 全量) + 其他画布 summary 注入 + 当前画布 recall 最近 N 条 + archival 检索
   */
  buildContext(projectId: string, canvasId: string, userInput: string): {
    systemPrompt: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  } {
    const m = this.get(projectId);
    const parts: string[] = [];

    // ① 核心记忆
    parts.push(`你是 BigBotArt 画布工作台里的视频创作 Agent。你可以调用工具操作画布/引擎/资产/Skills。
工具返回后你会收到工具结果,然后继续回复或继续调用工具。
始终用中文回复。回答要具体、可执行,不要空谈。`);
    const core = m.core;
    if (core.projectGoal) parts.push(`【项目目标】${core.projectGoal}`);
    if (core.styleGuide) parts.push(`【风格规则】${core.styleGuide}`);
    if (core.constraints) parts.push(`【硬性约束】${core.constraints}`);
    if (core.userPreferences) parts.push(`【用户偏好】${core.userPreferences}`);

    // ② 其他画布的 summary 注入(当前画布除外)
    const others = Object.entries(m.canvasMemory).filter(([cid]) => cid !== canvasId);
    if (others.length > 0) {
      parts.push('【本项目的其他画布】');
      for (const [cid, cm] of others) {
        const nodePart = cm.nodeCount > 0 ? `(${cm.nodeCount} 节点)` : '(空)';
        parts.push(`- 画布 ${cid} ${nodePart}: ${cm.summary || '暂无总结'}`);
      }
    }

    // ③ 当前画布 recall(最近 N 条) —— 转 messages
    const recent = this.recentRecall(projectId, canvasId);
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = recent
      .filter((r) => r.role === 'user' || r.role === 'assistant')
      .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));

    // ④ archival 检索注入(进 system prompt)
    const arc = this.searchArchival(projectId, userInput);
    if (arc.length > 0) {
      parts.push('【项目记忆(相关)】');
      for (const a of arc) parts.push(`- ${a.text}`);
    }

    return { systemPrompt: parts.join('\n\n'), messages };
  }

  /** 生成画布 summary(供切换画布时调用;LLM 失败时调用方给 fallback) */
  static summarizeFallback(canvasName: string, nodes: Array<{ kind: string; label?: string }>): string {
    const counts: Record<string, number> = {};
    for (const n of nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
    const parts = Object.entries(counts).map(([k, v]) => `${v}个${k}`);
    return `「${canvasName}」: ${parts.join('、') || '空白画布'}`.slice(0, SUMMARY_FALLBACK_LEN);
  }
}