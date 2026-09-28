/**
 * 视口更新路径测试(P3)
 *
 * P3 的核心不变量:**平移/缩放/小地图跳转不得 setState** ——
 * 视口直接写 .world 的 CSS 变量,React 完全不参与。若有人改回 setView,
 * 拖动时整棵树又会逐帧 reconcile(功能正常,优化静默归零)。
 *
 * 这类回归没有运行时症状,只能用源码约束 + 纯函数验证兜住。
 * (本文件不 mount 画布:那需要 window.bigbotart 等一整套环境。)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** canvas/ 下的模块(StageView 等) */
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
/** pages/CanvasPage.tsx(在 canvas 的上一级) */
const readPage = () => fs.readFileSync(path.join(__dirname, '..', '..', 'CanvasPage.tsx'), 'utf8');
/** styles/design-pages.css */
const readCss = () =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', 'styles', 'design-pages.css'), 'utf8');

describe('CSS 变量驱动的视口变换', () => {
  it('.world 的 transform 读 --vx/--vy/--vz,且带默认值', () => {
    const css = readCss();
    // 默认值:首帧 CSS 变量尚未写入时不能闪成 0,0（那会让画布跳到左上角）
    expect(css).toMatch(/--vx:20px/);
    expect(css).toMatch(/--vy:10px/);
    expect(css).toMatch(/--vz:\.86/);
    expect(css).toMatch(/transform:translate\(var\(--vx\),var\(--vy\)\)\s*scale\(var\(--vz\)\)/);
  });

  it('禁止给 .world 加 contain:paint(会裁掉越界的连线与节点)', () => {
    const css = readCss();
    const worldRule = css.split('\n').find((l) => l.includes('.pg-canvas .world{')) ?? '';
    expect(worldRule).toContain('contain:layout style');
    expect(worldRule).not.toContain('contain:paint');
  });
});

describe('StageView — .world 不再受 React style 控制', () => {
  const src = read('StageView.tsx');

  it('.world 上没有 style.transform(否则会覆盖命令式写入的值)', () => {
    // 取 .world 那个 div 的片段,确认它不带 style={{ transform }}
    const idx = src.indexOf('className="world"');
    expect(idx).toBeGreaterThan(-1);
    const seg = src.slice(idx, idx + 420);
    expect(seg).not.toMatch(/style=\{\{[^}]*transform/);
  });

  it('提供 applyView 写入器 + 同步 effect', () => {
    expect(src).toMatch(/applyView: \(v: \{ x: number; y: number; z: number \}\) => void/);
    expect(src).toMatch(/applyView\(view\)/);
  });

  it('小地图拖动结束有收尾回调(P3:否则视角不落盘)', () => {
    expect(src).toMatch(/onMinimapCommit/);
    // pointerup 与 pointercancel 都要收尾(取消不放会导致视角丢失)
    const up = src.indexOf('onPointerUp={(e) => {', src.indexOf('className="minimap"'));
    const seg = src.slice(up, up + 420);
    expect(seg).toMatch(/onMinimapCommit\(\)/);
    const cancel = src.indexOf('onPointerCancel=', src.indexOf('className="minimap"'));
    const seg2 = src.slice(cancel, cancel + 200);
    expect(seg2).toMatch(/onMinimapCommit\(\)/);
  });
});

describe('CanvasPage — 高频视口路径不得 setState', () => {
  const src = readPage();

  it('存在 applyView(写 CSS 变量)与 applyViewLive(写 DOM + 同步 ref)', () => {
    expect(src).toMatch(/const applyView = useCallback/);
    expect(src).toMatch(/setProperty\('--vx'/);
    expect(src).toMatch(/setProperty\('--vy'/);
    expect(src).toMatch(/setProperty\('--vz'/);
    expect(src).toMatch(/const applyViewLive = useCallback/);
  });

  it('平移 onMove 走 applyViewLive 而不是 setView', () => {
    const i = src.indexOf('const onMove = (e: PointerEvent) => {', src.indexOf('if (!panning) return;'));
    expect(i).toBeGreaterThan(-1);
    const seg = src.slice(i, i + 500);
    expect(seg).toMatch(/applyViewLive\(/);
    expect(seg).not.toMatch(/setView\(/);
  });

  it('滚轮缩放走 applyViewLive,收尾用 200ms 防抖 + commitView', () => {
    const i = src.indexOf('const onWheel = (e: WheelEvent) => {');
    expect(i).toBeGreaterThan(-1);
    const seg = src.slice(i, i + 1400);
    expect(seg).toMatch(/applyViewLive\(/);
    expect(seg).not.toMatch(/setView\(/);
    expect(seg).toMatch(/commitView\(/);
  });

  it('小地图跳转走 applyViewLive(可拖拽 = 高频)', () => {
    const i = src.indexOf('const onMinimapNavigate = useCallback');
    expect(i).toBeGreaterThan(-1);
    const seg = src.slice(i, i + 600);
    expect(seg).toMatch(/applyViewLive\(/);
    expect(seg).not.toMatch(/setView\(/);
  });

  it('离散提交统一走 commitView(state + ref + 百分比三同步)', () => {
    expect(src).toMatch(/const commitView = useCallback/);
    const i = src.indexOf('const commitView = useCallback');
    const seg = src.slice(i, i + 300);
    expect(seg).toMatch(/viewRef\.current = v/);
    expect(seg).toMatch(/setView\(v\)/);
    expect(seg).toMatch(/setZoomPctLive\(/);
  });
});

describe('缩放百分比显示 — 不能卡在旧值', () => {
  const src = readPage();

  it('zoomPct 用 zoomPctLive 而非 view.z', () => {
    /* 滚轮缩放期间 view 刻意不更新,若 zoomPct 读 view.z,底部百分比会卡住 */
    expect(src).toMatch(/const zoomPct = `\$\{zoomPctLive\}%`/);
    expect(src).not.toMatch(/const zoomPct = `\$\{Math\.round\(view\.z \* 100\)\}%`/);
  });

  it('applyViewLive 里同步百分比,且同整数不重复 setState', () => {
    const i = src.indexOf('const applyViewLive = useCallback');
    const seg = src.slice(i, i + 600);
    expect(seg).toMatch(/setZoomPctLive/);
    // 关键:prev === pct 时返回 prev,避免滚轮每一格都触发渲染
    expect(seg).toMatch(/prev === pct \? prev : pct/);
  });

  it('缩放按钮 / 重置也走 commitView(否则百分比与真实缩放不符)', () => {
    const i = src.indexOf('onZoomBy={');
    const seg = src.slice(i, i + 400);
    expect(seg).toMatch(/commitView\(/);
    expect(seg).toMatch(/onZoomReset=\{\(\) => commitView\(/);
  });
});

describe('持久化链路完整 — 命令式写入最终要落盘', () => {
  const src = readPage();

  it('持久化 effect 仍依赖 view 分量(P3 靠收尾 commitView 触发它)', () => {
    expect(src).toMatch(/\}, \[view\.x, view\.y, view\.z, projectId, activeCanvasId\]\);/);
  });

  it('平移 / 滚轮 / 小地图 三条命令式路径都有收尾提交', () => {
    // 平移:pointerup
    expect(src).toMatch(/const onUp = \(\) => \{\s*setPanning\(false\);/);
    // 滚轮:防抖定时器
    expect(src).toMatch(/wheelSyncTimer\.current = window\.setTimeout/);
    // 小地图:onMinimapCommit(StageView 侧已断言)
    expect(src).toMatch(/const onMinimapCommit = useCallback/);
  });
});
