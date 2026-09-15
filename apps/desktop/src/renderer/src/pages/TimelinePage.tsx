import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasSnapshot, ExportTask, RenderJob } from '@bigbotart/shared';

interface TimelinePageProps {
  onNavigate: (
    page:
      | 'home'
      | 'canvas'
      | 'assets'
      | 'skills'
      | 'timeline'
      | 'settings'
      | 'onboarding'
      | 'projects'
  ) => void;
}

/** 一个视频轨片段(含镜5 空位,入线后变成普通片段) */
interface VideoClip {
  key: string;
  flex: number;
  img: string;
  label: string;
  /** 片段角标,空位片段为 null */
  text: string | null;
  /** 是否占据播放头定位用的 slot5 空位 */
  isSlot5: boolean;
  filled: boolean;
  /** 真实产物(画布生成)文件路径;只给有真实产物的片段赋值 */
  path?: string;
  nodeId?: string;
  takeId?: string;
}

/** Take 池条目 */
interface Take {
  key: string;
  take: string;
  img: string;
  dur: string;
  /** 真实产物(画布生成)文件路径;演示 Take 无 */
  path?: string;
  nodeId?: string;
  takeId?: string;
}

const TAKES: Take[] = [
  { key: 't1', take: '镜3 · T1', img: './assets/env-valley.jpg', dur: '8s' },
  { key: 't2', take: '镜4 · T2', img: './assets/env-dusk.jpg', dur: '12s' },
  { key: 't3', take: '镜5 · T1', img: './assets/sb-river.jpg', dur: '8s' },
];

/** 入线后填进镜5 空位的音频波形(取自设计稿 timeline.js 的 innerHTML) */
const SLOT5_WAVE = [12, 20, 14, 22, 10, 18];

/** 音频轨片段(前 4 段)波形高度,元数据全部沿用设计稿 */
const AUDIO_CLIPS: { key: string; flex: number; wave: number[] }[] = [
  { key: 'a1', flex: 2, wave: [12, 20, 16, 24, 14, 20, 10, 18, 22, 12] },
  { key: 'a2', flex: 2.5, wave: [16, 22, 12, 18, 24, 14, 18, 10] },
  { key: 'a3', flex: 2, wave: [10, 18, 22, 12, 16, 20] },
  { key: 'a4', flex: 2, wave: [14, 20, 16, 22, 12, 16] },
];

const CONTINUITY: { flex: number; text: string; warn?: boolean }[] = [
  { flex: 2, text: '尾帧→镜2 首帧 ✓' },
  { flex: 2.5, text: '尾帧→镜3 首帧 ✓' },
  { flex: 2, text: '尾帧→镜4 · 建议重跑', warn: true },
  { flex: 2, text: '' },
  { flex: 1.5, text: '' },
];

const VIDEO_CLIPS: VideoClip[] = [
  {
    key: 'c1',
    flex: 2,
    img: './assets/shot-01.jpg',
    label: '片段 1/5 · 00:00 / 00:46',
    text: '镜1 · T3 · 8s',
    isSlot5: false,
    filled: true,
  },
  {
    key: 'c2',
    flex: 2.5,
    img: './assets/shot-02.jpg',
    label: '片段 2/5 · 00:08 / 00:46',
    text: '镜2 · T1 · 10s',
    isSlot5: false,
    filled: true,
  },
  {
    key: 'c3',
    flex: 2,
    img: './assets/env-valley.jpg',
    label: '片段 3/5 · 00:18 / 00:46',
    text: '镜3 · T1 · 8s',
    isSlot5: false,
    filled: true,
  },
  {
    key: 'c4',
    flex: 2,
    img: './assets/env-dusk.jpg',
    label: '片段 4/5 · 00:26 / 00:46',
    text: '镜4 · T2 · 12s',
    isSlot5: false,
    filled: true,
  },
  {
    key: 'c5',
    flex: 1.5,
    img: './assets/shot-01.jpg',
    label: '片段 5/5 · 00:38 / 00:46',
    text: null,
    isSlot5: true,
    filled: false,
  },
];

const TRANSITIONS: { kind: '叠化' | '硬切'; afterIndex: number }[] = [
  { kind: '叠化', afterIndex: 0 },
  { kind: '叠化', afterIndex: 1 },
  { kind: '硬切', afterIndex: 2 },
];

const FORMATS = ['MP4 · H.264+AAC', 'ProRes'];
const RESOLUTIONS = ['1920×1080', '1280×720'];
const PLATFORMS = ['9:16 竖屏', '1:1', '无字幕版'];

/** 播放头定位:把百分比转成设计稿用的 calc(% + px) 字符串 */
function playheadLeft(pct: number): string {
  const p = Math.max(0, Math.min(1, pct));
  return `calc(${(p * 100).toFixed(1)}% + ${(16 * (1 - p) - 16 * p).toFixed(1)}px)`;
}

/** 取文件 basename(导出产物 outputPath 展示用) */
function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function TransitionIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function Wave({ heights }: { heights: number[] }): React.ReactElement {
  return (
    <div className="wave">
      {heights.map((h, i) => (
        <i key={i} style={{ height: `${h}px` }} />
      ))}
    </div>
  );
}

export default function TimelinePage({ onNavigate }: TimelinePageProps): React.ReactElement {
  /* ── 监视器:当前选中片段 ── */
  const [monitorImg, setMonitorImg] = useState('./assets/shot-02.jpg');
  const [tcLabel, setTcLabel] = useState('片段 2/5 · 00:08 / 00:46');
  const [selKey, setSelKey] = useState('c2');

  /* ── 视频轨(镜5 空位可被 Take 池填充)── */
  const [clips, setClips] = useState<VideoClip[]>(VIDEO_CLIPS);
  const [slot5Audio, setSlot5Audio] = useState<number[] | null>(null);
  const [usedTake, setUsedTake] = useState<string | null>(null);

  /* ── 播放头 ── */
  const [playheadPct, setPlayheadPct] = useState(0.26);
  const draggingRef = useRef(false);

  /* ── 播放状态 ── */
  const [playing, setPlaying] = useState(false);

  /* ── 导出选项 ── */
  const [fmt, setFmt] = useState(FORMATS[0] ?? '');
  const [res, setRes] = useState(RESOLUTIONS[0] ?? '');
  const [plats, setPlats] = useState<string[]>([]);

  /* ── 导出进度(真实任务轮询)── */
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [finished, setFinished] = useState(false);
  /** 进度旁 mono 文本:运行中的 stage / 成功后产物文件名 */
  const [exportStage, setExportStage] = useState('');
  /** 提示/错误(复用现有 notebox 样式);null 表示不显示 */
  const [exportNote, setExportNote] = useState<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  /* ── 真实数据:当前项目(时间线/导出来源)── */
  const [project, setProject] = useState<{ id: string; name: string } | null>(null);
  /* ── Take 池:有真实产物时替换演示条目,否则保持设计稿 ── */
  const [poolTakes, setPoolTakes] = useState<Take[]>(TAKES);

  /* 片段选择 → 监视器 */
  const selectClip = useCallback((clip: VideoClip) => {
    setSelKey(clip.key);
    setMonitorImg(clip.img);
    setTcLabel(clip.label);
  }, []);

  /* Take 池 → 入线(填充镜5 空位),只生效一次 */
  const fillSlot5 = useCallback(
    (take: Take) => {
      if (usedTake) return;
      setUsedTake(take.key);
      setClips((prev) =>
        prev.map((c) =>
          c.isSlot5
            ? {
                ...c,
                filled: true,
                img: take.img,
                text: `${take.take} · ${take.dur}`,
                label: '片段 5/5 · 00:38 / 00:46',
                path: take.path,
                nodeId: take.nodeId,
                takeId: take.takeId,
              }
            : c,
        ),
      );
      setSlot5Audio(SLOT5_WAVE);
    },
    [usedTake],
  );

  /* 播放头拖动(点击标尺定位 + 按住拖动) */
  const seekFromEvent = useCallback((clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    setPlayheadPct(pct);
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const ruler = rulerRef.current;
      if (ruler) seekFromEvent(e.clientX, ruler);
    };
    const onUp = () => {
      draggingRef.current = false;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [seekFromEvent]);

  const rulerRef = useRef<HTMLDivElement | null>(null);

  /* 挂载:取第一个项目 → 画布真实产物 → 替换演示片段;无真实产物时保持设计稿演示 */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const projects = await window.bigbotart.listProjects();
        if (cancelled || projects.length === 0) return;
        const proj = projects[0];
        if (!proj) return;
        setProject({ id: proj.id, name: proj.name });
        const [jobs, snap] = await Promise.all([
          window.bigbotart.queueStatus(),
          window.bigbotart.loadCanvas(proj.id),
        ]);
        if (cancelled) return;
        const jobsList: RenderJob[] = jobs ?? [];
        const snapData: CanvasSnapshot = snap;
        const done = jobsList.filter((j) => j.status === 'succeeded' && !!j.resultPath);
        if (done.length === 0) return; // 没有真实产物:保持设计稿演示片段
        // 按 nodeId 关联画布 shot 节点标题
        const titleById = new Map<string, string>();
        for (const n of snapData.nodes) {
          if (n.kind === 'shot') titleById.set(n.id, n.label);
        }
        // 视频轨:按队列顺序把真实产物绑定到前 4 个片段槽位(镜5 空位留给 Take 池入线)
        setClips((prev) =>
          prev.map((c, i) => {
            const a = done[i];
            if (a && !c.isSlot5) {
              return { ...c, path: a.resultPath, nodeId: a.nodeId, takeId: a.takeId };
            }
            return c;
          }),
        );
        // Take 池:真实产物即"可入线的 Take"(画布 shot 节点标题命名),最多展示 6 条
        const realTakes: Take[] = done.slice(0, 6).map((j, i) => ({
          key: `real-${j.nodeId || j.id}`,
          take: `${titleById.get(j.nodeId) || `镜${i + 1}`} · ${
            j.takeId ? j.takeId.toUpperCase() : `T${i + 1}`
          }`,
          img: VIDEO_CLIPS[i % VIDEO_CLIPS.length]?.img ?? './assets/env-valley.jpg',
          dur: '8s',
          path: j.resultPath ?? '',
          nodeId: j.nodeId,
          takeId: j.takeId,
        }));
        setPoolTakes(realTakes);
      } catch {
        // IPC 不可用/无数据:静默回退演示,不打断页面
      }
    })();
    return () => {
      cancelled = true;
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  /* 真实进度:每 700ms 轮询 exportStatus,喂给 expBar/expPct;成功/失败收尾 */
  const pollExport = useCallback((taskId: string) => {
    const tick = async () => {
      try {
        const task: ExportTask = await window.bigbotart.exportStatus(taskId);
        if (task.status === 'running') {
          if (task.progress !== undefined) {
            setProgress(Math.max(0, Math.min(100, Math.round(task.progress))));
          }
          if (task.stage) setExportStage(task.stage);
          pollTimerRef.current = window.setTimeout(tick, 700);
        } else if (task.status === 'succeeded') {
          setProgress(100);
          setFinished(true);
          setExporting(false);
          setExportStage(task.outputPath ? basename(task.outputPath) : '');
        } else {
          setExporting(false);
          setExportStage('导出失败');
          setExportNote(`导出失败:${task.error ?? '未知错误'}`);
        }
      } catch (e) {
        setExporting(false);
        setExportStage('导出失败');
        setExportNote(`导出失败:${(e as Error).message}`);
      }
    };
    pollTimerRef.current = window.setTimeout(tick, 0);
  }, []);

  const startExport = useCallback(async () => {
    setExportNote(null);
    setExportStage('');
    // 只导出时间线上有真实产物的片段(按入线顺序)
    const real = clips.filter((c): c is VideoClip & { path: string } => !!c.path);
    if (!project || real.length === 0) {
      setExportNote('时间线还没有真实产物:先在画布生成镜头');
      return;
    }
    setFinished(false);
    setProgress(0);
    setExporting(true);
    try {
      const res = await window.bigbotart.exportTimeline({
        projectId: project.id,
        clips: real.map((c) => ({
          path: c.path,
          label: c.text ?? c.label,
          nodeId: c.nodeId,
          takeId: c.takeId,
        })),
        outputName: project.name || 'timeline',
      });
      if (!res.ok) {
        setExporting(false);
        setExportStage('导出失败');
        setExportNote(res.error ?? '导出失败');
        return;
      }
      if (!res.taskId) {
        setExporting(false);
        setExportStage('导出失败');
        setExportNote('导出失败:未返回任务 ID');
        return;
      }
      pollExport(res.taskId);
    } catch (e) {
      setExporting(false);
      setExportStage('导出失败');
      setExportNote(`导出失败:${(e as Error).message}`);
    }
  }, [project, clips, pollExport]);

  const pctText = finished ? '完成 · 已归档到项目' : `${Math.round(progress)}%`;
  const infoText = usedTake ? '5 片段 · 总时长 00:46 · 已齐' : '5 片段 · 总时长 00:46';
  const isSlot5Filled = clips.some((c) => c.isSlot5 && c.filled);

  let transCursor = 0;

  return (
    <div className="pg-timeline">
      <div className="app" data-od-id="timeline-app">
        <header className="topbar" data-od-id="tl-toolbar">
          <button className="btn btn-g btn-sm" onClick={() => onNavigate('canvas')}>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
            >
              <path d="m14 6-6 6 6 6" />
            </svg>
            草原之河 · 时间线
          </button>
          <span className="sep"></span>
          <span className="mut" style={{ fontSize: 'var(--text-xs)' }}>
            基本收尾:裁切 / 转场 / 响度统一 · 不替代专业 NLE
          </span>
          <span className="spacer"></span>
          <span className="mono mut" style={{ fontSize: '11px' }} id="tlInfo">
            {infoText}
          </span>
        </header>

        {/* 上:预览 + Take 池 + 导出 */}
        <div className="upper">
          <section className="preview-col" data-od-id="tl-preview">
            <div className="monitor">
              <img id="monitorImg" src={monitorImg} alt="节目监视器:当前片段画面" />
              <span className="tc mono" id="tcLabel">
                {tcLabel}
              </span>
              <span className="audio-tag mono">音轨:内嵌 · 已保留</span>
            </div>
            <div className="transport">
              <button className="ibtn" title="上一片段">
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 5h2v14H6Zm12 0v14L9.5 12Z" />
                </svg>
              </button>
              <button className="ibtn" title="播放" id="playBtn" onClick={() => setPlaying((p) => !p)}>
                <svg viewBox="0 0 24 24" fill="currentColor" id="playIco">
                  {playing ? (
                    <path d="M7 5h4v14H7Zm6 0h4v14h-4Z" />
                  ) : (
                    <path d="M8 5.5v13l11-6.5Z" />
                  )}
                </svg>
              </button>
              <button className="ibtn" title="下一片段">
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M16 5h2v14h-2ZM6 5v14l8.5-7Z" />
                </svg>
              </button>
            </div>
            <div className="pool" data-od-id="take-pool">
              <span className="lbl">Take 池 · 画布 Selected Take(点击入线)</span>
              <div className="pool-row">
                {poolTakes.map((t) => {
                  const consumed = usedTake === t.key;
                  return (
                    <div
                      key={t.key}
                      className="take"
                      data-take={t.take}
                      data-img={t.img}
                      data-dur={t.dur}
                      onClick={() => fillSlot5(t)}
                      style={
                        consumed ? { opacity: 0.4, pointerEvents: 'none' } : undefined
                      }
                    >
                      <img src={t.img} alt={`${t.take.replace(' · ', ' Take')} 缩略图`} />
                      <div className="tl">
                        <span>{t.take.replace(' · ', ' ')}</span>
                        <span className="mono mut">{t.dur}</span>
                      </div>
                    </div>
                  );
                })}
                <div className="take empty" onClick={() => onNavigate('canvas')}>
                  从画布拖入
                </div>
              </div>
            </div>
          </section>

          {/* 右:导出面板 */}
          <aside className="export" data-od-id="tl-export">
            <div className="export-in">
              <span className="lbl">导出(FFmpeg 本地执行)</span>
              <div>
                <span className="lbl">格式</span>
                <div className="optrow">
                  {FORMATS.map((f) => (
                    <span
                      key={f}
                      className={`chip${fmt === f ? ' on' : ''}`}
                      data-fmt={f}
                      onClick={() => setFmt(f)}
                    >
                      {f}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <span className="lbl">分辨率</span>
                <div className="optrow">
                  {RESOLUTIONS.map((r) => (
                    <span
                      key={r}
                      className={`chip${res === r ? ' on' : ''}`}
                      data-res={r}
                      onClick={() => setRes(r)}
                    >
                      {r}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <span className="lbl">音轨</span>
                <div className="notebox" style={{ marginTop: '6px' }}>
                  保留各 Take 内嵌音轨 · 响度统一 −14 LUFS
                </div>
              </div>
              <div>
                <span className="lbl">多平台版本(P2)</span>
                <div className="optrow">
                  {PLATFORMS.map((p) => (
                    <span
                      key={p}
                      className={`chip${plats.includes(p) ? ' on' : ''}`}
                      data-plat={p}
                      onClick={() =>
                        setPlats((prev) =>
                          prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
                        )
                      }
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </div>
              <button
                className="btn btn-p"
                style={{ width: '100%', opacity: exporting ? 0.5 : 1 }}
                id="exportBtn"
                data-od-id="export-btn"
                disabled={exporting}
                onClick={startExport}
              >
                {exporting ? '导出中…' : finished ? '再次导出 MP4' : '导出 MP4'}
              </button>
              {exportNote !== null && (
                <div className="notebox" role="status" style={{ marginTop: '4px' }}>
                  {exportNote}
                </div>
              )}
              <div id="exportProg" hidden={!exporting && !finished}>
                <div className="row" style={{ justifyContent: 'space-between', fontSize: '11px' }}>
                  <span className="mut">正在导出…</span>
                  <span className="mono mut" id="expPct">
                    {pctText}
                  </span>
                </div>
                {exportStage !== '' && (
                  <div className="mono mut" id="expStage" style={{ fontSize: '10px', marginTop: '2px' }}>
                    {exportStage}
                  </div>
                )}
                <div className="pbar" style={{ marginTop: '6px' }}>
                  <i id="expBar" style={{ width: `${finished ? 100 : progress}%` }} />
                </div>
              </div>
              <div className="notebox">导出记录随项目归档;参数可复现(同画布 Take)。</div>
            </div>
          </aside>
        </div>

        {/* 下:时间线轨道 */}
        <section className="tracks" data-od-id="tl-tracks">
          <div className="tl-head">
            <button className="btn btn-s btn-sm">裁切</button>
            <button className="btn btn-s btn-sm">转场</button>
            <button className="btn btn-s btn-sm">响度统一</button>
            <span className="spacer"></span>
            <span className="mono mut" style={{ fontSize: '11px' }}>
              00:00 ───── 00:46
            </span>
          </div>
          <div className="tl-body">
            <div
              className="playhead"
              id="playhead"
              style={{ left: playheadLeft(playheadPct) }}
            ></div>
            <div
              className="ruler"
              id="ruler"
              ref={rulerRef}
              onMouseDown={(e) => {
                draggingRef.current = true;
                seekFromEvent(e.clientX, e.currentTarget);
              }}
            >
              <span>0s</span>
              <span>10s</span>
              <span>20s</span>
              <span>30s</span>
              <span>46s</span>
            </div>
            <div className="trackrow">
              <span className="tname lbl">视频轨</span>
              <div className="track-lane" id="videoLane">
                {clips.map((c) => {
                  const isClip = c.text !== null;
                  const showTrans = isClip && transCursor < TRANSITIONS.length;
                  const trans = showTrans ? TRANSITIONS[transCursor++] : null;
                  return (
                    <React.Fragment key={c.key}>
                      <div
                        className={`clip${c.isSlot5 && !c.filled ? ' empty' : ''}${
                          c.key === selKey ? ' sel' : ''
                        }`}
                        style={{ flex: c.flex }}
                        data-img={c.img}
                        data-label={c.label}
                        id={c.isSlot5 ? 'slot5' : undefined}
                        onClick={() => selectClip(c)}
                      >
                        {isClip ? (
                          <>
                            <img src={c.img} alt={`${c.text ?? ''} 片段`} />
                            <span className="cl">{c.text}</span>
                          </>
                        ) : (
                          '镜5 · 待生成'
                        )}
                      </div>
                      {trans && (
                        <span className="trans" title={`转场:${trans.kind}`}>
                          <TransitionIcon />
                        </span>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
            <div className="trackrow">
              <span className="tname lbl">音频轨</span>
              <div className="track-lane audio" id="audioLane">
                {AUDIO_CLIPS.map((a) => (
                  <React.Fragment key={a.key}>
                    <div className="clip audio-clip" style={{ flex: a.flex }}>
                      <Wave heights={a.wave} />
                    </div>
                    <span style={{ width: '16px', flex: 'none' }}></span>
                  </React.Fragment>
                ))}
                <div
                  className={`clip${isSlot5Filled ? ' audio-clip' : ' empty'}`}
                  style={{ flex: 1.5 }}
                  id={isSlot5Filled ? undefined : 'slot5a'}
                >
                  {isSlot5Filled && slot5Audio ? (
                    <Wave heights={slot5Audio} />
                  ) : (
                    '—'
                  )}
                </div>
              </div>
            </div>
            <div className="cont-row">
              <span className="tname lbl">连续性</span>
              <div className="cont-lane">
                {CONTINUITY.map((c, i) => (
                  <span
                    key={i}
                    style={{
                      flex: c.flex,
                      ...(c.warn
                        ? { color: 'color-mix(in oklab,var(--warn) 60%,black)' }
                        : {}),
                    }}
                  >
                    {c.text}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
