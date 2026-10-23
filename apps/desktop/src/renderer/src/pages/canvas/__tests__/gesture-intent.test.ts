/**
 * 触控手势意图判定(2026-10,M5 里程碑的第一块砖)
 *
 * 规格来源:docs/网页远程访问-改造方案.md §11.2(判定表)、§11.7(用例清单与风险)。
 * 本文件只测**判定**,不测执行(执行侧要直写 DOM,起不了浏览器)。
 *
 * 三条必须钉住的不变量:
 *   ① **桌面手感一个字都不能改**:非 touch 一律 'desktop'(§11.7 风险 1)。
 *      2026-10 刚把「拖空白平移」拿掉,判定写错就会让它悄悄回来。
 *   ② **触控与鼠标是两套阈值**:触控 8px、鼠标 3px(§11.7 风险 2)。
 *      手指抖动会瞬间超过 3px,沿用鼠标阈值会让长按菜单几乎弹不出来。
 *   ③ **两指永远是捏合**:绝不能是 pan —— 双指缩放顺带平移画布是 iPad 上最典型的
 *      「手势打架」,必须用单测钉死。
 */
import { describe, it, expect } from 'vitest';
import {
  classifyGesture,
  classifyGestureUp,
  shouldArmLongPress,
  isTouchPointer,
  dragThresholdFor,
  LONG_PRESS_MS,
  LONG_PRESS_MOVE_TOLERANCE_PX,
  TOUCH_DRAG_THRESHOLD_PX,
  MOUSE_DRAG_THRESHOLD_PX,
  CONNECT_THRESHOLD_PX,
  type GestureIntentInput,
} from '../gesture-intent';

/** 触控输入的缺省值:单指、没按住、没动、点在空白上、拖动阈值用触控那套 8px */
function touchInput(overrides: Partial<GestureIntentInput> = {}): GestureIntentInput {
  return {
    pointerType: 'touch',
    touchCount: 1,
    holdMs: 0,
    dist: 0,
    hit: 'stage',
    longPressArmed: false,
    dragThresholdPx: TOUCH_DRAG_THRESHOLD_PX,
    ...overrides,
  };
}

/** 鼠标输入的缺省值:阈值用桌面那套 3px */
function mouseInput(overrides: Partial<GestureIntentInput> = {}): GestureIntentInput {
  return {
    pointerType: 'mouse',
    touchCount: 0,
    holdMs: 0,
    dist: 0,
    hit: 'stage',
    longPressArmed: false,
    dragThresholdPx: MOUSE_DRAG_THRESHOLD_PX,
    ...overrides,
  };
}

describe('classifyGesture — 桌面分支:鼠标手感一个字都不能改', () => {
  it('鼠标在空白处拖动 → desktop(调用方因此不会改去平移)', () => {
    // 关键:桌面「左键拖空白」既不是平移也不是框选(框选要顶栏先开模式)
    expect(classifyGesture(mouseInput({ dist: 100 }))).toBe('desktop');
  });

  it('鼠标在节点上拖动、在「+」上拖动 → 一律 desktop', () => {
    expect(classifyGesture(mouseInput({ hit: 'node', dist: 100 }))).toBe('desktop');
    expect(classifyGesture(mouseInput({ hit: 'node-add', dist: 100 }))).toBe('desktop');
  });

  it('笔(stylus)也算桌面:笔的精度接近鼠标,走触控会丢掉右键/框选语义', () => {
    expect(classifyGesture(mouseInput({ pointerType: 'pen', dist: 100 }))).toBe('desktop');
  });

  it('鼠标即使传来 armed=true 也还是 desktop(锁存只在触控路径产生)', () => {
    expect(
      classifyGesture(mouseInput({ longPressArmed: true, dist: 0, hit: 'stage' })),
    ).toBe('desktop');
  });
});

describe('classifyGesture — 触控空白:平移 vs 长按框选', () => {
  it('单指空白移动 10px(阈值 8)→ pan', () => {
    expect(classifyGesture(touchInput({ dist: 10 }))).toBe('pan');
  });

  it('移动不足阈值(6px)且未到长按 → desktop(短按空白与鼠标一致,什么都不做)', () => {
    expect(classifyGesture(touchInput({ dist: 6 }))).toBe('desktop');
  });

  it('按下 500ms 内移动 20px → pan,且长按判定同时被取消', () => {
    const input = touchInput({ holdMs: 300, dist: 20 });
    expect(classifyGesture(input)).toBe('pan');
    // 长按被取消:调用方保持 armed = false,这次手势就只是平移
    expect(shouldArmLongPress(input)).toBe(false);
  });

  it('长按成立(armed)后再拖动 → marquee(框选)', () => {
    expect(
      classifyGesture(touchInput({ longPressArmed: true, holdMs: 600, dist: 30 })),
    ).toBe('marquee');
  });

  it('长按已成立但还没拖动 → hold(等抬手,此时什么都不做)', () => {
    expect(
      classifyGesture(touchInput({ longPressArmed: true, holdMs: 600, dist: 2 })),
    ).toBe('hold');
  });

  it('未长按也未超阈值 → desktop', () => {
    expect(classifyGesture(touchInput({ holdMs: 100, dist: 0 }))).toBe('desktop');
  });

  it('位移正好等于阈值(8px)不算拖动(阈值是严格大于)', () => {
    expect(classifyGesture(touchInput({ dist: TOUCH_DRAG_THRESHOLD_PX }))).toBe('desktop');
    expect(classifyGesture(touchInput({ dist: TOUCH_DRAG_THRESHOLD_PX + 0.5 }))).toBe('pan');
  });
});

describe('classifyGesture — 多指:永远是捏合', () => {
  it('两指 → pinch', () => {
    expect(classifyGesture(touchInput({ touchCount: 2 }))).toBe('pinch');
  });

  it('两指时无论命中哪里、位移多大,都绝不是 pan', () => {
    for (const hit of ['stage', 'node', 'node-add'] as const) {
      for (const dist of [0, 5, 20, 200]) {
        const intent = classifyGesture(touchInput({ touchCount: 2, hit, dist }));
        expect(intent).toBe('pinch');
        expect(intent).not.toBe('pan');
      }
    }
  });

  it('两指 + 长按已成立 → 仍然是 pinch(捏合优先)', () => {
    expect(
      classifyGesture(touchInput({ touchCount: 2, longPressArmed: true, dist: 40 })),
    ).toBe('pinch');
  });
});

describe('classifyGesture — 节点:拖动优先于菜单', () => {
  it('节点上触控移动超过阈值(10px > 8px)→ drag-node', () => {
    expect(classifyGesture(touchInput({ hit: 'node', dist: 10 }))).toBe('drag-node');
  });

  it('节点上移动超过阈值时绝不返回 context-menu(长按菜单不能压在拖动上)', () => {
    const intent = classifyGesture(touchInput({ hit: 'node', dist: 10 }));
    expect(intent).not.toBe('context-menu');
  });

  it('节点上长按(armed)且未过拖动阈值 → context-menu', () => {
    expect(
      classifyGesture(touchInput({ hit: 'node', longPressArmed: true, holdMs: 600, dist: 3 })),
    ).toBe('context-menu');
  });

  it('节点上长按(armed)但已经在拖 → drag-node(长按期间已经在拖就不再升级成菜单)', () => {
    const intent = classifyGesture(
      touchInput({ hit: 'node', longPressArmed: true, holdMs: 900, dist: 12 }),
    );
    expect(intent).toBe('drag-node');
    expect(intent).not.toBe('context-menu');
  });

  it('节点上短按(未长按、未超阈值)→ desktop(走现有点选)', () => {
    expect(classifyGesture(touchInput({ hit: 'node', holdMs: 120, dist: 2 }))).toBe('desktop');
  });

  it('触控在节点上移动 3px 不算拖动(触控阈值是 8px,不是鼠标的 3px)', () => {
    // §11.7 风险 2:3px 的鼠标阈值放在手指上会被抖动瞬间触发
    expect(classifyGesture(touchInput({ hit: 'node', dist: 3 }))).toBe('desktop');
  });
});

describe('classifyGesture — 「+」:拖出连线 vs 短按弹层', () => {
  it('「+」上移动超过 4px → connect', () => {
    expect(classifyGesture(touchInput({ hit: 'node-add', dist: 5 }))).toBe('connect');
  });

  it('「+」上不足 4px → desktop(短按 → 走现有 click 弹层路径)', () => {
    expect(classifyGesture(touchInput({ hit: 'node-add', dist: 3 }))).toBe('desktop');
  });

  it('连线阈值与现有实现一致:严格大于 4px(现有 connectDrag 是 `Math.hypot(dx, dy) > 4`)', () => {
    expect(CONNECT_THRESHOLD_PX).toBe(4);
    expect(classifyGesture(touchInput({ hit: 'node-add', dist: 4 }))).toBe('desktop');
    expect(classifyGesture(touchInput({ hit: 'node-add', dist: 4.5 }))).toBe('connect');
  });

  it('调用方可以显式覆盖连线阈值(缺省仍是 4px)', () => {
    expect(classifyGesture(touchInput({ hit: 'node-add', dist: 6 }))).toBe('connect');
    expect(
      classifyGesture(touchInput({ hit: 'node-add', dist: 6, connectThresholdPx: 10 })),
    ).toBe('desktop');
  });

  it('「+」上即使长按已成立,也不弹菜单(「+」只认连线/短按两条语义)', () => {
    expect(
      classifyGesture(touchInput({ hit: 'node-add', longPressArmed: true, dist: 1 })),
    ).toBe('desktop');
  });
});

describe('classifyGesture — 已有控件不接管', () => {
  it('命中 control → desktop(按钮/缩放条自己有点击语义,手势层不抢)', () => {
    expect(classifyGesture(touchInput({ hit: 'control', dist: 50 }))).toBe('desktop');
    expect(
      classifyGesture(touchInput({ hit: 'control', longPressArmed: true, dist: 50 })),
    ).toBe('desktop');
  });
});

describe('classifyGestureUp — 抬手判定', () => {
  it('空白长按后没拖动就抬起 → clear-selection(与空白右键同语义)', () => {
    expect(
      classifyGestureUp(touchInput({ longPressArmed: true, holdMs: 600, dist: 2 })),
    ).toBe('clear-selection');
  });

  it('节点长按后抬起 → context-menu', () => {
    expect(
      classifyGestureUp(touchInput({ hit: 'node', longPressArmed: true, holdMs: 600, dist: 2 })),
    ).toBe('context-menu');
  });

  it('抬手时已经拖过了 → desktop(收尾归执行侧,不在抬手再弹一次菜单)', () => {
    expect(
      classifyGestureUp(touchInput({ longPressArmed: true, holdMs: 900, dist: 30 })),
    ).toBe('desktop');
    expect(
      classifyGestureUp(
        touchInput({ hit: 'node', longPressArmed: true, holdMs: 900, dist: 30 }),
      ),
    ).toBe('desktop');
  });

  it('没长按就抬起 → desktop(普通点击/平移结束)', () => {
    expect(classifyGestureUp(touchInput({ holdMs: 100, dist: 1 }))).toBe('desktop');
    expect(classifyGestureUp(touchInput({ hit: 'node', holdMs: 100, dist: 1 }))).toBe('desktop');
  });

  it('鼠标抬手 → desktop(桌面路径不产生抬手意图)', () => {
    expect(classifyGestureUp(mouseInput({ longPressArmed: true, dist: 0 }))).toBe('desktop');
  });

  it('两指抬起 → desktop(松手结束捏合,不误清选区)', () => {
    expect(
      classifyGestureUp(touchInput({ touchCount: 2, longPressArmed: true, dist: 0 })),
    ).toBe('desktop');
  });

  it('「+」抬起 → desktop(短按弹层由现有 click 路径处理)', () => {
    expect(
      classifyGestureUp(touchInput({ hit: 'node-add', longPressArmed: true, dist: 0 })),
    ).toBe('desktop');
  });

  it('move 阶段与 up 阶段都会给出 context-menu,但语义不同(即时反馈 vs 抬手确认)', () => {
    const input = touchInput({ hit: 'node', longPressArmed: true, holdMs: 600, dist: 2 });
    expect(classifyGesture(input)).toBe('context-menu');
    expect(classifyGestureUp(input)).toBe('context-menu');
  });
});

describe('shouldArmLongPress — 长按成立判定', () => {
  it('触控 + 空白 + 500ms + 0px → true(成立)', () => {
    expect(
      shouldArmLongPress({
        pointerType: 'touch',
        touchCount: 1,
        holdMs: LONG_PRESS_MS,
        dist: 0,
        hit: 'stage',
      }),
    ).toBe(true);
  });

  it('499ms → false(还没到时长)', () => {
    expect(
      shouldArmLongPress({
        pointerType: 'touch',
        touchCount: 1,
        holdMs: LONG_PRESS_MS - 1,
        dist: 0,
        hit: 'stage',
      }),
    ).toBe(false);
  });

  it('位移 9px → false(超过 8px 抖动容差,长按被取消)', () => {
    expect(
      shouldArmLongPress({
        pointerType: 'touch',
        touchCount: 1,
        holdMs: LONG_PRESS_MS,
        dist: 9,
        hit: 'stage',
      }),
    ).toBe(false);
  });

  it('鼠标 → false(长按是触控独有的交互)', () => {
    expect(
      shouldArmLongPress({
        pointerType: 'mouse',
        touchCount: 0,
        holdMs: LONG_PRESS_MS,
        dist: 0,
        hit: 'stage',
      }),
    ).toBe(false);
  });

  it('节点上长按也成立(节点长按 → 菜单)', () => {
    expect(
      shouldArmLongPress({
        pointerType: 'touch',
        touchCount: 1,
        holdMs: LONG_PRESS_MS,
        dist: 0,
        hit: 'node',
      }),
    ).toBe(true);
  });

  it('两指不成立(那是捏合)', () => {
    expect(
      shouldArmLongPress({
        pointerType: 'touch',
        touchCount: 2,
        holdMs: LONG_PRESS_MS,
        dist: 0,
        hit: 'stage',
      }),
    ).toBe(false);
  });

  it('「+」与已有控件不成立(它们有自己的点击语义,长按会抢点击)', () => {
    expect(
      shouldArmLongPress({
        pointerType: 'touch',
        touchCount: 1,
        holdMs: LONG_PRESS_MS,
        dist: 0,
        hit: 'node-add',
      }),
    ).toBe(false);
    expect(
      shouldArmLongPress({
        pointerType: 'touch',
        touchCount: 1,
        holdMs: LONG_PRESS_MS,
        dist: 0,
        hit: 'control',
      }),
    ).toBe(false);
  });

  it('位移正好 8px 仍成立(容差是小于等于)', () => {
    expect(
      shouldArmLongPress({
        pointerType: 'touch',
        touchCount: 1,
        holdMs: LONG_PRESS_MS,
        dist: LONG_PRESS_MOVE_TOLERANCE_PX,
        hit: 'stage',
      }),
    ).toBe(true);
  });

  it('可以直接传完整的 GestureIntentInput(结构兼容)', () => {
    expect(shouldArmLongPress(touchInput({ holdMs: LONG_PRESS_MS, dist: 0 }))).toBe(true);
  });
});

describe('阈值常量与便利函数', () => {
  it('dragThresholdFor:触控 8px、鼠标 3px', () => {
    expect(dragThresholdFor('touch')).toBe(8);
    expect(dragThresholdFor('mouse')).toBe(3);
  });

  it('dragThresholdFor:笔与其它指针类型沿用鼠标阈值(桌面手感不变)', () => {
    expect(dragThresholdFor('pen')).toBe(3);
    expect(dragThresholdFor('')).toBe(3);
  });

  it('常量数值与规格一致', () => {
    expect(LONG_PRESS_MS).toBe(500);
    expect(LONG_PRESS_MOVE_TOLERANCE_PX).toBe(8);
    expect(TOUCH_DRAG_THRESHOLD_PX).toBe(8);
    expect(MOUSE_DRAG_THRESHOLD_PX).toBe(3);
    expect(CONNECT_THRESHOLD_PX).toBe(4);
  });

  it('触控阈值与长按容差同值(8px):「长按后拖动」和「算不算拖动」是同一条线', () => {
    expect(TOUCH_DRAG_THRESHOLD_PX).toBe(LONG_PRESS_MOVE_TOLERANCE_PX);
  });

  it('isTouchPointer 只认 touch', () => {
    expect(isTouchPointer('touch')).toBe(true);
    expect(isTouchPointer('mouse')).toBe(false);
    expect(isTouchPointer('pen')).toBe(false);
  });

  it('拖动阈值由参数决定:传 3px 时 4px 就算拖动了(接线方选错阈值会被看到)', () => {
    // 锁的是「判定只认传进来的阈值」,不是把 8px 写死在函数里
    expect(classifyGesture(touchInput({ dist: 4, dragThresholdPx: 3 }))).toBe('pan');
    expect(classifyGesture(touchInput({ dist: 4, dragThresholdPx: 8 }))).toBe('desktop');
  });
});

describe('纯函数性质', () => {
  it('同一份输入重复判定结果一致(无副作用、无隐藏状态)', () => {
    const input = touchInput({ hit: 'node', longPressArmed: true, holdMs: 600, dist: 3 });
    expect(classifyGesture(input)).toBe(classifyGesture(input));
    expect(classifyGestureUp(input)).toBe(classifyGestureUp(input));
  });

  it('判定不修改传入对象(调用方可以把同一份输入喂给多个判定函数)', () => {
    const input = touchInput({ hit: 'stage', dist: 30 });
    const snapshot = { ...input };
    classifyGesture(input);
    classifyGestureUp(input);
    shouldArmLongPress(input);
    expect(input).toEqual(snapshot);
  });

  it('位移算不出来(NaN)时保守处理:当作「已经在动」,不弹菜单也不 arm 长按', () => {
    // NaN > 8 恒为 false;若不归一化,一次真实拖动会被判成「没动」,长按菜单会在拖动中弹出
    expect(classifyGesture(touchInput({ hit: 'node', dist: NaN }))).toBe('drag-node');
    expect(classifyGesture(touchInput({ hit: 'stage', dist: NaN }))).toBe('pan');
    expect(
      shouldArmLongPress({
        pointerType: 'touch',
        touchCount: 1,
        holdMs: LONG_PRESS_MS,
        dist: NaN,
        hit: 'stage',
      }),
    ).toBe(false);
  });
});
