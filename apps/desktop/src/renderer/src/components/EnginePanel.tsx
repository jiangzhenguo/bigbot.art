import React, { useState } from 'react';
import type { RuntimeProbe } from '@bigbotart/shared';

/** 引擎引导浮层 — 样式走 design-pages.css `.engine-panel*` + 主题 token */
export default function EnginePanel({
  probes,
  onProbe,
}: {
  probes: RuntimeProbe[];
  onProbe: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const install = async (id: string) => {
    setBusy(id);
    try {
      const r = await window.bigbotart.installRuntime(id);
      if (r.ok) {
        await onProbe();
        alert(`${r.message} · 已重新探测`);
      } else {
        alert(r.message);
      }
    } catch (e) {
      alert(`安装调用失败:${e instanceof Error ? e.message : String(e)}`);
    }
    setBusy(null);
  };

  if (!open) {
    return (
      <button
        type="button"
        className="engine-panel-toggle"
        onClick={() => setOpen(true)}
        title="引擎引导向导"
      >
        🛠 引擎引导
      </button>
    );
  }

  return (
    <div className="engine-panel">
      <div className="engine-panel-hd">
        <span className="engine-panel-title">引擎引导向导</span>
        <button type="button" className="engine-panel-close" onClick={() => setOpen(false)} aria-label="关闭">
          ✕
        </button>
      </div>
      {probes.map((p) => (
        <div key={p.id} className="engine-panel-card">
          <div className="engine-panel-row">
            <span className="engine-panel-label">{p.label}</span>
            <span
              className={
                p.status === 'ready'
                  ? 'engine-panel-status ok'
                  : p.status === 'missing'
                    ? 'engine-panel-status miss'
                    : 'engine-panel-status bad'
              }
            >
              {p.status === 'ready' ? '✔ 就绪' : p.status === 'missing' ? '未安装' : '异常'}
            </span>
          </div>
          {p.detail && <div className="engine-panel-detail">{p.detail}</div>}
          {p.status !== 'ready' && p.id !== 'h3c' && (
            <button
              type="button"
              className="engine-panel-install"
              onClick={() => install(p.id)}
              disabled={busy === p.id}
            >
              {busy === p.id ? '处理中…' : p.id === 'mlxgen' ? '一键安装 mlxgen' : '查看安装指引'}
            </button>
          )}
        </div>
      ))}
      <button type="button" className="engine-panel-probe" onClick={onProbe}>
        ↻ 重新探测
      </button>
    </div>
  );
}
