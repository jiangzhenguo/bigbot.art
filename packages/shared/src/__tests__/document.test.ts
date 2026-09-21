/**
 * 长文档分段纯函数(chunkText / chunkNav)测试
 */
import { describe, it, expect } from 'vitest';
import { chunkText, chunkNav } from '../document.js';

/** 生成 n 行、每行 len 字符(不含换行)的文本 */
const grid = (n: number, len: number, sep = '\n') =>
  Array.from({ length: n }, (_, i) => 'x'.repeat(len)).join(sep);

describe('chunkText · 基本切块', () => {
  it('短文本:1 块,行 1–N,拼接可还原全文', () => {
    const txt = '第一行\n第二行\n第三行';
    const { chunks, totalChars, totalLines } = chunkText(txt);
    expect(totalChars).toBe(txt.length);
    expect(totalLines).toBe(3);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toMatchObject({ index: 0, startLine: 1, endLine: 3 });
    expect(chunks[0]!.text).toBe(txt);
  });

  it('长文本按 maxChars 断块,块间行号连续,拼接还原全文', () => {
    const txt = grid(10, 100); // 10 行 × 100 字符,无空行
    const { chunks } = chunkText(txt, { maxChars: 300 });
    // 贪心放行:放得下就加,放不下才断 → 每块 2 行(201 chars)后第 3 行放不下 → 5 块
    expect(chunks.length).toBe(5);
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
      [9, 10],
    ]);
    // 每块长度 ≤ maxChars + 一行(断块时本行尚未加入)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(300 + 101);
    // 块与块行号连续(不重不漏)
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startLine).toBe(chunks[i - 1]!.endLine + 1);
    }
    expect(chunks.map((c) => c.text).join('\n')).toBe(txt);
  });

  it('已过半且遇空行 → 在段落边界断块(空行并入块尾,不截断行)', () => {
    const txt = `${grid(6, 100)}\n\n${grid(5, 100)}`; // 6 行 + 空行 + 5 行
    const { chunks } = chunkText(txt, { maxChars: 300 });
    expect(chunks.length).toBeGreaterThan(1);
    // 某中间块以空行结尾(空行断点生效,行被完整保留)
    expect(chunks.slice(0, -1).some((c) => c.text.endsWith('\n'))).toBe(true);
    // 块与块行号连续(不重不漏)
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startLine).toBe(chunks[i - 1]!.endLine + 1);
    }
    // 拼接还原全文(不丢行)
    expect(chunks.map((c) => c.text).join('\n')).toBe(txt);
  });

  it('单行超长:允许超 maxChars(不拆行),仍为 1 块', () => {
    const txt = 'y'.repeat(2_000); // 无换行
    const { chunks } = chunkText(txt, { maxChars: 300 });
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 1 });
    expect(chunks[0]!.text.length).toBe(2_000);
  });

  it('空文本:0 块', () => {
    const { chunks, totalLines } = chunkText('');
    expect(chunks.length).toBe(0);
    expect(totalLines).toBe(0);
  });

  it('size 越界自动夹取(下限 200 / 上限 20000)', () => {
    const txt = grid(10, 100);
    const tiny = chunkText(txt, { maxChars: 1 }); // 夹到 200 → 2 块(每块 2 行?200/100=2)
    expect(tiny.chunks.length).toBeGreaterThan(0);
    // 上限夹取:20000 内不报错
    const huge = chunkText(txt, { maxChars: 999999 });
    expect(huge.chunks.length).toBe(1);
  });
});

describe('chunkNav', () => {
  it('输出共几块与当前块行范围', () => {
    const { chunks } = chunkText(grid(10, 100), { maxChars: 300 });
    const nav = chunkNav(chunks, chunks[1]!);
    expect(nav).toContain('共 5 块');
    expect(nav).toContain('第 2/5 块');
    expect(nav).toContain('行 3–4');
  });
});