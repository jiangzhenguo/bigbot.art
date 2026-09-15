/**
 * CanvasSwitcher — 画布工作台 topbar 项目标题旁的"画布切换器"
 * 设计稿对应 OpenDesign canvas.html topbar:
 *   <button class="cv-title" id="canvasChip" data-od-id="canvas-switcher">
 *     <span id="cvName">主画布</span><svg>…</svg>
 *   </button>
 *   <input id="cvRename" class="cv-rename" … style="display:none">
 *   <div class="pop" id="canvasPop">
 *     <div class="pop-cap">画布 · 本项目 <span id="cvCount">3</span> 个</div>
 *     <div id="cvList"></div>
 *     <div class="pop-hr"></div>
 *     <button id="cvNew">＋ 新建画布</button>
 *     <button id="cvRenameBtn">重命名「主画布」…</button>
 *     <button id="cvDel" class="danger">删除「主画布」</button>
 *   </div>
 *
 * 视觉与样式严格沿用设计稿(.pg-canvas 命名空间下的 .cv-title/.cv-rename/.pop/.pop-it)。
 * 渲染时通过 projectCanvases 拿列表,active = projectCanvases.activeCanvasId。
 *
 * 交互:点击 chip 打开 pop;pop 内点列表项触发 onSwitchCanvas(返回目标快照给上层);
 * 新建/重命名/删除调用对应 handler;pop 在外点击/创建/删除后自动关闭。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CanvasSnapshot, ProjectCanvases } from '@bigbotart/shared';

interface CanvasSwitcherProps {
  projectCanvases: ProjectCanvases | null;
  onSwitchCanvas: (canvasId: string) => Promise<CanvasSnapshot | null>;
  onCreateCanvas: (name?: string) => Promise<CanvasSnapshot | null>;
  onDeleteCanvas: (canvasId: string) => Promise<string | null>;
  onRenameCanvas: (canvasId: string, name: string) => Promise<boolean>;
  /** 顶部 chrome 颜色风格 — 透传给 .cv-title/.pop */
  surface?: 'glass' | 'plain';
}

export default function CanvasSwitcher({
  projectCanvases,
  onSwitchCanvas,
  onCreateCanvas,
  onDeleteCanvas,
  onRenameCanvas,
}: CanvasSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState('');
  const [popPos, setPopPos] = useState<{ top: number; left: number } | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const list = projectCanvases?.canvases ?? [];
  const activeId = projectCanvases?.activeCanvasId ?? '';
  const cur = list.find((c) => c.id === activeId);

  /** 打开弹窗时定位到 chip 下方(Portal 到 body,需要 fixed 坐标) */
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = chipRef.current?.getBoundingClientRect();
      if (!r) return;
      setPopPos({ top: Math.round(r.bottom + 8), left: Math.round(r.left) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  /* ── 点 chip / pop 外面关闭 ── */
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current && wrapRef.current.contains(t)) return;
      if (popRef.current && popRef.current.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /* ── 进入重命名 → 聚焦输入框 ── */
  useEffect(() => {
    if (renaming) {
      requestAnimationFrame(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      });
    }
  }, [renaming]);

  const startRename = () => {
    if (!cur) return;
    setRenameVal(cur.name);
    setRenaming(true);
    setOpen(false);
  };
  const endRename = async (save: boolean) => {
    if (!cur) return;
    const next = renameVal.trim();
    setRenaming(false);
    if (!save || !next || next === cur.name) return;
    await onRenameCanvas(cur.id, next);
  };

  const handleCreate = async () => {
    const created = await onCreateCanvas();
    setOpen(false);
    if (created) {
      await onSwitchCanvas(created.id);
    }
  };

  const handleSwitch = async (id: string) => {
    setOpen(false);
    if (id === activeId) return;
    await onSwitchCanvas(id);
  };

  const handleDelete = async () => {
    if (!cur) return;
    if (!confirm(`删除「${cur.name}」？此操作不可撤销。`)) return;
    const nextActiveId = await onDeleteCanvas(cur.id);
    if (nextActiveId) {
      await onSwitchCanvas(nextActiveId);
    }
  };

  if (!cur) return null;

  return (
    <div ref={wrapRef} style={{ display: 'inline-flex', alignItems: 'center', position: 'relative' }}>
      {renaming ? (
        <input
          ref={renameInputRef}
          className="cv-rename"
          value={renameVal}
          maxLength={24}
          aria-label="画布名称"
          data-od-id="canvas-rename-input"
          onChange={(e) => setRenameVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') endRename(true);
            else if (e.key === 'Escape') endRename(false);
          }}
          onBlur={() => endRename(true)}
          style={{ display: 'block' }}
        />
      ) : (
        <button
          ref={chipRef}
          className="cv-title"
          id="canvasChip"
          data-od-id="canvas-switcher"
          title="点击切换画布 · 双击重命名"
          onClick={() => setOpen((v) => !v)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            startRename();
          }}
          style={{ display: 'inline-flex' }}
        >
          <span id="cvName">{cur.name}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      )}
      <span className="crumb-sep" style={{ visibility: 'hidden', width: 8 }}>
        ›
      </span>

      {open && popPos &&
        createPortal(
          <div
            ref={popRef}
            className="pop open"
            id="canvasPop"
            data-od-id="canvas-switcher-pop"
            style={{
              position: 'fixed',
              top: popPos.top,
              left: popPos.left,
              minWidth: 260,
              display: 'block',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="pop-cap">
              画布 · 本项目 <span id="cvCount">{list.length}</span> 个
            </div>
            <div id="cvList" style={{ maxHeight: 220, overflow: 'auto' }}>
              {list.map((c) => {
                const isCur = c.id === activeId;
                return (
                  <button
                    key={c.id}
                    className="pop-it"
                    data-cv={c.id}
                    data-od-id={isCur ? 'canvas-active' : 'canvas-item'}
                    onClick={() => handleSwitch(c.id)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left' }}
                  >
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                    <span className="cv-meta">{c.nodes?.length ?? 0} 节点</span>
                    {isCur ? <span className="ck">✓</span> : null}
                  </button>
                );
              })}
            </div>
            <div className="pop-hr" />
            <button
              className="pop-it"
              id="cvNew"
              data-od-id="canvas-new"
              onClick={handleCreate}
            >
              ＋ 新建画布
            </button>
            <button
              className="pop-it"
              id="cvRenameBtn"
              data-od-id="canvas-rename"
              onClick={startRename}
            >
              重命名「{cur.name}」…
            </button>
            <button
              className={`pop-it${list.length <= 1 ? ' danger dim' : ' danger'}`}
              id="cvDel"
              data-od-id="canvas-delete"
              onClick={handleDelete}
            >
              删除「{cur.name}」
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}