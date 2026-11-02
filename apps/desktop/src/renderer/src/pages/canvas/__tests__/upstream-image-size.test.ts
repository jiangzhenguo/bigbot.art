import { describe, expect, it } from 'vitest';
import { resolveShotSpecForRole } from '@bigbotart/shared';
import type { CanvasNode } from '../types';
import { resolveUpstreamImageSize } from '../upstream-image-size';

const imageEditWithSquareResult: CanvasNode = {
  id: 'edit-1',
  title: '图片编辑',
  kind: 'image-edit',
  w: 224,
  x: 0,
  y: 0,
  data: { resultPath: '/outputs/square.png' },
};

describe('首帧上游图片尺寸解析', () => {
  it('图片编辑节点缺 width/height 时，从真实产物识别 1536×1536', async () => {
    const size = await resolveUpstreamImageSize(imageEditWithSquareResult, [], async (path) => {
      expect(path).toBe('/outputs/square.png');
      return { ok: true, width: 1536, height: 1536 };
    });
    expect(size).toEqual({ width: 1536, height: 1536 });
    expect(resolveShotSpecForRole('first-frame', '16:9', 'reference', size)).toEqual({
      aspect: '1:1',
      width: 768,
      height: 768,
    });
  });

  it('已有有效元数据时不探测文件', async () => {
    const src: CanvasNode = { ...imageEditWithSquareResult, data: { width: 1024, height: 1024 } };
    const size = await resolveUpstreamImageSize(src, [], async () => {
      throw new Error('不应探测');
    });
    expect(size).toEqual({ width: 1024, height: 1024 });
  });

  it('资产元数据缺失时也读取真实文件', async () => {
    const src: CanvasNode = {
      id: 'asset-node', title: '图片', kind: 'asset', w: 224, x: 0, y: 0,
      data: { assetId: 'asset-1', resultPath: '/outputs/asset.png' },
    };
    const size = await resolveUpstreamImageSize(src, [{ id: 'asset-1' }], async () => ({
      ok: true, width: 2048, height: 2048,
    }));
    expect(size).toEqual({ width: 2048, height: 2048 });
  });

  it('探测失败或无有效尺寸时返回 undefined', async () => {
    await expect(resolveUpstreamImageSize(imageEditWithSquareResult, [], async () => ({ ok: false }))).resolves.toBeUndefined();
    await expect(resolveUpstreamImageSize(imageEditWithSquareResult, [], async () => {
      throw new Error('文件不可读');
    })).resolves.toBeUndefined();
  });
});
