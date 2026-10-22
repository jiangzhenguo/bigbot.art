/**
 * 边校验单测 — 方案 A(写入点强制校验)/ B(refs 单一事实源)/ D(提交前防呆)
 * 还原 n f s w 事故场景:image-crop → shot 首帧被连成双入边必须被拦下。
 */
import { describe, it, expect } from 'vitest';
import {
  validateEdge,
  allowedPortLabels,
  deriveShotRefsFromEdges,
  pendingImageUpstreamLabels,
  deriveAudioRefSource,
  validateRefsForSubmit,
  referenceMediaIssues,
  referenceAnchorConflictIssues,
  anchorReferenceConnectIssue,
  type EdgeNodeMin,
  type EdgeMin,
} from '../edge-validate.js';
import { SINGLE_VALUE_PORTS } from '../connector-map.js';

const assetNode = (id: string, mediaType = 'image'): EdgeNodeMin => ({
  id,
  kind: 'asset',
  data: { assetId: `asset-${id}`, mediaType },
});
const shotNode = (id: string, extra: Record<string, unknown> = {}): EdgeNodeMin => ({
  id,
  kind: 'shot',
  data: { mode: 'first-frame', ...extra },
});
const cropNode = (id: string): EdgeNodeMin => ({
  id,
  kind: 'image-crop',
  data: { resultPath: `/out/${id}.png` },
});
const imageNode = (id: string): EdgeNodeMin => ({
  id,
  kind: 'image-gen',
  data: { resultPath: `/out/${id}.png` },
});

const edge = (source: string, target: string, label: string): EdgeMin => ({ source, target, label });

describe('A · validateEdge 端口合法性', () => {
  it('image-crop → shot first-frame 类型上合法(n f s w 连接本身不是非法组合)', () => {
    const nodes = [assetNode('a'), shotNode('s'), cropNode('c')];
    const res = validateEdge(nodes, [], edge('c', 's', 'first-frame'));
    expect(res.ok).toBe(true);
  });

  it('非法 label(shoot 端口拼写错误)被拒,错误信息给出可用端口', () => {
    const nodes = [assetNode('a'), shotNode('s')];
    const res = validateEdge(nodes, [], edge('a', 's', 'first-framme'));
    expect(res.ok).toBe(false);
    expect(res.errors[0]!.code).toBe('port-not-allowed');
    expect(res.errors[0]!.message).toContain('first-frame');
  });

  it('自连被拒', () => {
    const nodes = [shotNode('s')];
    const res = validateEdge(nodes, [], edge('s', 's', 'first-frame'));
    expect(res.ok).toBe(false);
    expect(res.errors[0]!.code).toBe('self-loop');
  });

  it('重复边(同 from/to)被拒', () => {
    const nodes = [assetNode('a'), shotNode('s')];
    const existing = [edge('a', 's', 'first-frame')];
    const res = validateEdge(nodes, existing, edge('a', 's', 'first-frame'));
    expect(res.errors[0]!.code).toBe('duplicate-edge');
  });

  it('asset(video) → shot first-frame 被拒(媒体不匹配,提示可选 ref-video)', () => {
    const nodes = [assetNode('v', 'video'), shotNode('s')];
    const res = validateEdge(nodes, [], edge('v', 's', 'first-frame'));
    expect(res.ok).toBe(false);
    expect(res.errors[0]!.message).toContain('ref-video');
  });

  it('shot → shot first-frame 合法(镜头接续:上游尾帧 → 下游首帧,载荷是尾帧图片而非视频本体)', () => {
    const nodes = [shotNode('up', { resultPath: '/out/up.mp4', tailFramePath: '/out/up-last.png' }), shotNode('down')];
    const res = validateEdge(nodes, [], edge('up', 'down', 'first-frame'));
    expect(res.ok).toBe(true);
    expect(allowedPortLabels(shotNode('up'), 'shot')).toEqual(['first-frame', 'ref-video', 'ref-audio']);
  });

  it('shot → shot 尾帧未就绪也允许建边(连线先立,提交期 W004 兜底)', () => {
    const nodes = [shotNode('up'), shotNode('down')];
    expect(validateEdge(nodes, [], edge('up', 'down', 'first-frame')).ok).toBe(true);
  });

  it('shot → shot ref-video 合法(整段成片作 Ref2VA 参考视频)', () => {
    const nodes = [shotNode('up', { resultPath: '/out/up.mp4' }), shotNode('down')];
    expect(validateEdge(nodes, [], edge('up', 'down', 'ref-video')).ok).toBe(true);
    // 同一对节点之间仍受既有 duplicate-edge 规则约束:first-frame 与 ref-video 不能共存于同一对 up→down
    // (这是全端口通用限制,不是 ref-video 特有;下游要看参考视频就别再连首帧端口)
    const edges = [edge('up', 'down', 'first-frame')];
    const dup = validateEdge(nodes, edges, edge('up', 'down', 'ref-video'));
    expect(dup.ok).toBe(false);
    expect(dup.errors[0]!.code).toBe('duplicate-edge');
  });

  it('shot → shot 其他端口仍被拒(last-frame/ref-image 媒体不匹配)', () => {
    const nodes = [shotNode('up', { tailFramePath: '/out/up-last.png' }), shotNode('down')];
    for (const label of ['last-frame', 'ref-image']) {
      const res = validateEdge(nodes, [], edge('up', 'down', label));
      expect(res.ok, label).toBe(false);
      expect(res.errors[0]!.code, label).toBe('port-not-allowed');
    }
  });

  it('shot → shot first-frame 与已有 first-frame 入边冲突 ⇒ 可替换(单值端口)', () => {
    const nodes = [assetNode('a'), shotNode('up', { tailFramePath: '/out/up-last.png' }), shotNode('down')];
    const edges = [edge('a', 'down', 'first-frame')];
    const res = validateEdge(nodes, edges, edge('up', 'down', 'first-frame'));
    expect(res.ok).toBe(false);
    expect(res.errors[0]!.code).toBe('single-port-conflict');
    expect(res.errors[0]!.replaceable).toBe(true);
  });

  it('asset(video) → shot ref-video 合法', () => {
    const nodes = [assetNode('v', 'video'), shotNode('s')];
    const res = validateEdge(nodes, [], edge('v', 's', 'ref-video'));
    expect(res.ok).toBe(true);
  });

  it('workflow-input 槽位 label 必须以 slot- 开头', () => {
    const nodes = [assetNode('a'), { id: 'wi', kind: 'workflow-input', data: {} }];
    expect(validateEdge(nodes, [], edge('a', 'wi', 'input')).ok).toBe(false);
    expect(validateEdge(nodes, [], edge('a', 'wi', 'slot-人物')).ok).toBe(true);
  });

  it('workflow-output 收口 label 固定 output', () => {
    const nodes = [shotNode('s'), { id: 'wo', kind: 'workflow-output', data: {} }];
    expect(validateEdge(nodes, [], edge('s', 'wo', 'first-frame')).ok).toBe(false);
    expect(validateEdge(nodes, [], edge('s', 'wo', 'output')).ok).toBe(true);
  });
});

describe('A · 单值端口基数(first-frame 双入边 = n f s w 事故)', () => {
  it('shot 已有 asset→first-frame,再加 crop→first-frame 被标记为可替换冲突', () => {
    const nodes = [assetNode('a'), shotNode('s'), cropNode('c')];
    const edges = [edge('a', 's', 'first-frame')];
    const res = validateEdge(nodes, edges, edge('c', 's', 'first-frame'));
    expect(res.ok).toBe(false);
    expect(res.errors[0]!.code).toBe('single-port-conflict');
    expect(res.errors[0]!.replaceable).toBe(true);
    expect(res.errors[0]!.replacedEdge?.source).toBe('a');
  });

  it('替换语义后(旧边移除)校验通过', () => {
    const nodes = [assetNode('a'), shotNode('s'), cropNode('c')];
    const old = edge('a', 's', 'first-frame');
    // 手工模拟 handler 的替换:移除旧边后重新校验
    const afterReplace = [old].filter((e) => !(e.source === 'a' && e.target === 's'));
    const res = validateEdge(nodes, afterReplace, edge('c', 's', 'first-frame'));
    expect(res.ok).toBe(true);
  });

  it('ref-image 是多值端口,多条入边不冲突', () => {
    const nodes = [assetNode('a'), assetNode('b'), shotNode('s', { mode: 'ref-image' })];
    const edges = [edge('a', 's', 'ref-image')];
    const res = validateEdge(nodes, edges, edge('b', 's', 'ref-image'));
    expect(res.ok).toBe(true);
  });
});

describe('B · deriveShotRefsFromEdges(refs 由边推导)', () => {
  it('asset → shot first-frame 推导出 assetId 引用(auto)', () => {
    const nodes = [assetNode('a'), shotNode('s')];
    const refs = deriveShotRefsFromEdges(nodes, [edge('a', 's', 'first-frame')], 's');
    expect(refs).toEqual([{ assetId: 'asset-a', role: 'first-frame', auto: true }]);
  });

  it('两条 first-frame 入边推导出两个来源(提交层据此拦截)', () => {
    const nodes = [assetNode('a'), cropNode('c'), shotNode('s')];
    const refs = deriveShotRefsFromEdges(
      nodes,
      [edge('a', 's', 'first-frame'), edge('c', 's', 'first-frame')],
      's',
    );
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => (r.assetId ? `asset:${r.assetId}` : `path:${r.path}`))).toEqual([
      'asset:asset-a',
      'path:/out/c.png',
    ]);
  });

  it('shot → shot 接续用上游 tailFramePath 作首帧', () => {
    const nodes = [shotNode('up', { tailFramePath: '/out/up-last.png', resultPath: '/out/up.mp4' }), shotNode('down')];
    const refs = deriveShotRefsFromEdges(nodes, [edge('up', 'down', 'first-frame')], 'down');
    expect(refs).toEqual([{ path: '/out/up-last.png', role: 'first-frame', auto: true }]);
  });

  it('手动项(非 auto)保留优先,自动项按边覆盖', () => {
    const nodes = [assetNode('a'), shotNode('s')];
    const existing = [{ assetId: 'asset-manual', role: 'first-frame', auto: false }];
    const refs = deriveShotRefsFromEdges(nodes, [edge('a', 's', 'first-frame')], 's', existing);
    expect(refs.map((r) => r.assetId)).toEqual(['asset-manual']); // 手动项优先,边推导不注入
  });

  it('suppressed 角色不注入', () => {
    const nodes = [assetNode('a'), shotNode('s')];
    const refs = deriveShotRefsFromEdges(nodes, [edge('a', 's', 'first-frame')], 's', [], ['first-frame']);
    expect(refs).toEqual([]);
  });

  it('图片产物 → shot ref-image 推导出 path 引用(auto,参考图端口)', () => {
    const nodes = [imageNode('g'), shotNode('s', { mode: 'ref-image' })];
    const refs = deriveShotRefsFromEdges(nodes, [edge('g', 's', 'ref-image')], 's');
    expect(refs).toEqual([{ path: '/out/g.png', role: 'ref-image', auto: true }]);
  });

  it('两个图片产物源分别连 first-frame 与 ref-image:refs 两个端口各自推导', () => {
    const nodes = [imageNode('g'), { id: 'c', kind: 'image-crop', data: { resultPath: '/out/c.png' } }, shotNode('s')];
    const refs = deriveShotRefsFromEdges(
      nodes,
      [edge('g', 's', 'first-frame'), edge('c', 's', 'ref-image')],
      's',
    );
    expect(refs.find((r) => r.role === 'first-frame')).toEqual({ path: '/out/g.png', role: 'first-frame', auto: true });
    expect(refs.find((r) => r.role === 'ref-image')).toEqual({ path: '/out/c.png', role: 'ref-image', auto: true });
  });

  /* ── 视频参考(h3 --ref-video):三类视频源都必须能推导出 ref-video,否则连线可见但提交静默丢弃 ── */

  it('shot → shot ref-video 用上游成片作参考视频(auto)', () => {
    const nodes = [shotNode('up', { resultPath: '/out/up.mp4', tailFramePath: '/out/up-last.png' }), shotNode('down')];
    const refs = deriveShotRefsFromEdges(nodes, [edge('up', 'down', 'ref-video')], 'down');
    expect(refs).toEqual([{ path: '/out/up.mp4', role: 'ref-video', auto: true }]);
  });

  it('shot → shot 同时有 first-frame 与 ref-video 入边时:尾帧作首帧、成片作参考视频,两角色各自的推导互不干扰', () => {
    // 注:同一对节点同时建这两条边会被 validateEdge 的 duplicate-edge 拦下(通用规则)。
    // 本用例只锁死「推导层角色分派正确」,将来若放开同对多端口,行为仍然正确。
    const nodes = [shotNode('up', { resultPath: '/out/up.mp4', tailFramePath: '/out/up-last.png' }), shotNode('down')];
    const refs = deriveShotRefsFromEdges(nodes, [edge('up', 'down', 'first-frame'), edge('up', 'down', 'ref-video')], 'down');
    expect(refs.find((r) => r.role === 'first-frame')).toEqual({ path: '/out/up-last.png', role: 'first-frame', auto: true });
    expect(refs.find((r) => r.role === 'ref-video')).toEqual({ path: '/out/up.mp4', role: 'ref-video', auto: true });
  });

  it('shot → shot ref-video 在上游成片就绪前不注入(不写空路径),就绪后自动补上', () => {
    const pending = [shotNode('up', { tailFramePath: '/out/up-last.png' }), shotNode('down')];
    expect(deriveShotRefsFromEdges(pending, [edge('up', 'down', 'ref-video')], 'down')).toEqual([]);
    const ready = [shotNode('up', { resultPath: '/out/up.mp4' }), shotNode('down')];
    expect(deriveShotRefsFromEdges(ready, [edge('up', 'down', 'ref-video')], 'down')).toHaveLength(1);
  });

  it('video-upscale → shot ref-video 用增强成片作参考视频(auto)', () => {
    const nodes = [
      { id: 'u', kind: 'video-upscale', data: { resultPath: '/out/enhanced.mp4' } },
      shotNode('s'),
    ];
    const refs = deriveShotRefsFromEdges(nodes, [edge('u', 's', 'ref-video')], 's');
    expect(refs).toEqual([{ path: '/out/enhanced.mp4', role: 'ref-video', auto: true }]);
  });

  it('video-upscale → shot first-frame 不注入(端口载荷是静帧,须先取帧)', () => {
    const nodes = [{ id: 'u', kind: 'video-upscale', data: { resultPath: '/out/enhanced.mp4' } }, shotNode('s')];
    expect(deriveShotRefsFromEdges(nodes, [edge('u', 's', 'first-frame')], 's')).toEqual([]);
  });

  it('asset(video) → shot ref-video 推导出 assetId 引用', () => {
    const nodes = [assetNode('v', 'video'), shotNode('s')];
    const refs = deriveShotRefsFromEdges(nodes, [edge('v', 's', 'ref-video')], 's');
    expect(refs).toEqual([{ assetId: 'asset-v', role: 'ref-video', auto: true }]);
  });

  it('ref-video 是被手动绑定或被 × 停用时不注入(单值端口让位规则)', () => {
    const nodes = [shotNode('up', { resultPath: '/out/up.mp4' }), shotNode('down')];
    const existing = [{ assetId: 'asset-manual', role: 'ref-video', auto: false }];
    expect(deriveShotRefsFromEdges(nodes, [edge('up', 'down', 'ref-video')], 'down', existing)).toEqual(existing);
    expect(deriveShotRefsFromEdges(nodes, [edge('up', 'down', 'ref-video')], 'down', [], ['ref-video'])).toEqual([]);
  });
});

describe('D · 提交前防呆', () => {
  it('图片上游无产物 ⇒ pendingImageUpstreamLabels 点名', () => {
    const still: EdgeNodeMin = { id: 'img1', kind: 'image-gen', label: '分镜静帧 01', data: {} };
    const ready: EdgeNodeMin = {
      id: 'img2',
      kind: 'image-gen',
      label: '角色卡',
      data: { resultPath: '/tmp/char.png' },
    };
    const shot = shotNode('s');
    const edges: EdgeMin[] = [
      { id: 'e1', source: 'img1', target: 's', label: 'ref-image' },
      { id: 'e2', source: 'img2', target: 's', label: 'ref-image' },
    ];
    expect(pendingImageUpstreamLabels([still, ready, shot], edges, 's')).toEqual(['分镜静帧 01']);
  });

  it('析出两个 first-frame 来源 ⇒ ref-multi-source 错误', () => {
    const nodes = [assetNode('a'), cropNode('c'), shotNode('s')];
    const refs = deriveShotRefsFromEdges(
      nodes,
      [edge('a', 's', 'first-frame'), edge('c', 's', 'first-frame')],
      's',
    );
    const issues = validateRefsForSubmit('s', 'shot', refs, { mode: 'first-frame' });
    expect(issues.some((i) => i.code === 'ref-multi-source' && i.severity === 'error')).toBe(true);
  });

  it('mode=first-frame 但缺首帧 ⇒ W004 警告(不阻断)', () => {
    const issues = validateRefsForSubmit('s', 'shot', [], { mode: 'first-frame' });
    expect(issues.some((i) => i.code === 'ref-missing' && i.severity === 'warn')).toBe(true);
  });

  it('referenceMediaIssues:first-frame 引用是视频媒体 ⇒ error', () => {
    const issues = referenceMediaIssues([{ role: 'first-frame', kind: 'video', path: '/x.mp4' }]);
    expect(issues.some((i) => i.code === 'media-mismatch')).toBe(true);
    expect(referenceMediaIssues([{ role: 'first-frame', kind: 'image', path: '/x.png' }])).toEqual([]);
  });

  it('allowedPortLabels:image-crop → shot 得 first-frame', () => {
    expect(allowedPortLabels(cropNode('c'), 'shot')).toContain('first-frame');
  });

  it('allowedPortLabels:四类图片产物 → shot 双端口(first-frame + ref-image 图生视频)', () => {
    for (const k of ['image-gen', 'image-edit', 'image-upscale', 'image-crop']) {
      const labels = allowedPortLabels({ id: `n-${k}`, kind: k, data: { resultPath: `/out/${k}.png` } }, 'shot');
      expect(labels, k).toEqual(expect.arrayContaining(['first-frame', 'ref-image']));
    }
  });

  it('validateEdge:image-gen → shot ref-image 合法(参考图端口)', () => {
    const nodes = [imageNode('g'), shotNode('s')];
    expect(validateEdge(nodes, [], edge('g', 's', 'ref-image')).ok).toBe(true);
  });

  it('技能4:已有 first-frame 再连 ref-image ⇒ 拒绝(h3 互斥)', () => {
    const nodes = [imageNode('env'), imageNode('card'), shotNode('s')];
    const existing = [edge('env', 's', 'first-frame')];
    const res = validateEdge(nodes, existing, edge('card', 's', 'ref-image'));
    expect(res.ok).toBe(false);
    expect(res.errors[0]?.code).toBe('anchor-reference-conflict');
    expect(res.errors[0]?.message).toContain('ref-image');
    expect(res.errors[0]?.message).toContain('first-frame');
  });

  it('已有 ref-image 再连 first-frame ⇒ 拒绝', () => {
    const nodes = [imageNode('env'), imageNode('card'), shotNode('s')];
    const res = validateEdge(nodes, [edge('card', 's', 'ref-image')], edge('env', 's', 'first-frame'));
    expect(res.ok).toBe(false);
    expect(res.errors[0]?.code).toBe('anchor-reference-conflict');
  });

  it('first-frame + ref-audio 不互斥', () => {
    const audio = assetNode('a', 'audio');
    const nodes = [imageNode('env'), audio, shotNode('s')];
    expect(validateEdge(nodes, [edge('env', 's', 'first-frame')], edge('a', 's', 'ref-audio')).ok).toBe(true);
  });

  it('referenceAnchorConflictIssues:首帧与参考图同时存在 ⇒ error', () => {
    const issues = referenceAnchorConflictIssues([{ role: 'first-frame' }, { role: 'ref-image' }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('互斥');
    expect(referenceAnchorConflictIssues([{ role: 'ref-image' }, { role: 'ref-image' }])).toEqual([]);
    expect(anchorReferenceConnectIssue([], 's', 'ref-image')).toBeNull();
  });
});

describe('A+ · 图片拼接/拆分(image-stitch / image-split)', () => {
  const stitchNode = (id: string): EdgeNodeMin => ({ id, kind: 'image-stitch', data: {} });
  const splitNode = (id: string): EdgeNodeMin => ({
    id,
    kind: 'image-split',
    data: { resultPath: '/out/sp-p1.png', pieces: ['/out/sp-p1.png', '/out/sp-p2.png', '/out/sp-p3.png'] },
  });

  it('图片产物/asset(图)→ image-stitch piece 合法;piece 是多值端口(多条入边不冲突)', () => {
    const nodes = [imageNode('g'), cropNode('c'), stitchNode('st')];
    expect(validateEdge(nodes, [], edge('g', 'st', 'piece')).ok).toBe(true);
    const res = validateEdge(nodes, [edge('g', 'st', 'piece')], edge('c', 'st', 'piece'));
    expect(res.ok).toBe(true); // 多值端口:第二条 piece 入边不算单值冲突
  });

  it('shot(视频)→ image-stitch piece 被拒(媒体不匹配:piece 要求图片)', () => {
    const nodes = [shotNode('s'), stitchNode('st')];
    expect(validateEdge(nodes, [], edge('s', 'st', 'piece')).ok).toBe(false);
  });

  it('image-split → edit 的 piece-N 合法(piece-2),越界格式(piece-0/piece-x)被拒', () => {
    const nodes = [splitNode('sp'), { id: 'e', kind: 'image-edit', data: {} }];
    expect(validateEdge(nodes, [], edge('sp', 'e', 'piece-2')).ok).toBe(true);
    expect(validateEdge(nodes, [], edge('sp', 'e', 'piece-0')).ok).toBe(false);
    expect(validateEdge(nodes, [], edge('sp', 'e', 'piece-x')).ok).toBe(false);
  });

  it('image-split → image-stitch 可用 piece-N 选片作拼接件', () => {
    const nodes = [splitNode('sp'), stitchNode('st')];
    expect(validateEdge(nodes, [], edge('sp', 'st', 'piece-3')).ok).toBe(true);
    expect(validateEdge(nodes, [], edge('sp', 'st', 'piece')).ok).toBe(true);
  });

  it('image-stitch/image-split → shot first-frame 合法(产物是图片)', () => {
    const nodes = [stitchNode('st'), splitNode('sp'), shotNode('s')];
    expect(validateEdge(nodes, [], edge('st', 's', 'first-frame')).ok).toBe(true);
    expect(validateEdge(nodes, [], edge('sp', 's', 'first-frame')).ok).toBe(true);
  });

  it('长名目标 kind 回退短 id:image-gen → image-edit(input)/ image-stitch(piece) 可校验', () => {
    // CONNECTOR_MAP 目标键是渲染层短 id;画布节点 kind 是长名,TARGET_KIND_ALIAS 兜底
    const nodes = [imageNode('g'), { id: 'e', kind: 'image-edit', data: {} }, stitchNode('st')];
    expect(allowedPortLabels(imageNode('g'), 'image-edit')).toContain('input');
    expect(allowedPortLabels(imageNode('g'), 'image-stitch')).toContain('piece');
    expect(validateEdge(nodes, [], edge('g', 'e', 'input')).ok).toBe(true);
    expect(validateEdge(nodes, [], edge('g', 'st', 'piece')).ok).toBe(true);
  });

  it('image-split 的 allowedPortLabels 追加 piece-N 模板(图片处理目标)', () => {
    expect(allowedPortLabels(splitNode('sp'), 'image-edit')).toContain('piece-N');
    expect(allowedPortLabels(splitNode('sp'), 'shot')).not.toContain('piece-N');
  });
});
/**
 * 2026-09:视频**不得**直连图片编辑,须先经 frame-grab(视频裁切取帧)落成图片。
 * 这一组锁死新端口的媒体类型约束 —— 它是「视频/图片」类型匹配的唯一保障点。
 */
describe('frame-grab · 视频裁切取帧端口与媒体约束', () => {
  const grabNode = (id: string, extra: Record<string, unknown> = {}): EdgeNodeMin => ({
    id,
    kind: 'frame-grab',
    data: { mode: 'first', ...extra },
  });
  const editNode = (id: string): EdgeNodeMin => ({ id, kind: 'image-edit', data: {} });
  const shotVideo = (id: string): EdgeNodeMin => ({
    id,
    kind: 'shot',
    data: { resultPath: `/out/${id}.mp4` },
  });

  it('shot → image-edit 不再被允许(旧直连已取消)', () => {
    const res = validateEdge([shotVideo('s'), editNode('e')], [], edge('s', 'e', 'input'));
    expect(res.ok).toBe(false);
    expect(res.errors[0]!.code).toBe('port-not-allowed');
  });

  it('视频源 → frame-grab 走 input-video 端口,允许', () => {
    const nodes = [shotVideo('s'), grabNode('g')];
    expect(allowedPortLabels(nodes[0]!, 'frame-grab')).toEqual(['input-video']);
    expect(validateEdge(nodes, [], edge('s', 'g', 'input-video')).ok).toBe(true);
  });

  it('视频增强产物 → frame-grab 也允许(增强成片同样可取帧)', () => {
    const nodes: EdgeNodeMin[] = [
      { id: 'u', kind: 'video-upscale', data: { resultPath: '/out/u.mp4' } },
      grabNode('g'),
    ];
    expect(validateEdge(nodes, [], edge('u', 'g', 'input-video')).ok).toBe(true);
  });

  it('图片源 → frame-grab 被拒(input-video 要求 video 媒体)', () => {
    const nodes = [imageNode('i'), grabNode('g')];
    expect(allowedPortLabels(nodes[0]!, 'frame-grab')).toEqual([]);
    const res = validateEdge(nodes, [], edge('i', 'g', 'input-video'));
    expect(res.ok).toBe(false);
  });

  it('frame-grab 产物是图片 → 可接 image-edit 的 input(替代旧 shot→edit 的合法通道)', () => {
    const nodes = [grabNode('g'), editNode('e')];
    expect(validateEdge(nodes, [], edge('g', 'e', 'input')).ok).toBe(true);
  });

  it('input-video 是单值端口:同目标已有入边 ⇒ 冲突但可替换', () => {
    const nodes = [shotVideo('s1'), shotVideo('s2'), grabNode('g')];
    const edges = [edge('s1', 'g', 'input-video')];
    const res = validateEdge(nodes, edges, edge('s2', 'g', 'input-video'));
    expect(res.ok).toBe(false);
    expect(res.errors[0]!.code).toBe('single-port-conflict');
    expect(res.errors[0]!.replaceable).toBe(true);
  });
});

describe('2.1 多参考编辑:→ image-edit ref-image 端口(2026-09-29 接线)', () => {
  const editNode = (id: string): EdgeNodeMin => ({ id, kind: 'image-edit', data: {} });

  it('asset(图片)→ image-edit ref-image 合法(此前端口表没有,会被拒)', () => {
    const nodes = [assetNode('a'), editNode('e')];
    const res = validateEdge(nodes, [], edge('a', 'e', 'ref-image'));
    expect(res.ok).toBe(true);
  });

  it('image-gen 产物 → image-edit ref-image 合法', () => {
    const nodes = [imageNode('g'), editNode('e')];
    const res = validateEdge(nodes, [], edge('g', 'e', 'ref-image'));
    expect(res.ok).toBe(true);
  });

  it('ref-image 是多值端口:image-edit 可收两条不同来源的参考图边', () => {
    const nodes = [assetNode('a'), assetNode('b'), editNode('e')];
    const edges = [edge('a', 'e', 'ref-image')];
    const res = validateEdge(nodes, edges, edge('b', 'e', 'ref-image'));
    expect(res.ok).toBe(true);
  });

  it('asset(视频)→ image-edit ref-image 被拒(媒体不匹配:ref-image 只要图片)', () => {
    const nodes = [assetNode('v', 'video'), editNode('e')];
    const res = validateEdge(nodes, [], edge('v', 'e', 'ref-image'));
    expect(res.ok).toBe(false);
  });

  it('allowedPortLabels:asset(图片)→ image-edit 含 input 与 ref-image', () => {
    const labels = allowedPortLabels(assetNode('a'), 'image-edit');
    expect(labels).toContain('input');
    expect(labels).toContain('ref-image');
  });
});

/**
 * 视频节点 → 音频参考(2026-10-08 新增连接器)
 *
 * 动机:`ref-audio` 端口过去只接受**音频资产**,于是「拿上游镜头的声音当这一段的声音参考」
 * 这条最自然的用法反而走不通 —— 视频节点(shot / video-upscale)产物是 mp4,连不上去。
 * 现在放开直连:提交期由 `extractAudio` 从视频抽出 wav 再走 h3 `--ref-audio`。
 *
 * 本组锁死三件事:
 *  1. 视频产物 → shot 的 ref-audio **合法**(媒体门禁认的是「音轨」而不是「视频本体」);
 *  2. 图片产物**不能**钻这个口子(没有音轨的东西不该被放进来);
 *  3. 派发层登记的是视频路径(抽音轨是提交期的副作用,纯函数不碰 ffmpeg)。
 */
describe('视频节点 → 音频参考(→ shot ref-audio)', () => {
  it('shot → shot ref-audio 合法(上游成片的内嵌音轨作声音参考)', () => {
    const nodes = [shotNode('up', { resultPath: '/out/up.mp4' }), shotNode('down')];
    const res = validateEdge(nodes, [], edge('up', 'down', 'ref-audio'));
    expect(res.ok).toBe(true);
  });

  it('video-upscale → shot ref-audio 合法(增强成片的音轨同样可用)', () => {
    const nodes = [
      { id: 'vu', kind: 'video-upscale', data: { resultPath: '/out/vu.mp4' } },
      shotNode('down'),
    ];
    const res = validateEdge(nodes, [], edge('vu', 'down', 'ref-audio'));
    expect(res.ok).toBe(true);
  });

  it('媒体门禁按「载荷是音轨」判定,不因源节点主输出是 video 而误拒', () => {
    // 这是本次改动的核心:portPayloadMedia 对带音轨的视频产物返回 'audio',
    // 否则 PORT_REQUIRED_MEDIA['ref-audio']='audio' 会把这条合法边挡下
    expect(allowedPortLabels(shotNode('up', { resultPath: '/out/up.mp4' }), 'shot')).toContain('ref-audio');
    expect(allowedPortLabels({ id: 'vu', kind: 'video-upscale', data: {} }, 'shot')).toContain('ref-audio');
  });

  it('图片产物不能连 ref-audio(没有音轨,不该开口子)', () => {
    // image-gen 的 CONNECTOR_MAP 里本来就没有 ref-audio 端口 → 无可用端口
    const nodes = [{ id: 'ig', kind: 'image-gen', data: { resultPath: '/out/ig.png' } }, shotNode('down')];
    const res = validateEdge(nodes, [], edge('ig', 'down', 'ref-audio'));
    expect(res.ok).toBe(false);
    expect(allowedPortLabels({ id: 'ig', kind: 'image-gen', data: {} }, 'shot')).not.toContain('ref-audio');
  });

  it('asset(图片)不能连 shot ref-audio(仍按资产真实媒体判定)', () => {
    const nodes = [assetNode('a'), shotNode('down')];
    const res = validateEdge(nodes, [], edge('a', 'down', 'ref-audio'));
    expect(res.ok).toBe(false);
  });

  it('asset(audio)→ shot ref-audio 仍合法(原有能力没被改动)', () => {
    const nodes = [assetNode('au', 'audio'), shotNode('down')];
    expect(validateEdge(nodes, [], edge('au', 'down', 'ref-audio')).ok).toBe(true);
  });

  it('ref-audio 是单值端口:第二个视频源会被判冲突(可替换)', () => {
    const nodes = [shotNode('up1', { resultPath: '/o/1.mp4' }), shotNode('up2', { resultPath: '/o/2.mp4' }), shotNode('down')];
    const existing = [edge('up1', 'down', 'ref-audio')];
    const res = validateEdge(nodes, existing, edge('up2', 'down', 'ref-audio'));
    expect(res.ok).toBe(false);
    expect(res.errors[0]!.code).toBe('single-port-conflict');
    expect(res.errors[0]!.replaceable).toBe(true);
  });

  it('B · deriveShotRefsFromEdges:视频源登记的是**视频路径**(抽音轨留给提交期)', () => {
    const nodes = [shotNode('up', { resultPath: '/out/up.mp4' }), shotNode('down')];
    const refs = deriveShotRefsFromEdges(nodes, [edge('up', 'down', 'ref-audio')], 'down');
    // 纯函数不产生 ffmpeg 副作用 → 这里必须是原视频路径,不是 .wav
    expect(refs).toEqual([{ path: '/out/up.mp4', role: 'ref-audio', auto: true }]);
  });

  it('B · video-upscale → shot 的 ref-audio 同样被推导出来', () => {
    const nodes = [
      { id: 'vu', kind: 'video-upscale', data: { resultPath: '/out/vu.mp4' } },
      shotNode('down'),
    ];
    const refs = deriveShotRefsFromEdges(nodes, [edge('vu', 'down', 'ref-audio')], 'down');
    expect(refs).toEqual([{ path: '/out/vu.mp4', role: 'ref-audio', auto: true }]);
  });

  it('B · 产物未就绪时不注入(与 ref-video 同口径,提交期兜底)', () => {
    const nodes = [shotNode('up', {}), shotNode('down')];
    expect(deriveShotRefsFromEdges(nodes, [edge('up', 'down', 'ref-audio')], 'down')).toEqual([]);
  });
});

/**
 * 视频 → 音频参考节点(2026-10-08)
 *
 * 需求原话:「视频节点加一个连接音频参考的连接器。通过 ffmpeg 把视频的声音抽出来
 * 给音频参考节点」。即 `audio-ref` 要能作为**下游**接住视频源 ——
 * 此前它只能手填 `data.assetId`,**没有任何来源可以连进来**(这是关键缺口)。
 *
 * 链路:视频连上 → 渲染层 ffmpeg 抽音轨 → 导入资产库 → 绑定 audio-ref.assetId。
 * 本组锁死端口合法性与来源推导(抽取本身由 main/__tests__/extract-audio.test.ts 覆盖)。
 */
describe('视频 → 音频参考节点(audio-ref 作为下游)', () => {
  const arNode = (id: string, data: Record<string, unknown> = {}) => ({ id, kind: 'audio-ref', data });

  it('shot → audio-ref 的 input-audio 端口合法', () => {
    const nodes = [shotNode('s', { resultPath: '/out/s.mp4' }), arNode('ar')];
    expect(validateEdge(nodes, [], edge('s', 'ar', 'input-audio')).ok).toBe(true);
    expect(allowedPortLabels(shotNode('s', { resultPath: '/out/s.mp4' }), 'audio-ref')).toEqual(['input-audio']);
  });

  it('video-upscale → audio-ref 同样合法(两个带音轨的视频源都能接)', () => {
    const nodes = [{ id: 'vu', kind: 'video-upscale', data: { resultPath: '/out/vu.mp4' } }, arNode('ar')];
    expect(validateEdge(nodes, [], edge('vu', 'ar', 'input-audio')).ok).toBe(true);
    expect(allowedPortLabels({ id: 'vu', kind: 'video-upscale', data: {} }, 'audio-ref')).toEqual(['input-audio']);
  });

  it('媒体门禁按「载荷是音轨」判定,不因源主输出是 video 而误拒', () => {
    // 与 ref-audio 同一手法:PORT_REQUIRED_MEDIA['input-audio']='audio',
    // 若 portPayloadMedia 不把带音轨的视频产物判成 audio,这条合法边会被自己挡下
    expect(allowedPortLabels(shotNode('s', { resultPath: '/o/s.mp4' }), 'audio-ref')).toContain('input-audio');
  });

  it('图片产物不能连 audio-ref(没有音轨,端口表里就没有)', () => {
    const ig = { id: 'ig', kind: 'image-gen', data: { resultPath: '/o/ig.png' } };
    expect(allowedPortLabels(ig, 'audio-ref')).toEqual([]);
    expect(validateEdge([ig, arNode('ar')], [], edge('ig', 'ar', 'input-audio')).ok).toBe(false);
  });

  it('audio-ref 自身不能再连 audio-ref(没有这个端口)', () => {
    expect(allowedPortLabels(arNode('ar1'), 'audio-ref')).toEqual([]);
  });

  it('input-audio 不是单值端口:可接多条(多来源由用户自行取舍)', () => {
    // 与 first-frame 等单值端口不同,这里不做基数限制 —— 抽取是幂等的「最后写入生效」,
    // 若做成单值会与「一个视频源一条边」的正常交互冲突(替换语义反而更困惑)
    expect(SINGLE_VALUE_PORTS.has('input-audio')).toBe(false);
  });

  it('deriveAudioRefSource:从 input-audio 边取出源视频路径', () => {
    const nodes = [shotNode('s', { resultPath: '/out/s.mp4' }), arNode('ar')];
    expect(deriveAudioRefSource(nodes, [edge('s', 'ar', 'input-audio')], 'ar')).toBe('/out/s.mp4');
  });

  it('deriveAudioRefSource:上游未产出 → undefined(等它跑完再抽,不误报)', () => {
    const nodes = [shotNode('s', {}), arNode('ar')];
    expect(deriveAudioRefSource(nodes, [edge('s', 'ar', 'input-audio')], 'ar')).toBeUndefined();
  });

  it('deriveAudioRefSource:其它 label 的入边不算音源', () => {
    const nodes = [shotNode('s', { resultPath: '/out/s.mp4' }), arNode('ar')];
    expect(deriveAudioRefSource(nodes, [edge('s', 'ar', 'first-frame')], 'ar')).toBeUndefined();
  });

  it('deriveAudioRefSource:只有带音轨的视频产物才算(图片源被忽略)', () => {
    const nodes = [
      { id: 'ig', kind: 'image-gen', data: { resultPath: '/o/ig.png' } },
      arNode('ar'),
    ];
    expect(deriveAudioRefSource(nodes, [edge('ig', 'ar', 'input-audio')], 'ar')).toBeUndefined();
  });
});

/**
 * timeline 作为**视频产物源**(2026-10 接线,用户反馈:「+」弹层只给 document,
 * 而时间线的导出成片本质是视频,应与 shot / video-upscale 同类)。
 *
 * 前置:data.resultPath 由导出完成时回写(TimelinePage / 检查器轮询两处同写)。
 * 本组锁死:端口合法性(媒体门禁)、first-frame 仍不开(载荷是静帧)、
 * refs 推导走 VIDEO_KINDS 分支读 resultPath、成片音轨可作 ref-audio / input-audio。
 */
describe('timeline 作为视频产物源(成片 → 下游)', () => {
  const tlNode = (id: string, data: Record<string, unknown> = { resultPath: `/out/${id}.mp4` }): EdgeNodeMin => ({
    id,
    kind: 'timeline',
    data,
  });

  it('timeline → shot ref-video / ref-audio 合法', () => {
    expect(validateEdge([tlNode('t'), shotNode('s')], [], edge('t', 's', 'ref-video')).ok).toBe(true);
    expect(validateEdge([tlNode('t'), shotNode('s')], [], edge('t', 's', 'ref-audio')).ok).toBe(true);
  });

  it('timeline → frame-grab input-video 合法;timeline → video-upscale input 合法', () => {
    const grab = { id: 'g', kind: 'frame-grab', data: {} };
    const vup = { id: 'u', kind: 'video-upscale', data: {} };
    expect(validateEdge([tlNode('t'), grab], [], edge('t', 'g', 'input-video')).ok).toBe(true);
    expect(validateEdge([tlNode('t'), vup], [], edge('t', 'u', 'input')).ok).toBe(true);
  });

  it('timeline → audio-ref input-audio 合法(成片带内嵌音轨;媒体门禁按载荷=音轨判定)', () => {
    const ar = { id: 'ar', kind: 'audio-ref', data: {} };
    expect(validateEdge([tlNode('t'), ar], [], edge('t', 'ar', 'input-audio')).ok).toBe(true);
    expect(allowedPortLabels(tlNode('t'), 'audio-ref')).toEqual(['input-audio']);
  });

  it('timeline → timeline clip 合法(成片入另一条时间线)', () => {
    expect(validateEdge([tlNode('a'), tlNode('b', {})], [], edge('a', 'b', 'clip')).ok).toBe(true);
  });

  it('timeline → shot first-frame 仍被拒(端口载荷是静帧,成片取帧须先经 frame-grab)', () => {
    const res = validateEdge([tlNode('t'), shotNode('s')], [], edge('t', 's', 'first-frame'));
    expect(res.ok).toBe(false);
    expect(res.errors[0]!.code).toBe('port-not-allowed');
  });

  it('timeline → image-edit 仍被拒(视频不直连图片编辑,与 shot 同纪律)', () => {
    const edit = { id: 'e', kind: 'image-edit', data: {} };
    expect(validateEdge([tlNode('t'), edit], [], edge('t', 'e', 'input')).ok).toBe(false);
  });

  it('B · deriveShotRefsFromEdges:timeline → shot ref-video 读 data.resultPath(与 video-upscale 同分支)', () => {
    const refs = deriveShotRefsFromEdges([tlNode('t'), shotNode('s')], [edge('t', 's', 'ref-video')], 's');
    expect(refs).toEqual([{ path: '/out/t.mp4', role: 'ref-video', auto: true }]);
  });

  it('B · deriveShotRefsFromEdges:成片未导出(resultPath 缺失)时不注入', () => {
    const refs = deriveShotRefsFromEdges([tlNode('t', {}), shotNode('s')], [edge('t', 's', 'ref-video')], 's');
    expect(refs).toEqual([]);
  });

  it('B · deriveAudioRefSource:timeline 成片的音轨可作 audio-ref 来源', () => {
    const ar = { id: 'ar', kind: 'audio-ref', data: {} };
    expect(deriveAudioRefSource([tlNode('t'), ar], [edge('t', 'ar', 'input-audio')], 'ar')).toBe('/out/t.mp4');
  });
});
