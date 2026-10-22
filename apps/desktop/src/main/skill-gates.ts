/**
 * 技能硬闸门 — 把技能文档里「不可跳步」的规则落成代码判定
 *
 * 为什么需要(2026-10-12「技能2测试」事故):co-op-game-intro 已改为全量注入、
 * Agent 也调了 3 次 skills.read,仍然跳过角色卡,直接出主菜单合影静帧并把它
 * first-frame 直通给镜头 —— 文档规则对模型只是建议,只有工具层拒绝才是约束。
 *
 * 2026-10-13 补:music-video-subtitle 只在 prompt 里写配乐、不连 ref-audio,
 * 成片根本没用上用户音乐 —— 见 `checkMasterAudioGate`。
 *
 * 判定全是纯函数;engine.submit 在提交前调用 `checkSkillSubmitGates`。
 */
import type { CanvasEdge, CanvasNode } from '@bigbotart/shared';
import { isCharacterCardNode } from '@bigbotart/shared';

/** 需要角色卡先行的技能 → 至少几张已出图的角色卡 */
export const SKILL_CHARACTER_CARD_MIN: Record<string, number> = {
  'co-op-game-intro': 2,
  '3d-animation-short': 1,
};

/** 提交 shot 前必须已连 ref-audio(用户主音轨)的技能 */
export const SKILL_REQUIRE_REF_AUDIO = new Set<string>(['music-video-subtitle']);

/** 画布已有用户真实素材时,产品画面必须 image-edit(原图底图)、禁止 image-gen 重画的技能 */
export const SKILL_REQUIRE_PHOTO_EDIT = new Set<string>(['minimalist-product-ad']);

const GATED_KINDS = new Set(['shot', 'image-gen', 'image-edit']);

/** 与 shared `isCharacterCardNode` 同口径(角色卡标题识别) */
export function isCharacterCard(node: CanvasNode): boolean {
  return isCharacterCardNode(node);
}

function hasOutput(node: CanvasNode): boolean {
  const d = (node.data ?? {}) as Record<string, unknown>;
  if (node.kind === 'asset') return Boolean(d.assetId);
  return typeof d.resultPath === 'string' && d.resultPath.length > 0;
}

const labelOf = (n: CanvasNode) => n.label || n.id;

/** 该节点是否直接(ref-image)或经一层图片(first-frame/ref-image 的上游以角色卡为 ref-image)锚定到角色卡 */
function anchoredToCards(target: CanvasNode, nodes: CanvasNode[], edges: CanvasEdge[]): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const inbound = edges.filter((e) => e.target === target.id);
  if (inbound.some((e) => e.label === 'ref-image' && byId.get(e.source) && isCharacterCard(byId.get(e.source)!))) {
    return true;
  }
  return inbound
    .filter((e) => e.label === 'first-frame' || e.label === 'ref-image')
    .some((e) =>
      edges.some(
        (up) =>
          up.target === e.source &&
          up.label === 'ref-image' &&
          byId.get(up.source) !== undefined &&
          isCharacterCard(byId.get(up.source)!),
      ),
    );
}

export type GateResult = { ok: true } | { ok: false; reason: string };

/**
 * 角色卡先行闸门。
 *  - 未激活相关技能 / 提交的是角色卡本身 / 非生成类节点 → 放行
 *  - 已出图角色卡不足 → 拒绝(主菜单静帧、镜头都不许先跑)
 *  - 镜头未连到角色卡(直接或经确认静帧)→ 拒绝
 */
export function checkCharacterCardGate(
  skillId: string | undefined,
  target: CanvasNode,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): GateResult {
  const min = skillId ? SKILL_CHARACTER_CARD_MIN[skillId] : undefined;
  if (!min) return { ok: true };
  if (!GATED_KINDS.has(String(target.kind ?? ''))) return { ok: true };
  if (isCharacterCard(target)) return { ok: true };

  const cards = nodes.filter(isCharacterCard);
  const ready = cards.filter(hasOutput);
  if (ready.length < min) {
    const have = cards.length
      ? `画布上的角色卡:${cards.map((c) => `「${labelOf(c)}」${hasOutput(c) ? '(已出图)' : '(未出图)'}`).join('、')}。`
      : '画布上还没有任何角色卡节点。';
    return {
      ok: false,
      reason:
        `提交被拒绝:当前技能要求先出 ${min} 张角色卡(已出图 ${ready.length} 张),再生成主菜单静帧与视频。${have}` +
        `请先建角色卡「角色卡·PLAYER1」(有参考图→image-edit 以原图为 input;无参考→image-gen;` +
        `默认全身正面、简洁背景、无 UI)→ engine.submit → ask.user 确认,` +
        `${min > 1 ? '再做「角色卡·PLAYER2」,' : ''}之后再提交「${labelOf(target)}」。`,
    };
  }

  if (target.kind === 'shot' && !anchoredToCards(target, nodes, edges)) {
    return {
      ok: false,
      reason:
        `提交被拒绝:镜头「${labelOf(target)}」没有锚定到角色卡,人物会每镜重画。` +
        `请 canvas.connect 把 ${ready.map((c) => `「${labelOf(c)}」`).join('、')} 以 label="ref-image" 连到该镜头` +
        `(mode 会自动切到「关联」),或让它的首帧来自一张已连角色卡的确认静帧。`,
    };
  }
  return { ok: true };
}

/** 镜头是否已有 ref-audio 入边(来源节点存在即可;媒体类型由后续 referenceMediaIssues 再验) */
export function hasRefAudioEdge(target: CanvasNode, nodes: CanvasNode[], edges: CanvasEdge[]): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return edges.some((e) => e.target === target.id && e.label === 'ref-audio' && byId.has(e.source));
}

/**
 * Master Audio 闸门(music-video-subtitle)。
 * 用户音乐必须经 asset/audio-ref → shot 的 ref-audio 进入 h3 `--ref-audio`;
 * 只在 prompt 里写「配乐」不算用了音乐。
 */
export function checkMasterAudioGate(
  skillId: string | undefined,
  target: CanvasNode,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): GateResult {
  if (!skillId || !SKILL_REQUIRE_REF_AUDIO.has(skillId)) return { ok: true };
  if (target.kind !== 'shot') return { ok: true };
  if (hasRefAudioEdge(target, nodes, edges)) return { ok: true };

  const audioish = nodes.filter((n) => {
    const kind = String(n.kind ?? '');
    const label = String(n.label ?? '');
    if (kind === 'audio-ref') return true;
    if (kind === 'asset' && /主音轨|master\s*audio|音乐|配乐|歌曲|beat|bgm/i.test(label)) return true;
    return false;
  });
  const hint = audioish.length
    ? `画布上已有可用音源:${audioish.map((n) => `「${labelOf(n)}」`).join('、')}。` +
      `请 canvas.connect 把其中之一以 label="ref-audio" 连到「${labelOf(target)}」,再 engine.submit。`
    : `画布上还没有主音轨节点。请先 assets.import 导入用户音乐 → canvas.create_node(kind="asset", label="主音轨·Master Audio") 绑定该音频` +
      `→ canvas.connect(label="ref-audio") 连到「${labelOf(target)}」,再 engine.submit。`;

  return {
    ok: false,
    reason:
      `提交被拒绝:当前技能「音乐MV动态字幕」要求镜头必须连用户音乐(ref-audio → h3 --ref-audio)。` +
      `只在 prompt 里写配乐/BPM/歌词不会把真实音轨送进引擎。${hint}`,
  };
}

/**
 * 产品保真闸门(minimalist-product-ad,2026-10-14「技能5测试」事故)。
 *
 * 事故形态:用户上传了真实产品图(画布上有绑好资产的资源节点),Agent 却用
 * image-gen **重新生成**产品当分镜静帧/锚图 —— 纯文生图画出来的是另一件产品,
 * 用户的真实产品从未进入成片链路(只在第一步 image-edit 出现过一次)。
 *
 * 规则:该技能激活时,画布上只要存在**绑定了资产的资源节点**(= 用户已提供真实素材),
 * 就拒绝提交 image-gen —— 产品画面必须经 image-edit 以真实照片为 input 底图。
 * 画布上没有任何用户素材时放行(技能本来就允许 image-gen 从文字生成锚图)。
 */
export function checkProductPhotoEditGate(
  skillId: string | undefined,
  target: CanvasNode,
  nodes: CanvasNode[],
  _edges: CanvasEdge[],
): GateResult {
  if (!skillId || !SKILL_REQUIRE_PHOTO_EDIT.has(skillId)) return { ok: true };
  if (target.kind !== 'image-gen') return { ok: true };
  const boundAssets = nodes.filter(
    (n) => n.kind === 'asset' && String(((n.data ?? {}) as Record<string, unknown>).assetId ?? '').trim(),
  );
  if (boundAssets.length === 0) return { ok: true };
  return {
    ok: false,
    reason:
      `提交被拒绝:当前技能「极简产品广告」要求产品画面必须由真实照片编辑而来,画布上已有用户素材:` +
      `${boundAssets.map((n) => `「${labelOf(n)}」`).join('、')}。` +
      `禁止用 image-gen 重新生成产品本体(那画出来的是另一件产品)。` +
      `正确做法:canvas.create_node(kind="image-edit") → canvas.connect 把资源节点/已确认锚图以 label="input" 连入` +
      `→ 写清「保留产品本体、只改背景/光影/构图」的编辑提示词 → engine.submit。` +
      `只有当画布上没有任何用户素材时,才允许 image-gen 生成产品画面。`,
  };
}

/**
 * 角色参考图编辑闸(全局,2026-10-22)。
 *
 * 事故:用户上传猫照片说「根据图片生成角色图」,Agent 建 image-gen 并把资产连成
 * ref-image(Klein 多参考)——约定要求走 image-edit + input 底图编辑。
 * 系统提示曾只在「激活技能」时注入,无技能时整段丢失。
 *
 * 规则:提交 image-gen 且入边有来自 **asset** 的 ref-image → 拒绝。
 * 资产是用户真图;把它当多参考文生图等于绕开编辑保真。无资产参考的纯文生图放行。
 */
export function checkCharacterRefEditGate(
  target: CanvasNode,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): GateResult {
  if (target.kind !== 'image-gen') return { ok: true };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const assetRefs = edges.filter(
    (e) =>
      e.target === target.id &&
      e.label === 'ref-image' &&
      byId.get(e.source)?.kind === 'asset',
  );
  if (assetRefs.length === 0) return { ok: true };
  const names = assetRefs
    .map((e) => byId.get(e.source))
    .filter(Boolean)
    .map((n) => `「${labelOf(n!)}」`)
    .join('、');
  return {
    ok: false,
    reason:
      `提交被拒绝:「${labelOf(target)}」是 image-gen,却把用户素材 ${names} 连成了 ref-image。` +
      `有参考图出角色卡/角色图时必须走编辑:canvas.create_node(kind="image-edit")` +
      `→ canvas.connect 把参考图以 label="input" 连入 → 写编辑提示词(默认全身正面)→ engine.submit。` +
      `不要用 image-gen + ref-image 多参考重画。无参考图时才允许纯 image-gen 文生图。`,
  };
}

/** 聚合所有技能提交闸;任一拒绝即返回该拒绝 */
export function checkSkillSubmitGates(
  skillId: string | undefined,
  target: CanvasNode,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): GateResult {
  const a = checkCharacterCardGate(skillId, target, nodes, edges);
  if (!a.ok) return a;
  const b = checkMasterAudioGate(skillId, target, nodes, edges);
  if (!b.ok) return b;
  const c = checkProductPhotoEditGate(skillId, target, nodes, edges);
  if (!c.ok) return c;
  return checkCharacterRefEditGate(target, nodes, edges);
}
