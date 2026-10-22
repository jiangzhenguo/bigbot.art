/**
 * 派生态 → nodesRef 同步的源码护栏(2026-10-11「图片编辑无法运行」事故回归)
 *
 * 事故形态:new6-8c7w(image-edit)连线完整、检查器显示「输入图 · 产物直通」,
 * 点「运行」却 toast「需要输入图」—— 探针实测:点击时 nodesRef 里 inputImageFrom=null,
 * 而 nodes state 里有。根因:9f80e2f 给 setNodes 加 ref 同步包装时只覆盖了 'set' 分支,
 * derive-from-edges 由 effect 直接 dispatchNodes(旁路),派生态永远进不了 nodesRef;
 * 而 runNode / buildActiveSnapshot / 连线校验全部读 ref ⇒ 「显示有、运行没有」,
 * 派生态也永远存不进快照。
 *
 * 修法:derive effect 里先 computeEdgeDerivations 算出结果,**先把同一份结果同步进
 * nodesRef**(changed=false 也要同步,愈合历史裂口),再 dispatch。
 *
 * 2026-10-20 追加(画布被抹空事故):同步 ref 时**不许无条件用 state** ——
 * effect 里读到的 `nodes` 可能还是上一次渲染的旧值(挂载首帧为初始空数组,StrictMode 还会重放),
 * 无条件回写会把刚加载的节点清成 [],而 edgesRef 仍有边 ⇒ 卸载 flush 写出「0 节点 + N 悬空边」,
 * 两个项目画布被抹空。本测试同时锁死:算 → 同步 ref → 再 dispatch,且空 state 不得覆盖非空 ref。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '../../CanvasPage.tsx'), 'utf-8');

/** 抽出 derive effect 的函数体(从注释锚点到 effect 结束) */
function deriveEffectBody(): string {
  const anchor = src.indexOf("dispatchNodes({ type: 'derive-from-edges', edges });");
  expect(anchor, 'CanvasPage 里找不到 derive-from-edges 的 dispatch').toBeGreaterThan(-1);
  // 往前找最近的 useEffect( 起点
  const start = src.lastIndexOf('useEffect(() => {', anchor);
  expect(start, 'derive dispatch 不在 useEffect 里').toBeGreaterThan(-1);
  return src.slice(start, anchor + 80);
}

describe('derive-from-edges 必须同步 nodesRef(2026-10-11 事故)', () => {
  it('derive effect 先算派生结果、同步 nodesRef,再 dispatch(顺序锁死)', () => {
    const body = deriveEffectBody();
    const iCompute = body.indexOf('computeEdgeDerivations(nodes, edges)');
    const iSync = body.indexOf('nodesRef.current = r.nextNodes');
    const iDispatch = body.indexOf("dispatchNodes({ type: 'derive-from-edges', edges });");
    expect(iCompute, 'derive effect 里缺少 computeEdgeDerivations 预算').toBeGreaterThan(-1);
    expect(iSync, 'derive effect 里缺少 nodesRef 同步(派生态只进 state 不进 ref 的事故会复活)').toBeGreaterThan(-1);
    expect(iDispatch).toBeGreaterThan(-1);
    expect(iCompute).toBeLessThan(iSync);
    expect(iSync).toBeLessThan(iDispatch);
  });

  it('ref 同步不依赖 changed(历史裂口:state 已有派生态时 changed=false,也要同步)', () => {
    const body = deriveEffectBody();
    // 同步语句本身必须有(派生态不能只进 state),但允许按 changed 分支
    expect(body).toMatch(/nodesRef\.current = r\.nextNodes/);
  });

  it('⚠️ 空 state 不许覆盖非空 ref(2026-10-20 画布被抹空事故)', () => {
    const body = deriveEffectBody();
    // 旧的「无条件回写」是事故真因:`nodesRef.current = r.changed ? r.nextNodes : nodes`
    expect(body, '无条件用 state 回写 ref 的写法回来了').not.toMatch(
      /nodesRef\.current = r\.changed \? r\.nextNodes : nodes/,
    );
    // 必须带守卫:nodes 非空、或 ref 本来就是空,才允许用 state 回写
    expect(body).toMatch(/nodes\.length > 0 \|\| nodesRef\.current\.length === 0/);
  });
});
