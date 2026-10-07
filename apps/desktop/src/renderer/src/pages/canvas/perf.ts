/**
 * perf.ts — 渲染性能采集(纯逻辑)
 *
 * ── 为什么需要它 ──
 * P0–P3 做了三轮画布优化,但**没有实测数据**:改完只能靠手感说「好像顺了」,
 * 也无法判断 P4(连线 imperative 化 + 视口裁剪)到底值不值得做。
 * 这个模块提供客观依据:FPS、长帧、以及**长帧发生在哪个操作期间**。
 *
 * ── 设计取舍 ──
 * 1) 纯函数 + 显式状态,采集器只是一个薄壳(见 usePerfMonitor)。
 *    这样统计口径(百分位、分位数、归因)全部可单测,不必模拟 rAF。
 * 2) 用**环形缓冲**而非无限数组:面板常开时不能一直吃内存。
 * 3) 只记「帧间隔」不记「每帧做了什么」:后者要 Performance API 埋点,
 *    侵入性大;而「哪类操作期间掉帧」已经足够指导优化方向 ——
 *    这正是当初决定 P0/P1/P2/P3 优先级时缺的那块信息。
 */

/** 一帧的采样(间隔 ms) */
export interface FrameSample {
  /** 距上一帧的间隔(ms)。首帧无间隔,不采样 */
  dt: number;
}

/** 正在进行中的操作类别(用于把长帧归因到具体交互) */
export type PerfPhase =
  | 'idle'
  | 'pan'          // 平移画布(双指滑动 / 中键 / 空格+拖动)
  | 'zoom'         // 缩放(Ctrl/⌘+滑动 或 鼠标滚轮)
  | 'drag-node'    // 拖动节点
  | 'marquee'      // 框选
  | 'connect'      // 拖拽建边
  | 'minimap'      // 小地图跳转
  | 'agent';       // Agent 对话(长任务)

/** 长帧阈值(ms):60fps 一帧 16.7ms,超过 2 帧即需要关注 */
export const LONG_FRAME_MS = 33;
/** 严重卡顿阈值(ms) */
export const JANK_FRAME_MS = 100;

export interface PerfStats {
  /** 采样帧数 */
  frames: number;
  /** 平均 FPS(按平均帧间隔换算) */
  fps: number;
  /** 帧间隔分位数(ms) */
  p50: number;
  p95: number;
  p99: number;
  /** 最长帧间隔(ms) */
  worst: number;
  /** 长帧数与占比 */
  longFrames: number;
  longPct: number;
  /** 严重卡顿数 */
  jankFrames: number;
}

/** 按操作类别归因的卡顿统计 */
export interface PhaseBucket {
  phase: PerfPhase;
  frames: number;
  longFrames: number;
  /** 该阶段内最差帧(ms) */
  worst: number;
}

/**
 * 采集器状态(纯数据,便于单测直接构造)。
 * 用环形缓冲:容量满后覆盖最旧样本。
 */
export interface PerfStore {
  /** 环形缓冲 */
  buf: number[];
  /** 写入位置(环形) */
  head: number;
  /** 已写入总数(用于判断是否绕圈) */
  total: number;
  capacity: number;
  /** 每个长帧对应的阶段(与 buf 同索引语义,见 record) */
  phases: PerfPhase[];
  /** 当前阶段(每次 record 时快照) */
  current: PerfPhase;
}

export function createPerfStore(capacity = 600): PerfStore {
  return { buf: [], head: 0, total: 0, capacity, phases: [], current: 'idle' };
}

/**
 * 记录一帧。
 *
 * ⚠️ 环形缓冲的相位对齐:buf 与 phases 必须同增同绕,否则归因会错位。
 * 这里两个数组用同一套 head/total 逻辑(写入前先补位),避免错位 bug。
 */
export function record(store: PerfStore, dt: number, phase: PerfPhase = store.current): PerfStore {
  if (!Number.isFinite(dt) || dt <= 0) return store; // 时钟回拨/非法值直接忽略
  const next: PerfStore = {
    ...store,
    buf: store.buf.slice(),
    phases: store.phases.slice(),
  };
  if (next.total < next.capacity) {
    next.buf.push(dt);
    next.phases.push(phase);
  } else {
    next.buf[next.head] = dt;
    next.phases[next.head] = phase;
  }
  next.head = (next.head + 1) % next.capacity;
  next.total += 1;
  return next;
}

export function setPhase(store: PerfStore, phase: PerfPhase): PerfStore {
  return store.current === phase ? store : { ...store, current: phase };
}

/** 取当前窗口内的全部样本(按时间序,从最旧到最新) */
export function samplesOf(store: PerfStore): number[] {
  return store.total <= store.capacity
    ? store.buf
    : // 绕圈后从 head 开始读才是时间序
      [...store.buf.slice(store.head), ...store.buf.slice(0, store.head)];
}

/** 有序数组的分位数(线性插值;空数组返回 0) */
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  const w = pos - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
}

/** 汇总统计 */
export function summarize(store: PerfStore): PerfStats {
  const s = samplesOf(store).filter((v) => Number.isFinite(v) && v > 0);
  if (s.length === 0) {
    return { frames: 0, fps: 0, p50: 0, p95: 0, p99: 0, worst: 0, longFrames: 0, longPct: 0, jankFrames: 0 };
  }
  const sorted = [...s].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const avg = sum / s.length;
  const longFrames = s.filter((v) => v > LONG_FRAME_MS).length;
  return {
    frames: s.length,
    // 平均间隔 → FPS;间隔为 0 的情况已被上面的过滤排除
    fps: avg > 0 ? Math.round((1000 / avg) * 10) / 10 : 0,
    p50: round2(percentile(sorted, 0.5)),
    p95: round2(percentile(sorted, 0.95)),
    p99: round2(percentile(sorted, 0.99)),
    worst: round2(sorted[sorted.length - 1]!),
    longFrames,
    longPct: Math.round((longFrames / s.length) * 1000) / 10,
    jankFrames: s.filter((v) => v > JANK_FRAME_MS).length,
  };
}

/**
 * 按阶段归因:哪类操作在掉帧。
 *
 * 这是本模块最有价值的部分 —— 「拖节点时 p95 = 48ms,平移时 p95 = 18ms」
 * 能直接指出该优化哪条路径,而不是笼统地说「画布卡」。
 */
export function byPhase(store: PerfStore): PhaseBucket[] {
  const order: PerfPhase[] = ['pan', 'zoom', 'drag-node', 'marquee', 'connect', 'minimap', 'agent', 'idle'];
  const acc = new Map<PerfPhase, PhaseBucket>();
  const s = samplesOf(store);
  const p = store.total <= store.capacity ? store.phases : [...store.phases.slice(store.head), ...store.phases.slice(0, store.head)];
  for (let i = 0; i < s.length; i++) {
    const dt = s[i]!;
    const ph = p[i] ?? 'idle';
    const b = acc.get(ph) ?? { phase: ph, frames: 0, longFrames: 0, worst: 0 };
    b.frames += 1;
    if (dt > LONG_FRAME_MS) b.longFrames += 1;
    if (dt > b.worst) b.worst = round2(dt);
    acc.set(ph, b);
  }
  return order.filter((ph) => acc.has(ph)).map((ph) => acc.get(ph)!);
}

/** 帧间隔 → 等级(面板配色用) */
export function frameLevel(dt: number): 'ok' | 'warn' | 'bad' {
  if (dt > JANK_FRAME_MS) return 'bad';
  if (dt > LONG_FRAME_MS) return 'warn';
  return 'ok';
}

/** 人类可读的结论(直接给优化方向,而不是丢一堆数字) */
export function diagnose(stats: PerfStats, buckets: PhaseBucket[]): string {
  if (stats.frames < 30) return '样本不足 · 在画布上拖一拖再看';
  // 找掉帧最集中的阶段(按长帧数,其次看最差帧)
  const worstPhase = [...buckets]
    .filter((b) => b.frames >= 10 && b.longFrames > 0)
    .sort((a, b) => b.longFrames - a.longFrames || b.worst - a.worst)[0];
  const label: Record<PerfPhase, string> = {
    pan: '拖动画布', zoom: '缩放', 'drag-node': '拖动节点', marquee: '框选',
    connect: '拖拽建边', minimap: '小地图', agent: 'Agent 对话', idle: '静止',
  };
  if (stats.fps >= 55 && stats.longPct < 5) return `流畅 · p95 ${stats.p95}ms`;
  if (worstPhase) {
    return `${label[worstPhase.phase]}时掉帧最重(长帧 ${worstPhase.longFrames}/${worstPhase.frames}, 最差 ${worstPhase.worst}ms)`;
  }
  return `存在长帧但未归因到具体操作 · p95 ${stats.p95}ms`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
