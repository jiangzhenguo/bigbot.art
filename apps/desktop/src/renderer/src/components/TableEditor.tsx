/**
 * TableEditor — 文本节点 / 分镜表节点共用的表格编辑器(文档 §5)
 * 规格来源:docs/文本节点与Agent分镜管线-产品设计与技术方案.md §5.2
 * 交互参考:Open Design 原型 document-storyboard-inspector.html / storyboard-table.html
 *
 * 实现方式:非受控 contentEditable 表格(与原型一致)——挂载/快照重建时按 props 建表,
 * 编辑操作即时读 DOM → onChange 上抛 {head, body};父层负责写回 markdown 与重渲染画布。
 * 通过 snapshot(数字)让父层在"外部数据变了"(切视图/导入)时强制重建。
 */
import React, { useEffect, useRef } from 'react';
import {
  parseClipboard,
  tableToGfm,
  copyTextToClipboard,
  type TableMatrix,
} from '@bigbotart/shared';

export interface TableEditorProps {
  /** 数据列表头(不含序号列) */
  head: string[];
  /** 数据行(不含序号列;行短于表头自动补空) */
  rows: string[][];
  /** 序号列表头,默认 '#' */
  snHead?: string;
  /** true:序号列是数据首列(分镜表镜号,粘贴/导出保留,编辑时自动续号) */
  snIsData?: boolean;
  /** 需配图列(相对数据列的 index);该列渲染 是/否 芯片,默认「是」 */
  ynCol?: number;
  /** 宽表(分镜表 8 列,加 min-width) */
  wide?: boolean;
  /** 工具条是否带「复制 CSV」 */
  csv?: boolean;
  /** 工具条是否带「粘贴示例」 */
  pasteSample?: boolean;
  /** 示例数据(粘贴示例用) */
  sampleData?: () => string[][];
  /** 底部说明 */
  foot?: string;
  /** 每行状态消息(默认 "N 行 · M 列") */
  msgFn?: (mm: TableMatrix) => string;
  /** 操作后的提示消息(op: row-add/row-del/col-add/col-del/paste,arg: 行号/列名/数量) */
  onChangeMsg?: (op: string, arg?: number | string) => string | null;
  /** 每次变化上抛(编辑/增删行列/粘贴/是-否切换) */
  onChange?: (mm: TableMatrix) => void;
  /** 外部数据快照版本:变化(如切视图/导入)时从 props 重建 DOM */
  snapshot?: number;
}

const esc = (s: unknown) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export default function TableEditor({
  head,
  rows,
  snHead = '#',
  snIsData = false,
  ynCol,
  wide,
  csv,
  pasteSample,
  sampleData,
  foot,
  msgFn,
  onChangeMsg,
  onChange,
  snapshot = 0,
}: TableEditorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLTableElement | null>(null);
  const msgBoxRef = useRef<HTMLSpanElement | null>(null);
  const pasteBarRef = useRef<HTMLDivElement | null>(null);
  const pasteMsgRef = useRef<HTMLSpanElement | null>(null);
  const pendingRef = useRef<string[][] | null>(null);
  const gridElementRef = useRef<HTMLDivElement | null>(null);

  /* ── 工具函数(闭包内,用 ref 访问 DOM) ── */
  const utilRef = useRef<{ build: (h: string[], r: string[][]) => void; renumber: () => void; sync: (msg?: string | null) => void; bodyRows: () => HTMLTableRowElement[]; rowHtml: (vals?: string[]) => string; matrix: () => TableMatrix } | null>(null);

  useEffect(() => {
    const gridEl = gridRef.current;
    const msg = msgBoxRef.current;
    const pasteBar = pasteBarRef.current;
    const pasteMsg = pasteMsgRef.current;
    if (!gridEl || !msg || !pasteBar || !pasteMsg) return;

    const bodyRows = (): HTMLTableRowElement[] =>
      Array.from(gridEl.tBodies[0]?.rows ?? []);

    const renumber = () => {
      bodyRows().forEach((tr, i) => {
        tr.cells[0]!.textContent = String(i + 1);
      });
    };

    const cellText = (td: HTMLTableCellElement): string => {
      const b = td.querySelector('[data-yn]');
      return b ? b.textContent!.trim() : td.textContent!.trim();
    };

    const matrix = (): TableMatrix => {
      const headCells = Array.from(gridEl.tHead?.rows[0]?.cells ?? []);
      const h = headCells.map((th) => th.textContent!.trim()).slice(1);
      let body = bodyRows().map((tr) => Array.from(tr.cells).map(cellText));
      if (!snIsData) body = body.map((r) => r.slice(1));
      return { head: h, body };
    };

    /** cols 显式传列数:build() 拼 html 时 thead 尚未写入 DOM,不能从 live DOM 读(首挂 tHead=null → 白屏事故) */
    const rowHtml = (vals?: readonly string[], cols?: number): string => {
      const n = cols ?? (gridEl.tHead?.rows[0]?.cells.length ?? 1) - 1;
      let tr = '<tr><td class="sn"></td>';
      for (let i = 0; i < n; i++) {
        const v = vals && vals[i] != null ? String(vals[i]) : '';
        if (ynCol === i) {
          const yes = v.trim() !== '否';
          tr += `<td class="c-img"><button class="ynm${yes ? ' on' : ''}" data-yn>${yes ? '是' : '否'}</button></td>`;
        } else {
          tr += `<td contenteditable="true">${esc(v)}</td>`;
        }
      }
      return tr + '</tr>';
    };

    const sync = (m?: string | null) => {
      const mm = matrix();
      msg.textContent = m ?? (msgFn ? msgFn(mm) : `${mm.body.length} 行 · ${mm.head.length} 列`);
      if (onChange) onChange(mm);
    };

    const build = (h: string[], r: string[][]) => {
      let html = '<thead><tr>';
      html += `<th class="sn" scope="col">${esc(snHead)}</th>`;
      h.forEach((hd, i) => {
        html += ynCol === i ? `<th class="c-img">${esc(hd)}</th>` : `<th contenteditable="true">${esc(hd)}</th>`;
      });
      html += '</tr></thead><tbody>';
      r.forEach((row) => {
        html += rowHtml(row, h.length);
      });
      html += '</tbody>';
      gridEl.innerHTML = html;
      renumber();
      sync();
    };

    utilRef.current = { build, renumber, sync, bodyRows, rowHtml, matrix };
    build(head, rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  /* ── 事件委托(挂载一次) ── */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const onGridClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const gridEl = gridRef.current;
      const msg = msgBoxRef.current;
      const u = utilRef.current;
      if (!gridEl || !msg || !u) return;

      const ynB = target.closest('[data-yn]') as HTMLButtonElement | null;
      if (ynB) {
        const on = !ynB.classList.contains('on');
        ynB.classList.toggle('on', on);
        ynB.textContent = on ? '是' : '否';
        u.sync();
        return;
      }
      const sn = target.closest('.sn') as HTMLTableCellElement | null;
      if (sn && sn.parentElement?.parentElement?.tagName === 'TBODY') {
        const tr = sn.parentElement;
        const was = tr.classList.contains('on');
        u.bodyRows().forEach((r) => r.classList.remove('on'));
        if (!was) tr.classList.add('on');
        return;
      }
      const btn = target.closest('[data-op]') as HTMLButtonElement | null;
      if (!btn) return;
      const op = btn.dataset.op;

      if (op === 'row-add') {
        const tr = document.createElement('tr');
        tr.innerHTML = u.rowHtml();
        gridEl.tBodies[0]!.appendChild(tr);
        u.renumber();
        u.sync(onChangeMsg ? onChangeMsg('row-add') : undefined);
      } else if (op === 'row-del') {
        const rs = u.bodyRows();
        if (!rs.length) return;
        const sel = rs.filter((r) => r.classList.contains('on'));
        const targetRow = sel.length ? sel[0]! : rs[rs.length - 1]!;
        const idx = rs.indexOf(targetRow) + 1;
        targetRow.remove();
        u.renumber();
        u.sync(onChangeMsg ? onChangeMsg('row-del', idx) : undefined);
      } else if (op === 'col-add') {
        const th = document.createElement('th');
        th.contentEditable = 'true';
        th.textContent = '新列';
        gridEl.tHead!.rows[0]!.appendChild(th);
        u.bodyRows().forEach((tr) => {
          const td = document.createElement('td');
          td.contentEditable = 'true';
          tr.appendChild(td);
        });
        u.sync(onChangeMsg ? onChangeMsg('col-add') : undefined);
      } else if (op === 'col-del') {
        const headRow = gridEl.tHead!.rows[0]!;
        if (headRow.cells.length <= 3) {
          msg.textContent = '至少保留两列';
          setTimeout(() => u.sync(), 1400);
          return;
        }
        const last = headRow.cells.length - 1;
        const name = headRow.cells[last]!.textContent!.trim();
        headRow.deleteCell(last);
        u.bodyRows().forEach((tr) => tr.deleteCell(last));
        u.sync(onChangeMsg ? onChangeMsg('col-del', name) : undefined);
      } else if (op === 'copy-gfm') {
        const mm = u.matrix();
        copyTextToClipboard(tableToGfm(snIsData ? ['镜号', ...mm.head] : mm.head, mm.body), (r) => {
          msg.textContent = `已复制为 GFM 表格(${r})`;
          setTimeout(() => u.sync(), 1600);
        });
      } else if (op === 'copy-csv') {
        const mm = u.matrix();
        const h = snIsData ? ['镜号', ...mm.head] : mm.head;
        const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
        const csvText = [h.map(q).join(',')].concat(mm.body.map((r) => r.map(q).join(','))).join('\n');
        copyTextToClipboard(csvText, (r) => {
          msg.textContent = `已复制为 CSV(${r})`;
          setTimeout(() => u.sync(), 1600);
        });
      } else if (op === 'paste-sample' && sampleData && onChangeMsg) {
        const rows2 = sampleData();
        pendingRef.current = rows2;
        pasteMsgRef.current!.textContent = `检测到 ${rows2.length} 行 · 示例数据 · 默认追加到表尾`;
        pasteBarRef.current!.classList.add('show');
      }
    };

    const onGridInput = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t.isContentEditable) utilRef.current?.sync();
    };

    const onGridPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement;
      if (!t.isContentEditable && !t.closest('.te-grid')) return;
      const txt = (e.clipboardData || (window as unknown as { clipboardData?: DataTransfer }).clipboardData)?.getData('text/plain') ?? '';
      const parsed = parseClipboard(txt);
      if (!parsed || !parsed.length || parsed[0]!.length < 2) return;
      e.preventDefault();
      pendingRef.current = parsed;
      const kind = /^\s*\|/.test(txt.trim()) ? 'GFM 表格' : txt.indexOf('\t') > -1 ? 'TSV' : 'CSV';
      pasteMsgRef.current!.textContent = `检测到 ${parsed.length} 行 · ${kind} · 默认追加到表尾`;
      pasteBarRef.current!.classList.add('show');
    };

    const onPasteBarClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('[data-paste-op]') as HTMLButtonElement | null;
      const u = utilRef.current;
      if (!btn || !u) return;
      const op = btn.dataset.pasteOp;
      const pending = pendingRef.current;
      if (op !== 'cancel' && pending) {
        const gridEl = gridRef.current!;
        if (op === 'replace') gridEl.tBodies[0]!.innerHTML = '';
        pending.forEach((r) => {
          const tr = document.createElement('tr');
          tr.innerHTML = u.rowHtml(snIsData ? r.slice(1) : r);
          gridEl.tBodies[0]!.appendChild(tr);
        });
        u.renumber();
        u.sync(onChangeMsg ? onChangeMsg('paste', pending.length) : undefined);
      }
      pendingRef.current = null;
      pasteBarRef.current!.classList.remove('show');
    };

    const onGridKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).isContentEditable) {
        e.preventDefault();
        (e.target as HTMLElement).blur();
      }
    };

    root.addEventListener('click', onGridClick);
    root.addEventListener('input', onGridInput);
    root.addEventListener('paste', onGridPaste);
    root.addEventListener('keydown', onGridKeydown);
    const pasteBar = pasteBarRef.current;
    if (pasteBar) pasteBar.addEventListener('click', onPasteBarClick);
    return () => {
      root.removeEventListener('click', onGridClick);
      root.removeEventListener('input', onGridInput);
      root.removeEventListener('paste', onGridPaste);
      root.removeEventListener('keydown', onGridKeydown);
      if (pasteBar) pasteBar.removeEventListener('click', onPasteBarClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="te" ref={rootRef}>
      <div className="te-bar">
        <button className="tb" data-op="row-add">+ 行</button>
        <button className="tb" data-op="row-del">− 行</button>
        <span className="te-div" aria-hidden="true"></span>
        <button className="tb" data-op="col-add">+ 列</button>
        <button className="tb" data-op="col-del">− 列</button>
        <span className="te-div" aria-hidden="true"></span>
        <button className="tb" data-op="copy-gfm">复制 GFM</button>
        {csv ? <button className="tb" data-op="copy-csv">复制 CSV</button> : null}
        {pasteSample ? <button className="tb" data-op="paste-sample">粘贴示例</button> : null}
        <span className="te-msg" ref={msgBoxRef}></span>
      </div>
      <div className="te-scroll">
        <div ref={gridElementRef}>
          <table className={`te-grid${wide ? ' w8' : ''}`} ref={gridRef}></table>
        </div>
      </div>
      <div className="te-paste" ref={pasteBarRef}>
        <span className="grow" ref={pasteMsgRef}></span>
        <button className="btn btn-s btn-sm" data-paste-op="append">追加</button>
        <button className="tb" data-paste-op="replace">替换当前表</button>
        <button className="tb" data-paste-op="cancel">取消</button>
      </div>
      {foot ? (
        <div className="te-foot"><span>{foot}</span></div>
      ) : null}
    </div>
  );
}