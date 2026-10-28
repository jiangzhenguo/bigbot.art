/**
 * 设置页「远程访问」。口令和配对密钥只在这一次出现在桌面窗口里。
 */
import React, { useEffect, useRef, useState } from 'react';
import { DEFAULT_REMOTE_PORT, type RemoteAccessStatus } from '@bigbotart/shared';
import { useT } from '../../i18n';
import MsgCopyBtn from '../agent/MsgCopyBtn';

/** 一次性口令：只读展示 + 显式复制，避免用户手动框选长 Token。 */
export function RemotePassphraseRow({ passphrase, copyLabel, inputLabel }: { passphrase: string; copyLabel: string; inputLabel: string }) {
  return (
    <div className="row g8 remote-passphrase-row" style={{ marginTop: 8, flexWrap: 'nowrap' }}>
      <input
        data-od-id="settings-remote-passphrase"
        readOnly
        value={passphrase}
        onFocus={(e) => e.currentTarget.select()}
        style={{ flex: '1 1 auto', minWidth: 0 }}
        aria-label={inputLabel}
      />
      <MsgCopyBtn text={passphrase} className="btn btn-s btn-sm remote-token-copy" label={copyLabel} />
    </div>
  );
}

export function RemoteAccessSection() {
  const t = useT();
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [portText, setPortText] = useState(String(DEFAULT_REMOTE_PORT));
  const [relayUrl, setRelayUrl] = useState('');
  const [keyText, setKeyText] = useState('');
  const [keyError, setKeyError] = useState('');
  const [passphrase, setPassphrase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loaded = useRef(false);

  const refresh = () => {
    void window.bigbotart.remoteAccessStatus().then((s) => {
      setStatus(s);
      setPortText(String(s.port || DEFAULT_REMOTE_PORT));
      if (!loaded.current) {
        loaded.current = true;
        setRelayUrl(s.relay.url);
      }
    });
  };

  useEffect(() => {
    refresh();
  }, []);

  const port = () => {
    const n = Number(portText);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_REMOTE_PORT;
  };

  const save = async (enabled: boolean, relayEnabled: boolean) => {
    setBusy(true);
    setKeyError('');
    try {
      const key = keyText.trim();
      if (key) {
        const res = await window.bigbotart.relaySetPairingKey(key);
        if (!res.ok) {
          setKeyError(res.error ?? t('配对密钥没有保存'));
          return;
        }
        setKeyText('');
      }
      await window.bigbotart.setSettings({
        remoteAccess: {
          enabled,
          port: port(),
          relayEnabled,
          relayUrl: relayUrl.trim().replace(/\/+$/, ''),
        },
      });
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
  const relayOn = status?.relay.enabled === true;
  return (
    <div className="srow" data-od-id="settings-remote-access" style={{ alignItems: 'flex-start' }}>
      <div className="grow">
        <b>{t('远程访问')}</b>
        <div className="sub">
          {t('推荐用已备案域名上的自建中继。也可以只用 Tailscale。本机服务默认关闭,只听回环或 Tailscale 网卡,不会绑到所有网卡。')}
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
        {passphrase ? <RemotePassphraseRow passphrase={passphrase} copyLabel={t('复制')} inputLabel={t('口令(只显示这一次)')} /> : null}
        <div className="sub" style={{ marginTop: 12 }}>
          <b>{t('自建中继')}</b>
        </div>
        <div className="sub" data-od-id="settings-relay-status">
          {status?.relay.connected ? t('中继已连接') : (status?.relay.error ?? t('中继未连接'))}
          {status?.relay.hasPairingKey ? ` · ${t('配对密钥已保存')}` : ` · ${t('还没有配对密钥')}`}
        </div>
        <div className="row g8" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <span className="input-w" style={{ minWidth: 220, flex: '1 1 220px' }}>
            <input
              data-od-id="settings-relay-url"
              value={relayUrl}
              placeholder="https://art.example.com/bba"
              onChange={(e) => setRelayUrl(e.target.value)}
              aria-label={t('中继地址')}
            />
          </span>
          <span className="input-w" style={{ minWidth: 180 }}>
            <input
              data-od-id="settings-relay-key"
              type="password"
              value={keyText}
              autoComplete="new-password"
              onChange={(e) => setKeyText(e.target.value)}
              aria-label={t('配对密钥')}
            />
          </span>
          <button className="btn btn-s btn-sm" type="button" data-od-id="settings-relay-save" disabled={busy} onClick={() => void save(relayOn ? true : on, relayOn)}>
            {t('保存中继')}
          </button>
          <span
            className={`sw${relayOn ? ' on' : ''}`}
            data-sw=""
            data-od-id="settings-relay-toggle"
            onClick={() => {
              if (!busy) void save(relayOn ? on : true, !relayOn);
            }}
          />
        </div>
        {keyError ? <div className="sub">{keyError}</div> : null}
        <div className="sub" style={{ marginTop: 6 }}>
          {t('地址可以带路径前缀(例如 /bba)。反代要把这个前缀转给中继,浏览器才会用同一个前缀取页面与接口。')}
        </div>
      </div>
      <span
        className={`sw${on ? ' on' : ''}`}
        data-sw=""
        data-od-id="settings-remote-toggle"
        onClick={() => {
          if (!busy) void save(!on, on ? false : relayOn);
        }}
      />
    </div>
  );
}
