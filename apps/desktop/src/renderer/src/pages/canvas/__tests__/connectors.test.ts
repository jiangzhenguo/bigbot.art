/**
 * 连接器测试 — 图片裁切节点(image-crop)端口解析(渲染层权威表 connectors.ts)
 * 覆盖:「+」弹窗可见性与端口锚定;源/目标类型矩阵;图片产物集合
 */
import { describe, it, expect } from 'vitest';
import { resolvePortOptions, resolvePort, hasConnector, IMAGE_KINDS } from '../connectors.js';
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