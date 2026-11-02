import type { CanvasNode } from './types';

export interface ImageSize {
  width: number;
  height: number;
}

export type ImageSizeProbe = (path: string) => Promise<Partial<ImageSize> & { ok?: boolean }>;

function validSize(width: unknown, height: unknown): ImageSize | undefined {
  const w = Number(width ?? 0);
  const h = Number(height ?? 0);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { width: w, height: h } : undefined;
}

/** 解析首帧上游图片尺寸；优先节点/资产元数据，产物文件探测在缺失时兜底。 */
export async function resolveUpstreamImageSize(
  src: CanvasNode,
  assets: Array<{ id: string; localPath?: string; width?: number; height?: number }>,
  probe: ImageSizeProbe,
): Promise<ImageSize | undefined> {
  const data = (src.data ?? {}) as Record<string, unknown>;
  const asset = src.kind === 'asset'
    ? assets.find((a) => a.id === String(data.assetId ?? ''))
    : undefined;
  const metadataSize = validSize(asset?.width, asset?.height) ?? validSize(data.width, data.height);
  if (metadataSize) return metadataSize;

  // image-edit / image-crop 等老节点只保存 resultPath，没有 width/height；必须读真实产物，
  // 否则 1:1 首帧也会在创建 shot 时静默退回弹层默认 16:9。
  const resultPath = typeof data.resultPath === 'string' ? data.resultPath.trim() : '';
  const path = resultPath || asset?.localPath || '';
  if (!path) return undefined;
  try {
    const info = await probe(path);
    if (info.ok === false) return undefined;
    return validSize(info.width, info.height);
  } catch {
    return undefined;
  }
}
