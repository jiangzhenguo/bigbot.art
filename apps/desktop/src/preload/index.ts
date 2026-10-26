/**
 * Preload — 通过 contextBridge 暴露类型化 API 给渲染进程
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  API_CATALOG,
  type BigBotArtApi,
  type CanvasSaveOptions,
  type CanvasSnapshot,
  type LlmSource,
  type MediaKind,
  type RenderRequest,
} from '@bigbotart/shared';

function ch(name: keyof BigBotArtApi): string {
  const entry = API_CATALOG.find((e) => e.name === name);
  if (!entry) throw new Error(`目录里没有 ${name}`);
  return entry.ipcChannel;
}

const api: BigBotArtApi = {
  probeRuntimes: () => ipcRenderer.invoke(ch('probeRuntimes')),
  installRuntime: (id) => ipcRenderer.invoke(ch('installRuntime'), id),
  runSelfCheck: () => ipcRenderer.invoke(ch('runSelfCheck')),
  mlxgenModels: () => ipcRenderer.invoke(ch('mlxgenModels')),
  mlxgenDownload: (repoId: string) => ipcRenderer.invoke(ch('mlxgenDownload'), repoId),
  mlxgenDownloadStatus: (jobId: string) => ipcRenderer.invoke(ch('mlxgenDownloadStatus'), jobId),
  mlxgenDownloadActive: () => ipcRenderer.invoke(ch('mlxgenDownloadActive')),
  mlxgenDownloadCancel: (jobId: string) => ipcRenderer.invoke(ch('mlxgenDownloadCancel'), jobId),
  savePngAsset: (input: { name: string; dataUrl: string; projectId?: string; tags?: string[] }) =>
    ipcRenderer.invoke(ch('savePngAsset'), input),
  checkProviders: () => ipcRenderer.invoke(ch('checkProviders')),
  submitRender: (req: RenderRequest) => ipcRenderer.invoke(ch('submitRender'), req),
  renderStatus: (provider, handle) => ipcRenderer.invoke(ch('renderStatus'), provider, handle),
  cancelRender: (provider, handle) => ipcRenderer.invoke(ch('cancelRender'), provider, handle),
  queueStatus: () => ipcRenderer.invoke(ch('queueStatus')),
  onQueueChanged: (cb) => {
    const listener = (_e: unknown, jobs: unknown) => cb(jobs as never);
    ipcRenderer.on(ch('onQueueChanged'), listener);
    return () => ipcRenderer.removeListener('render-queue-changed', listener);
  },
  listProjects: () => ipcRenderer.invoke(ch('listProjects')),
  createProject: (name: string) => ipcRenderer.invoke(ch('createProject'), name),
  deleteProject: (id: string) => ipcRenderer.invoke(ch('deleteProject'), id),
  renameProject: (id: string, name: string) => ipcRenderer.invoke(ch('renameProject'), id, name),
  projectCover: (projectId: string) => ipcRenderer.invoke(ch('projectCover'), projectId),
  projectCovers: () => ipcRenderer.invoke(ch('projectCovers')),
  uploadProjectCover: (projectId: string) => ipcRenderer.invoke(ch('uploadProjectCover'), projectId),
  clearProjectCover: (projectId: string) => ipcRenderer.invoke(ch('clearProjectCover'), projectId),
  loadCanvas: (projectId: string) => ipcRenderer.invoke(ch('loadCanvas'), projectId),
  saveCanvas: (snapshot: CanvasSnapshot) => ipcRenderer.invoke(ch('saveCanvas'), snapshot),
  loadProjectCanvases: (projectId: string) => ipcRenderer.invoke(ch('loadProjectCanvases'), projectId),
  saveCanvasSnapshot: (snapshot: CanvasSnapshot, opts?: CanvasSaveOptions) =>
    ipcRenderer.invoke(ch('saveCanvasSnapshot'), snapshot, opts),
  onCanvasSnapshotUpdated: (cb) => {
    const listener = (_e: unknown, snap: unknown) => cb(snap as never);
    ipcRenderer.on(ch('onCanvasSnapshotUpdated'), listener);
    return () => ipcRenderer.removeListener('canvas-snapshot-updated', listener);
  },
  createCanvas: (projectId: string, name?: string) => ipcRenderer.invoke(ch('createCanvas'), projectId, name),
  renameCanvas: (projectId: string, canvasId: string, name: string) => ipcRenderer.invoke(ch('renameCanvas'), projectId, canvasId, name),
  deleteCanvas: (projectId: string, canvasId: string) => ipcRenderer.invoke(ch('deleteCanvas'), projectId, canvasId),
  switchActiveCanvas: (projectId: string, canvasId: string) => ipcRenderer.invoke(ch('switchActiveCanvas'), projectId, canvasId),
  setProjectLlm: (projectId: string, llm: LlmSource | null) => ipcRenderer.invoke(ch('setProjectLlm'), projectId, llm),
  importAssets: (opts?: { paths?: string[]; projectId?: string }) => ipcRenderer.invoke(ch('importAssets'), opts),
  listAssets: (projectId?: string) => ipcRenderer.invoke(ch('listAssets'), projectId),
  // 🆕 媒体信息按需探测(资源节点检查器;只读,不回写资产库)
  probeMedia: (path: string, kind?: MediaKind) => ipcRenderer.invoke(ch('probeMedia'), path, kind),
  deleteAsset: (id: string) => ipcRenderer.invoke(ch('deleteAsset'), id),
  updateAsset: (
    id: string,
    patch: {
      name?: string;
      caption?: string | null;
      categoryId?: string | null;
      projectId?: string | null;
      tags?: string[];
    },
  ) => ipcRenderer.invoke(ch('updateAsset'), id, patch),
  listAssetCategories: () => ipcRenderer.invoke(ch('listAssetCategories')),
  createAssetCategory: (name: string, projectId?: string) => ipcRenderer.invoke(ch('createAssetCategory'), name, projectId),
  renameAssetCategory: (id: string, name: string) => ipcRenderer.invoke(ch('renameAssetCategory'), id, name),
  deleteAssetCategory: (id: string) => ipcRenderer.invoke(ch('deleteAssetCategory'), id),
  assetRefs: (assetId: string) => ipcRenderer.invoke(ch('assetRefs'), assetId),
  listTrash: () => ipcRenderer.invoke(ch('listTrash')),
  restoreAsset: (id: string) => ipcRenderer.invoke(ch('restoreAsset'), id),
  emptyTrash: () => ipcRenderer.invoke(ch('emptyTrash')),
  archiveProducts: (input: {
    projectId: string;
    items: Array<{ nodeId: string; path: string; name?: string; caption?: string }>;
    categoryId?: string;
  }) => ipcRenderer.invoke(ch('archiveProducts'), input),
  listArchivableProducts: (projectId: string) => ipcRenderer.invoke(ch('listArchivableProducts'), projectId),
  listSkills: () => ipcRenderer.invoke(ch('listSkills')),
  saveSkill: (input: { name: string; projectId: string; canvasId?: string; instructions?: string; inject?: 'full' | 'summary' }) =>
    ipcRenderer.invoke(ch('saveSkill'), input),
  // 本地技能文档导入;preload 只在主进程重载后暴露给渲染层
  importSkill: () => ipcRenderer.invoke(ch('importSkill')),
  applySkill: (
    skillId: string,
    projectName: string,
    activate?: boolean,
    paramValues?: Record<string, string>,
  ) => ipcRenderer.invoke(ch('applySkill'), skillId, projectName, activate, paramValues),
  deleteSkill: (id: string) => ipcRenderer.invoke(ch('deleteSkill'), id),
  skillRead: (skillId: string) => ipcRenderer.invoke(ch('skillRead'), skillId),
  skillUpdate: (skillId: string, patch: { name?: string; description?: string; instructions?: string | null; inject?: 'full' | 'summary' }) =>
    ipcRenderer.invoke(ch('skillUpdate'), skillId, patch),
  skillActivate: (
    projectId: string,
    canvasId: string,
    skillId: string,
    paramValues?: Record<string, string>,
  ) => ipcRenderer.invoke(ch('skillActivate'), projectId, canvasId, skillId, paramValues),
  skillDeactivate: (projectId: string, canvasId: string) => ipcRenderer.invoke(ch('skillDeactivate'), projectId, canvasId),
  skillActive: (projectId: string, canvasId: string) => ipcRenderer.invoke(ch('skillActive'), projectId, canvasId),
  exportTimeline: (req) => ipcRenderer.invoke(ch('exportTimeline'), req),
  exportStatus: (taskId: string) => ipcRenderer.invoke(ch('exportStatus'), taskId),
  exportFilePath: (input: { name: string }) => ipcRenderer.invoke(ch('exportFilePath'), input),
  saveExportAs: (input: { name: string }) => ipcRenderer.invoke(ch('saveExportAs'), input),
  archiveExport: (input: { projectId: string; nodeId: string; name: string }) =>
    ipcRenderer.invoke(ch('archiveExport'), input),
  exportProjectPackage: (req) => ipcRenderer.invoke(ch('exportProjectPackage'), req),
  importProjectPackage: (input) => ipcRenderer.invoke(ch('importProjectPackage'), input),
  extractFrame: (videoPath, mode, seconds) => ipcRenderer.invoke(ch('extractFrame'), videoPath, mode, seconds),
  extractAudio: (videoPath) => ipcRenderer.invoke(ch('extractAudio'), videoPath),
  cropImage: (input: { path: string; aspect: string; focus?: 'center' | 'top' | 'bottom' | 'left' | 'right' }) =>
    ipcRenderer.invoke(ch('cropImage'), input),
  stitchImages: (input: { paths: string[]; mode: 'row' | 'column' | 'grid'; gridCols?: number; gap?: number; bg?: string }) =>
    ipcRenderer.invoke(ch('stitchImages'), input),
  splitImage: (input: { path: string; mode: 'rows' | 'cols' | 'grid'; count?: number; gridCols?: number; gridRows?: number }) =>
    ipcRenderer.invoke(ch('splitImage'), input),
  // 🆕 视频增强(超分 + 合修脸):分钟级长任务,产物落 outputs/video-post/
  videoUpscale: (input) => ipcRenderer.invoke(ch('videoUpscale'), input),
  videoPostProbe: () => ipcRenderer.invoke(ch('videoPostProbe')),
  videoPostRunning: () => ipcRenderer.invoke(ch('videoPostRunning')),
  videoPostLastProgress: () => ipcRenderer.invoke(ch('videoPostLastProgress')),
  videoPostCancel: (input) => ipcRenderer.invoke(ch('videoPostCancel'), input),
  onVideoPostProgress: (cb) => {
    const listener = (_e: unknown, p: unknown) => cb(p as never);
    ipcRenderer.on(ch('onVideoPostProgress'), listener);
    return () => ipcRenderer.removeListener('video-post-progress', listener);
  },
  revealInFinder: (target: { path: string }) => ipcRenderer.invoke(ch('revealInFinder'), target),
  getSettings: () => ipcRenderer.invoke(ch('getSettings')),
  setSettings: (patch) => ipcRenderer.invoke(ch('setSettings'), patch),
  remoteAccessStatus: () => ipcRenderer.invoke(ch('remoteAccessStatus')),
  remoteAccessRotatePassphrase: () => ipcRenderer.invoke(ch('remoteAccessRotatePassphrase')),
  relaySetPairingKey: (key: string) => ipcRenderer.invoke(ch('relaySetPairingKey'), key),
  accelList: () => ipcRenderer.invoke(ch('accelList')),
  accelPickSource: (source) => ipcRenderer.invoke(ch('accelPickSource'), source),
  accelInstall: (input) => ipcRenderer.invoke(ch('accelInstall'), input),
  accelInstallLora: (input) => ipcRenderer.invoke(ch('accelInstallLora'), input),
  accelRemove: (id) => ipcRenderer.invoke(ch('accelRemove'), id),
  accelSetDefault: (id) => ipcRenderer.invoke(ch('accelSetDefault'), id),
  accelSetDefaultEnabled: (enabled) => ipcRenderer.invoke(ch('accelSetDefaultEnabled'), enabled),
  accelGetDefaultEnabled: () => ipcRenderer.invoke(ch('accelGetDefaultEnabled')),
  accelDefaultShotConfig: () => ipcRenderer.invoke(ch('accelDefaultShotConfig')),
  styleModelStatus: (packId: string) => ipcRenderer.invoke(ch('styleModelStatus'), packId),
  styleModelBuild: (packId: string) => ipcRenderer.invoke(ch('styleModelBuild'), packId),
  styleModelCancel: () => ipcRenderer.invoke(ch('styleModelCancel')),
  onStyleModelProgress: (cb) => {
    const listener = (_e: unknown, ev: unknown) => cb(ev as never);
    ipcRenderer.on(ch('onStyleModelProgress'), listener);
    return () => ipcRenderer.removeListener('style-model-progress', listener);
  },
  llmLocalModels: (kind: 'lmstudio' | 'ollama' | 'pimlx') => ipcRenderer.invoke(ch('llmLocalModels'), kind),
  llmLoadModel: (kind: 'lmstudio' | 'ollama' | 'pimlx', modelId: string) =>
    ipcRenderer.invoke(ch('llmLoadModel'), kind, modelId),
  llmTestConnection: (input: { baseUrl: string; apiKey?: string; providerId?: string }) =>
    ipcRenderer.invoke(ch('llmTestConnection'), input),
  llmListRemoteModels: (input: { baseUrl: string; apiKey?: string; providerId?: string }) =>
    ipcRenderer.invoke(ch('llmListRemoteModels'), input),
  credentialSet: (providerId: string, apiKey: string) =>
    ipcRenderer.invoke(ch('credentialSet'), providerId, apiKey),
  credentialDelete: (providerId: string) => ipcRenderer.invoke(ch('credentialDelete'), providerId),
  agentStatus: () => ipcRenderer.invoke(ch('agentStatus')),
  agentStart: (modelSource?: LlmSource) => ipcRenderer.invoke(ch('agentStart'), modelSource),
  agentStop: () => ipcRenderer.invoke(ch('agentStop')),
  agentPlan: (brief, opts) => ipcRenderer.invoke(ch('agentPlan'), brief, opts),
  agentPlanStoryboard: (brief, opts) => ipcRenderer.invoke(ch('agentPlanStoryboard'), brief, opts),
  agentChat: (req) => ipcRenderer.invoke(ch('agentChat'), req),
  agentCancel: (projectId: string) => ipcRenderer.invoke(ch('agentCancel'), projectId),
  onAgentEvent: (cb) => {
    const listener = (_e: unknown, ev: unknown) => cb(ev as never);
    ipcRenderer.on(ch('onAgentEvent'), listener);
    return () => ipcRenderer.removeListener('agent-event', listener);
  },
  memoryGet: (projectId: string) => ipcRenderer.invoke(ch('memoryGet'), projectId),
  memoryClear: (projectId: string, canvasId: string) => ipcRenderer.invoke(ch('memoryClear'), projectId, canvasId),
  memoryCompact: (projectId: string, canvasId: string) => ipcRenderer.invoke(ch('memoryCompact'), projectId, canvasId),
  chatThreadsList: (projectId: string, canvasId: string) =>
    ipcRenderer.invoke(ch('chatThreadsList'), projectId, canvasId),
  chatThreadCreate: (projectId: string, canvasId: string, opts?) =>
    ipcRenderer.invoke(ch('chatThreadCreate'), projectId, canvasId, opts),
  chatThreadSwitch: (projectId: string, canvasId: string, threadId: string) =>
    ipcRenderer.invoke(ch('chatThreadSwitch'), projectId, canvasId, threadId),
  chatThreadRename: (projectId: string, threadId: string, title: string) =>
    ipcRenderer.invoke(ch('chatThreadRename'), projectId, threadId, title),
  chatThreadDelete: (projectId: string, threadId: string) =>
    ipcRenderer.invoke(ch('chatThreadDelete'), projectId, threadId),
  chatThreadMessages: (projectId: string, threadId: string) =>
    ipcRenderer.invoke(ch('chatThreadMessages'), projectId, threadId),
  chatThreadActive: (projectId: string, canvasId: string) =>
    ipcRenderer.invoke(ch('chatThreadActive'), projectId, canvasId),
  takesList: (projectId: string) => ipcRenderer.invoke(ch('takesList'), projectId),
  takesHistory: (projectId: string, shotNodeId: string, currentTakeId?: string) =>
    ipcRenderer.invoke(ch('takesHistory'), projectId, shotNodeId, currentTakeId),
  takesCreate: (projectId: string, partial) => ipcRenderer.invoke(ch('takesCreate'), projectId, partial),
  takesPatch: (projectId: string, takeId: string, patch) =>
    ipcRenderer.invoke(ch('takesPatch'), projectId, takeId, patch),
  takesDelete: (projectId: string, takeId: string) => ipcRenderer.invoke(ch('takesDelete'), projectId, takeId),
  debugLogs: () => ipcRenderer.invoke(ch('debugLogs')),
  debugClear: () => ipcRenderer.invoke(ch('debugClear')),
  onDebugLog: (cb) => {
    const listener = (_e: unknown, entry: unknown) => cb(entry as never);
    ipcRenderer.on(ch('onDebugLog'), listener);
    return () => ipcRenderer.removeListener('debug-log', listener);
  },
};

contextBridge.exposeInMainWorld('bigbotart', api);
contextBridge.exposeInMainWorld('bigbotartShell', true);

export type { BigBotArtApi }; // 仅为类型