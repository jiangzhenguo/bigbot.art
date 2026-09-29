/**
 * ModelCombo — 模型下拉(检查器)
 * - 数据源:已知 4 模型(与 capabilities().models 同口径)+ 自定义 repoId
 * - 每项右侧徽章实时反映下载状态:已下载 ✓ / 待下载 ⤓ / 下载中 %(mlxgenModels / mlxgenDownload / mlxgenDownloadStatus)
 * - 点击「待下载」徽章直接发起下载;完成后自动选中
 */
import React, { useEffect, useRef, useState } from 'react';

export interface ModelItem {
  id: string;
  name: string;
  repoId: string;
  /** 兼容旧节点存的值(短别名等),匹配时按已登记显示 */
  alias?: string;
  desc: string;
  ico: string;
}

/** 与 packages/providers capabilities().models 同口径的已知图片模型(大小 = HF 官方清单实测 2026-09) */
export const IMAGE_MODELS: ModelItem[] = [
  { id: 'z-image-turbo', name: 'Z-Image-Turbo', repoId: 'AbstractFramework/z-image-turbo-8bit', desc: '文生图 · ~11 GB', ico: 'Z-T' },
  // 2.1 统一 bf16 全量:文生图 + 参考编辑(1-10 张 / 原生 RGBA)三能力全有。
  // 原 8bit 社区导出无 vision tower、做不了编辑,已移除(2026-09-28)
  { id: 'qwen-image-2.1', name: 'Qwen-Image-2.1', repoId: 'Qwen/Qwen-Image-2.1', alias: 'qwen-image-2.1', desc: '文生图 / 参考编辑 · 7.1B · ~33 GB', ico: 'Q-2' },
  { id: 'qwen-image-edit', name: 'Qwen Image Edit', repoId: 'mlx-community/Qwen-Image-Edit-8bit', alias: 'qwen-image-edit', desc: '指令编辑 / mask · 8bit ~37.5 GB', ico: 'Q-E' },
  { id: 'flux2-klein-9b', name: 'Flux.2 Klein 9B', repoId: 'AbstractFramework/flux.2-klein-9b-8bit', desc: '多参考编辑 / outpaint · ~18 GB', ico: 'F-K' },
  { id: 'seedvr2-3b', name: 'SeedVR2 3B', repoId: 'AbstractFramework/seedvr2-3b-8bit', desc: '超分修复 · ~4.7 GB', ico: 'S-V' },
];

export function matchModel(value: string): ModelItem | undefined {
  return IMAGE_MODELS.find((m) => m.repoId === value || m.alias === value);
}

export function ModelCombo({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (repoId: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const [dls, setDls] = useState<Record<string, { pct?: number; error?: string }>>({});
  const [custom, setCustom] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);

  const refresh = () => {
    void window.bigbotart.mlxgenModels().then((list) => {
      setReady(Object.fromEntries(list.map((m) => [m.repoId, m.downloaded])));
    }).catch(() => {});
  };
  useEffect(() => {
    refresh();
  }, [open]);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const startDl = (repoId: string) => {
    void window.bigbotart.mlxgenDownload(repoId).then((res) => {
      const jobId = res.jobId;
      if (!res.ok || !jobId) {
        setDls((d) => ({ ...d, [repoId]: { error: res.error ?? '下载失败' } }));
        return;
      }
      const t = window.setInterval(() => {
        void window.bigbotart.mlxgenDownloadStatus(jobId).then((st) => {
          if (st.status === 'running') {
            setDls((d) => ({ ...d, [repoId]: { pct: st.pct ?? 0 } }));
            return;
          }
          window.clearInterval(t);
          setDls((d) => ({ ...d, [repoId]: st.status === 'done' ? { pct: 100 } : { error: st.error ?? '下载失败' } }));
          refresh();
          if (st.status === 'done') onChange(repoId);
        }).catch(() => {});
      }, 700);
    }).catch(() => setDls((d) => ({ ...d, [repoId]: { error: '下载启动失败' } })));
  };

  const cur = matchModel(value);
  const curDl = cur ? dls[cur.repoId] : undefined;
  const label = cur?.name ?? (value ? value : '选择模型');

  return (
    <div className="combo" ref={rootRef} data-od-id="field-model-combo">
      <button
        className="combo-btn"
        type="button"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={disabled ? { opacity: 0.55 } : undefined}
      >
        <span className="ico">{cur?.ico ?? '···'}</span>
        <span className="meta">
          <span className="name">{label}</span>
          <span className="desc">{cur?.repoId ?? (value ? '自定义 repoId' : '来自 capabilities().models')}</span>
        </span>
        {cur ? (
          ready[cur.repoId] ? (
            <span className="badge ok">已下载</span>
          ) : curDl?.pct != null && curDl.pct < 100 ? (
            <span className="badge dl">下载中 {curDl.pct}%</span>
          ) : (
            <span className="badge dl">待下载</span>
          )
        ) : null}
        <span className="caret"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.7}><path d="m3 4.5 3 3 3-3" /></svg></span>
      </button>

      {open ? (
        <div className="combo-menu open" data-od-id="combo-menu-open">
          {IMAGE_MODELS.map((m) => {
            const dl = dls[m.repoId];
            const bad = dl?.error;
            return (
              <div
                key={m.id}
                className={`combo-opt${value === m.repoId || value === m.alias ? ' sel' : ''}`}
                onClick={() => {
                  if (dl && dl.pct != null && dl.pct! < 100) return; // 下载中不可选
                  onChange(m.repoId);
                  setOpen(false);
                }}
              >
                <span className="ico">{m.ico}</span>
                <span className="meta">
                  <span className="name">{m.name}</span>
                  <span className="desc">{m.repoId} · {m.desc}</span>
                </span>
                {ready[m.repoId] ? (
                  <span className="badge ok">已下载</span>
                ) : dl && dl.pct != null && dl.pct < 100 ? (
                  <span className="badge dl" onClick={(e) => { e.stopPropagation(); }}>下载中 {Math.round(dl.pct)}%</span>
                ) : (
                  <span
                    className="badge dl"
                    title="点击开始下载"
                    onClick={(e) => {
                      e.stopPropagation();
                      startDl(m.repoId);
                    }}
                  >
                    {bad ? `${bad.slice(0, 18)} · 重试` : `待下载 · ${m.desc.split('·')[1]?.trim() ?? ''}`}
                  </span>
                )}
              </div>
            );
          })}
          <div className="combo-opt" style={{ borderTop: '1px solid var(--border-soft)', marginTop: 4, paddingTop: 10 }}>
            <span className="ico" style={{ background: 'transparent', color: 'var(--muted)' }}>···</span>
            <span className="meta">
              <span className="name">输入自定义 repoId</span>
              <span className="desc"><input
                className="f-in"
                placeholder="owner/repo"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && custom.trim()) {
                    onChange(custom.trim());
                    setOpen(false);
                    setCustom('');
                  }
                }}
              /></span>
            </span>
          </div>
          <div className="combo-foot">在「设置 → 模型」可管理下载 / 删除缓存</div>
        </div>
      ) : null}
    </div>
  );
}