/**
 * BigBotArtApi 方法目录。
 *
 * 类型在接口上,频道和分类在这里。IPC 与 HTTP 都读这份频道名,
 * 不另起一套 REST 资源名。事件频道不是方法名的 kebab-case,必须手写。
 *
 * `runSelfCheck` 的现有 IPC 是 `run-selfcheck`(历史拼写),不能按驼峰重推。
 */
import type { BigBotArtApi } from './index.js';

export type ApiFlag = 'dialog' | 'pathArg' | 'long' | 'large' | 'secret' | 'desktopOnly';

export interface ApiCatalogEntry {
  name: keyof BigBotArtApi;
  kind: 'rpc' | 'event';
  ipcChannel: string;
  flags?: readonly ApiFlag[];
}

function rpc<N extends keyof BigBotArtApi>(name: N, ipcChannel: string, flags?: readonly ApiFlag[]): ApiCatalogEntry & { name: N } {
  return flags && flags.length ? { name, kind: 'rpc', ipcChannel, flags } : { name, kind: 'rpc', ipcChannel };
}

function event<N extends keyof BigBotArtApi>(name: N, ipcChannel: string): ApiCatalogEntry & { name: N } {
  return { name, kind: 'event', ipcChannel };
}

export const API_CATALOG = [

  rpc('probeRuntimes', 'probe-runtimes'),
  rpc('installRuntime', 'install-runtime', ['long']),
  rpc('runSelfCheck', 'run-selfcheck', ['long']),
  rpc('mlxgenModels', 'mlxgen-models'),
  rpc('mlxgenDownload', 'mlxgen-download'),
  rpc('mlxgenDownloadStatus', 'mlxgen-download-status'),
  rpc('mlxgenDownloadActive', 'mlxgen-download-active'),
  rpc('mlxgenDownloadCancel', 'mlxgen-download-cancel'),
  rpc('savePngAsset', 'save-png-asset', ['large']),
  rpc('checkProviders', 'check-providers'),
  rpc('submitRender', 'submit-render'),
  rpc('renderStatus', 'render-status'),
  rpc('cancelRender', 'cancel-render'),
  rpc('queueStatus', 'queue-status'),
  rpc('listProjects', 'list-projects'),
  rpc('createProject', 'create-project'),
  rpc('deleteProject', 'delete-project'),
  rpc('renameProject', 'rename-project'),
  rpc('projectCover', 'project-cover'),
  rpc('projectCovers', 'project-covers'),
  rpc('uploadProjectCover', 'upload-project-cover', ['dialog']),
  rpc('clearProjectCover', 'clear-project-cover'),
  rpc('loadCanvas', 'load-canvas'),
  rpc('saveCanvas', 'save-canvas', ['large']),
  rpc('loadProjectCanvases', 'load-project-canvases', ['large']),
  rpc('saveCanvasSnapshot', 'save-canvas-snapshot', ['large']),
  rpc('createCanvas', 'create-canvas'),
  rpc('renameCanvas', 'rename-canvas'),
  rpc('deleteCanvas', 'delete-canvas'),
  rpc('switchActiveCanvas', 'switch-active-canvas'),
  rpc('setProjectLlm', 'set-project-llm'),
  rpc('importAssets', 'import-assets', ['dialog', 'pathArg']),
  rpc('listAssets', 'list-assets'),
  rpc('probeMedia', 'probe-media', ['pathArg']),
  rpc('deleteAsset', 'delete-asset'),
  rpc('updateAsset', 'update-asset'),
  rpc('listAssetCategories', 'list-asset-categories'),
  rpc('createAssetCategory', 'create-asset-category'),
  rpc('renameAssetCategory', 'rename-asset-category'),
  rpc('deleteAssetCategory', 'delete-asset-category'),
  rpc('assetRefs', 'asset-refs'),
  rpc('listTrash', 'list-trash'),
  rpc('restoreAsset', 'restore-asset'),
  rpc('emptyTrash', 'empty-trash'),
  rpc('archiveProducts', 'archive-products', ['pathArg']),
  rpc('listArchivableProducts', 'list-archivable-products'),
  rpc('listSkills', 'list-skills'),
  rpc('saveSkill', 'save-skill'),
  rpc('importSkill', 'import-skill', ['dialog']),
  rpc('applySkill', 'apply-skill'),
  rpc('deleteSkill', 'delete-skill'),
  rpc('skillRead', 'skill-read'),
  rpc('skillUpdate', 'skill-update'),
  rpc('skillActivate', 'skill-activate'),
  rpc('skillDeactivate', 'skill-deactivate'),
  rpc('skillActive', 'skill-active'),
  rpc('exportTimeline', 'export-timeline'),
  rpc('exportStatus', 'export-status'),
  rpc('exportFilePath', 'export-file-path', ['pathArg']),
  rpc('saveExportAs', 'save-export-as', ['dialog']),
  rpc('archiveExport', 'archive-export'),
  rpc('exportProjectPackage', 'export-project-package', ['dialog', 'large']),
  rpc('importProjectPackage', 'import-project-package', ['dialog']),
  rpc('extractFrame', 'extract-frame', ['pathArg']),
  rpc('extractAudio', 'extract-audio', ['pathArg']),
  rpc('cropImage', 'crop-image', ['pathArg']),
  rpc('stitchImages', 'stitch-images', ['pathArg']),
  rpc('splitImage', 'split-image', ['pathArg']),
  rpc('videoUpscale', 'video-upscale', ['pathArg', 'long']),
  rpc('videoPostProbe', 'video-post-probe'),
  rpc('videoPostRunning', 'video-post-running'),
  rpc('videoPostLastProgress', 'video-post-last-progress'),
  rpc('videoPostCancel', 'video-post-cancel'),
  rpc('revealInFinder', 'reveal-in-finder', ['dialog']),
  rpc('getSettings', 'get-settings'),
  rpc('setSettings', 'set-settings'),
  rpc('remoteAccessStatus', 'remote-access-status'),
  rpc('remoteAccessRotatePassphrase', 'remote-access-rotate-passphrase', ['desktopOnly', 'secret']),
  rpc('accelList', 'accel-list'),
  rpc('accelInstall', 'accel-install', ['pathArg']),
  rpc('accelRemove', 'accel-remove'),
  rpc('accelSetDefault', 'accel-set-default'),
  rpc('accelSetDefaultEnabled', 'accel-set-default-enabled'),
  rpc('accelGetDefaultEnabled', 'accel-get-default-enabled'),
  rpc('accelDefaultShotConfig', 'accel-default-shot-config'),
  rpc('styleModelStatus', 'style-model-status'),
  rpc('styleModelBuild', 'style-model-build', ['long']),
  rpc('styleModelCancel', 'style-model-cancel'),
  rpc('llmLocalModels', 'llm-local-models'),
  rpc('llmLoadModel', 'llm-load-model', ['long']),
  rpc('llmTestConnection', 'llm-test-connection'),
  rpc('llmListRemoteModels', 'llm-list-remote-models'),
  rpc('credentialSet', 'credential-set', ['secret']),
  rpc('credentialDelete', 'credential-delete', ['secret']),
  rpc('agentStatus', 'agent-status'),
  rpc('agentStart', 'agent-start'),
  rpc('agentStop', 'agent-stop'),
  rpc('agentPlan', 'agent-plan'),
  rpc('agentPlanStoryboard', 'agent-plan-storyboard'),
  rpc('agentChat', 'agent-chat'),
  rpc('agentCancel', 'agent-cancel'),
  rpc('memoryGet', 'memory-get'),
  rpc('memoryClear', 'memory-clear'),
  rpc('memoryCompact', 'memory-compact', ['long']),
  rpc('chatThreadsList', 'chat-threads-list'),
  rpc('chatThreadCreate', 'chat-thread-create'),
  rpc('chatThreadSwitch', 'chat-thread-switch'),
  rpc('chatThreadRename', 'chat-thread-rename'),
  rpc('chatThreadDelete', 'chat-thread-delete'),
  rpc('chatThreadMessages', 'chat-thread-messages'),
  rpc('chatThreadActive', 'chat-thread-active'),
  rpc('takesList', 'takes-list'),
  rpc('takesHistory', 'takes-history'),
  rpc('takesCreate', 'takes-create'),
  rpc('takesPatch', 'takes-patch'),
  rpc('takesDelete', 'takes-delete'),
  rpc('debugLogs', 'debug-logs'),
  rpc('debugClear', 'debug-clear'),
  event('onQueueChanged', 'render-queue-changed'),
  event('onCanvasSnapshotUpdated', 'canvas-snapshot-updated'),
  event('onVideoPostProgress', 'video-post-progress'),
  event('onStyleModelProgress', 'style-model-progress'),
  event('onAgentEvent', 'agent-event'),
  event('onDebugLog', 'debug-log'),
] satisfies readonly ApiCatalogEntry[];

type CatalogName = (typeof API_CATALOG)[number]['name'];
type MissingFromCatalog = Exclude<keyof BigBotArtApi, CatalogName>;
type ExtraInCatalog = Exclude<CatalogName, keyof BigBotArtApi>;
type AssertNever<T extends never> = T;
export type _ApiCatalogMissing = AssertNever<MissingFromCatalog>;
export type _ApiCatalogExtra = AssertNever<ExtraInCatalog>;

export function catalogByName(name: string): ApiCatalogEntry | undefined {
  return API_CATALOG.find((e) => e.name === name);
}

export const RPC_CATALOG = API_CATALOG.filter((e) => e.kind === 'rpc');
export const EVENT_CATALOG = API_CATALOG.filter((e) => e.kind === 'event');
