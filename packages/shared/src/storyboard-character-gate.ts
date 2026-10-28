/**
 * 分镜 → 铺节点的角色一致性硬闸。
 *
 * 只拦「同一角色跨 2 镜及以上复用」：这类镜头若靠各镜独立静帧生成，脸型/服装没有权威身份源。
 * 单镜人物、空镜、剪影与一次性路人不要求建卡。
 */
import {
  cardMatchesToken,
  collectMaterializeCards,
  parseRoleTokens,
  type MaterializeNodeLike,
} from './storyboard-materialize.js';
import { rowCell } from './prompt.js';

export interface StoryboardCharacterIssue {
  /** missing-card = 角色列已点名但画布缺卡;unnamed-recurring = 描述里重复人物但角色列未指派 */
  kind: 'missing-card' | 'unnamed-recurring';
  name: string;
  rows: number[];
}

/** 这些技能明确用「每镜静帧」而非角色卡锁构图;显式点名的缺卡仍照常拦截。 */
const STILL_FRAME_SKILL_IDS = new Set(['paper-collage-explainer']);

/** 保守的人物名词表:命中跨镜复现才要求卡;不把「两人/他们」单独当身份。 */
const HUMAN_SUBJECTS: Array<[name: string, re: RegExp]> = [
  ['模特', /女模|男模|模特/],
  ['女主角', /女主角|女主/],
  ['男主角', /男主角|男主/],
  ['主角', /主角/],
  ['女孩', /女孩|女童/],
  ['男孩', /男孩|男童/],
  ['女人', /女人|女性|女子/],
  ['男人', /男人|男性|男子/],
  ['老人', /老人|老者/],
  ['少女', /少女/],
  ['少年', /少年/],
  ['孩子', /孩子|儿童/],
  ['骑士', /骑士/],
  ['武士', /武士/],
  ['警察', /警察/],
  ['医生', /医生/],
  ['教师', /老师|教师/],
  ['学生', /学生/],
  ['演员', /演员/],
  ['歌手', /歌手/],
  ['舞者', /舞者/],
  ['保安', /保安/],
  ['侦探', /侦探/],
  ['孕妇', /孕妇/],
];

export function checkStoryboardCharacterGate(opts: {
  head: string[];
  rows: string[][];
  canvasNodes: MaterializeNodeLike[];
  activeSkillId?: string;
}): StoryboardCharacterIssue[] {
  const { head, rows, canvasNodes } = opts;
  const cards = collectMaterializeCards(canvasNodes).filter((c) => c.kind === 'character');
  const issues: StoryboardCharacterIssue[] = [];

  // ① 角色列重复点名:不论技能,重复身份必须有真实角色卡可连。
  const named = new Map<string, { name: string; rows: number[] }>();
  rows.forEach((row, i) => {
    for (const token of parseRoleTokens(rowCell(row, head, '角色'))) {
      const key = token.trim().toLowerCase();
      if (!key) continue;
      const entry = named.get(key) ?? { name: token, rows: [] };
      entry.rows.push(i + 1);
      named.set(key, entry);
    }
  });
  for (const entry of named.values()) {
    if (entry.rows.length < 2) continue;
    if (!cards.some((card) => cardMatchesToken(card.name, entry.name))) {
      issues.push({ kind: 'missing-card', name: entry.name, rows: entry.rows });
    }
  }

  // ② 角色列全空的行:保守识别重复人物名词,防止模型写「本片无角色卡,留空」绕过①。
  if (!opts.activeSkillId || !STILL_FRAME_SKILL_IDS.has(opts.activeSkillId)) {
    const unnamed = new Map<string, { name: string; rows: number[] }>();
    rows.forEach((row, i) => {
      if (rowCell(row, head, '角色').trim()) return;
      const desc = rowCell(row, head, '画面描述');
      for (const [name, re] of HUMAN_SUBJECTS) {
        if (!re.test(desc)) continue;
        const entry = unnamed.get(name) ?? { name, rows: [] };
        entry.rows.push(i + 1);
        unnamed.set(name, entry);
      }
    });
    for (const entry of unnamed.values()) {
      if (entry.rows.length >= 2) issues.push({ kind: 'unnamed-recurring', ...entry });
    }
  }
  return issues;
}

/** 给 Agent / UI 的同一份可执行错误文案。 */
export function storyboardCharacterGateMessage(issues: StoryboardCharacterIssue[]): string {
  if (!issues.length) return '';
  const details = issues
    .slice(0, 4)
    .map((issue) =>
      issue.kind === 'missing-card'
        ? `角色「${issue.name}」在第 ${issue.rows.join('、')} 镜重复出现，但画布没有对应角色卡`
        : `第 ${issue.rows.join('、')} 镜重复出现「${issue.name}」，但「角色」列没有指定角色卡`,
    )
    .join('；');
  return `分镜一致性门未通过：${details}。请先为每个重复角色创建「角色卡·名字」（有参考图用 image-edit 并连 input；无参考用 image-gen；默认全身正面），提交出图后，在分镜表「角色」列逐镜填写卡名，再重新铺节点。禁止用各镜独立静帧代替角色卡，否则跨镜人脸与服装无法锁定。`;
}
