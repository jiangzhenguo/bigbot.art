/**
 * 网页入口的口令页。登录成功后整页刷新,让 WebSocket 带着 cookie 重连。
 */
import React, { useState } from 'react';

export function RemoteLogin() {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ passphrase }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !body?.ok) {
        setError(body?.error || '登录失败');
        setBusy(false);
        return;
      }
      location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
      setBusy(false);
    }
  };

  return (
    <form
      data-od-id="remote-login"
      onSubmit={(e) => void submit(e)}
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
        color: 'var(--fg)',
      }}
    >
      <div style={{ width: 'min(420px, calc(100% - 32px))', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <b>BigBotArt</b>
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>这台 Mac 上的远程访问。口令只存在于这台电脑的设置页。</div>
        <input
          data-od-id="remote-passphrase"
          type="password"
          autoComplete="current-password"
          value={passphrase}
          onChange={(ev) => setPassphrase(ev.target.value)}
          placeholder="口令"
          style={{
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid var(--border-soft)',
            background: 'transparent',
            color: 'inherit',
          }}
        />
        {error ? <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div> : null}
        <button className="btn btn-p" type="submit" disabled={busy || !passphrase} data-od-id="remote-login-submit">
          {busy ? '正在登录…' : '登录'}
        </button>
      </div>
    </form>
  );
}
