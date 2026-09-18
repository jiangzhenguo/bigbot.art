/**
 * 分镜表(storyboard)纯工具 — CanvasPage 与 StoryboardInspector 共用
 * 铺节点/撤销/重新同步的派生逻辑集中在这里,避免两处漂移。
 */
import type { PromptSource } from '@bigbotart/shared';
import { parseGfmTable, tableToGfm, SB_SIZE } from '@bigbotart/shared';
import type { CanvasNode } from './types';

/** 该分镜表已铺出的行号(0 基,去重升序)——由下游节点 promptFrom 派生 */
export function sbMaterializedRows(sbId: string, ns: CanvasNode[]): number[] {
  const rows = new Set<number>();
  for (const n of ns) {
    const ps = (n.data ?? {}).promptFrom as PromptSource | undefined;
    if (ps?.nodeId === sbId && ps.mode === 'row' && typeof ps.row === 'number') rows.add(ps.row);
  }
  return [...rows].sort((a, b) => a - b);
}

/** 该分镜表已铺出的 image-gen 节点数 */
export function sbImgCount(sbId: string, ns: CanvasNode[]): number {
  return ns.filter((n) => {
    const ps = (n.data ?? {}).promptFrom as PromptSource | undefined;
    return ps?.nodeId === sbId && ps.mode === 'row' && n.kind !== 'shot';
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
export { SB_SIZE };