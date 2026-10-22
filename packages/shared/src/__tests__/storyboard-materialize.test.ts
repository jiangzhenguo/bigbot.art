/**
 * 分镜表铺节点策略单测
 *
 * 锁住「更符合逻辑」的三条:
 *  1. 有角色卡/场景卡 → 首镜 Ref2VA,不机械建 image-gen
 *  2. 后续镜 → 接续上一镜(FL2VA),不建静帧、不混连 ref-image
 *  3. 无参考卡时:仅首镜(或硬切后)按需配图建静帧,后续仍接续
 */
import { describe, it, expect } from 'vitest';
import {
  cardNameFromLabel,
  collectMaterializeCards,
  isCharacterCardNode,
  isHardCutRow,
  isSceneCardNode,
  planStoryboardMaterializeRows,
  parseRoleTokens,
  rowLink,
  selectCardsForRow,
  summarizeMaterializePlans,
} from '../storyboard-materialize.js';

const HEAD = ['镜号', '画面描述', '对白/旁白', '景别', '运镜', '时长(s)', '需配图', '提示词(可选)'];

function row(
  n: number,
  scene: string,
  opts?: { move?: string; needImg?: string },
): string[] {
  return [
    String(n),
    scene,
    '',
    '中景',
    opts?.move ?? '固定',
    '5',
    opts?.needImg ?? '是',
    '',
  ];
}

describe('卡片识别', () => {
  it('角色卡 / 场景卡按标题命中', () => {
    expect(isCharacterCardNode({ id: 'a', kind: 'image-gen', label: '角色卡·苏青' })).toBe(true);
    expect(isSceneCardNode({ id: 'b', kind: 'image-gen', label: '场景卡·厨房' })).toBe(true);
    expect(isCharacterCardNode({ id: 'c', kind: 'image-gen', label: '分镜静帧 01' })).toBe(false);
  });

  it('人物卡与 image-stitch 拼图也算角色卡', () => {
    expect(isCharacterCardNode({ id: 'a', kind: 'image-stitch', label: '锦衣卫猫猫人 · 人物卡' })).toBe(true);
    expect(isCharacterCardNode({ id: 'b', kind: 'image-stitch', label: '魂游怪物 · 角色卡' })).toBe(true);
  });

  it('从标题剥离前缀得到主体名', () => {
    expect(cardNameFromLabel('角色卡·苏青', 'character')).toBe('苏青');
    expect(cardNameFromLabel('场景卡 - 河谷', 'scene')).toBe('河谷');
    expect(cardNameFromLabel('锦衣卫猫猫人 · 人物卡', 'character')).toBe('锦衣卫猫猫人');
  });

  it('collect 角色在前、场景在后', () => {
    const cards = collectMaterializeCards([
      { id: 's1', kind: 'image-gen', label: '场景卡·厨房' },
      { id: 'c1', kind: 'image-gen', label: '角色卡·苏青' },
      { id: 'c2', kind: 'asset', label: '角色卡·阿凯' },
    ]);
    expect(cards.map((c) => c.nodeId)).toEqual(['c1', 'c2', 's1']);
  });

  it('同身份多视图去重,拼图优先', () => {
    const cards = collectMaterializeCards([
      { id: 'side', kind: 'image-edit', label: '魂游怪物 · 侧面' },
      { id: 'front', kind: 'image-gen', label: '魂游怪物 · 全身铠甲 · 正面角色卡' },
      { id: 'stitch', kind: 'image-stitch', label: '魂游怪物 · 角色卡' },
      { id: 'scene', kind: 'image-gen', label: '破败宫殿 · 场景卡' },
    ]);
    expect(cards.filter((c) => c.kind === 'character').map((c) => c.nodeId)).toEqual(['stitch']);
    expect(cards.filter((c) => c.kind === 'scene').map((c) => c.nodeId)).toEqual(['scene']);
  });
});

describe('按行选卡', () => {
  const cards = collectMaterializeCards([
    { id: 'cat', kind: 'image-stitch', label: '锦衣卫猫猫人 · 人物卡' },
    { id: 'ghost', kind: 'image-stitch', label: '魂游怪物 · 角色卡' },
    { id: 'hall', kind: 'image-gen', label: '破败宫殿 · 场景卡' },
  ]);
  const headRole = [...HEAD, '衔接', '角色'];

  it('角色列点名只连本镜出场', () => {
    const row = ['1', '猫猫人登场', '', '中景', '固定', '5', '否', '', '硬切', '猫猫人'];
    expect(selectCardsForRow(row, headRole, cards).map((c) => c.nodeId)).toEqual(['cat']);
  });

  it('角色列可同时点名角色与场景', () => {
    const row = ['4', '身高对比对峙', '', '大远景', '仰拍', '5', '是', '', '硬切', '猫猫人、魂游怪物、破败宫殿'];
    expect(selectCardsForRow(row, headRole, cards).map((c) => c.nodeId).sort()).toEqual(['cat', 'ghost', 'hall']);
  });

  it('空镜不写角色 → 不挂角色卡,场景仍可按画面描述命中', () => {
    const row = ['1', '破败宫殿大殿全景,画面无人', '', '大远景', '横摇', '5', '否', '', '硬切', ''];
    expect(selectCardsForRow(row, headRole, cards).map((c) => c.nodeId)).toEqual(['hall']);
  });

  it('无角色列时按画面描述命中', () => {
    const head = [...HEAD, '衔接'];
    const row = ['2', '猫猫人从阴影中走出', '', '中景', '固定', '5', '否', '', '硬切'];
    expect(selectCardsForRow(row, head, cards).map((c) => c.nodeId)).toContain('cat');
    expect(selectCardsForRow(row, head, cards).map((c) => c.nodeId)).not.toContain('ghost');
  });

  it('parseRoleTokens 认中英文分隔', () => {
    expect(parseRoleTokens('猫猫人、魂游怪物, 破败宫殿')).toEqual(['猫猫人', '魂游怪物', '破败宫殿']);
  });
});

describe('硬切判定', () => {
  it('运镜或画面描述含硬切词', () => {
    expect(isHardCutRow(row(2, '室内', { move: '硬切' }), HEAD)).toBe(true);
    expect(isHardCutRow(row(2, '切到夜景街道'), HEAD)).toBe(true);
    expect(isHardCutRow(row(2, '继续推近'), HEAD)).toBe(false);
  });
});

const HEAD_LINK = [...HEAD, '衔接'];

function linkedRow(n: number, scene: string, link: string, needImg = '是'): string[] {
  return [String(n), scene, '', '中景', '固定', '5', needImg, '', link];
}

describe('衔接列', () => {
  it('没写列是 auto;写了硬切或接尾帧按字面认', () => {
    expect(rowLink(row(1, '开场'), HEAD)).toBe('auto');
    expect(rowLink(linkedRow(2, '走廊', '硬切'), HEAD_LINK)).toBe('cut');
    expect(rowLink(linkedRow(2, '接着动', '接尾帧'), HEAD_LINK)).toBe('continue');
  });

  it('硬切打断尾帧,有角色卡且需配图=是时另建静帧并且静帧走参考图', () => {
    const plans = planStoryboardMaterializeRows({
      head: HEAD_LINK,
      rows: [
        linkedRow(1, '夜街站街', '硬切'),
        linkedRow(2, '夜街贴身谈价', '接尾帧', '否'),
        linkedRow(3, '廉价钟点房走廊', '硬切'),
        linkedRow(4, '走廊里继续往前走', '接尾帧', '否'),
      ],
      canvasNodes: [{ id: 'c1', kind: 'image-gen', label: '角色卡·林晚秋' }],
    });
    expect(plans.map((p) => p.strategy)).toEqual(['ref', 'continue', 'ref', 'continue']);
    expect(plans[0]!.createKeyframe).toBe(true);
    expect(plans[0]!.keyframeAs).toBe('ref-image');
    expect(plans[0]!.refNodeIds).toEqual(['c1']);
    expect(plans[1]!.continueFromRow).toBe(1);
    expect(plans[1]!.refNodeIds).toEqual([]);
    expect(plans[2]!.createKeyframe).toBe(true);
    expect(plans[2]!.continueFromRow).toBeUndefined();
    expect(plans[2]!.refNodeIds).toEqual(['c1']);
    expect(plans[3]!.continueFromRow).toBe(3);
  });

  it('硬切但需配图=否 → 只挂卡、不建静帧', () => {
    const plans = planStoryboardMaterializeRows({
      head: HEAD_LINK,
      rows: [linkedRow(1, '夜街站街', '硬切', '否'), linkedRow(2, '继续谈', '接尾帧', '否')],
      canvasNodes: [{ id: 'c1', kind: 'image-gen', label: '角色卡·林晚秋' }],
    });
    expect(plans[0]!.strategy).toBe('ref');
    expect(plans[0]!.createKeyframe).toBe(false);
    expect(plans[0]!.refNodeIds).toEqual(['c1']);
    expect(plans[1]!.strategy).toBe('continue');
  });

  it('显式接尾帧压过画面描述里的硬切词', () => {
    const plans = planStoryboardMaterializeRows({
      head: HEAD_LINK,
      rows: [linkedRow(1, '开场', '硬切'), linkedRow(2, '切到她的手', '接尾帧', '否')],
    });
    expect(plans.map((p) => p.strategy)).toEqual(['keyframe', 'continue']);
  });

  it('无参考卡的硬切即使需配图=否也建静帧,不接上一镜', () => {
    const plans = planStoryboardMaterializeRows({
      head: HEAD_LINK,
      rows: [linkedRow(1, '街', '硬切'), linkedRow(2, '室内', '硬切', '否')],
    });
    expect(plans.map((p) => p.strategy)).toEqual(['keyframe', 'keyframe']);
    expect(plans[1]!.keyframeAs).toBe('first-frame');
    expect(plans[1]!.continueFromRow).toBeUndefined();
  });
});

describe('planStoryboardMaterializeRows', () => {
  it('无参考卡:首镜 keyframe,后续 continue(即使需配图=是也不再建静帧)', () => {
    const plans = planStoryboardMaterializeRows({
      head: HEAD,
      rows: [row(1, '开场'), row(2, '接续动作'), row(3, '再推进')],
    });
    expect(plans.map((p) => p.strategy)).toEqual(['keyframe', 'continue', 'continue']);
    expect(plans[0]!.createKeyframe).toBe(true);
    expect(plans[0]!.shotMode).toBe('first-frame');
    expect(plans[1]!.continueFromRow).toBe(1);
    expect(plans[2]!.continueFromRow).toBe(2);
    expect(plans[1]!.createKeyframe).toBe(false);
    expect(plans[1]!.refNodeIds).toEqual([]);
  });

  it('有角色卡+场景卡:首镜 ref,后续 continue,全程不建静帧', () => {
    const plans = planStoryboardMaterializeRows({
      head: HEAD,
      rows: [row(1, '开场'), row(2, '接续')],
      canvasNodes: [
        { id: 'char-1', kind: 'image-gen', label: '角色卡·苏青' },
        { id: 'scene-1', kind: 'image-gen', label: '场景卡·厨房' },
      ],
    });
    expect(plans.map((p) => p.strategy)).toEqual(['ref', 'continue']);
    expect(plans[0]!.shotMode).toBe('ref-image');
    expect(plans[0]!.refNodeIds).toEqual(['char-1', 'scene-1']);
    expect(plans[0]!.subjects.map((s) => s.name)).toEqual(['苏青', '厨房']);
    expect(plans.every((p) => !p.createKeyframe)).toBe(true);
    expect(plans[1]!.continueFromRow).toBe(1);
    expect(plans[1]!.refNodeIds).toEqual([]); // FL2VA 与 Ref2VA 互斥
  });

  it('硬切打断接续:硬切行重新走 ref(有卡)或 keyframe', () => {
    const withCards = planStoryboardMaterializeRows({
      head: HEAD,
      rows: [row(1, 'A'), row(2, '切到夜景', { move: '硬切' }), row(3, '夜景继续')],
      canvasNodes: [{ id: 'c1', kind: 'image-gen', label: '角色卡·主角' }],
    });
    expect(withCards.map((p) => p.strategy)).toEqual(['ref', 'ref', 'continue']);
    expect(withCards[1]!.refNodeIds).toEqual(['c1']);
    expect(withCards[2]!.continueFromRow).toBe(2);

    const noCards = planStoryboardMaterializeRows({
      head: HEAD,
      rows: [row(1, 'A'), row(2, '切到夜景', { move: '硬切' })],
    });
    expect(noCards.map((p) => p.strategy)).toEqual(['keyframe', 'keyframe']);
  });

  it('追加铺:上一行已 done → 本行 continue', () => {
    const plans = planStoryboardMaterializeRows({
      head: HEAD,
      rows: [row(1, 'A'), row(2, 'B')],
      doneRows: [1],
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.strategy).toBe('continue');
    expect(plans[0]!.continueFromRow).toBe(1);
  });

  it('需配图=否且无卡 → text', () => {
    const plans = planStoryboardMaterializeRows({
      head: HEAD,
      rows: [row(1, '空镜', { needImg: '否' })],
    });
    expect(plans[0]!.strategy).toBe('text');
    expect(plans[0]!.shotMode).toBe('text2video');
  });

  it('摘要可读', () => {
    const plans = planStoryboardMaterializeRows({
      head: HEAD,
      rows: [row(1, 'A'), row(2, 'B')],
      canvasNodes: [{ id: 'c1', kind: 'image-gen', label: '角色卡·A' }],
    });
    const s = summarizeMaterializePlans(plans);
    expect(s).toContain('2 shot');
    expect(s).toContain('绑定参考卡');
    expect(s).toContain('接续');
  });
});
