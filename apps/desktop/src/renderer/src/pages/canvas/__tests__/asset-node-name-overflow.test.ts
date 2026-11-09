/**
 * 资源节点长名称不撑破卡片(2026-11-07 实测事故:资产名是 64 位 sha256,
 * 节点头部与底部 meta 一起溢出卡片左右边缘)。
 *
 * 两道闸:
 *  ① 头部标题必须是**可压缩容器**(`.nh-t`,min-width:0 + ellipsis),否则 flex 子项
 *     按内容撑开,长串直接压在卡片外;
 *  ② 底部 meta 用中部省略(clipName)展示,完整值留在 title 里悬停可查。
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CanvasNode } from '../types.js';
import { NodeBody } from '../nodes/NodeBody.js';
import { NodeCard } from '../NodeCard.js';

const HASH = '4003b0b09b8ed27a80c6c1217950ef9adf80da5e29376b63192e49a0f8b66a7a';

function assetNode(): CanvasNode {
  return {
    id: 'asset-1',
    title: HASH,
    kind: 'asset',
    x: 0,
    y: 0,
    w: 236,
    data: { assetId: 'a1', mediaType: 'image' },
  } as CanvasNode;
}

const assetMeta = {
  a1: { name: HASH, kind: 'image', categoryName: '角色', src: null as string | null },
};

/** 渲染一个不依赖真实 DOM/网络的最小 NodeCard */
function renderCard(): string {
  const noop = (): void => undefined;
  return renderToStaticMarkup(
    React.createElement(NodeCard, {
      node: assetNode(),
      selected: false,
      flash: false,
      dragging: false,
      group: null,
      isConnectTarget: false,
      connectHitOk: false,
      nodes: [],
      takeResults: {},
      assetMeta,
      onSelect: noop,
      onContextMenu: noop,
      onHeaderPointerDown: noop,
      onAddPointerDown: noop,
      onAddClick: noop,
      registerRef: noop,
    } as never),
  );
}

describe('资源节点长名称', () => {
  it('头部标题包在可省略容器里,完整名称放 title 供悬停查看', () => {
    const html = renderCard();
    expect(html).toContain('class="nh-t"');
    expect(html).toContain(`title="${HASH}"`);
  });

  it('底部 meta 做中部省略(保留头尾),不再整串铺满卡片', () => {
    const html = renderToStaticMarkup(
      React.createElement(NodeBody, {
        node: assetNode(),
        nodes: [],
        takeResults: {},
        assetMeta,
      } as never),
    );
    // 可见文本是中部省略形态(完整 64 位串只允许出现在 title 属性里)
    const clipped = `${HASH.slice(0, 13)}…${HASH.slice(-6)}`;
    expect(html).toContain(`>${clipped} · image · 角色</div>`);
    // 完整值仍可从 title 悬停查到,数据不丢
    expect(html).toContain(`title="${HASH}"`);
  });

  it('短名称原样展示,不做多余省略', () => {
    const short = { a1: { name: '新娘三视图.png', kind: 'image', src: null as string | null } };
    const html = renderToStaticMarkup(
      React.createElement(NodeBody, {
        node: assetNode(),
        nodes: [],
        takeResults: {},
        assetMeta: short,
      } as never),
    );
    expect(html).toContain('新娘三视图.png');
    expect(html).not.toContain('…');
  });
});
