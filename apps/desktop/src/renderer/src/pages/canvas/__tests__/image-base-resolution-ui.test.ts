/**
 * 图片生成检查器「画幅 → 基础分辨率」UI 契约测试。
 *
 * 目标:1K / 1.5K / 2K 三个档位必须**真实渲染出可点 chip**,且每个 chip 直接写出
 * 「按当前画幅等比缩放后的实际宽高」—— 用户不点开也能知道会出多大。
 * 档位匹配高亮依赖容差(换档后宽高取整),这里一并锁住。
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AspectPresets } from '../inspector/image-ui.js';

function render(width: number, height: number): string {
  return renderToStaticMarkup(
    React.createElement(AspectPresets, { width, height, onChange: () => undefined }),
  );
}

describe('AspectPresets · 基础分辨率档位', () => {
  it('渲染 1K / 1.5K / 2K 三个档,并写出各自实际宽高', () => {
    const html = render(1024, 576);
    expect(html).toContain('data-od-id="base-resolution-1k"');
    expect(html).toContain('data-od-id="base-resolution-1.5k"');
    expect(html).toContain('data-od-id="base-resolution-2k"');
    // 16:9 三档的真实输出尺寸
    expect(html).toContain('1024×576');
    expect(html).toContain('1536×864');
    expect(html).toContain('2048×1152');
  });

  it('当前尺寸命中某档时该 chip 高亮,其余不高亮', () => {
    const html = render(1536, 864);
    const chip = (key: string): string => {
      const i = html.indexOf(`data-od-id="base-resolution-${key}"`);
      return html.slice(Math.max(0, i - 120), i);
    };
    expect(chip('1.5k')).toContain('chip on');
    expect(chip('1k')).not.toContain('chip on');
    expect(chip('2k')).not.toContain('chip on');
  });

  it('自定义长边(1280×720)不高亮任何档位,但仍给出三档预览', () => {
    const html = render(1280, 720);
    expect(html).not.toContain('chip on');
    expect(html).toContain('1024×576');
    expect(html).toContain('2048×1152');
  });

  it('画幅区文案说明「长边像素 + 等比缩放」,不让人误以为是面积档', () => {
    const html = render(1024, 1024);
    expect(html).toContain('长边像素');
    expect(html).toContain('等比缩放');
  });
});
