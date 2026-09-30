/**
 * 2.1 多参考编辑接线测试(2026-09-29,docs/工具模型选择-产品设计与技术方案.md §2.1.0b)
 *
 * 背景:Qwen-Image-2.1 的 `qwen21.edit` 支持 1-10 张参考图,但此前 UI 链路有 4 处断点:
 * ① 端口表(asset/图片产物 → image-edit 只有 input)② 派生态(image-edit 只记单值 inputImageFrom)
 * ③ 提交层(ref-image 收集被 `kind === 'image-gen'` 包住)④ 类型(无多图字段)。
 * 本文件锁 ①②;③④ 由 tool-handlers 侧测试锁(resolveRefImagePaths 已对 image-edit 生效)。
 */
import { describe, it, expect } from 'vitest';
import { computeEdgeDerivations } from '../edge-dispatch.js';
import { resolvePortOptions, hasConnector } from '../connectors.js';
import type { CanvasNode, Edge } from '../types.js';

const node = (id: string, kind: string, data: Record<string, unknown> = {}): CanvasNode =>
  ({ id, title: id, w: 200, x: 0, y: 0, kind: kind as CanvasNode['kind'], data }) as CanvasNode;

const assetNode = (id: string) => node(id, 'asset', { mediaType: 'image', assetId: id });

describe('断点①:端口表 — 图片源 → image-edit 可选 ref-image', () => {
  it('asset(图片)→ image-edit:提供 input + ref-image 两个端口', () => {
    const opts = resolvePortOptions(assetNode('a1'), 'image-edit');
    expect(opts.map((o) => o.port)).toEqual(['input', 'ref-image']);
  });

  it('image-gen 产物 → image-edit:提供 input + ref-image 两个端口', () => {
    const opts = resolvePortOptions(node('g1', 'image-gen'), 'image-edit');
    expect(opts.map((o) => o.port)).toEqual(['input', 'ref-image']);
  });

  it('image-crop / frame-grab 产物 → image-edit:同样有 ref-image', () => {
    for (const kind of ['image-crop', 'frame-grab', 'image-stitch', 'image-upscale']) {
      const opts = resolvePortOptions(node('x1', kind), 'image-edit');
      expect(opts.map((o) => o.port), kind).toContain('ref-image');
    }
  });
});

describe('断点②:派生态 — image-edit 的 ref-image 累积为多值 refImageFrom', () => {
  it('两条 ref-image 入边 → refImageFrom 累积 2 项(不再只留最后一张)', () => {
    const nodes = [assetNode('a1'), assetNode('a2'), node('e1', 'image-edit')];
    const edges: Edge[] = [
      { from: 'a1', to: 'e1', cls: '', label: 'ref-image' },
      { from: 'a2', to: 'e1', cls: '', label: 'ref-image' },
    ];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    const d = nextNodes.find((n) => n.id === 'e1')!.data as { refImageFrom?: Array<{ nodeId: string }> };
    expect(d.refImageFrom?.map((r) => r.nodeId)).toEqual(['a1', 'a2']);
  });

  it('input 边仍写单值 inputImageFrom,与 refImageFrom 互不干扰', () => {
    const nodes = [assetNode('a0'), assetNode('a1'), node('e1', 'image-edit')];
    const edges: Edge[] = [
      { from: 'a0', to: 'e1', cls: '', label: 'input' },
      { from: 'a1', to: 'e1', cls: '', label: 'ref-image' },
    ];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    const d = nextNodes.find((n) => n.id === 'e1')!.data as {
      inputImageFrom?: { nodeId: string };
      refImageFrom?: Array<{ nodeId: string }>;
    };
    expect(d.inputImageFrom?.nodeId).toBe('a0');
    expect(d.refImageFrom?.map((r) => r.nodeId)).toEqual(['a1']);
  });

  it('删除 ref-image 边 → refImageFrom 清理(边是唯一事实源)', () => {
    const nodes = [
      assetNode('a1'),
      node('e1', 'image-edit', { refImageFrom: [{ nodeId: 'a1' }] }),
    ];
    const { nextNodes } = computeEdgeDerivations(nodes, []);
    const d = nextNodes.find((n) => n.id === 'e1')!.data as { refImageFrom?: unknown };
    expect(d.refImageFrom).toBeUndefined();
  });

  it('重复派生幂等(内容不变 → changed=false)', () => {
    const nodes = [assetNode('a1'), node('e1', 'image-edit')];
    const edges: Edge[] = [{ from: 'a1', to: 'e1', cls: '', label: 'ref-image' }];
    const once = computeEdgeDerivations(nodes, edges);
    expect(once.changed).toBe(true);
    const twice = computeEdgeDerivations(once.nextNodes, edges);
    expect(twice.changed).toBe(false);
  });

  it('image-upscale 不受影响:ref-image 入边不写入 refImageFrom(只 image-edit 有)', () => {
    const nodes = [assetNode('a1'), node('u1', 'image-upscale')];
    const edges: Edge[] = [{ from: 'a1', to: 'u1', cls: '', label: 'ref-image' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    const d = nextNodes.find((n) => n.id === 'u1')!.data as { refImageFrom?: unknown };
    expect(d.refImageFrom).toBeUndefined();
  });
});
