/**
 * InspectorPane — 检查器页签内容(纯组合展示)
 *
 * 拆分自 CanvasPage 的 <div class="insp"> 区块:
 * 选中节点标题/预览 + InspectorBody(forms)+ 「仅重跑该节点」按钮。
 * 所有数据与回调由 CanvasPage 透传,本组件不做任何状态/副作用。
 */
import React from 'react';
import type { RenderJob, Asset, NodeKind } from '@bigbotart/shared';
import type { CanvasNode, Edge, NodeInfo } from './types';
import { InspectorBody, VideoPostCancelButton } from './inspector/InspectorBody';

/**
 * 「仅重跑该节点」可见的节点类型 —— 与 CanvasPage `runNode` 里**真有执行分支**的 kind 一一对应。
 *
 * 刻意排除 asset(纯引用节点,没有生成/后处理)、document(无可跑任务)、
 * timeline(点重跑只是跳转到时间线页)、storyboard(靠检查器里的「铺节点」动作而非重跑)、
 * director / audio-ref / workflow-*(尚无执行分支),否则按钮点了没反应,是个假入口。
 */
const RERUNABLE_KINDS = new Set<NodeKind | 'plain'>([
  'shot',
  'image-gen',
  'image-edit',
  'image-upscale',
  'image-crop',
  'image-stitch',
  'image-split',
  'frame-grab',
  'video-upscale',
]);

interface InspectorPaneProps {
  tab: 'chat' | 'insp';
  selected: string | null;
  selNode: CanvasNode | undefined;
  inspectTitle: string;
  selInfo: NodeInfo | undefined;
  /* ↓ 透传给 InspectorBody */
  infoMap: Record<string, NodeInfo>;
  setInfoMap: React.Dispatch<React.SetStateAction<Record<string, NodeInfo>>>;
  setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>;
  /** 撤销提交:检查器改参数 = 一次离散编辑动作(记入历史;缺省时退化为主导航,不影响独立使用) */
  onCommitEdit?: (label: string) => void;
  toastMsg: (msg: string) => void;
  projectId: string | null;
  activeCanvasId: string | null;
  jobs: RenderJob[];
  assetsList: Asset[];
  assetCache: Record<string, string>;
  runNode: (nodeId: string) => void;
  nodes: CanvasNode[];
  edges: Edge[];
  /** nodeId → 最新成功 Take 产物路径(视频增强等本地节点产物兜底显示;与节点卡同一份) */
  takeResults?: Record<string, string>;
  onMaterializeStoryboard: (sbNode: CanvasNode, aspect: string, tier: string) => void;
  onUndoStoryboard: (sbNode: CanvasNode) => void;
  onResyncStoryboard: (sbNode: CanvasNode) => void;
  onPlanStoryboard: (docNode: CanvasNode) => void;
  onOpenTimelinePage: () => void;
  onRemoveEdge: (srcId: string, dstId: string) => void;
  /** 「仅重跑该节点」 */
  onRerunSelected: () => void;
  /** 当前节点是否正在跑长任务(视频增强);true 时禁用重跑按钮防重复触发 */
  running?: boolean;
  /** asset 节点:「从资源库选择…」→ 打开资产选择弹层 */
  onOpenAssetPicker?: (nodeId: string) => void;
}

export function InspectorPane({
  tab,
  selected,
  selNode,
  inspectTitle,
  selInfo,
  infoMap,
  setInfoMap,
  setNodes,
  onCommitEdit,
  toastMsg,
  projectId,
  activeCanvasId,
  jobs,
  assetsList,
  assetCache,
  runNode,
  nodes,
  edges,
  takeResults,
  onMaterializeStoryboard,
  onUndoStoryboard,
  onResyncStoryboard,
  onPlanStoryboard,
  onOpenTimelinePage,
  onRemoveEdge,
  onRerunSelected,
  onOpenAssetPicker,
  running,
}: InspectorPaneProps) {
  return (
    <div className={`insp${tab === 'insp' ? ' on' : ''}`} data-od-id="inspector">
      {selected && selNode ? (
        <div>
          <div className="lbl" style={{ marginBottom: 8 }}>
            {inspectTitle}
          </div>
          {/* 顶部整块预览:**asset(资源)节点除外** —— 资源检查器自己第一条就是素材预览
              (见 AssetInspector 顶部注释),这里再画一遍会让同一张图在面板里出现两遍。
              其余 kind 的检查器没有统一置顶预览,仍靠这块给出「选中了什么」的第一印象。 */}
          {selInfo && selInfo.img && selNode.kind !== 'asset' ? (
            <div className="preview">
              <img src={selInfo.img} alt="选中节点预览" />
            </div>
          ) : null}
        </div>
      ) : null}
      {selected && selNode ? (
        <InspectorBody
          node={selNode}
          infoMap={infoMap}
          setInfoMap={setInfoMap}
          setNodes={setNodes}
          onCommitEdit={onCommitEdit}
          toastMsg={toastMsg}
          projectId={projectId}
          activeCanvasId={activeCanvasId}
          jobs={jobs}
          assetsList={assetsList}
          assetCache={assetCache}
          runNode={runNode}
          nodes={nodes}
          edges={edges}
          takeResults={takeResults}
          onMaterializeStoryboard={onMaterializeStoryboard}
          onUndoStoryboard={onUndoStoryboard}
          onResyncStoryboard={onResyncStoryboard}
          onPlanStoryboard={onPlanStoryboard}
          onOpenTimelinePage={onOpenTimelinePage}
          onRemoveEdge={onRemoveEdge}
          onOpenAssetPicker={onOpenAssetPicker}
        />
      ) : null}
      {/* 「仅重跑该节点」只对**有生成任务**的节点有意义。
          asset(资源)节点是纯引用节点:没有推理/后处理可跑(runNode 里没有对应分支,
          点了会落到 h3c 视频提交分支);timeline / document 同理 —— 一律不显示按钮,
          避免给出一个点了没反应(或报错)的假入口。 */}
      {selected && selNode?.kind && RERUNABLE_KINDS.has(selNode.kind) &&
        (running && selNode.kind === 'video-upscale' ? (
          <div className="vpost-rerun">
            <button className="btn btn-s rerun-btn" disabled data-od-id="rerun-btn" title="该节点正在增强中">
              增强中…
            </button>
            <VideoPostCancelButton nodeId={selNode.id} toastMsg={toastMsg} className="btn btn-s rerun-btn" />
          </div>
        ) : (
          <button
            className="btn btn-s rerun-btn"
            onClick={onRerunSelected}
            // 长任务进行中禁止再次触发(否则并行起多个后处理,互相抢资源并覆盖产物)
            disabled={running}
            title={running ? '该节点正在增强中,请等待当前任务完成' : undefined}
            data-od-id="rerun-btn"
          >
            {running ? '增强中…' : '仅重跑该节点'}
          </button>
        ))}
    </div>
  );
}