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