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

/** 铺节点默认画幅 → 尺寸(渲染层/agent/工具执行共用同一口径)
 *  16:9 / 9:16 用精确比例 1024×576 / 576×1024(32 倍数,与 image-crop 口径一致;
 *  旧值 832×480 / 480×832 实为 26:15 / 15:26,非真 16:9) */
export const SB_SIZE: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1024, height: 576 },
  '9:16': { width: 576, height: 1024 },
  '1:1': { width: 768, height: 768 },
  // 2026-10 新增:4:3 / 3:4(严格比例 + 32 倍数,见 h3c-command.ts ASPECT_SIZES 的推导注释)
  '4:3': { width: 1024, height: 768 },
  '3:4': { width: 768, height: 1024 },
};

/**
 * 视频(shot)可选画幅 —— **全链唯一真源**。
 *
 * 为什么放 shared:这个列表此前在四处各写一份(渲染层 `constants.ts` 的
 * `SHOT_ASPECTS`、providers 的 `ASPECT_SIZES`、`SB_SIZE`、以及各处硬编码判断),
 * 加一个比例要改 4-5 个文件、漏一处就出现「UI 能选、提交却报非法」。
 * 现在渲染层与 providers 都从这里取,新增比例只改这一处 + 尺寸表。
 */
export const VIDEO_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const;
export type VideoAspect = (typeof VIDEO_ASPECTS)[number];

/** 视频质量档位(h3 的四档) */
export const VIDEO_TIERS = ['preview', 'draft', 'default', 'reference'] as const;
export type VideoTier = (typeof VIDEO_TIERS)[number];

/**
 * 比例 × 档位 → 宽高。**这是「档位决定分辨率」的唯一落点。**
 *
 * 全部为 32 倍数合法档(H3_USAGE.md §4.2)。4:3 / 3:4 于 2026-10 新增:
 * 严格比例 + 32 倍数同时成立时档位离散(4:3 是 w=128k/h=96k),取值与同级
 * 16:9 / 9:16 面积对齐,保证切比例不改变速度档位。
 *
 * ⚠️ 与 `packages/providers/src/h3c-command.ts` 的 `ASPECT_SIZES`、
 * 渲染层 `constants.ts` 的 `SHOT_SIZES` 必须同值(后两者是历史副本;
 * providers 因包边界不能 import shared,故仍保留自己那份 + 单测比对)。
 */
export const SHOT_SIZES: Record<VideoAspect, Record<VideoTier, { width: number; height: number }>> = {
  '16:9': {
    preview: { width: 864, height: 480 },
    draft: { width: 864, height: 480 },
    default: { width: 864, height: 480 },
    reference: { width: 1280, height: 704 },
  },
  '9:16': {
    preview: { width: 480, height: 864 },
    draft: { width: 480, height: 864 },
    default: { width: 576, height: 1024 },
    reference: { width: 704, height: 1280 },
  },
  '1:1': {
    preview: { width: 448, height: 448 },
    draft: { width: 544, height: 544 },
    default: { width: 544, height: 544 },
    reference: { width: 768, height: 768 },
  },
  '4:3': {
    preview: { width: 640, height: 480 },
    draft: { width: 768, height: 576 },
    default: { width: 896, height: 672 },
    reference: { width: 1024, height: 768 },
  },
  '3:4': {
    preview: { width: 480, height: 640 },
    draft: { width: 576, height: 768 },
    default: { width: 672, height: 896 },
    reference: { width: 768, height: 1024 },
  },
};

/** 画幅中文标签(检查器 chips / 提示文案共用) */
export const VIDEO_ASPECT_LABEL: Record<VideoAspect, string> = {
  '16:9': '16:9 横屏',
  '9:16': '9:16 竖屏',
  '1:1': '1:1 方',
  '4:3': '4:3 横屏',
  '3:4': '3:4 竖屏',
};

/**
 * 把任意图片宽高**贴合**到 32 倍数(用于「首帧生成」沿用上游图片比例)。
 *
 * 语义 = 「保住比例,落到合法网格」,而不是两边各自四舍五入 ——
 * 后者会漂移比例:1080×1920(严格 9:16)两边取整成 1088×1920 就变成 1.765,
 * 肉眼是看不出来,但 h3 拿到的首帧与视频尺寸不一致就会被拉伸/裁切,
 * 而这个函数的**全部意义**就是让两者严格一致。
 *
 * 做法:在 32 网格上直接搜最优的 (w,h) —— 以原比例为约束,
 * 枚举「高度档位」h=32k(k 由小到大),令 w = round(h × ratio / 32) × 32,
 * 取比例误差最小、同误差下面积最接近原图的解。网格是离散的,
 * 因此不可能对所有输入都精确命中;但搜索能保证在不超面积上限的前提下
 * **把比例误差压到该网格能达到的最小值**(实践中通常能精确命中常见比例)。
 *
 * 纯函数、可单测、无副作用。
 */
export function fitImageSizeToGrid(
  width: number,
  height: number,
): { width: number; height: number } {
  const w = Number(width);
  const h = Number(height);
  // 非法输入 → 退回 1:1 默认,不抛错(调用方在 UI 里,崩了比给个兜底更糟)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { width: 544, height: 544 };
  }
  const MAX_AREA = 768 * 1344;
  const targetRatio = w / h;
  const snap32 = (v: number) => Math.max(32, Math.round(v / 32) * 32);

  let best: { width: number; height: number } | null = null;
  let bestErr = Infinity;
  let bestAreaErr = Infinity;

  /*
   * 搜索空间:高度从「缩到上限内的最大高度」往下扫。
   * 上限由面积约束给出 —— h 最大时 w 也必须够小,故 hMax = sqrt(MAX_AREA / ratio)。
   * 步长取 32(网格本身的粒度),范围覆盖到很小的值,保证一定能找到解。
   */
  const hMax = Math.min(snap32(h), snap32(Math.sqrt(MAX_AREA / targetRatio)));
  const hMin = 32;
  // 直接按 32 步长枚举;网格粒度下这个循环最多几百次,纯计算无 IO,足够快
  for (let hh = hMax; hh >= hMin; hh -= 32) {
    const ww = snap32(hh * targetRatio);
    if (ww * hh > MAX_AREA) continue;
    const err = Math.abs(ww / hh - targetRatio) / targetRatio;
    // 面积差距用于在比例并列时挑分辨率更接近原图的解
    const areaErr = Math.abs(ww * hh - w * h) / (w * h);
    if (err < bestErr - 1e-12 || (Math.abs(err - bestErr) <= 1e-12 && areaErr < bestAreaErr)) {
      best = { width: ww, height: hh };
      bestErr = err;
      bestAreaErr = areaErr;
    }
  }

  if (best) return best;
  // 兜底(理论上不可达):给一个一定合法的最小档
  return { width: 32, height: 32 };
}

/**
 * 首帧 / 参考图生成时,**新建 shot 节点**该用什么**比例**(注意:只定比例,不定分辨率)。
 *
 * ⚠️ **分辨率一律由「档位」决定**(2026-10 修正,原实现是错的):
 * 早期版本这里连 width/height 一起返回「上游图片的像素尺寸」,导致
 * 4K 参考图会把「5 秒预览档」顶成 4K 出片 —— 耗时与显存完全失控,
 * 用户选的档位形同虚设。正确语义是:
 *   - **档位(预览/草稿/默认/参考)= 用户显式选的分辨率**,任何情况下不被图片顶掉;
 *   - **连接角色只影响比例**。
 * 故本函数只返回 aspect,像素值一律由调用方查 `SHOT_SIZES[aspect][tier]`。
 *
 * 规则:
 *  - **首帧**(`first-frame` / `first-last`,上游给的是静帧)⇒ 比例**沿用上游图片**
 *    (首帧也就是视频第一帧,比例不一致会被拉伸/裁切)。
 *  - **参考图**(`ref-image` / Ref2VA,靠参考图锁定身份/场景,不锚定几何)⇒ 默认 **4:3**。
 *  - 其余模式(text2video / ref-video / audio-ref …)⇒ 返回 null = 不干预,用弹层所选。
 */
export function defaultShotAspectForRole(
  role: 'first-frame' | 'ref-image' | string | undefined,
  upstream?: { width?: number; height?: number },
): VideoAspect | null {
  if (role === 'first-frame') {
    const w = Number(upstream?.width ?? 0);
    const h = Number(upstream?.height ?? 0);
    if (w > 0 && h > 0) {
      // 用贴合后的尺寸归类,避免 1080×1920 这类非 32 倍数图片被归到 custom
      const fit = fitImageSizeToGrid(w, h);
      const a = classifyAspect(fit.width, fit.height);
      return a === 'custom' ? null : a;
    }
    return null;
  }
  if (role === 'ref-image') return '4:3';
  return null;
}

/**
 * 把具体宽高归类到已知比例(仅用于**显示标签**;数值仍是权威)。
 *
 * 用相对误差判定而不是精确相等:首帧贴合后的尺寸可能不落在任何预设档
 * (例如 1536×1152 是严格 4:3,但不在 4:3 档位表里),此时应显示「4:3」而不是
 * 「自定义」—— 用户关心的是构图比例,不是它是否等于某个预设像素值。
 * 容差 1% 足以吸收 32 倍数贴合带来的微小偏差,又不会把 16:9(1.778) 与
 * 3:2(1.5) 这类明显不同的比例混为一谈。
 */
export function classifyAspect(width: number, height: number): VideoAspect | 'custom' {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 'custom';
  const r = w / h;
  let best: { a: VideoAspect; err: number } | null = null;
  for (const a of VIDEO_ASPECTS) {
    const [n, d] = a.split(':').map(Number) as [number, number];
    const err = Math.abs(r - n / d) / (n / d);
    if (err < 0.01 && (!best || err < best.err)) best = { a, err };
  }
  return best?.a ?? 'custom';
}