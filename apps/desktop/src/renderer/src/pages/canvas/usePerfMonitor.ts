/**
 * usePerfMonitor — 渲染性能采集 hook(rAF 薄壳)
 *
 * 统计口径全部在 perf.ts(纯函数、可单测),这里只负责:
 *  ① 用 requestAnimationFrame 量帧间隔;
 *  ② 把「当前在做什么」告诉采集器(phase),用于长帧归因;
 *  ③ 按固定节流把最新统计抛给 UI(默认 500ms 一次,避免面板自己变成负担)。
 *
 * ⚠️ 性能监控本身不能显著影响性能:rAF 回调里只做一次减法 + 一个环形写入,
 * 汇总(排序/分位数)只在节流点做一次,绝不在每帧做。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createPerfStore,
  record,
  setPhase,
  summarize,
  byPhase,
  diagnose,
  type PerfStore,
  type PerfPhase,
  type PerfStats,
  type PhaseBucket,
} from './perf';

export interface PerfSnapshot {
  stats: PerfStats;
  buckets: PhaseBucket[];
  /** 人类可读结论(直接指向该优化哪条路径) */
  verdict: string;
  /** 最近 N 帧的间隔(供迷你曲线;只取尾部) */
  recent: number[];
}

export interface PerfMonitor {
  snapshot: PerfSnapshot;
  /** 声明当前阶段(压栈语义;必须与 endPhase 配对 —— 用于有明确起止的交互) */
  beginPhase: (p: PerfPhase) => void;
  endPhase: () => void;
  /**
   * 幂等占位阶段(用于**离散事件流**:滚轮、小地图拖动等没有干净 end 的交互)。
   * 重复调用不会累积;到点调 releasePhase 退回 idle。
   * ⚠️ 不要和 beginPhase 混用于同一交互 —— 一个压栈、一个占位,计数会错。
   */
  holdPhase: (p: PerfPhase) => void;
  releasePhase: () => void;
  /** 清空样本(重新测量) */
  reset: () => void;
}

const EMPTY: PerfSnapshot = {
  stats: { frames: 0, fps: 0, p50: 0, p95: 0, p99: 0, worst: 0, longFrames: 0, longPct: 0, jankFrames: 0 },
  buckets: [],
  verdict: '采样中…',
  recent: [],
};

/**
 * @param enabled 面板未打开时应传 false —— 不做无谓采集(采集本身也有成本)
 * @param throttleMs 汇总节流(ms)
 */
export function usePerfMonitor(enabled: boolean, throttleMs = 500): PerfMonitor {
  const storeRef = useRef<PerfStore>(createPerfStore());
  const [snapshot, setSnapshot] = useState<PerfSnapshot>(EMPTY);
  /** 阶段嵌套计数:多处同时声明(如平移中又拖节点)时,以最后一个声明为准、退回时恢复 */
  const phaseStackRef = useRef<PerfPhase[]>([]);

  const publish = useCallback(() => {
    const store = storeRef.current;
    const stats = summarize(store);
    const buckets = byPhase(store);
    setSnapshot({
      stats,
      buckets,
      verdict: diagnose(stats, buckets),
      recent: store.buf.slice(-120),
    });
  }, []);

  const beginPhase = useCallback((p: PerfPhase) => {
    phaseStackRef.current.push(p);
    storeRef.current = setPhase(storeRef.current, p);
  }, []);

  const endPhase = useCallback(() => {
    phaseStackRef.current.pop();
    const back = phaseStackRef.current[phaseStackRef.current.length - 1] ?? 'idle';
    storeRef.current = setPhase(storeRef.current, back);
  }, []);

  /** 占位阶段:只改 current,不动栈(幂等,适合滚轮这类连续事件) */
  const holdPhase = useCallback((p: PerfPhase) => {
    storeRef.current = setPhase(storeRef.current, p);
  }, []);

  /** 退回栈顶(无栈时 idle)—— 与 holdPhase 配对 */
  const releasePhase = useCallback(() => {
    const back = phaseStackRef.current[phaseStackRef.current.length - 1] ?? 'idle';
    storeRef.current = setPhase(storeRef.current, back);
  }, []);

  const reset = useCallback(() => {
    storeRef.current = createPerfStore();
    phaseStackRef.current = [];
    setSnapshot(EMPTY);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let last = performance.now();
    let lastPublish = last;
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      // 首帧 dt 可能是 0 或极大(标签页切回),record 内部已过滤非法值
      storeRef.current = record(storeRef.current, dt);
      if (now - lastPublish >= throttleMs) {
        lastPublish = now;
        publish();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enabled, throttleMs, publish]);

  return { snapshot, beginPhase, endPhase, holdPhase, releasePhase, reset };
}
