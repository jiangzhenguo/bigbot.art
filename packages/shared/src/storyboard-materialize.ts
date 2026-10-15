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
 *  2. 画布上有角色卡/场景卡 → `ref`(全部连 ref-image,Ref2VA;不建静帧)
 *  3. 「需配图=是」→ `keyframe`(建 image-gen 作首帧)
 *  4. 否则 → `text`(纯文生视频)
 *
 * 渲染层 / Agent tool-handlers / 确定性 plan 三处必须同口径调用本模块。
 */
import { rowCell, rowNeedsImage, type PromptSubject } from './prompt.js';

/** 可当参考卡的图片节点 kind */
const CARD_KINDS = new Set(['image-gen', 'image-edit', 'asset']);

const CHARACTER_LABEL_RE = /角色卡|角色设定|character\s*card/i;
const SCENE_LABEL_RE = /场景卡|场景设定|环境底图|环境卡|scene\s*card|environment\s*card/i;

/** 硬切/换场 → 打断镜间接续,重新走 ref 或 keyframe */
const HARD_CUT_RE =
  /硬切|切换场景|切到|转场|另一场景|新场景|场景切换|换场|cut\s*to|hard\s*cut|scene\s*change/i;

export type MaterializeStrategy = 'ref' | 'continue' | 'keyframe' | 'text';

export type MaterializeShotMode = 'text2video' | 'first-frame' | 'ref-image';

/** 画布上识别出的参考卡(角色 / 场景) */
export interface MaterializeCard {
  nodeId: string;
  kind: 'character' | 'scene';
  /** 写入 Subject 标签的名字(从标题剥离「角色卡·」等前缀) */
  name: string;
}

/** 单行铺节点计划(纯数据,调用方负责分配 id / 落盘) */
export interface MaterializeRowPlan {
  rowNo: number;
  strategy: MaterializeStrategy;
  shotMode: MaterializeShotMode;
  /** 锁定模式,避免派生态把 mode 从连线改回 text2video */
  modeOverride: boolean;
  /** 是否新建 image-gen 并以 first-frame 连到本镜 */
  createKeyframe: boolean;
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

/** 从标题抽出主体名:「角色卡·苏青」→「苏青」 */
export function cardNameFromLabel(label: string, kind: 'character' | 'scene'): string {
  const cleaned = String(label ?? '')
    .replace(CHARACTER_LABEL_RE, '')
    .replace(SCENE_LABEL_RE, '')
    .replace(/^[·\-—:：\s]+|[·\-—:：\s]+$/g, '')
    .trim();
  if (cleaned) return cleaned;
  return kind === 'scene' ? '场景' : '角色';
}

/** 扫描画布:角色卡在前、场景卡在后(与 Ref2VA Picture 编号习惯一致) */
export function collectMaterializeCards(nodes: MaterializeNodeLike[]): MaterializeCard[] {
  const chars: MaterializeCard[] = [];
  const scenes: MaterializeCard[] = [];
  for (const n of nodes) {
    const label = nodeDisplayLabel(n);
    if (isCharacterCardNode(n)) {
      chars.push({ nodeId: n.id, kind: 'character', name: cardNameFromLabel(label, 'character') });
    } else if (isSceneCardNode(n)) {
      scenes.push({ nodeId: n.id, kind: 'scene', name: cardNameFromLabel(label, 'scene') });
    }
  }
  return [...chars, ...scenes];
}

export function cardsToSubjects(cards: MaterializeCard[]): PromptSubject[] {
  return cards.map((c) => ({ name: c.name, kind: c.kind }));
}

/** 运镜 / 画面描述暗示硬切换场 */
export function isHardCutRow(row: string[] | undefined, head: string[]): boolean {
  const move = rowCell(row, head, '运镜');
  const scene = rowCell(row, head, '画面描述');
  return HARD_CUT_RE.test(move) || HARD_CUT_RE.test(scene);
}

/**
 * 从已铺节点反查「行号 → shot id」(追加铺时用来接续上一镜)。
 * 只认 kind=shot 且 promptFrom 指向该分镜表某行。
 */
export function existingShotByRow(
  nodes: MaterializeNodeLike[],
  storyboardId: string,
): Map<number, string> {
  const m = new Map<number, string>();
  for (const n of nodes) {
    if (String(n.kind ?? '') !== 'shot') continue;
    const data =
      n.data && typeof n.data === 'object' ? (n.data as { promptFrom?: { nodeId?: string; mode?: string; row?: number } }) : {};
    const pf = data.promptFrom;
    if (pf?.nodeId === storyboardId && pf.mode === 'row' && typeof pf.row === 'number') {
      m.set(pf.row, n.id);
    }
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
  const cards = collectMaterializeCards(opts.canvasNodes ?? []);
  const subjects = cardsToSubjects(cards);
  const refIds = cards.map((c) => c.nodeId);
  const hasRefs = refIds.length > 0;

  const plans: MaterializeRowPlan[] = [];
  /** 已有 shot 的行 + 本批刚计划的行 —— 判断「上一行是否有 shot 可接」 */
  const coveredRows = new Set<number>(done);

  for (let r = 0; r < opts.rows.length; r++) {
    const rowNo = r + 1;
    if (done.has(rowNo)) continue;
    const row = opts.rows[r];
    const hardCut = isHardCutRow(row, head);
    const prevRow = rowNo - 1;
    const canContinue = !hardCut && prevRow >= 1 && coveredRows.has(prevRow);

    let plan: MaterializeRowPlan;
    if (canContinue) {
      plan = {
        rowNo,
        strategy: 'continue',
        shotMode: 'first-frame',
        modeOverride: true,
        createKeyframe: false,
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
        createKeyframe: false,
        refNodeIds: [...refIds],
        subjects: [...subjects],
      };
    } else if (rowNeedsImage(row, head)) {
      plan = {
        rowNo,
        strategy: 'keyframe',
        shotMode: 'first-frame',
        modeOverride: true,
        createKeyframe: true,
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
  const text = plans.filter((p) => p.strategy === 'text').length;
  const parts = [`${n} shot`];
  if (keys) parts.push(`${keys} 静帧`);
  if (refs) parts.push(`${refs} 镜绑定参考卡`);
  if (cont) parts.push(`${cont} 镜接续上一镜尾帧`);
  if (text) parts.push(`${text} 镜纯文生`);
  return parts.join(' · ');
}
