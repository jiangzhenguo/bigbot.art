/**
 * MarkdownText — 轻量 Markdown 渲染(无第三方依赖)
 * 支持:标题 #/##/### · 加粗 ** · 行内代码 ` · 代码块 ```lang · 无序列表 -/* · 有序列表 1. · 链接 · 分隔线 --- · 段落 · GFM 表格
 * 样式沿用设计稿 CSS 变量(var(--fg)/var(--muted)/var(--border)/var(--font-mono) 等)
 */
import React from 'react';
import { parseGfmTable } from '@bigbotart/shared';

/* ── 行内解析:**bold** / `code` / [text](url) / *italic* ── */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let rest = text;
  let i = 0;
  const pushText = (s: string, key: string) => {
    if (s) out.push(<React.Fragment key={key}>{s}</React.Fragment>);
  };
  while (rest.length > 0) {
    // 行内代码
    let m = /^`([^`]+)`/.exec(rest);
    if (m) {
      out.push(
        <code
          key={`${keyPrefix}-c${i++}`}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.92em',
            background: 'var(--surface)',
            border: '1px solid var(--border-soft)',
            borderRadius: 4,
            padding: '1px 5px',
          }}
        >
          {m[1]}
        </code>,
      );
      rest = rest.slice(m[0].length);
      continue;
    }
    // 加粗
    m = /^\*\*([^*]+)\*\*/.exec(rest);
    if (m) {
      out.push(<b key={`${keyPrefix}-b${i++}`} style={{ fontWeight: 600 }}>{m[1]}</b>);
      rest = rest.slice(m[0].length);
      continue;
    }
    // 链接
    m = /^\[([^\]]+)\]\(([^)]+)\)/.exec(rest);
    if (m) {
      out.push(
        <a key={`${keyPrefix}-a${i++}`} href={m[2]} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
          {m[1]}
        </a>,
      );
      rest = rest.slice(m[0].length);
      continue;
    }
    // 斜体(*x* 或 _x_,避免匹配 ** 已处理)
    m = /^\*([^*]+)\*/.exec(rest) ?? /^_([^_]+)_/.exec(rest);
    if (m) {
      out.push(<i key={`${keyPrefix}-i${i++}`}>{m[1]}</i>);
      rest = rest.slice(m[0].length);
      continue;
    }
    // 普通文本到下一个标记
    const next = rest.slice(1).search(/[`*\[_]/);
    const chunk = next < 0 ? rest : rest.slice(0, next + 1);
    pushText(chunk, `${keyPrefix}-t${i++}`);
    rest = rest.slice(chunk.length);
  }
  return out;
}

/* ── 块级解析 ── */
export default function MarkdownText({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) { i++; continue; }

    // 代码块
    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // skip closing ```
      blocks.push(
        <pre
          key={key++}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            lineHeight: 1.55,
            background: 'var(--surface)',
            border: '1px solid var(--border-soft)',
            borderRadius: 8,
            padding: '10px 12px',
            overflow: 'auto',
            whiteSpace: 'pre',
            margin: '8px 0',
          }}
        >
          {lang ? (
            <div style={{ color: 'var(--meta)', fontSize: 10, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>
              {lang}
            </div>
          ) : null}
          {buf.join('\n')}
        </pre>,
      );
      continue;
    }

    // 分隔线
    if (line && /^\s*---+\s*$/.test(line)) {
      blocks.push(<hr key={key++} style={{ border: 0, borderTop: '1px solid var(--border-soft)', margin: '10px 0' }} />);
      i++;
      continue;
    }

    // 标题
    const hm = line ? /^(#{1,3})\s+(.+)$/.exec(line) : null;
    if (hm) {
      const level = hm[1]?.length ?? 1;
      blocks.push(
        <div
          key={key++}
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 600,
            letterSpacing: '-.01em',
            fontSize: level === 1 ? 'var(--text-base)' : level === 2 ? 'var(--text-sm)' : 'var(--text-xs)',
            margin: '10px 0 4px',
            color: 'var(--fg)',
          }}
        >
          {renderInline(hm[2] ?? '', `h${key}`)}
        </div>,
      );
      i++;
      continue;
    }

    // 无序列表
    if (line && /^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={key++} style={{ margin: '4px 0', paddingLeft: 18, lineHeight: 1.6 }}>
          {items.map((it, k) => (
            <li key={k} style={{ marginBottom: 2 }}>
              {renderInline(it, `ul${key}-${k}`)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // 有序列表
    if (line && /^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={key++} style={{ margin: '4px 0', paddingLeft: 18, lineHeight: 1.6 }}>
          {items.map((it, k) => (
            <li key={k} style={{ marginBottom: 2 }}>
              {renderInline(it, `ol${key}-${k}`)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    // GFM 表格块(表头行 + 分隔行 + 数据行)
    if (line && /^\s*\|.*\|\s*$/.test(line)) {
      // 从当前行起找表格:表头(index) + 分隔(index+1) + 数据行
      let li = i;
      while (li < lines.length && /^\s*\|.*\|\s*$/.test(lines[li] ?? '')) li++;
      const slice = lines.slice(i, li).join('\n');
      const tb = parseGfmTable(slice);
      if (tb && tb.start === 0) {
        i = li;
        blocks.push(
          <div key={key++} style={{ overflowX: 'auto', margin: '6px 0' }}>
            <table
              className="md-table"
              style={{
                borderCollapse: 'collapse',
                fontSize: 11,
                lineHeight: 1.5,
                minWidth: '100%',
              }}
            >
              <thead>
                <tr>
                  {tb.head.map((h, k) => (
                    <th
                      key={k}
                      style={{
                        border: '1px solid var(--border-soft)',
                        background: 'var(--surface)',
                        padding: '4px 8px',
                        textAlign: 'left',
                        whiteSpace: 'nowrap',
                        fontWeight: 600,
                        color: 'var(--fg-2)',
                      }}
                    >
                      {renderInline(h, `th${key}-${k}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tb.rows.map((r, k) => (
                  <tr key={k}>
                    {tb.head.map((_, c) => (
                      <td
                        key={c}
                        style={{
                          border: '1px solid var(--border-soft)',
                          padding: '4px 8px',
                          color: 'var(--fg-2)',
                          verticalAlign: 'top',
                        }}
                      >
                        {renderInline(r[c] ?? '', `td${key}-${k}-${c}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
        continue;
      }
    }

    // 空行
    if (!line || !line.trim()) {
      i++;
      continue;
    }

    // 普通段落(收集连续非空行)
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^\s*(```|#{1,3}\s|[-*]\s|\d+\.\s|---+\s*$)/.test(lines[i]!)
    ) {
      buf.push(lines[i]!);
      i++;
    }
    blocks.push(
      <p key={key++} style={{ margin: '4px 0', lineHeight: 1.65 }}>
        {renderInline(buf.join(' '), `p${key}`)}
      </p>,
    );
  }

  return <div className="md" style={{ fontSize: 'var(--text-xs)' }}>{blocks}</div>;
}