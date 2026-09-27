/**
 * selection — 框选(marquee)几何 + 分组(Group)纯函数
 *
 * 拆分理由(AGENTS.md §4「纯函数解析器 + 单测」先例,同 planStitch/planSplit):
 * 框选最容易写错的是**边界情况** —— 反向拖拽(右下往左上)、零面积点击、
 * 未测量节点(`h` 缺失)、以及组内外连线的取舍。这些全部收敛到这里用测试钉住,
 * CanvasPage 只负责状态与事件接线。
 *
 * 坐标约定:全部为 **world 坐标系**(与 `.world` 容器的 transform 同系),
 * 屏幕坐标必须在调用方先经 `screenToWorld` 转换 —— 否则缩放/平移后框选会错位。
 */
import type { CanvasNode } from './types';

/** 未测量节点的兜底高度(与 CanvasPage 的 UNMEASURED_NODE_H 同口径:
 *  ResizeObserver 测量前的节点没有 h,用经验值参与命中,否则刚建节点框不中) */
export const UNMEASURED_NODE_H = 120;

/** 轴向对齐矩形(world 坐标,x/y 为左上角) */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 拖拽起止两点 → 规整矩形(自动处理反向拖拽:右下往左上也是正矩形) */
export function rectFromPoints(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): Rect {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(bx - ax),
    h: Math.abs(by - ay),
  };
}

/** 屏幕坐标 → world 坐标(视图平移 + 缩放;z 已由 UI 钳制在 0.4–1.3,不做二次校验) */
export function screenToWorld(
  cx: number,
  cy: number,
  view: { x: number; y: number; z: number },
): { x: number; y: number } {
  return { x: (cx - view.x) / view.z, y: (cy - view.y) / view.z };
}

/** 节点包围盒(宽度必有;高度缺失时按未测量兜底) */
export function nodeRect(n: Pick<CanvasNode, 'x' | 'y' | 'w' | 'h'>): Rect {
  return { x: n.x, y: n.y, w: n.w, h: n.h ?? UNMEASURED_NODE_H };
}

/** 矩形是否相交(轴对齐;**相交即选中**,不做「完全包含」—— 与 Figma/PPT 手感一致) */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 点是否落在矩形内(含边界) */
export function rectContainsPoint(r: Rect, px: number, py: number): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/**
 * 框选命中:与矩形相交的节点 id 列表。
 *
 * - `strict=false`(默认):相交即选中 —— 大框擦过节点边角也会选中,符合直觉。
 * - `strict=true`:完全包含才选中 —— 拖框时不想误选部分重叠的邻居节点时可切。
 * - 零面积矩形(纯点击):按「点命中」处理,避免 `rectsIntersect` 对零宽矩形恒 false
 *   (点击空白应清空选区,这是调用方的判断,这里只保证语义一致)。
 */
export function nodesInRect(
  nodes: CanvasNode[],
  rect: Rect,
  opts?: { strict?: boolean },
): string[] {
  const strict = opts?.strict === true;
  const zeroArea = rect.w < 0.5 && rect.h < 0.5;
  return nodes
    .filter((n) => {
      const nr = nodeRect(n);
      if (zeroArea) return rectContainsPoint(nr, rect.x, rect.y);
      if (strict) {
        return (
          nr.x >= rect.x &&
          nr.y >= rect.y &&
          nr.x + nr.w <= rect.x + rect.w &&
          nr.y + nr.h <= rect.y + rect.h
        );
      }
      return rectsIntersect(nr, rect);
    })
    .map((n) => n.id);
}

/** 一簇节点的包围盒(组框绘制用);空集返回 null */
export function boundingRect(
  nodes: Array<Pick<CanvasNode, 'id' | 'x' | 'y' | 'w' | 'h'>>,
  ids: string[],
): Rect | null {
  const set = new Set(ids);
  const picked = nodes.filter((n) => set.has(n.id));
  if (picked.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of picked) {
    const r = nodeRect(n);
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/* ══════════ 分组(Group)════════════ */

/**
 * 组 —— 画布上的命名节点集合。
 *
 * 设计决定:**组不写进 CanvasNode**,而是挂在 CanvasSnapshot.groups(独立数组)。
 * 理由:
 *  - 节点增删不需要维护「节点上的 groupId ↔ 组上 members」双向索引,单点真源 = members;
 *  - Agent 侧 `canvas.*` 工具整体重建节点对象时会保留未知字段,但**删节点**必然留下脏 id,
 *    独立数组可以用 `pruneGroups` 一次性清理,不必逐节点回写;
 *  - 一个节点在 UI 上只属于一个组(建组时自动从旧组摘除),数组模型天然表达得清楚。
 */
export interface NodeGroup {
  id: string;
  name: string;
  /** 成员节点 id(顺序 = 入组顺序;拖动整组时按此顺序算包围盒) */
  members: string[];
  /** 组底色(设计 token 名,如 'accent'/'success';缺省 = 中性) */
  tone?: 'neutral' | 'accent' | 'success' | 'warn';
  createdAt: string;
}

/** 默认组名序号:在已有组名里找 `组 N` 的最大 N,避免重名(用户可后续重命名) */
export function nextGroupName(groups: NodeGroup[]): string {
  let max = 0;
  for (const g of groups) {
    const m = /^组\s*(\d+)$/.exec(g.name.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `组 ${max + 1}`;
}

/** 建组:从已有组里摘除这些成员(一个节点只属于一个组),再追加新组 */
export function createGroup(
  groups: NodeGroup[],
  members: string[],
  opts?: { name?: string; id?: string; tone?: NodeGroup['tone'] },
): { groups: NodeGroup[]; group: NodeGroup } {
  const memberSet = new Set(members);
  // 先从旧组摘除(toRemove 由 pruneGroups 统一清理空组)
  const detached = groups.map((g) =>
    g.members.some((m) => memberSet.has(m))
      ? { ...g, members: g.members.filter((m) => !memberSet.has(m)) }
      : g,
  );
  const group: NodeGroup = {
    id: opts?.id ?? `grp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: opts?.name ?? nextGroupName(groups),
    members: [...members],
    tone: opts?.tone ?? 'neutral',
    createdAt: new Date().toISOString(),
  };
  return { groups: pruneGroups([...detached, group]), group };
}

/** 解组:移除这些组 id;`keepMembers` 无意义(成员本就是独立节点,不需要回写) */
export function dissolveGroups(groups: NodeGroup[], groupIds: string[]): NodeGroup[] {
  const drop = new Set(groupIds);
  return groups.filter((g) => !drop.has(g.id));
}

/** 从组里增删成员(Shift 点选微调时用);组不存在则原样返回 */
export function toggleGroupMember(
  groups: NodeGroup[],
  groupId: string,
  nodeId: string,
  member: boolean,
): NodeGroup[] {
  return groups.map((g) => {
    if (g.id !== groupId) return g;
    const has = g.members.includes(nodeId);
    if (member && !has) return { ...g, members: [...g.members, nodeId] };
    if (!member && has) return { ...g, members: g.members.filter((m) => m !== nodeId) };
    return g;
  });
}

/**
 * 清理:丢掉空组,并从成员里剔除已不存在的节点。
 *
 * 必须节点删除 / Agent 删节点后调用 —— 否则残留脏 id 会让下一轮
 * `boundingRect` 算出错误的组框,或点组框时找不到节点。
 */
export function pruneGroups(groups: NodeGroup[], liveNodeIds?: string[]): NodeGroup[] {
  const live = liveNodeIds ? new Set(liveNodeIds) : null;
  return groups
    .map((g) => (live ? { ...g, members: g.members.filter((m) => live.has(m)) } : g))
    .filter((g) => g.members.length > 0);
}

/** 某节点所属的组(null = 未分组);一个节点至多属于一个组 */
export function groupOfNode(groups: NodeGroup[], nodeId: string): NodeGroup | null {
  return groups.find((g) => g.members.includes(nodeId)) ?? null;
}

/**
 * 选区「扩张到整组」:选中组内任一节点 ⇒ 整组成员一起选中。
 *
 * 这是组概念的**核心手感**,也是它与「多选」的区别:多选是一次性临时集合,
 * 组是持久化的整体。拖动/删除/复制前都先做这一步扩张。
 */
export function expandSelectionToGroups(
  groups: NodeGroup[],
  selectedIds: string[],
): string[] {
  const out = new Set(selectedIds);
  for (const id of selectedIds) {
    const g = groupOfNode(groups, id);
    if (g) for (const m of g.members) out.add(m);
  }
  return [...out];
}

/** 选区完全等于某组(用于工具栏「解组」按钮的可用态判定) */
export function selectionIsWholeGroup(
  groups: NodeGroup[],
  selectedIds: string[],
): NodeGroup | null {
  if (selectedIds.length === 0) return null;
  const set = new Set(selectedIds);
  return (
    groups.find(
      (g) => g.members.length === set.size && g.members.every((m) => set.has(m)),
    ) ?? null
  );
}

/** 快照里的组数据规整(旧项目文件无 groups → 空数组;脏数据丢弃) */
export function normalizeGroups(raw: unknown, liveNodeIds: string[]): NodeGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: NodeGroup[] = [];
  const seenGroupIds = new Set<string>();
  const claimed = new Set<string>(); // 一个节点只归一个组(先到先得)
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = String(o.id ?? '');
    const name = String(o.name ?? '');
    const membersRaw = Array.isArray(o.members) ? o.members : [];
    if (!id || !name || seenGroupIds.has(id)) continue;
    const members = membersRaw
      .map((m) => String(m))
      .filter((m) => liveNodeIds.includes(m) && !claimed.has(m));
    if (members.length === 0) continue;
    for (const m of members) claimed.add(m);
    seenGroupIds.add(id);
    const tone = o.tone;
    out.push({
      id,
      name,
      members,
      tone:
        tone === 'accent' || tone === 'success' || tone === 'warn' ? tone : 'neutral',
      createdAt: String(o.createdAt ?? new Date().toISOString()),
    });
  }
  return out;
}
