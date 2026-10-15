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

  it('从标题剥离前缀得到主体名', () => {
    expect(cardNameFromLabel('角色卡·苏青', 'character')).toBe('苏青');
    expect(cardNameFromLabel('场景卡 - 河谷', 'scene')).toBe('河谷');
  });

  it('collect 角色在前、场景在后', () => {
    const cards = collectMaterializeCards([
      { id: 's1', kind: 'image-gen', label: '场景卡·厨房' },
      { id: 'c1', kind: 'image-gen', label: '角色卡·苏青' },
      { id: 'c2', kind: 'asset', label: '角色卡·阿凯' },
    ]);
    expect(cards.map((c) => c.nodeId)).toEqual(['c1', 'c2', 's1']);
  });
});

describe('硬切判定', () => {
  it('运镜或画面描述含硬切词', () => {
    expect(isHardCutRow(row(2, '室内', { move: '硬切' }), HEAD)).toBe(true);
    expect(isHardCutRow(row(2, '切到夜景街道'), HEAD)).toBe(true);
    expect(isHardCutRow(row(2, '继续推近'), HEAD)).toBe(false);
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
