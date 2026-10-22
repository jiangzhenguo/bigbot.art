/**
 * 设置页「远程访问」。口令只在生成的这一次出现在桌面窗口里。
 */
import React, { useEffect, useState } from 'react';
import { DEFAULT_REMOTE_PORT, type RemoteAccessStatus } from '@bigbotart/shared';
import { useT } from '../../i18n';

export function RemoteAccessSection() {
  const t = useT();
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [portText, setPortText] = useState(String(DEFAULT_REMOTE_PORT));
  const [passphrase, setPassphrase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    void window.bigbotart.remoteAccessStatus().then((s) => {
      setStatus(s);
      setPortText(String(s.port || DEFAULT_REMOTE_PORT));
    });
  };

  useEffect(() => {
    refresh();
  }, []);

  const port = () => {
    const n = Number(portText);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_REMOTE_PORT;
  };

  const apply = async (enabled: boolean) => {
    setBusy(true);
    try {
      await window.bigbotart.setSettings({ remoteAccess: { enabled, port: port() } });
      setPassphrase(null);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    setBusy(true);
    try {
      const res = await window.bigbotart.remoteAccessRotatePassphrase();
      if (!res.ok || !res.passphrase) {
        setPassphrase(null);
        return;
      }
      setPassphrase(res.passphrase);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const on = status?.enabled === true;
  return (
    <div className="srow" data-od-id="settings-remote-access" style={{ alignItems: 'flex-start' }}>
      <div className="grow">
        <b>{t('远程访问')}</b>
        <div className="sub">
          {t('只在 Tailscale 网卡和本机回环上监听,默认关闭。不要用 Funnel 把这个端口公布到公网。')}
        </div>
        <div className="sub" style={{ marginTop: 8 }}>
          {status?.listening
            ? status.urls.join('  ')
            : (status?.error ?? t('未开启'))}
          {status?.listening && !status.pageReady ? ` · ${t('页面还没构建,请先 pnpm build')}` : ''}
        </div>
        <div className="row g8" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <span className="input-w">
            <input
              data-od-id="settings-remote-port"
              inputMode="numeric"
              value={portText}
              onChange={(e) => setPortText(e.target.value)}
              aria-label={t('端口')}
            />
          </span>
          <button className="btn btn-s btn-sm" type="button" disabled={busy} onClick={() => void rotate()}>
            {t('生成新口令')}
          </button>
        </div>
        {passphrase ? (
          <input
            data-od-id="settings-remote-passphrase"
            readOnly
            value={passphrase}
            onFocus={(e) => e.currentTarget.select()}
            style={{ marginTop: 8, width: '100%' }}
            aria-label={t('口令(只显示这一次)')}
          />
        ) : null}
      </div>
      <span
        className={`sw${on ? ' on' : ''}`}
        data-sw=""
        data-od-id="settings-remote-toggle"
        onClick={() => {
          if (!busy) void apply(!on);
        }}
      />
    </div>
  );
}
