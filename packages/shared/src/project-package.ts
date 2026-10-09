/**
 * 项目包(.bba)—— 项目级导入/导出格式契约
 *
 * 背景:PRD §8.3 原本只规划了「H3Mise 项目导入」这一条迁移路径(把外部项目台的数据搬进来),
 * 但本应用自己的项目**出不去** —— 换机、备份、把项目发给协作者都没有通道。
 * 本模块把入口换成**自产自销的项目包**:导出当前项目 → 单文件 .bba;首页「导入」读它。
 *
 * 文件形态:`gzip(JSON)`。**不引入 zip 依赖** —— 媒体文件按 base64 内联在 JSON 里,
 * 用 Node 内置 `zlib` 压缩。代价是媒体体积膨胀约 33%(base64 开销,文本类能被 gzip 收回来),
 * 换来的是:零新增运行时依赖、无 zip 解压路径穿越风险、包内容是一份可读 JSON(排错友好)。
 *
 * ⚠️ **包里不放生成产物**(outputs/ 下的 mp4/png):一个几十镜的项目动辄数 GB,
 * 且产物可用节点参数重跑。包内只放**结构 + 历史 + 用户导入的附件实体**。
 * 导入后节点 data.resultPath 保留原绝对路径 —— 同机重装能直接命中,换机则命中不到,
 * 渲染层已有「产物缺失」降级展示,用户重跑即可(比伪造一个空文件诚实)。
 */

/** 包格式版本:读取端只接受 ≤ 本值的包;高版本包明确拒绝(而不是猜着读) */
export const PROJECT_PACKAGE_VERSION = 1;

/** 包内媒体条目的种类 —— 决定导入时落到哪个目录 */
export type ProjectPackageMediaKind = 'asset' | 'attachment';

export interface ProjectPackageMedia {
  /** 包内引用键(资产/附件在包内的稳定标识) */
  key: string;
  kind: ProjectPackageMediaKind;
  /** 原文件名(含扩展名,导入时按它决定落盘扩展名) */
  name: string;
  /** 原始绝对路径(仅作诊断展示,导入时不使用) */
  originalPath: string;
  /** 字节数(导出端测量;导入端可用于校验截断) */
  bytes: number;
  /** base64 编码的文件内容 */
  dataBase64: string;
}

export interface ProjectPackagePayload {
  /** 项目元数据(id/name/description/llmOverride/创建时间等);导入时 id 会重新分配 */
  project: import('./domain').Project;
  /** 全部画布快照(节点 + 连线 + 分组 + 视口) */
  canvases: import('./domain').ProjectCanvases;
  /** Take 历史(项目下全部节点) */
  takes: import('./domain').Take[];
  /** Agent 记忆(核心记忆/画布总结/recall/归档/激活技能) */
  memory: import('./domain').ProjectMemory | null;
  /** 项目资源元数据(localPath 指向包内条目时会被重写为导入后的新路径) */
  assets: import('./domain').Asset[];
  /** 资源分类 */
  assetCategories: import('./domain').AssetCategory[];
  /** 媒体实体(附件与项目资源;产物不入包) */
  media: ProjectPackageMedia[];
}

export interface ProjectPackage {
  /** 固定字面量,防止误读任意 JSON 文件 */
  format: 'bigbotart-project';
  version: number;
  /** 导出时间(ISO) */
  exportedAt: string;
  /** 导出端应用版本(诊断用) */
  appVersion?: string;
  /** 导出端数据根(诊断用;导入时忽略) */
  exportedFrom?: string;
  /** 打包时的统计(UI 展示「已导出 N 节点 / M 个附件」) */
  stats: ProjectPackageStats;
  payload: ProjectPackagePayload;
}

export interface ProjectPackageStats {
  canvases: number;
  nodes: number;
  edges: number;
  takes: number;
  assets: number;
  mediaFiles: number;
  /** 媒体字节合计(未压缩) */
  mediaBytes: number;
}

/** 导出请求:两条路径二选一 —— 传 path 直接写盘(不进系统对话框),否则弹保存对话框 */
export interface ProjectExportRequest {
  projectId: string;
  /** 目标文件绝对路径(省略 → 主进程弹 showSaveDialog) */
  path?: string;
}

export interface ProjectExportResult {
  ok: boolean;
  /** 用户取消保存对话框(不是错误) */
  canceled?: boolean;
  /** 实际写出的文件路径 */
  path?: string;
  /** 文件字节数 */
  bytes?: number;
  stats?: ProjectPackageStats;
  error?: string;
}

export interface ProjectImportResult {
  ok: boolean;
  canceled?: boolean;
  /** 导入后新建的项目(渲染层据此跳转) */
  project?: import('./domain').Project;
  /** 导入统计(UI 提示「N 节点 / M 附件」) */
  stats?: ProjectPackageStats;
  /** 非致命问题(缺产物 / 附件文件缺失等);导入照样成功,但必须让用户看见 */
  warnings?: string[];
  error?: string;
}
