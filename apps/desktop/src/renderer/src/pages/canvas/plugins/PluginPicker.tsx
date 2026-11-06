import React, { useMemo, useState } from 'react';
import type { NodePluginCatalogItem, NodePluginUiDeclaration } from '@bigbotart/shared';
import {
  filterPickerItems,
  pickerFacetValues,
  pickerSelectedItem,
  pickerSelectionPatch,
  pickerTabItems,
  pickerTabs,
  type PickerFilters,
} from './picker-logic';

export interface PluginPickerProps {
  /** 来自 manifest 的受控 UI 声明。 */
  ui: NodePluginUiDeclaration;
  /** 清单条目（主进程已校验并把缩略图转成 bba-plugin:// URL）。 */
  items: readonly NodePluginCatalogItem[];
  /** 当前 valueParam 的值。 */
  value: unknown;
  /** 当前 variantParam 的值；用于在同一姿势的多视角条目里定位选中项。 */
  variant?: unknown;
  readOnly: boolean;
  loading?: boolean;
  error?: string;
  onSelect: (item: NodePluginCatalogItem) => void;
}

/**
 * 宿主渲染的通用可视化选择器：搜索 + 筛选 + 缩略图网格 + 分组 tab + 选中预览。
 * 插件只提供清单数据，UI 形态由宿主统一实现（不加载第三方 React 代码）。
 */
export function PluginPicker({
  ui,
  items,
  value,
  variant,
  readOnly,
  loading = false,
  error,
  onSelect,
}: PluginPickerProps) {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<PickerFilters>({});
  const [tabOverride, setTabOverride] = useState<string | null>(null);

  const selected = pickerSelectedItem(items, ui, value, variant);
  const tabs = useMemo(() => pickerTabs(items, ui), [items, ui]);
  const selectedTab = ui.tabField && selected
    ? String(selected.fields[ui.tabField] ?? '')
    : '';
  const activeTab = tabOverride ?? (selectedTab || tabs[0] || '');

  const matched = useMemo(
    () => filterPickerItems(items, ui, query, filters),
    [items, ui, query, filters],
  );
  const visible = useMemo(
    () => pickerTabItems(matched, ui, ui.tabField ? activeTab : undefined),
    [matched, ui, activeTab],
  );

  const select = (item: NodePluginCatalogItem): void => {
    if (readOnly) return;
    onSelect(item);
  };

  return (
    <section
      data-od-id="plugin-picker"
      data-ui-type={ui.type}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ color: 'var(--fg)', fontSize: 12 }}>{ui.title}</b>
        {selected ? (
          <span className="mono mut" data-od-id="plugin-picker-current" style={{ fontSize: 10 }}>
            {selected.label}
            {selectedTab ? ` · ${selectedTab}` : ''}
          </span>
        ) : null}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          className="input-w"
          data-od-id="plugin-picker-search"
          type="search"
          placeholder="搜索名称 / ID"
          value={query}
          disabled={readOnly}
          onChange={(event) => setQuery(event.target.value)}
          style={{ flex: '1 1 140px', minWidth: 120 }}
        />
        {(ui.filterFields ?? []).map((field) => {
          const values = pickerFacetValues(items, ui, field);
          return (
            <select
              key={field}
              className="input-w"
              data-od-id={`plugin-picker-filter-${field}`}
              value={filters[field] ?? ''}
              disabled={readOnly}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
              style={{ flex: '0 1 auto', maxWidth: 140 }}
            >
              <option value="">全部</option>
              {values.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          );
        })}
      </div>

      {error ? (
        <div role="alert" data-od-id="plugin-picker-error" style={{ color: 'var(--danger)', fontSize: 11 }}>
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="mut" data-od-id="plugin-picker-loading" style={{ fontSize: 11 }}>正在加载清单…</div>
      ) : (
        <div
          data-od-id="plugin-picker-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))',
            gap: 6,
            maxHeight: 260,
            overflowY: 'auto',
            padding: 2,
          }}
        >
          {visible.map((item) => {
            const isSelected = selected?.id === item.id;
            return (
              <button
                key={item.id}
                type="button"
                data-od-id={`plugin-picker-item-${item.id}`}
                data-selected={isSelected ? 'true' : 'false'}
                title={item.label}
                disabled={readOnly}
                onClick={() => select(item)}
                style={{
                  padding: 0,
                  borderRadius: 'var(--radius-sm)',
                  border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border-soft)'}`,
                  outline: isSelected ? '2px solid var(--accent)' : 'none',
                  outlineOffset: '-2px',
                  background: isSelected ? 'var(--surface-warm)' : 'transparent',
                  cursor: readOnly ? 'default' : 'pointer',
                  overflow: 'hidden',
                  aspectRatio: '1 / 1',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {item.thumb ? (
                  <img
                    src={item.thumb}
                    alt={item.label}
                    loading="lazy"
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                ) : (
                  <span className="mut" style={{ fontSize: 10, padding: 4, textAlign: 'center' }}>
                    {item.label}
                  </span>
                )}
              </button>
            );
          })}
          {visible.length === 0 ? (
            <div className="mut" data-od-id="plugin-picker-empty" style={{ fontSize: 11, gridColumn: '1 / -1' }}>
              没有匹配的条目
            </div>
          ) : null}
        </div>
      )}

      {tabs.length ? (
        <div
          data-od-id="plugin-picker-tabs"
          style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}
        >
          {tabs.map((tab) => {
            const isActive = tab === activeTab;
            return (
              <button
                key={tab}
                type="button"
                className={`btn btn-s btn-sm${isActive ? ' btn-p' : ''}`}
                data-od-id={`plugin-picker-tab-${tab}`}
                data-active={isActive ? 'true' : 'false'}
                disabled={readOnly}
                onClick={() => setTabOverride(tab)}
              >
                {tab}
              </button>
            );
          })}
        </div>
      ) : null}

      {selected ? (
        <div
          data-od-id="plugin-picker-preview"
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            padding: 8,
            border: '1px solid var(--border-soft)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--surface-warm)',
          }}
        >
          {selected.thumb ? (
            <img
              src={selected.thumb}
              alt={selected.label}
              style={{ width: 84, height: 84, objectFit: 'cover', borderRadius: 'var(--radius-sm)', flex: 'none' }}
            />
          ) : null}
          <div style={{ minWidth: 0 }}>
            <div style={{ color: 'var(--fg)', fontSize: 12, fontWeight: 600 }}>{selected.label}</div>
            <div className="mono mut" style={{ fontSize: 10, marginTop: 2 }}>{selected.id}</div>
            {selected.description ? (
              <div className="mut" style={{ fontSize: 11, lineHeight: 1.5, marginTop: 4 }}>
                {selected.description}
              </div>
            ) : null}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
              {Object.entries(selected.fields).map(([field, value]) => (
                <span
                  key={field}
                  className="mono"
                  data-od-id={`plugin-picker-field-${field}`}
                  style={{
                    fontSize: 10,
                    padding: '1px 5px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-soft)',
                    color: 'var(--muted)',
                  }}
                >
                  {field}: {String(value)}
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="mut" data-od-id="plugin-picker-preview-empty" style={{ fontSize: 11 }}>
          尚未选择
        </div>
      )}
    </section>
  );
}

/** 选中回调的默认实现：把选中项按 ui 声明写回节点参数。 */
export function pickerPatchFor(
  ui: NodePluginUiDeclaration,
  item: NodePluginCatalogItem,
): Record<string, unknown> {
  return pickerSelectionPatch(ui, item);
}
