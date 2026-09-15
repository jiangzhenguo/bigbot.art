/**
 * Preload — 通过 contextBridge 暴露类型化 API 给渲染进程
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  BigBotArtApi,
  CanvasSnapshot,
  LlmSource,
  RenderRequest,
} from '@bigbotart/shared';

const api: BigBotArtApi = {
  probeRuntimes: () => ipcRenderer.invoke('probe-runtimes'),
  installRuntime: (id) => ipcRenderer.invoke('install-runtime', id),
  checkProviders: () => ipcRenderer.invoke('check-providers'),
  submitRender: (req: RenderRequest) => ipcRenderer.invoke('submit-render', req),
  renderStatus: (provider, handle) => ipcRenderer.invoke('render-status', provider, handle),
  cancelRender: (provider, handle) => ipcRenderer.invoke('cancel-render', provider, handle),
  queueStatus: () => ipcRenderer.invoke('queue-status'),
  listProjects: () => ipcRenderer.invoke('list-projects'),
  createProject: (name: string) => ipcRenderer.invoke('create-project', name),
  deleteProject: (id: string) => ipcRenderer.invoke('delete-project', id),
  renameProject: (id: string, name: string) => ipcRenderer.invoke('rename-project', id, name),
  loadCanvas: (projectId: string) => ipcRenderer.invoke('load-canvas', projectId),
  saveCanvas: (snapshot: CanvasSnapshot) => ipcRenderer.invoke('save-canvas', snapshot),
  loadProjectCanvases: (projectId: string) => ipcRenderer.invoke('load-project-canvases', projectId),
  saveCanvasSnapshot: (snapshot: CanvasSnapshot) => ipcRenderer.invoke('save-canvas-snapshot', snapshot),
  createCanvas: (projectId: string, name?: string) => ipcRenderer.invoke('create-canvas', projectId, name),
  renameCanvas: (projectId: string, canvasId: string, name: string) => ipcRenderer.invoke('rename-canvas', projectId, canvasId, name),
  deleteCanvas: (projectId: string, canvasId: string) => ipcRenderer.invoke('delete-canvas', projectId, canvasId),
  switchActiveCanvas: (projectId: string, canvasId: string) => ipcRenderer.invoke('switch-active-canvas', projectId, canvasId),
  setProjectLlm: (projectId: string, llm: LlmSource | null) => ipcRenderer.invoke('set-project-llm', projectId, llm),
  importAssets: (opts?: { paths?: string[] }) => ipcRenderer.invoke('import-assets', opts),
  listAssets: () => ipcRenderer.invoke('list-assets'),
  deleteAsset: (id: string) => ipcRenderer.invoke('delete-asset', id),
  listSkills: () => ipcRenderer.invoke('list-skills'),
  saveSkill: (input: { name: string; projectId: string }) => ipcRenderer.invoke('save-skill', input),
  applySkill: (skillId: string, projectName: string) => ipcRenderer.invoke('apply-skill', skillId, projectName),
  deleteSkill: (id: string) => ipcRenderer.invoke('delete-skill', id),
  exportTimeline: (req) => ipcRenderer.invoke('export-timeline', req),
  exportStatus: (taskId: string) => ipcRenderer.invoke('export-status', taskId),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
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
  agentChat: (req) => ipcRenderer.invoke('agent-chat', req),
  agentCancel: (projectId: string) => ipcRenderer.invoke('agent-cancel', projectId),
  onAgentEvent: (cb) => {
    const listener = (_e: unknown, ev: unknown) => cb(ev as never);
    ipcRenderer.on('agent-event', listener);
    return () => ipcRenderer.removeListener('agent-event', listener);
  },
  memoryGet: (projectId: string) => ipcRenderer.invoke('memory-get', projectId),
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