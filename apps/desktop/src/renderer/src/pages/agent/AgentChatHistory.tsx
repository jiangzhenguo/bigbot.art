/**
 * AgentChatHistory — 本画布会话历史抽屉(对照 Open Design canvas.html thread-drawer)
 * 纯展示:列表/搜索/菜单;切换与 CRUD 经 props 回调。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatThreadListItem } from '@bigbotart/shared';

function displayTitle(t: ChatThreadListItem): string {
  if (t.title?.trim()) return t.title.trim();
  if (t.preview?.trim()) {
    const p = t.preview.trim();
    return p.length <= 32 ? p : `${p.slice(0, 31)}…`;
  }
  return '新对话';
}

function relTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const d = Date.now() - ts;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

export function AgentChatHistory({
  open,
  threads,
  activeThreadId,
  onClose,
  onSwitch,
  onRename,
  onDelete,
  onDerive,
}: {
  open: boolean;
  threads: ChatThreadListItem[];
  activeThreadId: string | null;
  onClose: () => void;
  onSwitch: (threadId: string) => void;
  onRename: (threadId: string, title: string) => void;
  onDelete: (threadId: string) => void;
  onDerive: (parentThreadId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setMenu(null);
      return;
    }
    // 打开时聚焦搜索
    const t = window.setTimeout(() => searchRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter((t) => {
      const hay = `${displayTitle(t)} ${t.preview ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [threads, query]);

  const parentTitle = (parentId?: string) => {
    if (!parentId) return '';
    const p = threads.find((x) => x.id === parentId);
    return p ? displayTitle(p) : '…';
  };

  return (
    <div
      className="thread-drawer"
      data-od-id="agent-thread-drawer"
      aria-hidden={open ? 'false' : 'true'}
    >
      <div className="thread-drawer-h">
        <b>本画布 · 对话历史</b>
        <span className="spacer" />
        <button
          type="button"
          className="agent-icon-btn"
          aria-label="关闭历史列表"
          data-od-id="agent-history-close"
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      <div className="thread-search">
        <input
          ref={searchRef}
          type="search"
          placeholder="搜索标题或预览…"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-od-id="agent-thread-search"
        />
      </div>
      <div className="thread-list" role="listbox" aria-label="会话列表" data-od-id="agent-thread-list">
        {filtered.length === 0 ? (
          <div className="thread-empty" data-od-id="thread-empty-hint">
            <b>{query ? '没有匹配的会话' : '还没有历史会话'}</b>
            <span>
              {query
                ? '试试别的关键词,或清空搜索'
                : '发一条消息后会出现在这里。对话按会话隔离 · 画布内容共用。'}
            </span>
          </div>
        ) : (
          filtered.map((t) => {
            const on = t.id === activeThreadId;
            const badges: React.ReactNode[] = [];
            if (on) badges.push(<span key="cur" className="thread-badge cur">当前</span>);
            if (t.hasCompact) badges.push(<span key="sum" className="thread-badge sum">有压缩摘要</span>);
            if (t.parentThreadId) {
              badges.push(
                <span key="der" className="thread-badge der">
                  派生自 {parentTitle(t.parentThreadId)}
                </span>,
              );
            }
            return (
              <button
                key={t.id}
                type="button"
                className={`thread-row${on ? ' on' : ''}`}
                role="option"
                aria-selected={on}
                data-thread-id={t.id}
                onClick={() => onSwitch(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ id: t.id, x: e.clientX, y: e.clientY });
                }}
              >
                <div className="thread-row-top">
                  <span className="thread-row-title">{displayTitle(t)}</span>
                  <span className="thread-row-time">{relTime(t.updatedAt)}</span>
                </div>
                {t.preview ? <div className="thread-row-prev">{t.preview}</div> : null}
                {badges.length ? <div className="thread-badges">{badges}</div> : null}
              </button>
            );
          })
        )}
      </div>
      <div className="thread-drawer-ft">
        对话按会话隔离 · 画布节点与技能仍共用 · 切换不会「时光倒流」画布
      </div>

      {menu ? (
        <div
          ref={menuRef}
          className="pop open thread-menu"
          role="menu"
          data-od-id="agent-thread-menu"
          style={{
            position: 'fixed',
            left: Math.min(menu.x, window.innerWidth - 200),
            top: Math.min(menu.y, window.innerHeight - 140),
            zIndex: 90,
          }}
        >
          <button
            className="pop-it"
            type="button"
            data-od-id="thread-menu-rename"
            onClick={() => {
              const cur = threads.find((x) => x.id === menu.id);
              const next = window.prompt('会话标题', cur?.title ?? '');
              setMenu(null);
              if (next == null) return;
              onRename(menu.id, next);
            }}
          >
            重命名
          </button>
          <button
            className="pop-it"
            type="button"
            data-od-id="thread-menu-derive"
            onClick={() => {
              const id = menu.id;
              setMenu(null);
              onDerive(id);
            }}
          >
            从此新建
          </button>
          <button
            className="pop-it danger"
            type="button"
            data-od-id="thread-menu-delete"
            onClick={() => {
              const id = menu.id;
              setMenu(null);
              if (window.confirm('删除此会话?消息不可恢复。')) onDelete(id);
            }}
          >
            删除会话
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default AgentChatHistory;
