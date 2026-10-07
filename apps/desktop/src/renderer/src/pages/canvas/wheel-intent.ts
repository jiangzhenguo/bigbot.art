/**
 * wheel-intent — 滚轮 / 触控板手势的**意图判定**纯函数
 *
 * 背景(2026-10 改动):画布的平移从「左键拖空白」改为「触控板双指滑动」,
 * 于是 `wheel` 事件本身要承担两种语义,必须先判定用户到底想干什么:
 *
 *   · **触控板双指滑动** → 平移画布(与 Figma / 浏览器一致);
 *   · **Ctrl/⌘ + 滑动** → 缩放 —— Chromium 把触控板「捏合」直接合成成
 *     `ctrl+wheel`(这是浏览器把捏合暴露给网页的唯一标准方式),所以捏合缩放
 *     天然落在这条分支上,不需要额外做多指手势;
 *   · **鼠标滚轮** → 缩放 —— 鼠标没有第二根手指,滚轮若不缩放,鼠标用户就再也
 *     缩不了了。用 `deltaMode !== 0` 区分:触控板/精密滚动发的是像素级
 *     `DOM_DELTA_PIXEL`(0),传统鼠标滚轮发的是行/页级(1/2)。
 *
 * 判定与执行分离的理由:执行那侧要直写 DOM(见 CanvasPage 的 P3 注释),没法单测;
 * 把「怎么判」收敛成纯函数后,三条分支与边界情况都能用测试钉住。
 */

/** 一次滚轮事件的意图 */
export type WheelIntent = 'pan' | 'zoom';

export interface WheelIntentInput {
  /** 事件上的 ctrlKey(触控板捏合在 Chromium 里被合成为 ctrl+wheel) */
  ctrlKey?: boolean;
  /** 事件上的 metaKey(⌘ + 滑动,给习惯 Mac 快捷键的用户) */
  metaKey?: boolean;
  /** WheelEvent.deltaMode:0 = 像素(触控板),1/2 = 行/页(传统鼠标滚轮) */
  deltaMode?: number;
  /** 事件上的 shiftKey(见下方说明:刻意不参与判定,列出仅为文档化) */
  shiftKey?: boolean;
}

/**
 * 判定这次滚轮是「平移画布」还是「缩放画布」。
 *
 * 注意 `shiftKey` **刻意不参与判定**:触控板横向双指滑动时,Chromium 有时会
 * 顺带带上 shift,若据此改判会得到「横滑突然变成缩放」的怪异手感 —— 横滑
 * 就该横移画布(见 `panOffset` 对 deltaX 的处理)。
 */
export function wheelIntent(input: WheelIntentInput): WheelIntent {
  if (input.metaKey) return 'zoom';
  if (input.ctrlKey) return 'zoom';
  // 行/页模式 = 传统鼠标滚轮(触控板永远是像素模式)
  if ((input.deltaMode ?? 0) !== 0) return 'zoom';
  return 'pan';
}

/**
 * 双指滑动的位移量 → 视口平移增量。
 *
 * 视口变换是 `translate(x, y) scale(z)`,平移**在缩放之前**,所以 1px 的滑动
 * 就是 1px 的位移,**不要再除以 z**(那是「以 z 为基准」的错误假设,会让放大后
 * 滑动变得黏滞)。方向取负:手指向左滑(deltaX < 0)时画布内容应跟着向左走
 * = 视口原点右移,与系统/浏览器的自然滚动一致。
 */
export function panOffset(deltaX: number, deltaY: number): { dx: number; dy: number } {
  // 归一 `-0` 为 `0`:非法输入取负会得到 `-0`,虽不影响视觉,却会让
  // 「视口是否变化」的比对与断言失效(同 inspector/lib/image-zoom.ts 的 tidy)
  const norm = (v: number): number => {
    if (!Number.isFinite(v)) return 0;
    const n = -v;
    return n === 0 ? 0 : n;
  };
  return { dx: norm(deltaX), dy: norm(deltaY) };
}

/** 滚轮 deltaY → 缩放因子(指数映射,保证「滚上滚下对称」) */
export function zoomFactorFor(deltaY: number): number {
  if (!Number.isFinite(deltaY)) return 1;
  return Math.exp(-deltaY * 0.0016);
}
