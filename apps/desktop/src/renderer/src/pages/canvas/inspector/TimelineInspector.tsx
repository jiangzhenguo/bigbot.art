import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  RenderJob,
  TimelineAudio,
  TimelineData,
  TimelineExportPreset,
  TimelineTransition,
  Take,
} from '@bigbotart/shared';
import type { CanvasNode } from '../types';
import { KVSection, Lbl } from './fields';
import { outputUrlOf } from '../media';

/** 产物 URL 是否为视频(决定用 <video> 还是 <img>) */
function isVideoSrc(src: string | null | undefined): boolean {
  if (!src) return false;
  return /\.(mp4|mov|webm|m4v)$/i.test(src);
}

export interface TimelineInspectorProps {
  node: CanvasNode;
  /** 写回节点 data(以整片 patch) */
  setData: (patch: Partial<TimelineData>) => void;
  /** 当前项目内全部节点(用于按 id 查找 shot 标题 / Take 列表等) */
  nodes: CanvasNode[];
  projectId: string | null;
  activeCanvasId: string | null;
  jobs: RenderJob[];
  toastMsg: (msg: string) => void;
  /** 跳到时间线页面 */
  onOpenTimelinePage?: () => void;
  /** 删边(「移出时间线」= 断开该镜头到时间线的连线) */
  onRemoveEdge?: (sourceId: string, targetId: string) => void;
}

const FORMATS: Array<TimelineExportPreset['format']> = ['mp4-h264', 'prores'];
/* 分辨率 / 多平台版本 UI 已隐藏(导出固定用素材原始尺寸);常量保留供类型引用 */
const RESOLUTIONS: Array<TimelineExportPreset['resolution']> = ['1920x1080', '1280x720', 'source'];
const PLATFORMS: Array<'9:16' | '1:1' | 'no-subtitle'> = ['9:16', '1:1', 'no-subtitle'];
const TRANSITION_KINDS: TimelineTransition['kind'][] = ['cut', 'crossfade', 'fade-black'];

export function TimelineInspector({
  node,
  setData,
  nodes,
  projectId,
  toastMsg,
  onOpenTimelinePage,
  onRemoveEdge,
}: TimelineInspectorProps) {
  const d = (node.data ?? {}) as Partial<TimelineData>;
  const shotNodeIds = d.shotNodeIds ?? [];
  const picks = d.picks ?? {};
  const trim = d.trim ?? {};
  const transitions = d.transitions ?? [];
  const audio: TimelineAudio = d.audio ?? {};
  const exportPreset: TimelineExportPreset = d.exportPreset ?? {};

  /** 镜头节点 → CanvasNode 索引(标题) */
  const nodesById = useMemo(() => {
    const m = new Map<string, CanvasNode>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  /** 每个入线 shot 节点的全量 Take 历史(id → takes[]) */
  const [takeHistory, setTakeHistory] = useState<Record<string, Take[]>>({});
  useEffect(() => {
    let cancelled = false;
    if (!projectId || shotNodeIds.length === 0) {
      setTakeHistory({});
      return () => {
        cancelled = true;
      };
    }
    (async () => {
      const next: Record<string, Take[]> = {};
      await Promise.all(
        shotNodeIds.map(async (sid) => {
          try {
            const h = await window.bigbotart.takesHistory(projectId, sid);
            next[sid] = h.takes ?? [];
          } catch {
            next[sid] = [];
          }
        }),
      );
      if (!cancelled) setTakeHistory(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, shotNodeIds]);

  /** 导出进度(本地状态;成功 toast 即可) */
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);

  /* ── 入线序列操作 ── */
  const moveShot = useCallback(
    (idx: number, dir: -1 | 1) => {
      const next = [...shotNodeIds];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return;
      [next[idx], next[j]] = [next[j]!, next[idx]!];
      setData({ shotNodeIds: next, manualOrder: true });
    },
    [shotNodeIds, setData],
  );

  const removeShot = useCallback(
    (sid: string) => {
      setData({
        shotNodeIds: shotNodeIds.filter((x) => x !== sid),
        manualOrder: true,
        picks: Object.fromEntries(Object.entries(picks).filter(([k]) => k !== sid)),
        trim: Object.fromEntries(Object.entries(trim).filter(([k]) => k !== sid)),
        audio: {
          ...audio,
          perClipVolume: Object.fromEntries(
            Object.entries(audio.perClipVolume ?? {}).filter(([k]) => k !== sid),
          ),
        },
      });
      // 「移出时间线」= 断开该镜头 → 时间线的连线;删边后派发不再把它加回入线
      onRemoveEdge?.(sid, node.id);
      toastMsg(`已移出时间线并断开连线:${nodesById.get(sid)?.title ?? sid.slice(0, 8)}`);
    },
    [shotNodeIds, picks, trim, audio, nodesById, setData, toastMsg, onRemoveEdge, node.id],
  );

  const selectTake = useCallback(
    (sid: string, takeId: string) => {
      setData({ picks: { ...picks, [sid]: takeId } });
    },
    [picks, setData],
  );

  const setTrim = useCallback(
    (sid: string, patch: Partial<{ inSec: number; outSec: number }>) => {
      const cur = trim[sid] ?? { inSec: 0, outSec: 0 };
      setData({ trim: { ...trim, [sid]: { ...cur, ...patch } } });
    },
    [trim, setData],
  );

  const setVolume = useCallback(
    (sid: string, vol: number) => {
      setData({
        audio: {
          ...audio,
          perClipVolume: { ...(audio.perClipVolume ?? {}), [sid]: vol },
        },
      });
    },
    [audio, setData],
  );

  /* ── 转场操作 ── */
  const setTransitionKind = useCallback(
    (idx: number, kind: TimelineTransition['kind']) => {
      const cur = transitions[idx] ?? { afterIndex: idx, kind: 'cut' as const };
      setData({
        transitions: transitions.map((t, i) =>
          i === idx ? { ...cur, ...t, kind } : t,
        ),
      });
    },
    [transitions, setData],
  );

  const setTransitionDuration = useCallback(
    (idx: number, durationMs: number) => {
      const cur = transitions[idx] ?? { afterIndex: idx, kind: 'cut' as const };
      setData({
        transitions: transitions.map((t, i) =>
          i === idx ? { ...cur, ...t, durationMs } : t,
        ),
      });
    },
    [transitions, setData],
  );

  /* ── 导出预设操作 ── */
  const setExportPreset = useCallback(
    (patch: Partial<TimelineExportPreset>) => {
      setData({ exportPreset: { ...exportPreset, ...patch } });
    },
    [exportPreset, setData],
  );

  const togglePlatform = useCallback(
    (p: '9:16' | '1:1' | 'no-subtitle') => {
      const cur = exportPreset.platforms ?? [];
      const next = cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p];
      setExportPreset({ platforms: next });
    },
    [exportPreset, setExportPreset],
  );
  // 分辨率/比例固定取自素材:导出不缩放、多平台留空(UI 已隐藏,导出永远用素材原始尺寸)
  const exportPresetFixed: TimelineExportPreset = {
    ...exportPreset,
    resolution: 'source',
    platforms: [],
  };

  /* ── 导出 ── */
  const startExport = useCallback(async () => {
    if (!projectId) {
      setExportNote('未关联项目,无法导出');
      return;
    }
    if (shotNodeIds.length === 0) {
      setExportNote('时间线为空:连入 shot 节点后再导出');
      return;
    }
    setExportNote(null);
    setExporting(true);
    try {
      const sequence = shotNodeIds.map((sid) => {
        const item: {
          shotNodeId: string;
          takeId?: string;
          trim?: { inSec: number; outSec: number };
          volume?: number;
        } = { shotNodeId: sid };
        if (picks[sid]) item.takeId = picks[sid]!;
        const t = trim[sid];
        if (t && (t.inSec > 0 || t.outSec > 0)) item.trim = t;
        const vol = audio.perClipVolume?.[sid];
        if (vol !== undefined && vol !== 1) item.volume = vol;
        return item;
      });
      const transitionsArr: TimelineTransition[] = [];
      for (let i = 0; i < shotNodeIds.length - 1; i++) {
        const t = transitions[i] ?? { afterIndex: i, kind: 'cut' as const };
        transitionsArr.push({ ...t, afterIndex: i });
      }
      const audioOpt: TimelineAudio = {};
      if (audio.loudnessNormalize !== undefined) audioOpt.loudnessNormalize = audio.loudnessNormalize;

      const res = await window.bigbotart.exportTimeline({
        projectId,
        // 同时填旧字段,保持向后兼容(从 sequence 解析时优先 sequence)
        clips: shotNodeIds.map((sid) => ({
          path: '',
          nodeId: sid,
          takeId: picks[sid],
          label: nodesById.get(sid)?.title,
        })),
        sequence,
        transitions: transitionsArr,
        audio: Object.keys(audioOpt).length > 0 ? audioOpt : undefined,
        exportPreset: exportPresetFixed,
        outputName: 'timeline',
      });
      if (!res.ok) {
        setExportNote(res.error ?? '导出失败');
        toastMsg(`导出失败:${res.error ?? '未知错误'}`);
      } else {
        toastMsg('导出已启动,可在时间线页面查看进度');
      }
    } catch (e) {
      setExportNote(`导出失败:${(e as Error).message}`);
      toastMsg(`导出失败:${(e as Error).message}`);
    } finally {
      setExporting(false);
    }
  }, [projectId, shotNodeIds, picks, trim, audio, transitions, exportPreset, nodesById, toastMsg]);

  const readyShots = shotNodeIds.filter((sid) => {
    const list = takeHistory[sid] ?? [];
    return list.some((t) => t.status === 'succeeded' && t.resultPath);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* ── 1. 入线镜头序列 ── */}
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <Lbl>入线镜头 ×{shotNodeIds.length}</Lbl>
          {d.manualOrder && (
            <span className="mut" style={{ fontSize: 10 }}>
              手动排序 · 不被入边覆盖
            </span>
          )}
        </div>
        {shotNodeIds.length === 0 && (
          <div className="mut" style={{ fontSize: 12 }}>
            通过上游 shot 节点连线自动入线
          </div>
        )}
        {shotNodeIds.map((sid, i) => {
          const shotNode = nodesById.get(sid);
          const takes = takeHistory[sid] ?? [];
          const okTakes = takes.filter((t) => t.status === 'succeeded' && t.resultPath);
          const currentPick = picks[sid];
          const trimCur = trim[sid];
          const vol = audio.perClipVolume?.[sid] ?? 1;
          const latestOk = okTakes[0];
          const thumb = latestOk?.resultPath ? outputUrlOf(latestOk.resultPath) : null;
          return (
            <div
              key={sid}
              style={{
                border: '1px solid var(--border-soft)',
                borderRadius: 8,
                padding: '8px 10px',
                marginBottom: 6,
                background: 'var(--surface-soft)',
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {/* 缩略图:产物是视频用 <video>(首帧封面),图片用 <img> */}
                {thumb ? (
                  isVideoSrc(thumb) ? (
                    <video
                      src={thumb}
                      muted
                      loop
                      playsInline
                      preload="metadata"
                      style={{
                        width: 56,
                        height: 32,
                        objectFit: 'cover',
                        borderRadius: 4,
                        background: 'var(--surface-warm)',
                        flex: 'none',
                      }}
                    />
                  ) : (
                    <img
                      src={thumb}
                      alt="缩略图"
                      style={{
                        width: 56,
                        height: 32,
                        objectFit: 'cover',
                        borderRadius: 4,
                        background: 'var(--surface-warm)',
                        flex: 'none',
                      }}
                    />
                  )
                ) : (
                  <div
                    style={{
                      width: 56,
                      height: 32,
                      display: 'grid',
                      placeItems: 'center',
                      background: 'var(--surface-warm)',
                      border: '1px dashed var(--border)',
                      borderRadius: 4,
                      fontSize: 10,
                      color: 'var(--meta)',
                      flex: 'none',
                    }}
                  >
                    待生成
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    #{i + 1} {shotNode?.title ?? sid.slice(0, 8)}
                  </div>
                  <div className="mono mut" style={{ fontSize: 10 }}>
                    {okTakes.length > 0
                      ? `${okTakes.length} 个可用 Take`
                      : '尚未生成产物'}
                  </div>
                </div>
                {/* 顺序控制 */}
                <div style={{ display: 'flex', gap: 2 }}>
                  <button
                    className="btn btn-s btn-sm"
                    style={{ padding: '2px 6px' }}
                    disabled={i === 0}
                    onClick={() => moveShot(i, -1)}
                    title="上移"
                  >
                    ↑
                  </button>
                  <button
                    className="btn btn-s btn-sm"
                    style={{ padding: '2px 6px' }}
                    disabled={i === shotNodeIds.length - 1}
                    onClick={() => moveShot(i, 1)}
                    title="下移"
                  >
                    ↓
                  </button>
                  <button
                    className="btn btn-s btn-sm"
                    style={{ padding: '2px 6px', color: 'var(--danger)' }}
                    onClick={() => removeShot(sid)}
                    title="移出时间线"
                  >
                    ×
                  </button>
                </div>
              </div>

              {/* Take 选择 */}
              <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className="mut" style={{ fontSize: 11, flex: 'none' }}>Take</span>
                <select
                  className="input-w mono"
                  style={{ flex: 1, fontSize: 11, padding: '2px 6px' }}
                  value={currentPick ?? latestOk?.id ?? ''}
                  onChange={(e) => selectTake(sid, e.target.value)}
                  disabled={okTakes.length === 0}
                >
                  {okTakes.length === 0 && <option value="">(尚无可用 Take)</option>}
                  {okTakes.map((t) => (
                    <option key={t.id} value={t.id}>
                      #{t.attempt} · {t.status === 'succeeded' ? '成功' : t.status} ·{' '}
                      {(t.durationSec ?? 0).toFixed(1)}s
                    </option>
                  ))}
                </select>
              </div>

              {/* 裁切入出点 */}
              <div style={{ marginTop: 4, display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className="mut" style={{ fontSize: 11, flex: 'none' }}>裁切</span>
                <input
                  className="input-w mono"
                  type="number"
                  step="0.1"
                  min={0}
                  placeholder="inSec"
                  style={{ width: 70, fontSize: 11, padding: '2px 6px' }}
                  value={trimCur?.inSec ?? ''}
                  onChange={(e) => setTrim(sid, { inSec: Number(e.target.value) })}
                />
                <span className="mut" style={{ fontSize: 10 }}>→</span>
                <input
                  className="input-w mono"
                  type="number"
                  step="0.1"
                  min={0}
                  placeholder="outSec"
                  style={{ width: 70, fontSize: 11, padding: '2px 6px' }}
                  value={trimCur?.outSec ?? ''}
                  onChange={(e) => setTrim(sid, { outSec: Number(e.target.value) })}
                />
                <span className="mut" style={{ fontSize: 10, marginLeft: 4 }}>vol</span>
                <input
                  className="input-w mono"
                  type="number"
                  step="0.1"
                  min={0}
                  max={2}
                  style={{ width: 50, fontSize: 11, padding: '2px 6px' }}
                  value={vol}
                  onChange={(e) => setVolume(sid, Number(e.target.value))}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* ── 2. 转场 ── */}
      {shotNodeIds.length >= 2 && (
        <div>
          <Lbl>镜头间转场 ×{shotNodeIds.length - 1}</Lbl>
          {Array.from({ length: shotNodeIds.length - 1 }).map((_, i) => {
            const cur = transitions[i] ?? { afterIndex: i, kind: 'cut' as const };
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                  marginBottom: 4,
                  fontSize: 11,
                }}
              >
                <span className="mono mut" style={{ width: 38, flex: 'none' }}>
                  #{i + 1}→{i + 2}
                </span>
                <div style={{ display: 'flex', gap: 2, flex: 1 }}>
                  {TRANSITION_KINDS.map((k) => (
                    <span
                      key={k}
                      className={`chip${cur.kind === k ? ' on' : ''}`}
                      style={{ fontSize: 10, padding: '2px 6px' }}
                      onClick={() => setTransitionKind(i, k)}
                    >
                      {k === 'cut' ? '硬切' : k === 'crossfade' ? '叠化' : '黑场'}
                    </span>
                  ))}
                </div>
                <input
                  className="input-w mono"
                  type="number"
                  step="50"
                  min={0}
                  max={5000}
                  disabled={cur.kind === 'cut'}
                  style={{
                    width: 64,
                    fontSize: 11,
                    padding: '2px 6px',
                    opacity: cur.kind === 'cut' ? 0.4 : 1,
                  }}
                  value={cur.durationMs ?? 500}
                  onChange={(e) => setTransitionDuration(i, Number(e.target.value))}
                />
                <span className="mut" style={{ fontSize: 10 }}>
                  ms
                </span>
              </div>
            );
          })}
          {transitions.some((t) => t.kind === 'fade-black') && (
            <div className="notebox" style={{ marginTop: 4, fontSize: 10 }}>
              黑场转场 P0 与硬切等价(P2 用 overlay 实现)
            </div>
          )}
        </div>
      )}

      {/* ── 3. 音轨 ── */}
      <div>
        <Lbl>音轨</Lbl>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
          <span
            className={`chip${audio.loudnessNormalize !== false ? ' on' : ''}`}
            onClick={() =>
              setData({
                audio: { ...audio, loudnessNormalize: !(audio.loudnessNormalize !== false) },
              })
            }
            style={{ flex: 'none' }}
          >
            响度统一 −14 LUFS
          </span>
        </div>
      </div>

      {/* ── 4. 导出预设 ── */}
      <div>
        <Lbl>导出预设</Lbl>
        <div>
          <span className="mut" style={{ fontSize: 11 }}>格式</span>
          <div className="row g6" style={{ marginTop: 2 }}>
            {FORMATS.map((f) => (
              <span
                key={f}
                className={`chip${(exportPreset.format ?? 'mp4-h264') === f ? ' on' : ''}`}
                style={{ fontSize: 11 }}
                onClick={() => setExportPreset({ format: f })}
              >
                {f === 'mp4-h264' ? 'MP4 · H.264+AAC' : 'ProRes'}
              </span>
            ))}
          </div>
        </div>
        {/* 分辨率 / 多平台版本:暂隐藏,导出完全用素材原始分辨率和尺寸 */}
        <div className="mut" style={{ fontSize: 10, marginTop: 8 }}>
          导出使用素材原始分辨率与尺寸
        </div>
      </div>

      {/* ── 5. KV 元数据 ── */}
      <KVSection
        rows={[
          ['总片段', `${shotNodeIds.length}`],
          ['就绪片段', `${readyShots.length}/${shotNodeIds.length}`],
          ['音轨', audio.loudnessNormalize !== false ? '保留 + −14 LUFS' : '保留原始'],
          ['导出', `${(exportPreset.format ?? 'mp4-h264') === 'mp4-h264' ? 'FFmpeg · MP4 H.264+AAC' : 'FFmpeg · ProRes'}`],
        ]}
      />

      {/* ── 6. 动作 ── */}
      {exportNote && (
        <div className="notebox" role="status" style={{ fontSize: 11 }}>
          {exportNote}
        </div>
      )}
      <button
        className="btn btn-p"
        style={{ width: '100%', opacity: exporting ? 0.5 : 1 }}
        onClick={startExport}
        disabled={exporting}
      >
        {exporting ? '导出中…' : readyShots.length === 0 ? '导出 MP4(尚无产物)' : '导出 MP4'}
      </button>
      {onOpenTimelinePage && (
        <button
          className="btn btn-s btn-sm"
          style={{ width: '100%' }}
          onClick={onOpenTimelinePage}
        >
          打开时间线页面
        </button>
      )}
    </div>
  );
}

// 静音符号引用,避免 unused 警告
void outputUrlOf;
