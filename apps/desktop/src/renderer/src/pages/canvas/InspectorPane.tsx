/**
 * InspectorPane — 检查器页签内容(纯组合展示)
 *
 * 拆分自 CanvasPage 的 <div class="insp"> 区块:
 * 选中节点标题/预览 + InspectorBody(forms)+ 「仅重跑该节点」按钮。
 * 所有数据与回调由 CanvasPage 透传,本组件不做任何状态/副作用。
 */
import React from 'react';
import type { RenderJob, Asset } from '@bigbotart/shared';
import type { CanvasNode, NodeInfo } from './types';
import { InspectorBody } from './inspector/InspectorBody';

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
  onMaterializeStoryboard: (sbNode: CanvasNode, aspect: string, tier: string) => void;
  onUndoStoryboard: (sbNode: CanvasNode) => void;
  onResyncStoryboard: (sbNode: CanvasNode) => void;
  onPlanStoryboard: (docNode: CanvasNode) => void;
  onOpenTimelinePage: () => void;
  onRemoveEdge: (srcId: string, dstId: string) => void;
  /** 「仅重跑该节点」 */
  onRerunSelected: () => void;
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
  onMaterializeStoryboard,
  onUndoStoryboard,
  onResyncStoryboard,
  onPlanStoryboard,
  onOpenTimelinePage,
  onRemoveEdge,
  onRerunSelected,
  onOpenAssetPicker,
}: InspectorPaneProps) {
  return (
    <div className={`insp${tab === 'insp' ? ' on' : ''}`} data-od-id="inspector">
      {selected && selNode ? (
        <div>
          <div className="lbl" style={{ marginBottom: 8 }}>
            {inspectTitle}
          </div>
          {selInfo && selInfo.img ? (
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
          onMaterializeStoryboard={onMaterializeStoryboard}
          onUndoStoryboard={onUndoStoryboard}
          onResyncStoryboard={onResyncStoryboard}
          onPlanStoryboard={onPlanStoryboard}
          onOpenTimelinePage={onOpenTimelinePage}
          onRemoveEdge={onRemoveEdge}
          onOpenAssetPicker={onOpenAssetPicker}
        />
      ) : null}
      {selected && (
        <button
          className="btn btn-s"
          style={{ width: '100%' }}
          onClick={onRerunSelected}
        >
          仅重跑该节点
        </button>
      )}
    </div>
  );
}