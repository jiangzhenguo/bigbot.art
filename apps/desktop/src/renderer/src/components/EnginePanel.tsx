import React, { useState } from 'react';
import type { RuntimeProbe } from '@bigbotart/shared';

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
    const r = await window.bigbotart.installRuntime(id);
    setBusy(null);
    alert(r.message);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{ position: 'absolute', top: 10, right: 10, zIndex: 10, background: '#232a36', color: '#e6e8ec', border: '1px solid #3a4356', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 12 }}
        title="引擎引导向导"
      >
        🛠 引擎引导
      </button>
    );
  }

  return (
    <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 10, width: 300, background: '#1b1f27', border: '1px solid #3a4356', borderRadius: 10, padding: 14, fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontWeight: 700 }}>引擎引导向导</span>
        <button onClick={() => setOpen(false)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 14 }}>✕</button>
      </div>
      {probes.map((p) => (
        <div key={p.id} style={{ padding: '8px 10px', marginBottom: 6, background: '#1f252f', borderRadius: 8, border: '1px solid #2a3040' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 600 }}>{p.label}</span>
            <span style={{ marginLeft: 'auto', color: p.status === 'ready' ? '#57c7a2' : p.status === 'missing' ? '#d9a25e' : '#e07a7a' }}>
              {p.status === 'ready' ? '✔ 就绪' : p.status === 'missing' ? '未安装' : '异常'}
            </span>
          </div>
          {p.detail && <div style={{ opacity: 0.6, marginTop: 3, lineHeight: 1.4 }}>{p.detail}</div>}
          {p.status !== 'ready' && p.id !== 'h3c' && (
            <button onClick={() => install(p.id)} disabled={busy === p.id}
              style={{ marginTop: 6, background: '#2c6e49', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: busy === p.id ? 'wait' : 'pointer', fontSize: 11 }}>
              {busy === p.id ? '处理中…' : p.id === 'mlxgen' ? '一键安装 mlxgen' : '查看安装指引'}
            </button>
          )}
        </div>
      ))}
      <button onClick={onProbe} style={{ width: '100%', marginTop: 6, background: '#232a36', color: '#e6e8ec', border: '1px solid #3a4356', borderRadius: 6, padding: '6px 0', cursor: 'pointer', fontSize: 11 }}>
        ↻ 重新探测
      </button>
    </div>
  );
}