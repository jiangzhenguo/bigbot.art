/**
 * pinch 测试 — 触屏捏合与双击的判定逻辑(纯函数 + 手势状态机)
 *
 * 覆盖三组:①几何(间距/中点/倍率);②双击判定(间隔与位移阈值);
 * ③手势状态机(单指 → 双指 → 抬起一指 → 全部抬起)。
 *
 * ③里最要紧的一条是「**捏合中抬起一指,剩下的那指不能突然开始平移**」——
 * 那会让画面在捏合结束的瞬间跳一下,是触屏缩放最容易踩的坑。
 *
 * 约定:坐标单位一律 px;time 单位 ms。
 */
import { describe, it, expect } from 'vitest';
import {
  DOUBLE_TAP_MAX_DIST,
  DOUBLE_TAP_MAX_MS,
  GestureTracker,
  PINCH_MIN_DISTANCE,
  TAP_MAX_DRIFT,
  isDoubleTap,
  pinchRatio,
  pointDistance,
  pointMidpoint,
  type PointerInput,
} from '../lib/pinch.js';
import { IDENTITY_VIEW, type ZoomView } from '../lib/image-zoom.js';

/** 造一个指针事件 */
const ptr = (id: number, x: number, y: number, kind = 'touch', time = 0): PointerInput => ({
  id,
  x,
  y,
  kind,
  time,
});

describe('pointDistance / pointMidpoint', () => {
  it('间距是欧氏距离', () => {
    expect(pointDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(pointDistance({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(0);
  });

  it('中点是两点的平均(捏合锚点)', () => {
    expect(pointMidpoint({ x: 0, y: 0 }, { x: 100, y: 50 })).toEqual({ x: 50, y: 25 });
    // 两指对称时中点就是它们的正中间
    expect(pointMidpoint({ x: -40, y: 0 }, { x: 40, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe('pinchRatio', () => {
  it('倍率 = 当前间距 / 起始间距', () => {
    expect(pinchRatio(100, 200)).toBeCloseTo(2, 9);
    expect(pinchRatio(200, 100)).toBeCloseTo(0.5, 9);
    expect(pinchRatio(100, 100)).toBeCloseTo(1, 9);
  });

  it('起始间距过小(接近除零)时退化为 1,不产生噪声倍率', () => {
    expect(pinchRatio(0, 100)).toBe(1);
    expect(pinchRatio(1, 100)).toBe(1);
    expect(pinchRatio(PINCH_MIN_DISTANCE, 100)).toBeCloseTo(100 / PINCH_MIN_DISTANCE, 9);
  });

  it('非法输入退化为 1(绝不返回 NaN 把视图带飞)', () => {
    expect(pinchRatio(Number.NaN, 100)).toBe(1);
    expect(pinchRatio(100, Number.NaN)).toBe(1);
    expect(pinchRatio(Number.POSITIVE_INFINITY, 100)).toBe(1);
    expect(pinchRatio(100, Number.NEGATIVE_INFINITY)).toBe(1);
  });

  it('两指完全重合(间距 0)→ 倍率 0(缩到最小,由 zoomAtPoint 钳制)', () => {
    expect(pinchRatio(100, 0)).toBe(0);
  });
});

describe('isDoubleTap', () => {
  const base = { x: 100, y: 200, time: 1000 };

  it('没有前一次按压 → 不是双击', () => {
    expect(isDoubleTap(null, base)).toBe(false);
  });

  it('间隔与位移都在阈值内 → 是双击', () => {
    const prev = { x: 100, y: 200, time: 1000 };
    expect(isDoubleTap(prev, { x: 105, y: 206, time: 1150 })).toBe(true);
  });

  it('间隔超过阈值 → 不是双击(阈值 300ms,判定用严格小于)', () => {
    const prev = { x: 100, y: 200, time: 1000 };
    expect(isDoubleTap(prev, { x: 100, y: 200, time: 1000 + DOUBLE_TAP_MAX_MS })).toBe(false);
    expect(isDoubleTap(prev, { x: 100, y: 200, time: 1000 + DOUBLE_TAP_MAX_MS + 1 })).toBe(false);
    // 刚好卡在阈值内
    expect(isDoubleTap(prev, { x: 100, y: 200, time: 1000 + DOUBLE_TAP_MAX_MS - 1 })).toBe(true);
  });

  it('位移超过阈值 → 不是双击(阈值 30px,判定用严格小于)', () => {
    const prev = { x: 100, y: 200, time: 1000 };
    expect(isDoubleTap(prev, { x: 100 + DOUBLE_TAP_MAX_DIST, y: 200, time: 1100 })).toBe(false);
    expect(isDoubleTap(prev, { x: 100 + DOUBLE_TAP_MAX_DIST + 1, y: 200, time: 1100 })).toBe(false);
    expect(isDoubleTap(prev, { x: 100 + DOUBLE_TAP_MAX_DIST - 1, y: 200, time: 1100 })).toBe(true);
  });

  it('时间倒流(时钟被改 / 时间戳异常)不算双击', () => {
    expect(isDoubleTap({ x: 0, y: 0, time: 2000 }, { x: 0, y: 0, time: 1000 })).toBe(false);
  });
});

describe('GestureTracker — 单指与双指', () => {
  it('一根手指按下 → single 模式', () => {
    const t = new GestureTracker();
    const r = t.down(ptr(1, 100, 100), IDENTITY_VIEW);
    expect(r.mode).toBe('single');
    expect(r.pinchStarted).toBe(false);
    expect(r.doubleTap).toBe(false);
    expect(t.count).toBe(1);
  });

  it('第二指落下 → 进入 pinch,并锁定起始间距与起始视图', () => {
    const t = new GestureTracker();
    const view: ZoomView = { zoom: 2, tx: 0.1, ty: -0.2 };
    t.down(ptr(1, 100, 100), IDENTITY_VIEW);
    const r = t.down(ptr(2, 300, 100), view);
    expect(r.mode).toBe('pinch');
    expect(r.pinchStarted).toBe(true);
    expect(t.pinch).not.toBeNull();
    expect(t.pinch?.startDistance).toBeCloseTo(200, 9);
    expect(t.pinch?.startZoom).toBe(2);
    expect(t.pinch?.startView).toEqual(view);
  });

  it('currentPair 给出当前间距与中点(捏合锚点)', () => {
    const t = new GestureTracker();
    t.down(ptr(1, 100, 100), IDENTITY_VIEW);
    t.down(ptr(2, 300, 100), IDENTITY_VIEW);
    const pair = t.currentPair();
    expect(pair).not.toBeNull();
    expect(pair?.distance).toBeCloseTo(200, 9);
    expect(pair?.mid).toEqual({ x: 200, y: 100 });
    // 手指移动后,间距与中点跟着变
    t.move(ptr(2, 500, 100));
    const pair2 = t.currentPair();
    expect(pair2?.distance).toBeCloseTo(400, 9);
    expect(pair2?.mid).toEqual({ x: 300, y: 100 });
  });

  it('第三指被忽略(捏合只认一对)', () => {
    const t = new GestureTracker();
    t.down(ptr(1, 100, 100), IDENTITY_VIEW);
    t.down(ptr(2, 300, 100), IDENTITY_VIEW);
    const r = t.down(ptr(3, 500, 500), IDENTITY_VIEW);
    expect(r.pinchStarted).toBe(false);
    expect(t.count).toBe(2);
    // 基准不被第三指搅乱
    expect(t.pinch?.startDistance).toBeCloseTo(200, 9);
  });
});

describe('GestureTracker — 抬起一指后不跳(核心约束)', () => {
  it('捏合中抬起一指:模式仍是 pinch(冻结),剩下那指不会突然开始平移', () => {
    const t = new GestureTracker();
    t.down(ptr(1, 100, 100), IDENTITY_VIEW);
    t.down(ptr(2, 300, 100), IDENTITY_VIEW);
    const up = t.up(2);
    expect(up.ended).toBe(false);
    expect(up.pinched).toBe(true);
    // ⚠️ 关键:不能退回 single —— 那样剩下那指的移动会从「捏合结束的位置」直接当平移
    expect(t.mode).toBe('pinch');
    // 剩下的那指只剩一根 → 没有成对的指针 → 捏合算不出间距,自然不会动
    expect(t.currentPair()).toBeNull();
    // 再抬起另一指 → 手势才结束
    const up2 = t.up(1);
    expect(up2.ended).toBe(true);
    expect(t.mode).toBe('idle');
  });

  it('捏合中抬起的是第一指:同样冻结,不退回 single', () => {
    const t = new GestureTracker();
    t.down(ptr(1, 100, 100), IDENTITY_VIEW);
    t.down(ptr(2, 300, 100), IDENTITY_VIEW);
    t.up(1);
    expect(t.mode).toBe('pinch');
    expect(t.currentPair()).toBeNull();
  });

  it('单指手势:抬起即结束', () => {
    const t = new GestureTracker();
    t.down(ptr(1, 100, 100), IDENTITY_VIEW);
    const up = t.up(1);
    expect(up.ended).toBe(true);
    expect(up.wasTap).toBe(true);
    expect(up.pinched).toBe(false);
    expect(t.mode).toBe('idle');
  });

  it('reset 清空全部状态(换图时用)', () => {
    const t = new GestureTracker();
    t.down(ptr(1, 100, 100), IDENTITY_VIEW);
    t.down(ptr(2, 300, 100), IDENTITY_VIEW);
    t.reset();
    expect(t.count).toBe(0);
    expect(t.mode).toBe('idle');
    expect(t.pinch).toBeNull();
  });
});

describe('GestureTracker — 触屏双击判定', () => {
  it('两次 touch 按下:间隔与位移都在阈值内 → 第二次判为双击', () => {
    const t = new GestureTracker();
    const first = t.down(ptr(1, 100, 200, 'touch', 1000), IDENTITY_VIEW);
    expect(first.doubleTap).toBe(false);
    t.up(1);
    const second = t.down(ptr(2, 108, 206, 'touch', 1200), IDENTITY_VIEW);
    expect(second.doubleTap).toBe(true);
  });

  it('间隔太长 → 不是双击', () => {
    const t = new GestureTracker();
    t.down(ptr(1, 100, 200, 'touch', 1000), IDENTITY_VIEW);
    t.up(1);
    const second = t.down(ptr(2, 100, 200, 'touch', 1000 + DOUBLE_TAP_MAX_MS + 50), IDENTITY_VIEW);
    expect(second.doubleTap).toBe(false);
  });

  it('落点差太远 → 不是双击', () => {
    const t = new GestureTracker();
    t.down(ptr(1, 100, 200, 'touch', 1000), IDENTITY_VIEW);
    t.up(1);
    const second = t.down(ptr(2, 100 + DOUBLE_TAP_MAX_DIST + 20, 200, 'touch', 1100), IDENTITY_VIEW);
    expect(second.doubleTap).toBe(false);
  });

  it('鼠标不参与这套判定(桌面双击走浏览器原生 dblclick)', () => {
    const t = new GestureTracker();
    t.down(ptr(1, 100, 200, 'mouse', 1000), IDENTITY_VIEW);
    t.up(1);
    const second = t.down(ptr(2, 100, 200, 'mouse', 1100), IDENTITY_VIEW);
    expect(second.doubleTap).toBe(false);
  });

  it('前一次是拖动(位移超阈值)→ 不能作为双击的前半段', () => {
    const t = new GestureTracker();
    t.down(ptr(1, 100, 200, 'touch', 1000), IDENTITY_VIEW);
    // 拖动:手指从按下点移开了
    t.move(ptr(1, 100 + TAP_MAX_DRIFT + 5, 200));
    const up = t.up(1);
    expect(up.wasTap).toBe(false);
    const second = t.down(ptr(2, 100, 200, 'touch', 1100), IDENTITY_VIEW);
    expect(second.doubleTap).toBe(false);
  });

  it('捏合打断双击候选(捏过之后的第一下不算双击)', () => {
    const t = new GestureTracker();
    t.down(ptr(1, 100, 200, 'touch', 1000), IDENTITY_VIEW);
    t.up(1);
    t.down(ptr(1, 100, 200, 'touch', 1100), IDENTITY_VIEW);
    t.down(ptr(2, 300, 200, 'touch', 1150), IDENTITY_VIEW); // → pinch
    t.up(1);
    t.up(2);
    const third = t.down(ptr(3, 100, 200, 'touch', 1200), IDENTITY_VIEW);
    expect(third.doubleTap).toBe(false);
  });

  it('一次双击只认一次:第三下不会被当成新的双击', () => {
    const t = new GestureTracker();
    t.down(ptr(1, 100, 200, 'touch', 1000), IDENTITY_VIEW);
    t.up(1);
    expect(t.down(ptr(2, 100, 200, 'touch', 1100), IDENTITY_VIEW).doubleTap).toBe(true);
    t.up(2);
    expect(t.down(ptr(3, 100, 200, 'touch', 1200), IDENTITY_VIEW).doubleTap).toBe(false);
  });
});

describe('GestureTracker — wasTap(点击 vs 拖动)', () => {
  it('几乎没动 → 是点击', () => {
    const t = new GestureTracker();
    t.down(ptr(1, 100, 200, 'touch', 0), IDENTITY_VIEW);
    t.move(ptr(1, 102, 201));
    expect(t.up(1).wasTap).toBe(true);
  });

  it('拖过了 → 不是点击(不该触发「点空白关闭」)', () => {
    const t = new GestureTracker();
    t.down(ptr(1, 100, 200, 'touch', 0), IDENTITY_VIEW);
    t.move(ptr(1, 100 + TAP_MAX_DRIFT + 1, 200));
    expect(t.up(1).wasTap).toBe(false);
  });
});
