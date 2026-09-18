/**
 * GFM 表格工具 — 文本节点 / 分镜表节点共用(零依赖)
 * 文档:docs/文本节点与Agent分镜管线-产品设计与技术方案.md §5.4
 *
 * 表格在 note 里是 Markdown 的一个「块」,唯一真源是 markdown 文本;
 * 编辑操作 = 解析表格块 → 改 TableData → 原位替换回 markdown。
 */

/** 解析后的表格块(行 index 与数据分离,方便原位替换) */
export interface TableBlock {
  /** 表头行号(0 基) */
  start: number;
  /** 表格结束行号(不含,0 基;end = 最后一行数据后面) */
  end: number;
  /** 表头列(首尾 | 已去掉) */
  head: string[];
  /** 数据行(不含表头/分隔行) */
  rows: string[][];
}

export type TableMatrix = { head: string[]; body: string[][] };

/** 该行是否形如 | … |(管道表格行) */
export function isPipeLine(l: string): boolean {
  return /^\s*\|.*\|\s*$/.test(l);
}

/** 该行是否表头分隔行(|---|:---:|) */
export function isSepLine(l: string): boolean {
  return /^\s*\|[\s:\-|]+\|\s*$/.test(l);
}

/** 拆分一行表格(去首尾 |,按 | 切,trim) */
export function splitRow(l: string): string[] {
  return l
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** 从 markdown 提取首个表格块;没有返回 null */
export function parseGfmTable(md: string): TableBlock | null {
  const lines = md.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (isPipeLine(lines[i] ?? '') && isSepLine(lines[i + 1] ?? '')) {
      const head = splitRow(lines[i] ?? '');
      let j = i + 2;
      const rows: string[][] = [];
      while (j < lines.length && isPipeLine(lines[j] ?? '')) {
        rows.push(splitRow(lines[j] ?? ''));
        j++;
      }
      return { start: i, end: j, head, rows };
    }
  }
  return null;
}

/** TableData → GFM 表格文本(单元格内 | 替换为 ·) */
export function tableToGfm(head: string[], rows: string[][]): string {
  const cl = (v: unknown) => String(v == null ? '' : v).replace(/\|/g, '·');
  const out = [
    `| ${head.map(cl).join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
  ];
  rows.forEach((r) => out.push(`| ${r.map(cl).join(' | ')} |`));
  return out.join('\n');
}

/** 用新 GFM 表格替换 markdown 中的首个表格块(无表格块则追加到末尾) */
export function replaceTableBlock(md: string, gfm: string): string {
  const b = parseGfmTable(md);
  if (!b) return md.replace(/\s*$/, '') + '\n\n' + gfm;
  const lines = md.split('\n');
  return lines.slice(0, b.start).concat(gfm.split('\n'), lines.slice(b.end)).join('\n');
}

/**
 * 剪贴板文本 → 二维数组:
 *   GFM 表格(≥2 行管道) → 过滤分隔行后按管道拆;
 *   TSV / CSV(按首行分隔符判别) → 按分隔符拆。
 */
export function parseClipboard(text: string): string[][] | null {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return null;
  const gfm = lines.filter(isPipeLine);
  if (gfm.length >= 2) {
    return gfm.filter((l) => !isSepLine(l)).map(splitRow);
  }
  const sep = lines[0]!.indexOf('\t') > -1 ? '\t' : lines[0]!.indexOf(',') > -1 ? ',' : null;
  if (!sep) return null;
  return lines.map((l) => l.split(sep).map((c) => c.trim()));
}

/** 剪贴板复制辅助(浏览器/Electron 渲染层可用) */
export function copyTextToClipboard(
  text: string,
  onResult: (msg: string) => void,
): void {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(() => onResult('已复制'))
      .catch(() => onResult('复制被浏览器拦截'));
  } else {
    onResult('已复制');
  }
}