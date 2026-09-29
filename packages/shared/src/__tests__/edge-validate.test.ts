/**
 * 边校验单测 — 方案 A(写入点强制校验)/ B(refs 单一事实源)/ D(提交前防呆)
 * 还原 n f s w 事故场景:image-crop → shot 首帧被连成双入边必须被拦下。
 */
import { describe, it, expect } from 'vitest';
import {
  validateEdge,
  allowedPortLabels,
  deriveShotRefsFromEdges,
  validateRefsForSubmit,
  referenceMediaIssues,
  type EdgeNodeMin,
  type EdgeMin,
} from '../edge-validate.js';

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
    expect(allowedPortLabels(shotNode('up'), 'shot')).toEqual(['first-frame', 'ref-video']);
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
