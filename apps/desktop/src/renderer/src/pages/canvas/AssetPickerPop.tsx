/**
 * AssetPickerPop — 资产选择弹层(画布 asset 节点「更换资产…」/ 检查器「从资源库选择…」)
 *
 * 对齐设计稿 assetPop:缩略图 + 名称 + 亚标题 + 分类,底部「管理资产 · 打开项目资源 →」。
 * 候选列表 = 当前项目资源在前,后补全局共享资源;支持搜索。
 */
import React, { useEffect, useRef, useState } from 'react';
import type { Asset, AssetCategory } from '@bigbotart/shared';

interface AssetPickerPopProps {
  open: boolean;
  /** 弹层锚点(视口坐标) */
  pos: { x: number; y: number } | null;
  /** 候选资产(调用方已排序:项目资源在前) */
  assets: Asset[];
  categories: AssetCategory[];
  projectId: string | null;
  onPick: (asset: Asset) => void;
  /** 「管理资产 · 打开项目资源 →」 */
  onManage: () => void;
  onClose: () => void;
}

function KindMark({ a }: { a: Asset }) {
  if (a.kind === 'audio') return <span style={{ fontSize: 13 }}>🎵</span>;
  if (a.kind === 'video') return <span style={{ fontSize: 13 }}>🎬</span>;
  if (a.kind === 'document') return <span style={{ fontSize: 13 }}>📄</span>;
  if (a.localPath) {
    return (
      <img
        src={`bba-asset://${a.localPath.split('/').pop()}`}
        alt=""
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        loading="lazy"
      />
    );
  }
  return <span style={{ fontSize: 13 }}>🖼</span>;
}

export function AssetPickerPop({
  open,
  pos,
  assets,
  categories,
  projectId,
  onPick,
  onManage,
  onClose,
}: AssetPickerPopProps) {
  const [q, setQ] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
  }, [open]);

  /* 点外 / Escape 关闭 */
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current && wrapRef.current.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open || !pos) return null;

  const needle = q.trim().toLowerCase();
  const list = needle
    ? assets.filter(
        (a) =>
          a.name.toLowerCase().includes(needle) ||
          (a.tags ?? []).some((t) => t.toLowerCase().includes(needle)),
      )
    : assets;

  return (
    <div
      ref={wrapRef}
      className="pop open"
      data-od-id="asset-picker-pop"
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: 286,
        maxHeight: 420,
        display: 'flex',
        flexDirection: 'column',
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="pop-cap">选择资产 · 来自资产中心</div>
      <div className="ap-s" style={{ padding: '6px 10px' }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 13, height: 13 }}>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          placeholder="搜索资产名 / 标签…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', fontSize: 12 }}
        />
      </div>
      <div style={{ overflowY: 'auto', flex: 1, maxHeight: 300 }}>
        {list.length === 0 ? (
          <div className="ap-empty" style={{ padding: '14px 10px' }}>没有匹配的资产 · 先去资源页导入</div>
        ) : (
          list.map((a) => {
            const cat = categories.find((c) => c.id === a.categoryId)?.name;
            const isProj = a.projectId === projectId;
            const projTag = a.projectId ? (isProj ? '项目' : '全局') : '总库';
            return (
              <button
                key={a.id}
                className="pop-it"
                data-od-id={`asset-pick-${a.id}`}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left' }}
                onClick={() => {
                  onPick(a);
                  onClose();
                }}
              >
                <span
                  style={{
                    width: 28, height: 28, borderRadius: 7, overflow: 'hidden', flex: 'none',
                    display: 'grid', placeItems: 'center', background: 'var(--surface)',
                  }}
                >
                  <KindMark a={a} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                    {a.name}
                  </b>
                  <span className="asub" style={{ display: 'block', fontSize: 10.5, color: 'var(--muted)' }}>
                    {a.kind} · {projTag}
                  </span>
                </span>
                <span className="acat" style={{ fontSize: 10, color: 'var(--meta)', flex: 'none' }}>
                  {cat ?? '未分类'}
                </span>
              </button>
            );
          })
        )}
      </div>
      <div className="pop-hr" />
      <button
        className="pop-it"
        data-od-id="asset-picker-manage"
        onClick={() => {
          onManage();
          onClose();
        }}
      >
        管理资产 · 打开项目资源 →
      </button>
    </div>
  );
}