/**
 * 分镜表铺节点策略 — 单一事实源
 *
 * 旧实现机械地「每行 = 1 shot + (需配图? 1 image-gen : 0)」:
 *  - 不连画布上已有的角色卡/场景卡 → 人物环境每镜重画
 *  - 不把上一镜成片尾帧接到下一镜首帧 → 镜间断裂
 *  - first-frame(FL2VA) 与 ref-image(Ref2VA) 互斥,混连会被拒
 *
 * 新策略(按行决策,优先级从上到下):
 *  1. 上一镜可接续且本行不是硬切 → `continue`(shot→shot first-frame,FL2VA)
 *  2. 本行选中的角色卡/场景卡 → `ref`(连 ref-image,Ref2VA;需配图=是才另建静帧)
 *  3. 「需配图=是」或硬切 → `keyframe`(建 image-gen 作首帧)
 *  4. 否则 → `text`(纯文生视频)
 *
 * 渲染层 / Agent tool-handlers / 确定性 plan 三处必须同口径调用本模块。
 */
import { rowCell, rowNeedsImage, type PromptSource, type PromptSubject } from './prompt.js';

/** 可当参考卡的图片节点 kind(含拼图角色卡) */
const CARD_KINDS = new Set(['image-gen', 'image-edit', 'asset', 'image-stitch']);

const CHARACTER_LABEL_RE = /角色卡|人物卡|角色设定|character\s*card/i;
const SCENE_LABEL_RE = /场景卡|场景设定|环境底图|环境卡|scene\s*card|environment\s*card/i;

/** 视图/变体后缀:同一角色的侧面/背面/特写不当作另一张卡 */
const VIEW_HINT_RE = /侧面|背面|正面|头部|特写|全身|立姿|bust|side|back|front|3\s*[dD]|写实版|设定图/i;

/** 硬切/换场 → 打断镜间接续,重新走 ref 或 keyframe */
const HARD_CUT_RE =
  /硬切|切换场景|切到|转场|另一场景|新场景|场景切换|换场|cut\s*to|hard\s*cut|scene\s*change/i;

const ROLE_SPLIT_RE = /[,，、/;；|]+/;

export type MaterializeStrategy = 'ref' | 'continue' | 'keyframe' | 'text';

export type MaterializeShotMode = 'text2video' | 'first-frame' | 'ref-image';

/** 画布上识别出的参考卡(角色 / 场景) */
export interface MaterializeCard {
  nodeId: string;
  kind: 'character' | 'scene';
  /** 写入 Subject 标签的名字(从标题剥离「角色卡·」等前缀) */
  name: string;
  /** 源节点 kind(拼图优先) */
  sourceKind?: string;
  /** 原始标题(去重视图判定) */
  label?: string;
}

/** 单行铺节点计划(纯数据,调用方负责分配 id / 落盘) */
export interface MaterializeRowPlan {
  rowNo: number;
  strategy: MaterializeStrategy;
  shotMode: MaterializeShotMode;
  /** 锁定模式,避免派生态把 mode 从连线改回 text2video */
  modeOverride: boolean;
  /** 是否新建 image-gen 静帧 */
  createKeyframe: boolean;
  /**
   * 静帧接到镜头的端口。
   * ref-image:有参考卡的硬切镜,静帧和角色卡同属 Ref2VA,不占首帧。
   * first-frame:没有参考卡,静帧就是这一镜的第一帧。
   */
  keyframeAs: 'first-frame' | 'ref-image';
  /** 连到本镜的 ref-image 源节点 id(角色卡/场景卡) */
  refNodeIds: string[];
  /**
   * 接续来源的分镜行号(1-based)。
   * 调用方用「本批已建 shot」或「画布已有 shot」的 row→id 表解析成真实 nodeId。
   */
  continueFromRow?: number;
  /** 传给 assembleH3Prompt 的 Subject 列表(仅 ref 策略) */
  subjects: PromptSubject[];
}

/** 轻量节点形状(主进程 CanvasNode / 渲染层本地节点都能喂进来) */
export interface MaterializeNodeLike {
  id: string;
  kind?: string;
  label?: string;
  title?: string;
  /** 宽松:CanvasNode.data 是联合类型,不做强约束 */
  data?: unknown;
}

export function nodeDisplayLabel(n: MaterializeNodeLike): string {
  return String(n.label ?? n.title ?? '').trim();
}

export function isCharacterCardNode(n: MaterializeNodeLike): boolean {
  return CARD_KINDS.has(String(n.kind ?? '')) && CHARACTER_LABEL_RE.test(nodeDisplayLabel(n));
}

export function isSceneCardNode(n: MaterializeNodeLike): boolean {
  return CARD_KINDS.has(String(n.kind ?? '')) && SCENE_LABEL_RE.test(nodeDisplayLabel(n));
}

/** 从标题抽出主体名:「角色卡·苏青」→「苏青」;「锦衣卫猫猫人 · 人物卡」→「锦衣卫猫猫人」 */
export function cardNameFromLabel(label: string, kind: 'character' | 'scene'): string {
  const cleaned = String(label ?? '')
    .replace(CHARACTER_LABEL_RE, '')
    .replace(SCENE_LABEL_RE, '')
    .replace(/^[·\-—:：\s]+|[·\-—:：\s]+$/g, '')
    .trim();
  if (cleaned) return cleaned;
  return kind === 'scene' ? '场景' : '角色';
}

/** 同一角色的身份键:取第一个 ·/— 分段,忽略视图后缀 */
export function cardIdentityKey(name: string): string {
  const head = (String(name).split(/[·\-—:/]/)[0] ?? name).trim();
  return head.replace(/\s+/g, '').toLowerCase() || String(name).replace(/\s+/g, '').toLowerCase();
}

function cardPreferScore(c: MaterializeCard): number {
  const label = c.label ?? c.name;
  let s = 0;
  if (c.sourceKind === 'image-stitch') s += 100;
  if (CHARACTER_LABEL_RE.test(label) || SCENE_LABEL_RE.test(label)) s += 40;
  if (!VIEW_HINT_RE.test(label)) s += 20;
  s -= Math.min(label.length, 80);
  return s;
}

/** 同一身份只留一张卡:拼图 > 无视图后缀的「角色卡/人物卡」> 其余 */
export function dedupeMaterializeCards(cards: MaterializeCard[]): MaterializeCard[] {
  const best = new Map<string, MaterializeCard>();
  for (const c of cards) {
    const key = `${c.kind}:${cardIdentityKey(c.name)}`;
    const prev = best.get(key);
    if (!prev || cardPreferScore(c) > cardPreferScore(prev)) best.set(key, c);
  }
  const chars: MaterializeCard[] = [];
  const scenes: MaterializeCard[] = [];
  for (const c of best.values()) {
    if (c.kind === 'character') chars.push(c);
    else scenes.push(c);
  }
  return [...chars, ...scenes];
}

/** 扫描画布:角色卡在前、场景卡在后(与 Ref2VA Picture 编号习惯一致);同身份去重 */
export function collectMaterializeCards(nodes: MaterializeNodeLike[]): MaterializeCard[] {
  const raw: MaterializeCard[] = [];
  for (const n of nodes) {
    const label = nodeDisplayLabel(n);
    if (isCharacterCardNode(n)) {
      raw.push({
        nodeId: n.id,
        kind: 'character',
        name: cardNameFromLabel(label, 'character'),
        sourceKind: String(n.kind ?? ''),
        label,
      });
    } else if (isSceneCardNode(n)) {
      raw.push({
        nodeId: n.id,
        kind: 'scene',
        name: cardNameFromLabel(label, 'scene'),
        sourceKind: String(n.kind ?? ''),
        label,
      });
    }
  }
  return dedupeMaterializeCards(raw);
}

export function cardsToSubjects(cards: MaterializeCard[]): PromptSubject[] {
  return cards.map((c) => {
    const short = (c.name.split(/[·\-—]/)[0] ?? c.name).trim();
    return { name: short || c.name, kind: c.kind };
  });
}

/** 「角色」列拆成名字列表 */
export function parseRoleTokens(cell: string): string[] {
  return String(cell ?? '')
    .split(ROLE_SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function cardMatchesToken(cardName: string, token: string): boolean {
  const a = String(cardName ?? '').replace(/\s+/g, '');
  const b = String(token ?? '').replace(/\s+/g, '');
  if (!a || !b) return false;
  const aKey = cardIdentityKey(a);
  const bKey = cardIdentityKey(b);
  return a.includes(b) || b.includes(a) || aKey.includes(bKey) || bKey.includes(aKey);
}

function descMentionsCard(desc: string, card: MaterializeCard): boolean {
  const d = String(desc ?? '');
  if (!d) return false;
  const key = (card.name.split(/[·\-—]/)[0] ?? card.name).trim();
  if (key.length >= 2 && d.includes(key)) return true;
  /* 「锦衣卫猫猫人」对「猫猫人从阴影中走出」:用身份键的后缀短名命中 */
  if (key.length >= 2) {
    for (let i = 0; i <= key.length - 2; i++) {
      const sub = key.slice(i);
      if (sub.length >= 2 && d.includes(sub)) return true;
    }
  }
  return cardMatchesToken(card.name, d);
}

/**
 * 按行选出本镜该连的卡。
 * - 表头有「角色」列:只连列里点名的角色;场景卡仍可按画面描述命中。
 * - 无「角色」列(旧表):按画面描述命中;一个都没命中时回退全部(兼容模糊行)。
 */
export function selectCardsForRow(
  row: string[] | undefined,
  head: string[],
  allCards: MaterializeCard[],
): MaterializeCard[] {
  if (!allCards.length) return [];
  const hasRoleCol = head.indexOf('角色') >= 0;
  const desc = rowCell(row, head, '画面描述');
  if (hasRoleCol) {
    const tokens = parseRoleTokens(rowCell(row, head, '角色'));
    const out: MaterializeCard[] = [];
    for (const c of allCards) {
      if (c.kind === 'character') {
        if (tokens.some((t) => cardMatchesToken(c.name, t))) out.push(c);
      } else if (tokens.some((t) => cardMatchesToken(c.name, t)) || descMentionsCard(desc, c)) {
        out.push(c);
      }
    }
    return out;
  }
  const matched = allCards.filter((c) => descMentionsCard(desc, c));
  if (matched.length > 0) return matched;
  return allCards;
}

/** 运镜 / 画面描述暗示硬切换场 */
export function isHardCutRow(row: string[] | undefined, head: string[]): boolean {
  const move = rowCell(row, head, '运镜');
  const scene = rowCell(row, head, '画面描述');
  return HARD_CUT_RE.test(move) || HARD_CUT_RE.test(scene);
}

/** 「衔接」列:硬切 / 接尾帧 / 没写(沿用硬切词与接续) */
export type RowLink = 'cut' | 'continue' | 'auto';

/**
 * 读「衔接」列。显式值优先于画面描述里的硬切词。
 * 旧表没有这一列时返回 auto,铺节点行为与加列之前一致。
 */
export function rowLink(row: string[] | undefined, head: string[]): RowLink {
  const v = rowCell(row, head, '衔接').trim();
  if (!v) return 'auto';
  if (/硬切|换场|不接尾帧|\bhard\s*cut\b/i.test(v)) return 'cut';
  if (/接尾帧|接续/.test(v)) return 'continue';
  return 'auto';
}

/** 静帧边的端口。调用方三处(plan / tool-handlers / CanvasPage)都用它,避免一处写死 first-frame。 */
export function keyframeEdgeLabel(plan: Pick<MaterializeRowPlan, 'keyframeAs'>): 'first-frame' | 'ref-image' {
  return plan.keyframeAs === 'ref-image' ? 'ref-image' : 'first-frame';
}

/**
 * 铺节点时写入下游的归属。`promptFrom` 会被边分派按文档边重写,
 * `storyboardId` / `storyboardRow` 留下来,整理和已铺行统计仍认得出。
 */
export function storyboardLinkFields(nodeId: string, row: number): {
  promptFrom: PromptSource;
  storyboardId: string;
  storyboardRow: number;
} {
  return {
    promptFrom: { nodeId, mode: 'row', row },
    storyboardId: nodeId,
    storyboardRow: row,
  };
}

/**
 * 节点属于哪张分镜表的哪一行。
 * 先看边分派清不掉的 storyboardId / storyboardRow,没有再退回 promptFrom(mode=row)。
 */
export function storyboardLinkOf(data: unknown): { nodeId: string; row?: number } | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as {
    storyboardId?: unknown;
    storyboardRow?: unknown;
    promptFrom?: { nodeId?: unknown; mode?: unknown; row?: unknown };
  };
  const fromField = typeof d.storyboardId === 'string' && d.storyboardId ? d.storyboardId : undefined;
  const fieldRow = typeof d.storyboardRow === 'number' && Number.isFinite(d.storyboardRow) ? d.storyboardRow : undefined;
  const ps = d.promptFrom;
  const fromPrompt = ps && ps.mode === 'row' && typeof ps.nodeId === 'string' && ps.nodeId ? ps.nodeId : undefined;
  const promptRow = typeof ps?.row === 'number' && Number.isFinite(ps.row) ? ps.row : undefined;
  const nodeId = fromField ?? fromPrompt;
  if (!nodeId) return undefined;
  const row = fromField ? fieldRow ?? (fromPrompt === nodeId ? promptRow : undefined) : promptRow;
  return typeof row === 'number' ? { nodeId, row } : { nodeId };
}

/**
 * 从已铺节点反查「行号 → shot id」(追加铺时用来接续上一镜)。
 * 只认 kind=shot,且 storyboardId / promptFrom 指向该分镜表某行。
 */
export function existingShotByRow(
  nodes: MaterializeNodeLike[],
  storyboardId: string,
): Map<number, string> {
  const m = new Map<number, string>();
  for (const n of nodes) {
    if (String(n.kind ?? '') !== 'shot') continue;
    const link = storyboardLinkOf(n.data);
    if (link?.nodeId === storyboardId && typeof link.row === 'number') m.set(link.row, n.id);
  }
  return m;
}

/**
 * 按行产出铺节点计划。跳过 `doneRows` 里已铺的行。
 * 不分配节点 id —— 调用方边建边把本批 shot 的 row→id 记下来供后续 continue 解析。
 */
export function planStoryboardMaterializeRows(opts: {
  head: string[];
  rows: string[][];
  doneRows?: Iterable<number>;
  canvasNodes?: MaterializeNodeLike[];
}): MaterializeRowPlan[] {
  const head = opts.head;
  const done = new Set(opts.doneRows ?? []);
  const allCards = collectMaterializeCards(opts.canvasNodes ?? []);

  const plans: MaterializeRowPlan[] = [];
  /** 已有 shot 的行 + 本批刚计划的行 —— 判断「上一行是否有 shot 可接」 */
  const coveredRows = new Set<number>(done);

  for (let r = 0; r < opts.rows.length; r++) {
    const rowNo = r + 1;
    if (done.has(rowNo)) continue;
    const row = opts.rows[r];
    const link = rowLink(row, head);
    /* 显式「接尾帧」压过文案里的硬切词;显式「硬切」一定断开。没写列时仍看硬切词。 */
    const hardCut = link === 'cut' || (link !== 'continue' && isHardCutRow(row, head));
    const prevRow = rowNo - 1;
    const canContinue = !hardCut && prevRow >= 1 && coveredRows.has(prevRow);
    const rowCards = selectCardsForRow(row, head, allCards);
    const subjects = cardsToSubjects(rowCards);
    const refIds = rowCards.map((c) => c.nodeId);
    const hasRefs = refIds.length > 0;
    const needImg = rowNeedsImage(row, head);
    /* 有参考卡时:只有显式硬切且「需配图=是」才另建静帧(卡已够用时不要白造一张)。
       静帧走 ref-image,和角色卡一起给 Ref2VA,不和上一镜尾帧混用。 */
    const stillWithRefs = link === 'cut' && needImg;

    let plan: MaterializeRowPlan;
    if (canContinue) {
      plan = {
        rowNo,
        strategy: 'continue',
        shotMode: 'first-frame',
        modeOverride: true,
        createKeyframe: false,
        keyframeAs: 'first-frame',
        refNodeIds: [],
        continueFromRow: prevRow,
        subjects: [],
      };
    } else if (hasRefs) {
      plan = {
        rowNo,
        strategy: 'ref',
        shotMode: 'ref-image',
        modeOverride: true,
        createKeyframe: stillWithRefs,
        keyframeAs: 'ref-image',
        refNodeIds: [...refIds],
        subjects: [...subjects],
      };
    } else if (needImg || link === 'cut') {
      plan = {
        rowNo,
        strategy: 'keyframe',
        shotMode: 'first-frame',
        modeOverride: true,
        createKeyframe: true,
        keyframeAs: 'first-frame',
        refNodeIds: [],
        subjects: [],
      };
    } else {
      plan = {
        rowNo,
        strategy: 'text',
        shotMode: 'text2video',
        modeOverride: false,
        createKeyframe: false,
        keyframeAs: 'first-frame',
        refNodeIds: [],
        subjects: [],
      };
    }
    plans.push(plan);
    coveredRows.add(rowNo);
  }
  return plans;
}

/** 人类可读摘要(工具返回 / toast) */
export function summarizeMaterializePlans(plans: MaterializeRowPlan[]): string {
  if (!plans.length) return '无新行';
  const n = plans.length;
  const refs = plans.filter((p) => p.strategy === 'ref').length;
  const cont = plans.filter((p) => p.strategy === 'continue').length;
  const keys = plans.filter((p) => p.strategy === 'keyframe').length;
  const stills = plans.filter((p) => p.createKeyframe).length;
  const text = plans.filter((p) => p.strategy === 'text').length;
  const parts = [`${n} shot`];
  if (stills) parts.push(`${stills} 静帧`);
  else if (keys) parts.push(`${keys} 静帧`);
  if (refs) parts.push(`${refs} 镜绑定参考卡`);
  if (cont) parts.push(`${cont} 镜接续上一镜尾帧`);
  if (text) parts.push(`${text} 镜纯文生`);
  return parts.join(' · ');
}
