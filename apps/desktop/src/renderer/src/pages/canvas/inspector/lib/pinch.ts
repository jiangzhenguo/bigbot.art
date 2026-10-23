/**
 * pinch — 触屏手势的判定逻辑(纯逻辑,无 React / DOM 依赖)
 *
 * 为什么要单独成文件:触屏缩放里最容易互相打架的是「单指平移」与「双指捏合」
 * 共存 —— 尤其**抬起一根手指后剩下那根突然开始平移**(画面会跳一下)。
 * 这类规则光靠肉眼看代码很难确认,故按 `lib/image-zoom.ts` 的同样做法抽成纯模块,
 * 用单测锁住,见 `__tests__/pinch.test.ts`。
 *
 * ⚠️ 缩放数学不在这里:倍率/锚点/钳制一律复用 `lib/image-zoom.ts` 的
 * `zoomAtPoint` / `zoomByFactor` / `clampPanView`,这里只回答「现在算什么手势」。
 */
import type { ZoomView } from './image-zoom';

/** 指针位置(client 坐标) */
export interface PointerPoint {
  x: number;
  y: number;
}

/** 一次按压(位置 + 时刻) */
export interface TapPoint extends PointerPoint {
  /** 按下时刻(ms) */
  time: number;
}

/** 一次指针事件 */
export interface PointerInput extends PointerPoint {
  /** 指针 id(同一次按压期间不变) */
  id: number;
  /** 指针类型:'touch' / 'mouse' / 'pen' */
  kind: string;
  /** 事件时刻(ms) */
  time: number;
}

/**
 * 触屏双击的最大间隔(ms)。
 *
 * 取 300:Android `GestureDetector` 的双击超时是 300ms、iOS UIKit 约 0.35s,
 * 都比浏览器原生 `dblclick` 的阈值(约 500ms)更紧。触摸时「连点两下」的间隔
 * 本来就短(不像鼠标要精确对点),阈值太松会把「想双击放大」误判成别的意图。
 */
export const DOUBLE_TAP_MAX_MS = 300;

/**
 * 触屏双击两次按下的最大位移(px)。
 *
 * 取 30:手指落点本身就有几像素抖动(指腹接触面比指尖大),30px 足够容错;
 * 再大就会把「点了两个不同的地方」误判成双击。
 */
export const DOUBLE_TAP_MAX_DIST = 30;

/**
 * 判定为「点击」(而不是拖动)的最大位移(px)。
 *
 * 取 10:超过它就认为用户是在拖动(平移图),这次按压不能作为双击的前半段。
 */
export const TAP_MAX_DRIFT = 10;

/**
 * 捏合的最小有效间距(px)。
 *
 * 两指靠得比它还近时,「当前间距 / 起始间距」接近除零,倍率全是噪声;
 * 此时按「不缩放」处理,免得画面被倍率噪声带飞。
 */
export const PINCH_MIN_DISTANCE = 8;

/** 两点间距(px) */
export function pointDistance(a: PointerPoint, b: PointerPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 两点中点(捏合的锚点:两指之间那一点) */
export function pointMidpoint(a: PointerPoint, b: PointerPoint): PointerPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * 捏合倍率 = 当前两指间距 / 起始两指间距。
 *
 * 非法输入(除零、NaN)一律退化为 1(= 不缩放),绝不能返回 NaN 把视图带飞。
 */
export function pinchRatio(startDistance: number, currentDistance: number): number {
  if (!Number.isFinite(startDistance) || !Number.isFinite(currentDistance)) return 1;
  if (startDistance < PINCH_MIN_DISTANCE) return 1;
  const r = currentDistance / startDistance;
  return Number.isFinite(r) && r >= 0 ? r : 1;
}

/**
 * 是否构成一次双击:两次按下的间隔在阈值内、且落点相距不远。
 *
 * 判定用**严格小于**(间隔 < 300ms 且位移 < 30px):阈值取「等于」时判不算,
 * 边界行为与文档口径一致,免得以后有人把阈值改成 300 却以为含义变了。
 *
 * ⚠️ 只对**触屏**用这条规则:鼠标的 `dblclick` 由浏览器原生派发(桌面行为不动),
 * 触屏在 `touch-action:none` 的元素上不保证派发 `dblclick`,只能自己判定。
 */
export function isDoubleTap(prev: TapPoint | null, curr: TapPoint): boolean {
  if (!prev) return false;
  const dt = curr.time - prev.time;
  // 时间倒流(系统时钟被改、事件时间戳异常)不算双击
  if (dt < 0 || dt >= DOUBLE_TAP_MAX_MS) return false;
  return pointDistance(prev, curr) < DOUBLE_TAP_MAX_DIST;
}

/** 手势模式:一指 = 单指(平移),两指 = 捏合(缩放) */
export type GestureMode = 'idle' | 'single' | 'pinch';

/** 捏合会话:手势开始时锁定的基准 */
export interface PinchSession {
  /** 起始时两指间距(px) */
  startDistance: number;
  /** 起始时的视图倍率 */
  startZoom: number;
  /** 起始时的视图(含平移量)——每帧都从它重算,避免逐帧增量累积漂移 */
  startView: ZoomView;
}

/** 当前参与捏合的两根手指 */
export interface PointerPair {
  a: PointerPoint;
  b: PointerPoint;
  /** 两指间距(px) */
  distance: number;
  /** 两指中点(捏合锚点) */
  mid: PointerPoint;
}

/** 指针按下时的判定结果 */
export interface DownResult {
  /** 按下后的手势模式 */
  mode: GestureMode;
  /** 这次按下让手势进入了捏合(第二指落下) */
  pinchStarted: boolean;
  /** 这次按下判定为触屏双击 */
  doubleTap: boolean;
}

/** 指针抬起时的判定结果 */
export interface UpResult {
  /** 本次手势是否已结束(没有剩余指针) */
  ended: boolean;
  /** 抬起的这根手指自按下以来几乎没有移动(=「点击」而不是「拖动」) */
  wasTap: boolean;
  /** 本次手势期间是否发生过捏合 */
  pinched: boolean;
}

interface TrackedPointer extends PointerPoint {
  /** 按下时的位置(用来判断这一下是「点击」还是「拖动」) */
  downX: number;
  downY: number;
}

/**
 * GestureTracker — 多指手势状态机(纯逻辑,无 React / DOM 依赖)
 *
 * 状态:
 *  - `idle`   没有指针按下
 *  - `single` 一根手指(桌面鼠标拖动 / 触屏单指平移)
 *  - `pinch`  两根手指(缩放)
 *
 * ⚠️ **抬起一指后不跳**的关键:捏合中抬起一根手指时,本类**保持 `pinch` 模式并冻结**,
 * 剩下那根手指的移动被忽略,直到它也抬起、手势才算结束。
 * 若此时切回 `single`,剩下那根手指会从「上一个位置」直接开始平移,画面会跳一下
 * (用户在捏合结束时手指是停在半空中的,那个位置和「平移起点」差得很远)。
 */
export class GestureTracker {
  private readonly pointers = new Map<number, TrackedPointer>();
  /** 上一次「可能是双击前半段」的触屏按压(跨手势保留:双击本来就是两次独立手势) */
  private tap: TapPoint | null = null;
  /** 捏合基准 */
  private session: PinchSession | null = null;
  private mode_: GestureMode = 'idle';
  /** 本次手势期间是否发生过捏合 */
  private pinched_ = false;

  /** 当前手势模式 */
  get mode(): GestureMode {
    return this.mode_;
  }

  /** 当前捏合基准(不在捏合时为 null) */
  get pinch(): PinchSession | null {
    return this.session;
  }

  /** 当前按下的指针数 */
  get count(): number {
    return this.pointers.size;
  }

  /**
   * 一根手指按下。
   *
   * @param p    指针事件
   * @param view 此刻的视图(捏合基准要锁住它:第二指落下时图在哪,就从哪开始缩放)
   */
  down(p: PointerInput, view: ZoomView): DownResult {
    // 只跟踪前两指:第三指及以上忽略(捏合只认一对,多指会把基准搅乱)
    if (this.pointers.size >= 2 && !this.pointers.has(p.id)) {
      return { mode: this.mode_, pinchStarted: false, doubleTap: false };
    }
    if (this.pointers.has(p.id)) {
      // 同一个 pointerId 重复 down(少见):只更新位置,不重置手势
      const cur = this.pointers.get(p.id);
      if (cur) {
        cur.x = p.x;
        cur.y = p.y;
      }
      return { mode: this.mode_, pinchStarted: false, doubleTap: false };
    }

    this.pointers.set(p.id, { x: p.x, y: p.y, downX: p.x, downY: p.y });

    if (this.pointers.size === 1) {
      this.mode_ = 'single';
      this.session = null;
      this.pinched_ = false;
      if (p.kind === 'touch') {
        const cand: TapPoint = { x: p.x, y: p.y, time: p.time };
        const doubleTap = isDoubleTap(this.tap, cand);
        // 一次双击只认一次:命中后清掉候选(否则第三下会被当成新的双击)
        this.tap = doubleTap ? null : cand;
        return { mode: this.mode_, pinchStarted: false, doubleTap };
      }
      // 鼠标/触控笔的双击交给浏览器原生 dblclick,这里不参与判定
      this.tap = null;
      return { mode: this.mode_, pinchStarted: false, doubleTap: false };
    }

    // 第二指落下 → 进入捏合并锁定基准
    this.mode_ = 'pinch';
    this.pinched_ = true;
    this.tap = null; // 捏合打断双击候选
    const pair = this.currentPair();
    this.session = {
      startDistance: pair ? pair.distance : 0,
      startZoom: view.zoom,
      startView: view,
    };
    return { mode: this.mode_, pinchStarted: true, doubleTap: false };
  }

  /** 指针移动(只更新位置,手势判定在调用方按 `mode` 分流) */
  move(p: PointerInput): void {
    const cur = this.pointers.get(p.id);
    if (!cur) return;
    cur.x = p.x;
    cur.y = p.y;
  }

  /** 指针抬起 / 取消 */
  up(id: number): UpResult {
    const p = this.pointers.get(id);
    this.pointers.delete(id);
    const wasTap = p ? Math.hypot(p.x - p.downX, p.y - p.downY) <= TAP_MAX_DRIFT : false;
    const pinched = this.pinched_;
    let ended = false;
    if (this.pointers.size === 0) {
      this.mode_ = 'idle';
      this.session = null;
      this.pinched_ = false;
      ended = true;
      // 这一下不是「干净的点击」(拖过 / 捏过) → 双击候选作废
      if (!wasTap || pinched) this.tap = null;
    }
    // 还有手指没抬起:
    //  - pinch 模式 → 保持冻结(剩下那根手指的移动被忽略),避免突然开始平移而跳一下
    //  - single 模式 → 不会有别的指针(单指模式下按下的第二根会立刻切到 pinch)
    return { ended, wasTap, pinched };
  }

  /** 当前参与捏合的两根手指(不足两根时为 null) */
  currentPair(): PointerPair | null {
    const it = this.pointers.values();
    const a = it.next().value;
    if (!a) return null;
    const b = it.next().value;
    if (!b) return null;
    return { a, b, distance: pointDistance(a, b), mid: pointMidpoint(a, b) };
  }

  /** 清空全部状态(换图 / 组件重挂载时用) */
  reset(): void {
    this.pointers.clear();
    this.tap = null;
    this.session = null;
    this.mode_ = 'idle';
    this.pinched_ = false;
  }
}
