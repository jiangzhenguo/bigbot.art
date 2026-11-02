import React from 'react';
import type { NodePluginParameterSchema } from '@bigbotart/shared';

export interface PluginFieldProps {
  name: string;
  schema: NodePluginParameterSchema;
  value: unknown;
  required: boolean;
  readOnly: boolean;
  controlId: string;
  error?: string;
  onChange: (value: unknown) => void;
}

/** format:'text' 是 string 的多行展示提示，参数值仍是普通字符串。 */
export function isPluginTextSchema(schema: NodePluginParameterSchema): boolean {
  return schema.type === 'string' && schema.format === 'text';
}

/** number/integer 输入的纯转换；空值和非法值不写入 NaN。 */
export function parsePluginNumber(raw: string): number | undefined {
  if (!raw.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function PluginField({
  name,
  schema,
  value,
  required,
  readOnly,
  controlId,
  error,
  onChange,
}: PluginFieldProps) {
  const label = schema.title || name;
  const describedBy = [schema.description ? `${controlId}-description` : '', error ? `${controlId}-error` : '']
    .filter(Boolean).join(' ') || undefined;
  const common = {
    id: controlId,
    disabled: readOnly,
    'aria-invalid': !!error,
    'aria-describedby': describedBy,
    'data-od-id': `plugin-field-${name}`,
  };

  return (
    <div data-od-id={`plugin-field-row-${name}`} style={{ flex: 'none' }}>
      <label className="lbl" htmlFor={controlId} style={{ display: 'block', marginBottom: 6 }}>
        {label}
        {required ? <span style={{ color: 'var(--danger)' }}> *</span> : null}
      </label>
      {schema.description ? (
        <div id={`${controlId}-description`} className="mut" style={{ fontSize: 11, lineHeight: 1.5, marginBottom: 6 }}>
          {schema.description}
        </div>
      ) : null}
      <PluginControl
        name={name}
        schema={schema}
        value={value}
        required={required}
        common={common}
        onChange={onChange}
      />
      {error ? (
        <div id={`${controlId}-error`} role="alert" style={{ color: 'var(--danger)', fontSize: 11, lineHeight: 1.5, marginTop: 5 }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

function PluginControl({
  name,
  schema,
  value,
  required,
  common,
  onChange,
}: Pick<PluginFieldProps, 'name' | 'schema' | 'value' | 'required' | 'onChange'> & {
  common: {
    id: string;
    disabled: boolean;
    'aria-invalid': boolean;
    'aria-describedby': string | undefined;
    'data-od-id': string;
  };
}) {
  if (schema.enum?.length) {
    const options = schema.enum;
    const selected = options.findIndex((option) => Object.is(option, value));
    return (
      <select
        {...common}
        className="input-w"
        value={selected >= 0 ? String(selected) : ''}
        onChange={(event) => {
          const index = Number(event.target.value);
          onChange(event.target.value === '' ? undefined : options[index]);
        }}
        style={{ width: '100%' }}
      >
        <option value="" disabled={required}>{required ? '请选择' : '未设置'}</option>
        {options.map((option, index) => (
          <option key={`${typeof option}:${String(option)}`} value={String(index)}>{String(option)}</option>
        ))}
      </select>
    );
  }

  if (schema.type === 'boolean') {
    return (
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: 'var(--fg)', fontSize: 12 }}>
        <input
          {...common}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        {value === true ? '已开启' : '已关闭'}
      </label>
    );
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    return (
      <input
        {...common}
        className="input-w mono"
        type="number"
        inputMode="decimal"
        min={schema.minimum}
        max={schema.maximum}
        step={schema.type === 'integer' ? 1 : 'any'}
        value={typeof value === 'number' && Number.isFinite(value) ? String(value) : ''}
        onChange={(event) => onChange(parsePluginNumber(event.target.value))}
        style={{ width: '100%' }}
      />
    );
  }

  if (isPluginTextSchema(schema)) {
    return (
      <textarea
        {...common}
        className="input-w"
        rows={4}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        style={{ width: '100%', resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 12 }}
      />
    );
  }

  return (
    <input
      {...common}
      className="input-w"
      type="text"
      name={name}
      value={typeof value === 'string' ? value : ''}
      onChange={(event) => onChange(event.target.value)}
      style={{ width: '100%' }}
    />
  );
}
