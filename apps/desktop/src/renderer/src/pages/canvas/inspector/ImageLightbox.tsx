import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  IDENTITY_VIEW,
  MAX_ZOOM,
  MIN_ZOOM,
  clampPanView,
  clampZoom,
  nextStop,
  panDeltaFor,
  zoomAtPoint,
  zoomByFactor,
  zoomLabel,
  type ZoomView,
} from './lib/image-zoom';

interface ImageLightboxProps {
  src: string;
  alt: string;
  /** 点击背景 / 关闭按钮 / Esc 关闭 */
  onClose: () => void;
}

/** 每个滚轮像素对应的缩放指数(触控板捏合的强度) */
const WHEEL_K = 0.0022;
/** 键盘平移步长(视口比例) */
const KEY_PAN = 0.06;
/** Safari 旧式 gesture 事件(部分触控板手势只走这条路径)的放大系数 */
const GESTURE_K = 1.9;
/** 视口尺寸最小可用值(未测量时用它兜底,避免除以 0) */
const MIN_BOX = 1;

interface ViewBox {
  /** 视口尺寸(px) */
  w: number;
  h: number;
  /** 图片原样(contain 后)显示尺寸(px)—— 缩放锚点与平移钳制都要用 */
  dw: number;
  dh: number;
}

/**
 * ImageLightbox — 应用内全屏看图(覆盖层,不是 Electron 的 window fullscreen)
 *
 * 放大有三条路径,覆盖鼠标 / Mac 触控板 / 键盘:
 *  1. **按钮与档位**:− / + / 「适应」/「1:1」+ 实时百分比;双击在 1× ↔ 2× 间切换;
 *     `+` `-` `0` 与方向键是键盘等价物。
 *  2. **Mac 触控板双指捏合**:macOS 把捏合派发成 `wheel` 且 `ctrlKey === true`(Chromium
 *     里仍是可取消的 wheel 事件,不是 passive),以光标为锚点做指数缩放;另接 Safari 的
 *     `gesturestart/change/end` 兜底,两条路径用时间戳去重,避免同一次捏合被放大两次。
 *  3. **滚轮 = 缩放**:鼠标滚轮直接缩放(看图场景的通行约定)。触控板**双指平移**
 *     (非 ctrlKey 且横向分量为主)仍作平移,便于浏览放大后的图。
 *  另外:图大于视口时按住拖动即可平移(`grab` 光标),触控板双指滑动同样可用。
 *
 * 这是**应用内覆盖层**(`.ovl-lb` 自绘暗底),不用 `requestFullscreen` —— 后者会把整个
 * 文档(含画布)一起全屏,而不是单张图。
 */
export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  const [view, setView] = useState<ZoomView>(IDENTITY_VIEW);
  const [panning, setPanning] = useState(false);
  const [box, setBox] = useState<ViewBox>({ w: 0, h: 0, dw: 0, dh: 0 });
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const viewRef = useRef<ZoomView>(IDENTITY_VIEW);
  viewRef.current = view;
  const boxRef = useRef(box);
  boxRef.current = box;
  const panRef = useRef<{ id: number; x: number; y: number } | null>(null);
  /** 本次指针序列是否真的拖动过(用于吞掉拖拽收尾的那个 click,避免拖完就关) */
  const draggedRef = useRef(false);
  /** 最近一次手势时间:wheel 与 gesturechange 可能同时到达,只认先到的那个 */
  const gestureAtRef = useRef(0);

  /* 换图(切 Take / 换节点)必须回到「适应窗口」,否则沿用上一张的平移量会显示错位 */
  useEffect(() => {
    setView(IDENTITY_VIEW);
    panRef.current = null;
    setPanning(false);
  }, [src]);

  /** 量一次视口尺寸 + 图片 contain 后的显示尺寸(锚点/钳制/1:1 都依赖它) */
  const measure = useCallback(() => {
    const el = viewportRef.current;
    const img = imgRef.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const nw = img?.naturalWidth ?? 0;
    const nh = img?.naturalHeight ?? 0;
    // contain:等比缩放到能放进视口
    let dw = 0;
    let dh = 0;
    if (nw > 0 && nh > 0 && w > 0 && h > 0) {
      const s = Math.min(w / nw, h / nh);
      dw = nw * s;
      dh = nh * s;
    }
    setBox((b) => (b.w === w && b.h === h && b.dw === dw && b.dh === dh ? b : { w, h, dw, dh }));
  }, []);

  /* 视口尺寸与图片解码尺寸:挂载后量一次,窗口缩放跟随;换图(src 变)时图片要重新解码 */
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure, src]);

  /** 由当前视图与视口算出「图片在屏幕上的实际尺寸」——测量还没回来时的兜底 */
  const dispOf = useCallback((b: ViewBox): { dw: number; dh: number } => {
    if (b.dw > 0 && b.dh > 0) return { dw: b.dw, dh: b.dh };
    return { dw: Math.max(MIN_BOX, b.w), dh: Math.max(MIN_BOX, b.h) };
  }, []);

  /** 缩放(可按锚点):所有入口都收口到这里,保证钳制与居中规则一致 */
  const applyZoom = useCallback(
    (next: number, px = 0, py = 0) => {
      const b = boxRef.current;
      const d = dispOf(b);
      setView((v) => zoomAtPoint(v, next, px, py, d.dw, d.dh, b.w, b.h));
    },
    [dispOf],
  );

  /** 档位步进:有锚点(按钮带指针位置)就放大那里,否则以视口中心纯缩放 */
  const step = useCallback(
    (dir: number, anchor?: { x: number; y: number }) => {
      const b = boxRef.current;
      const d = dispOf(b);
      const px = anchor ? anchor.x - b.w / 2 : 0;
      const py = anchor ? anchor.y - b.h / 2 : 0;
      setView((v) => zoomAtPoint(v, nextStop(v.zoom, dir), px, py, d.dw, d.dh, b.w, b.h));
    },
    [dispOf],
  );

  /** 「适应窗口」:回到 1× 且居中 */
  const fit = useCallback(() => setView(IDENTITY_VIEW), []);

  /**
   * 「1:1」:按图片自然像素显示 —— 适应窗口时倍率 1 对应 dw/naturalWidth,故取倒数。
   * 超大图(>14000px 宽)的 1:1 会超过 MAX_ZOOM 上限,此时只能逼近而不能真到 1:1。
   */
  const actualSize = useCallback(() => {
    const b = boxRef.current;
    const d = dispOf(b);
    const img = imgRef.current;
    const natural = img?.naturalWidth ?? 0;
    if (natural > 0 && d.dw > 0) {
      applyZoom(natural / d.dw);
      return;
    }
    applyZoom(1);
  }, [applyZoom, dispOf]);

  /** 1:1 是否受上限压制(用于按钮文案,避免显示一个达不到的承诺) */
  const actualCapped = (() => {
    const img = imgRef.current;
    const natural = img?.naturalWidth ?? 0;
    return natural > 0 && box.dw > 0 && natural / box.dw > MAX_ZOOM;
  })();

  /* 滚轮:触控板捏合(ctrlKey)/ 鼠标滚轮 = 缩放;触控板双指平移 = 平移 */
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault(); // 必须阻止:否则 Chromium 会把触控板捏合当成整页缩放
      const b = boxRef.current;
      const d = dispOf(b);
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left - b.w / 2;
      const py = e.clientY - rect.top - b.h / 2;
      const pinch = e.ctrlKey || e.metaKey;
      // 明显横向的双指滑动视作平移(横向浏览大图),纵向留给缩放
      if (!pinch && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const cur = viewRef.current;
        const p = clampPanView(cur.tx - e.deltaX / d.dw, cur.ty, cur.zoom, d.dw, d.dh, b.w, b.h);
        setView({ ...cur, tx: p.tx, ty: p.ty });
        return;
      }
      gestureAtRef.current = Date.now();
      // deltaMode:0=像素(触控板/多数鼠标) 1=行 2=页 —— 行/页要乘系数,否则滚半天不动
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? b.h : 1;
      const dz = e.deltaY * unit;
      setView((v) => zoomByFactor(v, Math.exp(-dz * WHEEL_K), px, py, d.dw, d.dh, b.w, b.h));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [dispOf]);

  /* Safari 旧式 gesture 事件兜底(macOS 触控板捏合的另一条派发路径) */
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let active = false;
    const onStart = (e: Event): void => {
      e.preventDefault();
      active = true;
      gestureAtRef.current = Date.now();
    };
    const onChange = (e: Event): void => {
      const ev = e as Event & { scale?: number; clientX?: number; clientY?: number; rotation?: number };
      if (!active || typeof ev.scale !== 'number' || ev.scale <= 0) return;
      e.preventDefault();
      // 双指旋转时 rotation 非 0:本查看器不支持旋转,直接忽略该次手势
      if (ev.rotation) return;
      // 同一手势若 wheel 路径刚处理过(40ms 内),跳过以免放大两次
      if (Date.now() - gestureAtRef.current < 40) return;
      const b = boxRef.current;
      const d = dispOf(b);
      const rect = el.getBoundingClientRect();
      const px = (ev.clientX ?? rect.left + b.w / 2) - rect.left - b.w / 2;
      const py = (ev.clientY ?? rect.top + b.h / 2) - rect.top - b.h / 2;
      // gesture 的 scale 是「相对手势起始」的累计值,故以当前倍率为基准换算
      setView((v) => zoomAtPoint(v, v.zoom * (1 + (ev.scale! - 1) * GESTURE_K), px, py, d.dw, d.dh, b.w, b.h));
    };
    const onEnd = (): void => {
      active = false;
    };
    const s = onStart as EventListener;
    const c = onChange as EventListener;
    const en = onEnd as EventListener;
    el.addEventListener('gesturestart', s);
    el.addEventListener('gesturechange', c);
    el.addEventListener('gestureend', en);
    return () => {
      el.removeEventListener('gesturestart', s);
      el.removeEventListener('gesturechange', c);
      el.removeEventListener('gestureend', en);
    };
  }, [dispOf]);

  /* 键盘:Esc 关闭;+/-/0 缩放;方向键平移(覆盖层内不抢画布快捷键) */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        step(1);
        return;
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        step(-1);
        return;
      }
      if (e.key === '0') {
        e.preventDefault();
        fit();
        return;
      }
      const dx = e.key === 'ArrowLeft' ? KEY_PAN : e.key === 'ArrowRight' ? -KEY_PAN : 0;
      const dy = e.key === 'ArrowUp' ? KEY_PAN : e.key === 'ArrowDown' ? -KEY_PAN : 0;
      if (!dx && !dy) return;
      e.preventDefault();
      const cur = viewRef.current;
      const b = boxRef.current;
      const d = dispOf(b);
      // tx 的单位是**未缩放**的图片尺寸 S(见 lib/image-zoom.ts 顶部实测说明),
      // 故「屏幕位移 KEY_PAN·V」换算成 tx 是 KEY_PAN·V/S —— **不能**除 zoom
      const p = clampPanView(
        cur.tx + panDeltaFor(dx * b.w, d.dw),
        cur.ty + panDeltaFor(dy * b.h, d.dh),
        cur.zoom,
        d.dw,
        d.dh,
        b.w,
        b.h,
      );
      setView({ ...cur, tx: p.tx, ty: p.ty });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, step, fit, dispOf]);

  /* 拖拽平移:图大于视口(钳制后仍有余量)时才可用 */
  const pannable = view.zoom > 1.001;
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!pannable || e.button !== 0) return;
    e.preventDefault();
    panRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    draggedRef.current = false;
    setPanning(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const p = panRef.current;
    if (!p || p.id !== e.pointerId) return;
    const b = boxRef.current;
    const d = dispOf(b);
    if (d.dw <= 0 || d.dh <= 0) return;
    const v = viewRef.current;
    if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) > 2) draggedRef.current = true;
    const next = clampPanView(v.tx + (e.clientX - p.x) / d.dw, v.ty + (e.clientY - p.y) / d.dh, v.zoom, d.dw, d.dh, b.w, b.h);
    panRef.current = { id: p.id, x: e.clientX, y: e.clientY };
    setView({ ...v, tx: next.tx, ty: next.ty });
  };
  const endPan = (): void => {
    if (!panRef.current) return;
    panRef.current = null;
    setPanning(false);
  };

  /**
   * 点视口空白 = 关闭。
   * 两道豁免:①点的是图片本身;②这一次点击是**拖拽平移的收尾**(pointerdown→move→up
   * 之后浏览器仍会补一个 click —— 若不拦,拖完图一松手就把查看器关了)。
   * ⚠️ 两条豁免分支都必须 **stopPropagation**:外层 `.ovl-lb` 上的 onClick 也是 onClose,
   * 只 return 不做阻断的话事件继续冒泡,点图片照样会关掉查看器(实测踩中)。
   */
  const onViewportClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget || draggedRef.current) {
      draggedRef.current = false;
      e.stopPropagation();
      return;
    }
    onClose();
  };

  /** 双击:适应 ↔ 2×(以指针为锚点,双击哪里放大哪里) */
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    e.stopPropagation();
    const b = boxRef.current;
    const d = dispOf(b);
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left - b.w / 2;
    const py = e.clientY - rect.top - b.h / 2;
    const v = viewRef.current;
    if (v.zoom > 1.2) {
      setView(IDENTITY_VIEW);
      return;
    }
    setView(zoomAtPoint(v, clampZoom(2), px, py, d.dw, d.dh, b.w, b.h));
  };

  const atMin = view.zoom <= MIN_ZOOM + 1e-4;
  const atMax = view.zoom >= MAX_ZOOM - 1e-4;

  return (
    <div
      className="ovl-lb"
      data-od-id="image-preview-lightbox"
      onClick={onClose}
      // 覆盖层内的滚轮/手势一律自行处理,不冒泡去缩放底下的画布
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="ovl-lb-bar" data-od-id="image-lightbox-zoom" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="btn btn-s btn-sm"
          data-od-id="image-lightbox-zoom-out"
          title="缩小(− 键)"
          disabled={atMin}
          onClick={() => step(-1)}
        >
          −
        </button>
        <span className="ovl-lb-pct mono" data-od-id="image-lightbox-zoom-pct">
          {zoomLabel(view.zoom)}
        </span>
        <button
          type="button"
          className="btn btn-s btn-sm"
          data-od-id="image-lightbox-zoom-in"
          title="放大(+ 键)"
          disabled={atMax}
          onClick={() => step(1)}
        >
          +
        </button>
        <button type="button" className="btn btn-s btn-sm" data-od-id="image-lightbox-fit" title="适应窗口(0 键)" onClick={fit}>
          适应
        </button>
        <button
          type="button"
          className="btn btn-s btn-sm"
          data-od-id="image-lightbox-actual"
          title={actualCapped ? `按原始像素 1:1 显示(受 ${MAX_ZOOM * 100}% 上限压制,仅能逼近)` : '按原始像素 1:1 显示'}
          onClick={actualSize}
        >
          {actualCapped ? '1:1⚠' : '1:1'}
        </button>
        <span className="ovl-lb-tip">滚轮 / 双指捏合缩放 · 拖动平移 · 双击放大</span>
      </div>
      <div
        ref={viewportRef}
        className={`ovl-lb-viewport${pannable ? ' pan' : ''}${panning ? ' grabbing' : ''}`}
        // 点视口空白处 = 关闭(与主流看图一致)。
        // —— 不能用 e.stopPropagation() 让外层遮罩处理:视口是 inset:0 铺满整层的,
        //    事件根本到不了外层,那样点空白就永远关不掉(实测踩中)。
        // 点**图片**本身不关(图片自己 stopPropagation);刚拖拽完的一次 click 也不关。
        onClick={onViewportClick}
        onDoubleClick={onDoubleClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          draggable={false}
          onLoad={measure}
          style={{
            // 布局盒锁成「适应窗口」后的尺寸。若用自然尺寸再 scale,
            // 百分比平移的基准和视口中心对不齐,图会整体偏下。
            ...(box.dw > 0 && box.dh > 0 ? { width: box.dw, height: box.dh } : null),
            transform: `translate(${view.tx * 100}%, ${view.ty * 100}%) scale(${view.zoom})`,
            transformOrigin: 'center center',
            transition: panning ? 'none' : 'transform 90ms ease-out',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--glass-shadow-lg)',
          }}
        />
      </div>
      <button
        type="button"
        className="ovl-lb-close"
        data-od-id="image-lightbox-close"
        aria-label="关闭"
        title="关闭 (Esc)"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}
