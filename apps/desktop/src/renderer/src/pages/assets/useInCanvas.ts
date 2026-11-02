import type { Asset, BigBotArtApi, CanvasNode, CanvasSnapshot, ProjectCanvases } from '@bigbotart/shared';

const ASSET_NODE_WIDTH = 224;
const ASSET_NODE_HEIGHT = 200;
const PLACEMENT_GAP = 28;

export type CanvasAssetApi = Pick<BigBotArtApi, 'loadProjectCanvases' | 'saveCanvasSnapshot'>;

export interface AssetNodeAppendResult {
  snapshot: CanvasSnapshot;
  node: CanvasNode;
}

function newAssetNodeId(): string {
  const uuid = globalThis.crypto?.randomUUID?.().slice(0, 8);
  return `asset-${Date.now().toString(36)}-${uuid ?? Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 资源管理页没有画布 DOM，不能复用 CanvasPage 的视口中心函数。
 * 用快照里的 viewport 反推一个接近可视区中心的世界坐标，再像画布内新建节点一样找空位。
 */
function findAssetPosition(snapshot: CanvasSnapshot, width: number, height: number): { x: number; y: number } {
  const raw = snapshot.viewport;
  const z = raw && Number.isFinite(raw.z) && raw.z > 0 ? raw.z : 1;
  const vx = raw && Number.isFinite(raw.x) ? raw.x : 0;
  const vy = raw && Number.isFinite(raw.y) ? raw.y : 0;
  const cx = (640 - vx) / z;
  const cy = (360 - vy) / z;
  const overlaps = (x: number, y: number) =>
    snapshot.nodes.some((n) => {
      const nw = n.width ?? 224;
      const nh = n.height ?? 200;
      return !(
        x + width + PLACEMENT_GAP < n.position.x ||
        x - PLACEMENT_GAP > n.position.x + nw ||
        y + height + PLACEMENT_GAP < n.position.y ||
        y - PLACEMENT_GAP > n.position.y + nh
      );
    });

  if (!overlaps(cx - width / 2, cy - height / 2)) {
    return { x: cx - width / 2, y: cy - height / 2 };
  }
  for (let ring = 1; ring <= 24; ring++) {
    const count = ring * 8;
    for (let k = 0; k < count; k++) {
      const angle = (k / count) * Math.PI * 2;
      const x = cx - width / 2 + Math.round(Math.cos(angle) * ring * 48);
      const y = cy - height / 2 + Math.round(Math.sin(angle) * ring * 48);
      if (!overlaps(x, y)) return { x, y };
    }
  }
  const first = snapshot.nodes[0];
  return first
    ? { x: first.position.x + (first.width ?? 224) + PLACEMENT_GAP, y: first.position.y }
    : { x: cx - width / 2, y: cy - height / 2 };
}

/** 在快照末尾追加一个已绑定资源的真实 asset 节点；输入快照与既有节点均不被修改。 */
export function appendAssetNode(
  snapshot: CanvasSnapshot,
  asset: Asset,
  options: { id?: string; now?: string } = {},
): AssetNodeAppendResult {
  const now = options.now ?? new Date().toISOString();
  const node: CanvasNode = {
    id: options.id ?? newAssetNodeId(),
    kind: 'asset',
    label: asset.name,
    position: findAssetPosition(snapshot, ASSET_NODE_WIDTH, ASSET_NODE_HEIGHT),
    width: ASSET_NODE_WIDTH,
    height: ASSET_NODE_HEIGHT,
    data: { assetId: asset.id, mediaType: asset.kind },
    createdAt: now,
    updatedAt: now,
  };
  return { snapshot: { ...snapshot, nodes: [...snapshot.nodes, node] }, node };
}

/**
 * 把资源写入当前活动画布并持久化。
 *
 * 必须从 store 重读，不能使用 App 缓存：离开画布后的防抖保存/Agent 增量写入可能已推进版本。
 * 若保存期间仍发生并发写入，基于 store 返回的最新快照重试，绝不整体覆盖对方的新节点。
 */
export async function addAssetToActiveCanvas(
  api: CanvasAssetApi,
  projectId: string,
  asset: Asset,
): Promise<{ projectCanvases: ProjectCanvases; nodeId: string }> {
  let pc = await api.loadProjectCanvases(projectId);
  let current = pc.canvases.find((c) => c.id === pc.activeCanvasId) ?? pc.canvases[0];
  if (!current) throw new Error('当前项目没有可用画布');

  for (let attempt = 0; attempt < 3; attempt++) {
    const appended = appendAssetNode(current, asset);
    const result = await api.saveCanvasSnapshot(appended.snapshot);
    if (result.ok) {
      const saved: CanvasSnapshot = { ...appended.snapshot, version: appended.snapshot.version + 1 };
      return {
        projectCanvases: {
          ...pc,
          activeCanvasId: saved.id,
          canvases: pc.canvases.map((c) => (c.id === saved.id ? saved : c)),
        },
        nodeId: appended.node.id,
      };
    }
    if (result.stale && result.current) {
      current = result.current;
      pc = {
        ...pc,
        activeCanvasId: current.id,
        canvases: pc.canvases.some((c) => c.id === current!.id)
          ? pc.canvases.map((c) => (c.id === current!.id ? current! : c))
          : [...pc.canvases, current],
      };
      continue;
    }
    throw new Error('画布保存失败，请重试');
  }
  throw new Error('画布正在同时更新，请稍后重试');
}
