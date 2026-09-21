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
});