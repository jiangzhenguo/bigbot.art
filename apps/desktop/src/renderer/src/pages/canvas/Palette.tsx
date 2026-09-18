/**
 * Palette — 左侧节点面板(纯展示 + 双击/折叠回调透传)
 *
 * 拆分自 CanvasPage 的 <aside class="palette"> 区块。
 * DOM 结构与原实现一致:aside + pal-expand 同屏渲染,
 * 显隐由外层 .app.palette-collapsed 类 + CSS 控制(design-pages.css .palette-collapsed 规则)。
 */
import React from 'react';
import { NODE_TYPES } from './constants';
import { PALETTE_ICONS } from './icons';

interface PaletteProps {
  collapsed: boolean;
  onCollapse: () => void;
  onExpand: () => void;
  /** 双击节点类型 → 在画布视口中心附近添加 */
  onAddByDoubleClick: (typeId: string) => void;
}

export function Palette({ collapsed, onCollapse, onExpand, onAddByDoubleClick }: PaletteProps) {
  return (
    <>
      <aside className="palette" data-od-id="canvas-palette">
        <div className="pal-head">
          <span className="lbl">节点面板 · 点击添加</span>
          <button
            className="pal-fold"
            title="收起节点面板"
            aria-label="收起节点面板"
            data-od-id="palette-collapse"
            onClick={(e) => {
              e.stopPropagation();
              onCollapse();
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
              <path d="m14 6-6 6 6 6" />
            </svg>
          </button>
        </div>
        {NODE_TYPES.map((t) => (
          <div
            className="pal-it"
            key={t.id}
            draggable
            title="双击添加到画布中心 · 或拖到画布内"
            onDoubleClick={() => onAddByDoubleClick(t.id)}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'copy';
              e.dataTransfer.setData('application/x-bigbotart-palette', t.id);
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
              {PALETTE_ICONS[t.id]}
            </svg>
            <div>
              <b>{t.name}</b>
              <span>{t.sub}</span>
            </div>
            {t.p1 ? <span className="p1">P1</span> : t.wf ? <span className="p1">WF</span> : null}
          </div>
        ))}
      </aside>
      <button
        className="pal-expand"
        title="展开节点面板"
        aria-label="展开节点面板"
        data-od-id="palette-expand"
        onClick={onExpand}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
          <path d="m10 6 6 6-6 6" />
        </svg>
        节点面板
      </button>
    </>
  );
}