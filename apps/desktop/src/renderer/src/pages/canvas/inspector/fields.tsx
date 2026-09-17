import React from 'react';

export function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="kr">
      <span>{k}</span>
      <span className="mono">{v}</span>
    </div>
  );
}

export function KVSection({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="kv">
      {rows.map(([k, v]) => (
        <KV key={k} k={k} v={v} />
      ))}
    </div>
  );
}

export function Lbl({ children }: { children: React.ReactNode }) {
  return (
    <div className="lbl" style={{ marginBottom: 8 }}>
      {children}
    </div>
  );
}

export function TextAreaField({ label, value, onChange, rows = 4, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; rows?: number; placeholder?: string;
}) {
  return (
    <div>
      <Lbl>{label}</Lbl>
      <textarea
        className="input-w"
        rows={rows}
        style={{ width: '100%', resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 12 }}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
