/**
 * NodePluginManager — 可信本地节点插件的安装、注册与执行。
 *
 * 对外只暴露一个小接口；manifest 校验、版本化安装、输入边解析、动态加载、
 * Take 生命周期和最新画布回写都收在主进程内部。插件只能拿到运行上下文，
 * 不会拿到 ProjectStore、AssetStore、TakeStore 或 Electron 对象。
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { cp, mkdir, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  normalizeNodePluginData,
  parsePluginNodeKind,
  publicNodePluginDefinition,
  validateNodePluginData,
  validateNodePluginManifest,
  type CanvasNode,
  type CanvasSnapshot,
  type NodePluginDefinition,
  type NodePluginInputPort,
  type NodePluginManifest,
  type NodePluginManifestNode,
  type NodePluginMedia,
  type NodePluginRunRequest,
  type NodePluginRunResult,
  type Take,
} from '@bigbotart/shared';
import { OUTPUTS_DIR, type AssetStore } from './assets.js';
import type { DebugLogger } from './logger.js';
import type { ProjectStore } from './store.js';
import type { TakeStore } from './takes.js';

export interface NodePluginManagerOptions {
  store: ProjectStore;
  assets: AssetStore;
  takes: TakeStore;
  logger?: { log(level: string, message: string): void } | DebugLogger;
  /** 测试可注入临时数据目录；默认 BIGBOTART_HOME 或 ~/.bigbotart。 */
  dataDir?: string;
  /** 测试可注入临时产物目录；默认与资产/渲染产物根一致。 */
  outputsDir?: string;
}

export interface NodePluginInstalledSummary {
  id: string;
  version: string;
  displayName: string;
  enabled: boolean;
  error?: string;
  nodes: NodePluginDefinition[];
}

interface InstalledPluginRecord {
  manifest: NodePluginManifest;
  installPath: string;
  enabled: boolean;
  installedAt: string;
  error?: string;
}

interface PluginRegistryFile {
  version: 1;
  plugins: InstalledPluginRecord[];
}

interface PluginExecutorResult {
  resultPath: string;
  data?: Record<string, unknown>;
  outputs?: Record<string, string>;
}

interface PluginExecutorContext {
  parameters: Record<string, unknown>;
  inputs: Record<string, string[]>;
  outputDir: string;
  projectId: string;
  canvasId: string;
  nodeId: string;
  dryRun: boolean;
  log(message: string): void;
  reportProgress(pct?: number, message?: string): void;
}

type PluginExecute = (ctx: PluginExecutorContext) => Promise<PluginExecutorResult> | PluginExecutorResult;

const MEDIA_BY_EXTENSION: Record<string, NodePluginMedia> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image',
  '.mp4': 'video', '.mov': 'video', '.m4v': 'video', '.webm': 'video', '.mkv': 'video',
  '.wav': 'audio', '.mp3': 'audio', '.m4a': 'audio', '.aac': 'audio', '.flac': 'audio', '.ogg': 'audio',
  '.pdf': 'document', '.doc': 'document', '.docx': 'document',
  '.txt': 'text', '.md': 'text', '.markdown': 'text', '.json': 'text', '.srt': 'text', '.vtt': 'text',
};

const MEDIA_BY_NODE_KIND: Record<string, NodePluginMedia> = {
  'image-gen': 'image', 'image-edit': 'image', 'image-upscale': 'image',
  'image-crop': 'image', 'image-stitch': 'image', 'image-split': 'image', 'frame-grab': 'image',
  shot: 'video', 'video-upscale': 'video', timeline: 'video', document: 'document',
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUnderRoot(filePath: string, root: string): boolean {
  const target = resolve(filePath);
  const base = resolve(root);
  return target !== base && (target.startsWith(base + sep) || (sep === '\\' && target.startsWith(base + '/')));
}

function assertPathSegment(value: string, label: string): void {
  if (!value || value === '.' || value === '..' || value.length > 240 || /[/\\\0]/.test(value)) {
    throw new Error(`${label} 不是安全的单段路径: ${JSON.stringify(value)}`);
  }
}

function mediaOf(value: unknown): NodePluginMedia | undefined {
  return value === 'image' || value === 'video' || value === 'audio' || value === 'document' || value === 'text'
    ? value
    : undefined;
}

export class NodePluginManager {
  private readonly store: ProjectStore;
  private readonly assets: AssetStore;
  private readonly takes: TakeStore;
  private readonly logger?: NodePluginManagerOptions['logger'];
  private readonly dataDir: string;
  private readonly outputsDir: string;
  private readonly pluginsRoot: string;
  private readonly stateFile: string;
  private readonly runningNodes = new Set<string>();
  private plugins: InstalledPluginRecord[] = [];
  private _revision = 0;

  constructor(opts: NodePluginManagerOptions) {
    this.store = opts.store;
    this.assets = opts.assets;
    this.takes = opts.takes;
    this.logger = opts.logger;
    this.dataDir = resolve(opts.dataDir ?? process.env.BIGBOTART_HOME ?? join(homedir(), '.bigbotart'));
    this.outputsDir = resolve(opts.outputsDir ?? OUTPUTS_DIR);
    this.pluginsRoot = join(this.dataDir, 'plugins');
    this.stateFile = join(this.dataDir, 'plugins.json');
    mkdirSync(this.dataDir, { recursive: true });
    this.loadState();
  }

  get revision(): number {
    return this._revision;
  }

  /** 默认只列可执行定义；includeDisabled 供设置页/只读降级展示。 */
  listDefinitions(opts?: { includeDisabled?: boolean }): NodePluginDefinition[] {
    const out: NodePluginDefinition[] = [];
    for (const record of this.plugins) {
      const usable = record.enabled && !record.error;
      if (!usable && !opts?.includeDisabled) continue;
      for (const node of record.manifest.nodes) out.push(this.toDefinition(record, node));
    }
    return out;
  }

  /** 停用的定义仍可查询，enabled=false；run 会再次做启停与磁盘完整性检查。 */
  getDefinition(kind: string): NodePluginDefinition | undefined {
    const parsed = parsePluginNodeKind(kind);
    if (!parsed) return undefined;
    const record = this.plugins.find((item) => item.manifest.id === parsed.pluginId);
    const node = record?.manifest.nodes.find((item) => item.kind === parsed.localKind);
    if (!record || !node) return undefined;
    return this.toDefinition(record, node);
  }

  listInstalled(): NodePluginInstalledSummary[] {
    return this.plugins.map((record) => ({
      id: record.manifest.id,
      version: record.manifest.version,
      displayName: record.manifest.displayName,
      enabled: record.enabled && !record.error,
      ...(record.error ? { error: record.error } : {}),
      nodes: record.manifest.nodes.map((node) => this.toDefinition(record, node)),
    }));
  }

  private toDefinition(record: InstalledPluginRecord, node: NodePluginManifestNode): NodePluginDefinition {
    const definition = publicNodePluginDefinition(record.manifest, node, record.enabled && !record.error);
    if (!record.error) return definition;
    // 内部 error 常含排障路径；公开定义只给安全摘要，完整原因留在 plugins.json 与日志。
    let error = '插件不可用，请查看主进程日志';
    if (record.error.includes('manifest')) error = '插件 manifest 缺失或无效';
    else if (record.error.includes('执行器加载失败')) error = '插件执行器加载失败，请查看主进程日志';
    else if (record.error.includes('执行器')) error = '插件执行器缺失或无效';
    else if (record.error.includes('安装') || record.error.includes('插件文件')) error = '插件安装目录缺失或无效';
    return { ...definition, error };
  }

  /**
   * 安装用户显式选择的文件夹。源目录只读；先复制到同文件系统 staging，再原子 rename。
   * 同 id/version 永不覆盖，升级只切换注册记录，旧版本目录保留用于回查。
   */
  async installFromFolder(sourcePath: string): Promise<{ ok: boolean; error?: string }> {
    let staging: string | undefined;
    try {
      const source = await realpath(resolve(sourcePath));
      const sourceStat = await stat(source);
      if (!sourceStat.isDirectory()) return this.installError('请选择包含 manifest.json 的插件文件夹');
      if (isUnderRoot(source, this.pluginsRoot) || source === resolve(this.pluginsRoot)) {
        return this.installError('不能从应用插件安装目录重复安装');
      }

      const manifestPath = join(source, 'manifest.json');
      const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
      const validated = validateNodePluginManifest(raw);
      if (!validated.ok) {
        return this.installError(`manifest 校验失败: ${this.formatIssues(validated.errors)}`);
      }
      const manifest = validated.manifest;
      const previous = this.plugins.find((item) => item.manifest.id === manifest.id);
      const destination = join(this.pluginsRoot, manifest.id, manifest.version);
      if (previous?.manifest.version === manifest.version || existsSync(destination)) {
        return this.installError(`插件 ${manifest.id}@${manifest.version} 已存在；请提升 version 后再安装`);
      }

      await mkdir(dirname(destination), { recursive: true });
      staging = join(dirname(destination), `.${manifest.version}.staging-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      await this.copyFolderWithoutLinks(source, staging);
      const record: InstalledPluginRecord = {
        manifest,
        installPath: destination,
        enabled: previous?.enabled ?? true,
        installedAt: new Date().toISOString(),
      };
      const inspectionError = this.inspectRecord({ ...record, installPath: staging });
      if (inspectionError) {
        record.enabled = false;
        record.error = inspectionError;
      }
      if (existsSync(destination)) throw new Error(`目标版本目录已存在: ${destination}`);
      await rename(staging, destination);
      staging = undefined;
      this.plugins = [...this.plugins.filter((item) => item.manifest.id !== manifest.id), record];
      this.saveState();
      this._revision += 1;
      if (inspectionError) return this.installError(`插件已登记但不可运行: ${inspectionError}`);
      this.log('info', `已安装插件 ${manifest.id}@${manifest.version}`);
      return { ok: true };
    } catch (error) {
      return this.installError(`安装插件失败: ${errorText(error)}`);
    } finally {
      if (staging) {
        try {
          await rm(staging, { recursive: true, force: true });
        } catch (cleanupError) {
          this.log('warn', `清理插件 staging 失败 ${staging}: ${errorText(cleanupError)}`);
        }
      }
    }
  }

  setEnabled(id: string, enabled: boolean): { ok: boolean; error?: string } {
    const record = this.plugins.find((item) => item.manifest.id === id);
    if (!record) return { ok: false, error: `插件不存在: ${id}` };
    if (enabled) {
      const inspectionError = this.refreshRecord(record);
      if (inspectionError) {
        record.enabled = false;
        record.error = inspectionError;
        this.saveState();
        this._revision += 1;
        return { ok: false, error: inspectionError };
      }
      record.error = undefined;
    }
    if (record.enabled === enabled && !record.error) return { ok: true };
    record.enabled = enabled;
    try {
      this.saveState();
    } catch (error) {
      return { ok: false, error: `保存插件状态失败: ${errorText(error)}` };
    }
    this._revision += 1;
    this.log('info', `插件 ${id} 已${enabled ? '启用' : '停用'}`);
    return { ok: true };
  }

  /** 只移除注册状态，绝不递归删除插件文件或历史产物。 */
  remove(id: string): { ok: boolean; error?: string } {
    const next = this.plugins.filter((item) => item.manifest.id !== id);
    if (next.length === this.plugins.length) return { ok: false, error: `插件不存在: ${id}` };
    const previous = this.plugins;
    this.plugins = next;
    try {
      this.saveState();
    } catch (error) {
      this.plugins = previous;
      return { ok: false, error: `保存插件状态失败: ${errorText(error)}` };
    }
    this._revision += 1;
    this.log('info', `已移除插件注册 ${id}(文件保留)`);
    return { ok: true };
  }

  async run(req: NodePluginRunRequest): Promise<NodePluginRunResult> {
    if (this.runningNodes.has(req.nodeId)) {
      return this.runError(req.nodeId, `节点 ${req.nodeId} 正在运行，请勿重复提交`);
    }
    this.runningNodes.add(req.nodeId);
    let take: Take | undefined;
    try {
      const canvas = this.store.loadProjectCanvases(req.projectId).canvases.find((item) => item.id === req.canvasId);
      if (!canvas) return this.runError(req.nodeId, `画布不存在: ${req.canvasId}`);
      const node = canvas.nodes.find((item) => item.id === req.nodeId);
      if (!node) return this.runError(req.nodeId, `画布节点不存在: ${req.nodeId}`);
      const parsed = parsePluginNodeKind(node.kind);
      if (!parsed) return this.runError(req.nodeId, `不是插件节点 kind: ${node.kind}`);
      const record = this.plugins.find((item) => item.manifest.id === parsed.pluginId);
      if (!record) return this.runError(req.nodeId, `插件未安装或已移除: ${parsed.pluginId}`);
      const diskError = this.refreshRecord(record);
      if (diskError) {
        record.enabled = false;
        record.error = diskError;
        this.saveState();
        this._revision += 1;
        return this.runError(req.nodeId, `插件 ${parsed.pluginId} 不可运行: ${diskError}`);
      }
      if (!record.enabled) return this.runError(req.nodeId, `插件已停用: ${parsed.pluginId}`);
      const manifestNode = record.manifest.nodes.find((item) => item.kind === parsed.localKind);
      if (!manifestNode) return this.runError(req.nodeId, `插件 ${parsed.pluginId} 未定义节点 ${parsed.localKind}`);

      const validated = validateNodePluginData(node.data, manifestNode.parametersSchema);
      if (!validated.ok) return this.runError(req.nodeId, `节点参数校验失败: ${this.formatIssues(validated.errors)}`);
      const parameters = normalizeNodePluginData(validated.data, manifestNode.parametersSchema);
      const inputs = this.resolveInputs(canvas, node, manifestNode);
      const dryRun = process.env.BIGBOTART_DRYRUN !== '0';

      take = this.takes.append(req.projectId, {
        shotNodeId: req.nodeId,
        status: 'queued',
        params: {
          kind: node.kind,
          __plugin: { id: record.manifest.id, version: record.manifest.version },
          parameters,
          inputs,
          dryRun,
        },
      });
      assertPathSegment(record.manifest.id, 'pluginId');
      assertPathSegment(req.nodeId, 'nodeId');
      assertPathSegment(take.id, 'takeId');
      const outputDir = join(this.outputsDir, 'plugins', record.manifest.id, req.nodeId, take.id);
      await mkdir(outputDir, { recursive: true });

      const executorPath = await this.executorRealPath(record, manifestNode);
      let imported: { execute?: PluginExecute; default?: { execute?: PluginExecute } };
      try {
        imported = (await import(pathToFileURL(executorPath).href)) as typeof imported;
      } catch (error) {
        const message = `执行器加载失败 ${manifestNode.executor}: ${errorText(error)}`;
        this.markLoadFailure(record, message);
        throw new Error(message);
      }
      const execute = typeof imported.execute === 'function'
        ? imported.execute
        : typeof imported.default?.execute === 'function'
          ? imported.default.execute
          : undefined;
      if (!execute) {
        const message = `执行器必须导出 execute(ctx) 或 default.execute: ${manifestNode.executor}`;
        this.markLoadFailure(record, message);
        throw new Error(message);
      }

      const result = await execute({
        parameters,
        inputs,
        outputDir,
        projectId: req.projectId,
        canvasId: req.canvasId,
        nodeId: req.nodeId,
        dryRun,
        log: (message) => this.log('info', `[${record.manifest.id}/${req.nodeId}] ${String(message)}`),
        reportProgress: (pct, message) => {
          const progress = typeof pct === 'number' && Number.isFinite(pct)
            ? ` ${Math.max(0, Math.min(100, pct))}%`
            : '';
          this.log('info', `[${record.manifest.id}/${req.nodeId}] 进度${progress}${message ? ` ${message}` : ''}`);
        },
      });
      if (!isRecord(result) || typeof result.resultPath !== 'string' || !result.resultPath.trim()) {
        throw new Error('执行器结果缺少 resultPath');
      }
      const resultPath = await this.validateOutputFile(result.resultPath, outputDir, '主产物');
      const outputs = result.outputs === undefined
        ? undefined
        : await this.validateNamedOutputs(result.outputs, outputDir);
      if (result.data !== undefined && !isRecord(result.data)) throw new Error('执行器 data 必须是对象');

      const patched = await this.takes.patch(req.projectId, take.id, { status: 'succeeded', resultPath });
      if (!patched) throw new Error(`Take 不存在，无法写入成功终态: ${take.id}`);
      this.saveRunResult({
        req,
        plugin: record.manifest,
        manifestNode,
        resultPath,
        takeId: take.id,
        ...(result.data ? { extraData: result.data } : {}),
        ...(outputs ? { outputs } : {}),
      });
      this.log('info', `插件运行成功 ${record.manifest.id}/${req.nodeId}, take=${take.id}`);
      return { ok: true, nodeId: req.nodeId, resultPath, takeId: take.id };
    } catch (error) {
      const message = errorText(error);
      if (take) {
        try {
          const patched = await this.takes.patch(req.projectId, take.id, { status: 'failed', error: message });
          if (!patched) this.log('error', `插件运行失败且 Take 不存在: ${take.id}`);
        } catch (patchError) {
          this.log('error', `插件失败 Take 终态写入失败 ${take.id}: ${errorText(patchError)}`);
        }
      }
      return this.runError(req.nodeId, message, take?.id);
    } finally {
      this.runningNodes.delete(req.nodeId);
    }
  }

  private loadState(): void {
    if (!existsSync(this.stateFile)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.stateFile, 'utf8'));
    } catch (error) {
      this.log('error', `插件状态文件损坏 ${this.stateFile}: ${errorText(error)}`);
      return;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) {
      this.log('error', `插件状态文件形状无效 ${this.stateFile}`);
      return;
    }
    const loaded: InstalledPluginRecord[] = [];
    for (const raw of parsed.plugins) {
      if (!isRecord(raw) || typeof raw.installPath !== 'string' || typeof raw.enabled !== 'boolean') {
        this.log('error', '跳过损坏的插件注册记录');
        continue;
      }
      const manifestResult = validateNodePluginManifest(raw.manifest);
      if (!manifestResult.ok) {
        this.log('error', `跳过无效插件注册定义: ${this.formatIssues(manifestResult.errors)}`);
        continue;
      }
      const record: InstalledPluginRecord = {
        manifest: manifestResult.manifest,
        installPath: raw.installPath,
        enabled: raw.enabled,
        installedAt: typeof raw.installedAt === 'string' ? raw.installedAt : new Date().toISOString(),
        ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
      };
      const inspectionError = this.refreshRecord(record);
      if (inspectionError) {
        record.enabled = false;
        record.error = inspectionError;
      } else {
        record.error = undefined;
      }
      loaded.push(record);
    }
    this.plugins = loaded;
    this.saveState();
  }

  /** 每次启用/运行前重读安装目录，外部删文件或改坏 manifest 不会被旧内存状态掩盖。 */
  private refreshRecord(record: InstalledPluginRecord): string | undefined {
    const expected = resolve(join(this.pluginsRoot, record.manifest.id, record.manifest.version));
    if (resolve(record.installPath) !== expected) return `安装路径越出版本化插件目录: ${record.installPath}`;
    const manifestPath = join(record.installPath, 'manifest.json');
    try {
      if (!existsSync(manifestPath)) return `插件 manifest.json 缺失: ${manifestPath}`;
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
      const validated = validateNodePluginManifest(raw);
      if (!validated.ok) return `安装后的 manifest 无效: ${this.formatIssues(validated.errors)}`;
      if (validated.manifest.id !== record.manifest.id || validated.manifest.version !== record.manifest.version) {
        return '安装后的 manifest id/version 与注册状态不一致';
      }
      record.manifest = validated.manifest;
      record.installPath = expected;
    } catch (error) {
      return `读取插件 manifest 失败: ${errorText(error)}`;
    }
    return this.inspectRecord(record);
  }

  private inspectRecord(record: InstalledPluginRecord): string | undefined {
    try {
      if (!statSync(record.installPath).isDirectory()) return `插件安装路径不是目录: ${record.installPath}`;
      for (const node of record.manifest.nodes) {
        const executor = resolve(record.installPath, node.executor);
        if (!isUnderRoot(executor, record.installPath)) return `执行器路径穿越: ${node.executor}`;
        if (!existsSync(executor) || !statSync(executor).isFile()) {
          return `节点 ${node.kind} 的执行器缺失: ${node.executor}`;
        }
        const realRoot = realpathSync(record.installPath);
        const realExecutor = realpathSync(executor);
        if (!isUnderRoot(realExecutor, realRoot)) return `执行器真实路径越出插件目录: ${node.executor}`;
      }
      return undefined;
    } catch (error) {
      return `插件文件检查失败: ${errorText(error)}`;
    }
  }

  private async executorRealPath(record: InstalledPluginRecord, node: NodePluginManifestNode): Promise<string> {
    const lexical = resolve(record.installPath, node.executor);
    if (!isUnderRoot(lexical, record.installPath)) throw new Error(`执行器路径穿越: ${node.executor}`);
    const [root, target] = await Promise.all([realpath(record.installPath), realpath(lexical)]);
    if (!isUnderRoot(target, root)) throw new Error(`执行器真实路径越出插件目录: ${node.executor}`);
    if (!(await stat(target)).isFile()) throw new Error(`执行器不是文件: ${node.executor}`);
    return target;
  }

  private async copyFolderWithoutLinks(source: string, destination: string): Promise<void> {
    // cp 的 filter 在复制前逐个核对源路径；额外遍历显式拒绝 symlink，避免安装后逃出插件根。
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`插件包不能包含符号链接: ${abs}`);
        if (entry.isDirectory()) await walk(abs);
        else if (!entry.isFile()) throw new Error(`插件包含不支持的文件类型: ${abs}`);
      }
    };
    await walk(source);
    await cp(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      filter: async (src) => {
        if (lstatSync(src).isSymbolicLink()) throw new Error(`插件包不能包含符号链接: ${src}`);
        return true;
      },
    });
  }

  private resolveInputs(
    canvas: CanvasSnapshot,
    node: CanvasNode,
    definition: NodePluginManifestNode,
  ): Record<string, string[]> {
    const ports = new Map<string, NodePluginInputPort>(definition.inputs.map((port) => [port.id, port]));
    const grouped = new Map<string, Array<{ edgeId: string; source: CanvasNode }>>();
    for (const edge of canvas.edges.filter((item) => item.target === node.id)) {
      const portId = edge.label ?? '';
      const port = ports.get(portId);
      if (!port) throw new Error(`输入边 ${edge.id} 指向未声明端口 ${portId || '(无 label)'}`);
      const source = canvas.nodes.find((item) => item.id === edge.source);
      if (!source) throw new Error(`输入 ${portId} 的边 ${edge.id} 找不到源节点 ${edge.source}`);
      const list = grouped.get(portId) ?? [];
      list.push({ edgeId: edge.id, source });
      grouped.set(portId, list);
    }

    const inputs: Record<string, string[]> = {};
    for (const port of definition.inputs) {
      const connected = grouped.get(port.id) ?? [];
      if (port.required && connected.length === 0) throw new Error(`缺少必填输入 ${port.id}(${port.label})`);
      if (port.cardinality === 'single' && connected.length > 1) {
        throw new Error(`输入 ${port.id} 是 single，却收到 ${connected.length} 条边`);
      }
      inputs[port.id] = connected.map(({ edgeId, source }) => this.resolveInputPath(port, edgeId, source));
    }
    return inputs;
  }

  private resolveInputPath(port: NodePluginInputPort, edgeId: string, source: CanvasNode): string {
    const data = (isRecord(source.data) ? source.data : {}) as Record<string, unknown>;
    let filePath: unknown;
    let media: NodePluginMedia | undefined;
    if (source.kind === 'asset' || typeof data.assetId === 'string') {
      const assetId = typeof data.assetId === 'string' ? data.assetId : '';
      const asset = assetId ? this.assets.get(assetId) : undefined;
      if (!asset || asset.deletedAt) throw new Error(`输入 ${port.id} 的边 ${edgeId} 引用了不存在的资产 ${assetId || '(空)'}`);
      filePath = asset.localPath;
      media = asset.kind;
    } else {
      filePath = data.resultPath;
      media = mediaOf(data.mediaType) ?? MEDIA_BY_NODE_KIND[source.kind] ?? MEDIA_BY_EXTENSION[extname(String(filePath ?? '')).toLowerCase()];
    }
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error(`输入 ${port.id} 的边 ${edgeId}: 源节点 ${source.id} 尚无可用 localPath/resultPath`);
    }
    const absolute = resolve(filePath);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new Error(`输入 ${port.id} 的边 ${edgeId}: 文件不存在 ${absolute}`);
    }
    if (!media) throw new Error(`输入 ${port.id} 的边 ${edgeId}: 无法判定源节点 ${source.id} 的媒体类型`);
    if (media !== port.media) {
      throw new Error(`输入 ${port.id} 的边 ${edgeId}: 需要 ${port.media}，实际为 ${media}(源节点 ${source.id})`);
    }
    return absolute;
  }

  private async validateOutputFile(rawPath: string, outputDir: string, label: string): Promise<string> {
    const candidate = resolve(outputDir, rawPath);
    if (!isUnderRoot(candidate, outputDir)) throw new Error(`${label}越出本次输出目录: ${rawPath}`);
    if (!existsSync(candidate) || !statSync(candidate).isFile() || statSync(candidate).size === 0) {
      throw new Error(`${label}不是已存在的非空文件: ${candidate}`);
    }
    const [root, target] = await Promise.all([realpath(outputDir), realpath(candidate)]);
    if (!isUnderRoot(target, root)) throw new Error(`${label}真实路径越出本次输出目录: ${rawPath}`);
    return target;
  }

  private async validateNamedOutputs(raw: unknown, outputDir: string): Promise<Record<string, string>> {
    if (!isRecord(raw)) throw new Error('执行器 outputs 必须是 Record<string,string>');
    const out: Record<string, string> = {};
    for (const [name, path] of Object.entries(raw)) {
      if (typeof path !== 'string') throw new Error(`命名产物 ${name} 的路径必须是字符串`);
      out[name] = await this.validateOutputFile(path, outputDir, `命名产物 ${name}`);
    }
    return out;
  }

  private saveRunResult(input: {
    req: NodePluginRunRequest;
    plugin: NodePluginManifest;
    manifestNode: NodePluginManifestNode;
    resultPath: string;
    takeId: string;
    extraData?: Record<string, unknown>;
    outputs?: Record<string, string>;
  }): void {
    const { req, plugin, manifestNode, resultPath, takeId, extraData, outputs } = input;
    // 长执行期间渲染层可能已保存多次；必须重载最新快照，不能拿运行前对象整体覆盖。
    const fresh = this.store.loadProjectCanvases(req.projectId).canvases.find((item) => item.id === req.canvasId);
    if (!fresh) throw new Error(`运行完成后画布已不存在: ${req.canvasId}`);
    const node = fresh.nodes.find((item) => item.id === req.nodeId);
    if (!node) throw new Error(`运行完成后节点已删除: ${req.nodeId}`);
    if (node.kind !== `plugin:${plugin.id}:${manifestNode.kind}`) {
      throw new Error(`运行完成后节点 kind 已变化，拒绝回写: ${node.kind}`);
    }
    const oldData = isRecord(node.data) ? node.data : {};
    const primary = manifestNode.outputs.find((output) => output.primary);
    node.data = {
      ...oldData,
      ...(extraData ?? {}),
      // 宿主字段最后写入，插件额外 data 不能伪造 Take、主产物或插件身份。
      resultPath,
      currentTakeId: takeId,
      ...(primary ? { mediaType: primary.media } : {}),
      ...(outputs ? { outputs } : {}),
      __plugin: { id: plugin.id, version: plugin.version },
    };
    // 只改 node.data；extraData.kind 即便存在也不可能覆盖 CanvasNode.kind。
    node.updatedAt = new Date().toISOString();
    fresh.updatedAt = node.updatedAt;
    // 先推进版本再交给 Store；其版本防护只拒绝“小于”，等版本旧内容不能获得同等保护。
    fresh.version = (fresh.version ?? 0) + 1;
    const saved = this.store.saveCanvasSnapshot(fresh);
    if (!saved.ok) {
      throw new Error(`画布结果保存失败${saved.stale ? '(版本已过期)' : ''}: ${req.canvasId}`);
    }
  }

  private markLoadFailure(record: InstalledPluginRecord, message: string): void {
    record.enabled = false;
    record.error = message;
    try {
      this.saveState();
      this._revision += 1;
    } catch (saveError) {
      this.log('error', `插件加载错误状态保存失败 ${record.manifest.id}: ${errorText(saveError)}`);
    }
  }

  private saveState(): void {
    mkdirSync(this.dataDir, { recursive: true });
    const doc: PluginRegistryFile = { version: 1, plugins: this.plugins };
    const temporary = `${this.stateFile}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(temporary, JSON.stringify(doc, null, 2), 'utf8');
    renameSync(temporary, this.stateFile);
  }

  private formatIssues(errors: ReadonlyArray<{ path: string; message: string }>): string {
    return errors.slice(0, 8).map((issue) => `${issue.path}: ${issue.message}`).join('；');
  }

  private installError(error: string): { ok: false; error: string } {
    this.log('error', error);
    return { ok: false, error };
  }

  private runError(nodeId: string, error: string, takeId?: string): NodePluginRunResult {
    this.log('error', `插件节点 ${nodeId} 运行失败: ${error}`);
    return { ok: false, nodeId, error, ...(takeId ? { takeId } : {}) };
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    try {
      if (this.logger) (this.logger.log as (level: string, message: string) => void)(level, message);
      else console.error(`[node-plugins:${level}] ${message}`);
    } catch (loggerError) {
      console.error(`[node-plugins:error] 日志写入失败: ${errorText(loggerError)}; 原日志: ${message}`);
    }
  }
}
