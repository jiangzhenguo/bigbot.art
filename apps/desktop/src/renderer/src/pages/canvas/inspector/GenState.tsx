/**
 * GenState — 生成状态面板(gstate:待生成 / 排队中 / 生产中 / 已完成 / 失败)
 * 由队列 jobs + 节点产物/Take 推导;含取消 / 重新生成 / 下载模型等行动。
 */
import React from 'react';
import type { RenderJob } from '@bigbotart/shared';
import type { CanvasNode } from '../types';

export interface GenStateProps {
  node: CanvasNode;
  jobs: RenderJob[];
  /** 本节点 Take 数量(≥0;空 Take 展示用) */
  takesCount: number;
  runNode: (nodeId: string) => void;
  toastMsg: (m: string) => void;
  /** 当前模型已下载?(failed 态「下载模型」行动) */
  modelDownloaded?: boolean;
  onDownloadModel?: () => void;
}

export type NodePhase = 'queued' | 'running' | 'failed' | 'done' | 'pending';

/** 从队列 + 节点状态推导本节点运行阶段 */
export function nodeJobPhase(
  node: CanvasNode,
  jobs: RenderJob[],
  takesCount: number,
): { phase: NodePhase; job?: RenderJob; queuePos?: number; queueLen?: number } {
  const mine = jobs.filter((j) => j.nodeId === node.id);
  const queued = mine.filter((j) => j.status === 'queued').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  if (queued.length > 0) {
    const allQueued = jobs.filter((j) => j.status === 'queued').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const pos = allQueued.findIndex((j) => j.id === queued[0]!.id);
    return { phase: 'queued', job: queued[0], queuePos: pos + 1, queueLen: allQueued.length };
  }
  const running = mine.find((j) => j.status === 'running');
  if (running) return { phase: 'running', job: running };
  const failed = mine.filter((j) => j.status === 'failed').sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
  if (failed.length > 0) return { phase: 'failed', job: failed[failed.length - 1] };
  const hasProduct = !!String((node.data as Record<string, unknown>)?.resultPath ?? '');
  return { phase: hasProduct || takesCount > 0 ? 'done' : 'pending' };
}

export function GenStatePanel(p: GenStateProps) {
  const { node, jobs, takesCount, runNode, toastMsg, modelDownloaded, onDownloadModel } = p;
  const d = (node.data ?? {}) as Record<string, unknown>;
  const st = nodeJobPhase(node, jobs, takesCount);
  const cancel = (jobId: string) => {
    void window.bigbotart
      .cancelRender('mlxgen', { providerTaskId: jobId })
      .then(() => toastMsg('已取消任务'))
      .catch(() => toastMsg('取消失败,见主进程日志'));
  };

  if (st.phase === 'pending') {
    return (
      <div className="gstate pend" data-od-id="gstate-pend">
        <div className="gs-h">
          <span className="dot warn"></span>
          <b>待生成</b>
          <span className="right">空 Take {takesCount}</span>
        </div>
        <div className="gs-sub">点击下方主行动按钮开始生成;中途可取消;产物自动落入 Take 历史。</div>
      </div>
    );
  }

  if (st.phase === 'queued') {
    const pos = st.queuePos ?? 1;
    const len = st.queueLen ?? 1;
    return (
      <div className="gstate run" data-od-id="gstate-queued">
        <div className="gs-h">
          <span className="dot run"></span>
          <b>排队中 · 队列第 {pos} 位</b>
          <span className="right">图片槽位互斥</span>
        </div>
        <div className="qbar">
          {Array.from({ length: Math.max(3, len) }).map((_, i) => (
            <div key={i} className={`qbar-pip${i < pos ? ' on' : ''}`} />
          ))}
        </div>
        <div className="gs-sub">上游任务还在采样(图片槽位互斥);表单可继续编辑,提交按最新参数生效。</div>
        <div className="gs-acts">
          <span className="grow"></span>
          <button
            className="btn btn-s btn-sm"
            type="button"
            style={{ color: 'var(--danger)', borderColor: 'color-mix(in oklab, var(--danger) 35%, var(--border))' }}
            onClick={() => st.job && cancel(st.job.id)}
          >
            取消排队
          </button>
        </div>
      </div>
    );
  }

  if (st.phase === 'running') {
    const pct = Math.round((st.job?.progress ?? 0) * 100);
    return (
      <div className="gstate run" data-od-id="gstate-running">
        <div className="gs-h">
          <span className="dot run"></span>
          <b>{st.job?.stage || '采样中'}</b>
          <span className="right">{pct}%</span>
        </div>
        <div className="pbar"><i style={{ width: `${Math.max(2, pct)}%` }} /></div>
        <div className="gs-sub">mlxgen 本地推理中 · 完成前表单锁定,避免状态错乱。</div>
        <div className="gs-acts">
          <span className="grow"></span>
          <button className="btn btn-s btn-sm" type="button" onClick={() => toastMsg('完整日志见主进程日志面板')}>查看日志</button>
          <button
            className="btn btn-s btn-sm"
            type="button"
            style={{ color: 'var(--danger)', borderColor: 'color-mix(in oklab, var(--danger) 35%, var(--border))' }}
            onClick={() => st.job && cancel(st.job.id)}
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  if (st.phase === 'failed') {
    const err = st.job?.error ?? '未知错误';
    const wantsModel = /download|模型未下载|not found|require/i.test(err);
    return (
      <div className="gstate err" data-od-id="gstate-err">
        <div className="gs-h">
          <span className="dot err"></span>
          <b>失败</b>
          <span className="right">exit ≠ 0</span>
        </div>
        <div className="diag">{err.slice(0, 260)}</div>
        <div className="gs-acts">
          <span className="gs-sub grow" style={{ fontSize: 10.5 }}>
            {wantsModel ? '模型未下载 · 点击「下载模型」开始真实下载,完成后可重试' : '诊断来自 stderr 尾部 · 可重试或调整参数'}
          </span>
          <button className="btn btn-s btn-sm" type="button" onClick={() => toastMsg('完整日志见主进程日志面板(调试日志)')}>查看完整日志</button>
          {wantsModel && !modelDownloaded ? (
            <button className="btn btn-s btn-sm" type="button" style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }} onClick={onDownloadModel}>下载模型 →</button>
          ) : null}
        </div>
      </div>
    );
  }

  const takeName = typeof d.currentTakeId === 'string' ? d.currentTakeId : `Take ${Math.max(1, takesCount)}`;
  return (
    <div className="gstate ok" data-od-id="gstate-ok">
      <div className="gs-h">
        <span className="dot ok"></span>
        <b>已完成 · {takeName}</b>
        <span className="right">{Array.isArray(d.seeds) && d.seeds.length ? `seed ${d.seeds[0]}` : ''}</span>
      </div>
    </div>
  );
}