/**
 * 分镜表 / 提示词组装工具 — 文本节点与分镜表节点共用(零依赖)
 * 文档:docs/文本节点与Agent分镜管线-产品设计与技术方案.md §6.2 §7.5
 */
import { parseGfmTable, tableToGfm } from './table.js';

/** 分镜表默认列(第 0 版固定,columnMap 放开后列可改) */
export const STORYBOARD_HEAD = [
  '镜号',
  '画面描述',
  '对白/旁白',
  '景别',
  '运镜',
  '时长(s)',
  '需配图',
  '提示词(可选)',
] as const;

/** 新分镜表节点的默认 markdown(表头 + 一行占位) */
export function defaultStoryboardMarkdown(): string {
  return [
    '# 新分镜',
    '',
    '说明:一行 = 一个分镜;可在检查器表格视图编辑,或点「从分镜表生成节点」铺出镜头。',
    '',
    tableToGfm([...STORYBOARD_HEAD], [['1', '', '', '', '', '5', '是', '']]),
  ].join('\n');
}

/** 提示词来源(连边 / 铺节点时写入下游 data.promptFrom) */
export interface PromptSource {
  nodeId: string;
  /** full=全文注入(现状兼容);block=标记选段;row=分镜表某行 */
  mode: 'full' | 'block' | 'row';
  /** mode=block: 'prompt'(```prompt 块) 或 'shot-<N>'(标题块) */
  blockId?: string;
  /** mode=row: 表格行号(1 起,跳过表头) */
  row?: number;
}

/** Markdown 里的提示词标记检测结果 */
export interface DocMarkers {
  /** 存在 ```prompt 代码块 */
  prompt: boolean;
  /** 存在 #shot-N / ## 镜头N 标题块 */
  shot: boolean;
  /** 存在表格块 */
  table: boolean;
}

/** 检测文档节点 markdown 的标记(选段规则 §6.2) */
export function docMarkers(md: string): DocMarkers {
  return {
    prompt: /```prompt/.test(md),
    shot: /(^|\n)#{1,2}\s*(镜头\s*\d+|shot-\d+)/i.test(md),
    table: !!parseGfmTable(md),
  };
}

/** 按优先级推断连边时的提示词来源(mode + blockId) */
export function inferPromptSource(md: string): Pick<PromptSource, 'mode' | 'blockId'> {
  if (/```prompt/.test(md)) return { mode: 'block', blockId: 'prompt' };
  const hm = /(^|\n)#{1,2}\s*(?:镜头\s*(\d+)|shot-(\d+))/i.exec(md);
  if (hm) return { mode: 'block', blockId: `shot-${hm[2] ?? hm[3]}` };
  return { mode: 'full' };
}

/** 提取 ```prompt 代码块内容(无则 null) */
export function extractPromptBlock(md: string): string | null {
  const m = /```prompt\s*\n([\s\S]*?)\n```/.exec(md);
  return m?.[1]?.trim() || null;
}

/** 提取 #shot-N / ## 镜头N 标题块正文(标题行之后到下一个标题/末尾) */
export function extractShotBlock(md: string, blockId: string): string | null {
  const n = /^shot-(\d+)$/.exec(blockId)?.[1];
  const m = n
    ? new RegExp(`(^|\\n)#{1,2}\\s*(?:镜头\\s*${n}|shot-${n})[^\\n]*\\n([\\s\\S]*?)(?=\\n#{1,2}\\s|$)`, 'i').exec(md)
    : null;
  if (!m) return null;
  const body = (m[2] ?? '').trim();
  return body || null;
}

/** 按 PromptSource 从 markdown 解出提示词文本(选中块为空回退全文) */
export function resolvePromptFromSource(md: string, ps: PromptSource): string {
  if (ps.mode === 'block' && ps.blockId === 'prompt') {
    const block = extractPromptBlock(md);
    if (block) return block;
    return md.trim();
  }
  if (ps.mode === 'block' && ps.blockId) {
    const block = extractShotBlock(md, ps.blockId);
    if (block) return block;
    return md.trim();
  }
  return md.trim();
}

/* ═══ 分镜表行 → 提示词组装(§7.5) ═══ */

/** 按表头名取列号(缺列回退默认位置;表头可能被用户增删) */
const HEAD_DEFAULT_IDX: Record<string, number> = {
  画面描述: 1,
  对白: 2,
  '对白/旁白': 2,
  景别: 3,
  运镜: 4,
  时长: 5,
  '时长(s)': 5,
  需配图: 6,
  提示词: 7,
  '提示词(可选)': 7,
};

export function colIndex(head: string[], name: string): number {
  const i = head.indexOf(name);
  if (i >= 0) return i;
  return HEAD_DEFAULT_IDX[name] ?? -1;
}

/** 读取行内某列(行短于表头时补空) */
export function rowCell(
  row: string[] | undefined,
  head: string[],
  name: string,
): string {
  const i = colIndex(head, name);
  if (i < 0) return '';
  return String((row ?? [])[i] ?? '');
}

/** 该行是否需配图(「需配图」列 ≠ 否;缺列按默认位置) */
export function rowNeedsImage(row: string[] | undefined, head: string[]): boolean {
  const v = rowCell(row, head, '需配图');
  return v.trim() !== '否';
}

/** 该行时长(秒) */
export function rowSeconds(row: string[] | undefined, head: string[]): number {
  const d = parseFloat(rowCell(row, head, '时长(s)'));
  return Number.isNaN(d) ? 0 : d;
}

/** 表统计:n 行 / 需配图 / 合计秒 */
export function sbStats(head: string[], rows: string[][]): {
  n: number;
  imgs: number;
  secs: number;
} {
  let imgs = 0;
  let secs = 0;
  for (const r of rows) {
    if (rowNeedsImage(r, head)) imgs++;
    secs += rowSeconds(r, head);
  }
  return { n: rows.length, imgs, secs: Math.round(secs * 10) / 10 };
}

/** H3 五段式组装(shot 节点;「提示词(可选)」列有值则显式使用) */
export function assembleH3Prompt(
  row: string[] | undefined,
  head: string[],
  basePrompt?: string,
): { explicit: boolean; text: string } {
  const p = rowCell(row, head, '提示词(可选)').trim();
  if (p) return { explicit: true, text: p };
  const look = (basePrompt ?? '').trim() || '电影感，自然光影，写实';
  const dial = rowCell(row, head, '对白/旁白').trim();
  const hasDial = !!dial && dial !== '无' && dial !== '—';
  const action = hasDial
    ? /[「『]/.test(dial)
      ? dial
      : `对白「${dial}」`
    : '无对白 · 以肢体动作推进';
  const scene = rowCell(row, head, '画面描述');
  const size = rowCell(row, head, '景别');
  const move = rowCell(row, head, '运镜') || '固定';
  return {
    explicit: false,
    text: [
      `Scene: ${scene}（${size}落位）`,
      `Action: ${action}`,
      `Camera: ${size} · ${move}`,
      `Look: ${look}`,
      `Audio: ${hasDial ? '口型同步 · 环境音' : '环境音 · 水声与风声'}`,
    ].join('\n'),
  };
}

/** Z-Image 六段式组装(image-gen 节点) */
export function assembleZImagePrompt(
  row: string[] | undefined,
  head: string[],
  basePrompt?: string,
): { explicit: boolean; text: string } {
  const p = rowCell(row, head, '提示词(可选)').trim();
  if (p) return { explicit: true, text: p };
  const look = (basePrompt ?? '').trim() || '电影感，自然光影，写实';
  return {
    explicit: false,
    text: [
      `主体：${rowCell(row, head, '画面描述')}`,
      '场景：秋日河谷 · 草原河岸（继承 Brief）',
      `构图：${rowCell(row, head, '景别')}`,
      '光影：黄昏侧光（继承 Brief）',
      `风格：${look}`,
      '约束：无文字，不变形，主体身份措辞锁定',
    ].join('\n'),
  };
}

/** 分镜表 markdown 序列化(标题 + 说明 + 表格)→ 源码视图 / Agent 产出共用 */
export function storyboardMarkdown(title: string, intro: string, head: string[], rows: string[][]): string {
  return [`# ${title}`, '', intro, '', tableToGfm(head, rows)].join('\n');
}

/** 铺节点默认画幅 → 尺寸(32 倍数,含 h3.c 限制内;渲染层/agent/工具执行共用同一口径) */
export const SB_SIZE: Record<string, { width: number; height: number }> = {
  '16:9': { width: 832, height: 480 },
  '9:16': { width: 480, height: 832 },
  '1:1': { width: 768, height: 768 },
};