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

  it('图片产物 → shot(ref-image 端口):shot.refs 注入 { path, role:ref-image, auto } 参考图', () => {
    const nodes = [
      node('g1', 'image-gen', { resultPath: '/tmp/out/g1.png' }),
      node('s1', 'shot', { mode: 'ref-image', refs: [] }),
    ];
    const edges: Edge[] = [{ from: 'g1', to: 's1', cls: '', label: 'ref-image' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    const shot = nextNodes.find((n) => n.id === 's1')!;
    const refs = (shot.data as { refs: Array<{ path?: string; role: string }> }).refs;
    expect(refs).toContainEqual({ path: '/tmp/out/g1.png', role: 'ref-image', auto: true });
  });

  it('ref-image 边不触发 mode 自动切换(保持 text2video;h3 --ref-image 与 --first-frame 互斥)', () => {
    const nodes = [
      node('g1', 'image-gen', { resultPath: '/tmp/out/g1.png' }),
      node('s1', 'shot', { mode: 'text2video', refs: [] }),
    ];
    const edges: Edge[] = [{ from: 'g1', to: 's1', cls: '', label: 'ref-image' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    const shot = nextNodes.find((n) => n.id === 's1')!;
    expect((shot.data as { mode: string }).mode).toBe('text2video');
  });

  /* ── 参考视频(h3 --ref-video):三类视频源之前全被静默丢弃,连线可见但不进生成命令 ── */

  it('上游镜头 → shot(ref-video 端口):用整段成片注入 { path, role:ref-video, auto }', () => {
    const nodes = [
      node('up', 'shot', { resultPath: '/tmp/out/up.mp4', tailFramePath: '/tmp/out/up-last.png' }),
      node('s1', 'shot', { mode: 'ref-video', refs: [] }),
    ];
    const edges: Edge[] = [{ from: 'up', to: 's1', cls: '', label: 'ref-video' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    const refs = (nextNodes.find((n) => n.id === 's1')!.data as { refs: Array<{ path?: string; role: string }> }).refs;
    expect(refs).toContainEqual({ path: '/tmp/out/up.mp4', role: 'ref-video', auto: true });
    // 参考视频取的是成片,不是尾帧 PNG
    expect(refs.some((r) => r.path === '/tmp/out/up-last.png')).toBe(false);
  });

  it('视频增强产物 → shot(ref-video 端口):增强成片注入 ref-video', () => {
    const nodes = [
      node('u1', 'video-upscale', { resultPath: '/tmp/out/enhanced.mp4' }),
      node('s1', 'shot', { mode: 'ref-video', refs: [] }),
    ];
    const edges: Edge[] = [{ from: 'u1', to: 's1', cls: '', label: 'ref-video' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    const refs = (nextNodes.find((n) => n.id === 's1')!.data as { refs: Array<{ path?: string; role: string }> }).refs;
    expect(refs).toContainEqual({ path: '/tmp/out/enhanced.mp4', role: 'ref-video', auto: true });
  });

  it('视频 asset → shot(ref-video 端口):注入 assetId 引用', () => {
    const nodes = [
      node('a1', 'asset', { assetId: 'asset-vid', mediaType: 'video' }),
      node('s1', 'shot', { mode: 'ref-video', refs: [] }),
    ];
    const edges: Edge[] = [{ from: 'a1', to: 's1', cls: '', label: 'ref-video' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    const refs = (nextNodes.find((n) => n.id === 's1')!.data as { refs: Array<{ assetId?: string; role: string }> }).refs;
    expect(refs).toContainEqual({ assetId: 'asset-vid', role: 'ref-video', auto: true });
  });

  it('ref-video 边不触发 mode 自动切换(参考视频是独立语义,不当作首帧接续)', () => {
    const nodes = [
      node('up', 'shot', { resultPath: '/tmp/out/up.mp4' }),
      node('s1', 'shot', { mode: 'text2video', refs: [] }),
    ];
    const edges: Edge[] = [{ from: 'up', to: 's1', cls: '', label: 'ref-video' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    expect((nextNodes.find((n) => n.id === 's1')!.data as { mode: string }).mode).toBe('text2video');
  });

  it('上游成片未就绪时 ref-video 不注入空路径(不写 path:undefined)', () => {
    const nodes = [node('up', 'shot', { tailFramePath: '/tmp/out/up-last.png' }), node('s1', 'shot', { mode: 'ref-video', refs: [] })];
    const edges: Edge[] = [{ from: 'up', to: 's1', cls: '', label: 'ref-video' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    const refs = (nextNodes.find((n) => n.id === 's1')!.data as { refs: Array<{ role: string }> }).refs;
    expect(refs.some((r) => r.role === 'ref-video')).toBe(false);
  });

  it('删掉 ref-video 入边 ⇒ 自动注入的参考视频被撤销(手动绑定保留)', () => {
    const nodes = [
      node('up', 'shot', { resultPath: '/tmp/out/up.mp4' }),
      node('s1', 'shot', { mode: 'ref-video', refs: [] }),
    ];
    const edges: Edge[] = [{ from: 'up', to: 's1', cls: '', label: 'ref-video' }];
    const once = computeEdgeDerivations(nodes, edges);
    expect((once.nextNodes.find((n) => n.id === 's1')!.data as { refs: unknown[] }).refs).toHaveLength(1);
    const twice = computeEdgeDerivations(once.nextNodes, []);
    expect((twice.nextNodes.find((n) => n.id === 's1')!.data as { refs: unknown[] }).refs).toHaveLength(0);
  });

  it('first-frame 边仍自动切 mode=first-frame(回归);删掉后收回 text2video', () => {
    const nodes = [
      node('g1', 'image-gen', { resultPath: '/tmp/out/g1.png' }),
      node('s1', 'shot', { mode: 'text2video', refs: [] }),
    ];
    const edges: Edge[] = [{ from: 'g1', to: 's1', cls: '', label: 'first-frame' }];
    const once = computeEdgeDerivations(nodes, edges);
    expect((once.nextNodes.find((n) => n.id === 's1')!.data as { mode: string }).mode).toBe('first-frame');
    const twice = computeEdgeDerivations(once.nextNodes, []);
    expect((twice.nextNodes.find((n) => n.id === 's1')!.data as { mode: string }).mode).toBe('text2video');
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
/**
 * 视频节点 → 音频参考(2026-10-08 新增连接器,渲染层派发)
 *
 * 派发层只**登记视频路径**,不抽音轨 —— 派发是纯函数,不能有 ffmpeg 副作用;
 * 真正的抽取发生在提交期(runNode / 主进程 engine.submit 调 extractAudio)。
 * 这里锁死「登记的是视频路径」这条契约,防止有人图省事在派发里抽音轨。
 */
describe('视频节点 → shot 的 ref-audio 派发', () => {
  const refsOf = (ns: CanvasNode[], id: string) =>
    ((ns.find((n) => n.id === id)!.data as { refs?: Array<{ path?: string; role: string; auto?: boolean }> }).refs ?? []);

  it('shot → shot:ref-audio 写入 refs,路径是上游成片 mp4(不是 wav)', () => {
    const nodes = [node('up', 'shot', { resultPath: '/out/up.mp4' }), node('down', 'shot')];
    const edges: Edge[] = [{ from: 'up', to: 'down', cls: '', label: 'ref-audio' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    expect(refsOf(nextNodes, 'down')).toEqual([{ path: '/out/up.mp4', role: 'ref-audio', auto: true }]);
  });

  it('video-upscale → shot:同样派发', () => {
    const nodes = [node('vu', 'video-upscale', { resultPath: '/out/vu.mp4' }), node('down', 'shot')];
    const edges: Edge[] = [{ from: 'vu', to: 'down', cls: '', label: 'ref-audio' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    expect(refsOf(nextNodes, 'down')).toEqual([{ path: '/out/vu.mp4', role: 'ref-audio', auto: true }]);
  });

  it('上游产物未就绪 → 不派发(提交期 W004 兜底)', () => {
    const nodes = [node('up', 'shot', {}), node('down', 'shot')];
    const edges: Edge[] = [{ from: 'up', to: 'down', cls: '', label: 'ref-audio' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    expect(refsOf(nextNodes, 'down')).toEqual([]);
  });

  it('删除 ref-audio 边 → refs 被清理(撤销直通)', () => {
    const nodes = [
      node('up', 'shot', { resultPath: '/out/up.mp4' }),
      node('down', 'shot', { refs: [{ path: '/out/up.mp4', role: 'ref-audio', auto: true }] }),
    ];
    const { nextNodes } = computeEdgeDerivations(nodes, []);
    expect(refsOf(nextNodes, 'down')).toEqual([]);
  });

  it('用户手动绑定过 ref-audio(非 auto)→ 自动项让位,不覆盖用户意图', () => {
    const nodes = [
      node('up', 'shot', { resultPath: '/out/up.mp4' }),
      node('down', 'shot', { refs: [{ path: '/my/manual.wav', role: 'ref-audio' }] }),
    ];
    const edges: Edge[] = [{ from: 'up', to: 'down', cls: '', label: 'ref-audio' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    const refs = refsOf(nextNodes, 'down');
    expect(refs.some((r) => r.path === '/my/manual.wav')).toBe(true);
    expect(refs.some((r) => r.path === '/out/up.mp4')).toBe(false);
  });
});

/**
 * 视频 → 音频参考节点(2026-10-08 新增连接器,渲染层派发)
 *
 * 派发只**登记来源节点**(`inputAudioFrom`),不抽音轨 —— 抽取是 ffmpeg 副作用,
 * 由 CanvasPage 的专用 effect 完成(见「连上即抽音轨」)。这里锁死登记与撤销语义。
 */
describe('视频 → audio-ref 的派发', () => {
  const d = (ns: CanvasNode[], id: string) => ns.find((n) => n.id === id)!.data as Record<string, unknown>;

  it('shot → audio-ref:登记 inputAudioFrom = 源节点 id', () => {
    const nodes = [node('s1', 'shot', { resultPath: '/o/s1.mp4' }), node('ar', 'audio-ref', {})];
    const edges: Edge[] = [{ from: 's1', to: 'ar', cls: '', label: 'input-audio' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    expect(d(nextNodes, 'ar').inputAudioFrom).toEqual({ nodeId: 's1' });
  });

  it('video-upscale → audio-ref:同样登记', () => {
    const nodes = [node('vu', 'video-upscale', { resultPath: '/o/vu.mp4' }), node('ar', 'audio-ref', {})];
    const edges: Edge[] = [{ from: 'vu', to: 'ar', cls: '', label: 'input-audio' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    expect(d(nextNodes, 'ar').inputAudioFrom).toEqual({ nodeId: 'vu' });
  });

  it('删边 → inputAudioFrom 与抽取记录一并清掉(不留无主的 assetId)', () => {
    // 抽出来的产物绑定(sourceVideoPath)必须跟着边一起清:
    // 否则会留下一个与任何连线都无关的 assetId,用户看不出它从哪来
    const nodes = [
      node('s1', 'shot', { resultPath: '/o/s1.mp4' }),
      node('ar', 'audio-ref', { inputAudioFrom: { nodeId: 's1' }, sourceVideoPath: '/o/s1.mp4', assetId: 'asset-x' }),
    ];
    const { nextNodes } = computeEdgeDerivations(nodes, []);
    expect(d(nextNodes, 'ar').inputAudioFrom).toBeUndefined();
    expect(d(nextNodes, 'ar').sourceVideoPath).toBeUndefined();
  });

  it('图片源连 audio-ref 不登记(端口表本就没这条路,派发也不该写)', () => {
    const nodes = [node('ig', 'image-gen', { resultPath: '/o/ig.png' }), node('ar', 'audio-ref', {})];
    const edges: Edge[] = [{ from: 'ig', to: 'ar', cls: '', label: 'input-audio' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    expect(d(nextNodes, 'ar').inputAudioFrom).toBeUndefined();
  });

  it('audio-ref 原有的 assetId 绑定不被派发抹掉(它是那条链之外的独立能力)', () => {
    const nodes = [node('s1', 'shot', { resultPath: '/o/s1.mp4' }), node('ar', 'audio-ref', { assetId: 'manual-audio' })];
    const edges: Edge[] = [{ from: 's1', to: 'ar', cls: '', label: 'input-audio' }];
    const { nextNodes } = computeEdgeDerivations(nodes, edges);
    expect(d(nextNodes, 'ar').assetId).toBe('manual-audio');
  });
});
