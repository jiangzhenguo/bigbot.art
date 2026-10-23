/**
 * gesture-intent — 触控手势的**意图判定**纯函数
 *
 * 背景(2026-10,M5 里程碑):画布要能在 iPad 网页端用起来,而现有画布的手势全是
 * 「鼠标语义」的 —— 左键拖空白 = 框选(且必须先用顶栏按钮打开框选模式)、右键 = 菜单、
 * 滚轮 = 缩放。手指没有右键,单指拖空白在桌面语义里什么也不是,于是 iPad 上
 * 「怎么把画布挪开」这个最基本的动作无处落地(§11.2)。
 *
 * 与 `wheel-intent.ts` 同构的思路:**判定与执行分离**。
 *   · 判定侧(本文件):纯函数。输入是「这一帧的指针状态」,输出是「这一帧该干什么」。
 *     不碰 DOM、不碰 React、不读全局状态、不 new Date(时间由调用方传入),
 *     于是 §11.7 的用例可以纯 vitest 覆盖,不起浏览器。
 *   · 执行侧(CanvasPage):拿判定结果去调现成的 beginPan / beginMarquee /
 *     beginNodeDrag / connectDrag,以及开节点菜单。本文件不关心「怎么执行」。
 *
 * 为什么要单独一个模块,而不是在 CanvasPage 里写 if:
 *   ① **桌面手感不能被触控路径改动**。§11.7 风险 1:2026-10 刚把「拖空白平移」拿掉,
 *      判定写错的最坏结果不是「手势变怪」,而是「鼠标用户发现左键拖空白开始平移了」
 *      —— 那是已经修过一次的回归。所以判定层用单测钉死「非 touch 一律 desktop」,
 *      桌面分支一行都不改。
 *   ② **触控与鼠标的阈值必须分开**。§11.7 风险 2:鼠标的 3px 拖动阈值放在手指上会被
 *      抖动瞬间触发,长按菜单几乎永远弹不出来。所以触控用 8px、鼠标保持 3px,
 *      两套数字都从参数进来(而不是写死在函数里),由接线方按 pointerType 选。
 *   ③ **长按的「已成立」是一次锁存**。长按一旦成立(500ms 内没移动超过 8px),
 *      后面即使手指开始移动,这次手势的身份也已经定了(框选 / 菜单),不该退回「平移」。
 *      锁存由调用方负责(它才有定时器和 ref),本文件只提供纯判定。
 *
 * 边界说明:**热区 44px(§11.3)不在本模块**。热区是 CSS 与命中检测的事
 * (控件要按屏幕像素算,放在 `.world` 里要乘 1/zoom),本模块只消费调用方判好的
 * hit 分类(stage / node / node-add / control),不关心控件有多大。
 *
 * 规格来源:docs/网页远程访问-改造方案.md §11.2(判定表)、§11.7(用例清单与风险)。
 */

/* ── 常量:每个数都有来源,改之前先看下面的理由 ───────────────────────── */

/**
 * 长按成立所需的最短按住时长(ms)。
 *
 * 取 500ms 的理由:这是移动端长按的通用量级(iOS / Android 的原生 context menu
 * 触发点都在 500ms 上下),再短会和「点一下」的手感打架 —— 用户想点选节点却被判成长按,
 * 菜单弹出来把点选吃掉;再长(800ms 以上)则让「长按框选」显得迟钝,用户以为没反应。
 */
export const LONG_PRESS_MS = 500;

/**
 * 长按判定期间允许的手指抖动(px)。
 *
 * 手指按住时的自然抖动实测在 5px 上下,阈值取 8px 是「抖动不打断长按、但真挪动就能打断」
 * 的折中。刻意与触控拖动阈值(TOUCH_DRAG_THRESHOLD_PX)取同一个数:
 * 于是「长按后拖动」的分界和「算不算拖动」的分界是同一条线,不需要维护两套手感。
 */
export const LONG_PRESS_MOVE_TOLERANCE_PX = 8;

/**
 * 触控拖动阈值(px)。
 *
 * §11.7 风险 2 的实测依据:手指按住时的自然抖动就能超过鼠标的 3px,若触控沿用 3px,
 * 长按菜单会在用户还没想拖的时候就被抖动打断 —— 菜单几乎弹不出来。
 * 8px 是「仍算抖动」与「已经是在拖」之间的经验分界。
 */
export const TOUCH_DRAG_THRESHOLD_PX = 8;

/**
 * 鼠标拖动阈值(px)。
 *
 * 沿用现有实现(CanvasPage 里节点拖动与空白框选都是 `Math.hypot(...) > 3`),
 * 桌面手感不能因为加了触控路径而变 —— 这是 §11.7 风险 1 的底线。
 */
export const MOUSE_DRAG_THRESHOLD_PX = 3;

/**
 * 「+」拖出连线的位移阈值(px)。
 *
 * 与现有 connectDrag 实现一致(CanvasPage 里 `Math.hypot(dx, dy) > 4` 才算 moved)。
 * 两处若不一致,同一个「+」上的同一手势在触控路径与鼠标路径会给出不同结果
 * (既弹添加弹层又建边),所以这里锁死 4 并在单测里钉住。
 */
export const CONNECT_THRESHOLD_PX = 4;

/* ── 类型 ──────────────────────────────────────────────────────────── */

/**
 * 命中区域。调用方用 elementFromPoint / closest 判出来传进来:
 *   · `stage`    —— 空白舞台
 *   · `node`     —— 节点主体或节点头部
 *   · `node-add` —— 节点上的「+」(连线起点)
 *   · `control`  —— 已有控件(工具栏按钮、缩放条等),它们自己有点击语义
 */
export type GestureHit = 'stage' | 'node' | 'node-add' | 'control';

/**
 * 这一帧的意图。取值直接对应执行侧要调的现有入口:
 *   · `desktop`        —— 不是触控(或触控但没命中任何手势区):现有分支原样跑,不改任何行为
 *   · `pinch`          —— 两指捏合缩放(锚点取两指中点)
 *   · `connect`        —— 从「+」拖出连线
 *   · `drag-node`      —— 拖动节点
 *   · `context-menu`   —— 打开节点菜单
 *   · `marquee`        —— 框选
 *   · `hold`           —— 长按已成立但还没拖动:等抬手,此时什么都不做
 *   · `pan`            —— 单指平移画布
 *   · `clear-selection`—— 长按空白后没拖动就抬手:清空选区(同空白右键语义)
 */
export type GestureIntent =
  | 'desktop'
  | 'pinch'
  | 'connect'
  | 'drag-node'
  | 'context-menu'
  | 'marquee'
  | 'hold'
  | 'pan'
  | 'clear-selection';

/**
 * 一次手势事件的判定输入。每个字段都由调用方算好传进来 —— 本模块是纯判定,
 * 不知道 DOM、不知道画布状态、也不知道「现在是几点」。
 */
export interface GestureIntentInput {
  /** 指针类型:'mouse' / 'pen' / 'touch' / 其它字符串;只有 'touch' 走触控分支 */
  pointerType: string;
  /** 当前按下的触点总数(1 = 单指,≥2 = 多指);来自调用方自己的触点计数 */
  touchCount: number;
  /** 自 pointerdown 起的按住时长(ms)。由调用方传入 —— 本模块不读时钟 */
  holdMs: number;
  /** 自 pointerdown 起的位移(px,直线距离)。由调用方算好(通常是 Math.hypot) */
  dist: number;
  /** 命中区域 */
  hit: GestureHit;
  /**
   * 长按是否**已经成立**(此前某一帧判定过并被调用方锁存)。
   * 注意:本模块只做纯判定,锁存由调用方负责。
   */
  longPressArmed: boolean;
  /** 拖动阈值(px):触控 8 / 鼠标 3,由调用方按 pointerType 选(见 dragThresholdFor) */
  dragThresholdPx: number;
  /** 「+」连线位移阈值(px),缺省 CONNECT_THRESHOLD_PX(4) */
  connectThresholdPx?: number;
}

/**
 * 长按成立判定所需的输入。
 * 用 Pick 声明,是为了让调用方能直接把完整的 GestureIntentInput 传进来(结构兼容),
 * 不用为了调一次 shouldArmLongPress 而重新组装一个对象。
 */
export type LongPressInput = Pick<
  GestureIntentInput,
  'pointerType' | 'touchCount' | 'holdMs' | 'dist' | 'hit'
>;

/* ── 便利函数 ──────────────────────────────────────────────────────── */

/**
 * 是不是触控指针。
 *
 * 只认 'touch':笔(stylus)虽然也是「非鼠标」,但它的精度接近鼠标(有 hover、有按键),
 * 按触控处理会让有笔的用户丢失右键/框选语义,所以笔和鼠标一样走 desktop 分支。
 */
export function isTouchPointer(pointerType: string): boolean {
  return pointerType === 'touch';
}

/**
 * 按指针类型取拖动阈值(px):触控 8,其余(鼠标 / 笔)3。
 *
 * 为什么不在判定函数里写死:桌面阈值是既有手感(3px),改成 8 会让桌面用户觉得节点
 * 「粘手」;而触控沿用 3px 又会被手指抖动瞬间触发(§11.7 风险 2)。
 * 两套数字都进参数,接线方按 pointerType 选,判定层只负责用传进来的数。
 */
export function dragThresholdFor(pointerType: string): number {
  return isTouchPointer(pointerType) ? TOUCH_DRAG_THRESHOLD_PX : MOUSE_DRAG_THRESHOLD_PX;
}

/* ── 内部小工具 ────────────────────────────────────────────────────── */

/**
 * 位移归一化:负数当 0(「没动」),非有限数(NaN / Infinity)当「已经移动」。
 *
 * 为什么 NaN 要当「已经移动」而不是「没动」:判定全部靠 `dist > 阈值` 这种比较,
 * 而 `NaN > 8` 恒为 false —— 调用方一旦算出 NaN(比如起点坐标缺失),一次真实的拖动
 * 就会被判成「没动」,于是长按菜单可能在拖动途中凭空弹出来。
 * 反过来把 NaN 当「已经移动」是保守选择:不弹菜单、不 arm 长按、不清选区,
 * 只是继续按拖动处理,不会出现「弹了个不该弹的菜单」。
 */
function normalizeDist(dist: number): number {
  if (!Number.isFinite(dist)) return Number.POSITIVE_INFINITY;
  return dist > 0 ? dist : 0;
}

/* ── 判定 ──────────────────────────────────────────────────────────── */

/**
 * 判定「这一帧(pointermove 等)的手势意图」。
 *
 * 判定顺序是有讲究的,不要随意重排:
 *   ① 非触控 → desktop:桌面分支原样跑,一行都不改(§11.7 风险 1)。
 *   ② 多指 → pinch:优先于任何单指语义。两指时永远是捏合,
 *      绝不能是 pan(否则双指缩放会顺带把画布平移走,这是 iPad 上最典型的「手势打架」)。
 *   ③ 「+」 → connect / desktop:「+」有自己的语义(拖出连线),
 *      不足阈值时等同短按,走现有「打开添加弹层」的 click 路径。
 *   ④ 节点 → drag-node 优先于 context-menu:长按期间手指已经在拖节点时,
 *      不再升级成菜单(§11.2 明写),否则菜单会在拖动途中凭空弹出来。
 *   ⑤ 空白 → 按「长按是否已成立」分两路:已成立就是框选/等待,未成立就是平移/什么都不做。
 *
 * 返回 'desktop' 在这里的含义是「本模块不产生任何额外动作,让现有分支原样处理」。
 */
export function classifyGesture(input: GestureIntentInput): GestureIntent {
  // ① 桌面(鼠标 / 笔 / 其它):原样走现有分支,不改任何行为
  if (!isTouchPointer(input.pointerType)) return 'desktop';

  // ② 多指 = 捏合缩放。必须在所有单指语义之前判,否则双指会同时触发平移。
  if (input.touchCount >= 2) return 'pinch';

  const dist = normalizeDist(input.dist);
  const dragThreshold = input.dragThresholdPx;

  // ③ 「+」:拖过阈值 = 拖出连线;没拖过 = 短按,走现有 click 弹层路径
  if (input.hit === 'node-add') {
    const connectThreshold = input.connectThresholdPx ?? CONNECT_THRESHOLD_PX;
    return dist > connectThreshold ? 'connect' : 'desktop';
  }

  // ④ 节点:先看是不是已经在拖,再看长按是否成立
  if (input.hit === 'node') {
    if (dist > dragThreshold) return 'drag-node'; // 已经在拖 → 不升级成菜单
    if (input.longPressArmed) return 'context-menu'; // 长按成立且没拖走 → 弹节点菜单
    return 'desktop'; // 短按 → 走现有点选
  }

  // ⑤ 空白舞台:长按成立与否决定是「框选/等待」还是「平移/什么都不做」
  if (input.hit === 'stage') {
    if (input.longPressArmed) {
      // 长按已成立:拖动就是框选,没拖动就等着抬手(hold 阶段什么都不做)
      return dist > dragThreshold ? 'marquee' : 'hold';
    }
    // 长按未成立:单指拖动 = 平移画布(这是触控板上「双指滑动」在手指上的对应物);
    // 不足阈值 = 短按空白,与鼠标一致,什么都不做
    return dist > dragThreshold ? 'pan' : 'desktop';
  }

  // ⑥ 已有控件(工具栏按钮 / 缩放条等):它们自己有点击语义,手势层一律不接管
  return 'desktop';
}

/**
 * 判定「抬手(pointerup)这一刻的意图」。
 *
 * 与 classifyGesture 的差别只在**时机**:
 *   · move 阶段返回 'context-menu' = 「长按已成立,此刻就可以弹菜单」(即时反馈);
 *   · up 阶段返回 'context-menu'   = 「抬手这一刻才弹菜单」(抬手才确认)。
 * 两者语义不同,接线方(CanvasPage)两个都要接:菜单是弹一次还是弹两次,
 * 由执行侧决定(通常以 up 为准,move 只做「已长按」的视觉反馈)。
 *
 * 'desktop' 在这里表示「抬手时没有额外动作」,不代表桌面 —— 例如拖过的空白
 * 抬手(框选结束)也归到这里,收尾(提交框选、commitView)由执行侧自己管。
 */
export function classifyGestureUp(input: GestureIntentInput): GestureIntent {
  if (!isTouchPointer(input.pointerType)) return 'desktop';
  // 多指抬起 = 捏合结束,不做别的(否则双指松手会误清选区)
  if (input.touchCount >= 2) return 'desktop';
  // 没长按成立 → 抬手只是普通的一次点击/平移结束,没有额外语义
  if (!input.longPressArmed) return 'desktop';

  const dist = normalizeDist(input.dist);
  // 拖过了:这次手势已经在拖节点/框选,收尾归执行侧,不在抬手阶段再弹菜单
  if (dist > input.dragThresholdPx) return 'desktop';

  if (input.hit === 'stage') return 'clear-selection'; // 长按空白后没拖动就抬手 → 清空选区
  if (input.hit === 'node') return 'context-menu'; // 长按节点后抬起 → 弹菜单
  return 'desktop';
}

/**
 * 长按是否成立(可以锁存 armed 并在后续每一帧继续用)。
 *
 * 成立条件(全部满足):
 *   · 触控指针
 *   · 只有一根手指(两指及以上是捏合,不是长按)
 *   · 命中空白或节点(「+」和已有控件不参与长按:「+」有自己的点击语义,
 *     控件有自己的点击语义,长按抢它们的点击只会让 iPad 上的按钮变难按)
 *   · 已按住 ≥ LONG_PRESS_MS(500)
 *   · 期间位移 ≤ LONG_PRESS_MOVE_TOLERANCE_PX(8)——手指抖动的容差
 *
 * 调用方用定时器在 500ms 时调它,成立后**锁存**(longPressArmed = true)并在此后
 * 每一帧继续传进来;锁存由调用方负责,本函数只做纯判定,每次调用互不影响。
 */
export function shouldArmLongPress(input: LongPressInput): boolean {
  if (!isTouchPointer(input.pointerType)) return false;
  if (input.touchCount !== 1) return false;
  if (input.hit !== 'stage' && input.hit !== 'node') return false;
  // 用 `>=` 写死方向:NaN 的 holdMs 会让 `<` 比较恒为 false(误判成已到时),
  // 而 `>=` 遇 NaN 恒为 false,正确地判成「还没到长按时长」
  if (!(input.holdMs >= LONG_PRESS_MS)) return false;
  if (normalizeDist(input.dist) > LONG_PRESS_MOVE_TOLERANCE_PX) return false;
  return true;
}
