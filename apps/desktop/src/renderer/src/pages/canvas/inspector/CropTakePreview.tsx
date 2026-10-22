import React, { useEffect, useState } from 'react';
import type { ShotTakeHistory, Take } from '@bigbotart/shared';
import type { CanvasNode } from '../types';
import { ImagePreview } from './ImagePreview';
import { previewUrlOf } from '../media';
import { SaveToLibraryButton } from './SaveToLibraryButton';

interface CropTakePreviewProps {
  node: CanvasNode;
  projectId: string | null;
  /** 源图路径(Asset ID 直绑 / 连线上游解析结果);无产物/无 Take 时的兜底预览 */
  srcFallback?: string | null;
  toastMsg?: (m: string) => void;
  onSaved?: () => void;
}

/** 与 ImageTakeSection 同口径的默认 Take 产物:currentTakeId → 最新成功且有产物 → 最新一条 */
function defaultTakePath(takes: Take[], boundTakeId?: string): string | null {
  if (boundTakeId) {
    const t = takes.find((x) => x.id === boundTakeId);
    if (t?.resultPath) return t.resultPath;
  }
  const ok = takes.find((x) => x.status === 'succeeded' && x.resultPath);
  return ok?.resultPath ?? null;
}

/**
 * 裁剪节点预览:默认显示「已生成的 Take」的裁剪结果(与 Take 历史选中逻辑同口径,
 * 不依赖 node.data.resultPath 是否持久化);无产物时回退源图;都没有时提示。
 */
export function CropTakePreview({ node, projectId, srcFallback, toastMsg, onSaved }: CropTakePreviewProps) {
  const [hist, setHist] = useState<ShotTakeHistory | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    void window.bigbotart
      .takesHistory(projectId, node.id)
      .then((h) => {
        if (alive) setHist(h);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [projectId, node.id]);

  const d = (node.data ?? {}) as Record<string, unknown>;
  const direct = String(d.resultPath ?? '');
  const boundTakeId = typeof d.currentTakeId === 'string' ? d.currentTakeId : undefined;
  const takePath = defaultTakePath(hist?.takes ?? [], boundTakeId);
  const haveResult = !!direct || !!takePath;
  const src = direct || takePath || srcFallback || null;

  const resultPath = direct || takePath || '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <ImagePreview
        src={src ? previewUrlOf(src) : null}
        label={haveResult ? '裁剪结果' : '源图预览'}
        emptyHint={
          haveResult
            ? undefined
            : '生成后显示裁剪结果 · 未生成时显示源图(连一个 图片生成/编辑/增强 节点或 asset)'
        }
      />
      {haveResult && toastMsg ? (
        <SaveToLibraryButton
          projectId={projectId}
          items={[{ nodeId: node.id, path: resultPath, name: node.title }]}
          toastMsg={toastMsg}
          onSaved={onSaved}
        />
      ) : null}
    </div>
  );
}