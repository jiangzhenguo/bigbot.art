/**
 * 分镜表节点检查器 — storyboard:表格主视图 + 源码次级 + 铺节点(材质化)
 * 文档 §4.2 §5.2 §6.3 §7.4 · 交互参考 document-storyboard-inspector.html / storyboard-table.html
 *
 * markdown 是唯一真源:标题 + 说明 + 一个 GFM 表格块;表格编辑原位回写表格块。
 * 铺节点只创建节点、不触发运行;改表标 stale;「重新同步」按当前表重组提示词写回。
 */
import React, { useState } from 'react';
import {
  parseGfmTable,
  replaceTableBlock,
  tableToGfm,
  sbStats,
  rowNeedsImage,
  rowSeconds,
  planStoryboardMaterializeRows,
  summarizeMaterializePlans,
} from '@bigbotart/shared';
import type { CanvasNode } from '../types';
import { sbMaterializedRows, sbImgCount, sbDirty } from '../storyboard';
import { Lbl } from './fields';
import TableEditor from '../../../components/TableEditor';

export interface StoryboardInspectorProps {
  node: CanvasNode;
  setData: (patch: Record<string, unknown>) => void;
  nodes: CanvasNode[];
  toastMsg: (msg: string) => void;
  onMaterializeStoryboard?: (sb: CanvasNode, aspect: string, tier: string) => void;
  onUndoStoryboard?: (sb: CanvasNode) => void;
  onResyncStoryboard?: (sb: CanvasNode) => void;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const DEFAULT_YN_IDX = 6; // 需配图 默认列

export default function StoryboardInspector({
  node,
  setData,
  nodes,
  toastMsg,
  onMaterializeStoryboard,
  onUndoStoryboard,
  onResyncStoryboard,
}: StoryboardInspectorProps) {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const md = String(d.markdown ?? '');
  const base = String(d.basePrompt ?? '');
  const aspect = String(d.aspect ?? '16:9');
  const tier = String(d.tier ?? 'default');
  const tbl = parseGfmTable(md);
  const head = tbl?.head ?? [];
  const rows = tbl?.rows ?? [];
  const st = sbStats(head, rows);
  const matRows = sbMaterializedRows(node.id, nodes);
  const imgCnt = sbImgCount(node.id, nodes);
  const dirty = sbDirty(node, nodes);
  /* matRows 是 1-based promptFrom.row;计划层同口径,避免 0/1 混用导致「永远有待铺行」 */
  const layPlans = planStoryboardMaterializeRows({
    head,
    rows,
    doneRows: matRows,
    canvasNodes: nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.title,
      title: n.title,
      data: (n.data ?? {}) as Record<string, unknown>,
    })),
  });
  const pending = layPlans.map((p) => p.rowNo - 1);
  const addImg = layPlans.filter((p) => p.createKeyframe).length;
  const planHint = layPlans.length ? summarizeMaterializePlans(layPlans) : '';

  const [view, setView] = useState<'tbl' | 'src'>('tbl');
  const [mode, setMode] = useState<'step' | 'auto'>('step');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [tblSnapshot, setTblSnapshot] = useState(0);
  const onTableChange = (mm: { head: string[]; body: string[][] }) => {
    const newHead = ['镜号', ...mm.head];
    const newRows = mm.body.map((r, i) => {
      const row = r.slice();
      row[0] = String(i + 1);
      while (row.length < newHead.length) row.push('');
      return row.slice(0, newHead.length);
    });
    setData({ markdown: replaceTableBlock(md, tableToGfm(newHead, newRows)) });
  };

  /* 源码次级视图:切回表格时从 markdown 重新解析(标题/说明保留在文本里) */
  const switchSrc = (v: string) => setData({ markdown: v });

  const goMaterialize = () => {
    if (!onMaterializeStoryboard) return;
    if (!pending.length) {
      toastMsg('当前行均已铺出 · 新增行后可追加铺');
      return;
    }
    if (mode === 'auto') {
      onMaterializeStoryboard(node, aspect, tier);
      return;
    }
    setConfirmOpen(true);
  };

  const addN = pending.length + addImg;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="insp-h" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Lbl>分镜表 · {node.title}</Lbl>
        <span className="badge">{st.n} 行</span>
        <span className="badge">需配图 {st.imgs}</span>
        <span className="badge">合计 {st.secs}s</span>
        <span className="mono mut" style={{ marginLeft: 'auto', fontSize: 10 }}>storyboard · 一行 = 一个分镜</span>
      </div>

      <div className="f-row" style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <span className="chip" style={{ fontSize: 11, padding: '3px 10px' }} onClick={() => setMode(mode === 'step' ? 'auto' : 'step')}>
          模式 · {mode === 'step' ? '分步' : '自动'}
        </span>
        <span className="f-hint">{mode === 'step' ? '铺节点前弹确认 · 每一步可干预' : '点「生成节点」直接铺 · 跳过确认'}</span>
      </div>

      <div>
        <div className="lbl" style={{ marginBottom: 4 }}>全局质感段 basePrompt(铺节点时注入每一行)</div>
        <textarea
          className="f-ta"
          style={{ minHeight: 54, width: '100%' }}
          aria-label="全局质感段"
          value={base}
          onChange={(e) => setData({ basePrompt: e.target.value })}
        />
      </div>

      <div>
        <div className="f-row" style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <Lbl>视图</Lbl>
          <div className="f-chips" style={{ display: 'flex', gap: 5 }}>
            <span className={`chip${view === 'tbl' ? ' on' : ''}`} onClick={() => setView('tbl')}>表格</span>
            <span className={`chip${view === 'src' ? ' on' : ''}`} onClick={() => setView('src')}>源码</span>
          </div>
          <span className="f-hint" style={{ marginLeft: 'auto' }}>表格主视图 · 「提示词」列留空 = 组装器生成</span>
        </div>

        {view === 'tbl' ? (
          <div style={{ marginTop: 6 }}>
            <TableEditor
              key={`te-${tblSnapshot}`}
              head={head.slice(1)}
              rows={rows.map((r) => r.slice(1))}
              snHead="镜号"
              snIsData
              ynCol={head.indexOf('需配图') >= 0 ? head.indexOf('需配图') - 1 : DEFAULT_YN_IDX - 1}
              wide
              csv
              pasteSample
              sampleData={() => [
                ['6', '黄昏两人并肩远去', '「明天见」', '远景', '固定', '5', '是', '', '硬切'],
                ['7', '黑场 · 片名字幕', '无', '—', '固定', '3', '否', '', '接尾帧'],
              ]}
              foot="镜号自动续号 · 删行不改其他行内容 · 已铺节点保留(仅提示) · 改表标 stale,可用「重新同步」写回"
              snapshot={tblSnapshot}
              msgFn={(mm) => {
                let imgs = 0;
                let secs = 0;
                const mhead = ['镜号', ...mm.head];
                mm.body.forEach((r, i) => {
                  if (rowNeedsImage(r, mhead)) imgs++;
                  secs += rowSeconds(r, mhead);
                });
                return `${mm.body.length} 行 · 需配图 ${imgs} · 合计 ${Math.round(secs * 10) / 10}s`;
              }}
              onChange={onTableChange}
              onChangeMsg={(op, arg) =>
                op === 'row-del'
                  ? `已删除第 ${arg} 行(已铺节点保留,仅提示)`
                  : op === 'paste'
                    ? `已导入 ${arg} 行粘贴数据`
                    : op === 'col-del'
                      ? `已删列「${arg}」`
                      : op === 'col-add'
                        ? '已加列 · 可在 columnMap 映射语义槽位'
                        : null
              }
            />
          </div>
        ) : (
          <>
            <textarea
              className="f-ta mono"
              style={{ minHeight: 230, width: '100%' }}
              aria-label="分镜表 Markdown 源码"
              spellCheck={false}
              value={md}
              onChange={(e) => switchSrc(e.target.value)}
            />
            <div className="f-hint" style={{ marginTop: 7 }}>
              源码为次级视图;切回表格时解析首个表格块原位生效,其余文字保留为表头说明。
            </div>
          </>
        )}
      </div>

      <div>
        <div className="lbl" style={{ marginBottom: 6 }}>铺节点默认值</div>
        <div className="f-row" style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <span className="f-lbl">画幅</span>
          <div className="f-chips" style={{ display: 'flex', gap: 5 }}>
            {(['16:9', '9:16', '1:1'] as const).map((a) => (
              <span key={a} className={`chip${aspect === a ? ' on' : ''}`} style={{ padding: '3px 10px' }} onClick={() => setData({ aspect: a })}>
                {a}
              </span>
            ))}
          </div>
          <span className="f-lbl">档位</span>
          <div className="f-chips" style={{ display: 'flex', gap: 5 }}>
            {([['preview', '预览'], ['default', '默认']] as const).map(([v, l]) => (
              <span key={v} className={`chip${tier === v ? ' on' : ''}`} style={{ padding: '3px 10px' }} onClick={() => setData({ tier: v })}>
                {l}
              </span>
            ))}
          </div>
        </div>
        <div className="f-hint" style={{ marginTop: 5 }}>
          时长取每行「时长(s)」列;选「预览档」可先用 256²/4 步秒级看构图,再批量转默认档。
        </div>
      </div>

      {/* 铺节点区 */}
      <div>
        {dirty && matRows.length ? (
          <div className="gstate warn">
            <div className="gs-h">
              <span className="dot stale"></span>
              <b>表格已改 · {matRows.length + imgCnt} 个下游待重新同步</b>
              <span className="right">stale</span>
            </div>
            <div className="gs-sub">改表只标 stale、不级联删节点;「重新同步」按当前表重组提示词写回已铺节点,不重建、不删除。</div>
            <div className="gs-act">
              <button className="btn btn-s btn-sm" onClick={() => onResyncStoryboard?.(node)}>重新同步</button>
            </div>
          </div>
        ) : null}

        <div className="gs-act" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-p" onClick={goMaterialize}>
            {matRows.length ? (pending.length ? `追加铺 ${pending.length} 行新节点` : '从分镜表生成节点') : '从分镜表生成节点'}
          </button>
          {matRows.length ? (
            <button className="btn btn-s btn-sm" onClick={() => onResyncStoryboard?.(node)}>重新同步</button>
          ) : null}
          {matRows.length ? (
            <button className="btn btn-s btn-sm" onClick={() => onUndoStoryboard?.(node)}>撤销铺节点</button>
          ) : null}
        </div>

        {pending.length && matRows.length ? (
          <div className="f-hint">表格新增 {pending.length} 行 · 追加铺只为新行创建节点,已铺节点不动。</div>
        ) : null}

        {confirmOpen ? (
          <div className="mat show">
            <div className="psrc-h">
              <b>{matRows.length ? '将追加创建' : '将创建'} {addN} 个节点</b>
              <span className="mono">
                {planHint || `${pending.length} shot`} · {aspect} · {tier === 'preview' ? '预览档' : '默认档'}
              </span>
            </div>
            <ul>
              <li>「衔接=硬切」不接上一镜尾帧。「角色」列点名的卡走 <span className="mono">ref-image</span>;需配图=是才另建静帧;没有卡时静帧作为 <span className="mono">first-frame</span></li>
              <li>「衔接=接尾帧」只把上一镜成片作为 <span className="mono">first-frame</span>,不再挂参考卡。同一场戏连续动作用接尾帧,不要整表硬切</li>
              <li>时长取每行「时长(s)」列;画幅与档位为全局默认,仅作用于本次铺出的节点</li>
              <li><b>只创建节点,不触发运行</b> —— 生成须逐节点或批跑,避免误烧资源;一次原子操作,可整体撤销(⌘Z)</li>
            </ul>
            <div className="gs-act" style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-p btn-sm" onClick={() => { setConfirmOpen(false); onMaterializeStoryboard?.(node, aspect, tier); }}>确认</button>
              <button className="btn btn-s btn-sm" onClick={() => setConfirmOpen(false)}>取消</button>
            </div>
          </div>
        ) : null}

        {matRows.length && !dirty ? (
          <div className="gok" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <span className="dot ok"></span>
            <span>已铺 {matRows.length} shot{imgCnt ? ` + ${imgCnt} image-gen` : ''} · 未触发运行</span>
            <span className="mono">可 ⌘Z 整体撤销</span>
          </div>
        ) : null}
      </div>

      {/* 已铺行速览(sub mini) */}
      {matRows.length ? (
        <div>
          <div className="lbl" style={{ marginBottom: 4 }}>已铺行</div>
          <div className="f-chips" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {matRows.map((r) => (
              <span key={r} className="badge">{pad2(r + 1)}{rowNeedsImage(rows[r], head) ? ' · img' : ''}</span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}