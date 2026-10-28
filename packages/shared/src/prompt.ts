/**
 * 分镜表 / 提示词组装工具 — 文本节点与分镜表节点共用(零依赖)
 * 文档:docs/文本节点与Agent分镜管线-产品设计与技术方案.md §6.2 §7.5
 */
import { parseGfmTable, tableToGfm } from './table.js';

/**
 * 分镜表核心列(旧版 10 列,顺序与下标保持兼容)。
 * 新列只能追加在尾部:老画布仍按表头名读取,缺列时 rowCell 返回空串。
 */
export const STORYBOARD_CORE_HEAD = [
  '镜号',
  '画面描述',
  '对白/旁白',
  '景别',
  '运镜',
  '时长(s)',
  '需配图',
  '提示词(可选)',
  '衔接',
  '角色',
] as const;

/**
 * 摄影 / 声音 / 调度扩展列(2026-10-28,分镜改造第 2 步)。
 * 全部可选;「节拍」只供规划与审阅,不直接注入生成提示词(避免把抽象叙事术语当画面指令)。
 */
export const STORYBOARD_EXTENDED_HEAD = [
  '焦段',
  '水平角度',
  '机位高度',
  '构图',
  '视线',
  '焦点',
  '稳定性',
  '光位',
  '声景',
  '配乐',
  '站位(blocking)',
  '节拍',
] as const;

/** 新建分镜表的完整默认列(核心 10 + 扩展 12)。 */
export const STORYBOARD_HEAD = [...STORYBOARD_CORE_HEAD, ...STORYBOARD_EXTENDED_HEAD] as const;

/** 新分镜表节点的默认 markdown(表头 + 一行占位) */
export function defaultStoryboardMarkdown(): string {
  const defaults: Record<string, string> = { 镜号: '1', '时长(s)': '5', 需配图: '是', 衔接: '硬切' };
  const row = STORYBOARD_HEAD.map((name) => defaults[name] ?? '');
  return [
    '# 新分镜',
    '',
    '说明:一行 = 一个分镜;可在检查器表格视图编辑,或点「从分镜表生成节点」铺出镜头。「角色」列写本镜出场的角色卡/场景卡名(逗号分隔)。摄影、声音与站位扩展列均可选填。',
    '',
    tableToGfm([...STORYBOARD_HEAD], [row]),
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
  衔接: 8,
  角色: 9,
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

/**
 * 参考素材条目 —— 供 H3 Ref2VA 的 `<Subject n>` 标签段使用(2026-10-09)。
 *
 * 背景:h3 收到 `--ref-image` 后**按传入顺序**自动编号成 `<Picture 1>`、`<Picture 2>`……
 * 但官方 Ref2VA 规范要求**提示词里用 `<Subject n>` 显式引用这些图**,否则模型只是
 * 「看到了图」却不知道要继承什么(脸?服装?还是背景?)。
 * 真实事故:角色卡/场景卡连了边、提示词却完全没提,9 张参考图的能力形同虚设。
 */
export interface PromptSubject {
  /** 主体名(如「苏青」);由调用方/Agent 给出,本模块不做推断 */
  name: string;
  /** character = 身份锁(脸/发型/服装) / scene = 环境锁(布局/光位/地标) */
  kind: 'character' | 'scene';
  /**
   * 该主体的**具体可辨识特征**(如「黑色短发、黑色皮夹克」)。
   *
   * 为什么需要它(2026-10-09 实测):只写一句笼统的 `identity lock: face, hair, outfit`
   * 时,模型会把「锁」理解成「我看到了这个人」,但**抓不住具体特征** ——
   * 实测角色卡是「黑色短发 + 黑夹克」,出片却变成「黑色爆炸头 + 黑皮衣」;
   * 另一角色卡是「金色马尾 + 黑战术服」,出片变成「金色盘发 + 红外套」。
   * 服装/颜色这类大色块能对上,发型与服装**款式**这类细节会漂。
   * 把特征逐条写进标签里,等于给模型一张**逐项核对清单**,代价几乎为零。
   */
  traits?: string;
}

/**
 * 组装 Ref2VA 的 `<Subject n>` 标签段(纯函数,便于单测)。
 *
 * 输出形如:
 *   `<Subject 1> is 苏青 in <Picture 1> (identity lock: face, hair, outfit).`
 *   `<Subject 2> is the environment in <Picture 2> (scene lock).`
 *
 * ⚠️ **编号即顺序**:`<Picture n>` 的 n 由数组下标决定,调用方必须保证数组顺序
 * = 参考图连线的先后顺序(h3 就是这样编号的),否则标签与图对不上 ——
 * 那种错误比不写标签更糟(模型会拿场景图当角色继承)。
 *
 * 名字为空或全空白的条目**跳过**(不产出半截标签,也不浪费一个 Picture 编号):
 * 宁可不写,也不要写一句"某人"误导模型。
 *
 * @param subjects 参考素材(按连线顺序)
 * @returns 标签段文本;无有效条目时返回空串(调用方据此不插入该段)
 */
export function buildSubjectLabels(subjects?: PromptSubject[]): string {
  const valid = validSubjects(subjects);
  if (valid.length === 0) return '';
  return valid
    .map((s, i) => {
      const n = i + 1;
      const name = String(s.name).trim();
      const traits = String(s.traits ?? '').trim();
      if (s.kind === 'scene') {
        // 场景锁:特征给定时逐条列出,否则退回通用槽位说明
        return traits
          ? `<Subject ${n}> is the environment in <Picture ${n}> (scene lock — must match exactly: ${traits}).`
          : `<Subject ${n}> is the environment in <Picture ${n}> (scene lock: layout, landmarks, lighting).`;
      }
      /* 角色锁:实测「只写 face, hair, outfit」会漂(见 PromptSubject.traits 注释),
         故把具体特征显式列出,并追加一句**不许改**的硬约束。
         注意措辞用 "must match exactly" —— H3 官方 Ref2VA 结构里 retention 关系就是
         靠这类明确措辞表达的(fully_preserved / weak_reference),含糊的"lock"力度不够。 */
      return traits
        ? `<Subject ${n}> is ${name} in <Picture ${n}> (identity lock — must match exactly: ${traits}). Do not change this character's face, hairstyle, hair color, or outfit design.`
        : `<Subject ${n}> is ${name} in <Picture ${n}> (identity lock: face, hair, outfit). Do not change this character's face, hairstyle, or outfit design.`;
    })
    .join('\n');
}

/** 过滤掉名字为空白的条目(它们不占 Picture 编号,否则标签与图会错位) */
function validSubjects(subjects?: PromptSubject[]): PromptSubject[] {
  return (subjects ?? []).filter((s) => String(s?.name ?? '').trim());
}

/**
 * 组装 Ref2VA 的 `retention_analysis:` 段(纯函数,便于单测)。
 *
 * 为什么单独成段(H3 官方 Ref2VA 骨架的必需段落,2026-10-09 补):
 * 官方模板把「参考素材保留关系」单列为一段,逐主体声明保留强度:
 *
 *   retention_analysis:
 *   <Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - ...
 *   <Subject 2> (appears in [Shot 1]): weak_reference - ...
 *
 * 而只写一句笼统的 `identity lock` 时,模型收到的是「请保持一致」这种**无强度**的要求。
 * 实测事故:角色卡明确定义为「深灰战术背心」,提示词却在 4 处反复写 `red coat`,
 * 参考图与文字互相冲突,出片自然锁不住 —— 而 `fully_preserved` 这类**逐项声明**
 * 能把「哪个主体、保留到什么程度」讲清楚,是官方结构里专门治这个的部分。
 *
 * 角色用 `fully_preserved`(身份必须完全保留);场景用 `fully_preserved` 但声明
 * 保留的是布局/地标/光位(环境本就不该逐像素照搬,重点是空间关系稳定)。
 *
 * @param subjects 参考素材(按连线顺序,与 `buildSubjectLabels` 同一份)
 * @param shotLabels 该主体出现的镜头标签(如 `[Shot 1]`);缺省给 `[Shot 1]`
 * @returns 段落文本;无有效条目时返回空串(调用方据此不插入该段)
 */
export function buildRetentionAnalysis(subjects?: PromptSubject[], shotLabels?: string[]): string {
  const valid = validSubjects(subjects);
  if (valid.length === 0) return '';
  const where = (shotLabels ?? ['[Shot 1]']).join(', ');
  const lines = valid.map((s, i) => {
    const n = i + 1;
    if (s.kind === 'scene') {
      return `<Subject ${n}> (appears in ${where}): fully_preserved - spatial layout, landmarks, and lighting direction unchanged from <Picture ${n}>.`;
    }
    return `<Subject ${n}> (appears in ${where}): fully_preserved - face, hairstyle, hair color, outfit design, and body proportions unchanged from <Picture ${n}>.`;
  });
  return `retention_analysis:\n${lines.join('\n')}`;
}

/**
 * 未提供 basePrompt 时的中性量化光照。
 * 风格词只能由 basePrompt(技能风格锁)提供；禁止重新加入「电影感 / 写实」等空泛兜底。
 */
const DEFAULT_QUANTIFIED_LIGHT =
  '主光从主体右前方 45°、略高于视线照入，左后侧形成阴影；主体与背景保留明暗层次';

/**
 * 把过去挤在 `Camera: 景别 · 运镜` 里的信息拆成独立摄影指令。
 * 扩展列为空就不输出对应行:旧 10 列表不会得到一堆「未指定」。
 */
function buildCameraLines(row: string[] | undefined, head: string[]): string[] {
  const lines = [`Shot Size: ${rowCell(row, head, '景别')}`];
  const optional: Array<[label: string, column: string]> = [
    ['Horizontal Angle', '水平角度'],
    ['Height', '机位高度'],
    ['Lens Intent', '焦段'],
  ];
  for (const [label, column] of optional) {
    const value = rowCell(row, head, column).trim();
    if (value) lines.push(`${label}: ${value}`);
  }
  lines.push(`Movement: ${rowCell(row, head, '运镜') || '固定'}`);
  for (const [label, column] of [
    ['Composition', '构图'],
    ['Eyeline', '视线'],
    ['Focus', '焦点'],
    ['Stability', '稳定性'],
  ] as Array<[string, string]>) {
    const value = rowCell(row, head, column).trim();
    if (value) lines.push(`${label}: ${value}`);
  }
  return lines;
}

/** 可选生成指令行;空值不占位。 */
function optionalPromptLine(label: string, value: string): string[] {
  const v = value.trim();
  return v ? [`${label}: ${v}`] : [];
}

/** H3 五段式组装(shot 节点;「提示词(可选)」列有值则显式使用)
 *
 * @param subjects 参考素材(Ref2VA 镜传入;按连线顺序 → 生成 `<Subject n>` 标签段)。
 *                 first-frame(FL2VA)镜不传 —— FL2VA 与 ref-image 互斥,没有 Picture 可言。
 *                 ⚠️ 显式提示词(表格「提示词(可选)」列有值)时**不覆盖**,尊重作者原文;
 *                 此时标签段由作者自己写(技能文档已给出写法)。
 */
export function assembleH3Prompt(
  row: string[] | undefined,
  head: string[],
  basePrompt?: string,
  subjects?: PromptSubject[],
): { explicit: boolean; text: string } {
  const p = rowCell(row, head, '提示词(可选)').trim();
  if (p) return { explicit: true, text: p };
  const look = (basePrompt ?? '').trim() || DEFAULT_QUANTIFIED_LIGHT;
  const dial = rowCell(row, head, '对白/旁白').trim();
  const hasDial = !!dial && dial !== '无' && dial !== '—';
  const action = hasDial
    ? /[「『]/.test(dial)
      ? dial
      : `对白「${dial}」`
    : '无对白 · 以肢体动作推进';
  const scene = rowCell(row, head, '画面描述');
  const blocking = rowCell(row, head, '站位(blocking)');
  const lighting = rowCell(row, head, '光位');
  const soundscapeDetail = rowCell(row, head, '声景').trim() || '环境音';
  const music = rowCell(row, head, '配乐').trim();
  const cameraLines = buildCameraLines(row, head);
  /* Ref2VA(带参考素材)走 h3 官方的**分段结构**;否则沿用原来的五段式。
   *
   * 为什么分叉:官方 Ref2VA 骨架用 `overall_soundscape:` / `non_diegetic_music:` 这类
   * **固定段名**,模型是按段名解析的;用自造的 `Audio:` 会让这段落进「正文描述」而不是
   * 「声音轨」,音画配合会退化。T2VA/FL2VA 那些没有参考素材的场景不受影响,保持原样
   * (改它们只会引入无谓的回归面)。 */
  const labels = buildSubjectLabels(subjects);
  if (!labels) {
    const body = [
      `Scene: ${scene}`,
      ...optionalPromptLine('Blocking', blocking),
      `Action: ${action}`,
      ...cameraLines,
      `Look: ${look}`,
      ...optionalPromptLine('Lighting', lighting),
      `Audio: ${hasDial ? `口型同步 · ${soundscapeDetail}` : soundscapeDetail}`,
      ...optionalPromptLine('Music', music),
    ].join('\n');
    return { explicit: false, text: body };
  }
  const retention = buildRetentionAnalysis(subjects);
  const detailed = [
    `[Shot 1] ${scene}`,
    ...optionalPromptLine('Blocking', blocking),
    ...cameraLines,
    `Action: ${action}`,
    `Look: ${look}`,
    ...optionalPromptLine('Lighting', lighting),
  ].join('\n');
  const soundscape = hasDial ? `口型同步的人声 · ${soundscapeDetail}` : soundscapeDetail;
  return {
    explicit: false,
    text: [
      `subject_definitions:\n${labels}`,
      retention,
      `detailed_description:\n${detailed}`,
      `overall_soundscape: ${soundscape}`,
      `non_diegetic_music: ${music || 'N/A'}`,
    ].join('\n\n'),
  };
}

/**
 * 从 basePrompt / 画面描述抽出场景与光影短句(静帧六段式用)。
 * 禁止再写死「秋日河谷」「黄昏侧光」——那是旧模板事故。
 */
export function deriveStillSceneAndLight(
  row: string[] | undefined,
  head: string[],
  basePrompt?: string,
): { scene: string; light: string } {
  const desc = rowCell(row, head, '画面描述').trim();
  const look = (basePrompt ?? '').trim();
  const scene =
    desc.split(/[。.!！？\n]/)[0]?.trim().slice(0, 80) ||
    (look ? `继承风格锁 · ${look.slice(0, 40)}` : '按画面描述');
  const lightFromLook =
    look.match(/(?:光影|布光|光源|侧光|逆光|顶光|体积光|电影级布光)[^,，;；]{0,24}/)?.[0]?.trim() ||
    look.match(/(?:冷青|暗紫|幽蓝|暖黄|高反差)[^,，;；]{0,16}/)?.[0]?.trim();
  const light = lightFromLook || (look ? `继承风格锁` : '自然光影');
  return { scene, light };
}

/** Z-Image 六段式组装(image-gen 节点) */
export function assembleZImagePrompt(
  row: string[] | undefined,
  head: string[],
  basePrompt?: string,
): { explicit: boolean; text: string } {
  const p = rowCell(row, head, '提示词(可选)').trim();
  if (p) return { explicit: true, text: p };
  const look = (basePrompt ?? '').trim() || DEFAULT_QUANTIFIED_LIGHT;
  const { scene, light } = deriveStillSceneAndLight(row, head, basePrompt);
  const blocking = rowCell(row, head, '站位(blocking)').trim();
  const lighting = rowCell(row, head, '光位').trim();
  const composition = [
    rowCell(row, head, '景别'),
    ...(['焦段', '水平角度', '机位高度', '构图', '视线', '焦点'] as const).map((column) => {
      const value = rowCell(row, head, column).trim();
      return value ? `${column}:${value}` : '';
    }),
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    explicit: false,
    text: [
      `主体：${rowCell(row, head, '画面描述')}`,
      `场景：${scene}${blocking ? ` · 站位:${blocking}` : ''}`,
      `构图：${composition}`,
      `光影：${light}${lighting ? ` · ${lighting}` : ''}`,
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

/**
 * 档位预设(steps/layers/reuse/frames + ETA)— **全链唯一真源**。
 *
 * 为什么放 shared:这张表此前在**渲染层**(`constants.ts` 的 `SHOT_TIER_PRESETS`)与
 * **providers**(`h3c-command.ts` 的 `TIER_PRESETS`)各写一份,数值已经分叉过
 * (弹窗 ETA 与检查器 ETA 不一致,见 docs/连接器设计.md)。档位是「引擎参数 + 界面文案」
 * 交叉的东西,两边各写一份必然漂 —— 现在只有这一处,改档位改这里即可。
 *
 * ⚠️ **eta/etaMin 的口径 = 本机实测标定,不是上游文档抄数**:
 * 上游 H3_USAGE.md §4.3 给的是「5s 段 ~14-18 分钟 / high quality ~30-50 分钟」。
 * 2026-10-25 h3 把**视频 VAE 的 ViT 解码器从 FP32 改成 BF16**(MPS 张量核):
 * 960×544×124 的解码 159.45s → 47.33s(3.37x),端到端 409.95s → 316.93s,
 * VAE 峰值显存 9.37 → 4.68 GiB(相对误差 0.0048,VPIPE 的阈值是 0.02)。
 * VAE 解码耗时 ∝ 帧数 × 像素数,按各档位(以 1:1 尺寸为锚)折算,端到端各省:
 *   预览 448²/22 帧 ≈ 8s · 草稿 544²/56 帧 ≈ 29s · 默认 544²/124 帧 ≈ 64s · 参考 768²/124 帧 ≈ 127s
 * 即旧值 4/9/15/30 各减 {0.13, 0.48, 1.06, 2.11} 分钟 → 取整 4 / 9 / 14 / 28。
 * ⚠️ 加速包(步数变少)只压缩**去噪**那部分,权重加载与 VAE 解码是固定成本 ——
 *    渲染层按 `etaMin × (实际步数 / 档位步数)` 缩放只是粗估,别当承诺。
 */
export interface VideoTierPreset {
  /** 档位名(中文,给人看) */
  label: string;
  steps: number;
  layers: number;
  reuse: number;
  frames: number;
  /** ETA 文案(1:1 尺寸锚) */
  eta: string;
  /** ETA 分钟数(1:1 尺寸锚) */
  etaMin: number;
  note: string;
}

export const VIDEO_TIER_PRESETS: Record<VideoTier, VideoTierPreset> = {
  preview: { label: '预览', steps: 6, layers: 40, reuse: 2, frames: 22, eta: '≈4 分钟', etaMin: 4, note: '极速草稿(reuse2 防呆安全)' },
  draft: { label: '草稿', steps: 12, layers: 50, reuse: 2, frames: 56, eta: '≈9 分钟', etaMin: 9, note: '快速出片' },
  default: { label: '默认', steps: 20, layers: 50, reuse: 1, frames: 124, eta: '≈14 分钟', etaMin: 14, note: '5s 段甜点' },
  reference: { label: '参考', steps: 30, layers: 50, reuse: 1, frames: 124, eta: '≈28 分钟', etaMin: 28, note: 'high quality · gold 档' },
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