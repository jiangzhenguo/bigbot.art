/**
 * 换页/打开画布的「加载中」遮罩 —— 源码护栏(2026-10-23 iPad 网页端实测)
 *
 * 用户反馈:进画布与从画布回首页都会「卡在那里」——整页没反应,像死机。
 * 根因:换页要**同步**卸载整张画布(几百个节点 DOM + SVG 连线)再挂载新页,
 * 浏览器在这段跑完之前没法 paint;公网链路只有 ~350KB/s,这段被拉得更长。
 *
 * 修法:挂一个全屏「加载中」遮罩。⚠️ 但遮罩本身有个硬约束 ——
 * **必须先让浏览器把遮罩画出去,再做那件重活**。若遮罩与重活在同一帧里,
 * 遮罩等于没加(重活跑完才 paint,用户直接看到结果,中间的「卡」依旧存在)。
 *
 * 本测试锁死的就是这个顺序,以及两条「不许卡死」的兜底:
 * ① nextPaint 必须有定时器兜底(标签页在后台时 rAF 不触发,否则导航直接挂死);
 * ② 遮罩必须有超时兜底(画布没报就绪时不能一直转圈);
 * ③ 画布页的遮罩要等 CanvasPage 自己报就绪(否则会闪一下空画布)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(resolve(here, '../../App.tsx'), 'utf-8');
const canvasSrc = readFileSync(resolve(here, '../CanvasPage.tsx'), 'utf-8');

/** 取出某个函数的源码片段(从函数名到下一个顶层声明) */
function blockOf(src: string, marker: string): string {
  const i = src.indexOf(marker);
  expect(i, `源码里找不到 ${marker}`).toBeGreaterThan(-1);
  // 往后取到下一个顶层 `  };`(同缩进的函数结束)
  const end = src.indexOf('\n  };', i);
  return src.slice(i, end > -1 ? end : i + 4000);
}

describe('换页加载遮罩:先上屏,再干活', () => {
  it('handleNavigate:挂遮罩 → 等一帧 → 换页(顺序锁死)', () => {
    const body = blockOf(appSrc, 'const handleNavigate = useCallback(');
    const iMask = body.indexOf('setNavLoading(');
    const iPaint = body.indexOf('await nextPaint()');
    const iGo = body.indexOf('setCurrentPage(page)');
    expect(iMask, 'handleNavigate 里没有挂遮罩').toBeGreaterThan(-1);
    expect(iPaint, 'handleNavigate 里没有等一帧(遮罩与重活同帧 = 白加)').toBeGreaterThan(-1);
    expect(iGo, 'handleNavigate 里没有换页').toBeGreaterThan(-1);
    expect(iMask, '遮罩必须先挂').toBeLessThan(iPaint);
    expect(iPaint, '必须等浏览器 paint 一次再换页').toBeLessThan(iGo);
  });

  it('handleSelectProject(首页进画布):遮罩先上屏,再拉画布数据', () => {
    const body = blockOf(appSrc, 'const handleSelectProject = async');
    const iMask = body.indexOf('setNavLoading(');
    const iPaint = body.indexOf('await nextPaint()');
    const iLoad = body.indexOf('await loadCanvasesForProject(');
    const iGo = body.indexOf('setCurrentPage(');
    expect(iMask).toBeGreaterThan(-1);
    expect(iPaint).toBeGreaterThan(-1);
    expect(iMask, '遮罩必须先挂').toBeLessThan(iPaint);
    expect(iPaint, '拉数据前要先让遮罩上屏').toBeLessThan(iLoad);
    expect(iLoad, '画布数据没拉完就换页 = 空画布').toBeLessThan(iGo);
  });

  it('nextPaint 有定时器兜底(后台标签页 rAF 不触发,否则导航挂死)', () => {
    const body = blockOf(appSrc, 'function nextPaint(');
    expect(body, 'nextPaint 里没有定时器兜底').toContain('setTimeout');
    expect(body, 'nextPaint 必须先等一帧(rAF)再 resolve').toContain('requestAnimationFrame');
  });

  it('遮罩有超时兜底:30s 内没等到就绪信号也要撤(不能一直转圈)', () => {
    expect(appSrc, 'App.tsx 里没有遮罩超时兜底').toContain('30000');
    const body = blockOf(appSrc, 'useEffect(() => {\n    if (!navLoading) return;');
    expect(body, '超时兜底没有在 navLoading 变化时重建定时器').toContain('setTimeout');
    expect(body, '超时后必须清掉遮罩').toContain('setNavLoading(null)');
  });

  it('画布页:遮罩等 CanvasPage 报就绪才撤(否则闪一下空画布)', () => {
    expect(appSrc, 'App.tsx 没有把 onReady 传给 CanvasPage').toContain('onReady={handleCanvasReady}');
    const body = blockOf(appSrc, 'const handleCanvasReady = useCallback(');
    expect(body, '就绪回调必须清掉遮罩').toContain('setNavLoading(null)');
    expect(body, '就绪回调要认「在等画布就绪」这个标记').toContain('waitCanvasReadyRef');
  });

  it('CanvasPage:节点装好并画出第一帧后才报就绪', () => {
    expect(canvasSrc, 'CanvasPage 没有 onReady 回调').toContain('onReady');
    const iHydrate = canvasSrc.indexOf('setNodes(selfHeal.nodes)');
    const iReady = canvasSrc.indexOf('onReadyRef.current?.()');
    expect(iHydrate, '找不到装节点的 hydration 逻辑').toBeGreaterThan(-1);
    expect(iReady, '找不到就绪通知').toBeGreaterThan(-1);
    expect(iHydrate, '就绪通知必须排在装节点之后').toBeLessThan(iReady);
    // 两帧:少等一帧就可能在节点还没画出来时就报就绪 → 闪一下空画布
    const body = blockOf(canvasSrc, "useEffect(() => {\n    // 没有活动画布");
    expect(body, '就绪通知前必须等两次 rAF(等浏览器真的画出去)').toContain('requestAnimationFrame');
    expect(body.split('requestAnimationFrame').length - 1, '就绪通知只等了一帧').toBeGreaterThanOrEqual(2);
  });

  it('换页到当前页直接返回(否则挂上遮罩却等不到就绪信号,转到 30s 兜底)', () => {
    const body = blockOf(appSrc, 'const handleNavigate = useCallback(');
    expect(body, '缺少「已经在这一页就什么都不做」的短路').toContain('if (page === currentPage) return;');
  });
});
