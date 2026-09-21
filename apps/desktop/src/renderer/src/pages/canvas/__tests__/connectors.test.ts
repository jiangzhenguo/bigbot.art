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
});