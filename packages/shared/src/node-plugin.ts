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

/**
 * 受控的检查器 UI 声明。首版只有一种控件 `picker`（可视化选择器）：
 * 宿主按声明渲染通用组件（搜索 / 筛选 / 分组 / 缩略图网格 / 预览），
 * 插件**不提供** React 代码，UI 能力由宿主统一实现。
 */
export interface NodePluginUiDeclaration {
  type: 'picker';
  /** 控件标题，例如「姿势选择器」。 */
  title: string;
  /** 选中项 id 写入的节点参数名，必须在 parametersSchema.properties 中声明。 */
  valueParam: string;
  /** 可选：把清单项的某个字段写入第二个参数（例如 angle）。 */
  variantParam?: string;
  /** variantParam 对应的清单项字段名；缺省时用 tabField。 */
  variantField?: string;
  /**
   * 可选：清单项里「值字段」的名字，写入 valueParam 的不是条目 id 而是该字段的值。
   *
   * 场景：插件的参数是一个长枚举值（例如「id | 体系 | 分类 | 名称」），
   * 而清单条目 id 是短 id（full_sexy_P001）。此时用 valueField 指明写哪个字段。
   */
  valueField?: string;
  /** 清单文件（相对插件根目录）的 JSON，含 items 数组。 */
  catalog: string;
  /** 搜索命中的字段名；缺省 ['id','label']。 */
  searchFields?: string[];
  /** 渲染成下拉筛选的字段名（例如体系、分类）。 */
  filterFields?: string[];
  /** 渲染成分组 tab 的字段名（例如视角 angle）。 */
  tabField?: string;
  /** 缩略图字段名；其值是相对清单文件所在目录的图片路径。 */
  thumbnailField?: string;
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
  /** 可选的受控 UI 声明；缺省走 Schema 自动生成的原生控件。 */
  ui?: NodePluginUiDeclaration;
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
  /** 受控 UI 声明（白名单拷贝；缺省表示用原生控件）。 */
  ui?: NodePluginUiDeclaration;
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
          ['ui'],
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
        if (node.ui !== undefined) {
          validateNodePluginUi(
            node.ui,
            `${nodePath}.ui`,
            errors,
            isRecord(node.parametersSchema) && isRecord(node.parametersSchema.properties)
              ? (node.parametersSchema as unknown as NodePluginParametersSchema)
              : undefined,
          );
        }
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
    ...(node.ui ? { ui: { ...node.ui } } : {}),
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

/**
 * picker 独占的参数名集合。
 *
 * 这些参数的值**由用户在检查器里选**，建节点那一刻必然还是空的。
 * 因此建节点阶段不能拿 parametersSchema.required 去卡它们 —— 否则节点永远建不出来，
 * 检查器也就永远打不开，picker 形同虚设。
 */
export function nodePluginPickerOwnedParams(ui: NodePluginUiDeclaration | undefined): string[] {
  if (!ui) return [];
  return [ui.valueParam, ui.variantParam].filter((name): name is string => !!name);
}

/**
 * 校验节点参数，但**豁免 picker 独占的必填参数**。
 *
 * 用于「建节点」这一刻：picker 的值还没选，允许为空；
 * 其余必填参数仍然必须齐全，非法值照样报错（不静默吞错）。
 */
export function validateNodePluginDataForCreate(
  data: unknown,
  schema: NodePluginParametersSchema,
  ui?: NodePluginUiDeclaration,
): ValidateNodePluginDataResult {
  const owned = new Set(nodePluginPickerOwnedParams(ui));
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
      // picker 独占参数在建节点时允许为空 —— 它的值由用户在检查器里选。
      if (owned.has(key)) continue;
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

/* ────────────────────────────── 受控 UI：可视化选择器(picker) ────────────────────────────── */

export interface NodePluginCatalogItem {
  /** 清单项唯一 id；选中后写入 valueParam。 */
  id: string;
  /** 显示名。 */
  label: string;
  description?: string;
  /** 缩略图 URL（bba-plugin://），没有图时缺省。 */
  thumb?: string;
  /** 其余字段（体系 / 分类 / 视角…），值只允许 string / number / boolean。 */
  fields: Record<string, NodePluginPrimitive>;
}

export interface NodePluginCatalog {
  items: NodePluginCatalogItem[];
  /** 清单里出现过的全部附加字段名（供 UI 提示与调试）。 */
  fields: string[];
}

export type NodePluginCatalogResult =
  | { ok: true; catalog: NodePluginCatalog }
  | { ok: false; error: string };

export type ValidateNodePluginCatalogResult =
  | { ok: true; catalog: NodePluginCatalog }
  | { ok: false; errors: NodePluginValidationIssue[] };

/** picker 缩略图 URL：bba-plugin://<pluginId>/<version>/<相对路径>。 */
export function nodePluginAssetUrl(pluginId: string, version: string, relativePath: string): string {
  const encoded = relativePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `bba-plugin://${pluginId}/${encodeURIComponent(version)}/${encoded}`;
}

const UI_REQUIRED = ['type', 'title', 'valueParam', 'catalog'] as const;
const UI_OPTIONAL = ['variantParam', 'variantField', 'valueField', 'searchFields', 'filterFields', 'tabField', 'thumbnailField'] as const;

/** 字段名必须是安全 id；清单项字段名同理，避免污染原型或制造怪异路径。 */
function safeFieldName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(value);
}

/**
 * 校验受控 UI 声明。valueParam / variantParam 必须已在 parametersSchema 中声明，
 * 否则选择结果无处落盘（会被归一化丢掉）——这类错误必须在安装前拦下。
 */
export function validateNodePluginUi(
  value: unknown,
  path: string,
  errors: NodePluginValidationIssue[],
  schema?: NodePluginParametersSchema,
): void {
  const ui = fixedShape(value, UI_REQUIRED, UI_OPTIONAL, path, errors);
  if (!ui) return;
  if (ui.type !== 'picker') {
    issue(errors, `${path}.type`, 'ui-type', '首版只支持 type=picker');
  }
  if (!nonEmptyText(ui.title, 120)) issue(errors, `${path}.title`, 'shape', 'title 须为 1–120 字符');
  if (!safeId(ui.valueParam)) {
    issue(errors, `${path}.valueParam`, 'id', 'valueParam 须为小写字母/数字/连字符组成的参数名');
  } else if (schema && !hasOwn(schema.properties, ui.valueParam)) {
    issue(errors, `${path}.valueParam`, 'ui-param', `valueParam ${ui.valueParam} 未在 parametersSchema 中声明`);
  }
  if (ui.variantParam !== undefined) {
    if (!safeId(ui.variantParam)) {
      issue(errors, `${path}.variantParam`, 'id', 'variantParam 须为小写字母/数字/连字符组成的参数名');
    } else if (schema && !hasOwn(schema.properties, ui.variantParam)) {
      issue(errors, `${path}.variantParam`, 'ui-param', `variantParam ${ui.variantParam} 未在 parametersSchema 中声明`);
    }
  }
  if (ui.variantField !== undefined && !safeFieldName(ui.variantField)) {
    issue(errors, `${path}.variantField`, 'ui-field', 'variantField 须为合法字段名');
  }
  if (ui.valueField !== undefined && !safeFieldName(ui.valueField)) {
    issue(errors, `${path}.valueField`, 'ui-field', 'valueField 须为合法字段名');
  }
  if (!safeExecutor(ui.catalog)) {
    issue(errors, `${path}.catalog`, 'executor', 'catalog 必须是插件根目录内的相对路径，禁止绝对路径、URI、空段与 ..');
  }
  for (const key of ['searchFields', 'filterFields'] as const) {
    const list = ui[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      issue(errors, `${path}.${key}`, 'shape', `${key} 必须是字符串数组`);
      continue;
    }
    const seen = new Set<string>();
    list.forEach((field, index) => {
      if (!safeFieldName(field)) {
        issue(errors, `${path}.${key}[${index}]`, 'ui-field', `${key} 的元素须为合法字段名`);
        return;
      }
      if (seen.has(field)) issue(errors, `${path}.${key}[${index}]`, 'duplicate', `${key} 重复声明 ${field}`);
      seen.add(field);
    });
  }
  for (const key of ['tabField', 'thumbnailField'] as const) {
    if (ui[key] !== undefined && !safeFieldName(ui[key])) {
      issue(errors, `${path}.${key}`, 'ui-field', `${key} 须为合法字段名`);
    }
  }
}

/**
 * 校验插件清单文件。条目 = id + label + 可选描述/缩略图 + 其余字段；
 * id 必须唯一；缩略图必须是相对路径（真实文件由主进程在安装/加载时核对）。
 */
export function validateNodePluginCatalog(input: unknown): ValidateNodePluginCatalogResult {
  const errors: NodePluginValidationIssue[] = [];
  try {
    const rawItems = Array.isArray(input)
      ? input
      : isRecord(input) && Array.isArray(input.items)
        ? input.items
        : undefined;
    if (!rawItems) {
      issue(errors, '$', 'shape', '清单必须是数组，或包含 items 数组的对象');
      return { ok: false, errors };
    }
    const items: NodePluginCatalogItem[] = [];
    const seen = new Set<string>();
    const fieldNames = new Set<string>();
    rawItems.forEach((rawItem, index) => {
      const itemPath = `$.items[${index}]`;
      if (!isRecord(rawItem)) {
        issue(errors, itemPath, 'shape', '条目必须是对象');
        return;
      }
      const id = rawItem.id;
      if (typeof id !== 'string' || !id.trim() || id.length > 128) {
        issue(errors, `${itemPath}.id`, 'shape', 'id 须为 1–128 字符');
        return;
      }
      if (seen.has(id)) {
        issue(errors, `${itemPath}.id`, 'duplicate', `条目 id 重复:${id}`);
        return;
      }
      seen.add(id);
      const label = rawItem.label;
      if (typeof label !== 'string' || !label.trim() || label.length > 120) {
        issue(errors, `${itemPath}.label`, 'shape', 'label 须为 1–120 字符');
        return;
      }
      const fields: Record<string, NodePluginPrimitive> = {};
      for (const [key, value] of Object.entries(rawItem)) {
        if (key === 'id' || key === 'label' || key === 'description' || key === 'thumb') continue;
        if (!safeFieldName(key)) {
          issue(errors, `${itemPath}.${key}`, 'ui-field', `字段名 ${key} 非法`);
          continue;
        }
        if (typeof value === 'string' || typeof value === 'boolean') {
          fields[key] = value;
        } else if (typeof value === 'number' && Number.isFinite(value)) {
          fields[key] = value;
        } else {
          issue(errors, `${itemPath}.${key}`, 'type', '字段值只允许 string / number / boolean');
        }
        fieldNames.add(key);
      }
      let thumb: string | undefined;
      if (rawItem.thumb !== undefined) {
        if (typeof rawItem.thumb !== 'string' || !safeExecutor(rawItem.thumb)) {
          issue(errors, `${itemPath}.thumb`, 'shape', 'thumb 必须是相对路径（禁止绝对路径与 ..）');
        } else {
          thumb = rawItem.thumb;
        }
      }
      const description = rawItem.description;
      if (description !== undefined && typeof description !== 'string') {
        issue(errors, `${itemPath}.description`, 'shape', 'description 必须是字符串');
      }
      items.push({
        id,
        label,
        ...(typeof description === 'string' && description ? { description } : {}),
        ...(thumb ? { thumb } : {}),
        fields,
      });
    });
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, catalog: { items, fields: [...fieldNames].sort() } };
  } catch (error) {
    issue(errors, '$', 'exception', `清单读取失败:${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, errors };
  }
}
