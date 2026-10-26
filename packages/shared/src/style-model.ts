/**
 * 风格模型包(style LoRA 融合包)的下载 / 构建契约(2026-10,MiniMax-H3-mystic 接入)。
 *
 * 背景:h3.c CLI 不接受 `--lora`;风格 LoRA 的使用方式是**离线融合** ——
 * 把 LoRA 权重增量烤进基础模型(MiniMax-H3)的 FL2VA / Ref2VA transformer 副本,
 * 产出一个完整模型目录(如 ~/ai/h3/MiniMax-H3-mystic),推理时 `-d` 指向它即可。
 * 融合脚本 merge_lora_h3.py 在 h3 部署目录(本机 ~/ai/h3/)。
 *
 * 构建管线(styleModelBuild,主进程 h3-style-model.ts):
 *   ① 下载 LoRA safetensors(HF / Civitai,缺失才下,已存在跳过);
 *   ② 复制基础模型的非 transformer 组件(APFS clonefile,几乎不占新空间);
 *   ③ 对 FL2VA / Ref2VA 两个 transformer 各跑一次融合(强度 1.0 烤死)。
 *
 * ⚠️ 幂等性:merge 脚本是「copy + 就地 patch」,对**已融合**的目录重跑会把 delta 再叠加
 * 一次(双重 LoRA,画面必然过饱和/崩坏)。因此每次构建前一律删除产物目录下的
 * transformer/ 再重跑,保证「重跑 = 干净重来」。
 */

/** 本地 LoRA 融合安装的统一进度 id（与设置页底部安装区共用）。 */
export const LOCAL_LORA_BUILD_ID = 'local-lora-install';

export type H3TransformerTarget = 'FL2VA' | 'Ref2VA';

/** 单个本地 LoRA 的安装参数；产物目录由主进程按名称安全分配，渲染层不能指定。 */
export interface LocalLoraInstallInput {
  name: string;
  loraPath: string;
  kind: 'accel' | 'style';
  steps: number;
  /** both = 同一文件分别融合到两个 transformer；仅作者明确兼容时使用。 */
  target: H3TransformerTarget | 'both';
}

/** 一个 LoRA 下载源(某个 transformer 变体对应一个文件;同一 target 多条 = 按数组顺序先后融合,如先风格后 turbo) */
export interface StyleLoraSource {
  /** 目标文件名(落盘名,如 MysticXXX_MMH3-V4.safetensors) */
  fileName: string;
  /** 作用的模型子组件:FL2VA(文生视频/首尾帧)或 Ref2VA(参考图) */
  target: 'FL2VA' | 'Ref2VA';
  /** 下载地址(HF resolve / Civitai download endpoint) */
  url: string;
  /** 人类可读来源说明(失败指引用) */
  origin: string;
  /** 落盘目录(缺省 = 构建方案的 loraDir;双融合包的 turbo LoRA 在别的目录时用) */
  dir?: string;
}

/** 风格包构建状态(styleModelStatus 返回) */
export interface StyleModelStatus {
  packId: string;
  /** 该包是否有已知的下载/构建方案(未登记的风格包只能手动构建) */
  buildable: boolean;
  /** 产物模型目录(融合输出,-d 目标) */
  outDir: string;
  /** 产物目录已就绪(含 FL2VA + Ref2VA transformer) */
  mergedReady: boolean;
  /** 基础模型目录就绪(融合的材料) */
  baseReady: boolean;
  /** 基础模型目录路径 */
  baseDir: string;
  /** 融合脚本存在 */
  scriptReady: boolean;
  /** 融合脚本路径 */
  scriptPath: string;
  /** LoRA 文件逐个就绪情况 */
  loras: Array<{ fileName: string; target: 'FL2VA' | 'Ref2VA'; exists: boolean; sizeBytes: number; path: string }>;
  /** 还差什么(人读,设置页直接显示;空串 = 全部就绪可直接构建/已构建) */
  missing: string[];
}

/** 构建进度事件(onStyleModelProgress) */
export interface StyleModelProgress {
  packId: string;
  /** download=下载 LoRA / copy=复制基础组件 / merge-FL2VA / merge-Ref2VA / done / error / cancelled */
  stage: 'download' | 'copy' | 'merge-FL2VA' | 'merge-Ref2VA' | 'done' | 'error' | 'cancelled';
  /** 0-100;download 阶段按文件字节数算,merge 阶段按已处理 shard 数粗算 */
  pct?: number;
  /** 人读进度描述(设置页进度条下方一行) */
  message: string;
  /** stage=error 时的原因 */
  error?: string;
}
