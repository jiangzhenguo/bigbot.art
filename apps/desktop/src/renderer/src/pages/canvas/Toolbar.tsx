/**
 * Toolbar — 画布顶部工具条(纯展示 + 回调透传)
 *
 * 拆分自 CanvasPage 的 <header className="topbar"> 区块:
 * 「框选」是**模式开关**(开 = 拖空白框选,关 = 拖空白无动作);
 * 画布平移统一走「触控板双指滑动」,鼠标另有中键拖动 / 空格+拖动两条保底通道
 * (2026-10 改:此前是「关 = 拖空白平移」,左键拖空白太容易误操作);
 * 重跑/运行全部、调试开关由 props 接线。
 * 注:旧的「连线」按钮已移除 —— 它是从未接线的静态占位,连线一律走节点边缘的「+」连接点
 * (拖出即拉线,命中多端口组合时由 PortPickPop 选角色),无需额外模式开关。
 *
 * ⚠️ 「分支:v2 实验」入口已隐藏(2026-10-08,`BRANCH_FEATURE_ENABLED=false`)——
 *    与上面「连线」按钮是同一类问题:弹层里三项是**静态占位**,`main · 主版本` /
 *    `v2 实验` 只是文字、`＋ 从当前画布新建分支…` 没有任何 onClick,点了没反应。
 *    保留 JSX 与 `openPop` 接线是刻意的(见 flag 注释),恢复入口的**前置条件是先实现分支**,
 *    不是把 `false` 改回 `true`。详见 docs/待办-分支功能.md。
 */
import React from 'react';
import type { CanvasSnapshot, ProjectCanvases } from '@bigbotart/shared';
import CanvasSwitcher from '../../components/CanvasSwitcher';
import type { CanvasPageProps } from './types';
import type { NodeGroup } from './selection';

/**
 * 「分支」功能入口开关(2026-10-08 隐藏,待实现)。
 *
 * 同 `@bigbotart/shared` 的 `HIDDEN_NODE_KINDS` 是同一处置手法:**隐藏入口而非删定义**。
 * - 为什么隐藏:分支弹层的三项全是静态占位(见文件头注),留着一个点了没反应的
 *   「v2 实验」按钮,用户会当成 bug,也会误以为画布已支持分支工作流。
 * - 为什么保留代码:类型/样式/`openPop` 接线均已就位,实现分支时只需把这里改回
 *   `true` 并给弹层补真实动作,不必重新接线。
 * - ⚠️ 恢复的前置条件是**先实现分支**,不是把本常量改成 `true`。
 */
const BRANCH_FEATURE_ENABLED = false;

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
  /* 撤销/重做(历史由 CanvasPage 的 HistoryStack 持有,这里只接线与置灰) */
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /* 框选 / 分组 */
  /** 框选模式开关(开 = 拖空白框选) */
  marqueeMode: boolean;
  onToggleMarquee: () => void;
  /** 当前选中节点数(0 = 无选区) */
  selectedCount: number;
  /** 选区恰好等于一个完整组时给出该组(决定「解组」可用态) */
  wholeGroup: NodeGroup | null;
  /** 画布上的分组总数(「建组」入口的提示) */
  groupCount: number;
  onGroupSelection: () => void;
  onUngroupSelection: () => void;
  /** 整理节点位置。有选区时只整理选中的,否则整理整张画布 */
  onTidy: () => void;
  rerunDone: boolean;
  /** 当前受影响的节点数(stale / agentOn) */
  staleCount: number;
  /** 本项目资源计数(顶栏「资源」入口角标) */
  assetCount: number;
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
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  marqueeMode,
  onToggleMarquee,
  selectedCount,
  wholeGroup,
  groupCount,
  onGroupSelection,
  onUngroupSelection,
  onTidy,
  rerunDone,
  staleCount,
  assetCount,
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
      <button
        className="ibtn"
        data-od-id="canvas-undo"
        title={canUndo ? '撤销(⌘Z)' : '没有可撤销的操作'}
        disabled={!canUndo}
        style={canUndo ? undefined : { opacity: 0.4 }}
        onClick={onUndo}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path d="M8 5 3 10l5 5" />
          <path d="M3 10h11a7 7 0 0 1 0 14h-3" />
        </svg>
      </button>
      <button
        className="ibtn"
        data-od-id="canvas-redo"
        title={canRedo ? '重做(⌘⇧Z)' : '没有可重做的操作'}
        disabled={!canRedo}
        style={canRedo ? undefined : { opacity: 0.4 }}
        onClick={onRedo}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path d="m16 5 5 5-5 5" />
          <path d="M21 10H10a7 7 0 0 0 0 14h3" />
        </svg>
      </button>
      <span className="sep"></span>
      {/* 框选模式开关:开 = 拖空白框选;关 = 拖空白无动作(平移走双指滑动 / 中键 / 空格) */}
      <button
        className="btn btn-g btn-sm"
        data-od-id="canvas-marquee-toggle"
        aria-pressed={marqueeMode}
        title={
          marqueeMode
            ? '框选模式:拖空白处框选节点(点击关闭)\n平移画布:触控板双指滑动 / 中键拖动 / 空格+拖动'
            : '框选模式:开启后拖空白处可框选多个节点\n多选后可建组、整体拖动与删除'
        }
        style={
          marqueeMode
            ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
            : undefined
        }
        onClick={onToggleMarquee}
      >
        {marqueeMode ? '◼ 框选中' : '框选'}
      </button>
      {/* 分组操作:选中 ≥2 个节点可建组;选区恰好是整组时可解组 */}
      <button
        className="btn btn-g btn-sm"
        data-od-id="canvas-group"
        disabled={selectedCount < 2}
        style={selectedCount < 2 ? { opacity: 0.4 } : undefined}
        title={
          selectedCount < 2
            ? '框选或 Shift 点选至少 2 个节点后可建组(⌘G)'
            : `把选中的 ${selectedCount} 个节点收成一个组(⌘G)`
        }
        onClick={onGroupSelection}
      >
        建组
        {groupCount > 0 ? (
          <span className="n" style={{ color: 'var(--meta)', fontSize: 11, marginLeft: 4 }}>
            {groupCount}
          </span>
        ) : null}
      </button>
      <button
        className={`btn btn-g btn-sm${wholeGroup ? '' : ' dim'}`}
        data-od-id="canvas-ungroup"
        disabled={!wholeGroup}
        style={wholeGroup ? undefined : { opacity: 0.4 }}
        title={wholeGroup ? `解组「${wholeGroup.name}」(节点保留,⌘⇧G)` : '先选中整个组(点组徽标 / 双击组框)'}
        onClick={onUngroupSelection}
      >
        解组
      </button>
      <button
        className="btn btn-g btn-sm"
        data-od-id="canvas-tidy"
        title={
          selectedCount > 0
            ? `整理选中的 ${selectedCount} 个节点(只改位置,⌘Z 可撤销)`
            : '整理整张画布:避开重叠,分镜表和它的镜头留在一起(⌘Z 可撤销)'
        }
        onClick={onTidy}
      >
        整理
      </button>
      <span className="spacer"></span>
      {/* 「分支:v2 实验」入口已隐藏 —— 弹层内是静态占位,点了没反应(见顶部 flag 注释)。
          整段(按钮 + 弹层)一起包在 flag 里:只藏按钮会留下一个永远打不开的 `.pop` 节点。 */}
      {BRANCH_FEATURE_ENABLED ? (
        <>
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
        </>
      ) : null}
      <button
        className="btn btn-s btn-sm"
        data-od-id="rerun-affected"
        disabled={rerunDone}
        style={rerunDone ? { opacity: 0.55 } : undefined}
        onClick={onRerunAffected}
      >
        {rerunDone ? '重跑已排队 ✓' : `仅重跑受影响（${staleCount}）`}
      </button>
      <button
        className="btn btn-s btn-sm"
        data-od-id="toolbar-assets"
        title="打开资源管理 · 项目资源视图"
        onClick={() => onNavigate('assets')}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          style={{ width: 12, height: 12, marginRight: 5, verticalAlign: -1 }}
        >
          <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z" />
        </svg>
        资源
        {assetCount > 0 ? (
          <span className="n" style={{ color: 'var(--meta)', fontSize: 11, marginLeft: 4 }}>{assetCount}</span>
        ) : null}
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