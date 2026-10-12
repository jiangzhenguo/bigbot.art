/**
 * useTakeResult — 图片节点产物兜底(2026-09-29)
 *
 * **问题**:节点 `data.resultPath` 是队列完成时由渲染层回写的,但回写可能失败/滞后
 * (真实事故:`pal7-lfy3` 的 Take 记录里 resultPath 完整、产物文件也生成了,而节点
 *  `data.resultPath` 始终为空 → 检查器预览不显示、归档按钮失效、节点卡不出图)。
 * 而检查器一直**只读 `data.resultPath`**,没有任何兜底。
 *
 * **本 hook 的口径与 shot 节点既有的 `takeResults` 完全一致**:`data.resultPath` 为空时,
 * 回退到该节点 Take 历史里**最新一条 status=succeeded 且有 resultPath** 的产物。
 * 这样「Take 已落盘但节点没回写」这种状态不再让用户看到"什么都没有"。
 *
 * 刷新时机:节点 id 变化、`data.resultPath` 变化、本节点 job 状态变化(生成完成后拉一次)。
 */
import { useEffect, useRef, useState } from 'react';
import type { RenderJob } from '@bigbotart/shared';

/** 从 Take 历史里挑出「最新成功且有产物」的 resultPath(与 ImageTakeSection 的 curTake 同口径) */
export function pickTakeResultPath(takes: Array<{ status?: string; resultPath?: string }> | undefined): string | undefined {
  if (!Array.isArray(takes)) return undefined;
  // 历史按时间正序追加 → 从后往前找第一条成功且有产物的
  for (let i = takes.length - 1; i >= 0; i--) {
    const t = takes[i];
    if (t?.status === 'succeeded' && t.resultPath) return t.resultPath;
  }
  return undefined;
}

/**
 * 项目全部 Take → 「节点 id → 最新成功产物路径」映射(2026-10)。
 *
 * 为什么需要:画布侧原先只对 **shot** 节点逐个 `takesHistory` 回填产物
 * (`refreshTakeResults`),而 video-upscale / 图片类节点的产物**只**靠
 * 「任务完成时渲染层 setNodes 回写 data.resultPath」。真实事故(飞机1 · new1-gta1):
 * 视频增强跑了 82 分钟,期间用户离开画布页 → 那次 setState 落在已卸载组件上被丢弃,
 * 而 Take 已由同一次回写流程写进主进程 → 磁盘上有产物、Take 里 resultPath 完整,
 * 节点 data 却是空的 ⇒ 节点卡/检查器都不显示,只有「什么都不出」可看。
 *
 * 一次性取回全部 Take(单次 IPC,优于逐节点 takesHistory)后按节点归组:
 * 调用方按 `createdAt` 倒序传入(takesList 的既有顺序),每个节点第一条命中的即最新。
 */
export function latestTakeResultByNode(
  takes: Array<{ shotNodeId?: string; status?: string; resultPath?: string }> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of takes ?? []) {
    if (!t?.shotNodeId || t.status !== 'succeeded' || !t.resultPath) continue;
    if (out[t.shotNodeId]) continue; // 倒序输入 → 先到者最新
    out[t.shotNodeId] = t.resultPath;
  }
  return out;
}

export function useTakeResult(
  nodeId: string,
  projectId: string | null,
  dataResultPath: unknown,
  jobs: RenderJob[],
): string | undefined {
  const direct = typeof dataResultPath === 'string' && dataResultPath ? dataResultPath : undefined;
  const [fallback, setFallback] = useState<string | undefined>(undefined);
  const sigRef = useRef('');
  /** 上次已解析到的兜底路径:参与签名,路径变化(切换 Take)时强制重拉 */
  const lastResolvedRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    // 节点自己已有 resultPath → 不需要兜底(仍然清掉旧兜底值,避免切 Take 后残留)
    if (direct) {
      setFallback(undefined);
      sigRef.current = ''; // 复位签名:下次 resultPath 变空时要重新拉兜底
      return;
    }
    if (!projectId || !nodeId) return;
    const mine = jobs.filter((j) => j.nodeId === nodeId);
    const sig = `${nodeId}|${mine.map((j) => `${j.id}:${j.status}`).join(',')}`;
    // ⚠️ 2026-09-29 修复「切换 Take 后预览消失」:此前只按 job 签名去重,而**切换 Take 不产生
    // 新 job**(`jobs` 不变 → sig 不变)⇒ 这里直接 return ⇒ fallback 永远停在 undefined
    // ⇒ 用户切到另一条 Take 时预览空白。现在额外比对「上次已解析到的路径」(`lastSigRef`),
    // 目标路径变化就重拉;`direct` 归空时也在上面复位,保证必然重取。
    const sigWithState = `${sig}|${lastResolvedRef.current ?? ''}`;
    if (sigWithState === sigRef.current) return;
    sigRef.current = sigWithState;
    let alive = true;
    void window.bigbotart
      .takesHistory(projectId, nodeId)
      .then((h) => {
        if (!alive) return;
        const picked = pickTakeResultPath(h?.takes);
        lastResolvedRef.current = picked;
        setFallback(picked);
      })
      .catch(() => {
        /* 单个节点失败不影响其余;保持 undefined 即可(不静默改状态) */
      });
    return () => {
      alive = false;
    };
  }, [nodeId, projectId, direct, jobs]);

  return direct ?? fallback;
}
