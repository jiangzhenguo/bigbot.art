/**
 * ToolRunCard — 本轮工具执行聚合卡(设计文档 §3 / agent-cards.html ②)
 *
 * 一次用户消息对应的整轮工具调用聚合为一张卡:
 * - 默认收起为一行摘要「⚙ 本轮执行 N 个工具 · M 成功 · K 失败」
 * - 卡片级展开/收起 + 行级详情(参数 JSON 截断 240 字符,结果全文 pre-wrap)
 * - 异常优先:有失败时红点 + 摘要红字,卡片与失败行自动展开
 * - 有 nodeId 的行带「定位 →」
 */
import React, { useEffect, useRef, useState } from 'react';
import type { ChatMedia, ToolRun } from '../types';
import { AudioPlayer } from '../../canvas/media';

const ARG_TRUNCATE = 240;

/** 参数一行摘要(收起行时展示):key: value · key: value */
function argSummary(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`)
    .join(' · ');
}

/** 参数 JSON(截断 240 字符,尾部 …) */
function argsJson(args: Record<string, unknown>): string {
  const s = JSON.stringify(args);
  return s.length > ARG_TRUNCATE ? `${s.slice(0, ARG_TRUNCATE)}…` : s;
}

const GearIcon = (
  <svg className="trc-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <circle cx="12" cy="12" r="3.1" />
    <path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7 5.5 18.5M18.5 18.5l-1.8-1.8M7.3 7.3 5.5 5.5" />
  </svg>
);
const ChevronDown = (
  <svg className="trc-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
    <path d="m6 9 6 6 6-6" />
  </svg>
);
const ChevronRight = (
  <svg className="tr-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
    <path d="m9 6 6 6-6 6" />
  </svg>
);
const CheckIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
    <path d="m4.5 12.5 5 5 10-11" />
  </svg>
);
const CrossIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

/** 行内产物媒体(成功且能解析到节点产物时;图片/视频缩略 + 音频播放器,与节点卡同一渲染通道) */
function RunMedia({ media }: { media: ChatMedia }) {
  if (media.kind === 'image') return <img className="tr-media" src={media.url} alt="" />;
  if (media.kind === 'video') return <video className="tr-media" src={media.url} controls preload="metadata" />;
  return <AudioPlayer src={media.url} compact />;
}

export function ToolRunCard({
  runs,
  onLocate,
  resolveMedia,
}: {
  runs: ToolRun[];
  onLocate: (nodeId: string) => void;
  /** 节点 → 产物媒体(成功行内联显示生成结果;缺省不显示) */
  resolveMedia?: (nodeId: string) => ChatMedia | null;
}) {
  const errIdxs = runs.map((r, i) => (r.status === 'error' ? i : -1)).filter((i) => i >= 0);
  const hasErr = errIdxs.length > 0;
  const okCount = runs.filter((r) => r.status === 'success').length;
  const runCount = runs.filter((r) => r.status === 'running').length;

  const [cExpanded, setCExpanded] = useState(hasErr);
  const [openRows, setOpenRows] = useState<ReadonlySet<number>>(() => new Set(errIdxs));
  // 用户手动收起过卡片后,后续新失败不再强制展开(尊重用户选择)
  const userToggled = useRef(false);

  /* 异常优先:运行中新出现失败 → 卡片自动展开 + 失败行自动展开 */
  useEffect(() => {
    if (!hasErr) return;
    setOpenRows((prev) => {
      const next = new Set(prev);
      for (const i of errIdxs) next.add(i);
      return next;
    });
    if (!userToggled.current) setCExpanded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs]);

  const toggleRow = (i: number) => {
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  return (
    <div className={`trc${hasErr ? ' err' : ''}${cExpanded ? ' open' : ''}`} data-od-id="agent-tools">
      <button
        className="trc-head"
        type="button"
        aria-expanded={cExpanded}
        onClick={() => {
          userToggled.current = true;
          setCExpanded((v) => !v);
        }}
      >
        {GearIcon}
        {hasErr ? <span className="trc-dot"></span> : null}
        <span className="trc-sum">
          本轮执行 <b>{runs.length}</b> 个工具
          {runCount > 0 ? (
            <>
              {' '}· <b>{okCount}</b> 成功 · <b>{runCount}</b> 运行中
            </>
          ) : hasErr ? (
            <>
              {' '}· <b>{okCount}</b> 成功 · <span className="err-n">{errIdxs.length} 失败</span>
            </>
          ) : (
            ' · 全部成功'
          )}
        </span>
        {ChevronDown}
      </button>
      <div className="trc-body">
        {runs.map((r, i) => {
          const rowOpen = openRows.has(i);
          const cls = r.status === 'error' ? 'err' : r.status === 'running' ? 'running' : 'ok';
          // 成功的产物类调用(engine.submit / frames.extract 等带 nodeId 的):内联显示节点产物。
          // 解析在渲染期进行 —— 提交成功时产物可能还没跑完,队列完成后 nodes/takeResults 更新,
          // 这里随重渲染自动补上媒体(不存快照,永远反映最新产物)。
          const media = r.status === 'success' && r.nodeId && resolveMedia ? resolveMedia(r.nodeId) : null;
          return (
            <div className={`tr-row ${cls}${rowOpen ? ' open' : ''}`} key={`${r.name}-${i}`}>
              <button className="tr-rh" type="button" aria-expanded={rowOpen} onClick={() => toggleRow(i)}>
                {ChevronRight}
                <span className="tr-nm">{r.name}</span>
                <span className="tr-st">
                  {r.status === 'running' ? (
                    <>
                      <span className="spin sm"></span>运行中
                    </>
                  ) : r.status === 'error' ? (
                    <>{CrossIcon}失败</>
                  ) : (
                    <>{CheckIcon}成功</>
                  )}
                </span>
                {r.nodeId ? (
                  <span
                    className="locate"
                    onClick={(e) => {
                      e.stopPropagation();
                      onLocate(r.nodeId!);
                    }}
                  >
                    定位 →
                  </span>
                ) : null}
              </button>
              {!rowOpen && Object.keys(r.args).length > 0 ? <div className="tr-arg">{argSummary(r.args)}</div> : null}
              {rowOpen ? (
                <div className="tr-detail">
                  <div className="tr-sec">
                    <div className="tr-k">参数</div>
                    <pre className="tr-v">{argsJson(r.args)}</pre>
                  </div>
                  {r.result ? (
                    <div className="tr-sec">
                      <div className="tr-k">{r.status === 'error' ? '错误' : '结果'}</div>
                      <pre className={`tr-v${r.status === 'error' ? ' err' : ''}`}>{r.result}</pre>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {media ? <RunMedia media={media} /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ToolRunCard;
