/**
 * 空白处右键 = 取消选择
 *
 * 需求:在画布空白地方右击,取消当前选中的节点(与 Figma 一致)。
 *
 * 这类交互没有纯函数可测,且 mount 整个 CanvasPage 需要 window.bigbotart /
 * ResizeObserver 一整套环境(见 viewport-imperative.test.ts 的同款说明),
 * 故沿用该文件的**源码契约**手法:把「谁拦事件、谁清选区」这几条不变量钉死。
 *
 * ⚠️ 2026-10-10 事故(「右键取消选择没了」):第一版把处理程序挂在 **.world** 上,
 * 而 .world 只有固定 1600×1000(design-pages.css `.pg-canvas .world`),点阵背景
 * 画在 **.stage** 上 —— 用户看到的「空白」大部分是 stage 自身(平移之后、或世界
 * 矩形之外),处理程序从未触发。真正会回退的不变量是:
 *   ① 处理程序必须挂在 .stage 上,且带与 onPointerDown 同款的空白命中判定
 *      (stage 自身 / .world / svg 才算空白);
 *   ② 节点右键菜单不得被抢走 —— 靠 NodeCard contextmenu 的 stopPropagation
 *      (React 合成事件:stop 之后 stage 的处理器不会被调用),不靠「别挂 stage」。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** canvas/ 下的模块(StageView / NodeCard) */
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
/** pages/CanvasPage.tsx(canvas 的上一级) */
const readPage = () => fs.readFileSync(path.join(__dirname, '..', '..', 'CanvasPage.tsx'), 'utf8');
/** styles/design-pages.css */
const readCss = () =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', 'styles', 'design-pages.css'), 'utf8');

/** 截取 .stage 开标签的属性区(section 开标签 → .world 开标签之间) */
const stageAttrs = (src: string) => {
  const stageOpen = src.search(/^\s*<section$/m);
  expect(stageOpen).toBeGreaterThan(-1);
  const worldOpen = src.indexOf('className="world"', stageOpen);
  expect(worldOpen).toBeGreaterThan(stageOpen);
  const seg = src.slice(stageOpen, worldOpen);
  expect(seg).toMatch(/data-od-id="canvas-stage"/); // 确认截到的就是舞台
  return seg;
};

describe('StageView — 空白右键挂在 .stage 上,且只认「真的点在空白」', () => {
  const src = read('StageView.tsx');

  it('StageViewProps 暴露 onWorldContextMenu', () => {
    expect(src).toMatch(/onWorldContextMenu: \(e: React\.MouseEvent\) => void;/);
    // 解构里也要有,否则传进来的回调永远不会被调用
    const destructure = src.slice(src.indexOf('export function StageView({'));
    expect(destructure.slice(0, 1200)).toMatch(/onWorldContextMenu,/);
  });

  it('处理程序挂在 .stage 的属性区(2026-10-10 事故:.world 只有 1600×1000,空白大多是 stage)', () => {
    const attrs = stageAttrs(src);
    expect(attrs).toMatch(/onContextMenu=\{\(e\) => \{/);
    // 与 onPointerDown 同款的空白命中判定:stage 自身 / .world / svg 才算空白
    expect(attrs).toMatch(/const t = e\.target/);
    expect(attrs).toMatch(/t !== e\.currentTarget/);
    expect(attrs).toMatch(/t\.classList\.contains\('world'\)/);
    expect(attrs).toMatch(/t\.tagName !== 'svg'/);
    expect(attrs).toMatch(/onWorldContextMenu\(e\)/);
    // 这里绝不 preventDefault:'节点菜单'的右键由 NodeCard 处理,空白处由 CanvasPage 处理,
    // StageView 只做路由,不越权决定浏览器默认菜单的去留。
    expect(attrs).not.toMatch(/preventDefault/);
  });

  it('⚠️ 事故回归锚:.world 仍是固定 1600×1000(改回无限大前,右键只能挂 stage)', () => {
    const css = readCss();
    const worldRule = css.split('\n').find((l) => l.includes('.pg-canvas .world{')) ?? '';
    expect(worldRule).toContain('width:1600px');
    expect(worldRule).toContain('height:1000px');
    // 点阵背景(用户眼中的「画布空白」)画在 stage 上,不在 world 上
    const stageRule = css.split('\n').find((l) => l.includes('.pg-canvas .stage{')) ?? '';
    expect(stageRule).toContain('radial-gradient');
  });

  it('.world 自身不再带 onContextMenu(与 stage 双挂会重复触发)', () => {
    const worldOpen = src.indexOf('className="world"');
    const seg = src.slice(worldOpen, worldOpen + 2200);
    expect(seg).not.toMatch(/onContextMenu/);
  });
});

describe('NodeCard — 节点右键仍然拦下事件', () => {
  it('节点自己的 contextmenu 调 CanvasPage 回调(回调内 stopPropagation)', () => {
    const src = read('NodeCard.tsx');
    const i = src.indexOf('onContextMenu={(e) => onContextMenu(e, n)}');
    expect(i).toBeGreaterThan(-1);
    const page = readPage();
    const h = page.indexOf('const handleNodeContextMenu = useCallback');
    expect(h).toBeGreaterThan(-1);
    const seg = page.slice(h, h + 520);
    expect(seg).toMatch(/e\.stopPropagation\(\)/);
    expect(seg).toMatch(/setCtx\(\{ x: e\.clientX, y: e\.clientY, id: n\.id \}\)/);
  });
});

describe('CanvasPage — 空白右键取消选择的语义', () => {
  const src = readPage();
  const open = src.indexOf('const handleWorldContextMenu = useCallback');
  /** 回调体(截到下一个 useCallback 声明为止,避免把后面的回调算进来) */
  const body = (() => {
    const rest = src.slice(open);
    const next = rest.indexOf('const handleNodeHeaderPointerDown', 40);
    return rest.slice(0, next);
  })();

  it('回调存在并接到了 StageView 的 onWorldContextMenu', () => {
    expect(open).toBeGreaterThan(-1);
    expect(src).toMatch(/onWorldContextMenu=\{handleWorldContextMenu\}/);
  });

  it('清空选区(取消选择),并禁掉默认右键菜单', () => {
    expect(body).toMatch(/e\.preventDefault\(\)/);
    expect(body).toMatch(/setSelectedIds\(\[\]\)/);
  });

  it('已经空选区时不做无谓的状态写入', () => {
    // 判空与清空写在同一个分支里(空选区只走 preventDefault,不 setState)
    expect(body).toMatch(/if \(selectedIdsRef\.current\.length !== 0\) \{/);
    expect(body.indexOf('selectedIdsRef.current.length !== 0')).toBeLessThan(
      body.indexOf('setSelectedIds([])'),
    );
  });

  it('顺带收掉可能开着的浮层(「+」弹层 / 节点菜单)', () => {
    expect(body).toMatch(/closeAddPop\(\)/);
    expect(body).toMatch(/setCtx\(null\)/);
  });

  it('选中态不是编辑内容:不进撤销/重做历史', () => {
    /* 与「点空白清空选区」同口径 —— 只 setSelectedIds,不 commitEdit。
       若这里提交历史,用户按 ⌘Z 会「撤销」出一次莫名其妙的选中。 */
    expect(body).not.toMatch(/commitEdit\(/);
    expect(body).not.toMatch(/historyRef\.current\.commit/);
  });
});
