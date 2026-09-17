/**
 * TimelinePage — 时间线 / 导出(React 版,按设计稿 timeline.html 1:1 实现)
 *
 * 数据源(真实):
 *  - 项目上下文(projectId / projectName,由 App 传入;缺省回退 listProjects()[0])
 *  - 画布 timeline 节点 data(TimelineData:shotNodeIds / picks / trim / transitions / audio / exportPreset)
 *  - 每个入线 shot 的 Takes(takesHistory:成功且有产物的 Take → 片段)
 *  - 导出走 exportTimeline(sequence/transitions/audio/exportPreset)+ exportStatus 轮询
 *
 * 交互(全照设计稿):
 *  - 监视器:选片段换图、点击画面弹走带、播放头 rAF 推进、上一段/播放/下一段
 *  - 标尺:点击/拖动 scrub;缩放(像素/秒),标尺 tick 跟随
 *  - 裁切:片段入/出点手柄拖拽、裁切面板(in/out/reset)
 *  - 转场:片段间标记(硬切/叠化/黑场)、转场面板(chips + ms)
 *  - Take 拖放:take-strip 拖到对应镜头槽换片 / 拖到空槽补位 / 点击补第一个空槽
 *  - 片段拖放:改序(重排 shotNodeIds)
 *  - 导出面板:悬浮右上、可收起(默认收起,localStorage 记忆)、格式/分辨率/多平台 chips、进度条
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ExportTask,
  TimelineAudio,
  TimelineData,
  TimelineTransition,
} from '@bigbotart/shared';
import { outputUrlOf } from './canvas/media';

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
      | 'projects',
  ) => void;
  /** 当前项目(可选;缺省回退 listProjects()[0]) */
  projectId?: string | null;
  projectName?: string | null;
}

/** 一个镜头槽(与设计稿 model.shots 对齐) */
interface ShotSlot {
  id: string; // 画布 shot 节点 id(s1/s2/… 只是演示;真实为节点 id)
  shot: string; // 显示名:镜N 或节点 label
  take: string | null; // 当前 Take 号(T2 / T1 / null=未就绪)
  file: string | null; // 片段封面(真实产物 URL 或演示素材)
  resultPath?: string; // 真实产物文件路径(导出用;bba URL 的反解)
  dur: number; // 整段时长(秒)
  in: number;
  out: number;
  vol: number;
  ready: boolean;
  takeId?: string; // 真实 Take id(导出用)
}

interface TransRow {
  after: number;
  kind: 'cut' | 'crossfade' | 'fade-black';
  ms: number;
}

/** 导出预设(与 TimelineExportPreset 对应的小写键) */
interface Preset {
  fmt: 'mp4-h264' | 'prores';
  res: '1920x1080' | '1280x720' | 'source';
  platforms: string[];
}

/* 演示素材(无真实产物时的兜底封面;与设计稿同源) */
const DEMO_FILES = [
  './assets/shot-01.jpg',
  './assets/shot-02.jpg',
  './assets/env-valley.jpg',
  './assets/env-dusk.jpg',
  './assets/sb-river.jpg',
];

/* 设计稿常量 */
const LEFT = 12;
const RIGHT = 14;
const TW = 20; // 转场间隙宽度

function fmt(sec: number): string {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}

/** 封面 src:真实产物优先(bba-output://),否则演示素材,再否则 null */
function coverSrc(file: string | null | undefined, idx: number): string | null {
  if (file) return file.startsWith('bba-') || file.startsWith('http') ? file : file;
  return DEMO_FILES[idx % DEMO_FILES.length] ?? null;
}

/** 产物 URL 是否为视频(决定 clip/monitor 用 <video> 还是 <img>) */
function isVideoSrc(src: string | null | undefined): boolean {
  if (!src) return false;
  return /\.(mp4|mov|webm|m4v)$/i.test(src);
}

/** 波形(与设计稿 waveH 一致) */
function waveBars(seed: number, k: number): number {
  return 7 + Math.round(15 * Math.abs(Math.sin(seed * 3.7 + k * 1.71)));
}

export default function TimelinePage({
  onNavigate,
  projectId,
  projectName,
}: TimelinePageProps): React.ReactElement {
  /* ── 项目 / 数据 ── */
  const [proj, setProj] = useState<{ id: string; name: string } | null>(
    projectId && projectName ? { id: projectId, name: projectName } : null,
  );
  /** 画布 timeline 节点 data(导出时用) */
  const [tlData, setTlData] = useState<TimelineData | null>(null);

  /* ── 工作台状态 ── */
  const [shots, setShots] = useState<ShotSlot[]>([]);
  const [transitions, setTransitions] = useState<TransRow[]>([]);
  const [loudnorm, setLoudnorm] = useState(true);
  const [preset, setPreset] = useState<Preset>({
    fmt: 'mp4-h264',
    res: '1920x1080',
    platforms: [],
  });
  const [pps, setPps] = useState(20); // 像素/秒
  const [SEL, setSEL] = useState(0);
  const [curT, setCurT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [transportShow, setTransportShow] = useState(false);
  const [panel, setPanel] = useState<'trim' | 'trans' | null>(null);
  const [panelPos, setPanelPos] = useState({ x: 0, y: 0 });

  /* ── 导出状态(真实任务轮询) ── */
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [finished, setFinished] = useState(false);
  const [exportStage, setExportStage] = useState('');
  const [exportNote, setExportNote] = useState<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  /* ── 导出面板收起(默认收起,localStorage 记忆) ── */
  const [expOpen, setExpOpen] = useState(() => {
    try {
      return localStorage.getItem('tl:export:open') === '1';
    } catch {
      return false;
    }
  });
  const toggleExport = useCallback((v: boolean) => {
    setExpOpen(v);
    try {
      localStorage.setItem('tl:export:open', v ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);

  /* ── 几何(与设计稿 computeGeo 一致) ── */
  const geo = useMemo(() => {
    const xs: number[] = [];
    const starts: number[] = [];
    let x = LEFT;
    let t = 0;
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i]!;
      xs.push(x);
      starts.push(t);
      const d = Math.max(0.5, Math.round(((s.out ?? s.dur) - (s.in || 0)) * 10) / 10);
      x += d * pps;
      t += d;
      if (i < shots.length - 1) x += TW;
    }
    return { xs, starts, total: t, width: x + RIGHT };
  }, [shots, pps]);

  const shotDur = useCallback(
    (s: ShotSlot) => Math.max(0.5, Math.round(((s.out ?? s.dur) - (s.in || 0)) * 10) / 10),
    [],
  );
  const xAt = useCallback(
    (t: number) => {
      if (shots.length === 0) return LEFT;
      t = Math.max(0, Math.min(t, geo.total));
      for (let i = 0; i < shots.length; i++) {
        const d = shotDur(shots[i]!);
        if (t <= geo.starts[i]! + d) return geo.xs[i]! + (t - geo.starts[i]!) * pps;
      }
      const last = shots.length - 1;
      return geo.xs[last]! + shotDur(shots[last]!) * pps;
    },
    [geo, shots, pps, shotDur],
  );
  const idxAtT = useCallback(
    (t: number) => {
      if (shots.length === 0) return 0;
      for (let i = 0; i < shots.length; i++) {
        const d = shotDur(shots[i]!);
        if (t >= geo.starts[i]! - 0.001 && t < geo.starts[i]! + d - 0.001) return i;
      }
      return Math.max(0, shots.length - 1);
    },
    [geo, shots, shotDur],
  );

  /* ── 数据加载:项目 → timeline 节点 → takes ── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let pid = proj?.id;
        let pname = proj?.name;
        if (!pid) {
          const projects = await window.bigbotart.listProjects();
          if (cancelled || projects.length === 0) return;
          pid = projects[0]!.id;
          pname = projects[0]!.name;
        }
        if (!pid) return;
        if (!pname) {
          const p = (await window.bigbotart.listProjects()).find((x) => x.id === pid);
          pname = p?.name ?? '项目';
        }
        if (!cancelled) setProj({ id: pid, name: pname ?? '项目' });

        const canvases = await window.bigbotart.loadProjectCanvases(pid);
        if (cancelled) return;
        const allNodes: Array<{ id: string; kind: string; label: string; data?: unknown }> = [];
        for (const c of canvases.canvases) allNodes.push(...c.nodes);
        const titleById = new Map<string, string>();
        const shotKinds = new Set<string>();
        for (const n of allNodes) {
          if (n.kind === 'shot') {
            titleById.set(n.id, n.label);
            shotKinds.add(n.id);
          }
        }
        const tlNode = allNodes.find((n) => n.kind === 'timeline');
        const data = tlNode?.data as TimelineData | undefined;
        let shotIds = data?.shotNodeIds ?? [];
        const picks = data?.picks ?? {};
        const trim = data?.trim ?? {};
        const tlTrans = data?.transitions ?? [];
        const tlAudio: TimelineAudio = data?.audio ?? {};
        const tlPreset = data?.exportPreset;

        // 无入线:空态(等价设计稿 shots=[] → 引导)
        if (shotIds.length === 0) {
          if (!cancelled) setShots([]);
          return;
        }

        // 逐个 shot 拉 Takes,取成功且有产物的
        const resolved: Array<{
          id: string;
          take: { id: string; resultPath: string; durationSec?: number };
        }> = [];
        const demoIdx: string[] = [];
        for (const sid of shotIds) {
          try {
            const h = await window.bigbotart.takesHistory(pid, sid);
            const ok = h.takes.filter(
              (t) => t.status === 'succeeded' && !!t.resultPath,
            );
            const pick = picks[sid];
            const cur =
              (pick ? ok.find((t) => t.id === pick) : ok[0]) ?? null;
            if (cur?.resultPath) {
              resolved.push({
                id: sid,
                take: {
                  id: cur.id,
                  resultPath: cur.resultPath,
                  durationSec: cur.durationSec,
                },
              });
            } else {
              demoIdx.push(sid);
            }
          } catch {
            demoIdx.push(sid);
          }
        }
        if (cancelled) return;

        // 组装 ShotSlot
        const slots: ShotSlot[] = shotIds.map((sid, i) => {
          const r = resolved.find((x) => x.id === sid);
          const tr = trim[sid];
          const dur = Math.max(
            0.5,
            r?.take.durationSec && r.take.durationSec > 0
              ? r.take.durationSec
              : 8,
          );
          return {
            id: sid,
            shot: titleById.get(sid) ?? `镜${i + 1}`,
            take: r ? `T${resolved.findIndex((x) => x.id === sid) + 1}` : null,
            file: r ? outputUrlOf(r.take.resultPath) : null,
            resultPath: r?.take.resultPath ?? undefined,
            dur,
            in: tr?.inSec ?? 0,
            out: tr?.outSec && tr.outSec > 0 ? tr.outSec : dur,
            vol: tlAudio.perClipVolume?.[sid] ?? 1,
            ready: !!r,
            takeId: r?.take.id,
          };
        });

        // 转场:从 data 映射(长度 = shotNodeIds-1),缺省整段 cut
        const trs: TransRow[] = [];
        for (let i = 0; i < Math.max(0, shotIds.length - 1); i++) {
          const t = tlTrans[i] ?? { afterIndex: i, kind: 'cut' as const };
          trs.push({
            after: i,
            kind: t.kind,
            ms: t.durationMs ?? 500,
          });
        }

        if (!cancelled) {
          setShots(slots);
          setTransitions(trs);
          setLoudnorm(tlAudio.loudnessNormalize !== false);
          if (tlPreset) {
            setPreset({
              fmt: (tlPreset.format as Preset['fmt']) ?? 'mp4-h264',
              res: (tlPreset.resolution as Preset['res']) ?? '1920x1080',
              platforms: [...(tlPreset.platforms ?? [])],
            });
          }
          setTlData(data ?? null);
        }
      } catch {
        // IPC 不可用/无数据:静默保留空态
      }
    })();
    return () => {
      cancelled = true;
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  /* ── 选择 ── */
  const selectClip = useCallback(
    (i: number) => {
      if (shots.length === 0) return;
      const n = Math.max(0, Math.min(shots.length - 1, i));
      setSEL(n);
      setCurT(geo.starts[n]!);
      setPlaying(false);
    },
    [shots.length, geo],
  );

  /* ── 播放走带(真实视频驱动;演示素材退化虚拟 rAF) ── */
  const rafRef = useRef(0);
  const lastTsRef = useRef(0);
  const playingRef = useRef(false);
  const curIdxRef = useRef(0);
  curIdxRef.current = idxAtT(curT);

  /** 播放时从视频真实进度同步 curT(播放头跟随画面) */
  const syncFromVideo = useCallback((v: HTMLVideoElement) => {
    const idx = curIdxRef.current;
    const s = shots[idx];
    if (!s || !Number.isFinite(v.duration)) return;
    const local = v.currentTime - (s.in || 0);
    setCurT(Math.max(0, Math.min(geo.total, geo.starts[idx]! + Math.max(0, local))));
  }, [shots, geo]);

  /** 前进到下一片段并继续播放(真实衔接;图片片段用虚拟推进) */
  const advance = useCallback(() => {
    const next = curIdxRef.current + 1;
    const sNext = shots[next];
    if (!sNext) {
      // 播完:停在末尾
      setCurT(geo.total);
      setPlaying(false);
      return;
    }
    curIdxRef.current = next;
    setSEL(next);
    const v = monitorVideoRef.current;
    if (sNext.ready && sNext.file && isVideoSrc(sNext.file) && v) {
      // 真实视频:换 src 从本段入点继续播
      v.src = sNext.file;
      v.currentTime = sNext.in || 0;
      v.play().catch(() => {});
      setCurT(geo.starts[next]! + (sNext.in || 0));
    } else {
      // 图形片段:播放头跳到下一段起点,续播逻辑由 rAF 接管
      setCurT(geo.starts[next]!);
    }
  }, [shots, geo]);

  /* 播放主循环:
     - 当前片段是真实视频 → 由 video.currentTime 驱动(curT 每帧同步,画面与时间轴一致)
     - 图片/演示片段 → 虚拟时间推进,触到片段末尾前进 */
  useEffect(() => {
    playingRef.current = playing;
    if (!playing) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      return;
    }
    // 起点:若有真实视频,从未播状态从当前片段入点开始(避免重复设 src 重载)
    const s0 = shots[curIdxRef.current];
    const v0 = monitorVideoRef.current;
    if (s0?.ready && s0.file && isVideoSrc(s0.file) && v0) {
      const want = s0.file;
      if (v0.src !== want && v0.getAttribute('src') !== want) {
        v0.src = want;
        v0.load();
      }
      if (v0.paused) {
        v0.currentTime = s0.in || 0;
        v0.play().catch(() => {});
      }
    }
    lastTsRef.current = 0;
    const tick = (ts: number) => {
      if (!playingRef.current) return;
      const v = monitorVideoRef.current;
      const s = shots[curIdxRef.current];
      // 真实视频正在播 → 同步时间轴
      if (v && !v.paused && v.readyState >= 1 && s?.ready && s.file && isVideoSrc(s.file)) {
        syncFromVideo(v);
        // 到达本段出点/末尾 → 前进
        const localEnd = s.out > 0 && s.out <= s.dur ? s.out : s.dur;
        if (v.currentTime >= localEnd - 0.02) {
          advance();
        }
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      // 图片片段:虚拟推进
      if (!lastTsRef.current) lastTsRef.current = ts;
      const dt = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      setCurT((prev) => {
        const next = prev + dt;
        const sCur = shots[curIdxRef.current];
        const segEnd = sCur ? geo.starts[curIdxRef.current]! + (sCur.out > 0 ? sCur.out : sCur.dur) : geo.total;
        if (sCur && next >= segEnd - 0.02) {
          advance();
          return geo.starts[Math.min(curIdxRef.current + 1, shots.length - 1)]!;
        }
        if (next >= geo.total) {
          setPlaying(false);
          return geo.total;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, shots, geo, advance, syncFromVideo]);

  const pause = useCallback(() => {
    setPlaying(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    const v = monitorVideoRef.current;
    if (v && !v.paused) v.pause();
  }, []);

  /* 播放时当前片段跟随 */
  const curIdx = idxAtT(curT);
  const curShot = shots[curIdx] ?? shots[SEL] ?? null;

  /* 监视器视频元素(真实产物播放用) */
  const monitorVideoRef = useRef<HTMLVideoElement | null>(null);
  // 视频媒体事件:切换片段后 src 变化 → 重开播放;播完自然前进
  useEffect(() => {
    const v = monitorVideoRef.current;
    if (!v) return;
    const onLoaded = () => {
      // 播放中且 src 刚换 → 从入点继续
      if (playingRef.current) {
        const s = shots[curIdxRef.current];
        if (s) {
          v.currentTime = s.in || 0;
          v.play().catch(() => {});
        }
      }
    };
    const onEnded = () => {
      if (playingRef.current) advance();
    };
    v.addEventListener('loadedmetadata', onLoaded);
    v.addEventListener('ended', onEnded);
    return () => {
      v.removeEventListener('loadedmetadata', onLoaded);
      v.removeEventListener('ended', onEnded);
    };
  }, [shots, advance]);

  /* ── 走带弹窗 ── */
  const transportTimer = useRef<number | null>(null);
  const showTransport = useCallback(() => {
    if (transportTimer.current) window.clearTimeout(transportTimer.current);
    setTransportShow(true);
    transportTimer.current = window.setTimeout(() => setTransportShow(false), 4000);
  }, []);
  const hideTransport = useCallback(() => {
    setTransportShow(false);
    if (transportTimer.current) window.clearTimeout(transportTimer.current);
    transportTimer.current = null;
  }, []);

  /* ── 标尺 scrub ── */
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrubbingRef = useRef(false);
  const scrub = useCallback(
    (clientX: number) => {
      const r = rulerRef.current;
      if (!r) return;
      const rect = r.getBoundingClientRect();
      const scrollX = scrollRef.current?.scrollLeft ?? 0;
      const x = clientX - rect.left + scrollX;
      const t = Math.max(0, Math.min(geo.total, (x - LEFT) / pps));
      setCurT(t);
      // 播放中:把真实视频 seek 到对应片段位置(保持画面与播放头同步)
      const v = monitorVideoRef.current;
      const idx = idxAtT(t);
      const s = shots[idx];
      if (playingRef.current && v && s?.ready && s.file && isVideoSrc(s.file) && v.readyState >= 1) {
        curIdxRef.current = idx;
        try {
          v.currentTime = s.in + Math.max(0, t - geo.starts[idx]!);
        } catch {
          /* 未就绪忽略 */
        }
      }
    },
    [geo.total, pps, shots, geo],
  );

  /* ── 裁切手柄拖拽 ── */
  const trimDragRef = useRef<{
    edge: 'in' | 'out';
    px0: number;
    in0: number;
    out0: number;
    dur: number;
  } | null>(null);

  /* ── 导出轮询 ── */
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
          setExportStage(task.outputPath ? task.outputPath.split(/[\\/]/).pop() ?? '' : '');
          // 成片已产出:回写画布 timeline 节点 data.lastExport(节点体内嵌预览用)
          if (task.outputPath && projRef.current) {
            recordExportToCanvas(task.outputPath);
          }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 导出成片路径 → 写回画布 timeline 节点 data.lastExport(bba-output:// 可预览) */
  const projRef = useRef(proj);
  projRef.current = proj;
  const recordExportToCanvas = useCallback(async (outputPath: string) => {
    const pid = projRef.current?.id;
    if (!pid) return;
    try {
      const pc = await window.bigbotart.loadProjectCanvases(pid);
      const canvases = pc.canvases ?? [];
      let hit = false;
      const next = canvases.map((c) => {
        if (hit) return c;
        const nodes = c.nodes.map((n) => {
          if (n.kind === 'timeline') {
            hit = true;
            return {
              ...n,
              data: {
                ...(n.data ?? {}),
                lastExport: {
                  path: outputUrlOf(outputPath),
                  name: outputPath.split(/[\\/]/).pop() ?? outputPath,
                  format: presetRef.current.fmt,
                  resolution: 'source',
                  createdAt: new Date().toISOString(),
                },
              },
            };
          }
          return n;
        });
        return { ...c, nodes };
      });
      if (!hit) return;
      for (const c of next) {
        await window.bigbotart.saveCanvasSnapshot(c);
      }
    } catch {
      /* 写回失败不阻断(下次导出再试) */
    }
  }, []);

  const presetRef = useRef(preset);
  presetRef.current = preset;

  const startExport = useCallback(async () => {
    setExportNote(null);
    setExportStage('');
    if (!proj) {
      setExportNote('未关联项目,无法导出');
      return;
    }
    // 就绪片段(时序优先)
    const readyShots = shots.filter((s) => s.ready && !!s.file);
    if (readyShots.length === 0) {
      setExportNote('时间线还没有真实产物:先在画布生成镜头');
      return;
    }
    setFinished(false);
    setProgress(0);
    setExporting(true);
    try {
      // 编排路径:sequence + transitions + audio + exportPreset
      const sequence = shots
        .filter((s) => s.ready && s.takeId)
        .map((s) => {
          const item: {
            shotNodeId: string;
            takeId?: string;
            trim?: { inSec: number; outSec: number };
            volume?: number;
          } = { shotNodeId: s.id };
          if (s.takeId) item.takeId = s.takeId;
          if (s.in > 0 || s.out < s.dur) item.trim = { inSec: s.in, outSec: s.out };
          if (s.vol !== 1) item.volume = s.vol;
          return item;
        });
      const transitionsArr: TimelineTransition[] = transitions.map((t, i) => ({
        afterIndex: i,
        kind: t.kind,
        durationMs: t.kind === 'cut' ? undefined : t.ms,
      }));
      const audioOpt: TimelineAudio | undefined = { loudnessNormalize: loudnorm };
      const res = await window.bigbotart.exportTimeline({
        projectId: proj.id,
        clips: readyShots.map((s) => ({
          path: s.resultPath ?? '',
          label: `${s.shot} · ${s.take ?? ''}`,
          nodeId: s.id,
          takeId: s.takeId,
        })),
        sequence,
        transitions: transitionsArr,
        audio: audioOpt,
        // 分辨率/多平台固定:完全用素材原始分辨率和尺寸
        exportPreset: {
          format: preset.fmt,
          resolution: 'source',
          platforms: [],
        },
        outputName: proj.name || 'timeline',
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
  }, [proj, shots, transitions, loudnorm, preset, pollExport]);

  /* ── 全局指针:裁切拖拽 ── */
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = trimDragRef.current;
      if (!d || shots.length === 0) return;
      const s = shots[SEL];
      if (!s) return;
      const dx = (e.clientX - d.px0) / pps;
      setShots((prev) => {
        const cur = prev[SEL];
        if (!cur) return prev;
        let nin = cur.in;
        let nout = cur.out;
        if (d.edge === 'in') {
          nin = Math.max(0, Math.min(d.in0 + dx, d.out0 - 0.5));
        } else {
          nout = Math.min(d.dur, Math.max(d.in0 + 0.5, d.out0 + dx));
        }
        return prev.map((x, i) =>
          i === SEL ? { ...x, in: Math.round(nin * 10) / 10, out: Math.round(nout * 10) / 10 } : x,
        );
      });
    };
    const onUp = () => {
      trimDragRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [pps, shots.length, SEL]);

  /* ── 面板定位(popover 锚定按钮) ── */
  const openPanel = useCallback((id: 'trim' | 'trans', anchor?: HTMLElement | null) => {
    setPanel(id);
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      const x = Math.max(8, Math.min(r.left, window.innerWidth - 340));
      let top = r.bottom + 6;
      if (top + 140 > window.innerHeight - 8) top = r.top - 140 - 10;
      setPanelPos({ x, y: Math.max(8, top) });
    }
  }, []);
  const closePanel = useCallback(() => setPanel(null), []);

  const updateSelInfo = (s: ShotSlot | null, idx: number): string => {
    if (!s) return '—';
    return s.ready
      ? `${s.shot} · ${s.take} · 入 ${s.in.toFixed(1)}s → 出 ${s.out.toFixed(1)}s · 音量 ×${s.vol.toFixed(1)}`
      : `${s.shot} · 待生成 · 请在画布生成成功 Take`;
  };

  /** 视频 metadata 兜底:历史 Take 的 durationSec 可能是生成耗时(错误),加载产物后用真实时长纠正 */
  const syncVideoDur = useCallback((shotId: string, sec: number) => {
    if (!Number.isFinite(sec) || sec <= 0.1) return;
    setShots((prev) =>
      prev.map((s) => {
        if (s.id !== shotId) return s;
        const dur = Math.max(0.5, Math.round(sec * 10) / 10);
        // 只在实际时长明显不同时纠正(±0.3s 内不动,避免无谓重渲染)
        if (Math.abs(s.dur - dur) < 0.3) return s;
        return {
          ...s,
          dur,
          in: Math.min(s.in, dur),
          out: s.out > dur || s.out <= 0 ? dur : s.out,
        };
      }),
    );
  }, []);

  /* ── 渲染轨道 ── */
  const rulerTicks = useMemo(() => {
    const major = pps < 14 ? 10 : 5;
    const out: Array<{ x: number; t: number; maj: boolean; clamp: boolean }> = [];
    for (let t = 0; t <= geo.total + 0.001; t += 1) {
      const x = xAt(Math.min(t, geo.total));
      out.push({
        x,
        t,
        maj: t % major === 0,
        clamp: x > geo.width - 26,
      });
    }
    return out;
  }, [geo, pps, xAt]);

  const emptyShots = shots.length === 0;
  const readyCount = shots.filter((s) => s.ready).length;
  const totalInfo = `${shots.length} 片段 · 就绪 ${readyCount} · 总时长 ${fmt(geo.total)}`;
  const selInfo = updateSelInfo(curShot, curIdx);

  /* ── Take 池(设计稿 take-strip 数据:与 shots 派生,补位用) ── */
  const poolTakes = useMemo(() => {
    // 展示每个「有其他可用 Take」的镜头 + 演示空位
    // 真实项目里每 shot 只有当前 take 有产物时,池子展示其缩略图(可拖到空槽补位由 ready 过滤)
    return shots
      .filter((s) => s.ready)
      .map((s, i) => ({
        key: s.id,
        shotNum: i + 1,
        label: `${s.shot}·${s.take}`,
        dur: s.dur,
        file: coverSrc(s.file, i),
      }));
  }, [shots]);

  return (
    <div className="pg-timeline">
      <div className="app" data-od-id="timeline-app">
        <header className="topbar" data-od-id="tl-toolbar">
          <button
            className="btn btn-g btn-sm"
            data-od-id="tl-back"
            onClick={() => onNavigate('canvas')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
              <path d="m14 6-6 6 6 6" />
            </svg>
            <span>{proj?.name ? `${proj.name} · 时间线` : '时间线'}</span>
          </button>
          <span className="sep"></span>
          <span className="mut" style={{ fontSize: 'var(--text-xs)' }}>
            基本收尾 · 不替代专业 NLE
          </span>
          <span className="spacer"></span>
          <span className="mono mut" style={{ fontSize: 11 }} id="tlInfo">
            {emptyShots ? '—' : totalInfo}
          </span>
        </header>

        <main className="main">
          {/* ── 上:监视器 / 走带 | 导出 ── */}
          <section className="upper panel" data-od-id="tl-upper">
            <div className="preview-col">
              <div
                className={`monitor${playing ? ' playing' : ''}`}
                data-od-id="tl-monitor"
                onClick={() => {
                  if (playing) {
                    pause();
                    return;
                  }
                  showTransport();
                }}
              >
                {curShot?.ready && curShot.file ? (
                  isVideoSrc(curShot.file) ? (
                    <video
                      key={`v-${curShot.id}`}
                      ref={monitorVideoRef}
                      id="monitorVid"
                      className="flash-in"
                      src={curShot.file}
                      muted
                      loop
                      playsInline
                      preload="metadata"
                      onLoadedMetadata={(e) => {
                        const v = e.currentTarget;
                        if (v.duration && Number.isFinite(v.duration)) syncVideoDur(curShot.id, v.duration);
                      }}
                      style={{
                        maxWidth: 'calc(100% - 16px)',
                        maxHeight: 'calc(100% - 20px)',
                        width: 'auto',
                        height: 'auto',
                        objectFit: 'contain',
                        display: 'block',
                        background: '#000',
                      }}
                    />
                  ) : (
                    <img
                      key={`i-${curShot.id}`}
                      id="monitorImg"
                      className="flash-in"
                      src={curShot.file}
                      alt="节目监视器:当前片段画面"
                      style={{ display: 'block' }}
                    />
                  )
                ) : (
                  <div className="ph" id="monitorPh">
                    {curShot ? `${curShot.shot} 尚无成功 Take` : '时间线还没内容'}
                    <small>
                      {curShot
                        ? '请在画布为该镜头生成并选中 Take'
                        : '先在画布生成镜头并连线入线'}
                    </small>
                  </div>
                )}
                <span className="tc mono" id="tcLabel">
                  {curShot
                    ? `${curShot.shot}${curShot.ready ? ` · ${curShot.take}` : ' · 待生成'} · ${fmt(geo.starts[curIdx] ?? 0)} / ${fmt(geo.total)}`
                    : '—'}
                </span>
                <span className="audio-tag mono" id="audioTag">
                  音轨 · {curShot?.ready ? `内嵌${curShot.vol !== 1 ? ` · ×${curShot.vol}` : ''}` : '—'}
                </span>
                <button
                  className="play-center"
                  id="playCenter"
                  title="点击展开走带控制"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (playing) pause();
                    else if (curT >= geo.total - 0.05) {
                      setCurT(0);
                      setPlaying(true);
                    } else setPlaying(true);
                    showTransport();
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" id="playCenterIco">
                    <path d={playing ? 'M7 5h4v14H7Zm6 0h4v14h-4Z' : 'M8 5.5v13l11-6.5Z'} />
                  </svg>
                </button>
                <div className={`transport${transportShow ? ' show' : ''}`} data-od-id="tl-transport">
                  <button
                    className="ibtn"
                    title="上一片段"
                    onClick={(e) => {
                      e.stopPropagation();
                      selectClip(curIdx - 1);
                      hideTransport();
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M6 5h2v14H6Zm12 0v14L9.5 12Z" />
                    </svg>
                  </button>
                  <button
                    className="ibtn main"
                    title="播放 / 暂停"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (playing) pause();
                      else {
                        if (curT >= geo.total - 0.05) setCurT(0);
                        setPlaying(true);
                      }
                      hideTransport();
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor" id="playIco">
                      <path d={playing ? 'M7 5h4v14H7Zm6 0h4v14h-4Z' : 'M8 5.5v13l11-6.5Z'} />
                    </svg>
                  </button>
                  <button
                    className="ibtn"
                    title="下一片段"
                    onClick={(e) => {
                      e.stopPropagation();
                      selectClip(curIdx + 1);
                      hideTransport();
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M16 5h2v14h-2ZM6 5v14l8.5-7Z" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            {/* 导出悬浮面板 */}
            <aside className={`export${expOpen ? '' : ' collapsed'}`} id="tlExport" data-od-id="tl-export">
              <div className="panel exp-card">
                <div className="exp-head">
                  <span className="lbl">导出 · FFmpeg 本地执行</span>
                  <button
                    className="exp-fold"
                    title="收起导出面板"
                    onClick={() => toggleExport(false)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="m9 5 7 7-7 7" />
                    </svg>
                  </button>
                </div>
                <div className="export-in">
                  <div>
                    <span className="lbl">格式</span>
                    <div className="optrow">
                      {(['mp4-h264', 'prores'] as const).map((f) => (
                        <span
                          key={f}
                          className={`chip${preset.fmt === f ? ' on' : ''}`}
                          data-fmt={f}
                          onClick={() => setPreset((p) => ({ ...p, fmt: f }))}
                        >
                          {f === 'mp4-h264' ? 'MP4 · H.264+AAC' : 'ProRes 422'}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="lbl">音轨</span>
                    <div className="notebox" style={{ marginTop: 6 }} id="audioNote">
                      {loudnorm
                        ? '保留各 Take 内嵌音轨 · 响度统一 −14 LUFS(开)'
                        : '保留各 Take 内嵌音轨 · 响度统一 关(按原音量)'}
                    </div>
                  </div>
                  {/* 分辨率 / 多平台版本:已隐藏,导出完全用素材原始分辨率和尺寸 */}
                  <div className="notebox" style={{ fontSize: 11 }}>
                    导出使用素材原始分辨率与尺寸
                  </div>
                  <button
                    className="btn btn-p"
                    style={{ width: '100%', opacity: exporting || !proj ? 0.5 : 1 }}
                    id="exportBtn"
                    data-od-id="export-btn"
                    disabled={exporting || !proj}
                    onClick={startExport}
                  >
                    {exporting
                      ? '导出中…'
                      : finished
                        ? `再次导出 ${preset.fmt === 'prores' ? 'ProRes' : 'MP4'}`
                        : `导出 ${preset.fmt === 'prores' ? 'ProRes' : 'MP4'}`}
                  </button>
                  <div id="exportProg" hidden={!exporting && !finished}>
                    <div className="row" style={{ justifyContent: 'space-between', fontSize: 11 }}>
                      <span className="mut" id="expStage">
                        {exporting ? exportStage || '正在导出…' : '完成'}
                      </span>
                      <span className="mono mut" id="expPct">
                        {finished ? '100%' : `${Math.round(progress)}%`}
                      </span>
                    </div>
                    <div className="pbar" style={{ marginTop: 5 }}>
                      <i id="expBar" style={{ width: `${finished ? 100 : progress}%` }}></i>
                    </div>
                    {exportStage && (
                      <div className="mono mut" style={{ fontSize: 10, marginTop: 2 }}>
                        {exportStage}
                      </div>
                    )}
                  </div>
                  {exportNote && (
                    <div className="notebox" role="status" style={{ fontSize: 11 }}>
                      {exportNote}
                    </div>
                  )}
                  <div className="notebox" style={{ fontSize: 11 }}>
                    导出记录随项目归档 · 参数可复现(同画布 Take)
                  </div>
                </div>
              </div>
              <button
                className="exp-fab"
                id="expFab"
                data-od-id="export-fab"
                title="展开导出面板"
                onClick={() => toggleExport(true)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 15V4" />
                  <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
                  <path d="M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15" />
                </svg>
                导出
              </button>
            </aside>
          </section>

          {/* ── 下:剪辑工作台 ── */}
          <section className="tracks panel" data-od-id="tl-tracks">
            <div className="tl-tools" data-od-id="tl-tools">
              <button
                className={`btn${panel === 'trim' ? ' on' : ''}`}
                id="toolTrim"
                onClick={(e) =>
                  panel === 'trim' ? closePanel() : openPanel('trim', e.currentTarget)
                }
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
                  <path d="M5 5l9.5 9.5" />
                  <path d="M5 19l9.5-9.5" />
                  <circle cx="16.5" cy="7.5" r="1.8" />
                  <circle cx="16.5" cy="16.5" r="1.8" />
                </svg>
                裁切
              </button>
              <button
                className={`btn${panel === 'trans' ? ' on' : ''}`}
                id="toolTrans"
                onClick={(e) =>
                  panel === 'trans' ? closePanel() : openPanel('trans', e.currentTarget)
                }
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 8h10M13 4.5l3.5 3.5L13 11.5M17 16H7M11 12.5 7.5 16 11 19.5" />
                </svg>
                转场
              </button>
              <button
                className={`btn${loudnorm ? ' on' : ''}`}
                id="toolLoud"
                onClick={() => setLoudnorm((v) => !v)}
              >
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 11h2.4v2H3zM7.2 8h2.4v8H7.2zM11.4 5h2.4v14h-2.4zM15.6 9h2.4v6h-2.4zM19.8 11h2.4v2h-2.4z" />
                </svg>
                响度统一
              </button>
              <span className="sep mut" style={{ width: 1, height: 18, background: 'var(--border)' }}></span>
              <div className="take-strip" data-od-id="take-pool">
                <span className="lbl" style={{ fontSize: 10 }}>Takes</span>
                {poolTakes.map((t2) => (
                  <div
                    key={t2.key}
                    className="take-sm"
                    data-shot={t2.shotNum}
                    data-file={t2.file ?? ''}
                    data-lbl={t2.label}
                    data-dur={t2.dur}
                    draggable
                    title={`拖到 ${t2.shotNum} 片段上换片`}
                    onClick={() => {
                      // 点击补位第一个空槽
                      setShots((prev) => {
                        const emptyIdx = prev.findIndex((s) => !s.ready && s.id === t2.key);
                        if (emptyIdx < 0) return prev;
                        const cur = { ...prev[emptyIdx]! };
                        cur.take = t2.label.split('·')[1] ?? null;
                        cur.file = t2.file;
                        cur.dur = t2.dur;
                        cur.in = 0;
                        cur.out = t2.dur;
                        cur.vol = 1;
                        cur.ready = true;
                        return prev.map((x, i) => (i === emptyIdx ? cur : x));
                      });
                      if (t2.shotNum - 1 >= 0) selectClip(t2.shotNum - 1);
                    }}
                  >
                    {t2.file ? (
                      isVideoSrc(t2.file) ? (
                        <video
                          src={t2.file}
                          muted
                          loop
                          playsInline
                          preload="metadata"
                          style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', display: 'block', background: '#000' }}
                        />
                      ) : (
                        <img src={t2.file} alt={`${t2.label} Take`} />
                      )
                    ) : (
                      <span style={{ fontSize: 9 }}>—</span>
                    )}
                    <div className="ts-badge">{t2.label.split('·')[1] ?? ''}</div>
                  </div>
                ))}
                <div className="take-sm empty" title="去画布" onClick={() => onNavigate('canvas')}>
                  +
                </div>
              </div>
              <span className="sep mut" style={{ width: 1, height: 18, background: 'var(--border)' }}></span>
              <span className="selinfo mono" id="selInfo">
                {selInfo}
              </span>
              <span className="spacer"></span>
              <label className="zoom">
                缩放
                <input
                  type="range"
                  id="zoom"
                  min={10}
                  max={40}
                  step={1}
                  value={pps}
                  aria-label="时间刻度缩放"
                  onChange={(e) => setPps(Number(e.target.value))}
                />
                <span className="mono" id="zoomV">
                  {pps}
                </span>
              </label>
              <span className="sep mut" style={{ width: 1, height: 18, background: 'var(--border)' }}></span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-2)' }} id="curTc">
                {fmt(curT)}
              </span>
            </div>

            <div className="tl-scroll-wrap">
              <div className="trackheads">
                <div className="th" style={{ height: 22 }}></div>
                <div className="th" style={{ height: 62, marginTop: 8 }}>
                  <span className="sw v">V1</span>视频
                </div>
                <div className="th" style={{ height: 42, marginTop: 6 }}>
                  <span className="sw a">A1</span>音频
                </div>
                <div className="th" style={{ height: 24, marginTop: 8 }}>连续性</div>
              </div>
              <div className="tl-scroll" id="tlScroll" ref={scrollRef}>
                <div className="tl-inner" id="tlInner" style={{ width: emptyShots ? '100%' : geo.width }}>
                  <div
                    className="ruler"
                    id="ruler"
                    ref={rulerRef}
                    onPointerDown={(e) => {
                      scrubbingRef.current = true;
                      e.preventDefault();
                      scrub(e.clientX);
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }}
                    onPointerMove={(e) => {
                      if (scrubbingRef.current) scrub(e.clientX);
                    }}
                    onPointerUp={() => {
                      scrubbingRef.current = false;
                    }}
                    onPointerCancel={() => {
                      scrubbingRef.current = false;
                    }}
                  >
                    {rulerTicks.map((t) =>
                      t.maj ? (
                        <React.Fragment key={`m${t.t}`}>
                          <span
                            className="ticklab"
                            style={{
                              left: t.x,
                              transform: t.clamp ? 'translateX(-100%)' : undefined,
                            }}
                          >
                            {t.t}s
                          </span>
                          <span className="tick maj" style={{ left: t.x }}></span>
                        </React.Fragment>
                      ) : (
                        <span key={`t${t.t}`} className="tick" style={{ left: t.x }}></span>
                      ),
                    )}
                  </div>

                  {/* 视频轨 */}
                  <div
                    className="lane video"
                    id="videoLane"
                    data-od-id="video-lane"
                    onClick={(e) => {
                      const c = (e.target as HTMLElement).closest('.clip');
                      if (!c || (e.target as HTMLElement).closest('.trimh')) return;
                      const idx = shots.findIndex((s) => s.id === (c as HTMLElement).dataset.id);
                      if (idx >= 0) selectClip(idx);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      const c = (e.target as HTMLElement).closest('.clip');
                      document.querySelectorAll('.clip.drop-hi').forEach((x) => x.classList.remove('drop-hi'));
                      if (c) c.classList.add('drop-hi');
                    }}
                    onDragLeave={() => {
                      document.querySelectorAll('.clip.drop-hi').forEach((x) => x.classList.remove('drop-hi'));
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      document.querySelectorAll('.clip.drop-hi').forEach((x) => x.classList.remove('drop-hi'));
                      const c = (e.target as HTMLElement).closest('.clip');
                      if (!c) return;
                      const tIdx = shots.findIndex((s) => s.id === (c as HTMLElement).dataset.id);
                      if (tIdx < 0) return;
                      const takeData = e.dataTransfer.getData('text/bbt-take');
                      const clipData = e.dataTransfer.getData('text/bbt-clip');
                      if (takeData) {
                        const p = takeData.split('|');
                        const shotNum = parseInt(p[0] ?? '', 10);
                        if (shotNum !== tIdx + 1) return;
                        setShots((prev) =>
                          prev.map((s, i) =>
                            i === tIdx ? { ...s, take: p[2]?.split('·')[1] ?? s.take, file: p[1] ?? s.file, dur: parseFloat(p[3] ?? String(s.dur)), in: 0, out: parseFloat(p[3] ?? String(s.dur)), vol: 1, ready: true } : s,
                          ),
                        );
                        if (SEL === tIdx) setCurT(geo.starts[tIdx]!);
                      } else if (clipData) {
                        const from = shots.findIndex((s) => s.id === clipData);
                        if (from < 0 || from === tIdx) return;
                        setShots((prev) => {
                          const moved = prev[from]!;
                          const next = prev.filter((_, i) => i !== from);
                          next.splice(tIdx, 0, moved);
                          // 跟设计稿一致:id 重排(真实场景保留原始节点 id,只换顺序)
                          return next.map((s, i) => ({ ...s, id: s.id }));
                        });
                        setSEL(tIdx);
                        setCurT(geo.starts[tIdx]!);
                        setPlaying(false);
                      }
                    }}
                  >
                    {emptyShots ? (
                      <div className="empty-guide">
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontWeight: 600 }}>时间线还是空的</div>
                          <div className="mut" style={{ marginTop: 4 }}>
                            先在画布生成镜头并连线入线,Selected Take 会自动出现在这里。
                          </div>
                          <button className="btn btn-p btn-sm" onClick={() => onNavigate('canvas')}>
                            去画布
                          </button>
                        </div>
                      </div>
                    ) : (
                      shots.map((s, i) => {
                        const w = shotDur(s) * pps;
                        const x = geo.xs[i]!;
                        const isSel = i === curIdx || (playing && i === curIdx);
                        return (
                          <React.Fragment key={s.id}>
                            {s.ready ? (
                              <div
                                className={`clip${isSel ? ' sel' : ''}`}
                                data-id={s.id}
                                data-shot={i + 1}
                                data-ready="1"
                                draggable
                                style={{ left: x, width: w }}
                                onDragStart={(e) => {
                                  e.dataTransfer.setData('text/bbt-clip', s.id);
                                  e.dataTransfer.effectAllowed = 'move';
                                }}
                              >
                                {s.file && !isVideoSrc(s.file) ? (
                                  <img src={s.file} alt={`${s.shot} Take${s.take} 片段画面`} />
                                ) : s.file && isVideoSrc(s.file) ? (
                                  <video
                                    src={s.file}
                                    muted
                                    loop
                                    playsInline
                                    preload="metadata"
                                    onLoadedMetadata={(e) => {
                                      const v = e.currentTarget;
                                      if (v.duration && Number.isFinite(v.duration)) syncVideoDur(s.id, v.duration);
                                    }}
                                  />
                                ) : null}
                                <span className="c-badge">{`${s.shot} · ${s.take}`}</span>
                                <span className="c-dur">{shotDur(s).toFixed(1)}s</span>
                                <span
                                  className="trimh in"
                                  data-edge="in"
                                  onPointerDown={(e) => {
                                    e.stopPropagation();
                                    trimDragRef.current = {
                                      edge: 'in',
                                      px0: e.clientX,
                                      in0: s.in,
                                      out0: s.out,
                                      dur: s.dur,
                                    };
                                    e.preventDefault();
                                  }}
                                ></span>
                                <span
                                  className="trimh out"
                                  data-edge="out"
                                  onPointerDown={(e) => {
                                    e.stopPropagation();
                                    trimDragRef.current = {
                                      edge: 'out',
                                      px0: e.clientX,
                                      in0: s.in,
                                      out0: s.out,
                                      dur: s.dur,
                                    };
                                    e.preventDefault();
                                  }}
                                ></span>
                              </div>
                            ) : (
                              <div
                                className="clip empty"
                                data-id={s.id}
                                data-shot={i + 1}
                                data-ready="0"
                                style={{ left: x, width: w }}
                              >
                                <span>{`${s.shot} · 待生成`}</span>
                              </div>
                            )}
                            {i < shots.length - 1 && (
                              <span
                                className="trans"
                                data-b={i}
                                style={{ left: geo.xs[i + 1]! - TW / 2 }}
                                title={
                                  transitions[i]?.kind === 'crossfade'
                                    ? `叠化 · ${transitions[i]?.ms}ms`
                                    : transitions[i]?.kind === 'fade-black'
                                      ? '黑场(P2 真实现,当前等价硬切)'
                                      : '硬切'
                                }
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSEL(i);
                                  setCurT(geo.starts[i]!);
                                  setPlaying(false);
                                  openPanel('trans', e.currentTarget);
                                }}
                              >
                                {transitions[i]?.kind === 'crossfade' ? (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
                                    <path d="m9 6 6 6-6 6" />
                                  </svg>
                                ) : transitions[i]?.kind === 'fade-black' ? (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
                                    <circle cx="12" cy="12" r="3" />
                                  </svg>
                                ) : (
                                  <svg viewBox="0 0 24 24" fill="currentColor">
                                    <rect x="10.4" y="5" width="3.2" height="14" />
                                  </svg>
                                )}
                              </span>
                            )}
                          </React.Fragment>
                        );
                      })
                    )}
                  </div>

                  {/* 音频轨 */}
                  <div className="lane audio" id="audioLane" data-od-id="audio-lane">
                    {!emptyShots &&
                      shots.map((s, i) => {
                        const w = shotDur(s) * pps;
                        const x = geo.xs[i]!;
                        const n = Math.max(6, Math.min(90, Math.round(w / 5)));
                        return s.ready ? (
                          <div className="ac" key={s.id} style={{ left: x, width: w }}>
                            <div className="wave">
                              {Array.from({ length: n }).map((_, k) => (
                                <i key={k} style={{ height: `${waveBars((i + 1) * 0.7, k)}px` }}></i>
                              ))}
                            </div>
                            <span className="vol">×{s.vol.toFixed(1)}</span>
                          </div>
                        ) : (
                          <div className="ac empty" key={s.id} style={{ left: x, width: w }}>
                            无音轨数据
                          </div>
                        );
                      })}
                  </div>

                  {/* 连续性轨 */}
                  <div className="lane cont" id="contLane">
                    {!emptyShots &&
                      transitions.map((t, i) => {
                        const cx = (geo.xs[i + 1] ?? geo.width) - TW / 2;
                        // 连续性状态由转场类型近似(真实项目可从画布 continuity 校验扩展)
                        const warn = t.kind === 'cut';
                        const text = t.kind === 'fade-black' ? '— 无校验' : warn ? '⚠ 建议重跑' : '✓ 连续';
                        const cls = t.kind === 'fade-black' ? 'none' : warn ? 'warn' : 'ok';
                        return (
                          <span
                            key={i}
                            className={`cc ${cls}`}
                            style={{ left: cx - 45, width: 90 }}
                            title={`尾帧→${shots[i + 1]?.shot ?? ''} 首帧`}
                          >
                            {text}
                          </span>
                        );
                      })}
                  </div>

                  <div className="playhead" id="playhead" style={{ left: xAt(curT) }}></div>
                </div>
              </div>
            </div>
          </section>
        </main>
      </div>

      {/* ── 浮层弹窗(挂 .pg-timeline 直下,不放进 .panel 内:避免 backdrop-filter 包含块裁剪) ── */}
      {panel === 'trim' && (
        <div className="seg-panel open" id="trimPanel" style={{ left: panelPos.x, top: panelPos.y }}>
          <button className="seg-close" onClick={closePanel} aria-label="关闭">
            ✕
          </button>
          <div className="seg-row">
            <span className="lbl">
              裁切 · <span className="mono">{curShot ? `${curShot.shot}${curShot.take ? ` · ${curShot.take}` : ''}` : '—'}</span>
            </span>
            <label>
              入点{' '}
              <input
                type="number"
                className="numin"
                min={0}
                step={0.1}
                value={curShot?.in ?? 0}
                disabled={!curShot?.ready}
                onChange={(e) => {
                  if (!curShot) return;
                  const v = Math.max(0, Math.min(Number(e.target.value) || 0, curShot.out - 0.5));
                  setShots((prev) => prev.map((s, i) => (i === curIdx ? { ...s, in: Math.round(v * 10) / 10 } : s)));
                }}
              />
            </label>
            <label>
              出点{' '}
              <input
                type="number"
                className="numin"
                min={0.5}
                step={0.1}
                value={curShot?.out ?? 0}
                disabled={!curShot?.ready}
                onChange={(e) => {
                  if (!curShot) return;
                  const v = Math.min(curShot.dur, Math.max(Number(e.target.value) || 0, curShot.in + 0.5));
                  setShots((prev) => prev.map((s, i) => (i === curIdx ? { ...s, out: Math.round(v * 10) / 10 } : s)));
                }}
              />
            </label>
            <span className="mono mut">
              时长 {curShot?.ready ? shotDur(curShot).toFixed(1) : '—'}
            </span>
            <span className="spacer"></span>
            <button
              className="btn btn-g btn-sm"
              disabled={!curShot?.ready}
              onClick={() => {
                if (!curShot) return;
                setShots((prev) => prev.map((s, i) => (i === curIdx ? { ...s, in: 0, out: s.dur } : s)));
              }}
            >
              重置整段
            </button>
          </div>
        </div>
      )}
      {panel === 'trans' && (
        <div className="seg-panel open" id="transPanel" style={{ left: panelPos.x, top: panelPos.y }}>
          <button className="seg-close" onClick={closePanel} aria-label="关闭">
            ✕
          </button>
          <span className="lbl" style={{ fontSize: 10 }}>
            转场设置
          </span>
          {curIdx >= shots.length - 1 ? (
            <span className="mut" style={{ fontSize: 11 }}>
              已是最后一个镜头,无后续转场
            </span>
          ) : (
            (() => {
              const b = curIdx;
              const t = transitions[b] ?? { after: b, kind: 'cut' as const, ms: 500 };
              const a = shots[b];
              const d2 = shots[b + 1];
              return (
                <div className="trow" data-b={b}>
                  <span className="pair" style={{ fontWeight: 500 }}>
                    {a?.shot} → {d2?.shot}
                  </span>
                  {(['cut', 'crossfade', 'fade-black'] as const).map((k) => (
                    <span
                      key={k}
                      className={`chip sm${t.kind === k ? ' on' : ''}`}
                      data-kind={k}
                      onClick={() =>
                        setTransitions((prev) =>
                          prev.map((x, i) =>
                            i === b
                              ? { ...x, kind: k, ms: k !== 'cut' && !x.ms ? 500 : x.ms }
                              : x,
                          ),
                        )
                      }
                    >
                      {k === 'cut' ? '硬切' : k === 'crossfade' ? '叠化' : '黑场'}
                    </span>
                  ))}
                  <input
                    type="number"
                    className="numin"
                    data-ms
                    value={t.ms}
                    min={100}
                    max={2000}
                    step={100}
                    disabled={t.kind === 'cut'}
                    onChange={(e) =>
                      setTransitions((prev) =>
                        prev.map((x, i) =>
                          i === b
                            ? { ...x, ms: Math.max(100, Math.min(2000, Number(e.target.value) || 500)) }
                            : x,
                        ),
                      )
                    }
                  />
                  <span className="mut">ms</span>
                </div>
              );
            })()
          )}
        </div>
      )}
    </div>
  );
}