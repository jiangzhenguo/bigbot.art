/**
 * 长文档分段(纯函数)— 供 Agent 的 document.read 工具与测试使用
 *
 * 切块策略(参考 Claude Code Read 的「行范围 + 分块」思路,适配本项目的工具式读取):
 * - 按行累积,块字符数 ≤ maxChars(单行超长不可避免时允许超限)
 * - 优先在「空行」处断块(仅当当前块已过半),README/剧本/Markdown 的段落边界即空行
 * - 每块带 1-based 行范围,块与块之间行号连续、不重不漏
 * - 调用方(工具)先给 block 0 让模型看结构,再按需递增 chunk 逐段读
 */

export interface TextChunk {
  /** 0-based 块序号 */
  index: number;
  /** 本块起始行(1-based,含) */
  startLine: number;
  /** 本块结束行(1-based,含) */
  endLine: number;
  /** 本块文本(含行尾空白后的原样内容,块间行号连续) */
  text: string;
}

export interface ChunkTextResult {
  chunks: TextChunk[];
  totalChars: number;
  totalLines: number;
}

export interface ChunkTextOptions {
  /** 每块目标字符上限(默认 4000;下限 200、上限 20000,超出自动夹取) */
  maxChars?: number;
}

export function chunkText(text: string, opts: ChunkTextOptions = {}): ChunkTextResult {
  if (text === '') return { chunks: [], totalChars: 0, totalLines: 0 };
  const maxChars = Math.max(200, Math.min(opts.maxChars ?? 4000, 20000));
  const lines = text.split('\n');
  const chunks: TextChunk[] = [];
  let cur: string[] = [];
  let curStart = 1;
  let curChars = 0;

  const flush = (endLine: number) => {
    chunks.push({ index: chunks.length, startLine: curStart, endLine, text: cur.join('\n') });
    cur = [];
    curStart = endLine + 1;
    curChars = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineLen = line.length + 1; // +1 换行符

    // ① 已过半且遇空行 → 段落边界断块(空行并入本块尾部,语义清晰)
    if (line === '' && cur.length > 0 && curChars >= maxChars / 2) {
      cur.push(line);
      curChars += lineLen;
      flush(i + 1);
      continue;
    }
    // ② 超上限 → 强制断块(行号连续,下一块从本行开始)
    if (cur.length > 0 && curChars + lineLen > maxChars) {
      flush(i);
    }
    cur.push(line);
    curChars += lineLen;
  }
  if (cur.length > 0) flush(lines.length);

  const totalLines = text === '' ? 0 : lines.length;
  return { chunks, totalChars: text.length, totalLines };
}

/** 人读的块定位提示(给 LLM 决定下一块读哪) */
export function chunkNav(blocks: TextChunk[], cur: TextChunk): string {
  return `共 ${blocks.length} 块 · 当前第 ${cur.index + 1}/${blocks.length} 块(行 ${cur.startLine}–${cur.endLine})`;
}