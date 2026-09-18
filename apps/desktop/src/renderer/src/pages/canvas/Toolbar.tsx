/**
 * Toolbar — 画布顶部工具条(纯展示 + 回调透传)
 *
 * 拆分自 CanvasPage 的 <header className="topbar"> 区块:
 * 导航/撤销重做/框选连线是静态 UI;分支弹层、重跑/运行全部、调试开关由 props 接线。
 */
import React from 'react';
import type { CanvasSnapshot, ProjectCanvases } from '@bigbotart/shared';
import CanvasSwitcher from '../../components/CanvasSwitcher';
import type { CanvasPageProps } from './types';

interface ToolbarProps {
  projectName: string;
  onNavigate: CanvasPageProps['onNavigate'];
  projectCanvases: ProjectCanvases | null;
  onSwitchCanvas: (canvasId: string) => Promise<CanvasSnapshot | null>;
  onCreateCanvas: (name?: string) => Promise<CanvasSnapshot | null>;
  onDeleteCanvas: (canvasId: string) => Promise<string | null>;
  onRenameCanvas: (canvasId: string, name: string) => Promise<boolean>;
  /** 工具行弹层(分支等)当前打开的 id;由 CanvasPage 持有(全局点按/Escape 要关闭它) */
  openPop: string | null;
  setOpenPop: React.Dispatch<React.SetStateAction<string | null>>;
  rerunDone: boolean;
  /** 当前受影响的节点数(stale / agentOn) */
  staleCount: number;
  onRerunAffected: () => void;
  onRunAll: () => void;
  dbgOpen: boolean;
  onToggleDebug: () => void;
}

export function Toolbar({
  projectName,
  onNavigate,
  projectCanvases,
  onSwitchCanvas,
  onCreateCanvas,
  onDeleteCanvas,
  onRenameCanvas,
  openPop,
  setOpenPop,
  rerunDone,
  staleCount,
  onRerunAffected,
  onRunAll,
  dbgOpen,
  onToggleDebug,
}: ToolbarProps) {
  return (
    <header className="topbar" data-od-id="canvas-toolbar">
      <button className="btn btn-g btn-sm" onClick={() => onNavigate('home')}>
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
        {projectName || '未命名项目'}
      </button>
      <CanvasSwitcher
        projectCanvases={projectCanvases}
        onSwitchCanvas={onSwitchCanvas}
        onCreateCanvas={onCreateCanvas}
        onDeleteCanvas={onDeleteCanvas}
        onRenameCanvas={onRenameCanvas}
      />
      <span className="sep"></span>
      <button className="ibtn" title="撤销">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path d="M8 5 3 10l5 5" />
          <path d="M3 10h11a7 7 0 0 1 0 14h-3" />
        </svg>
      </button>
      <button className="ibtn" title="重做">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path d="m16 5 5 5-5 5" />
          <path d="M21 10H10a7 7 0 0 0 0 14h3" />
        </svg>
      </button>
      <span className="sep"></span>
      <button className="btn btn-g btn-sm">框选</button>
      <button className="btn btn-g btn-sm">连线</button>
      <span className="spacer"></span>
      <button
        className="chip"
        onClick={(e) => {
          e.stopPropagation();
          setOpenPop((p) => (p === 'branchPop' ? null : 'branchPop'));
        }}
      >
        分支：v2 实验
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div
        className={`pop${openPop === 'branchPop' ? ' open' : ''}`}
        style={{ top: 46, right: 210 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pop-it">main · 主版本</div>
        <div className="pop-it">
          v2 实验 · 当前<span className="ck">✓</span>
        </div>
        <div className="pop-it dim">＋ 从当前画布新建分支…</div>
      </div>
      <button
        className="btn btn-s btn-sm"
        data-od-id="rerun-affected"
        disabled={rerunDone}
        style={rerunDone ? { opacity: 0.55 } : undefined}
        onClick={onRerunAffected}
      >
        {rerunDone ? '重跑已排队 ✓' : `仅重跑受影响（${staleCount}）`}
      </button>
      <button className="btn btn-s btn-sm" data-od-id="run-all" onClick={onRunAll}>
        运行全部
      </button>
      <button
        className="btn btn-s btn-sm"
        data-od-id="debug-toggle"
        style={dbgOpen ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
        onClick={onToggleDebug}
      >
        {dbgOpen ? '调试面板 ▲' : '调试日志'}
      </button>
    </header>
  );
}