/**
 * 节点插件共享契约与纯函数。
 *
 * manifest 是插件包对外提供的声明；NodePluginDefinition 是主进程筛选后可交给
 * renderer / Agent 的公开视图。公开视图只含相对 executor，不包含插件安装目录。
 */

export const NODE_PLUGIN_API_VERSION = 'bigbotart.node-plugin/v1' as const;
export type NodePluginApiVersion = typeof NODE_PLUGIN_API_VERSION;

export type NodePluginMedia = 'image' | 'video' | 'audio' | 'document' | 'text';
export type NodePluginCardinality = 'single' | 'multiple';
export type NodePluginKind = `plugin:${string}:${string}`;
export type NodePluginPrimitive = string | number | boolean;
export type NodePluginData = Record<string, unknown>;

export interface NodePluginPort {
  id: string;
  label: string;
  media: NodePluginMedia;
  cardinality: NodePluginCardinality;
  required: boolean;
}

export type NodePluginInputPort = NodePluginPort;

export interface NodePluginOutputPort extends NodePluginPort {
  /** 一个节点最多一个主输出，供画布预览与下游默认连线使用。 */
  primary?: boolean;
}

export interface NodePluginParameterSchema {
  type: 'string' | 'number' | 'integer' | 'boolean';
  /** type=string 时可用 text 提示 UI 使用多行文本编辑器。 */
  format?: 'text';
  title?: string;
  description?: string;
  enum?: NodePluginPrimitive[];
  minimum?: number;
  maximum?: number;
  default?: NodePluginPrimitive;
}

/** 首版只支持一层 object；不支持嵌套对象、数组与任意 JSON Schema 关键字。 */
export interface NodePluginParametersSchema {
  type: 'object';
  properties: Record<string, NodePluginParameterSchema>;
  required?: string[];
}

export interface NodePluginManifestNode {
  /** 插件内局部 kind，不带 plugin: 前缀。 */
  kind: string;
  title: string;
  description: string;
  inputs: NodePluginInputPort[];
  outputs: NodePluginOutputPort[];
  defaultData: NodePluginData;
  parametersSchema: NodePluginParametersSchema;
  /** 相对插件根目录的执行入口，禁止绝对路径与 .. 穿越。 */
  executor: string;
}

export interface NodePluginManifest {
  apiVersion: NodePluginApiVersion;
  id: string;
  version: string;
  displayName: string;
  nodes: NodePluginManifestNode[];
}

/** 可安全传给 UI / Agent 的节点定义；刻意没有 installPath 等本机路径字段。 */
export interface NodePluginDefinition {
  kind: NodePluginKind;
  localKind: string;
  pluginId: string;
  pluginVersion: string;
  pluginDisplayName: string;
  enabled: boolean;
  /** 安装目录缺失、manifest 读取失败等可序列化状态；不包含本机路径。 */
  error?: string;
  title: string;
  description: string;
  inputs: NodePluginInputPort[];
  outputs: NodePluginOutputPort[];
  defaultData: NodePluginData;
  parametersSchema: NodePluginParametersSchema;
  executor: string;
}

export interface NodePluginRunRequest {
  projectId: string;
  canvasId: string;
  nodeId: string;
}

export interface NodePluginRunResult {
  ok: boolean;
  nodeId: string;
  resultPath?: string;
  takeId?: string;
  error?: string;
}

export interface ParsedPluginNodeKind {
  kind: NodePluginKind;
  pluginId: string;
  localKind: string;
}

export interface NodePluginValidationIssue {
  path: string;
  code: string;
  message: string;
}

export type ValidateNodePluginManifestResult =
  | { ok: true; manifest: NodePluginManifest }
  | { ok: false; errors: NodePluginValidationIssue[] };

export type ValidateNodePluginDataResult =
  | { ok: true; data: NodePluginData }
  | { ok: false; errors: NodePluginValidationIssue[] };

const SAFE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const MEDIA = new Set<NodePluginMedia>(['image', 'video', 'audio', 'document', 'text']);
const CARDINALITY = new Set<NodePluginCardinality>(['single', 'multiple']);
const PARAMETER_TYPES = new Set(['string', 'number', 'integer', 'boolean']);
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function issue(
  errors: NodePluginValidationIssue[],
  path: string,
  code: string,
  message: string,
): void {
  errors.push({ path, code, message });
}

/** 校验固定对象形状：required 必须存在，optional 可省略，其余字段一律拒绝。 */
function fixedShape(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  errors: NodePluginValidationIssue[],
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    issue(errors, path, 'shape', '必须是对象');
    return null;
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issue(errors, `${path}.${key}`, 'unknown-field', `不支持的字段 ${key}`);
  }
  for (const key of required) {
    if (!hasOwn(value, key)) issue(errors, `${path}.${key}`, 'required', `缺少必填字段 ${key}`);
  }
  return value;
}

function nonEmptyText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID_RE.test(value);
}

function safeExecutor(value: unknown): value is string {
  if (!nonEmptyText(value, 512) || value !== value.trim() || value.includes('\0')) return false;
  // 同时拦截 POSIX、Windows 盘符/盘符相对路径、UNC 与 file: 等 URI。
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) return false;
  const segments = value.split(/[\\/]/);
  return !segments.some((segment) => segment === '' || segment === '..');
}

function primitiveMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
    default:
      return false;
  }
}

function validatePrimitive(
  value: unknown,
  schema: NodePluginParameterSchema,
  path: string,
  errors: NodePluginValidationIssue[],
): void {
  if (!primitiveMatchesType(value, schema.type)) {
    issue(errors, path, 'type', `必须是 ${schema.type} 类型`);
    return;
  }
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    issue(errors, path, 'enum', '不在 enum 允许值中');
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issue(errors, path, 'minimum', `不能小于 ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issue(errors, path, 'maximum', `不能大于 ${schema.maximum}`);
    }
  }
}

const PARAMETER_SCHEMA_REQUIRED = ['type'] as const;
const PARAMETER_SCHEMA_OPTIONAL = ['format', 'title', 'description', 'enum', 'minimum', 'maximum', 'default'] as const;

function validateParametersSchema(
  value: unknown,
  path: string,
  errors: NodePluginValidationIssue[],
): void {
  const schema = fixedShape(value, ['type', 'properties'], ['required'], path, errors);
  if (!schema) return;
  if (schema.type !== 'object') issue(errors, `${path}.type`, 'schema', "parametersSchema.type 必须是 'object'");

  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) {
      issue(errors, `${path}.required`, 'schema', 'required 必须是字符串数组');
    } else {
      const seen = new Set<string>();
      schema.required.forEach((key, index) => {
        if (typeof key !== 'string' || key.length === 0) {
          issue(errors, `${path}.required[${index}]`, 'schema', 'required 项必须是非空字符串');
        } else if (seen.has(key)) {
          issue(errors, `${path}.required[${index}]`, 'duplicate', `required 重复声明 ${key}`);
        } else {
          seen.add(key);
          if (!isRecord(schema.properties) || !hasOwn(schema.properties, key)) {
            issue(errors, `${path}.required[${index}]`, 'schema', `required 引用了不存在的参数 ${key}`);
          }
        }
      });
    }
  }

  if (!isRecord(schema.properties)) {
    issue(errors, `${path}.properties`, 'schema', 'properties 必须是对象');
    return;
  }
  for (const [key, rawProperty] of Object.entries(schema.properties)) {
    const propertyPath = `${path}.properties.${key}`;
    if (!key.trim()) {
      issue(errors, propertyPath, 'schema', '参数名不能为空');
      continue;
    }
    const property = fixedShape(
      rawProperty,
      PARAMETER_SCHEMA_REQUIRED,
      PARAMETER_SCHEMA_OPTIONAL,
      propertyPath,
      errors,
    );
    if (!property) continue;
    if (typeof property.type !== 'string' || !PARAMETER_TYPES.has(property.type)) {
      issue(errors, `${propertyPath}.type`, 'schema', '仅支持 string/number/integer/boolean');
      continue;
    }
    const typedProperty = property as unknown as NodePluginParameterSchema;
    if (property.format !== undefined && (property.type !== 'string' || property.format !== 'text')) {
      issue(errors, `${propertyPath}.format`, 'schema', "format 仅支持 string 参数的 'text' 展示提示");
    }
    for (const textKey of ['title', 'description'] as const) {
      if (property[textKey] !== undefined && typeof property[textKey] !== 'string') {
        issue(errors, `${propertyPath}.${textKey}`, 'schema', `${textKey} 必须是字符串`);
      }
    }
    if (property.enum !== undefined) {
      if (!Array.isArray(property.enum) || property.enum.length === 0) {
        issue(errors, `${propertyPath}.enum`, 'schema', 'enum 必须是非空数组');
      } else {
        const seen = new Set<unknown>();
        property.enum.forEach((candidate, index) => {
          if (!primitiveMatchesType(candidate, property.type as string)) {
            issue(errors, `${propertyPath}.enum[${index}]`, 'schema', 'enum 项必须与参数 type 一致');
          }
          if (seen.has(candidate)) issue(errors, `${propertyPath}.enum[${index}]`, 'duplicate', 'enum 项不能重复');
          seen.add(candidate);
        });
      }
    }
    for (const bound of ['minimum', 'maximum'] as const) {
      const boundValue = property[bound];
      if (boundValue === undefined) continue;
      if (property.type !== 'number' && property.type !== 'integer') {
        issue(errors, `${propertyPath}.${bound}`, 'schema', `${bound} 只能用于 number/integer`);
      } else if (typeof boundValue !== 'number' || !Number.isFinite(boundValue)) {
        issue(errors, `${propertyPath}.${bound}`, 'schema', `${bound} 必须是有限数字`);
      }
    }
    if (
      typeof property.minimum === 'number' &&
      typeof property.maximum === 'number' &&
      Number.isFinite(property.minimum) &&
      Number.isFinite(property.maximum) &&
      property.minimum > property.maximum
    ) {
      issue(errors, propertyPath, 'schema', 'minimum 不能大于 maximum');
    }
    if (hasOwn(property, 'default')) {
      validatePrimitive(property.default, typedProperty, `${propertyPath}.default`, errors);
    }
  }
}

function validatePorts(
  value: unknown,
  direction: 'inputs' | 'outputs',
  path: string,
  errors: NodePluginValidationIssue[],
): void {
  if (!Array.isArray(value)) {
    issue(errors, path, 'shape', `${direction} 必须是数组`);
    return;
  }
  const required = ['id', 'label', 'media', 'cardinality', 'required'] as const;
  const optional = direction === 'outputs' ? (['primary'] as const) : ([] as const);
  const ids = new Set<string>();
  let primaryCount = 0;
  value.forEach((rawPort, index) => {
    const portPath = `${path}[${index}]`;
    const port = fixedShape(rawPort, required, optional, portPath, errors);
    if (!port) return;
    if (!safeId(port.id)) {
      issue(errors, `${portPath}.id`, 'id', '端口 id 须为小写字母/数字/连字符，且不能以连字符开头或结尾');
    } else if (ids.has(port.id)) {
      issue(errors, `${portPath}.id`, 'duplicate', `端口 id 重复:${port.id}`);
    } else {
      ids.add(port.id);
    }
    if (!nonEmptyText(port.label, 120)) issue(errors, `${portPath}.label`, 'shape', '端口 label 须为 1–120 字符');
    if (typeof port.media !== 'string' || !MEDIA.has(port.media as NodePluginMedia)) {
      issue(errors, `${portPath}.media`, 'shape', '未知端口媒体类型');
    }
    if (typeof port.cardinality !== 'string' || !CARDINALITY.has(port.cardinality as NodePluginCardinality)) {
      issue(errors, `${portPath}.cardinality`, 'shape', "cardinality 仅支持 'single'/'multiple'");
    }
    if (typeof port.required !== 'boolean') issue(errors, `${portPath}.required`, 'shape', 'required 必须是布尔值');
    if (direction === 'outputs') {
      if (port.primary !== undefined && typeof port.primary !== 'boolean') {
        issue(errors, `${portPath}.primary`, 'shape', 'primary 必须是布尔值');
      }
      if (port.primary === true) primaryCount += 1;
    }
  });
  if (primaryCount > 1) issue(errors, path, 'primary-output', '每个节点最多只能有一个主输出');
}

/**
 * 严格校验未知 manifest，并把异常统一转换为 discriminated union。
 * 这里不依赖 Node path 模块，因而 renderer 与测试环境都可直接使用。
 */
export function validateNodePluginManifest(input: unknown): ValidateNodePluginManifestResult {
  const errors: NodePluginValidationIssue[] = [];
  try {
    const root = fixedShape(input, ['apiVersion', 'id', 'version', 'displayName', 'nodes'], [], '$', errors);
    if (!root) return { ok: false, errors };
    if (root.apiVersion !== NODE_PLUGIN_API_VERSION) {
      issue(errors, '$.apiVersion', 'api-version', `apiVersion 必须是 ${NODE_PLUGIN_API_VERSION}`);
    }
    if (!safeId(root.id)) {
      issue(errors, '$.id', 'id', '插件 id 须为 1–64 位小写字母/数字/连字符，且不能以连字符开头或结尾');
    }
    if (typeof root.version !== 'string' || !SEMVER_RE.test(root.version)) {
      issue(errors, '$.version', 'version', 'version 必须是合法 SemVer(例如 1.0.0)');
    }
    if (!nonEmptyText(root.displayName, 120)) issue(errors, '$.displayName', 'shape', 'displayName 须为 1–120 字符');
    if (!Array.isArray(root.nodes)) {
      issue(errors, '$.nodes', 'shape', 'nodes 必须是数组');
    } else {
      if (root.nodes.length === 0) issue(errors, '$.nodes', 'required', '插件至少声明一个节点');
      const nodeKinds = new Set<string>();
      root.nodes.forEach((rawNode, nodeIndex) => {
        const nodePath = `$.nodes[${nodeIndex}]`;
        const node = fixedShape(
          rawNode,
          ['kind', 'title', 'description', 'inputs', 'outputs', 'defaultData', 'parametersSchema', 'executor'],
          [],
          nodePath,
          errors,
        );
        if (!node) return;
        if (!safeId(node.kind)) {
          issue(errors, `${nodePath}.kind`, 'kind', '局部 kind 须为 1–64 位小写字母/数字/连字符，不能含冒号');
        } else if (nodeKinds.has(node.kind)) {
          issue(errors, `${nodePath}.kind`, 'duplicate', `局部 kind 重复:${node.kind}`);
        } else {
          nodeKinds.add(node.kind);
        }
        if (!nonEmptyText(node.title, 120)) issue(errors, `${nodePath}.title`, 'shape', 'title 须为 1–120 字符');
        if (!nonEmptyText(node.description, 4000)) {
          issue(errors, `${nodePath}.description`, 'shape', 'description 须为 1–4000 字符');
        }
        validatePorts(node.inputs, 'inputs', `${nodePath}.inputs`, errors);
        validatePorts(node.outputs, 'outputs', `${nodePath}.outputs`, errors);
        if (!safeExecutor(node.executor)) {
          issue(errors, `${nodePath}.executor`, 'executor', 'executor 必须是插件根目录内的相对路径，禁止绝对路径、URI、空段与 ..');
        }
        validateParametersSchema(node.parametersSchema, `${nodePath}.parametersSchema`, errors);
        if (!isRecord(node.defaultData)) {
          issue(errors, `${nodePath}.defaultData`, 'shape', 'defaultData 必须是对象');
        } else if (isRecord(node.parametersSchema) && isRecord(node.parametersSchema.properties)) {
          // manifest 中的默认值可以是部分参数(运行时再补 schema default)，但已提供的值必须合法。
          for (const [key, value] of Object.entries(node.defaultData)) {
            const property = node.parametersSchema.properties[key];
            if (!isRecord(property)) {
              issue(errors, `${nodePath}.defaultData.${key}`, 'unknown-field', `defaultData 含未知参数 ${key}`);
            } else if (typeof property.type === 'string' && PARAMETER_TYPES.has(property.type)) {
              validatePrimitive(
                value,
                property as unknown as NodePluginParameterSchema,
                `${nodePath}.defaultData.${key}`,
                errors,
              );
            }
          }
        }
      });
    }
  } catch (error) {
    // Proxy/getter 等 hostile input 也不能让 manifest 加载流程抛出未处理异常。
    issue(errors, '$', 'exception', `manifest 读取失败:${error instanceof Error ? error.message : String(error)}`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: input as NodePluginManifest };
}

/** 生成完整插件节点 kind。合法性由 manifest 校验或 parse/is 助手把关。 */
export function pluginNodeKind(pluginId: string, localKind: string): NodePluginKind {
  return `plugin:${pluginId}:${localKind}`;
}

export function parsePluginNodeKind(value: unknown): ParsedPluginNodeKind | null {
  if (typeof value !== 'string') return null;
  const match = /^plugin:([^:]+):([^:]+)$/.exec(value);
  if (!match) return null;
  const pluginId = match[1]!;
  const localKind = match[2]!;
  if (!safeId(pluginId) || !safeId(localKind)) return null;
  return { kind: value as NodePluginKind, pluginId, localKind };
}

export function isPluginNodeKind(value: unknown): value is NodePluginKind {
  return parsePluginNodeKind(value) !== null;
}

/** 白名单式构造公开定义；即使内部对象额外带安装目录，也不会被透传。 */
export function publicNodePluginDefinition(
  manifest: NodePluginManifest,
  node: NodePluginManifestNode,
  enabled = true,
): NodePluginDefinition {
  const parametersSchema: NodePluginParametersSchema = {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(node.parametersSchema.properties).map(([key, schema]) => [
        key,
        { ...schema, ...(schema.enum ? { enum: [...schema.enum] } : {}) },
      ]),
    ),
    ...(node.parametersSchema.required ? { required: [...node.parametersSchema.required] } : {}),
  };
  return {
    kind: pluginNodeKind(manifest.id, node.kind),
    localKind: node.kind,
    pluginId: manifest.id,
    pluginVersion: manifest.version,
    pluginDisplayName: manifest.displayName,
    enabled,
    title: node.title,
    description: node.description,
    inputs: node.inputs.map((port) => ({ ...port })),
    outputs: node.outputs.map((port) => ({ ...port })),
    defaultData: { ...node.defaultData },
    parametersSchema,
    executor: node.executor,
  };
}

/**
 * 归一化节点参数：按 schema properties 白名单剔除未知字段，缺失值应用 default。
 * undefined 视为缺失；null 会保留并交由 validateNodePluginData 报类型错误。
 */
export function normalizeNodePluginData(data: unknown, schema: NodePluginParametersSchema): NodePluginData {
  const input = isRecord(data) ? data : {};
  const entries: Array<[string, NodePluginPrimitive | unknown]> = [];
  for (const [key, property] of Object.entries(schema.properties)) {
    if (hasOwn(input, key) && input[key] !== undefined) entries.push([key, input[key]]);
    else if (hasOwn(property, 'default')) entries.push([key, property.default]);
  }
  // fromEntries 会把 __proto__ 等键建成普通自有属性，避免原型污染。
  return Object.fromEntries(entries);
}

/** 先归一化，再校验 object/required/type/enum/minimum/maximum。未知字段默认剔除。 */
export function validateNodePluginData(data: unknown, schema: NodePluginParametersSchema): ValidateNodePluginDataResult {
  const errors: NodePluginValidationIssue[] = [];
  try {
    validateParametersSchema(schema, '$schema', errors);
    if (errors.length > 0) return { ok: false, errors };
    if (!isRecord(data)) {
      issue(errors, '$', 'type', '节点参数必须是对象');
      return { ok: false, errors };
    }
    const normalized = normalizeNodePluginData(data, schema);
    for (const key of schema.required ?? []) {
      if (!hasOwn(normalized, key)) issue(errors, `$.${key}`, 'required', `缺少必填参数 ${key}`);
    }
    for (const [key, property] of Object.entries(schema.properties)) {
      if (hasOwn(normalized, key)) validatePrimitive(normalized[key], property, `$.${key}`, errors);
    }
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, data: normalized };
  } catch (error) {
    issue(errors, '$', 'exception', `参数读取失败:${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, errors };
  }
}

export const NODE_PLUGIN_AGENT_DESCRIPTION_MAX_LENGTH = 160;

function compactDescription(value: string): string {
  const chars = Array.from(value.replace(/\s+/g, ' ').trim());
  if (chars.length <= NODE_PLUGIN_AGENT_DESCRIPTION_MAX_LENGTH) return chars.join('');
  return `${chars.slice(0, NODE_PLUGIN_AGENT_DESCRIPTION_MAX_LENGTH - 1).join('')}…`;
}

function summaryValue(value: NodePluginPrimitive): string {
  return JSON.stringify(value);
}

function parameterSummary(schema: NodePluginParametersSchema): string {
  const required = new Set(schema.required ?? []);
  const properties = Object.entries(schema.properties).map(([key, property]) => {
    const constraints = [
      property.type,
      required.has(key) ? '必填' : '可选',
      property.enum ? `枚举=${property.enum.map(summaryValue).join('|')}` : '',
      property.minimum !== undefined ? `最小=${property.minimum}` : '',
      property.maximum !== undefined ? `最大=${property.maximum}` : '',
      hasOwn(property, 'default') && property.default !== undefined ? `默认=${summaryValue(property.default)}` : '',
    ].filter(Boolean);
    return `${key}(${constraints.join(',')})`;
  });
  return properties.length > 0 ? properties.join('；') : '无';
}

function portSummary(ports: NodePluginPort[], outputs = false): string {
  if (ports.length === 0) return '无';
  return ports
    .map((port) => {
      const primary = outputs && (port as NodePluginOutputPort).primary === true ? ',主输出' : '';
      return `${port.id}(${port.media},${port.cardinality === 'single' ? '单值' : '多值'},${port.required ? '必填' : '可选'}${primary})`;
    })
    .join('；');
}

/** 给 Agent 的紧凑中文能力说明；停用插件完全不出现，kind 与参数/端口 id 保持原样。 */
export function nodePluginAgentSummary(definitions: readonly NodePluginDefinition[]): string {
  const enabled = definitions.filter((definition) => definition.enabled);
  if (enabled.length === 0) return '当前没有可用的节点插件。';
  const lines = enabled.map((definition) => {
    const title = definition.title.replace(/\s+/g, ' ').trim();
    const description = compactDescription(definition.description);
    const purpose = description ? `${title}:${description}` : title;
    return [
      `- kind=${definition.kind}`,
      `用途=${purpose}`,
      `输入=${portSummary(definition.inputs)}`,
      `输出=${portSummary(definition.outputs, true)}`,
      `参数=${parameterSummary(definition.parametersSchema)}`,
    ].join('；');
  });
  return ['可用节点插件(kind 必须原样使用):', ...lines].join('\n');
}
