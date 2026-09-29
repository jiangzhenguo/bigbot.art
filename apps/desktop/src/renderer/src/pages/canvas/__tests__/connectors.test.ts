/**
 * 连接器测试 — 图片裁切节点(image-crop)端口解析(渲染层权威表 connectors.ts)
 * 覆盖:「+」弹窗可见性与端口锚定;源/目标类型矩阵;图片产物集合
 */
import { describe, it, expect } from 'vitest';
import { resolvePortOptions, resolvePort, hasConnector, guardEdge, IMAGE_KINDS } from '../connectors.js';
import { NODE_TYPES } from '../constants.js';
import type { CanvasNode } from '../types.js';

const node = (kind: string, id = `n-${kind}`): CanvasNode =>
  ({ id, title: kind, w: 200, x: 0, y: 0, kind: kind as CanvasNode['kind'] }) as CanvasNode;
const imageNode = (kind: string, withResult = false) => ({
  ...node(kind),
  data: withResult ? { resultPath: `/tmp/out/${kind}.png` } : {},
});
const assetImage = () => ({ ...node('asset'), data: { mediaType: 'image', assetId: 'a1' } });

describe('resolvePortOptions · 图片产物 → image-crop', () => {
  it('image-gen 产物可连裁切节点,端口 input', () => {
    const opts = resolvePortOptions({ ...imageNode('image-gen', true), id: 'g1' }, 'crop');
    expect(opts.length).toBe(1);
    expect(opts[0]!.port).toBe('input');
  });

  it('image-edit / image-upscale 产物同样可连裁切节点', () => {
    for (const k of ['image-edit', 'image-upscale']) {
      expect(resolvePort({ ...imageNode(k, true), id: `x-${k}` }, 'crop')?.port).toBe('input');
    }
  });

  it('asset(图片素材)可连裁切节点,端口 input', () => {
    expect(resolvePort(assetImage(), 'crop')?.port).toBe('input');
  });

  it('audio-ref / document / shot 不能连裁切节点(无连接器)', () => {
    expect(hasConnector(node('audio-ref'), 'crop')).toBe(false);
    expect(hasConnector(node('document'), 'crop')).toBe(false);
    expect(hasConnector(node('shot'), 'crop')).toBe(false);
  });
});

describe('resolvePortOptions · image-crop 作为源', () => {
  const crop = () => ({ ...node('image-crop'), data: { aspect: '9:16', resultPath: '/tmp/out/crop.png' } });

  it('裁切结果 → image-edit:端口 input(输入图)', () => {
    expect(resolvePort(crop(), 'edit')?.port).toBe('input');
  });

  it('裁切结果 → image-upscale:端口 input;→ shot:端口 first-frame;→ timeline:端口 clip', () => {
    expect(resolvePort(crop(), 'upscale')?.port).toBe('input');
    expect(resolvePort(crop(), 'shot')?.port).toBe('first-frame');
    expect(resolvePort(crop(), 'timeline')?.port).toBe('clip');
  });

  it('裁切结果可作参考图(image-gen 的 ref-image)', () => {
    expect(resolvePort(crop(), 'image')?.port).toBe('ref-image');
  });

  it('裁切结果可收口到 workflow-output(output)', () => {
    expect(resolvePort(crop(), 'wf-output')?.port).toBe('output');
  });
});

describe('resolvePortOptions · 图片产物 → shot(图生视频双端口)', () => {
  it('image-gen / image-edit / image-upscale / image-crop → shot 均提供 first-frame + ref-image 双端口', () => {
    for (const k of ['image-gen', 'image-edit', 'image-upscale', 'image-crop']) {
      const opts = resolvePortOptions(imageNode(k, true), 'shot');
      expect(opts.map((o) => o.port), k).toEqual(['first-frame', 'ref-image']);
    }
  });

  it('双端口默认锚定为首端口 first-frame,ref-image 可选(deriveEdgeLabel portOverride 场景)', () => {
    expect(resolvePort(imageNode('image-gen', true), 'shot')?.port).toBe('first-frame');
    const opts = resolvePortOptions(imageNode('image-gen', true), 'shot');
    expect(opts.some((o) => o.port === 'ref-image')).toBe(true);
  });

  it('asset(图片素材) → shot 双端口保持不变(回归)', () => {
    const opts = resolvePortOptions(assetImage(), 'shot');
    expect(opts.map((o) => o.port)).toEqual(['first-frame', 'ref-image']);
  });
});

describe('IMAGE_KINDS', () => {
  it('image-crop 属于图片产物类节点(静帧直通/收口集合)', () => {
    expect(IMAGE_KINDS).toContain('image-crop');
  });

  it('image-stitch / image-split 同属图片产物类节点', () => {
    expect(IMAGE_KINDS).toContain('image-stitch');
    expect(IMAGE_KINDS).toContain('image-split');
  });
});

describe('resolvePortOptions · 图片拼接/拆分(image-stitch / image-split)', () => {
  it('四类图片产物 + asset(图)→ stitch 提供多值 piece 端口', () => {
    for (const k of ['image-gen', 'image-edit', 'image-upscale', 'image-crop']) {
      const opts = resolvePortOptions(imageNode(k, true), 'stitch');
      expect(opts.map((o) => o.port), k).toEqual(['piece']);
    }
    expect(resolvePort(assetImage(), 'stitch')?.port).toBe('piece');
  });

  it('四类图片产物 → split 提供 input 端口(拆分源)', () => {
    for (const k of ['image-gen', 'image-edit', 'image-upscale', 'image-crop']) {
      expect(resolvePort(imageNode(k, true), 'split')?.port, k).toBe('input');
    }
  });

  it('stitch/split 产物可作下游输入(input)与拼接件(piece)', () => {
    for (const k of ['image-stitch', 'image-split']) {
      expect(resolvePort(imageNode(k, true), 'edit')?.port, k).toBeDefined();
      expect(resolvePort(imageNode(k, true), 'stitch')?.port, k).toBeDefined();
    }
  });

  it('image-split → 图片处理目标:动态 piece-N 选项(网格 3×3 → piece-1..9)', () => {
    const sp = { ...node('image-split'), data: { mode: 'grid', gridCols: 3, gridRows: 3 } };
    const opts = resolvePortOptions(sp, 'edit');
    expect(opts).toHaveLength(9);
    expect(opts[0]!.port).toBe('piece-1');
    expect(opts[8]!.port).toBe('piece-9');
  });

  it('image-split 已跑出产物时按实际片数出选项(覆盖参数推算)', () => {
    const sp = { ...node('image-split'), data: { mode: 'rows', count: 9, pieces: ['/o/p1.png', '/o/p2.png'] } };
    expect(resolvePortOptions(sp, 'stitch').map((o) => o.port)).toEqual(['piece-1', 'piece-2']);
  });

  it('image-split → shot 仍是固定双端口(默认第 1 片)', () => {
    const sp = { ...node('image-split'), data: { mode: 'grid', gridCols: 3, gridRows: 3 } };
    expect(resolvePortOptions(sp, 'shot').map((o) => o.port)).toEqual(['first-frame', 'ref-image']);
  });

  it('stitch/split 产物可收口到 workflow-output(output)', () => {
    for (const k of ['image-stitch', 'image-split']) {
      expect(resolvePort(imageNode(k, true), 'wf-output')?.port, k).toBe('output');
    }
  });

  it('shot(视频)→ stitch 无可用端口(媒体不匹配,不出现在弹窗)', () => {
    expect(hasConnector(node('shot'), 'stitch')).toBe(false);
    expect(hasConnector(node('shot'), 'split')).toBe(false);
  });
});

describe('KIND_TO_TAGID 归一(拖拽连到已存在节点:快照加载的节点无 tag,传入长 kind)', () => {
  it('图片产物 → image-stitch(长 kind)同样解析出 piece 端口', () => {
    expect(resolvePort(imageNode('image-gen', true), 'image-stitch')?.port).toBe('piece');
    expect(resolvePort(assetImage(), 'image-stitch')?.port).toBe('piece');
  });

  it('图片产物 → image-split(长 kind)解析出 input 端口', () => {
    expect(resolvePort(imageNode('image-edit', true), 'image-split')?.port).toBe('input');
  });

  it('回归:asset(图)→ image-crop / image-edit(长 kind)拖拽连线可用(历史同型 bug)', () => {
    expect(resolvePort(assetImage(), 'image-crop')?.port).toBe('input');
    expect(resolvePort(assetImage(), 'image-edit')?.port).toBe('input');
    expect(resolvePort(imageNode('image-gen', true), 'image-upscale')?.port).toBe('input');
  });

  it('image-split(长 kind 目标)→ 动态 piece-N 不受影响;长 kind 源也正常', () => {
    const sp = { ...node('image-split'), data: { mode: 'rows', count: 2 } };
    expect(resolvePortOptions(sp, 'image-edit').map((o) => o.port)).toEqual(['piece-1', 'piece-2']);
  });
});

/**
 * guardEdge — 渲染层写边前的权威校验闸(方案 B:非法组合判定为不合法,建边时就拦下)。
 *
 * 事故背景(2026-09):`connectors.ts` 的 BY_KIND 与 shared 的 `CONNECTOR_MAP` 是两份手工
 * 维护的同构表且已分叉;渲染层从不调用 shared 的 `validateEdge`,于是
 * `video-upscale → image-edit` 这类「shared 判定无可用端口」的边照样能建出来。
 * 边建出来后 `edge-dispatch` 不认 VIDEO_KINDS(什么都不写)、写盘广播又把快照推回来,
 * 两边对同一条边的期望相反 ⇒ 节点在「有输入图 / 无输入图」间反复翻 ⇒ **不停闪烁**。
 */
describe('guardEdge · 视频产物 → 图片编辑 被判不合法(闪烁事故回归)', () => {
  const vup = (id = 'u'): CanvasNode =>
    ({ id, title: '视频增强', w: 200, x: 0, y: 0, kind: 'video-upscale', data: { resultPath: '/out/u.mp4' } }) as CanvasNode;
  const edit = (id = 'e'): CanvasNode =>
    ({ id, title: '图片编辑', w: 200, x: 300, y: 0, kind: 'image-edit', data: {} }) as CanvasNode;

  it('video-upscale → image-edit(label=input)被拦下,并给出可读原因', () => {
    const r = guardEdge(vup(), edit(), 'input', [vup(), edit()], []);
    expect(r.ok).toBe(false);
    expect(r.message).toBeTruthy();
    // 复现根因:shared 侧该组合确实没有可用端口(mp4 不是静帧,不该直连图片编辑 input)
    expect(r.message).toContain('没有可用端口');
  });

  it('回归:video-upscale → image-edit 在弹窗侧也本来就不出现(两份表此处一致)', () => {
    // 弹层不可见 + 写边被拦 = 双保险;此前缺口在于**拖拽到已有节点**那条路径不做 shared 校验
    expect(hasConnector(vup(), 'edit')).toBe(false);
    expect(guardEdge(vup(), edit(), 'input', [vup(), edit()], []).ok).toBe(false);
  });

  it('缺 label(无端口锚定)给出人话提示而不是放任脏边落盘', () => {
    const r = guardEdge(vup(), edit(), undefined, [vup(), edit()], []);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('没有可用的连线角色');
  });
});

describe('guardEdge · 合法组合一律放行(不误伤)', () => {
  const shot = (id = 's'): CanvasNode =>
    ({ id, title: '镜头', w: 200, x: 0, y: 0, kind: 'shot', data: { resultPath: '/out/s.mp4' } }) as CanvasNode;
  const edit = (id = 'e'): CanvasNode =>
    ({ id, title: '图片编辑', w: 200, x: 300, y: 0, kind: 'image-edit', data: {} }) as CanvasNode;
  const imgGen = (id = 'g'): CanvasNode =>
    ({ id, title: '图片生成', w: 200, x: 0, y: 0, kind: 'image-gen', data: { resultPath: '/out/g.png' } }) as CanvasNode;
  const crop = (id = 'c'): CanvasNode =>
    ({ id, title: '图片裁切', w: 200, x: 300, y: 0, kind: 'image-crop', data: {} }) as CanvasNode;

  it('shot → image-edit(input)**不再合法**:视频须先经 frame-grab 落成图片(2026-09 语义收紧)', () => {
    expect(guardEdge(shot(), edit(), 'input', [shot(), edit()], []).ok).toBe(false);
    // 弹层侧同口径:不该再把「图片编辑」列给镜头节点
    expect(hasConnector(shot(), 'edit')).toBe(false);
  });

  it('图片产物 → image-crop(input)合法', () => {
    expect(guardEdge(imgGen(), crop(), 'input', [imgGen(), crop()], []).ok).toBe(true);
  });

  it('单值端口冲突标记为 replaceable(替换语义)→ 放行,由既有逻辑顶掉旧边', () => {
    // image-edit 的 input 是单值端口:已有 A→E 的 input,再连 B→E 应走「替换语义」而非非法
    const a = imgGen('a');
    const b = imgGen('b');
    const e = edit();
    const edges = [{ from: 'a', to: 'e', label: 'input' }];
    const r = guardEdge(b, e, 'input', [a, b, e], edges);
    expect(r.ok).toBe(true);
  });

  it('自连被拦(同一节点)', () => {
    const s = shot();
    const r = guardEdge(s, s, 'input', [s], []);
    expect(r.ok).toBe(false);
  });
});

/**
 * 2026-09 语义收紧:视频**不得**直连图片编辑,必须先经「视频裁切取帧」
 * 把视频落成图片资源。同时镜头节点的「+」弹层不该再列出「图片编辑」。
 */
describe('shot 的「+」弹层可见类型(不含图片编辑,含视频裁切取帧)', () => {
  const shot = (): CanvasNode =>
    ({ id: 's', title: '镜头 01', w: 200, x: 0, y: 0, kind: 'shot', data: { resultPath: '/o/s.mp4' } }) as CanvasNode;
  /** 模拟 AddNodePopover 的可见性过滤 */
  const visible = (src: CanvasNode) => NODE_TYPES.filter((t) => hasConnector(src, t.id)).map((t) => t.name);

  it('不列出「图片编辑」(事故:点了加号看到图片编辑,连上就闪)', () => {
    expect(visible(shot())).not.toContain('图片编辑');
  });

  it('列出「视频裁切取帧」(新的合法下游)', () => {
    expect(visible(shot())).toContain('视频裁切取帧');
  });

  it('镜头节点弹层仍是「视频增强 + 镜头 + 取帧 + 时间线 + 工作流出口」这组(无图片编辑)', () => {
    expect(visible(shot()).sort()).toEqual(
      ['视频增强', '镜头（视频）', '视频裁切取帧', '时间线 / 剪辑', '工作流出口'].sort(),
    );
  });
});

describe('frame-grab · 视频裁切取帧(新增节点的连接与类型)', () => {
  const shot = (): CanvasNode =>
    ({ id: 's', title: '镜头', w: 200, x: 0, y: 0, kind: 'shot', data: { resultPath: '/o/s.mp4' } }) as CanvasNode;
  const vup = (): CanvasNode =>
    ({ id: 'u', title: '视频增强', w: 200, x: 0, y: 0, kind: 'video-upscale', data: { resultPath: '/o/u.mp4' } }) as CanvasNode;
  const grab = (): CanvasNode =>
    ({ id: 'g', title: '视频裁切取帧', w: 200, x: 300, y: 0, kind: 'frame-grab', data: { mode: 'first' } }) as CanvasNode;
  const edit = (): CanvasNode =>
    ({ id: 'e', title: '图片编辑', w: 200, x: 600, y: 0, kind: 'image-edit', data: {} }) as CanvasNode;
  const imgGen = (): CanvasNode =>
    ({ id: 'ig', title: '图片生成', w: 200, x: 0, y: 0, kind: 'image-gen', data: { resultPath: '/o/g.png' } }) as CanvasNode;

  it('视频源(镜头/视频增强)→ frame-grab 走 input-video 端口', () => {
    expect(guardEdge(shot(), grab(), 'input-video', [shot(), grab()], []).ok).toBe(true);
    expect(guardEdge(vup(), grab(), 'input-video', [vup(), grab()], []).ok).toBe(true);
  });

  it('图片源 → frame-grab 被拒(input-video 端口要求视频媒体)', () => {
    const r = guardEdge(imgGen(), grab(), 'input-video', [imgGen(), grab()], []);
    expect(r.ok).toBe(false);
  });

  it('frame-grab 产物是图片 → 可接图片编辑的 input(这正是替代 shot→edit 的合法通道)', () => {
    expect(guardEdge(grab(), edit(), 'input', [grab(), edit()], []).ok).toBe(true);
    expect(hasConnector(grab(), 'edit')).toBe(true);
  });

  it('frame-grab 归入图片产物类(IMAGE_KINDS),下游图片处理节点都能接', () => {
    expect(IMAGE_KINDS).toContain('frame-grab');
  });
});