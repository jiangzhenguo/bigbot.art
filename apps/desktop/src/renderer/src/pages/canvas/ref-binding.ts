/**
 * 镜头检查器「参考绑定」× 与画布边的对应关系。
 *
 * 2026-10-13 事故:× 只写 refsSuppressed / 裁 refs,不删边。
 * ref-image 是多值端口,停用按 role 整档拦不住 → 下一轮 derive 又加回来,
 * 画布连线也一直还在。自动绑定项的 × 必须删掉对应入边。
 */

export type RefBinding = {
  role: string;
  assetId?: string;
  path?: string;
  auto?: boolean;
};

export type RefEdgeMin = { from: string; to: string; label?: string };
export type RefNodeMin = { id: string; data?: unknown };

/** 自动注入的参考 → 对应入边的源节点 id;找不到返回 null */
export function findAutoRefEdgeSource(
  targetId: string,
  ref: RefBinding,
  nodes: RefNodeMin[],
  edges: RefEdgeMin[],
): string | null {
  if (!ref.auto) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    if (e.to !== targetId) continue;
    if ((e.label ?? '') !== ref.role) continue;
    const src = byId.get(e.from);
    if (!src) continue;
    const sd = (src.data ?? {}) as Record<string, unknown>;
    if (ref.assetId) {
      if (String(sd.assetId ?? '') === ref.assetId) return e.from;
      continue;
    }
    if (ref.path) {
      const result = String(sd.resultPath ?? '');
      const tail = String(sd.tailFramePath ?? '');
      if (result === ref.path || tail === ref.path) return e.from;
    }
  }
  return null;
}
