/**
 * 节点接力(cascade)— 上游节点生成成功后,自动把下游生成节点依次送入队列
 *
 * 纯函数层:不读 ref / 不 setState;CanvasPage 只负责接线(队列完成回调 + runNode 重跑标记)。
 * 语义:沿有向边(source → target)收集「生成类节点」的直接下游 / 传递下游闭包。
 * - 直接下游:单跑接力,上游成功 → 直接下游依次入队(每步递归);
 * - 传递闭包:重生成上游时给全部受影响下游标 stale(接力跑完逐个刷新)。
 */
import type { CanvasNode, Edge } from './types';

/** 参与接力的生成类节点(可运行节点;文档/分镜/时间线/工作流出入口不接力) */
export const CASCADE_KINDS = new Set(['shot', 'image-gen', 'image-edit', 'image-upscale', 'image-crop', 'image-stitch', 'image-split']);

/**
 * 直接下游生成节点:sourceId 的所有出边指向的生成类节点(id 去重,保持边序)。
 */
export function directDownstreamGenIds(sourceId: string, nodes: CanvasNode[], edges: Edge[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  for (const e of edges) {
    if (e.from !== sourceId) continue;
    const t = byId.get(e.to);
    if (t && CASCADE_KINDS.has(t.kind ?? '')) out.push(e.to);
  }
  return [...new Set(out)];
}

/**
 * 传递闭包:sourceIds 下游所有生成类节点(BFS,环安全 —— 用 seen 去重,不会死循环;不含源自身)。
 */
export function allDownstreamGenIds(sourceIds: string[], nodes: CanvasNode[], edges: Edge[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>(sourceIds);
  const out: string[] = [];
  const frontier = [...sourceIds];
  while (frontier.length > 0) {
    const id = frontier.shift() as string;
    for (const e of edges) {
      if (e.from !== id) continue;
      const t = byId.get(e.to);
      if (!t || !CASCADE_KINDS.has(t.kind ?? '')) continue;
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      out.push(e.to);
      frontier.push(e.to);
    }
  }
  return out;
}

export interface CascadeBusyCheck {
  /** 该节点是否「忙」:已在队列(queued/running)或本接力轮次已提交 → 跳过,防重复入队 */
  isBusy: (id: string) => boolean;
}

/**
 * 计算接力目标:源节点完成后,直接下游中「该跑」的节点。
 * - 无产物(首跑/幽灵)或已标 stale ⇒ 需要跑;
 * - 已有产物且未 stale ⇒ 视为最新,跳过(不重复跑);
 * - 忙(已在队列/本接力轮已提交)⇒ 跳过。
 */
export function pickCascadeTargets(
  sourceId: string,
  nodes: CanvasNode[],
  edges: Edge[],
  opts: CascadeBusyCheck,
): string[] {
  return directDownstreamGenIds(sourceId, nodes, edges).filter((id) => {
    if (opts.isBusy(id)) return false;
    const n = nodes.find((x) => x.id === id);
    const d = (n?.data ?? {}) as Record<string, unknown>;
    const hasResult = Boolean(d.resultPath);
    return !hasResult || n?.stale === true;
  });
}