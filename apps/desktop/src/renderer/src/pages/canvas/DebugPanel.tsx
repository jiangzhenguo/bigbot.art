/**
 * DebugPanel — 右下角主进程日志面板(纯展示)
 *
 * 拆分自 CanvasPage 的 dbg-panel 区块。日志抓取(debugLogs + onDebugLog 订阅)
 * 与自动滚动仍留在 CanvasPage(通过 bodyRef 传入),本组件只负责渲染。
 */
import React from 'react';
import type { DebugLogEntry } from '@bigbotart/shared';

interface DebugPanelProps {
  open: boolean;
  logs: DebugLogEntry[];
  /** 日志体容器 ref(CanvasPage 用于自动滚到底部) */
  bodyRef: React.MutableRefObject<HTMLDivElement | null>;
  onClear: () => void;
  onClose: () => void;
}

export function DebugPanel({ open, logs, bodyRef, onClear, onClose }: DebugPanelProps) {
  if (!open) return null;
  return (
    <div className="dbg-panel" data-od-id="debug-panel">
      <div className="dbg-head">
        <span className="lbl">调试日志 · 实时(主进程)</span>
        <div className="dbg-acts">
          <button className="btn btn-s btn-xs" onClick={onClear}>
            清空
          </button>
          <button className="btn btn-s btn-xs" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
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
    </div>
  );
}