/**
 * 语音引擎设置卡(语音合成 / 视频配音)
 *
 * 两张卡:
 *  1. CosyVoice3(`tts` / `dub` · 参考音色克隆 · CPU 隔离 venv · ~5.4GB)
 *  2. Qwen3-TTS VoiceDesign(`voice-design` / `dub --voice-design` · 文字设计音色 · MLX · ~4.5GB)
 *
 * 只做**就绪探测 + 可照抄命令**:真正的 `mlxgen prepare` 是数 GB 下载 + 建 venv,
 * 不在设置页里自动跑(避免用户以为是秒级操作;也避免无确认的网络/磁盘写入)。
 */
import React, { useEffect, useState } from 'react';
import type { TtsTooling } from '@bigbotart/shared';
import { useT } from '../i18n';

interface EngineRowProps {
  odId: string;
  title: string;
  subtitle: string;
  ready: boolean;
  busy: boolean;
  path?: string;
  missing: string[];
  command: string;
  onRefresh: () => void;
  error?: string | null;
}

function EngineRow(props: EngineRowProps) {
  const t = useT();
  const { odId, title, subtitle, ready, busy, path, missing, command, onRefresh, error } = props;
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* 由上层 error 展示 */
      });
  };

  return (
    <div className="mdl-row" data-od-id={odId} style={{ alignItems: 'flex-start' }}>
      <div className="grow" style={{ minWidth: 0 }}>
        <b>{title}</b>
        <div className="sub mono" style={{ fontSize: 11, color: 'var(--muted)', wordBreak: 'break-all' }}>
          {subtitle}
        </div>
        <div className="sub mono" style={{ fontSize: 10.5, marginTop: 4, wordBreak: 'break-all', color: 'var(--meta)' }}>
          {t('包路径')}: {path ?? '—'}
        </div>
        {!ready ? (
          <div style={{ marginTop: 6 }}>
            <div className="sub" style={{ fontSize: 11, color: 'var(--warn)' }}>
              {missing.join(';') || t('未就绪')}
            </div>
            <div
              className="mono"
              style={{
                marginTop: 4,
                padding: '6px 8px',
                border: '1px solid var(--border-soft)',
                borderRadius: 8,
                background: 'var(--surface-warm)',
                fontSize: 10.5,
                wordBreak: 'break-all',
              }}
            >
              {command}
            </div>
            <button type="button" className="btn btn-s btn-sm" style={{ marginTop: 6 }} onClick={copy}>
              {copied ? t('已复制') : t('复制准备命令')}
            </button>
          </div>
        ) : null}
        {error ? (
          <div className="sub" style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4 }}>
            {error}
          </div>
        ) : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
        <span className={`badge ${ready ? 'ok' : ''}`} style={ready ? undefined : { color: 'var(--warn)' }}>
          {busy ? t('探测中…') : ready ? t('已就绪') : t('未准备')}
        </span>
        <button type="button" className="btn btn-s btn-sm" onClick={onRefresh}>
          {t('重新探测')}
        </button>
      </div>
    </div>
  );
}

export function CosyVoiceSettings() {
  const t = useT();
  const [probe, setProbe] = useState<TtsTooling | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setError(null);
    void window.bigbotart
      .ttsProbe()
      .then((p) => setProbe(p))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    refresh();
  }, []);

  const cloneReady = Boolean(probe?.mlxgen && probe?.packageReady);
  const designReady = Boolean(probe?.mlxgen && probe?.voiceDesignReady);
  const genericMissing = (probe?.missing ?? []).filter(
    (m) => !m.includes('CosyVoice3') && !m.includes('Qwen3-TTS'),
  );

  return (
    <>
      <EngineRow
        odId="settings-cosyvoice"
        title={`CosyVoice3 · ${t('参考音色克隆')}`}
        subtitle={t('mlxgen tts / dub · 零样本克隆 · CPU 隔离 venv · 约 5.4GB')}
        ready={cloneReady}
        busy={probe === null}
        path={probe?.packagePath}
        missing={[
          ...genericMissing,
          ...(probe && !probe.packageReady ? [`CosyVoice3 prepared package 未就绪(${probe.packagePath ?? ''})`] : []),
        ]}
        command={probe?.prepareHint ?? 'mlxgen prepare --model cosyvoice3'}
        onRefresh={refresh}
        error={error}
      />
      <EngineRow
        odId="settings-qwen3-tts"
        title={`Qwen3-TTS · ${t('文字设计音色')}`}
        subtitle={t('mlxgen voice-design / dub --voice-design · 无需参考音 · 纯 MLX · 约 4.5GB')}
        ready={designReady}
        busy={probe === null}
        path={probe?.voiceDesignPackagePath}
        missing={[
          ...genericMissing,
          ...(probe && !probe.voiceDesignReady
            ? [`Qwen3-TTS prepared package 未就绪(${probe.voiceDesignPackagePath ?? ''})`]
            : []),
        ]}
        command={probe?.voiceDesignPrepareHint ?? 'mlxgen prepare --model qwen3-tts-voice-design'}
        onRefresh={refresh}
        error={error}
      />
    </>
  );
}
