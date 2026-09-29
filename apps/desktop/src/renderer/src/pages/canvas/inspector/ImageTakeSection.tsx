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

/** 生成时长(秒):优先墙钟耗时 elapsedSec,历史数据缺该字段时回退 durationSec */
export function takeElapsedSec(t: { elapsedSec?: number; durationSec?: number }): number | undefined {
  return t.elapsedSec ?? t.durationSec;
}

export function ImageTakeSection({ node, projectId, jobs, onSelectTake, toastMsg }: ImageTakeSectionProps) {
  const [hist, setHist] = useState<ShotTakeHistory | null>(null);

  const refreshHist = useCallback(() => {
    if (!projectId) return;
    void window.bigbotart.takesHistory(projectId, node.id).then(setHist).catch(() => setHist(null));
  }, [projectId, node.id]);

  useEffect(() => {
    refreshHist();
  }, [refreshHist]);

  // 任务提交/完成时自动刷新:按本节点 job 签名变化才重拉(避免长跑轮询重复请求)
  const jobSigRef = useRef('');
  useEffect(() => {
    const mine = jobs.filter((j) => j.nodeId === node.id);
    const sig = `${node.id}|${mine.map((j) => `${j.id}:${j.status}`).join(',')}`;
    if (sig === jobSigRef.current) return;
    jobSigRef.current = sig;
    refreshHist();
  }, [jobs, node.id, refreshHist]);

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
              T{t.attempt} · {t.status === 'succeeded' ? (t.resultPath ? '✓' : '✓·空') : t.status === 'failed' ? '✗' : t.status}
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
