/**
 * 画幅预设(纯 TS,无 React 依赖,便于单测)— 检查器「画幅」块与铺节点共用口径。
 *
 * ⚠️ 16:9 / 9:16 必须精确比例:
 *   - mlxgen 无 32 倍数约束(dimension_multiple=null,实测按所传宽高输出),因此用
 *     **1024×576 / 576×1024**(精确 16:9、9:16,且同为 32 倍数,与 image-crop 口径一致)。
 *   - 旧值 832×480 / 480×832 实为 26:15 / 15:26:ratioOf 永远匹配不上预设 key,
 *     点选无高亮、出图比例也不是真 16:9。
 */

export interface AspectPreset {
  key: string;
  label: string;
  w: number;
  h: number;
}

export const ASPECTS: AspectPreset[] = [
  { key: '1:1', label: '1:1', w: 1024, h: 1024 },
  { key: '16:9', label: '16:9', w: 1024, h: 576 },
  { key: '9:16', label: '9:16', w: 576, h: 1024 },
  { key: '4:3', label: '4:3', w: 1024, h: 768 },
  { key: '3:4', label: '3:4', w: 768, h: 1024 },
  { key: '2:3', label: '2:3', w: 720, h: 1080 },
];

export const ASPECT_KEYS = ASPECTS.map((a) => a.key);

/** 宽高 → 最简比例 'W:H'(非法/零值返回 '') */
export function ratioOf(w: number, h: number): string {
  if (!(w > 0 && h > 0)) return '';
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const d = g(w, h);
  return `${w / d}:${h / d}`;
}

/**
 * 尺寸 → 命中的画幅 key(按比例,容差 1%);未命中返回 ''。
 *
 * 为什么需要容差:档位换分辨率时宽高会四舍五入(如 2:3 在 1K 档 → 683×1024),
 * 精确比例匹配会让高亮在换档后突然消失。1% 足够容纳取整误差,又拦得住
 * 历史错误档 672×1024(21:32,偏 1.56%)冒充 2:3。
 */
export function aspectKeyOf(w: number, h: number, tolerance = 0.01): string {
  if (!(w > 0 && h > 0)) return '';
  const target = w / h;
  for (const a of ASPECTS) {
    if (Math.abs(target - a.w / a.h) / (a.w / a.h) <= tolerance) return a.key;
  }
  return '';
}

/* ══ 基础分辨率档(1K / 1.5K / 2K)═════════════════════════════════════════
 *
 * 「基础分辨率」= **长边像素**,1K≈1024 / 1.5K≈1536 / 2K≈2048。
 * 点选后按当前画幅**等比缩放**,不改变构图比例 —— 换档不会把 16:9 变成别的比例。
 *
 * 为什么单独做一组档位,而不是只留宽高输入框:
 *   用户调分辨率时说的是「来个 2K」,不是「宽 2048 高 1152」。手填宽高要自己算比例,
 *   还得保证两个数都改对(只改一个就变形)。档位把这件事一步做完,宽高框只是结果展示。
 *
 * 取整用 Math.round(不做 32 倍数对齐):mlxgen 生成路由 dimension_multiple=null,
 * 实测按所传宽高真实输出;等比缩放后四舍五入只差 1px,比例误差 < 0.1%。
 * 若强对齐 32,2:3 这类比例会被明显拉偏(1024 长边无法同时满足 2:3 与 32 倍数),
 * 反而出现「选了 2:3 却出 21:32」的老问题。
 */
export interface BaseResolution {
  key: '1k' | '1.5k' | '2k';
  label: string;
  /** 长边目标像素 */
  longEdge: number;
}

export const BASE_RESOLUTIONS: BaseResolution[] = [
  { key: '1k', label: '1K', longEdge: 1024 },
  { key: '1.5k', label: '1.5K', longEdge: 1536 },
  { key: '2k', label: '2K', longEdge: 2048 },
];

/** 把尺寸等比缩放到「长边 = longEdge」;非法输入原样返回(不让 UI 写坏数据)。 */
export function resizeToBase(
  w: number,
  h: number,
  longEdge: number,
): { w: number; h: number } {
  if (!(w > 0 && h > 0 && longEdge > 0)) return { w, h };
  const scale = longEdge / Math.max(w, h);
  return {
    w: Math.max(1, Math.round(w * scale)),
    h: Math.max(1, Math.round(h * scale)),
  };
}

/** 当前尺寸命中的基础分辨率档(长边容差 2%);未命中返回 null(= 自定义长边)。 */
export function baseResolutionOf(w: number, h: number, tolerance = 0.02): BaseResolution | null {
  if (!(w > 0 && h > 0)) return null;
  const long = Math.max(w, h);
  for (const r of BASE_RESOLUTIONS) {
    if (Math.abs(long - r.longEdge) / r.longEdge <= tolerance) return r;
  }
  return null;
}