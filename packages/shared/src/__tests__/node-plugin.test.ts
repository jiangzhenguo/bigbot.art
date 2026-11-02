import { describe, expect, it } from 'vitest';
import {
  NODE_PLUGIN_AGENT_DESCRIPTION_MAX_LENGTH,
  NODE_PLUGIN_API_VERSION,
  isPluginNodeKind,
  nodePluginAgentSummary,
  normalizeNodePluginData,
  parsePluginNodeKind,
  pluginNodeKind,
  publicNodePluginDefinition,
  validateNodePluginData,
  validateNodePluginManifest,
  type NodePluginData,
  type NodePluginDefinition,
  type NodePluginManifest,
  type NodePluginParametersSchema,
  type NodePluginRunRequest,
  type NodePluginRunResult,
  type NodePluginValidationIssue,
} from '../node-plugin.js';

function validManifest(): NodePluginManifest {
  return {
    apiVersion: NODE_PLUGIN_API_VERSION,
    id: 'acme-tools',
    version: '1.2.3',
    displayName: 'Acme 创作工具',
    nodes: [
      {
        kind: 'image-resize',
        title: '图片缩放',
        description: '按给定宽度缩放图片，并输出尺寸信息。',
        inputs: [
          { id: 'source', label: '来源图片', media: 'image', cardinality: 'single', required: true },
        ],
        outputs: [
          { id: 'image', label: '缩放图片', media: 'image', cardinality: 'single', required: true, primary: true },
          { id: 'metadata', label: '尺寸信息', media: 'text', cardinality: 'single', required: false },
        ],
        defaultData: { width: 512 },
        parametersSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', format: 'text', default: '默认提示词' },
            width: { type: 'integer', minimum: 1, maximum: 1024, default: 512 },
            ratio: { type: 'number', minimum: 0.1, maximum: 2 },
            mode: { type: 'string', enum: ['fit', 'fill'], default: 'fit' },
            enabled: { type: 'boolean', default: true },
          },
          required: ['prompt', 'width', 'mode'],
        },
        executor: 'executors/resize.js',
      },
    ],
  };
}

function expectIssue(result: { ok: false; errors: NodePluginValidationIssue[] } | { ok: true }, code: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors.some((error) => error.code === code), JSON.stringify(result.errors)).toBe(true);
}

describe('validateNodePluginManifest · 合法契约', () => {
  it('接受完整 manifest、SemVer 预发布版本和 string format=text', () => {
    const manifest = validManifest();
    manifest.version = '1.2.3-beta.1+build.7';
    expect(validateNodePluginManifest(manifest)).toEqual({ ok: true, manifest });
  });

  it('拒绝多余/缺失字段、不支持的 schema 关键字和空节点列表', () => {
    const extra = validManifest() as NodePluginManifest & { installPath?: string };
    extra.installPath = '/private/plugins/acme';
    expectIssue(validateNodePluginManifest(extra), 'unknown-field');

    const missing = validManifest();
    delete (missing.nodes[0] as Partial<NodePluginManifest['nodes'][number]>).executor;
    expectIssue(validateNodePluginManifest(missing), 'required');

    const unsupported = validManifest() as NodePluginManifest & {
      nodes: Array<{ parametersSchema: Record<string, unknown> }>;
    };
    unsupported.nodes[0]!.parametersSchema.additionalProperties = true;
    expectIssue(validateNodePluginManifest(unsupported), 'unknown-field');

    const empty = validManifest();
    empty.nodes = [];
    expectIssue(validateNodePluginManifest(empty), 'required');
  });

  it('拒绝非法 id/kind/version', () => {
    for (const kind of ['Image', 'bad_kind', 'bad kind', 'plugin:x:y', '-bad', 'bad-', '', 'a'.repeat(65)]) {
      const manifest = validManifest();
      manifest.nodes[0]!.kind = kind;
      expectIssue(validateNodePluginManifest(manifest), 'kind');
    }
    for (const version of ['1.0', 'v1.0.0', '01.0.0', '1.0.0-01']) {
      const manifest = validManifest();
      manifest.version = version;
      expectIssue(validateNodePluginManifest(manifest), 'version');
    }
    const badId = validManifest();
    badId.id = '../acme';
    expectIssue(validateNodePluginManifest(badId), 'id');
  });

  it.each([
    '/tmp/run.js',
    '../run.js',
    'executors/../run.js',
    '..\\run.js',
    'C:\\run.js',
    'C:run.js',
    'file:///tmp/run.js',
    '\\\\server\\share\\run.js',
    'executors//run.js',
    ' ./run.js',
  ])('拒绝危险 executor 路径:%s', (executor) => {
    const manifest = validManifest();
    manifest.nodes[0]!.executor = executor;
    expectIssue(validateNodePluginManifest(manifest), 'executor');
  });

  it('接受普通相对 executor 与 ./ 前缀', () => {
    for (const executor of ['run.mjs', './executors/run.js', 'executors/nested/run.cjs']) {
      const manifest = validManifest();
      manifest.nodes[0]!.executor = executor;
      expect(validateNodePluginManifest(manifest).ok).toBe(true);
    }
  });

  it('校验端口形状、重复 id、输入端 primary 与多个主输出', () => {
    const duplicate = validManifest();
    duplicate.nodes[0]!.outputs[1]!.id = 'image';
    expectIssue(validateNodePluginManifest(duplicate), 'duplicate');

    const twoPrimary = validManifest();
    twoPrimary.nodes[0]!.outputs[1]!.primary = true;
    expectIssue(validateNodePluginManifest(twoPrimary), 'primary-output');

    const inputPrimary = validManifest() as NodePluginManifest & {
      nodes: Array<{ inputs: Array<Record<string, unknown>> }>;
    };
    inputPrimary.nodes[0]!.inputs[0]!.primary = true;
    expectIssue(validateNodePluginManifest(inputPrimary), 'unknown-field');

    const badMedia = validManifest() as unknown as {
      nodes: Array<{ inputs: Array<Record<string, unknown>> }>;
    };
    badMedia.nodes[0]!.inputs[0]!.media = 'binary';
    expectIssue(validateNodePluginManifest(badMedia), 'shape');
  });

  it('校验 schema required 引用、enum 类型、范围与 manifest 默认值', () => {
    const missingProperty = validManifest();
    missingProperty.nodes[0]!.parametersSchema.required = ['not-declared'];
    expectIssue(validateNodePluginManifest(missingProperty), 'schema');

    const badEnum = validManifest();
    badEnum.nodes[0]!.parametersSchema.properties.mode!.enum = ['fit', 1];
    expectIssue(validateNodePluginManifest(badEnum), 'schema');

    const badRange = validManifest();
    badRange.nodes[0]!.parametersSchema.properties.width!.minimum = 2048;
    expectIssue(validateNodePluginManifest(badRange), 'schema');

    const badDefault = validManifest();
    badDefault.nodes[0]!.defaultData.width = 0;
    expectIssue(validateNodePluginManifest(badDefault), 'minimum');

    const badFormat = validManifest() as NodePluginManifest & {
      nodes: Array<{ parametersSchema: { properties: Record<string, Record<string, unknown>> } }>;
    };
    badFormat.nodes[0]!.parametersSchema.properties.width!.format = 'text';
    expectIssue(validateNodePluginManifest(badFormat), 'schema');
  });

  it('hostile getter/Proxy 不会抛出未处理异常', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys(): string[] {
          throw new Error('禁止读取');
        },
      },
    );
    let result: ReturnType<typeof validateNodePluginManifest> | undefined;
    expect(() => {
      result = validateNodePluginManifest(hostile);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.errors[0]?.code).toBe('exception');
  });
});

describe('插件 kind 与公开定义', () => {
  it('生成、识别并解析完整 kind', () => {
    const kind = pluginNodeKind('acme-tools', 'image-resize');
    expect(kind).toBe('plugin:acme-tools:image-resize');
    expect(isPluginNodeKind(kind)).toBe(true);
    expect(parsePluginNodeKind(kind)).toEqual({
      kind,
      pluginId: 'acme-tools',
      localKind: 'image-resize',
    });
    for (const invalid of ['shot', 'plugin:acme', 'plugin:acme:a:b', 'plugin:Acme:resize', 'plugin:acme:bad_kind']) {
      expect(isPluginNodeKind(invalid), invalid).toBe(false);
      expect(parsePluginNodeKind(invalid), invalid).toBeNull();
    }
    expect(isPluginNodeKind(null)).toBe(false);
  });

  it('publicNodePluginDefinition 白名单转换，不透传安装路径', () => {
    const manifest = validManifest();
    const internalManifest = { ...manifest, installPath: '/private/plugins/acme' };
    const internalNode = { ...manifest.nodes[0]!, absoluteInstallPath: '/private/plugins/acme/node' };
    const definition = publicNodePluginDefinition(internalManifest, internalNode, false);
    expect(definition).toMatchObject({
      kind: 'plugin:acme-tools:image-resize',
      localKind: 'image-resize',
      pluginId: 'acme-tools',
      pluginVersion: '1.2.3',
      pluginDisplayName: 'Acme 创作工具',
      enabled: false,
      title: '图片缩放',
      executor: 'executors/resize.js',
    });
    expect(JSON.stringify(definition)).not.toContain('/private');
    expect('installPath' in definition).toBe(false);
    expect('absoluteInstallPath' in definition).toBe(false);
    expect(definition.inputs).not.toBe(manifest.nodes[0]!.inputs);
    expect(definition.parametersSchema.required).not.toBe(manifest.nodes[0]!.parametersSchema.required);
  });

  it('运行请求/结果类型保持最小 IPC 契约', () => {
    const request: NodePluginRunRequest = { projectId: 'p1', canvasId: 'c1', nodeId: 'n1' };
    const success: NodePluginRunResult = { ok: true, nodeId: request.nodeId, resultPath: '/out/a.png', takeId: 't1' };
    const failure: NodePluginRunResult = { ok: false, nodeId: request.nodeId, error: '失败' };
    expect(success.takeId).toBe('t1');
    expect(failure.error).toBe('失败');
  });
});

describe('normalizeNodePluginData / validateNodePluginData', () => {
  it('应用 schema default，undefined 视为缺失，并剔除未知字段', () => {
    const schema = validManifest().nodes[0]!.parametersSchema;
    const input = { width: 640, prompt: undefined, unknown: '不应保留' };
    const normalized = normalizeNodePluginData(input, schema);
    expect(normalized).toEqual({
      prompt: '默认提示词',
      width: 640,
      mode: 'fit',
      enabled: true,
    });
    expect(input).toEqual({ width: 640, prompt: undefined, unknown: '不应保留' });

    const validated = validateNodePluginData(input, schema);
    expect(validated).toEqual({ ok: true, data: normalized });
  });

  it('保留 false/0/空字符串默认值', () => {
    const schema: NodePluginParametersSchema = {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', default: false },
        count: { type: 'integer', default: 0 },
        text: { type: 'string', default: '' },
      },
    };
    expect(normalizeNodePluginData({}, schema)).toEqual({ enabled: false, count: 0, text: '' });
  });

  it('default 可满足 required；没有默认值的必填参数会报错', () => {
    const schema = validManifest().nodes[0]!.parametersSchema;
    schema.required = ['prompt', 'ratio'];
    const result = validateNodePluginData({}, schema);
    expectIssue(result, 'required');
    if (!result.ok) {
      expect(result.errors.filter((error) => error.code === 'required')).toEqual([
        expect.objectContaining({ path: '$.ratio' }),
      ]);
    }
  });

  it.each([
    ['prompt', 42],
    ['width', 1.5],
    ['ratio', '1'],
    ['enabled', 0],
  ])('参数 %s 类型错误会返回 type issue', (key, value) => {
    const schema = validManifest().nodes[0]!.parametersSchema;
    const result = validateNodePluginData({ [key]: value }, schema);
    expectIssue(result, 'type');
    if (!result.ok) expect(result.errors.some((error) => error.path === `$.${key}`)).toBe(true);
  });

  it('number 拒绝 NaN/Infinity，非 object 数据也会被拒绝', () => {
    const schema = validManifest().nodes[0]!.parametersSchema;
    expectIssue(validateNodePluginData({ ratio: Number.NaN }, schema), 'type');
    expectIssue(validateNodePluginData({ ratio: Number.POSITIVE_INFINITY }, schema), 'type');
    expectIssue(validateNodePluginData([], schema), 'type');
    expectIssue(validateNodePluginData(null, schema), 'type');
  });

  it('校验 enum、minimum、maximum', () => {
    const schema = validManifest().nodes[0]!.parametersSchema;
    expectIssue(validateNodePluginData({ mode: 'crop' }, schema), 'enum');
    expectIssue(validateNodePluginData({ width: 0 }, schema), 'minimum');
    expectIssue(validateNodePluginData({ width: 1025 }, schema), 'maximum');
    expect(validateNodePluginData({ width: 1, ratio: 0.1 }, schema).ok).toBe(true);
    expect(validateNodePluginData({ width: 1024, ratio: 2 }, schema).ok).toBe(true);
  });

  it('schema 自身的非法 default/范围以结果返回，不抛异常', () => {
    const schema = validManifest().nodes[0]!.parametersSchema;
    schema.properties.width!.default = 0;
    const result = validateNodePluginData({}, schema);
    expectIssue(result, 'minimum');
    if (!result.ok) expect(result.errors[0]?.path).toContain('$schema');
  });

  it('prototype 形态参数名不会造成原型污染', () => {
    const properties = JSON.parse('{"__proto__":{"type":"string","default":"safe"}}') as NodePluginParametersSchema['properties'];
    const schema: NodePluginParametersSchema = { type: 'object', properties };
    const normalized: NodePluginData = normalizeNodePluginData({}, schema);
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(normalized, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('nodePluginAgentSummary', () => {
  it('包含精确 kind/用途/端口/参数，并完全跳过停用项', () => {
    const manifest = validManifest();
    const enabled = publicNodePluginDefinition(manifest, manifest.nodes[0]!);
    const disabled: NodePluginDefinition = {
      ...enabled,
      kind: pluginNodeKind(manifest.id, 'disabled-node'),
      localKind: 'disabled-node',
      title: '秘密停用节点',
      description: 'DISABLED_SECRET',
      enabled: false,
    };
    const summary = nodePluginAgentSummary([enabled, disabled]);
    expect(summary).toContain('kind=plugin:acme-tools:image-resize');
    expect(summary).toContain('用途=图片缩放:按给定宽度缩放图片');
    expect(summary).toContain('source(image,单值,必填)');
    expect(summary).toContain('image(image,单值,必填,主输出)');
    expect(summary).toContain('mode(string,必填,枚举="fit"|"fill",默认="fit")');
    expect(summary).toContain('width(integer,必填,最小=1,最大=1024,默认=512)');
    expect(summary).not.toContain('disabled-node');
    expect(summary).not.toContain('秘密停用节点');
    expect(summary).not.toContain('DISABLED_SECRET');
  });

  it('单个节点描述压缩空白并限制为 160 个 Unicode 字符', () => {
    const manifest = validManifest();
    manifest.nodes[0]!.description = `${'界'.repeat(400)}\n第二行`;
    const definition = publicNodePluginDefinition(manifest, manifest.nodes[0]!);
    const summary = nodePluginAgentSummary([definition]);
    expect(summary).toContain('…');
    expect(summary).not.toContain('第二行');
    expect(Array.from(summary).filter((char) => char === '界')).toHaveLength(
      NODE_PLUGIN_AGENT_DESCRIPTION_MAX_LENGTH - 1,
    );
    expect(nodePluginAgentSummary([{ ...definition, enabled: false }])).toBe('当前没有可用的节点插件。');
    expect(nodePluginAgentSummary([])).toBe('当前没有可用的节点插件。');
  });
});
