/**
 * 引擎/运行时探测状态(引导向导用)
 */

export interface RuntimeProbe {
  id: 'lmstudio' | 'ollama' | 'mlxgen' | 'h3c' | 'comfyui';
  label: string;
  detected: boolean;
  version?: string;
  path?: string;
  port?: number;
  status: 'ready' | 'missing' | 'error';
  detail?: string;
}

/**
 * 引擎自检项(引导向导第 4 步;主进程真实探测,非 UI 动画)
 * 每项独立判定:单项失败不影响其余项
 */
export interface SelfCheckItem {
  id: 'h3c' | 'mlxgen' | 'llm' | 'storage';
  label: string;
  ok: boolean;
  /** 真实探测结果摘要(GPU / 版本 / 端点 / 路径等) */
  detail: string;
  /** 失败时的可执行修复指引(ok=true 时缺省) */
  hint?: string;
  /** 该项实际耗时(ms,真实测量值) */
  ms: number;
}

/** 自检汇总报告 */
export interface SelfCheckReport {
  items: SelfCheckItem[];
  passed: number;
  total: number;
}

/** pi Agent 子进程健康状态 */
export interface AgentProcessState {
  running: boolean;
  pid?: number;
  startedAt?: string;
  lastHeartbeat?: string;
  version?: string;
  error?: string;
}

/** IPC 通道契约(主进程 ↔ 渲染进程) */
export interface BigBotArtApi {
  // 引擎引导
  probeRuntimes(): Promise<RuntimeProbe[]>;
  installRuntime(id: string): Promise<{ ok: boolean; message: string }>;
  /** 引擎自检(引导向导第 4 步):主进程真实探测 h3.c / mlxgen / LLM 工具回环 / 数据目录 */
  runSelfCheck(): Promise<SelfCheckReport>;
  // 图片引擎模型管理(mlxgen:已下载探测 / 真实下载 / 下载进度轮询)
  mlxgenModels(): Promise<Array<{ id: string; name: string; repoId: string; downloaded: boolean }>>;
  mlxgenDownload(repoId: string): Promise<{ ok: boolean; jobId?: string; error?: string }>;
  mlxgenDownloadStatus(jobId: string): Promise<{ status: 'running' | 'done' | 'failed' | 'cancelled'; pct?: number | null; error?: string }>;
  /** 进行中的下载任务清单(设置页进入时恢复进度轮询;id 为主进程已知模型 id) */
  mlxgenDownloadActive(): Promise<Array<{ id: string; jobId: string; pct: number | null }>>;
  /** 取消进行中的下载;保留 .part/.incomplete 支持断点续传,取消后任务释放、可重新下载 */
  mlxgenDownloadCancel(jobId: string): Promise<{ ok: boolean; error?: string }>;
  /** base64 dataURL PNG/JPEG/WebP → 资产库(检查器画遮罩生成 mask 用);返回新资产 id */
  savePngAsset(input: { name: string; dataUrl: string; projectId?: string; tags?: string[] }): Promise<{ ok: boolean; assetId?: string; error?: string }>;
  // Provider / 渲染任务
  checkProviders(): Promise<Record<string, import('./provider').ProviderStatus>>;
  submitRender(req: import('./provider').RenderRequest): Promise<import('./provider').RenderJobHandle>;
  renderStatus(provider: string, handle: { providerTaskId: string }): Promise<import('./provider').RenderStatus>;
  cancelRender(provider: string, handle: { providerTaskId: string }): Promise<void>;
  /** 渲染队列:当前全部任务(含排队位置/进度) */
  queueStatus(): Promise<import('./domain').RenderJob[]>;
  /** 渲染队列变更推送(主进程同 tick 去抖合并,推送精简视图;返回退订函数;首次全量用 queueStatus()) */
  onQueueChanged(cb: (jobs: import('./domain').RenderJob[]) => void): () => void;
  // 项目 / 画布
  listProjects(): Promise<import('./domain').Project[]>;
  createProject(name: string): Promise<import('./domain').Project>;
  deleteProject(id: string): Promise<{ ok: boolean; error?: string }>;
  renameProject(id: string, name: string): Promise<{ ok: boolean; error?: string }>;
  loadCanvas(projectId: string): Promise<import('./domain').CanvasSnapshot>;
  saveCanvas(snapshot: import('./domain').CanvasSnapshot): Promise<{ ok: boolean; stale?: boolean; current?: import('./domain').CanvasSnapshot }>;
  /** 项目级 LLM 覆盖(null 清除,回退全局) */
  setProjectLlm(projectId: string, llm: import('./domain').LlmSource | null): Promise<{ ok: boolean }>;
  /** 加载项目下所有画布 + 活动画布 id(一次拉完,前端切换无往返) */
  loadProjectCanvases(projectId: string): Promise<import('./domain').ProjectCanvases>;
  /** 保存单画布快照(自动写回项目容器)。
   *  版本防护:当 snap.version 落后于 store 当前版本(如 Agent 工具已增量写盘、渲染层状态未同步)时
   *  拒绝整体覆盖,返回 stale=true + 最新 current,由渲染层刷新后再保存,避免吞掉 Agent 的改动。 */
  saveCanvasSnapshot(
    snap: import('./domain').CanvasSnapshot,
    opts?: import('./domain').CanvasSaveOptions,
  ): Promise<{ ok: boolean; stale?: boolean; current?: import('./domain').CanvasSnapshot }>;
  /**
   * 整理画布节点坐标(只改 x/y)。主进程落盘并广播快照。
   * scope=selected 时只移动 selectedIds;缺省 scope=all。
   */
  tidyCanvas(input: {
    projectId: string;
    canvasId: string;
    scope?: 'all' | 'selected';
    selectedIds?: string[];
    gap?: number;
  }): Promise<{ ok: boolean; moved?: number; error?: string; bbox?: { x: number; y: number; w: number; h: number } }>;
  /** 画布快照更新推送(主进程任何写盘后广播,含 Agent 工具增量;渲染层据此刷新本地状态保持同步) */
  onCanvasSnapshotUpdated(cb: (snap: import('./domain').CanvasSnapshot) => void): () => void;
  /** 创建一个新画布(空白),返回画布;持久化并设为主画布(若项目无画布) */
  createCanvas(projectId: string, name?: string): Promise<import('./domain').CanvasSnapshot>;
  /** 重命名画布 */
  renameCanvas(projectId: string, canvasId: string, name: string): Promise<{ ok: boolean; error?: string }>;
  /** 删除画布(至少保留 1 个);若删的是 active,自动切换到剩余第一个 */
  deleteCanvas(projectId: string, canvasId: string): Promise<{ ok: boolean; error?: string }>;
  /** 切换活动画布;只改 active 指针,不返回画布内容(前端已持有完整列表) */
  switchActiveCanvas(projectId: string, canvasId: string): Promise<{ ok: boolean }>;
  // 项目封面(首页/项目页卡片;取代此前写死的静态占位图)
  /**
   * 解析单项目封面。自动封面 = 画布「第一个产图节点」的产物(图片优先,视频抽首帧兜底);
   * 手动封面 = 用户上传的图。路径由主进程校验磁盘存在性,渲染层直接渲染。
   */
  projectCover(projectId: string): Promise<import('./domain').ProjectCover>;
  /** 批量解析全部项目封面(首页/项目页一次拉完,避免 N 次 IPC) */
  projectCovers(): Promise<import('./domain').ProjectCover[]>;
  /**
   * 弹系统对话框选一张本地图片设为项目封面(拷贝进项目资源库后登记为 `coverAssetId`)。
   * 取消返回 canceled=true。
   */
  uploadProjectCover(projectId: string): Promise<{ ok: boolean; canceled?: boolean; cover?: import('./domain').ProjectCover; error?: string }>;
  /** 清除手动封面 → 回到自动(跟随首图节点) */
  clearProjectCover(projectId: string): Promise<{ ok: boolean; cover?: import('./domain').ProjectCover; error?: string }>;
  // 资产中心
  /** 导入资产:paths 给定时走白名单 headless;缺省弹系统对话框。projectId 给定时归入项目视图 */
  importAssets(opts?: { paths?: string[]; projectId?: string }): Promise<import('./domain').AssetImportResult>;
  /** 列资产:projectId 给定 = 项目视图(该项目的资源);缺省 = 总资源库(全部) */
  listAssets(projectId?: string): Promise<import('./domain').Asset[]>;
  /**
   * 探测本地媒体的基本信息(ffprobe:图片宽高 / 视频时长·分辨率·帧率 / 音频时长·采样率)。
   *
   * 只读、按需 —— 检查器选中资源节点时调一次。**不回写资产库**,故可随时重探;
   * 历史资产(导入时没探过 fps/采样率)也一视同仁能拿到完整信息。
   * 路径必须在应用数据/产物/导出白名单内(与 frames / vision 同口径),否则返回 `ok:false`。
   */
  probeMedia(path: string, kind?: import('./domain').MediaKind): Promise<import('./domain').MediaInfo>;
  /** 软删除 → 回收站(文件移入 trash,7 天后清理);被画布引用时返回引用列表供前端展示警告 */
  deleteAsset(id: string): Promise<{ ok: boolean; error?: string; refs?: import('./domain').AssetRef[] }>;
  /** 资源更新:重命名 / 文案 caption / 改分类(null=未分类) / 改归属(null=总资源库) / 改标签 */
  updateAsset(
    id: string,
    patch: import('./domain').AssetUpdatePatch,
  ): Promise<{ ok: boolean; error?: string }>;
  /** 分类字典(项目分类 + 全局分类;过滤由渲染层按 projectId 做) */
  listAssetCategories(): Promise<import('./domain').AssetCategory[]>;
  createAssetCategory(name: string, projectId?: string): Promise<import('./domain').AssetCategory>;
  renameAssetCategory(id: string, name: string): Promise<{ ok: boolean; error?: string }>;
  /** 删除分类:分类下资源转「未分类」,原资源文件保留 */
  deleteAssetCategory(id: string): Promise<{ ok: boolean; error?: string }>;
  /** 资源被画布引用位置(删除安全警告 / 「定位画布」) */
  assetRefs(assetId: string): Promise<import('./domain').AssetRef[]>;
  /** 回收站:软删资源列表(最新在前) */
  listTrash(): Promise<import('./domain').Asset[]>;
  restoreAsset(id: string): Promise<{ ok: boolean; error?: string }>;
  emptyTrash(): Promise<{ ok: boolean }>;
  /** 画布产物归档:复制产物文件进资产库并登记(source='product',归入 projectId)。name/caption 可选,缺省用文件名、不写文案 */
  archiveProducts(input: {
    projectId: string;
    items: Array<{ nodeId: string; path: string; name?: string; caption?: string }>;
    categoryId?: string;
  }): Promise<{ ok: boolean; assets: import('./domain').Asset[]; error?: string }>;
  /** 列项目画布中「有产物」的节点(「从画布产物导入」弹层的候选项) */
  listArchivableProducts(projectId: string): Promise<Array<{ nodeId: string; name: string; path: string; meta: string }>>;
  // Skills 库(画布模板 + Agent 指令段双形态;激活状态持久化在 canvasMemory,见 docs/Agent技能-指令模板与对话自动加载-产品设计与技术方案.md)
  listSkills(): Promise<import('./domain').Skill[]>;
  saveSkill(input: { name: string; projectId: string; canvasId?: string; instructions?: string; inject?: 'full' | 'summary' }): Promise<import('./domain').Skill>;
  /** 从本地技能文件夹或 .zip 包导入到「我的 Skill」 */
  importSkill(): Promise<
    | { ok: true; skill: import('./domain').Skill; skills: import('./domain').Skill[] }
    | { ok: false; canceled?: boolean; error?: string }
  >;
  applySkill(
    skillId: string,
    projectName: string,
    activate?: boolean,
    /** Skills 页「参数化字段」填值;键为 `{name}` 或裸名 */
    paramValues?: Record<string, string>,
  ): Promise<{ project: import('./domain').Project }>;
  deleteSkill(id: string): Promise<{ ok: boolean; error?: string }>;
  /** 读单个技能完整定义(含操作指令段;summary 模式按需取全文) */
  skillRead(skillId: string): Promise<import('./domain').Skill | null>;
  /** 更新技能元信息/指令段(指令编辑器;不动画布模板) */
  skillUpdate(skillId: string, patch: { name?: string; description?: string; instructions?: string | null; inject?: 'full' | 'summary' }): Promise<{ ok: boolean; skill?: import('./domain').Skill; error?: string }>;
  /** 激活技能到指定画布(同一画布至多一个;激活后对话自动注入指令段);paramValues 写入画布记忆并在注入前替换占位 */
  skillActivate(
    projectId: string,
    canvasId: string,
    skillId: string,
    paramValues?: Record<string, string>,
  ): Promise<{ ok: boolean; preview?: string; hasInstructions?: boolean; error?: string }>;
  /** 停用画布技能 */
  skillDeactivate(projectId: string, canvasId: string): Promise<{ ok: boolean }>;
  /** 查询画布当前激活技能(进入页面恢复 chip/注入卡;未激活返回 null) */
  skillActive(projectId: string, canvasId: string): Promise<{ skillId: string; name: string; inject?: 'full' | 'summary' } | null>;
  // 时间线导出(FFmpeg)
  exportTimeline(req: import('./domain').TimelineExportRequest): Promise<{ ok: boolean; taskId?: string; error?: string }>;
  exportStatus(taskId: string): Promise<import('./domain').ExportTask>;
  /** 按文件名解析导出目录内成片的绝对路径(timeline 旧节点 resultPath 愈合用;不存在返回 ok:false) */
  exportFilePath(input: { name: string }): Promise<{ ok: boolean; path?: string }>;
  /** 时间线成片「另存为…」:系统保存对话框选位置,把导出目录内的成片复制过去(取消返回 canceled=true) */
  saveExportAs(input: { name: string }): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
  /** 时间线成片「存入资源库」:复制进资产库并登记(source='product',归入 projectId) */
  archiveExport(input: { projectId: string; nodeId: string; name: string }): Promise<{ ok: boolean; assets: import('./domain').Asset[]; error?: string }>;
  // 项目包导入/导出(.bba 单文件:结构 + Take 历史 + 记忆 + 附件实体;不含生成产物)
  /**
   * 导出项目为 .bba 包。不传 path 时主进程弹保存对话框(取消返回 canceled=true)。
   * 写出的是 gzip(JSON);媒体按 base64 内联。
   */
  exportProjectPackage(req: import('./project-package').ProjectExportRequest): Promise<import('./project-package').ProjectExportResult>;
  /**
   * 从 .bba 包导入为**新项目**(原项目 id 一律重分配,不覆盖既有项目)。
   * 读取端校验 format/version;版本高于本应用时明确拒绝而不是猜着读。
   */
  importProjectPackage(input?: { path?: string }): Promise<import('./project-package').ProjectImportResult>;
  /**
   * 视频取帧:抽首/尾帧/**指定时间点**帧 PNG。
   * mode='at' 时必须给 seconds(非负秒数);产物落 outputs/frames/。
   * (镜头接续尾帧归档 / shot→image-edit 取帧源 / Agent frames.extract 中间帧)
   */
  extractFrame(
    videoPath: string,
    mode: 'first' | 'last' | 'at',
    /** mode='at' 时的取帧时间点(秒,非负) */
    seconds?: number,
  ): Promise<{ ok: boolean; path?: string; error?: string }>;
  /**
   * 音轨抽取:从视频抽出音轨 → 16-bit PCM wav(产物落 outputs/audio/)。
   *
   * 用途:「视频节点 → 音频参考」连接器 —— shot / video-upscale 的产物是 mp4,
   * 而 h3 的 `--ref-audio` 要的是音轨。提交前把视频源换成抽出的 wav。
   * 视频**没有音轨**时明确失败(不产出空文件)。
   */
  extractAudio(videoPath: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  /** 图片裁切:按目标画幅(A:B)ffmpeg 裁剪原图(image-crop 节点用;产物落 outputs/crops/) */
  cropImage(input: {
    path: string;
    /** 目标画幅,如 '16:9' / '9:16' / '1:1';宽高比须 > 0 */
    aspect: string;
    /** 裁切锚点:center(默认)/ top / bottom / left / right */
    focus?: 'center' | 'top' | 'bottom' | 'left' | 'right';
  }): Promise<{ ok: boolean; path?: string; error?: string }>;
  /** 图片拼接:多张图按横排/竖排/网格 ffmpeg 拼成一张(image-stitch 节点用;产物落 outputs/stitches/) */
  stitchImages(input: {
    /** 有序图片路径(2-16 张;顺序即拼接顺序) */
    paths: string[];
    /** 拼接方式:row=横排 / column=竖排 / grid=网格 */
    mode: 'row' | 'column' | 'grid';
    /** grid 模式列数(默认 3) */
    gridCols?: number;
    /** 图片间距 px(默认 0) */
    gap?: number;
    /** 间距/留白底色(ffmpeg 色名或 #hex,默认 white) */
    bg?: string;
  }): Promise<{ ok: boolean; path?: string; error?: string }>;
  /** 图片拆分:一张图等分成多片(image-split 节点用;产物落 outputs/splits/) */
  splitImage(input: {
    path: string;
    /** 拆分方式:rows=横切 N 段 / cols=竖切 N 段 / grid=gridCols×gridRows 网格 */
    mode: 'rows' | 'cols' | 'grid';
    /** rows/cols 模式份数(默认 3,上限 16) */
    count?: number;
    /** grid 模式列/行数(默认 3×3) */
    gridCols?: number;
    gridRows?: number;
  }): Promise<{ ok: boolean; paths?: string[]; error?: string }>;
  /** 🆕 视频增强(超分 + 合修脸):Real-ESRGAN 超分 + GFPGAN/CodeFormer 修脸(+ 可选 ffmpeg 去块)。
   *  video-upscale 节点用;长任务(每帧 1.2-1.5s),产物落 outputs/video-post/。
   *  ⚠️ 这是**阻塞式**长任务:要显示进度必须同时订阅 onVideoPostProgress(否则 10+ 分钟内 UI 无反馈)。 */
  videoUpscale(input: import('./domain').VideoUpscaleRequest): Promise<import('./domain').VideoUpscaleResult>;
  /** 视频增强工具链探测:realesrgan / face_fix_video.py / venv / 权重是否就绪(检查器防呆提示) */
  videoPostProbe(): Promise<import('./domain').VideoPostTooling>;
  /** 🆕 视频增强阶段进度推送(主进程 push;长任务期间驱动节点 badge / 检查器进度文案)。
   *  返回退订函数。同一时刻只有一个后处理任务在跑(全局串行链),故无需 jobId。 */
  onVideoPostProgress(cb: (p: import('./domain').VideoPostProgressEvent) => void): () => void;
  /** 🆕 当前正在跑的视频增强任务(主进程真源)。
   *  渲染层在**挂载时**调用以恢复运行态 —— 仅靠组件本地 state 的话,
   *  退出画布再进入会丢失「正在跑」标记,导致可对运行中的节点重复发起。 */
  videoPostRunning(): Promise<import('./domain').VideoPostRun[]>;
  /** 最近一次进度(挂载时立即恢复显示,不必等下一个 tick;无任务时 null) */
  videoPostLastProgress(): Promise<{ nodeId: string; stageLabel: string; detail?: string } | null>;
  /** 取消进行中的视频增强。给定 nodeId 只停该节点(含已排队尚未启动的那次);不给则停全部。 */
  videoPostCancel(input?: { nodeId?: string }): Promise<{ ok: boolean; error?: string }>;
  // 系统 / 文件
  /** 在系统文件管理器中定位路径(Finder 显示;主进程校验白名单后 shell 打开,文件缺失时回退最近存在目录) */
  revealInFinder(target: { path: string }): Promise<{ ok: boolean; revealed: string; error?: string }>;
  // 设置
  getSettings(): Promise<import('./domain').AppSettings>;
  setSettings(patch: Partial<import('./domain').AppSettings>): Promise<import('./domain').AppSettings>;
  /** 远程访问当前状态(地址、是否在听、有没有口令)。不含口令。 */
  remoteAccessStatus(): Promise<import('./domain').RemoteAccessStatus>;
  /**
   * 生成新口令并让旧会话失效。明文只在这一次返回。
   * 远程调用会被拒绝,只能在桌面设置页轮换。
   */
  remoteAccessRotatePassphrase(): Promise<{ ok: boolean; passphrase?: string; error?: string }>;
  /**
   * 保存中继配对密钥。明文不进 settings.json。远程调用会被拒绝。
   * 传空字符串表示清除。
   */
  relaySetPairingKey(key: string): Promise<{ ok: boolean; error?: string }>;
  // LLM 来源(五档:lmstudio / ollama / pimlx / openai-compatible / cloud)
  /** 枚举本地运行时模型(仅支持工具调用的;含体积/显存预估/已加载标记) */
  llmLocalModels(kind: 'lmstudio' | 'ollama' | 'pimlx'): Promise<import('./domain').LocalRuntimeModels>;
  /** 加载(驻留)本地模型;pi-mlx 未安装的模型会按需从 HuggingFace 拉取 */
  llmLoadModel(kind: 'lmstudio' | 'ollama' | 'pimlx', modelId: string): Promise<{ ok: boolean; error?: string }>;
  /** 测试 OpenAI 兼容端点连接;providerId 给定则从钥匙串取凭据 */
  llmTestConnection(input: { baseUrl: string; apiKey?: string; providerId?: string }): Promise<import('./domain').LlmConnectionTest>;
  /** 枚举远端 /v1/models 全量清单(添加模型弹层);providerId 给定则从钥匙串取凭据 */
  llmListRemoteModels(input: { baseUrl: string; apiKey?: string; providerId?: string }): Promise<{ ok: boolean; models: string[]; error?: string }>;
  /** 保存供应商凭据到 macOS 钥匙串(不回传、不落盘) */
  credentialSet(providerId: string, apiKey: string): Promise<{ ok: boolean; error?: string }>;
  /** 删除供应商凭据 */
  credentialDelete(providerId: string): Promise<{ ok: boolean }>;
  // h3 模型包管理 —— h3.c 不接受 --lora;加速包 = 蒸馏模型目录(-d)+ 4/8 步,风格包 = 风格 LoRA 离线融合目录 + 正常步数
  /** 列出已安装的模型包(主进程回填 exists 目录校验;设置页列表用) */
  accelList(): Promise<import('./domain').AccelPack[]>;
  /** 桌面原生选择器：直接选择已构建模型目录或本地 .safetensors LoRA。 */
  accelPickSource(source: 'directory' | 'lora'): Promise<{ ok: true; path: string; name: string } | { ok: false; canceled?: boolean; error?: string }>;
  /** 安装模型包:校验目录存在且含至少一个 h3 变体后登记入 settings.accelPacks;kind 缺省 accel */
  accelInstall(input: { name: string; path: string; steps?: number; kind?: import('./domain').AccelPackKind }): Promise<{ ok: boolean; packs?: import('./domain').AccelPack[]; error?: string }>;
  /** 单个本地 LoRA 离线融合为全新模型目录，成功后才登记；长任务可经 styleModelCancel 取消。 */
  accelInstallLora(input: import('./style-model').LocalLoraInstallInput): Promise<{ ok: boolean; packs?: import('./domain').AccelPack[]; error?: string; outDir?: string }>;
  /** 删除登记(只注销,不删磁盘) */
  accelRemove(id: string): Promise<{ ok: boolean; packs?: import('./domain').AccelPack[]; error?: string }>;
  /** 设默认包(id=null 清除默认);镜头启用模型包未选包时用默认包 */
  accelSetDefault(id: string | null): Promise<{ ok: boolean; packs?: import('./domain').AccelPack[]; error?: string }>;
  /**
   * 新建 shot 是否默认开启加速 LoRA(设置页总开关)。
   * 与 accelSetDefault 的区别:`default` 决定**用哪个包**,本开关决定**开不开**。
   * 开启后,渲染层「+」弹层与 Agent storyboard.materialize 建出的 shot 都会带上
   * `data.accel={enabled, packId, steps}`;单个镜头仍可在检查器里关掉。
   */
  accelSetDefaultEnabled(enabled: boolean): Promise<{ ok: boolean; enabled: boolean }>;
  /** 读「新建 shot 默认开启加速」总开关(设置页回填用;缺省 false) */
  accelGetDefaultEnabled(): Promise<boolean>;
  /**
   * 新建 shot 应写入的默认加速配置(null = 不该写 accel)。
   * 选包逻辑只在主进程 AccelStore 一处实现,渲染层「+」弹层直接取这份结果写入节点,
   * 避免两个建 shot 入口各写一份「选哪个包」的判断而分叉。
   */
  accelDefaultShotConfig(): Promise<{ enabled: true; packId: string; steps: number } | null>;
  // 风格模型包(mystic 等)下载 + 融合构建 —— LoRA 下载到本地后用 merge_lora_h3.py 离线融合进基础模型副本
  /** 风格包构建状态:LoRA 文件 / 基础模型 / 融合脚本 / 产物目录各自就绪情况 */
  styleModelStatus(packId: string): Promise<import('./style-model').StyleModelStatus>;
  /** 执行下载 + 融合构建(长任务;进度经 onStyleModelProgress 推送;防重入) */
  styleModelBuild(packId: string): Promise<{ ok: boolean; error?: string }>;
  /** 取消进行中的构建(杀当前子进程;半成品目录保留,重跑会先清 transformer 保证幂等) */
  styleModelCancel(): Promise<{ ok: boolean }>;
  /** 订阅风格包构建进度;返回退订函数 */
  onStyleModelProgress(cb: (ev: import('./style-model').StyleModelProgress) => void): () => void;
  // Agent 内核
  agentStatus(): Promise<AgentProcessState>;
  agentStart(modelSource?: import('./domain').LlmSource): Promise<AgentProcessState>;
  agentStop(): Promise<{ ok: boolean }>;
  /** 一句话起活:让 Agent 生成 Brief 并规划镜头(骨架期返回确定性规划) */
  agentPlan(
    brief: string,
    opts?: { projectId?: string; projectName?: string; existingNodeIds?: string[] },
  ): Promise<{
    document: import('./domain').CanvasNode;
    shots: import('./domain').CanvasNode[];
    edges: import('./domain').CanvasEdge[];
    report: string;
  }>;
  /** 分镜表规划:从文档/小说生成分镜表节点;默认分步只出表,autoMaterialize 同时铺节点 */
  agentPlanStoryboard(
    brief: string,
    opts?: { projectId?: string; projectName?: string; basePrompt?: string; autoMaterialize?: boolean },
  ): Promise<{
    storyboard: import('./domain').CanvasNode;
    images: import('./domain').CanvasNode[];
    shots: import('./domain').CanvasNode[];
    edges: import('./domain').CanvasEdge[];
    report: string;
  }>;
  /** 画布页多轮对话(带工具调用 + 记忆上下文 + AbortSignal 打断) */
  agentChat(req: import('./domain').AgentChatRequest): Promise<import('./domain').AgentChatResponse>;
  /** 真实打断当前对话(中止 LLM 请求) */
  agentCancel(projectId: string): Promise<{ ok: boolean }>;
  /** 订阅 Agent 实时事件(工具调用/校验)——渲染层注册回调,返回退订函数 */
  onAgentEvent(cb: (ev: import('./domain').AgentEvent) => void): () => void;
  /** 读取项目记忆(调试/设置页展示) */
  memoryGet(projectId: string): Promise<import('./domain').ProjectMemory>;
  /** /clear 命令:清空**当前活跃会话**对话(移除该会话 recall + 压缩摘要;节点总结与其他会话保留) */
  memoryClear(projectId: string, canvasId: string): Promise<{ ok: boolean; cleared: number; error?: string }>;
  /** /compact 命令:把当前活跃会话旧对话压成摘要(LLM 总结,不可达时兜底),写入会话 conversationSummary 并裁剪 recall(保留最近 N 条) */
  memoryCompact(projectId: string, canvasId: string): Promise<{
    ok: boolean;
    summary?: string;
    /** 被压缩裁掉的旧消息条数 */
    replaced?: number;
    /** 对话太短,无需压缩 */
    skipped?: boolean;
    /** LLM 不可达时使用确定性兜底摘要 */
    fallback?: boolean;
    error?: string;
  }>;
  /* ── Agent 历史会话(ChatThread) ── */
  /** 列出某画布的会话(含预览;按 updatedAt 降序) */
  chatThreadsList(projectId: string, canvasId: string): Promise<import('./domain').ChatThreadListItem[]>;
  /** 新建会话并设为活跃;当前已是空会话则复用 */
  chatThreadCreate(
    projectId: string,
    canvasId: string,
    opts?: { title?: string; parentThreadId?: string },
  ): Promise<{ ok: boolean; thread?: import('./domain').ChatThread; error?: string }>;
  /** 切换活跃会话 */
  chatThreadSwitch(
    projectId: string,
    canvasId: string,
    threadId: string,
  ): Promise<{ ok: boolean; thread?: import('./domain').ChatThread; error?: string }>;
  /** 重命名会话 */
  chatThreadRename(
    projectId: string,
    threadId: string,
    title: string,
  ): Promise<{ ok: boolean; thread?: import('./domain').ChatThread; error?: string }>;
  /** 删除会话;若删活跃则自动切到最近一条/清空壳 */
  chatThreadDelete(
    projectId: string,
    threadId: string,
  ): Promise<{ ok: boolean; activeThreadId?: string; error?: string }>;
  /** 读某会话全部 recall(供 UI 恢复) */
  chatThreadMessages(projectId: string, threadId: string): Promise<import('./domain').RecallMessage[]>;
  /** 当前画布活跃会话 id(没有则确保新建) */
  chatThreadActive(projectId: string, canvasId: string): Promise<{ threadId: string }>;
  // Take 历史(shot 节点生成归档)
  /** 列出项目下全部 Take(最新在前) */
  takesList(projectId: string): Promise<import('./domain').Take[]>;
  /** 列出指定 shot 节点的 Take 历史 */
  takesHistory(projectId: string, shotNodeId: string, currentTakeId?: string): Promise<import('./domain').ShotTakeHistory>;
  /** 创建一条 Take(渲染层提交任务前先建,拿 takeId 传给 submitRender) */
  takesCreate(projectId: string, partial: Partial<import('./domain').Take>): Promise<import('./domain').Take>;
  /** 打补丁(终态/resultPath/error 由主进程任务完成时自动写) */
  takesPatch(projectId: string, takeId: string, patch: Partial<import('./domain').Take>): Promise<import('./domain').Take | null>;
  /** 删除一条 Take(只删元数据,不删产物文件) */
  takesDelete(projectId: string, takeId: string): Promise<{ ok: boolean; error?: string }>;
  // 调试日志
  /** 拉取主进程日志总线(最近 500 条) */
  debugLogs(): Promise<import('./domain').DebugLogEntry[]>;
  /** 清空日志总线 */
  debugClear(): Promise<void>;
  /** 订阅实时日志(主进程 push);返回退订函数 */
  onDebugLog(cb: (e: import('./domain').DebugLogEntry) => void): () => void;
}

export * from './domain.js';
export * from './api-catalog.js';
export * from './provider.js';
export * from './tool-defs.js';
export * from './table.js';
export * from './prompt.js';
export * from './connector-map.js';
export * from './edge-validate.js';
export * from './document.js';
export * from './tool-models.js';
export * from './project-package.js';
export * from './style-model.js';
export * from './shot-duration.js';
export * from './storyboard-materialize.js';
export * from './skill-params.js';
export * from './agent-task.js';
export * from './opencode-go.js';
