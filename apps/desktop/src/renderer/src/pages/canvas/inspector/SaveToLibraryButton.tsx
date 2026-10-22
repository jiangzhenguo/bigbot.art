/**
 * 把节点产物存进当前项目资源库。
 * 名称用节点标题，文案用提示词（有则写入资产 caption，Agent 之后能直接读）。
 */
import React from 'react';

export interface LibrarySaveItem {
  nodeId: string;
  path: string;
  name?: string;
  caption?: string;
}

export function SaveToLibraryButton({
  projectId,
  items,
  toastMsg,
  onSaved,
  label = '存入资源库',
}: {
  projectId: string | null;
  items: LibrarySaveItem[];
  toastMsg: (m: string) => void;
  onSaved?: () => void;
  label?: string;
}) {
  const ready = items.filter((it) => it.path);
  if (!ready.length) return null;
  const onClick = () => {
    if (!projectId) {
      toastMsg('没有打开的项目，无法存入资源库');
      return;
    }
    void window.bigbotart
      .archiveProducts({
        projectId,
        items: ready.map((it) => ({
          nodeId: it.nodeId,
          path: it.path,
          name: it.name?.trim() || undefined,
          caption: it.caption?.trim() || undefined,
        })),
      })
      .then((r) => {
        if (!r.ok || !r.assets.length) {
          toastMsg(`存入失败：${r.error || '产物文件不存在'}`);
          return;
        }
        const first = r.assets[0]!;
        const extra = r.assets.length > 1 ? ` 等 ${r.assets.length} 项` : '';
        const cap = first.caption ? ' · 文案已保存' : '';
        toastMsg(`已存入资源库 ·「${first.name}」${extra}${cap}`);
        onSaved?.();
      })
      .catch(() => toastMsg('存入资源库失败'));
  };
  return (
    <button className="btn btn-s btn-sm" data-od-id="cta-archive" type="button" onClick={onClick}>
      {label}
    </button>
  );
}
