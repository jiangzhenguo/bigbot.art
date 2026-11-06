/**
 * 受控 UI(picker)的纯逻辑：搜索 / 筛选 / 分组 tab / 选中回写。
 *
 * 抽成纯函数是为了能脱离 React 断言行为 —— 宿主渲染通用组件，
 * 插件只提供清单数据，不提供任何 UI 代码。
 */
import type { NodePluginCatalogItem, NodePluginUiDeclaration } from '@bigbotart/shared';

export interface PickerFilters {
  [field: string]: string;
}

/** 搜索字段缺省 ['id','label']。 */
export function pickerSearchFields(ui: NodePluginUiDeclaration): string[] {
  return ui.searchFields && ui.searchFields.length > 0 ? [...ui.searchFields] : ['id', 'label'];
}

/** 读取清单项某个字段的文本形式；id/label/description 走固定字段，其余在 fields 里。 */
export function pickerFieldText(item: NodePluginCatalogItem, field: string): string {
  if (field === 'id') return item.id;
  if (field === 'label') return item.label;
  if (field === 'description') return item.description ?? '';
  const value = item.fields[field];
  return value === undefined ? '' : String(value);
}

/** 单个条目是否命中搜索词与筛选条件。 */
export function pickerItemMatches(
  item: NodePluginCatalogItem,
  ui: NodePluginUiDeclaration,
  query: string,
  filters: PickerFilters,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle) {
    const hit = pickerSearchFields(ui).some((field) =>
      pickerFieldText(item, field).toLowerCase().includes(needle),
    );
    if (!hit) return false;
  }
  for (const [field, wanted] of Object.entries(filters)) {
    if (!wanted) continue;
    if (pickerFieldText(item, field) !== wanted) return false;
  }
  return true;
}

/** 搜索 + 筛选后的条目（保持清单原始顺序）。 */
export function filterPickerItems(
  items: readonly NodePluginCatalogItem[],
  ui: NodePluginUiDeclaration,
  query: string,
  filters: PickerFilters,
): NodePluginCatalogItem[] {
  return items.filter((item) => pickerItemMatches(item, ui, query, filters));
}

/** 某个筛选字段的全部可选值（去重，保持清单顺序）。 */
export function pickerFacetValues(
  items: readonly NodePluginCatalogItem[],
  ui: NodePluginUiDeclaration,
  field: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const text = pickerFieldText(item, field);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/** 分组 tab 的取值顺序（清单顺序；无 tabField 时为空数组）。 */
export function pickerTabs(
  items: readonly NodePluginCatalogItem[],
  ui: NodePluginUiDeclaration,
): string[] {
  if (!ui.tabField) return [];
  return pickerFacetValues(items, ui, ui.tabField);
}

/** 某个 tab 下的条目。 */
export function pickerTabItems(
  items: readonly NodePluginCatalogItem[],
  ui: NodePluginUiDeclaration,
  tab: string | undefined,
): NodePluginCatalogItem[] {
  if (!ui.tabField || tab === undefined) return [...items];
  return items.filter((item) => pickerFieldText(item, ui.tabField!) === tab);
}

/**
 * 当前选中项。
 *
 * 按 valueParam 的值匹配（声明 valueField 时按该字段的值匹配）；
 * 若声明了 variantParam，还要同时匹配 variant ——
 * 否则同一姿势的多视角条目（poseValue 相同、只有 angle 不同）
 * 永远解析到第一条，预览图会和当前视角对不上。
 */
export function pickerSelectedItem(
  items: readonly NodePluginCatalogItem[],
  ui: NodePluginUiDeclaration,
  value: unknown,
  variant?: unknown,
): NodePluginCatalogItem | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const matchesValue = ui.valueField
    ? (item: NodePluginCatalogItem) => item.fields[ui.valueField!] === value
    : (item: NodePluginCatalogItem) => item.id === value;
  const candidates = items.filter(matchesValue);
  if (!candidates.length) return undefined;
  if (ui.variantParam && variant !== undefined && variant !== null && variant !== '') {
    const field = ui.variantField ?? ui.tabField;
    if (field) {
      const matched = candidates.find((item) => pickerFieldText(item, field) === String(variant));
      if (matched) return matched;
    }
  }
  return candidates[0];
}

/**
 * 选中项要写回 valueParam 的值。
 *
 * 缺省写条目 id；声明了 valueField 时写该字段的值 ——
 * 插件的参数常是一个长枚举值（"id | 体系 | 分类 | 名称"），
 * 而清单条目 id 是短 id，两者不是一回事。
 */
export function pickerItemValue(
  ui: NodePluginUiDeclaration,
  item: NodePluginCatalogItem,
): string | number | boolean | undefined {
  if (!ui.valueField) return item.id;
  return item.fields[ui.valueField];
}

/**
 * 选中项要写回的参数补丁：valueParam = 条目的值字段（缺省 id）；
 * variantParam = 条目在 variantField(缺省 tabField)上的值。
 */
export function pickerSelectionPatch(
  ui: NodePluginUiDeclaration,
  item: NodePluginCatalogItem,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const value = pickerItemValue(ui, item);
  if (value !== undefined) patch[ui.valueParam] = value;
  if (ui.variantParam) {
    const field = ui.variantField ?? ui.tabField;
    if (field) {
      const variant = item.fields[field];
      if (variant !== undefined) patch[ui.variantParam] = variant;
    }
  }
  return patch;
}
