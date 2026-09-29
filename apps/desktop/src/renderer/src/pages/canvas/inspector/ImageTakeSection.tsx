/**
 * ImageTakeSection — 图片类节点(image-gen / image-edit / image-upscale / image-crop)的 Take 历史
 *
 * 图片节点从 P1 起与 shot 一样记录 Take(每次生成一条,保留历史不覆盖):
 * - 提交前渲染层 takesCreate(queued) → 队列完成/调用侧 takesPatch 写终态
 * - 这里展示 attempt 列表,点击切换:回写节点 resultPath / currentTakeId 并清 ghost/stale
 * 纯展示 + 数据刷新;产物写画布通过 onSelectTake 回调由页面完成。
 *
 * 每条 Take 都显示**生成时长**,并保留**生成时用过的提示词**(存档在 `Take.params.prompt`);
 * 切换 Take 时把该条提示词原样回显出来 —— chip 悬停看全文,当前 Take 在下方给只读全文。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { RenderJob, ShotTakeHistory } from '@bigbotart/shared';
import type { CanvasNode } from '../types';
import { formatDurationSec } from '../media';

export interface ImageTakeSectionProps {
  node: CanvasNode;
  projectId: string | null;
  jobs: RenderJob[];
  /** 切换 Take:把产物写回节点(与 shot 检查器 onSelectTake 同语义);拆分节点附带 pieces 恢复 */
  onSelectTake?: (take: { id: string; attempt: number; status: string; resultPath?: string; pieces?: string[] }) => void;
  toastMsg: (msg: string) => void;
}

/** Take 存档的生成提示词(`params.prompt`,提交时由渲染层 runNode / Agent engine.submit 写入) */
export function takePromptOf(t: { params?: unknown }): string {
  return String((t.params as { prompt?: string } | undefined)?.prompt ?? '');
}

/**
 * Take 状态的界面文案。
 * 2026-09-29 修复:此前 queued/running 直接把英文原样渲染成「queued」,用户看到一条
 * 明明已完成的记录写着英文状态,极易误判成「还卡在排队中」。这里统一映射为中文。
 */
export function takeStatusLabel(t: { status?: string; resultPath?: string }): string {
  switch (t.status) {
    case 'succeeded':
      return t.resultPath ? '✓' : '✓·无产物';
    case 'failed':
      return '✗';
    case 'queued':
      return '排队中';
    case 'running':
      return '生成中';
    case 'cancelled':
      return '已取消';
    default:
      return t.status ?? '未知';
  }
}

/** 生成时长(秒):优先墙钟耗时 elapsedSec,历史数据缺该字段时回退 durationSec */
export function takeElapsedSec(t: { elapsedSec?: number; durationSec?: number }): number | undefined {
  return t.elapsedSec ?? t.durationSec;
}

/**
 * 计算「需要重拉 Take 历史」的签名。
 *
 * ⚠️ 为什么不能只看 job 状态(2026-09-29 真实事故:图片生成成功后 chip 一直停在「排队中」):
 * 此前签名 = `nodeId | job.id:status,...`,只在**本节点的 job 出现在 `jobs` 列表里**时才会变。
 * 但 `RenderQueue` 的 jobs 是**纯内存**的 —— 应用重启 / 窗口重载 / 切画布再回来之后,
 * 队列里根本没有这条 job(签名恒为 `<nodeId>|`),effect 首次挂载拉一次后就**永不重拉**,
 * 于是磁盘上早已是 `succeeded` 的 Take 在界面上永远显示「排队中」。
 * 现在把**节点产物路径**也纳入签名:`resultPath` 出现/变化(队列完成回写、切换 Take、Agent 回写)
 * 本身就是一个「历史一定变了」的强信号,与 job 是否存在无关。
 */
export function takeRefreshSig(
  nodeId: string,
  jobs: Array<{ nodeId: string; id: string; status: string }>,
  dataResultPath: unknown,
): string {
  const mine = jobs.filter((j) => j.nodeId === nodeId);
  const jobPart = mine.map((j) => `${j.id}:${j.status}`).join(',');
  const pathPart = typeof dataResultPath === 'string' ? dataResultPath : '';
  return `${nodeId}|${jobPart}|${pathPart}`;
}

/** 历史里是否还有未终态记录(queued/running)——有则不信任本次结果,短延时复检 */
export function hasUnsettledTake(takes: Array<{ status?: string }> | undefined): boolean {
  return Array.isArray(takes) && takes.some((t) => t.status === 'queued' || t.status === 'running');
}

export function ImageTakeSection({ node, projectId, jobs, onSelectTake, toastMsg }: ImageTakeSectionProps) {
  const [hist, setHist] = useState<ShotTakeHistory | null>(null);
  /** 卸载后不回写(setState on unmounted component) */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refreshHist = useCallback(async (): Promise<void> => {
    if (!projectId) return;
    try {
      const h = await window.bigbotart.takesHistory(projectId, node.id);
      if (!aliveRef.current) return;
      setHist(h);
      /* 落盘竞态兜底:主进程 `finishJob` 已改为「Take 终态先落盘再 notify」,但
         「任务已完成、Take 仍是 queued」这条路上没有任何**主动**重试 —— 一旦某次
         恰好在 patch 落盘前读盘,界面就永久定格在错误状态,只能靠用户手点一下。
         这里对「读到未终态记录」做一次短延时复检(仅一次,不轮询),把这类竞态收敛掉。 */
      if (hasUnsettledTake(h?.takes)) {
        window.setTimeout(() => {
          if (!aliveRef.current) return;
          void window.bigbotart
            .takesHistory(projectId, node.id)
            .then((again) => {
              if (aliveRef.current) setHist(again);
            })
            .catch(() => {
              /* 复检失败保留首次结果,不静默清空 */
            });
        }, 1200);
      }
    } catch {
      if (aliveRef.current) setHist(null);
    }
  }, [projectId, node.id]);

  /* 任务提交/完成 + 节点产物变化时自动刷新(单一入口,避免挂载时重复请求)。
     签名同时含 job 状态与 `data.resultPath`:后者保证「job 已不在队列里」(重启/重载/
     切画布)时依然能因产物出现而重拉 —— 只看 job 的老写法在这些场景下永不刷新。
     首挂载 `sigRef` 为空 → 签名必然不同 → 必定拉一次,旧行为保持不变。 */
  const sigRef = useRef('');
  useEffect(() => {
    const sig = takeRefreshSig(node.id, jobs, node.data?.resultPath);
    if (sig === sigRef.current) return;
    sigRef.current = sig;
    void refreshHist();
  }, [jobs, node.id, node.data?.resultPath, refreshHist]);

  const takes = hist?.takes ?? [];
  if (takes.length === 0) return null;

  /** 当前选中:手动 → 节点绑定 → 最新成功且有产物 → 最新一条 */
  const boundTakeId = typeof node.data?.currentTakeId === 'string' ? node.data.currentTakeId : undefined;
  const curTake =
    (boundTakeId ? takes.find((t) => t.id === boundTakeId) : undefined)
    ?? takes.find((t) => t.status === 'succeeded' && !!t.resultPath)
    ?? takes[0]
    ?? null;

  const curPrompt = curTake ? takePromptOf(curTake) : '';
  const curTook = curTake ? formatDurationSec(takeElapsedSec(curTake)) : null;

  const selectTake = (t: (typeof takes)[number]) => {
    onSelectTake?.({
      id: t.id,
      attempt: t.attempt,
      status: t.status,
      resultPath: t.resultPath,
      // image-split 一次运行记一条 Take、params.pieces 存全部切片;切换时一并恢复
      pieces: Array.isArray((t.params as { pieces?: unknown } | undefined)?.pieces)
        ? ((t.params as { pieces: unknown[] }).pieces as string[])
        : undefined,
    });
    toastMsg(`已切换图片 Take ${t.attempt}${t.resultPath ? ' · 预览已更新' : ' · 无产物文件'}`);
  };

  return (
    <div className="f-sec" data-od-id="image-take-history">
      <div className="lbl">Take 历史(图片节点 · P1)</div>
      <div className="f-chips" style={{ flexWrap: 'wrap' }}>
        {takes.slice(0, 10).map((t) => {
          const took = formatDurationSec(takeElapsedSec(t));
          const pr = takePromptOf(t);
          // 悬停给全量信息:状态 / 生成时长 / 生成时提示词 / 产物路径(失败给错误)
          const title = [
            `Take ${t.attempt} · ${t.status}`,
            `生成时长 ${took ?? '未知'}`,
            pr ? `提示词:${pr}` : '无提示词存档',
            t.resultPath ?? t.error,
          ]
            .filter(Boolean)
            .join('\n');
          return (
            <span
              key={t.id}
              className={`chip${t.id === curTake?.id ? ' on' : ''}${t.status === 'failed' ? ' dis' : ''}`}
              onClick={() => selectTake(t)}
              title={title}
            >
              T{t.attempt} · {takeStatusLabel(t)}
              {/* 生成时长:每条 Take 都显示;缺失显式写「时长未知」,不装作没这回事 */}
              <span className="mut" style={{ fontSize: 10, marginLeft: 4 }}>{took ?? '时长未知'}</span>
            </span>
          );
        })}
      </div>
      {takes.length > 10 ? <div className="f-hint">共 {takes.length} 条 · 仅显示最近 10 条</div> : null}

      {/* 当前 Take 的生成提示词(只读回显):切换 Take 即随之切换 */}
      {curTake ? (
        <div data-od-id="image-take-prompt" style={{ marginTop: 8 }}>
          <div className="f-hint" style={{ marginBottom: 4 }}>
            当前 Take T{curTake.attempt} 的生成提示词{curTook ? ` · 生成时长 ${curTook}` : ''}
            {curPrompt ? '' : ' · 该 Take 未存档提示词'}
          </div>
          {curPrompt ? <textarea className="f-ta short mono" rows={3} readOnly value={curPrompt} /> : null}
        </div>
      ) : null}
    </div>
  );
}
