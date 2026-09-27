/**
 * canvas-history — 画布编辑历史(真正的撤销/重做)
 *
 * 设计要点(与 CanvasPage 的持久化协议对齐):
 * - 快照内容 = 节点 + 连线(JSON 字符串),**不含 view** —— 平移/缩放记进历史会让
 *   「撤销一次」变成「把镜头挪回去」,而用户想撤的是内容改动。
 * - 提交(commit)只在**离散编辑动作**后发生,且用结构签名(`sig`)去重:
 *   拖动节点每帧 setState 不会刷屏,连线派生/体积测量(measure 写 h/w)也不会污染历史。
 * - undo/redo 用 `suspended` 闸门 + `baseline` 基线:回放期间状态写入不记录,
 *   回放结束后建立新基线,后续同内容再次提交会被签名挡住。
 * - 画布加载(切画布/Agent 推送刷新)用 `reset`:清空历史 + 换基线。
 */

/** 历史里保存的内容:只有可序列化的画布数据 */
export interface HistoryContent {
  nodes: unknown[];
  edges: unknown[];
  /** 节点分组(可选:旧调用点不传 = 无变化,兼容既有代码) */
  groups?: unknown[];
}

/** 单条历史(undo/redo 共用) */
export interface HistoryEntry {
  content: HistoryContent;
  label: string;
}

/** 历史条目上限(整份 JSON 字符串,按条数裁剪而非字节) */
export const HISTORY_LIMIT = 60;

/** 结构签名用的字段(与节点几何/语义相关;剔除 measure 写入的 w/h 与瞬态 badge/flash/stale/ghost) */
interface SigNode {
  id: string;
  title: string;
  x: number;
  y: number;
  kind: unknown;
  data: unknown;
}

/** 结构签名:忽略节点尺寸(测量/RS 抖动)、瞬态字段与数组顺序 */
export function structureSig(nodes: unknown[], edges: unknown[], groups?: unknown[]): string {
  const ns: SigNode[] = (nodes as Array<Record<string, unknown>>).map((n) => ({
    id: String(n.id),
    title: String(n.title ?? ''),
    x: Number(n.x ?? 0),
    y: Number(n.y ?? 0),
    kind: n.kind ?? null,
    data: n.data ?? null,
  }));
  ns.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const es = (edges as Array<Record<string, unknown>>)
    .map((e) => `${String(e.from)}>${String(e.to)}:${String(e.label ?? '')}`)
    .sort();
  // 分组也进签名:只改组(不改节点/连线)必须算一次真实编辑,否则撤销不到建组/解组
  const gs = ((groups ?? []) as Array<Record<string, unknown>>)
    .map((g) => `${String(g.id)}:${String(g.name)}:${((g.members ?? []) as unknown[]).map(String).join(',')}`)
    .sort();
  return JSON.stringify([ns, es, gs]);
}

export class HistoryStack {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  /** 当前基线的结构签名(去重用) */
  private baseline = '';
  /** 当前基线的**内容本身** —— 下一次 commit 时它就是「编辑前」状态,即撤销目标 */
  private baselineContent: HistoryContent | null = null;
  private suspended = false;

  /** 当前是否处于回放(undo/redo 应用状态)中 */
  get busy(): boolean {
    return this.suspended;
  }

  canUndo(): boolean {
    return !this.suspended && this.past.length > 0;
  }

  canRedo(): boolean {
    return !this.suspended && this.future.length > 0;
  }

  /** 历史条目数(调试/展示用) */
  counts(): { undo: number; redo: number } {
    return { undo: this.past.length, redo: this.future.length };
  }

  /** 换基线(画布加载/回放结束):清空未来并重置去重基线,不写入历史 */
  reset(content: HistoryContent): void {
    this.baseline = structureSig(content.nodes, content.edges, content.groups);
    this.baselineContent = { nodes: content.nodes, edges: content.edges, groups: content.groups };
    this.future = [];
  }

  /**
   * 提交一次编辑。**只需传编辑后的内容**(编辑前的内容 = 上一次的基线,由 stack 自己保存)。
   *
   * 这样调用方不必关心「prev/next 必须同一渲染周期成对给出」这个时序陷阱:
   * 上一次 commit/reset 之后的状态就是这次编辑的起点,天然正确。
   * 结构无变化(拖动/测量的高频写入、派生回填)时只对齐基线、不记录历史。
   */
  commit(content: HistoryContent, label: string): void {
    if (this.suspended) return;
    const sig = structureSig(content.nodes, content.edges, content.groups);
    if (sig === this.baseline) return; // 结构没变 → 不是一次真实编辑
    // 记录「编辑前」内容作为撤销目标(首次 commit 前若还没 reset,则视为空画布起点)
    this.past.push({
      content: this.baselineContent ?? { nodes: [], edges: [], groups: [] },
      label,
    });
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
    this.baseline = sig;
    this.baselineContent = { nodes: content.nodes, edges: content.edges, groups: content.groups };
  }

  /** 开始回放:此期间所有 commit 被忽略 */
  beginReplay(): void {
    this.suspended = true;
  }

  /**
   * 显式指定「编辑前内容」的提交。拖动节点这类**长事务**必须用它:
   * 拖动过程持续 setState,基线早已不是按下鼠标时的样子,没法从基线推断撤销目标。
   */
  commitFrom(prev: HistoryContent, content: HistoryContent, label: string): void {
    if (this.suspended) return;
    const sig = structureSig(content.nodes, content.edges, content.groups);
    if (sig === this.baseline) return;
    this.past.push({ content: prev, label });
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
    this.baseline = sig;
    this.baselineContent = { nodes: content.nodes, edges: content.edges, groups: content.groups };
  }

  /** 结束回放:用回放结果建立新基线(历史栈与未来栈保持 stepUndo/stepRedo 已维护的状态) */
  endReplay(content: HistoryContent): void {
    this.suspended = false;
    this.baseline = structureSig(content.nodes, content.edges, content.groups);
    this.baselineContent = { nodes: content.nodes, edges: content.edges, groups: content.groups };
  }

  /** 取一步撤销:返回要恢复的内容与动作名;空则 null(调用方随后 endReplay) */
  stepUndo(current: HistoryContent): HistoryEntry | null {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push({ content: current, label: entry.label });
    return entry;
  }

  /** 取一步重做:返回要恢复的内容与动作名 */
  stepRedo(current: HistoryContent): HistoryEntry | null {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push({ content: current, label: entry.label });
    return entry;
  }

  /** 清空全部历史(切画布/项目切换):连同基线一起重置 */
  clear(): void {
    this.past = [];
    this.future = [];
    this.baseline = '';
    this.baselineContent = null;
    this.suspended = false;
  }

  /** 测试用:当前基线签名 */
  baselineSig(): string {
    return this.baseline;
  }
}
