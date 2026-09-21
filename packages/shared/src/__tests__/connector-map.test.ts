/**
 * 能力表测试 — 图片裁切节点(image-crop)在 shared 连接器能力表/节点指南中的定义
 */
import { describe, it, expect } from 'vitest';
import {
  CONNECTOR_MAP,
  NODE_KIND_GUIDE,
  nodeKindGuide,
  connectorSummary,
  PORT_SEMANTICS,
} from '../connector-map.js';

describe('CONNECTOR_MAP · image-crop', () => {
  it('image-crop 作为源:可连 shot(首帧)/edit/upscale(输入)/image(参考图)/timeline(clip)', () => {
    const src = CONNECTOR_MAP['image-crop'];
    expect(src).toBeDefined();
    expect(src?.['shot']).toBe('first-frame');
    expect(src?.['edit']).toBe('input');
    expect(src?.['upscale']).toBe('input');
    expect(src?.['image']).toBe('ref-image');
    expect(src?.['timeline']).toBe('clip');
  });

  it('图片产物类节点可作为裁切源(crop → input)', () => {
    expect(CONNECTOR_MAP['image-gen']?.['crop']).toBe('input');
    expect(CONNECTOR_MAP['image-edit']?.['crop']).toBe('input');
    expect(CONNECTOR_MAP['image-upscale']?.['crop']).toBe('input');
  });

  it('asset(图片)可作裁切源', () => {
    expect(CONNECTOR_MAP.asset?.['crop']).toBe('input');
  });
});

describe('NODE_KIND_GUIDE · image-crop', () => {
  it('节点指南含 image-crop 且描述提及画幅裁剪', () => {
    const row = NODE_KIND_GUIDE.find(([k]) => k === 'image-crop');
    expect(row).toBeDefined();
    expect(row![1]).toContain('画幅');
  });

  it('nodeKindGuide() 输出包含 image-crop 行', () => {
    expect(nodeKindGuide()).toContain('- image-crop:');
  });

  it('connectorSummary() 输出包含 image-crop 可连关系', () => {
    const s = connectorSummary();
    expect(s).toContain('image-crop:可连');
    expect(s).toContain('edit → input');
  });
});

describe('PORT_SEMANTICS · input 端口', () => {
  it('input 语义存在(输入图/输入帧)', () => {
    expect(PORT_SEMANTICS.input).toContain('输入');
  });
});