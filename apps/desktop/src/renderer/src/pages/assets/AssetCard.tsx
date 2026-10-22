/**
 * AssetCard — 资源卡片(资源管理页网格;纯展示 + 选中回调)
 *
 * 对齐设计稿 acard:缩略图 + 覆盖角标(媒体类型 / 产物 / 附件 / 时长)+ 名称 + meta + 标签行。
 * 点击选中;详情在右侧 AssetDetail。
 */
import React from 'react';
import type { Asset } from '@bigbotart/shared';
import { SafeImage } from '../../components/SafeImage';
import { assetUrlOf } from '../canvas/media';

interface AssetCardProps {
  asset: Asset;
  categoryName?: string;
  selected: boolean;
  /** 引用数(删除安全提示用;0 = 不显示) */
  refCount?: number;
  onSelect: (id: string) => void;
}

function thumbOf(a: Asset): string | null {
  if (a.kind === 'image' && a.localPath) return assetUrlOf(a.localPath);
  return null;
}

export function AssetCard({ asset: a, categoryName, selected, refCount, onSelect }: AssetCardProps) {
  const img = thumbOf(a);
  const dims: string[] = [];
  if (a.width && a.height) dims.push(`${a.width}×${a.height}`);
  if (a.durationSec != null) dims.push(`${a.durationSec}s`);
  const sub = dims.join(' · ');
  return (
    <div
      className={`acard${selected ? ' sel' : ''}`}
      data-id={a.id}
      data-od-id={`asset-card-${a.id}`}
      style={{ cursor: 'pointer' }}
      onClick={() => onSelect(a.id)}
    >
      <div className="athumb">
        {img ? (
          <SafeImage src={img} alt={a.name} fill loading="lazy" />
        ) : a.kind === 'audio' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2.5, height: '100%', padding: '0 16px' }}>
            {[14, 26, 36, 20, 30, 16, 34, 22, 12, 28].map((h, i) => (
              <i key={i} style={{ width: 3, height: h, borderRadius: 2, background: 'color-mix(in oklab, var(--fg) 32%, transparent)' }} />
            ))}
          </div>
        ) : a.kind === 'video' ? (
          <div style={{ display: 'grid', placeItems: 'center', height: '100%', background: 'var(--surface)', color: 'var(--meta)' }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5.5v13l11-6.5Z" />
            </svg>
          </div>
        ) : (
          <div style={{ display: 'grid', placeItems: 'center', height: '100%', background: 'var(--surface)', color: 'var(--muted)' }}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6 2h9l5 5v15H6Z" />
              <path d="M14 2v6h6M9 13h8M9 17h5" />
            </svg>
          </div>
        )}
        <span className="tag" style={{ position: 'absolute', left: 8, top: 8 }}>
          {a.kind}
        </span>
        {a.source === 'product' ? (
          <span className="tag ok" style={{ position: 'absolute', right: 8, top: 8 }}>
            产物
          </span>
        ) : a.source === 'attachment' ? (
          <span className="tag warn" style={{ position: 'absolute', right: 8, top: 8 }}>
            附件
          </span>
        ) : null}
      </div>
      <div className="ai">
        <b>{a.name}</b>
        <div className="mono mut">
          {sub}
          {refCount ? <span style={{ marginLeft: 6 }}>· {refCount} 处引用</span> : null}
        </div>
        {categoryName ? (
          <div className="mono mut" style={{ fontSize: 10.5 }}>
            {categoryName}
          </div>
        ) : null}
        {a.tags?.length ? (
          <div className="mono mut" style={{ fontSize: 10 }}>
            {a.tags.slice(0, 3).join(' · ')}
          </div>
        ) : null}
      </div>
    </div>
  );
}