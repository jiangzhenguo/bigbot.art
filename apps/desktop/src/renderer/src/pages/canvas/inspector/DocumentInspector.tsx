/**
 * 文档节点检查器 — 文本节点(document)升级:源码 / 表格双视图 + 标记选段提示 + 文件导入
 * 文档 §4.1 §5 §6.2 · 交互参考 document-storyboard-inspector.html
 *
 * markdown 是唯一真源:源码编辑直接改 data.markdown;表格视图编辑 → 原位替换表格块。
 * 标记规则:```prompt 块 > #shot-N 标题块 > 全文注入(mode=full,现状兼容)。
 */
import React, { useRef, useState } from 'react';
import {
  parseGfmTable,
  replaceTableBlock,
  tableToGfm,
  docMarkers,
  inferPromptSource,
} from '@bigbotart/shared';
import type { CanvasNode } from '../types';
import { Lbl, KVSection } from './fields';
import TableEditor from '../../../components/TableEditor';

export interface DocumentInspectorProps {
  node: CanvasNode;
  setData: (patch: Record<string, unknown>) => void;
  toastMsg: (msg: string) => void;
  /** 「生成分镜表」→ Agent plan-storyboard */
  onPlanStoryboard?: (docNode: CanvasNode) => void;
}

export function docInjectLabel(md: string): string {
  const m = docMarkers(md);
  if (m.prompt) return '```prompt 块 · mode=block';
  if (m.shot) return '#shot-N 标题块 · mode=block';
  return '无标记 → 全文注入 · mode=full';
}

export default function DocumentInspector({ node, setData, toastMsg, onPlanStoryboard }: DocumentInspectorProps) {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const md = String(d.markdown ?? '');
  const markers = docMarkers(md);
  const [view, setView] = useState<'src' | 'tbl'>('src');
  const [tblSnapshot, setTblSnapshot] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const tbl = parseGfmTable(md);

  const onSrcChange = (v: string) => {
    setData({ markdown: v });
  };

  const onTableChange = (mm: { head: string[]; body: string[][] }) => {
    setData({ markdown: replaceTableBlock(md, tableToGfm(mm.head, mm.body)) });
  };

  const onImportFile = (file: File | null) => {
    if (!file) return;
    const rd = new FileReader();
    rd.onload = () => {
      const text = String(rd.result ?? '');
      setData({ markdown: text });
      setTblSnapshot((s) => s + 1);
      toastMsg(`已导入 ${file.name} · ${text.length} 字 · 表格与标记块已重解析`);
    };
    rd.readAsText(file);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="insp-h" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Lbl>文档 · {node.title}</Lbl>
        <span className="badge">表格块 {markers.table ? '1' : '0'}</span>
        <span className="mono mut" style={{ marginLeft: 'auto', fontSize: 10 }}>document · 提示词源</span>
      </div>

      <KVSection
        rows={[
          ['格式', 'Markdown · GFM 表格'],
          ['唯一真源', 'data.markdown'],
          ['注入来源', docInjectLabel(md)],
        ] as Array<[string, string]>}
      />

      <div>
        <div className="f-row" style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <Lbl>视图</Lbl>
          <div className="f-chips" style={{ display: 'flex', gap: 5 }}>
            <span className={`chip${view === 'src' ? ' on' : ''}`} onClick={() => setView('src')}>源码</span>
            <span
              className={`chip${view === 'tbl' ? ' on' : ''}${markers.table ? '' : ' dis'}`}
              onClick={() => {
                if (markers.table) setView('tbl');
                else toastMsg('未识别到表格块 · 先写一个 GFM 表格');
              }}
            >
              表格
            </span>
          </div>
          <span className="f-hint" style={{ marginLeft: 'auto' }}>检测到表格块时可进表格编辑</span>
        </div>

        {view === 'src' ? (
          <>
            <textarea
              className="f-ta mono"
              style={{ minHeight: 236, width: '100%' }}
              aria-label="Markdown 源码"
              spellCheck={false}
              value={md}
              onChange={(e) => onSrcChange(e.target.value)}
            />
            <div className="f-hint" style={{ marginTop: 7 }}>
              源码为主视图(保持现有习惯);标记块 <span className="mono">```prompt</span> /{' '}
              <span className="mono">#shot-N</span> 命中时优先于全文注入,选中块为空时回退全文。
            </div>
          </>
        ) : tbl ? (
          <div style={{ marginTop: 6 }}>
            <TableEditor
              head={tbl.head}
              rows={tbl.rows}
              snHead="#"
              snIsData={false}
              pasteSample
              sampleData={() => [
                ['渡船老人', '粗布外衣', '同一名渡船老人', '渡船老人 v1'],
                ['马', '鞍具 · 枣红', '同一匹枣红马', '枣红马 v2'],
              ]}
              foot="编辑即时原位回写 markdown 表格块 · 其余 Markdown 不动"
              snapshot={tblSnapshot}
              onChange={onTableChange}
              onChangeMsg={(op, arg) =>
                op === 'row-del' ? `已删除第 ${arg} 行(原位回写)` : op === 'paste' ? `已导入 ${arg} 行粘贴数据 · 原位回写` : '已原位回写表格块'
              }
            />
          </div>
        ) : null}
      </div>

      <div>
        <div className="lbl" style={{ marginBottom: 6 }}>选段规则(优先级从高到低)</div>
        <div className="f-hint">
          1. <span className="mono">```prompt</span> 代码块 → 块内文本即提示词;2. <span className="mono">#shot-N</span>{' '}
          / <span className="mono">## 镜头N</span> 标题块 → 该标题下正文;3. 无标记 → 全文注入(
          <span className="mono">mode=full</span>,现状兼容)。
        </div>
      </div>

      <div className="f-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-s btn-sm" onClick={() => fileRef.current?.click()}>
          从文件导入 .md / .txt
        </button>
        {onPlanStoryboard ? (
          <button className="btn btn-s btn-sm" onClick={() => onPlanStoryboard(node)}>
            生成分镜表
          </button>
        ) : null}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".md,.txt,.markdown,text/markdown,text/plain"
        hidden
        onChange={(e) => {
          onImportFile(e.target.files?.[0] ?? null);
          e.target.value = '';
        }}
      />
      {(() => {
        const ps = inferPromptSource(md);
        return (
          <div className="mut mono" style={{ fontSize: 10.5 }}>
            当前连线注入:mode={ps.mode}
            {ps.blockId ? ` · blockId=${ps.blockId}` : ''}
            <span style={{ color: 'var(--meta)' }}>(运行期:目标自身 prompt 为空时生效)</span>
          </div>
        );
      })()}
      <KVSection rows={[['字符数', String(md.length)], ['行数', String(md.split('\n').length)]]} />
    </div>
  );
}