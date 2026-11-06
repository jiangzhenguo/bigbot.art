/**
 * AudioGenInspector — CosyVoice3 语音节点检查器(tts-gen / video-dub)
 *
 * UI 依据:docs 同目录 Open Design 原型 canvas.html(2026-11-02）
 *   - 就绪徽标(已准备 / 未准备 + prepare 命令)
 *   - 旁白文本 + 字数 + RTF≈1.8 墙钟预估
 *   - 参考音色槽(连线优先,可手绑资产)、输入视频槽(video-dub)
 *   - 混音策略 replace/mix + 旁白音量/原声音量滑杆
 *   - 语速 / seed;折叠「高级 · refText / instruct」
 *   - 进度条 + 取消;产物试听/预览;未准备时禁用运行并给可照抄命令
 */
import React, { useEffect, useMemo, useState } from 'react';
import { normalizeVoiceMode, QWEN3_TTS_LANGUAGES, QWEN3_TTS_PROFILES, type Asset } from '@bigbotart/shared';
import type { CanvasNode } from '../types';
import { KVSection, Lbl } from './fields';
import { AudioPlayer, outputUrlOf, basenameOf } from '../media';

export interface AudioGenInspectorProps {
  node: CanvasNode;
  setData: (patch: Record<string, unknown>) => void;
  nodes?: CanvasNode[];
  assetsList: Asset[];
  assetCache: Record<string, string>;
  takeResults?: Record<string, string>;
  running: boolean;
  runNode: (nodeId: string) => void;
  toastMsg: (msg: string) => void;
  projectId?: string | null;
  /** 绑定示例音色后刷新画布侧资产缓存(否则新资产名要等下一次刷新才显示) */
  onRefreshAssets?: () => void;
}

type Probe = import('@bigbotart/shared').TtsTooling;

/**
 * 中文旁白时长粗估(秒):约 4 字/秒。
 * 墙钟按后端 RTF 估:CosyVoice3(CPU)≈1.8 / Qwen3-TTS(MLX Metal)≈0.8。
 */
export function estimateNarration(
  text: string,
  rtf = 1.8,
): { chars: number; audioSec: number; wallSec: number } {
  const chars = String(text ?? '').replace(/\s/g, '').length;
  const audioSec = Math.max(1.5, Math.round((chars / 4) * 10) / 10);
  return { chars, audioSec, wallSec: Math.round(audioSec * rtf) };
}

/** 模式提示(有 instruct → instruct2;有 refText → zero_shot;都没有 → cross_lingual) */
export function modeHintOf(d: Record<string, unknown>): string {
  if (String(d.instruct ?? '').trim()) return '模式 · instruct2(风格指令优先)';
  if (String(d.refText ?? '').trim()) return '模式 · zero_shot(参考音逐字稿)';
  return '模式 · cross_lingual(仅参考音色)';
}

function fmtWall(sec: number): string {
  if (sec < 60) return `${Math.max(2, sec)} 秒`;
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  return `${m} 分${r ? ` ${r} 秒` : ''}`;
}

export function AudioGenInspector(props: AudioGenInspectorProps) {
  const { node, setData, nodes = [], assetsList, takeResults = {}, running, runNode, toastMsg, projectId, onRefreshAssets } = props;
  const kind = node.kind === 'video-dub' ? 'video-dub' : 'tts-gen';
  const d = (node.data ?? {}) as Record<string, unknown>;
  const text = String(d.text ?? '');
  const voiceMode = normalizeVoiceMode(d.voiceMode);
  const designMode = voiceMode === 'design';
  const { chars, audioSec, wallSec } = estimateNarration(text, designMode ? 0.8 : 1.8);
  const speed = d.speed == null ? 1 : Number(d.speed);
  const seed = d.seed == null ? 42 : Number(d.seed);
  const voiceProfile = String(d.voiceProfile ?? '');
  const voiceDescription = String(d.voiceDescription ?? '');
  const language = String(d.language ?? 'auto') || 'auto';
  const temperature = d.temperature == null ? '' : String(d.temperature);
  const mixMode = d.mixMode === 'mix' ? 'mix' : 'replace';
  const keepWav = d.keepWav === true;

  const [probe, setProbe] = useState<Probe | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  /** 「使用示例音色」进行中(复制 + 登记资产是 IPC,防连点) */
  const [sampleBusy, setSampleBusy] = useState(false);

  const refreshProbe = () => {
    setProbeError(null);
    void window.bigbotart
      .ttsProbe()
      .then((p) => setProbe(p))
      .catch((e) => setProbeError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    refreshProbe();
    // 只在节点切换时探测一次;运行结束后手动「重新探测」即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const upstreamTitle = (id: string | undefined): string | undefined => {
    if (!id) return undefined;
    return nodes.find((n) => n.id === id)?.title;
  };
  const assetName = (id: string | undefined): string | undefined => {
    if (!id) return undefined;
    return assetsList.find((a) => a.id === id)?.name;
  };
  const videoFrom = (d.inputVideoFrom as { nodeId?: string } | undefined)?.nodeId;
  const voiceFrom = (d.refVoiceFrom as { nodeId?: string } | undefined)?.nodeId;
  const inputVideoLabel =
    upstreamTitle(videoFrom) ??
    (d.inputAssetId ? `资产 ${assetName(String(d.inputAssetId)) ?? String(d.inputAssetId).slice(0, 10)}` : undefined);
  const refVoiceLabel =
    upstreamTitle(voiceFrom) ??
    (d.refVoiceAssetId
      ? `资产 ${assetName(String(d.refVoiceAssetId)) ?? String(d.refVoiceAssetId).slice(0, 10)}`
      : undefined);

  const outPath = String(d.resultPath ?? '') || takeResults[node.id] || '';
  const narrationPath = String(d.narrationPath ?? '');
  const ready =
    probe === null ? true : probe.mlxgen && (designMode ? probe.voiceDesignReady : probe.packageReady);
  const audioAssets = useMemo(
    () => assetsList.filter((a) => a.kind === 'audio'),
    [assetsList],
  );

  // clone:ref-voice 不是运行前置(未连时主进程回落官方示例音色);
  // design:文字设计音色必须有描述或预设类型(Qwen3-TTS 不需要参考音)。
  const designVoiceReady = Boolean(voiceProfile) || Boolean(voiceDescription.trim());
  const canRun =
    ready &&
    !running &&
    chars > 0 &&
    (kind !== 'video-dub' || Boolean(inputVideoLabel)) &&
    (!designMode || designVoiceReady);
  /** 不能运行的具体原因(直接展示出来,别让用户对着一颗灰按钮猜) */
  const missing = [
    !chars ? '缺旁白文本' : null,
    kind === 'video-dub' && !inputVideoLabel ? '缺输入视频(input-video)' : null,
    designMode && !designVoiceReady ? '缺音色描述(选一个音色类型或写一句描述)' : null,
  ].filter((x): x is string => Boolean(x));

  /** 一键使用引擎包自带的官方示例音色(3.5s):复制到产物目录 + 登记项目资源 + 绑定到本节点 */
  const useSampleVoice = () => {
    if (sampleBusy) return;
    setSampleBusy(true);
    void window.bigbotart
      .ttsSampleVoice({ projectId: projectId ?? undefined })
      .then((r) => {
        if (!r.ok || !r.assetId) {
          toastMsg(r.error ?? '示例音色不可用');
          return;
        }
        setData({ refVoiceAssetId: r.assetId });
        onRefreshAssets?.();
        toastMsg(`已绑定官方示例音色(${r.name ?? '3.5s'})`);
      })
      .catch((e) => toastMsg(`示例音色不可用:${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setSampleBusy(false));
  };

  const start = () => {
    if (!ready) {
      toastMsg(
        designMode
          ? '请先在设置里准备 Qwen3-TTS(mlxgen prepare --model qwen3-tts-voice-design)'
          : '请先在设置里准备 CosyVoice3(mlxgen prepare --model cosyvoice3)',
      );
      return;
    }
    if (!chars) {
      toastMsg('请填写旁白文本');
      return;
    }
    if (kind === 'video-dub' && !inputVideoLabel) {
      toastMsg('需要输入视频连线 · input-video');
      return;
    }
    if (designMode && !designVoiceReady) {
      toastMsg('选一个内置音色类型,或写一句音色描述');
      return;
    }
    runNode(node.id);
  };

  const cancel = () => {
    void window.bigbotart
      .ttsCancel({ nodeId: node.id })
      .then((r) => {
        if (!r.ok) toastMsg(r.error ?? '取消失败');
      })
      .catch(() => toastMsg('取消失败'));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-od-id="insp-audio-gen">
      {/* 长任务进行中:显眼的整体进度(节点卡可能不在视野内) */}
      {node.progress ? (
        <div className="gstate run" data-od-id="tts-progress">
          <div className="gs-h">
            <span className="spin"></span>
            <b>{node.progress.stage || (kind === 'video-dub' ? '配音中' : '合成中')}</b>
            {node.progress.pct !== undefined ? <span className="right">{Math.round(node.progress.pct * 100)}%</span> : null}
          </div>
          <span className={`pbar${node.progress.indet ? ' indet' : ''}`}>
            {node.progress.indet ? (
              <i></i>
            ) : (
              <i className="fill" style={{ width: `${Math.round((node.progress.pct ?? 0) * 100)}%` }}></i>
            )}
          </span>
          <div className="gs-sub">{node.progress.text}</div>
          <div className="gs-act">
            <span className="grow"></span>
            <button type="button" className="btn btn-s btn-sm" style={{ color: 'var(--danger)' }} onClick={cancel}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      {/* 就绪徽标 */}
      <div className="f-sec">
        {probe === null && !probeError ? (
          <span className="badge">正在探测语音引擎…</span>
        ) : ready ? (
          <span className="badge" data-od-id="cosy-ready" style={{ color: 'var(--success)' }}>
            {designMode ? '✓ Qwen3-TTS · 已准备 · MLX Metal' : '✓ CosyVoice3 · 已准备 · 离线 CPU'}
          </span>
        ) : (
          <div>
            <span className="badge" data-od-id="cosy-missing" style={{ color: 'var(--warn)' }}>
              ! 未准备 · 运行按钮已禁用
            </span>
            <div className="f-hint" style={{ marginTop: 6 }}>
              {probeError ??
                (designMode
                  ? probe?.voiceDesignReady
                    ? 'Qwen3-TTS 已就绪'
                    : `Qwen3-TTS prepared package 未就绪(${probe?.voiceDesignPackagePath ?? ''})`
                  : probe?.packageReady
                    ? 'CosyVoice3 已就绪'
                    : `CosyVoice3 prepared package 未就绪(${probe?.packagePath ?? ''})`)}
            </div>
            {probe ? (
              <div className="mono f-hint" style={{ fontSize: 10.5, wordBreak: 'break-all', marginTop: 4 }}>
                {designMode ? probe.voiceDesignPrepareHint : probe.prepareHint}
              </div>
            ) : null}
            <button type="button" className="btn btn-xs" style={{ marginTop: 6 }} onClick={refreshProbe}>
              重新探测
            </button>
          </div>
        )}
      </div>

      {/* 产物:配音成片可直接播;文生语音给播放器 */}
      {kind === 'video-dub' && outPath ? (
        <div>
          <Lbl>配音结果</Lbl>
          <video
            src={outputUrlOf(outPath) ?? ''}
            controls
            preload="metadata"
            style={{ width: '100%', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-soft)', background: 'var(--media-bg)' }}
          />
          <div className="mono mut" style={{ fontSize: 11, marginTop: 4 }}>
            {basenameOf(outPath)}
            {d.durationSec ? ` · ${Number(d.durationSec).toFixed(1)}s` : ''}
          </div>
        </div>
      ) : null}
      {kind === 'tts-gen' && outPath ? (
        <div>
          <Lbl>合成结果</Lbl>
          <AudioPlayer src={outputUrlOf(outPath)} name={basenameOf(outPath)} />
          <div className="mono mut" style={{ fontSize: 11, marginTop: 4 }}>
            {basenameOf(outPath)}
            {d.durationSec ? ` · ${Number(d.durationSec).toFixed(1)}s` : ''}
          </div>
        </div>
      ) : null}

      <KVSection
        rows={[
          [
            '引擎',
            designMode
              ? 'Qwen3-TTS · mlxgen voice-design'
              : `CosyVoice3 · mlxgen ${kind === 'video-dub' ? 'dub' : 'tts'}`,
          ],
          [
            '语义',
            kind === 'video-dub'
              ? '成片配旁白 · 画面 stream-copy · 不进 RenderQueue'
              : '文生语音 → wav · 不进 RenderQueue',
          ],
        ]}
      />

      {/* 音色来源:clone = CosyVoice3 参考音;design = Qwen3-TTS 文字设计 */}
      <div className="f-sec" data-od-id="cosy-voice-mode">
        <Lbl>音色来源</Lbl>
        <div className="f-chips">
          <span
            className={`chip${!designMode ? ' on' : ''}`}
            onClick={() => setData({ voiceMode: 'clone' })}
          >
            参考音色克隆
          </span>
          <span
            className={`chip${designMode ? ' on' : ''}`}
            onClick={() => {
              if (designMode) return;
              const hasVoice = Boolean(voiceProfile) || Boolean(voiceDescription.trim());
              setData({ voiceMode: 'design', ...(hasVoice ? {} : { voiceProfile: 'narrator-female' }) });
            }}
          >
            文字设计音色
          </span>
        </div>
        <div className="f-hint" style={{ marginTop: 6 }}>
          {designMode
            ? 'Qwen3-TTS · 用一句话描述声音,不需要参考音;同一描述 + 同一 seed 可复现'
            : 'CosyVoice3 · 参考一段 3–30 秒人声;未指定时用官方示例音色'}
        </div>
      </div>

      {/* 旁白正文 */}
      <div>
        <Lbl>{kind === 'video-dub' ? '旁白文本' : '合成文本'}</Lbl>
        <textarea
          className="f-ta"
          data-od-id="cosy-text"
          value={text}
          placeholder="要念出来的旁白正文(会直接送 CosyVoice3;不需要 Audio 提示词段)"
          onChange={(e) => setData({ text: e.target.value })}
        />
        <div className="f-hint" data-od-id="cosy-eta" style={{ marginTop: 6 }}>
          {chars} 字 · RTF≈{designMode ? '0.8' : '1.8'} · 预计音频 ≈ {audioSec}s · 墙钟 ≈ {fmtWall(wallSec)}
          {designMode ? '(MLX Metal)' : '(CPU)'}
        </div>
      </div>

      {/* 文字设计音色(Qwen3-TTS):预设类型 + 自定义描述 + 语言 */}
      {designMode ? (
        <div className="f-sec" data-od-id="cosy-voice-design">
          <Lbl>音色类型</Lbl>
          <div className="f-chips" style={{ flexWrap: 'wrap' }}>
            {QWEN3_TTS_PROFILES.map((p) => (
              <span
                key={p.id}
                className={`chip${voiceProfile === p.id ? ' on' : ''}`}
                title={p.description}
                onClick={() => setData({ voiceProfile: p.id })}
              >
                {p.label}
              </span>
            ))}
            <span
              className={`chip${!voiceProfile ? ' on' : ''}`}
              onClick={() => setData({ voiceProfile: '' })}
            >
              自定义描述
            </span>
          </div>
          {voiceProfile ? (
            <div className="f-hint" style={{ marginTop: 6 }}>
              {QWEN3_TTS_PROFILES.find((p) => p.id === voiceProfile)?.hint ?? ''} · 内置音色类型(引擎 profile)
            </div>
          ) : (
            <textarea
              className="f-ta"
              data-od-id="cosy-voice-description"
              style={{ marginTop: 8, minHeight: 64 }}
              value={voiceDescription}
              placeholder="如:一位三十多岁的女性,声音温暖沉稳,语速偏慢;或 a deep, warm male narrator voice"
              onChange={(e) => setData({ voiceDescription: e.target.value })}
            />
          )}
          <div className="f-row" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span className="f-lbl" style={{ minWidth: 40 }}>语言</span>
            <select
              className="input-w mono"
              value={language}
              onChange={(e) => setData({ language: e.target.value })}
            >
              {QWEN3_TTS_LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
            <span className="f-hint">短句建议显式选中文</span>
          </div>
        </div>
      ) : (
      <div className="f-sec">
        <Lbl>参考音色</Lbl>
        <div className="slot" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="grow" style={{ flex: 1 }}>
            <div className="sname">ref-voice</div>
            <div className="f-hint">连线优先 · 3–30 秒干净人声;未连接时默认使用官方示例音色(3.5s)</div>
          </span>
          <span className="sval mono" style={{ fontSize: 11 }}>
            {refVoiceLabel ?? '未绑定'}
          </span>
        </div>
        <div className="row" style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-xs"
            onClick={() => {
              const first = audioAssets[0];
              if (!first) {
                toastMsg('资产库里没有音频资产 · 可点「使用示例音色」或先导入一段 3–30 秒人声');
                return;
              }
              setData({ refVoiceAssetId: first.id });
              toastMsg(`已绑定参考音色:${first.name}`);
            }}
          >
            绑定音频资产
          </button>
          <button type="button" className="btn btn-xs" data-od-id="cosy-sample-voice" disabled={sampleBusy} onClick={useSampleVoice}>
            {sampleBusy ? '准备中…' : '使用示例音色'}
          </button>
          {d.refVoiceAssetId ? (
            <button type="button" className="btn btn-xs" onClick={() => setData({ refVoiceAssetId: '' })}>
              解除绑定
            </button>
          ) : null}
        </div>
        {!refVoiceLabel ? (
          <div className="f-hint">未指定音色 → 生成时自动使用官方示例音色;想用自己的声音就绑一段 3–30 秒人声</div>
        ) : null}
      </div>
      )}

      {/* 输入视频 + 混音(video-dub) */}
      {kind === 'video-dub' ? (
        <>
          <div className="f-sec">
            <Lbl>输入视频</Lbl>
            <div className="slot" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="grow" style={{ flex: 1 }}>
                <div className="sname">input-video</div>
                <div className="f-hint">画面不动 · 仅重编码音轨(stream-copy)</div>
              </span>
              <span className="sval mono" style={{ fontSize: 11 }}>
                {inputVideoLabel ?? '未绑定'}
              </span>
            </div>
          </div>
          <div className="f-sec">
            <Lbl>混音策略</Lbl>
            <div className="f-chips">
              {(['replace', 'mix'] as const).map((m) => (
                <span key={m} className={`chip${mixMode === m ? ' on' : ''}`} onClick={() => setData({ mixMode: m })}>
                  {m}
                </span>
              ))}
            </div>
            <div className="f-hint">{mixMode === 'mix' ? '叠在原声上 · 可调原声音量' : '替换原声轨 · 默认'}</div>
            <div className="f-row" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <span className="f-lbl" style={{ minWidth: 64 }}>旁白音量</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={d.ttsVolume == null ? 1 : Number(d.ttsVolume)}
                onChange={(e) => setData({ ttsVolume: Number(e.target.value) })}
                style={{ flex: 1 }}
              />
              <span className="mono" style={{ minWidth: 34, textAlign: 'right', fontSize: 11 }}>
                {d.ttsVolume == null ? 1 : Number(d.ttsVolume)}
              </span>
            </div>
            {mixMode === 'mix' ? (
              <div className="f-row" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <span className="f-lbl" style={{ minWidth: 64 }}>原声音量</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={d.origVolume == null ? 0.15 : Number(d.origVolume)}
                  onChange={(e) => setData({ origVolume: Number(e.target.value) })}
                  style={{ flex: 1 }}
                />
                <span className="mono" style={{ minWidth: 34, textAlign: 'right', fontSize: 11 }}>
                  {d.origVolume == null ? 0.15 : Number(d.origVolume)}
                </span>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {/* 语速 / temperature / seed */}
      <div className="f-sec">
        <Lbl>{designMode ? 'seed / temperature' : '语速 / seed'}</Lbl>
        <div className="f-grid">
          {!designMode ? (
            <div className="fg">
              <span>语速</span>
              <input
                className="input-w mono"
                type="number"
                step="0.05"
                min="0.1"
                value={speed}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v > 0) setData({ speed: v });
                }}
              />
            </div>
          ) : null}
          <div className="fg">
            <span>seed</span>
            <input
              className="input-w mono"
              type="number"
              step="1"
              value={seed}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) setData({ seed: Math.trunc(v) });
              }}
            />
          </div>
          {designMode ? (
            <div className="fg">
              <span>temperature</span>
              <input
                className="input-w mono"
                type="number"
                step="0.05"
                min="0"
                placeholder="默认"
                value={temperature}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  if (!raw) {
                    setData({ temperature: undefined });
                    return;
                  }
                  const v = Number(raw);
                  if (Number.isFinite(v) && v >= 0) setData({ temperature: v });
                }}
              />
            </div>
          ) : null}
        </div>
      </div>

      {/* 高级:refText / instruct(仅 clone 模式) */}
      {!designMode ? (
      <details className="f-sec" data-od-id="cosy-advanced">
        <summary style={{ cursor: 'pointer', fontSize: 11.5, fontWeight: 600, color: 'var(--fg-2)' }}>
          高级 · refText / instruct
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <div className="f-hint">{modeHintOf(d)} · 同时填写时 instruct 优先</div>
          <div>
            <div className="f-hint">参考音逐字稿(refText)</div>
            <textarea
              className="f-ta mono"
              style={{ minHeight: 52 }}
              value={String(d.refText ?? '')}
              onChange={(e) => setData({ refText: e.target.value })}
            />
          </div>
          <div>
            <div className="f-hint">风格指令(instruct)</div>
            <textarea
              className="f-ta"
              style={{ minHeight: 52 }}
              value={String(d.instruct ?? '')}
              onChange={(e) => setData({ instruct: e.target.value })}
              placeholder="如:用温柔亲切的语气说"
            />
          </div>
        </div>
      </details>
      ) : null}

      {/* 旁路产物(video-dub) */}
      {kind === 'video-dub' ? (
        <div className="f-sec">
          <Lbl>旁路产物</Lbl>
          <div className="f-chips">
            <span className={`chip${keepWav ? ' on' : ''}`} onClick={() => setData({ keepWav: true })}>
              保留 wav
            </span>
            <span className={`chip${keepWav ? '' : ' on'}`} onClick={() => setData({ keepWav: false })}>
              不保留
            </span>
          </div>
          {narrationPath ? <div className="f-hint mono">{narrationPath}</div> : null}
        </div>
      ) : null}

      <button type="button" className="btn btn-p btn-sm" data-od-id="cosy-run" disabled={!canRun} onClick={start}>
        {running
          ? kind === 'video-dub'
            ? '配音中…'
            : '合成中…'
          : outPath
            ? kind === 'video-dub'
              ? '重新配音'
              : designMode
                ? '重新生成'
                : refVoiceLabel
                  ? '重新合成'
                  : '用示例音色重新合成'
            : kind === 'video-dub'
              ? '开始配音'
              : designMode
                ? '生成语音'
                : refVoiceLabel
                  ? '开始合成'
                  : '用示例音色合成'}
      </button>
      {!ready ? (
        <div className="f-hint">
          未 prepare 时禁用运行 · 请先在设置完成 {designMode ? 'Qwen3-TTS' : 'CosyVoice3'} 准备
        </div>
      ) : null}
      {ready && !running && missing.length > 0 ? (
        <div className="f-hint" data-od-id="cosy-missing-inputs" style={{ color: 'var(--warn)' }}>
          还不能运行:{missing.join(' · ')}
        </div>
      ) : null}
      {ready && probe && !probe.ffmpeg && kind === 'video-dub' ? (
        <div className="f-hint" style={{ color: 'var(--warn)' }}>ffmpeg 未安装:配音混音需要 ffmpeg(brew install ffmpeg)</div>
      ) : null}
    </div>
  );
}
