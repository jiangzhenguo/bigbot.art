/**
 * 技能硬闸门:
 *  - 角色卡先行(2026-10-12「技能2测试」事故回归)
 *  - Master Audio / ref-audio(2026-10-13「音乐MV没使用音乐」事故回归)
 */
import { describe, expect, it } from 'vitest';
import type { CanvasEdge, CanvasNode } from '@bigbotart/shared';
import {
  checkCharacterCardGate,
  checkMasterAudioGate,
  checkProductPhotoEditGate,
  checkSkillSubmitGates,
  hasRefAudioEdge,
  isCharacterCard,
} from '../skill-gates';

const node = (id: string, kind: string, label: string, data: Record<string, unknown> = {}): CanvasNode =>
  ({ id, kind, label, position: { x: 0, y: 0 }, width: 240, data, createdAt: 't', updatedAt: 't' }) as CanvasNode;
const edge = (source: string, target: string, label: string): CanvasEdge => ({ id: `${source}-${target}`, source, target, label });

const card1 = node('c1', 'image-gen', '角色卡·PLAYER1', { resultPath: '/o/c1.png' });
const card2 = node('c2', 'image-gen', '角色卡·PLAYER2', { resultPath: '/o/c2.png' });
const menu = node('m', 'image-edit', '主菜单确认静帧', { resultPath: '/o/m.png' });
const shot = node('s', 'shot', '镜头 01');
const masterAudio = node('a', 'asset', '主音轨·Master Audio', { assetId: 'asset-song' });

describe('isCharacterCard', () => {
  it('按标题识别图片/资产节点', () => {
    expect(isCharacterCard(card1)).toBe(true);
    expect(isCharacterCard(node('a', 'asset', '角色设定·NOVA'))).toBe(true);
    expect(isCharacterCard(node('x', 'shot', '角色卡镜头'))).toBe(false);
    expect(isCharacterCard(menu)).toBe(false);
  });
});

describe('checkCharacterCardGate', () => {
  it('未激活相关技能 → 放行', () => {
    expect(checkCharacterCardGate(undefined, shot, [shot], []).ok).toBe(true);
    expect(checkCharacterCardGate('h3-prompt-writing', shot, [shot], []).ok).toBe(true);
  });

  it('事故形态:没有角色卡就提交主菜单静帧 → 拒绝并给出建卡指引', () => {
    const r = checkCharacterCardGate('co-op-game-intro', menu, [menu], []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('2 张角色卡');
      expect(r.reason).toContain('角色卡·PLAYER1');
    }
  });

  it('只有 1 张已出图角色卡(co-op 需要 2 张)→ 拒绝', () => {
    const pending = node('c2', 'image-gen', '角色卡·PLAYER2');
    const r = checkCharacterCardGate('co-op-game-intro', menu, [card1, pending, menu], []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('未出图');
  });

  it('提交角色卡本身永远放行', () => {
    expect(checkCharacterCardGate('co-op-game-intro', node('c1', 'image-gen', '角色卡·PLAYER1'), [], []).ok).toBe(true);
  });

  it('角色卡齐了 → 主菜单静帧放行', () => {
    expect(checkCharacterCardGate('co-op-game-intro', menu, [card1, card2, menu], []).ok).toBe(true);
  });

  it('镜头直接连角色卡 ref-image → 放行', () => {
    const edges = [edge('c1', 's', 'ref-image'), edge('c2', 's', 'ref-image')];
    expect(checkCharacterCardGate('co-op-game-intro', shot, [card1, card2, shot], edges).ok).toBe(true);
  });

  it('镜头首帧来自已连角色卡的确认静帧 → 放行', () => {
    const edges = [edge('c1', 'm', 'ref-image'), edge('c2', 'm', 'ref-image'), edge('m', 's', 'first-frame')];
    expect(checkCharacterCardGate('co-op-game-intro', shot, [card1, card2, menu, shot], edges).ok).toBe(true);
  });

  it('镜头首帧来自未连角色卡的静帧 → 拒绝(合影锁不住人)', () => {
    const edges = [edge('m', 's', 'first-frame')];
    const r = checkCharacterCardGate('co-op-game-intro', shot, [card1, card2, menu, shot], edges);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('ref-image');
  });

  it('本地处理节点不受闸门约束', () => {
    const crop = node('k', 'image-crop', '裁切');
    expect(checkCharacterCardGate('co-op-game-intro', crop, [crop], []).ok).toBe(true);
  });
});

describe('checkMasterAudioGate · music-video-subtitle', () => {
  it('未激活该技能 → 放行', () => {
    expect(checkMasterAudioGate(undefined, shot, [shot], []).ok).toBe(true);
    expect(checkMasterAudioGate('co-op-game-intro', shot, [shot], []).ok).toBe(true);
  });

  it('事故形态:有技能但镜头没连 ref-audio → 拒绝并指引连主音轨', () => {
    const r = checkMasterAudioGate('music-video-subtitle', shot, [masterAudio, shot], []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/ref-audio|--ref-audio/);
      expect(r.reason).toContain('主音轨');
    }
  });

  it('画布上连主音轨都没有 → 拒绝并指引 assets.import', () => {
    const r = checkMasterAudioGate('music-video-subtitle', shot, [shot], []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/assets\.import|主音轨/);
  });

  it('shot 已连 ref-audio → 放行', () => {
    const edges = [edge('a', 's', 'ref-audio')];
    expect(checkMasterAudioGate('music-video-subtitle', shot, [masterAudio, shot], edges).ok).toBe(true);
    expect(hasRefAudioEdge(shot, [masterAudio, shot], edges)).toBe(true);
  });

  it('audio-ref 节点连 ref-audio → 放行', () => {
    const ar = node('ar', 'audio-ref', '音频参考');
    const edges = [edge('ar', 's', 'ref-audio')];
    expect(checkMasterAudioGate('music-video-subtitle', shot, [ar, shot], edges).ok).toBe(true);
  });

  it('非 shot 节点不受此闸约束', () => {
    expect(checkMasterAudioGate('music-video-subtitle', menu, [menu], []).ok).toBe(true);
  });

  it('checkSkillSubmitGates 聚合:MV 技能缺音轨时角色卡闸放行仍被音轨闸拦住', () => {
    const r = checkSkillSubmitGates('music-video-subtitle', shot, [shot], []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/ref-audio/);
  });
});

/* ── 产品保真闸(2026-10-14「技能5测试」事故:用户传了真实产品图,
      Agent 却用 image-gen 重新画了一把键盘当分镜静帧/首帧)── */
describe('checkProductPhotoEditGate(minimalist-product-ad)', () => {
  it('未激活该技能 → 放行', () => {
    const g = node('g', 'image-gen', '分镜静帧 01');
    const a = node('a', 'asset', '键盘产品主图', { assetId: 'asset-x' });
    expect(checkProductPhotoEditGate(undefined, g, [a, g], []).ok).toBe(true);
    expect(checkProductPhotoEditGate('brand-promo-video', g, [a, g], []).ok).toBe(true);
  });

  it('事故形态:画布已有用户素材资源节点,提交 image-gen → 拒绝并指引 image-edit', () => {
    const g = node('g', 'image-gen', '分镜静帧 01');
    const a = node('a', 'asset', '键盘产品主图', { assetId: 'asset-x' });
    const r = checkProductPhotoEditGate('minimalist-product-ad', g, [a, g], []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('键盘产品主图');
      expect(r.reason).toContain('image-edit');
      expect(r.reason).toMatch(/input/);
    }
  });

  it('画布上没有任何绑定资产的资源节点 → 放行(无素材场景技能允许 image-gen)', () => {
    const g = node('g', 'image-gen', '锚定照片 1');
    const empty = node('a', 'asset', '空资源节点'); // 未绑定 assetId 不算用户素材
    expect(checkProductPhotoEditGate('minimalist-product-ad', g, [g], []).ok).toBe(true);
    expect(checkProductPhotoEditGate('minimalist-product-ad', g, [empty, g], []).ok).toBe(true);
  });

  it('image-edit / shot 不受此闸约束(闸门只管 image-gen)', () => {
    const e = node('e', 'image-edit', '锚定图(编辑)');
    const a = node('a', 'asset', '产品图', { assetId: 'asset-x' });
    expect(checkProductPhotoEditGate('minimalist-product-ad', e, [a, e], []).ok).toBe(true);
    expect(checkProductPhotoEditGate('minimalist-product-ad', shot, [a, shot], []).ok).toBe(true);
  });

  it('聚合入口 checkSkillSubmitGates 同样拦截', () => {
    const g = node('g', 'image-gen', '分镜静帧 01');
    const a = node('a', 'asset', '产品图', { assetId: 'asset-x' });
    const r = checkSkillSubmitGates('minimalist-product-ad', g, [a, g], []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('image-edit');
  });
});
