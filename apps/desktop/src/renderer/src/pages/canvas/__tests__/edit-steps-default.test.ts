/**
 * 图片编辑默认步数一致性单测 —— 「界面显示几步 = 实际跑几步」。
 *
 * 事故背景(2026-09-29,真实):
 *   用户反馈「图片编辑不改 step 直接就是 40 步」。根因是**两套默认值互相不认识**:
 *     - 检查器 `ImageEditInspector` 的默认步数 **只作滑块初始展示、不写回 data**
 *       (旧注释原话:「仅作滑块初始值展示——不写回 data」,值为 4)
 *     - provider `mlxgen.ts` 的 2.1 参考编辑分支硬兜底 `p.steps ?? 40`
 *   于是提交参数里压根没有 `steps` 键(实测 take 存档确认),实跑 40 步而界面显示 4 ——
 *   2.1 bf16 上 40 步约 4 分钟,是 6 步版(54-92s)的 6-7 倍耗时,且用户无从察觉。
 *
 * 修法(A 方案,用户指定):检查器默认改 30 并**显式写回 data**;provider 兜底同步改 30,
 * 降级为「历史节点 / Agent 直传」的安全网,不再是一套隐藏默认值。
 *
 * ⚠️ 两个常量分处不同包(renderer 不能 import providers —— 包边界,与
 * `soundtrack-duration.test.ts` 锁 MIN_SOUNDTRACK_SECONDS 同一手法),
 * 所以 provider 那侧用**读源码文本**的方式锁:改一处忘了另一处会立刻红。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DEFAULT_EDIT_STEPS } from '../inspector/ImageEditInspector';

// __tests__ → canvas → pages → src → renderer → src → desktop → apps → 仓库根(上溯 8 层)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../../..');

const providerSrc = readFileSync(resolve(root, 'packages/providers/src/mlxgen.ts'), 'utf-8');
const inspectorSrc = readFileSync(
  resolve(root, 'apps/desktop/src/renderer/src/pages/canvas/inspector/ImageEditInspector.tsx'),
  'utf-8',
);

/** 从 provider 源码取参考编辑分支的 `p.steps ?? N` 兜底值 */
function providerEditFallbackSteps(): number {
  const m = /cmd\.push\('--steps', String\(Number\(p\.steps \?\? (\d+)\)\)\);/.exec(providerSrc);
  expect(m, 'mlxgen.ts 里找不到参考编辑分支的 steps 兜底').toBeTruthy();
  return Number(m![1]);
}

describe('图片编辑默认步数:检查器与 provider 必须同口径', () => {
  it('默认值为 30(用户 2026-09-29 指定;不再是 4 或 40)', () => {
    expect(DEFAULT_EDIT_STEPS).toBe(30);
  });

  it('provider 兜底值与检查器相等(改一处忘另一处 → 立刻红)', () => {
    expect(providerEditFallbackSteps()).toBe(DEFAULT_EDIT_STEPS);
  });

  it('检查器必须把默认步数**写回 data**(否则又回到「显示值 ≠ 提交值」的事故)', () => {
    // A 方案的关键:未设置时写回 DEFAULT_EDIT_STEPS(经 setDataRef 调用,见下一条)
    expect(inspectorSrc).toMatch(/setDataRef\.current\(\{\s*steps:\s*DEFAULT_EDIT_STEPS\s*\}\)/);
  });

  it('补写 steps 的 effect 依赖必须稳定(nodeId only)—— 否则无限重渲染', () => {
    /* 事故(2026-09-29,真实):初版 effect 依赖写成 [hasExplicitSteps, setData]。
       InspectorBody 的 setData 是**内联定义、每渲染换新引用**,而写入 steps 后 props 里的
       d.steps 要下一轮渲染才更新(本轮 hasExplicitSteps 仍是 false)→
       「写入 → 重渲染 → 依赖变化 → 再写入」自我维持,直接打爆
       React `Maximum update depth exceeded`(实测日志刷屏 672 条),最终 App 被 SIGTERM。
       修法:依赖只放 node.id,setData / hasExplicitSteps 经 ref 读取。
       本用例锁死这个形状 —— 谁把依赖改回去,立刻红。 */
    const effect = /useEffect\(\(\) => \{[\s\S]*?setDataRef\.current\(\{\s*steps:\s*DEFAULT_EDIT_STEPS\s*\}\);[\s\S]*?\}, \[([^\]]*)\]\)/.exec(
      inspectorSrc,
    );
    expect(effect, '找不到补写 steps 的 effect').toBeTruthy();
    expect(effect![1]).toBe('nodeId');
    // 且不得把不稳定引用放进依赖
    expect(effect![1]).not.toContain('setData');
    expect(effect![1]).not.toContain('hasExplicitSteps');
    // 必须经 ref 调用 setData(而非直接用 props.setData)
    expect(inspectorSrc).toMatch(/const setDataRef = useRef\(setData\)/);
  });

  it('滑块区间覆盖默认值(否则默认值落在区间外,浏览器会钳制到边界)', () => {
    const min = Number(/type="range"\s*\n\s*min=\{(\d+)\}/.exec(inspectorSrc)?.[1] ?? NaN);
    const max = Number(/type="range"\s*\n\s*min=\{\d+\}\s*\n\s*max=\{(\d+)\}/.exec(inspectorSrc)?.[1] ?? NaN);
    expect(Number.isFinite(min) && Number.isFinite(max)).toBe(true);
    expect(DEFAULT_EDIT_STEPS).toBeGreaterThanOrEqual(min);
    expect(DEFAULT_EDIT_STEPS).toBeLessThanOrEqual(max);
  });
});
