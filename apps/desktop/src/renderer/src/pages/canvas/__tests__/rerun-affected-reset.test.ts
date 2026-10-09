/**
 * 「仅重跑受影响」按钮的复位语义(2026-10-08)
 *
 * 事故形态:`setRerunDone(true)` 之后**没有任何地方复位**,而 Toolbar 的按钮是
 * `disabled={rerunDone}` —— 用户点过一次「仅重跑受影响」,按钮就**永久置灰**,
 * 文案停在「重跑已排队 ✓」和旧数字上,切画布 / 新一轮编辑标出 stale 都不恢复,
 * 只有刷新页面才行。
 *
 * 复位判据必须是「受影响集合被清空」(staleCount 归零),**不能用定长延时**:
 * stale 是节点跑完才清的,而单条 h3 实测数分钟到数十分钟,任何固定 N 秒
 * 都必然过早(还在跑就解锁,可重复点)或过晚(跑完了还灰着)。
 *
 * 这类回归没有纯函数可测(mount 画布需要 window.bigbotart 一整套环境),
 * 故沿用本目录既有的**源码约束**手法(见 viewport-imperative.test.ts)。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const readPage = () =>
  fs.readFileSync(path.join(__dirname, '..', '..', 'CanvasPage.tsx'), 'utf8');

/** 取出 rerunDone 定义处到 runAll 定义处的那一段源码,限制断言范围 */
function rerunSeg(src: string): string {
  // 注意是 `const [rerunDone` —— 解构写法带方括号,别按 `const rerunDone` 找
  const start = src.indexOf('const [rerunDone');
  expect(start, 'CanvasPage 里找不到 rerunDone 定义').toBeGreaterThan(-1);
  // 到 runAll 为止,覆盖 staleCount / 复位 effect / rerunAffected 整块
  const end = src.indexOf('const runAll', start);
  expect(end, '找不到 runAll,分段失败').toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('「仅重跑受影响」的 rerunDone 必须能复位', () => {
  it('存在 staleCount === 0 时复位 rerunDone 的 effect', () => {
    const seg = rerunSeg(readPage());
    // 复位 effect:staleCount 归零 ⇒ setRerunDone(false)
    expect(seg).toMatch(/if \(staleCount === 0\) setRerunDone\(false\)/);
    // 必须依赖 staleCount,否则 effect 不重跑、复位失效
    expect(seg).toMatch(/\}, \[staleCount\]\)/);
  });

  it('禁止用定长延时复位(跑完耗时不可预测,必然过早或过晚)', () => {
    const seg = rerunSeg(readPage());
    // rerunDone 的复位不得依赖 setTimeout / 延时
    const resetBlock = seg.slice(seg.indexOf('复位「重跑已排队」'));
    expect(resetBlock).not.toMatch(/setTimeout[\s\S]{0,80}setRerunDone/);
  });

  it('staleCount 是 nodes 派生值,且 Toolbar 消费同一份(不得再从 ref 各算一遍)', () => {
    const src = readPage();
    // 定义处:useMemo 依赖 nodes
    expect(src).toMatch(/const staleCount = useMemo\([\s\S]{0,120}\[nodes\],?\s*\)/);
    // 消费处:直接传 staleCount,不能再出现 nodesRef.current.filter(...).length 的内联计数
    expect(src).toMatch(/staleCount=\{staleCount\}/);
    expect(src).not.toMatch(/staleCount=\{nodesRef\.current\.filter/);
  });

  it('rerunAffected 在无受影响节点时不得置 rerunDone(避免空跑后置灰)', () => {
    const seg = rerunSeg(readPage());
    const fnStart = seg.indexOf('const rerunAffected');
    const fn = seg.slice(fnStart);
    // 早返回分支在 setRerunDone(true) **之前**,即空集合不置 done
    const earlyReturn = fn.indexOf('没有 stale 节点需要重跑');
    const setDone = fn.indexOf('setRerunDone(true)');
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(setDone).toBeGreaterThan(earlyReturn);
  });
});
