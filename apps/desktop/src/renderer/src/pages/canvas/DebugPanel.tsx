/**
 * DebugPanel — 右下角调试面板(性能 + 日志两个页签;纯展示)
 *
 * 「性能」页签回答一个问题:**现在该优化哪条路径**。
 * 它把帧间隔按操作归因(拖动节点 / 平移 / 缩放…),直接给出结论句,
 * 而不是丢一堆数字让人自己猜 —— 这正是 P0–P3 那三轮优化时缺的依据。
 *
 * 「日志」页签是原有的主进程日志总线(队列 / h3 进度 / 错误)。
 * 日志抓取与自动滚动仍在 CanvasPage(通过 bodyRef 传入),本组件只渲染。
 */
import React from 'react';
import type { DebugLogEntry } from '@bigbotart/shared';
import type { PerfSnapshot } from './usePerfMonitor';
import { frameLevel, LONG_FRAME_MS } from './perf';

export type DebugTab = 'perf' | 'logs';

interface DebugPanelProps {
  open: boolean;
  tab: DebugTab;
  onTab: (t: DebugTab) => void;
  logs: DebugLogEntry[];
  /** 日志体容器 ref(CanvasPage 用于自动滚到底部) */
  bodyRef: React.MutableRefObject<HTMLDivElement | null>;
  onClear: () => void;
  onClose: () => void;
  perf: PerfSnapshot;
  onPerfReset: () => void;
}

export function DebugPanel({
  open,
  tab,
  onTab,
  logs,
  bodyRef,
  onClear,
  onClose,
  perf,
  onPerfReset,
}: DebugPanelProps) {
  if (!open) return null;
  const { stats, buckets, verdict, recent } = perf;
  return (
    <div className="dbg-panel" data-od-id="debug-panel">
      <div className="dbg-head">
        <div className="dbg-tabs" role="tablist">
          <button
            className={`dbg-tab${tab === 'perf' ? ' on' : ''}`}
            role="tab"
            aria-selected={tab === 'perf'}
            onClick={() => onTab('perf')}
          >
            性能
          </button>
          <button
            className={`dbg-tab${tab === 'logs' ? ' on' : ''}`}
            role="tab"
            aria-selected={tab === 'logs'}
            onClick={() => onTab('logs')}
          >
            日志{logs.length ? ` · ${logs.length}` : ''}
          </button>
        </div>
        <div className="dbg-acts">
          {tab === 'perf' ? (
            <button className="btn btn-s btn-xs" onClick={onPerfReset}>
              重测
            </button>
          ) : (
            <button className="btn btn-s btn-xs" onClick={onClear}>
              清空
            </button>
          )}
          <button className="btn btn-s btn-xs" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>

      {tab === 'perf' ? (
        <div className="dbg-body" data-od-id="debug-perf">
          {/* 结论行:直接说该优化哪里 */}
          <div className={`dbg-verdict${stats.frames < 30 ? ' mut' : ''}`}>{verdict}</div>

          <div className="dbg-grid">
            <Stat label="FPS" value={stats.frames ? String(stats.fps) : '—'} tone={fpsTone(stats.fps, stats.frames)} />
            <Stat label="p50" value={fmt(stats.p50)} />
            <Stat label="p95" value={fmt(stats.p95)} tone={stats.p95 > LONG_FRAME_MS ? 'warn' : 'ok'} />
            <Stat label="最差" value={fmt(stats.worst)} tone={stats.worst > 100 ? 'bad' : stats.worst > LONG_FRAME_MS ? 'warn' : 'ok'} />
            <Stat label="长帧" value={stats.frames ? `${stats.longPct}%` : '—'} tone={stats.longPct > 10 ? 'warn' : 'ok'} />
            <Stat label="卡顿" value={String(stats.jankFrames)} tone={stats.jankFrames > 0 ? 'bad' : 'ok'} />
          </div>

          {/* 迷你帧曲线:一根柱子 = 一帧,越高越慢 */}
          <div className="dbg-spark" aria-hidden>
            {recent.length === 0 ? (
              <span className="mut">等待采样…</span>
            ) : (
              recent.slice(-80).map((dt, i) => (
                <i key={i} className={`s-${frameLevel(dt)}`} style={{ height: `${sparkH(dt)}%` }} title={`${Math.round(dt)}ms`} />
              ))
            )}
          </div>

          {/* 按操作归因 */}
          {buckets.length > 0 ? (
            <div className="dbg-phases" data-od-id="debug-perf-phases">
              {buckets.map((b) => (
                <div key={b.phase} className="dbg-phase">
                  <span className="ph">{PHASE_LABEL[b.phase]}</span>
                  <span className="fr">{b.frames} 帧</span>
                  <span className={`lf${b.longFrames ? ' bad' : ''}`}>长帧 {b.longFrames}</span>
                  <span className="wm">最差 {Math.round(b.worst)}ms</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="dbg-hint mut">
            采样 {stats.frames} 帧 · 长帧阈值 {LONG_FRAME_MS}ms · 面板打开时才采集
          </div>
        </div>
      ) : (
        <div className="dbg-body mono" ref={bodyRef}>
          {logs.length === 0 ? (
            <div className="mut">暂无日志 · 点「立即生成」后这里会实时显示队列 / h3 进度</div>
          ) : (
            logs.map((e, i) => (
              <div key={i} className={`dbg-line lv-${e.level}`}>
                <span className="dbg-ts">{e.ts.slice(11, 23)}</span>
                <span className="dbg-lv">{e.level}</span>
                <span className="dbg-msg">{e.msg}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const PHASE_LABEL: Record<string, string> = {
  pan: '拖动画布',
  zoom: '缩放',
  'drag-node': '拖动节点',
  marquee: '框选',
  connect: '拖拽建边',
  minimap: '小地图',
  agent: 'Agent 对话',
  idle: '静止',
};

function Stat({ label, value, tone = 'ok' }: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className={`dbg-stat t-${tone}`}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function fmt(v: number): string {
  return v > 0 ? `${Math.round(v * 10) / 10}` : '—';
}

function fpsTone(fps: number, frames: number): 'ok' | 'warn' | 'bad' {
  if (!frames) return 'ok';
  if (fps >= 55) return 'ok';
  return fps >= 40 ? 'warn' : 'bad';
}

/** 帧间隔 → 柱高百分比(0–100)。以 100ms 为满格,超过则顶格 */
function sparkH(dt: number): number {
  return Math.min(100, Math.max(4, (dt / 100) * 100));
}
