/**
 * 边派发测试 — image-crop 节点的输入图派发 / 产物连通(computeEdgeDerivations)
 * 用例:图片产物/素材 → crop 写入 inputImageFrom;删边清理;crop → 下游(edit/upcale/shot/timeline/wf-output)
 */
import { describe, it, expect } from 'vitest';
import { computeEdgeDerivations } from '../edge-dispatch.js';
import type { CanvasNode, Edge } from '../types.js';

const node = (id: string, kind: string, data: Record<string, unknown> = {}): CanvasNode =>
  ({ id, title: id, w: 200, x: 0, y: 0, kind: kind as CanvasNode['kind'], data }) as CanvasNode;

describe('入边派发 → image-crop 的 inputImageFrom', () => {
  it('image-gen 产物连到 crop:写入 inputImageFrom = 源节点 id', () => {
    const nodes = [node('g1', 'image-gen', { resultPath: '/tmp/out/g1.png' }), node('c1', 'image-crop')];
    const edges: Edge[] = [{ from: 'g1', to: 'c1', cls: '', label: 'input' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    const crop = nextNodes.find((n) => n.id === 'c1')!;
    expect((crop.data as { inputImageFrom?: { nodeId: string } }).inputImageFrom?.nodeId).toBe('g1');
  });

  it('asset(图片素材)连到 crop:同样写入 inputImageFrom', () => {
    const nodes = [node('a1', 'asset', { mediaType: 'image', assetId: 'a1' }), node('c1', 'image-crop')];
    const edges: Edge[] = [{ from: 'a1', to: 'c1', cls: '', label: 'input' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    expect((nextNodes.find((n) => n.id === 'c1')!.data as { inputImageFrom?: { nodeId: string } }).inputImageFrom?.nodeId).toBe('a1');
  });

  it('删除 input 边 → inputImageFrom 被清理(撤销直通)', () => {
    const nodes = [node('g1', 'image-gen', { resultPath: '/tmp/out/g1.png' }), node('c1', 'image-crop', { inputImageFrom: { nodeId: 'g1' } })];
    const { nextNodes } = computeEdgeDerivations(nodes, []);
    const crop = nextNodes.find((n) => n.id === 'c1')!;
    expect((crop.data as { inputImageFrom?: unknown }).inputImageFrom).toBeUndefined();
  });

  it('内容未变化时不触发 setState(changed=false)——image-crop 幂等', () => {
    const nodes = [node('g1', 'image-gen', { resultPath: '/tmp/out/g1.png' }), node('c1', 'image-crop')];
    const edges: Edge[] = [{ from: 'g1', to: 'c1', cls: '', label: 'input' }];
    const once = computeEdgeDerivations(nodes, edges);
    expect(once.changed).toBe(true);
    const twice = computeEdgeDerivations(once.nextNodes, edges);
    expect(twice.changed).toBe(false);
  });

  it('image-edit / image-upscale 的 input 派发同样幂等(回归原有潜在 bug)', () => {
    for (const kind of ['image-edit', 'image-upscale']) {
      const nodes = [node('g1', 'image-gen', { resultPath: '/tmp/out/g1.png' }), node('d1', kind)];
      const edges: Edge[] = [{ from: 'g1', to: 'd1', cls: '', label: 'input' }];
      const once = computeEdgeDerivations(nodes, edges);
      expect(once.changed, `first pass ${kind}`).toBe(true);
      const twice = computeEdgeDerivations(once.nextNodes, edges);
      expect(twice.changed, `second pass ${kind}`).toBe(false);
      const d = twice.nextNodes.find((n) => n.id === 'd1')!;
      expect((d.data as { inputImageFrom?: { nodeId: string } }).inputImageFrom?.nodeId, kind).toBe('g1');
    }
  });
});

describe('出边派发 · crop 产物 → 下游', () => {
  it('crop → image-edit:edit 节点拿到 inputImageFrom(裁切结果直通)', () => {
    const nodes = [node('c1', 'image-crop', { resultPath: '/tmp/out/crop.png' }), node('e1', 'image-edit')];
    const edges: Edge[] = [{ from: 'c1', to: 'e1', cls: '', label: 'input' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    const edit = nextNodes.find((n) => n.id === 'e1')!;
    expect((edit.data as { inputImageFrom?: { nodeId: string } }).inputImageFrom?.nodeId).toBe('c1');
  });

  it('crop → shot(first-frame 端口):shot.refs 注入 { path, role:first-frame, auto }', () => {
    const nodes = [
      node('c1', 'image-crop', { resultPath: '/tmp/out/crop.png' }),
      node('s1', 'shot', { mode: 'first-frame', refs: [] }),
    ];
    const edges: Edge[] = [{ from: 'c1', to: 's1', cls: '', label: 'first-frame' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    const shot = nextNodes.find((n) => n.id === 's1')!;
    const refs = (shot.data as { refs: Array<{ path?: string; role: string }> }).refs;
    expect(refs).toContainEqual({ path: '/tmp/out/crop.png', role: 'first-frame', auto: true });
  });

  it('crop → timeline:入线(clip)', () => {
    const nodes = [node('c1', 'image-crop', { resultPath: '/tmp/out/crop.png' }), node('t1', 'timeline', { shotNodeIds: [] })];
    const edges: Edge[] = [{ from: 'c1', to: 't1', cls: '', label: 'clip' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    const tl = nextNodes.find((n) => n.id === 't1')!;
    expect((tl.data as { shotNodeIds: string[] }).shotNodeIds).toContain('c1');
  });

  it('crop → workflow-output:image 输出槽收集源节点', () => {
    const nodes = [
      node('c1', 'image-crop', { resultPath: '/tmp/out/crop.png' }),
      node('w1', 'workflow-output', { outputs: [{ name: '产物', kind: 'image', sourceNodeIds: [] }] }),
    ];
    const edges: Edge[] = [{ from: 'c1', to: 'w1', cls: '' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    const wf = nextNodes.find((n) => n.id === 'w1')!;
    const outputs = (wf.data as { outputs: Array<{ kind: string; sourceNodeIds: string[] }> }).outputs;
    expect(outputs[0]!.sourceNodeIds).toContain('c1');
  });
});