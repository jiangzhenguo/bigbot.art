/**
 * Agent 多会话(ChatThread)——迁移、列表预览、标题截断等纯函数。
 * 状态写入仍走 MemoryStore(本文件不碰磁盘)。
 */
import type { ChatThread, ChatThreadListItem, ProjectMemory, RecallMessage } from '@bigbotart/shared';

export const TITLE_MAX = 32;
export const PREVIEW_MAX = 72;

export function newThreadId(): string {
  return `thr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export function truncateTitle(text: string, max = TITLE_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** 从首条用户消息生成会话标题(确定性,不调 LLM) */
export function titleFromFirstUserMessage(msgs: RecallMessage[]): string {
  const u = msgs.find((r) => r.role === 'user' && r.content.trim());
  return u ? truncateTitle(u.content) : '';
}

/** 最近一条人类可读正文作预览 */
export function previewFromMessages(msgs: RecallMessage[]): string | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const r = msgs[i];
    if (!r) continue;
    if (r.role !== 'user' && r.role !== 'assistant') continue;
    const t = r.content.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    return t.length <= PREVIEW_MAX ? t : `${t.slice(0, PREVIEW_MAX - 1)}…`;
  }
  return undefined;
}

function emptyCanvasMem(): ProjectMemory['canvasMemory'][string] {
  return { summary: '', nodeCount: 0, lastActive: new Date().toISOString(), keyDecisions: [] };
}

/**
 * 幂等迁移:把「一画布一条流」收成默认 ChatThread。
 * 返回是否改写了 memory(调用方决定是否 persist)。
 */
export function migrateChatThreadsV1(m: ProjectMemory): boolean {
  if (m.migration?.chatThreadsV1) {
    // 已标记,但仍兜底:漏网的无 threadId 消息归入该画布 active/唯一 thread
    return healOrphanRecall(m);
  }
  m.threads ??= {};
  const canvasIds = new Set<string>();
  for (const r of m.recall) canvasIds.add(r.canvasId);
  for (const cid of Object.keys(m.canvasMemory)) canvasIds.add(cid);

  let changed = false;
  const now = new Date().toISOString();
  for (const canvasId of canvasIds) {
    const existing = Object.values(m.threads).filter((t) => t.canvasId === canvasId && !t.archivedAt);
    if (existing.length > 0) {
      // 已有会话:给无 threadId 的 recall 补上活跃/首个会话
      const cm = m.canvasMemory[canvasId] ?? emptyCanvasMem();
      const activeId = cm.activeThreadId && m.threads[cm.activeThreadId] ? cm.activeThreadId : existing[0]!.id;
      if (cm.activeThreadId !== activeId) {
        m.canvasMemory[canvasId] = { ...cm, activeThreadId: activeId };
        changed = true;
      }
      for (const r of m.recall) {
        if (r.canvasId === canvasId && !r.threadId) {
          r.threadId = activeId;
          changed = true;
        }
      }
      continue;
    }

    const canvasRecall = m.recall.filter((r) => r.canvasId === canvasId);
    const id = `thr-legacy-${canvasId}`.slice(0, 64);
    const title = titleFromFirstUserMessage(canvasRecall) || '默认对话';
    const cm = m.canvasMemory[canvasId] ?? emptyCanvasMem();
    const thread: ChatThread = {
      id,
      canvasId,
      title,
      conversationSummary: cm.conversationSummary,
      createdAt: canvasRecall[0]?.createdAt ?? now,
      updatedAt: canvasRecall[canvasRecall.length - 1]?.createdAt ?? now,
    };
    m.threads[id] = thread;
    m.canvasMemory[canvasId] = { ...cm, activeThreadId: id };
    for (const r of canvasRecall) {
      if (!r.threadId) {
        r.threadId = id;
        changed = true;
      }
    }
    changed = true;
  }

  const wasMarked = Boolean(m.migration?.chatThreadsV1);
  m.migration = { ...(m.migration ?? {}), chatThreadsV1: true };
  return changed || !wasMarked;
}

/** 已迁移后仍出现的无 threadId 消息 → 归入画布活跃会话 */
function healOrphanRecall(m: ProjectMemory): boolean {
  m.threads ??= {};
  let changed = false;
  for (const r of m.recall) {
    if (r.threadId) continue;
    const cm = m.canvasMemory[r.canvasId];
    let tid = cm?.activeThreadId;
    if (!tid || !m.threads[tid]) {
      const any = Object.values(m.threads).find((t) => t.canvasId === r.canvasId && !t.archivedAt);
      tid = any?.id;
    }
    if (!tid) {
      // 该画布完全没有会话 → 补一个
      tid = newThreadId();
      const now = new Date().toISOString();
      m.threads[tid] = {
        id: tid,
        canvasId: r.canvasId,
        title: '默认对话',
        createdAt: now,
        updatedAt: now,
      };
      m.canvasMemory[r.canvasId] = {
        ...(cm ?? emptyCanvasMem()),
        activeThreadId: tid,
      };
    }
    r.threadId = tid;
    changed = true;
  }
  return changed;
}

export function listThreadItems(
  m: ProjectMemory,
  canvasId: string,
): ChatThreadListItem[] {
  const threads = Object.values(m.threads ?? {}).filter((t) => t.canvasId === canvasId && !t.archivedAt);
  const activeId = m.canvasMemory[canvasId]?.activeThreadId;
  const items: ChatThreadListItem[] = threads.map((t) => {
    const msgs = m.recall.filter((r) => r.threadId === t.id);
    return {
      ...t,
      preview: previewFromMessages(msgs),
      hasCompact: Boolean(t.conversationSummary),
      active: t.id === activeId,
    };
  });
  items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return items;
}

/** 会话是否「空」(从未发过用户消息)——新对话时复用,防空壳刷屏 */
export function threadHasUserMessage(m: ProjectMemory, threadId: string): boolean {
  return m.recall.some((r) => r.threadId === threadId && r.role === 'user');
}
