/**
 * AssetDetail — 资源详情面板(资源管理页右侧;纯展示 + 编辑回调)
 *
 * 对齐设计稿 detail:预览 / 分类 select / 标签编辑器(联想+频次)/ 属性 / 绑定与引用 / 删除警告。
 * 本地状态只放标签编辑输入;任何持久化都走 onUpdate / onDelete / onUseInCanvas。
 */
import React, { useEffect, useState } from 'react';
import type { Asset, AssetCategory, AssetRef } from '@bigbotart/shared';
import { MediaInfoPanel } from '../canvas/inspector/MediaInfoPanel';

interface AssetDetailProps {
  asset: Asset | null;
  categories: AssetCategory[];
  projectId: string | null;
  projectName: string;
  refs: AssetRef[];
  /** 全库标签频次(联想候选,按频次降序) */
  tagStats: Array<{ t: string; n: number }>;
  toastMsg: (m: string) => void;
  onUpdate: (patch: { name?: string; categoryId?: string | null; projectId?: string | null; tags?: string[] }) => Promise<boolean>;
  onDelete: () => void;
  onUseInCanvas: () => void;
}

const SRC_LABEL: Record<string, string> = { import: '手动导入', attachment: '对话附件', product: '画布产物归档' };

function formatDate(s: string | undefined): string {
  if (!s) return '—';
  const t = s.includes('T') ? s : `${s}T00:00:00Z`;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('zh-CN', { hour12: false });
}

export function AssetDetail({
  asset: a,
  categories,
  projectId,
  projectName,
  refs,
  tagStats,
  toastMsg,
  onUpdate,
  onDelete,
  onUseInCanvas,
}: AssetDetailProps) {
  /* 标签编辑:本地态随资产切换重置;回车或逗号添加 */
  const [tags, setTags] = useState<string[]>(a?.tags ?? []);
  const [tagInput, setTagInput] = useState('');
  useEffect(() => {
    setTags(a?.tags ?? []);
    setTagInput('');
  }, [a?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!a) {
    return (
      <div className="detail-in">
        <div className="empty" style={{ padding: '40px 20px' }}>
          <b>选择资源查看详情</b>
          <span className="mut" style={{ fontSize: 11 }}>分类 / 标签 / 引用 / 删除都在这里</span>
        </div>
      </div>
    );
  }

  const commitTags = (next: string[]) => {
    setTags(next);
    void onUpdate({ tags: next }).then((ok) => {
      if (!ok) toastMsg('标签保存失败');
    });
  };
  const addTag = () => {
    const v = tagInput.trim().replace(/,$/, '');
    if (!v) return;
    if (tags.includes(v)) {
      setTagInput('');
      return;
    }
    commitTags([...tags, v]);
    setTagInput('');
  };
  const removeTag = (i: number) => commitTags(tags.filter((_, idx) => idx !== i));

  const applyCat = (categoryId: string) => void onUpdate({ categoryId: categoryId || null });
  const applyProj = (pid: string) =>
    void onUpdate({ projectId: pid || null }).then((ok) => {
      if (ok) toastMsg(pid ? `已归入项目` : '已移到总资源库');
    });

  const catOptions = categories
    .filter((c) => !c.projectId || c.projectId === projectId || c.projectId === a.projectId)
    .slice()
    .sort((x, y) => (x.projectId ? 0 : -1) - (y.projectId ? 0 : -1));

  /* 联想候选:全库频次高的在前,排除已选 */
  const sugg = tagStats.filter((s) => !tags.includes(s.t)).slice(0, 6);

  return (
    <div className="detail-in">
      <div className="dpreview">
        {a.kind === 'image' && a.localPath ? (
          <img src={`bba-asset://${a.localPath.split('/').pop()}`} alt={a.name} />
        ) : a.kind === 'video' && a.localPath ? (
          <video
            src={`bba-asset://${a.localPath.split('/').pop()}`}
            muted
            loop
            playsInline
            preload="metadata"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', background: 'var(--media-bg)' }}
          />
        ) : a.kind === 'audio' ? (
          <div className="wavebox" style={{ display: 'flex', alignItems: 'center', gap: 3, height: '100%', padding: '0 18px' }}>
            {[14, 26, 36, 20, 30, 16, 34, 22, 12, 28, 18, 32, 14, 24].map((h, i) => (
              <i key={i} style={{ height: h }} />
            ))}
          </div>
        ) : (
          <div className="doc-thumb" style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6 2h9l5 5v15H6Z" />
              <path d="M14 2v6h6M9 13h8M9 17h5" />
            </svg>
          </div>
        )}
      </div>

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13, wordBreak: 'break-all' }}>{a.name}</div>
          <div className="mono mut" style={{ fontSize: 10.5 }}>{a.id}</div>
        </div>
      </div>

      <div className="lbl" style={{ margin: '10px 0 6px' }}>分类</div>
      <select className="dcat-select" style={{ width: '100%', padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', fontSize: 12, color: 'var(--fg)' }} value={a.categoryId ?? ''} onChange={(e) => applyCat(e.target.value)}>
        <option value="">未分类</option>
        {catOptions.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}{c.projectId ? '' : ' · 全局'}
          </option>
        ))}
      </select>

      <div className="lbl" style={{ margin: '10px 0 6px' }}>归属</div>
      <select className="dcat-select" style={{ width: '100%', padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', fontSize: 12, color: 'var(--fg)' }} value={a.projectId ?? ''} onChange={(e) => applyProj(e.target.value)}>
        <option value="">总资源库 · 全局共享</option>
        {projectId && a.projectId !== projectId ? (
          <option value={projectId}>{projectName} · 项目</option>
        ) : null}
        {a.projectId ? <option value="">移出到总资源库</option> : null}
      </select>

      <div className="lbl" style={{ margin: '10px 0 6px' }}>
        标签 <span className="mut" style={{ fontWeight: 400 }}>· 回车或逗号添加</span>
      </div>
      <div className="tag-suggest">
        <div className="tag-edit" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '4px 0' }}>
          {tags.map((t, i) => (
            <span key={t} className="tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {t}
              <span className="x" style={{ cursor: 'pointer' }} data-i={i} onClick={() => removeTag(i)}>×</span>
            </span>
          ))}
          <input
            placeholder={tags.length ? '' : '+ 添加标签'}
            value={tagInput}
            style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 12, flex: 1, minWidth: 90 }}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addTag();
              }
            }}
          />
        </div>
        {sugg.length || tagInput.trim() ? (
          <div className="sug" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
            {sugg.map((s) => (
              <button key={s.t} className="chip" style={{ fontSize: 10.5 }} onClick={() => commitTags([...tags, s.t])}>
                + {s.t} <span className="n" style={{ opacity: 0.6 }}>{s.n}</span>
              </button>
            ))}
            {tagInput.trim() && !tags.includes(tagInput.trim()) ? (
              <button className="chip" style={{ fontSize: 10.5 }} onClick={addTag}>
                新建「{tagInput.trim()}」↵
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="lbl" style={{ margin: '10px 0 6px' }}>属性</div>
      <div className="kv">
        <div className="kr"><span>类型</span><span>{a.kind}</span></div>
        {a.width && a.height ? (
          <div className="kr"><span>尺寸</span><span className="mono">{a.width}×{a.height}{a.durationSec ? ` · ${a.durationSec}s` : ''}</span></div>
        ) : null}
        <div className="kr"><span>来源</span><span>{SRC_LABEL[a.source ?? 'import'] ?? '手动导入'}</span></div>
        {a.originNodeId ? <div className="kr"><span>来源节点</span><span className="mono">{a.originNodeId}</span></div> : null}
        <div className="kr"><span>创建</span><span className="mono">{formatDate(a.createdAt)}</span></div>
      </div>

      {/* 媒体信息:按需 ffprobe(宽高/时长/帧率/采样率),与画布资源节点检查器同一组件同一口径 ——
          资产记录里的字段是**导入那一刻**快照下来的,历史资产缺 fps/采样率,这里现探一次补齐 */}
      {a.localPath ? (
        <div style={{ marginTop: 10 }}>
          <MediaInfoPanel path={a.localPath} kind={a.kind} />
        </div>
      ) : null}

      <div className="lbl" style={{ margin: '10px 0 6px' }}>
        绑定与引用 <span className="mut" style={{ fontWeight: 400 }}>· {refs.length ? `${refs.length} 处` : '未被引用'}</span>
      </div>
      {refs.length ? (
        <>
          <div className="kv">
            {refs.slice(0, 6).map((r, i) => (
              <div className="kr" key={i}>
                <span>{r.where}</span>
                <span className="mut">{r.kind}</span>
              </div>
            ))}
          </div>
          <div className="refs-warn" data-od-id="assets-delete-warning" style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: 'color-mix(in oklab, var(--danger) 8%, transparent)', color: 'var(--danger)', fontSize: 11 }}>
            此资源被 {refs.length} 处画布节点引用 · 文件将进入回收站（7 天后清理），引用节点会标记为「资产已移除」。
          </div>
        </>
      ) : (
        <div className="kv"><div className="kr"><span>画布引用</span><span>未被引用 · 可安全移动</span></div></div>
      )}

      <div className="row g6" style={{ flexWrap: 'wrap', marginTop: 14 }}>
        <button className="btn btn-p btn-sm" data-od-id="asset-detail-use-in-canvas" onClick={onUseInCanvas}>
          在画布使用
        </button>
        <span className="spacer" />
        <button className="btn btn-g btn-sm btn-danger" data-od-id="asset-detail-delete" onClick={onDelete}>
          移到回收站
        </button>
      </div>
    </div>
  );
}