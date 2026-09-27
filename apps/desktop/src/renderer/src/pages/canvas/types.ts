import type { NodeKind, CanvasSnapshot, ProjectCanvases } from '@bigbotart/shared';

export interface CanvasPageProps {
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
  projectId: string | null;
  projectName: string;
  projectCanvases: ProjectCanvases | null;
  onSaveCanvas: (snap: CanvasSnapshot) => Promise<void> | void;
  onSwitchCanvas: (canvasId: string) => Promise<CanvasSnapshot | null>;
  onCreateCanvas: (name?: string) => Promise<CanvasSnapshot | null>;
  onDeleteCanvas: (canvasId: string) => Promise<string | null>;
  onRenameCanvas: (canvasId: string, name: string) => Promise<boolean>;
}

export type EdgeClass = '' | 'stale' | 'ghost';

export interface Edge {
  from: string;
  to: string;
  cls: EdgeClass;
  /** 🆕 语义标签(手册 §9):input-brief / first-frame / last-frame / ref-image / ref-audio / slot-<name> */
  label?: string;
}

export interface CanvasNode {
  id: string;
  title: string;
  w: number;
  x: number;
  y: number;
  /** 幽灵节点(尚未产出) */
  ghost?: boolean;
  /** 上游改动导致过期 */
  stale?: boolean;
  /** Agent 正在此节点上重跑 */
  agentOn?: boolean;
  /** 节点头部状态点 */
  st?: 'ok' | 'warn';
  /** 节点头部背景覆盖(设计稿用 inline style 指定 --bg) */
  headBg?: string;
  badge?: string;
  /** 队列中存在本节点的进行中任务(queued/running)—— 由 CanvasPage 的队列订阅维护。
   *  有它就说明 badge 是「运行期标签」,快照推送/写盘不得把它当作用户内容覆盖 */
  running?: boolean;
  /** 长任务进度(仅视频增强等本地长任务用)
   *  - pct:整体进度 0-1(按阶段加权,跨阶段单调递增)
   *  - text:阶段文案(如「修脸 GFPGAN · 40/124 帧」)
   *  - stage:阶段序号(如「2/3」)
   *  - indet:当前阶段无细分进度 → 进度条走滚动动画 */
  progress?: { pct?: number; text: string; stage?: string; indet?: boolean };
  /** 解析「+」时用于定位的实测高度(px,未缩放) */
  h?: number;
  kind?: NodeKind | 'plain';
  tag?: NodeTag;
  /** 弹层创建的节点的补充描述行 */
  extra?: string;
  /** 真实业务参数(来自 Agent 规划 / 项目画布快照),渲染与生成用 */
  data?: Record<string, unknown>;
}

/** 由弹层/节点面板创建的新节点的渲染参数 */
export interface NodeTag {
  /** 展示层 id(节点库用),与 NodeKind 分开 */
  id: string;
  /** 领域层 kind(写入 CanvasNode.kind 与 CanvasSnapshot) */
  kind: NodeKind;
  name: string;
  sub: string;
  p1?: boolean;
  /** 🆕 v2 工作流专用节点(显示 WF 角标) */
  wf?: boolean;
}

export interface NodeInfo {
  t: string;
  img: string | null;
  meta: Array<[string, string]>;
}

/** 「+」按钮 → 拖拽连接的状态(StageView 渲染预览线/命中高亮用,拆分自 CanvasPage) */
export interface ConnectDrag {
  sourceId: string;
  /** pointerdown 屏幕坐标(用于判断「未拖动」则走 onClick 弹层路径) */
  sx: number;
  sy: number;
  /** 当前屏幕坐标 */
  cx: number;
  cy: number;
  /** 当前命中节点 id(null = 空白) */
  hitId: string | null;
  /** 当前命中是否可连 */
  hitOk: boolean;
  /** 标记已开始拖动(>4px 才算;否则 onPointerUp 走原 click) */
  moved: boolean;
}
