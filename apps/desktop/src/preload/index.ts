/**
 * Preload — 通过 contextBridge 暴露类型化 API 给渲染进程
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  BigBotArtApi,
  CanvasSnapshot,
  LlmSource,
  MediaKind,
  RenderRequest,
} from '@bigbotart/shared';

const api: BigBotArtApi = {
  probeRuntimes: () => ipcRenderer.invoke('probe-runtimes'),
  installRuntime: (id) => ipcRenderer.invoke('install-runtime', id),
  runSelfCheck: () => ipcRenderer.invoke('run-selfcheck'),
  mlxgenModels: () => ipcRenderer.invoke('mlxgen-models'),
  mlxgenDownload: (repoId: string) => ipcRenderer.invoke('mlxgen-download', repoId),
  mlxgenDownloadStatus: (jobId: string) => ipcRenderer.invoke('mlxgen-download-status', jobId),
  mlxgenDownloadActive: () => ipcRenderer.invoke('mlxgen-download-active'),
  mlxgenDownloadCancel: (jobId: string) => ipcRenderer.invoke('mlxgen-download-cancel', jobId),
  savePngAsset: (input: { name: string; dataUrl: string; projectId?: string; tags?: string[] }) =>
    ipcRenderer.invoke('save-png-asset', input),
  checkProviders: () => ipcRenderer.invoke('check-providers'),
  submitRender: (req: RenderRequest) => ipcRenderer.invoke('submit-render', req),
  renderStatus: (provider, handle) => ipcRenderer.invoke('render-status', provider, handle),
  cancelRender: (provider, handle) => ipcRenderer.invoke('cancel-render', provider, handle),
  queueStatus: () => ipcRenderer.invoke('queue-status'),
  onQueueChanged: (cb) => {
    const listener = (_e: unknown, jobs: unknown) => cb(jobs as never);
    ipcRenderer.on('render-queue-changed', listener);
    return () => ipcRenderer.removeListener('render-queue-changed', listener);
  },
  listProjects: () => ipcRenderer.invoke('list-projects'),
  createProject: (name: string) => ipcRenderer.invoke('create-project', name),
  deleteProject: (id: string) => ipcRenderer.invoke('delete-project', id),
  renameProject: (id: string, name: string) => ipcRenderer.invoke('rename-project', id, name),
  projectCover: (projectId: string) => ipcRenderer.invoke('project-cover', projectId),
  projectCovers: () => ipcRenderer.invoke('project-covers'),
  uploadProjectCover: (projectId: string) => ipcRenderer.invoke('upload-project-cover', projectId),
  clearProjectCover: (projectId: string) => ipcRenderer.invoke('clear-project-cover', projectId),
  loadCanvas: (projectId: string) => ipcRenderer.invoke('load-canvas', projectId),
  saveCanvas: (snapshot: CanvasSnapshot) => ipcRenderer.invoke('save-canvas', snapshot),
  loadProjectCanvases: (projectId: string) => ipcRenderer.invoke('load-project-canvases', projectId),
  saveCanvasSnapshot: (snapshot: CanvasSnapshot) => ipcRenderer.invoke('save-canvas-snapshot', snapshot),
  onCanvasSnapshotUpdated: (cb) => {
    const listener = (_e: unknown, snap: unknown) => cb(snap as never);
    ipcRenderer.on('canvas-snapshot-updated', listener);
    return () => ipcRenderer.removeListener('canvas-snapshot-updated', listener);
  },
  createCanvas: (projectId: string, name?: string) => ipcRenderer.invoke('create-canvas', projectId, name),
  renameCanvas: (projectId: string, canvasId: string, name: string) => ipcRenderer.invoke('rename-canvas', projectId, canvasId, name),
  deleteCanvas: (projectId: string, canvasId: string) => ipcRenderer.invoke('delete-canvas', projectId, canvasId),
  switchActiveCanvas: (projectId: string, canvasId: string) => ipcRenderer.invoke('switch-active-canvas', projectId, canvasId),
  setProjectLlm: (projectId: string, llm: LlmSource | null) => ipcRenderer.invoke('set-project-llm', projectId, llm),
  importAssets: (opts?: { paths?: string[]; projectId?: string }) => ipcRenderer.invoke('import-assets', opts),
  listAssets: (projectId?: string) => ipcRenderer.invoke('list-assets', projectId),
  // 🆕 媒体信息按需探测(资源节点检查器;只读,不回写资产库)
  probeMedia: (path: string, kind?: MediaKind) => ipcRenderer.invoke('probe-media', path, kind),
  deleteAsset: (id: string) => ipcRenderer.invoke('delete-asset', id),
  updateAsset: (id: string, patch: { name?: string; categoryId?: string | null; projectId?: string | null; tags?: string[] }) =>
    ipcRenderer.invoke('update-asset', id, patch),
  listAssetCategories: () => ipcRenderer.invoke('list-asset-categories'),
  createAssetCategory: (name: string, projectId?: string) => ipcRenderer.invoke('create-asset-category', name, projectId),
  renameAssetCategory: (id: string, name: string) => ipcRenderer.invoke('rename-asset-category', id, name),
  deleteAssetCategory: (id: string) => ipcRenderer.invoke('delete-asset-category', id),
  assetRefs: (assetId: string) => ipcRenderer.invoke('asset-refs', assetId),
  listTrash: () => ipcRenderer.invoke('list-trash'),
  restoreAsset: (id: string) => ipcRenderer.invoke('restore-asset', id),
  emptyTrash: () => ipcRenderer.invoke('empty-trash'),
  archiveProducts: (input: { projectId: string; items: Array<{ nodeId: string; path: string }>; categoryId?: string }) =>
    ipcRenderer.invoke('archive-products', input),
  listArchivableProducts: (projectId: string) => ipcRenderer.invoke('list-archivable-products', projectId),
  listSkills: () => ipcRenderer.invoke('list-skills'),
  saveSkill: (input: { name: string; projectId: string; canvasId?: string; instructions?: string; inject?: 'full' | 'summary' }) =>
    ipcRenderer.invoke('save-skill', input),
  applySkill: (skillId: string, projectName: string, activate?: boolean) =>
    ipcRenderer.invoke('apply-skill', skillId, projectName, activate),
  deleteSkill: (id: string) => ipcRenderer.invoke('delete-skill', id),
  skillRead: (skillId: string) => ipcRenderer.invoke('skill-read', skillId),
  skillUpdate: (skillId: string, patch: { name?: string; description?: string; instructions?: string | null; inject?: 'full' | 'summary' }) =>
    ipcRenderer.invoke('skill-update', skillId, patch),
  skillActivate: (projectId: string, canvasId: string, skillId: string) =>
    ipcRenderer.invoke('skill-activate', projectId, canvasId, skillId),
  skillDeactivate: (projectId: string, canvasId: string) => ipcRenderer.invoke('skill-deactivate', projectId, canvasId),
  skillActive: (projectId: string, canvasId: string) => ipcRenderer.invoke('skill-active', projectId, canvasId),
  exportTimeline: (req) => ipcRenderer.invoke('export-timeline', req),
  exportStatus: (taskId: string) => ipcRenderer.invoke('export-status', taskId),
  exportFilePath: (input: { name: string }) => ipcRenderer.invoke('export-file-path', input),
  saveExportAs: (input: { name: string }) => ipcRenderer.invoke('save-export-as', input),
  archiveExport: (input: { projectId: string; nodeId: string; name: string }) =>
    ipcRenderer.invoke('archive-export', input),
  exportProjectPackage: (req) => ipcRenderer.invoke('export-project-package', req),
  importProjectPackage: (input) => ipcRenderer.invoke('import-project-package', input),
  extractFrame: (videoPath, mode, seconds) => ipcRenderer.invoke('extract-frame', videoPath, mode, seconds),
  extractAudio: (videoPath) => ipcRenderer.invoke('extract-audio', videoPath),
  cropImage: (input: { path: string; aspect: string; focus?: 'center' | 'top' | 'bottom' | 'left' | 'right' }) =>
    ipcRenderer.invoke('crop-image', input),
  stitchImages: (input: { paths: string[]; mode: 'row' | 'column' | 'grid'; gridCols?: number; gap?: number; bg?: string }) =>
    ipcRenderer.invoke('stitch-images', input),
  splitImage: (input: { path: string; mode: 'rows' | 'cols' | 'grid'; count?: number; gridCols?: number; gridRows?: number }) =>
    ipcRenderer.invoke('split-image', input),
  // 🆕 视频增强(超分 + 合修脸):分钟级长任务,产物落 outputs/video-post/
  videoUpscale: (input) => ipcRenderer.invoke('video-upscale', input),
  videoPostProbe: () => ipcRenderer.invoke('video-post-probe'),
  videoPostRunning: () => ipcRenderer.invoke('video-post-running'),
  videoPostLastProgress: () => ipcRenderer.invoke('video-post-last-progress'),
  onVideoPostProgress: (cb) => {
    const listener = (_e: unknown, p: unknown) => cb(p as never);
    ipcRenderer.on('video-post-progress', listener);
    return () => ipcRenderer.removeListener('video-post-progress', listener);
  },
  revealInFinder: (target: { path: string }) => ipcRenderer.invoke('reveal-in-finder', target),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  accelList: () => ipcRenderer.invoke('accel-list'),
  accelInstall: (input) => ipcRenderer.invoke('accel-install', input),
  accelRemove: (id) => ipcRenderer.invoke('accel-remove', id),
  accelSetDefault: (id) => ipcRenderer.invoke('accel-set-default', id),
  accelSetDefaultEnabled: (enabled) => ipcRenderer.invoke('accel-set-default-enabled', enabled),
  accelGetDefaultEnabled: () => ipcRenderer.invoke('accel-get-default-enabled'),
  accelDefaultShotConfig: () => ipcRenderer.invoke('accel-default-shot-config'),
  llmLocalModels: (kind: 'lmstudio' | 'ollama' | 'pimlx') => ipcRenderer.invoke('llm-local-models', kind),
  llmLoadModel: (kind: 'lmstudio' | 'ollama' | 'pimlx', modelId: string) =>
    ipcRenderer.invoke('llm-load-model', kind, modelId),
  llmTestConnection: (input: { baseUrl: string; apiKey?: string; providerId?: string }) =>
    ipcRenderer.invoke('llm-test-connection', input),
  llmListRemoteModels: (input: { baseUrl: string; apiKey?: string; providerId?: string }) =>
    ipcRenderer.invoke('llm-list-remote-models', input),
  credentialSet: (providerId: string, apiKey: string) =>
    ipcRenderer.invoke('credential-set', providerId, apiKey),
  credentialDelete: (providerId: string) => ipcRenderer.invoke('credential-delete', providerId),
  agentStatus: () => ipcRenderer.invoke('agent-status'),
  agentStart: (modelSource?: LlmSource) => ipcRenderer.invoke('agent-start', modelSource),
  agentStop: () => ipcRenderer.invoke('agent-stop'),
  agentPlan: (brief, opts) => ipcRenderer.invoke('agent-plan', brief, opts),
  agentPlanStoryboard: (brief, opts) => ipcRenderer.invoke('agent-plan-storyboard', brief, opts),
  agentChat: (req) => ipcRenderer.invoke('agent-chat', req),
  agentCancel: (projectId: string) => ipcRenderer.invoke('agent-cancel', projectId),
  onAgentEvent: (cb) => {
    const listener = (_e: unknown, ev: unknown) => cb(ev as never);
    ipcRenderer.on('agent-event', listener);
    return () => ipcRenderer.removeListener('agent-event', listener);
  },
  memoryGet: (projectId: string) => ipcRenderer.invoke('memory-get', projectId),
  memoryClear: (projectId: string, canvasId: string) => ipcRenderer.invoke('memory-clear', projectId, canvasId),
  memoryCompact: (projectId: string, canvasId: string) => ipcRenderer.invoke('memory-compact', projectId, canvasId),
  takesList: (projectId: string) => ipcRenderer.invoke('takes-list', projectId),
  takesHistory: (projectId: string, shotNodeId: string, currentTakeId?: string) =>
    ipcRenderer.invoke('takes-history', projectId, shotNodeId, currentTakeId),
  takesCreate: (projectId: string, partial) => ipcRenderer.invoke('takes-create', projectId, partial),
  takesPatch: (projectId: string, takeId: string, patch) =>
    ipcRenderer.invoke('takes-patch', projectId, takeId, patch),
  takesDelete: (projectId: string, takeId: string) => ipcRenderer.invoke('takes-delete', projectId, takeId),
  debugLogs: () => ipcRenderer.invoke('debug-logs'),
  debugClear: () => ipcRenderer.invoke('debug-clear'),
  onDebugLog: (cb) => {
    const listener = (_e: unknown, entry: unknown) => cb(entry as never);
    ipcRenderer.on('debug-log', listener);
    return () => ipcRenderer.removeListener('debug-log', listener);
  },
};

contextBridge.exposeInMainWorld('bigbotart', api);

export type { BigBotArtApi }; // 仅为类型