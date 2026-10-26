/**
 * 分镜表(storyboard)纯工具 — CanvasPage 与 StoryboardInspector 共用
 * 铺节点/撤销/重新同步的派生逻辑集中在这里,避免两处漂移。
 */
import { parseGfmTable, tableToGfm, SB_SIZE, storyboardLinkOf } from '@bigbotart/shared';
import type { CanvasNode } from './types';

/** 该分镜表已铺出的行号(去重升序)——storyboardRow 优先,否则 promptFrom */
export function sbMaterializedRows(sbId: string, ns: CanvasNode[]): number[] {
  const rows = new Set<number>();
  for (const n of ns) {
    const link = storyboardLinkOf(n.data);
    if (link?.nodeId === sbId && typeof link.row === 'number') rows.add(link.row);
  }
  return [...rows].sort((a, b) => a - b);
}

/** 该分镜表已铺出的 image-gen 节点数 */
export function sbImgCount(sbId: string, ns: CanvasNode[]): number {
  return ns.filter((n) => {
    const link = storyboardLinkOf(n.data);
    return link?.nodeId === sbId && typeof link.row === 'number' && n.kind !== 'shot';
  }).length;
}

/** 解析分镜表节点的表格(无表格块返回 null) */
export function sbTableOf(sbNode: CanvasNode): { head: string[]; rows: string[][] } | null {
  const tb = parseGfmTable(String((sbNode.data ?? {}).markdown ?? ''));
  return tb ? { head: tb.head, rows: tb.rows } : null;
}

/** 表格已改(有已铺节点且当前表 ≠ lastTable 快照) */
export function sbDirty(sbNode: CanvasNode, ns: CanvasNode[]): boolean {
  const rows = sbMaterializedRows(sbNode.id, ns);
  if (!rows.length) return false;
  const tb = sbTableOf(sbNode);
  if (!tb) return true;
  const last = String((sbNode.data ?? {}).lastTable ?? '');
  return last !== tableToGfm(tb.head, tb.rows);
}

/**
 * `nodes` 里**与分镜表统计相关**的那部分的内容指纹。
 *
 * 上面三个统计函数对任意节点只读 `kind` + 分镜归属(storyboardId / promptFrom);位置/尺寸/标题/
 * 提示词等一概无关。渲染层据此在「签名没变」时复用同一份派生数组,
 * 避免「拖动一个节点 → 所有分镜表卡片重算统计 + memo 全部失效」。
 *
 * 与 canvas-history.ts 的 structureSig 同思路:比较内容而非引用。
 * 输出顺序无关(排序后拼接),故节点数组重排也不产生新签名。
 */
export function refNodesSignature(ns: CanvasNode[]): string {
  const parts: string[] = [];
  for (const n of ns) {
    const link = storyboardLinkOf(n.data);
    if (!link?.nodeId) continue;
    parts.push(`${n.id}|${n.kind ?? ''}|${link.nodeId}|row|${link.row ?? ''}`);
  }
  return parts.sort().join('\n');
}

export { SB_SIZE };