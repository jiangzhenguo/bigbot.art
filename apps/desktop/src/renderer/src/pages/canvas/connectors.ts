/**
 * 连接器端口映射(依据 docs/连接器设计.md §5.4/§5.5,UI 稿:「+」弹窗端口预告)
 *
 * 职责:回答一个问题——「这条边连上后,数据落在目标的哪个端口?」
 *   - 返回 null = 没有可用连接器 ⇒ 该目标类型在「+」弹窗里不列出(设计稿 §10)
 *   - 返回的 port 就是写进 CanvasEdge.label 的**端口锚定**,dispatch 与运行期按它取数
 *
 * ⚠️ 过渡期权威表(连接器设计 S1 切片):
 *   连接器本身对用户不可见(D1);可见的只是「端口语义」。S2 会把 shot 的端口
 *   改为由 ProviderCapabilities.videoModes[].refs 派生,届时本表的 shot 分支退场。
 */
import type { CanvasNode } from './types';

export interface PortResolution {
  /** 端口锚定(写入边 label) */
  port: string;
  /** 人读说明(弹窗第二行) */
  desc: string;
}

type PortRow = [port: string, desc: string];

/** 端口条目:单条 tuple,或多条 tuple 数组(同目标的多个可选端口,如图片产物 → shot 的 first-frame/ref-image) */
type PortEntry = PortRow | PortRow[];

/** 源节点 id 特例(演示节点/固定语义) */
const BY_ID: Record<string, Record<string, PortRow>> = {
  // 演示画布里的角色资产:身份注入优先于通用参考图
  charAsset: {
    shot: ['ref-image', '参考图 · Ref2VA 身份注入'],
    image: ['ref-image', '参考图 · 角色一致性'],
    edit: ['input', '输入图 · 原图编辑'],
  },
  // 环境资产:可作为首帧候选
  envAsset: {
    shot: ['first-frame', '首帧候选 · 场景参考'],
    image: ['ref-image', '风格参考 · 提示词注入'],
    edit: ['input', '输入图 · 原图编辑'],
  },
};

/** 源节点 kind → 目标类型 → 端口(单条或多条;多条时 resolvePortOptions 返回全部,弹窗出「角色」chips) */
const BY_KIND: Record<string, Record<string, PortEntry>> = {
  shot: {
    shot: [
      ['first-frame', '首帧 · 上游尾帧自动取帧'],
      ['ref-video', '参考视频 · 上游整段成片(风格/动作参考)'],
    ],
    edit: ['input', '输入帧 · 首/尾帧可取'],
    vupscale: ['input', '输入视频 · 镜头成片增强(超分/修脸)'],
    timeline: ['clip', '视频片段 · 整段入轨'],
  },
  'image-gen': {
    shot: [
      ['first-frame', '首帧 · 直通'],
      ['ref-image', '参考图 · Ref2VA 身份/场景锁定'],
    ],
    edit: ['input', '输入图 · 直通'],
    upscale: ['input', '输入图 · 超分源'],
    crop: ['input', '输入图 · 原图裁切'],
    stitch: ['piece', '拼接件 · 多图按画布位置排序'],
    split: ['input', '输入图 · 拆分源'],
    image: ['ref-image', '参考图'],
    timeline: ['clip', '静帧片段 · 入轨'],
  },
  'image-edit': {
    shot: [
      ['first-frame', '首帧 · 直通'],
      ['ref-image', '参考图 · Ref2VA 身份/场景锁定'],
    ],
    edit: ['input', '输入图 · 直通'],
    upscale: ['input', '输入图 · 超分源'],
    crop: ['input', '输入图 · 原图裁切'],
    stitch: ['piece', '拼接件 · 多图按画布位置排序'],
    split: ['input', '输入图 · 拆分源'],
    timeline: ['clip', '静帧片段 · 入轨'],
  },
  'image-upscale': {
    shot: [
      ['first-frame', '首帧 · 直通'],
      ['ref-image', '参考图 · Ref2VA 身份/场景锁定'],
    ],
    edit: ['input', '输入图 · 直通'],
    crop: ['input', '输入图 · 原图裁切'],
    stitch: ['piece', '拼接件 · 多图按画布位置排序'],
    split: ['input', '输入图 · 拆分源'],
    image: ['ref-image', '参考图'],
    timeline: ['clip', '静帧片段 · 入轨'],
  },
  // 🆕 视频增强(超分 + 合修脸):产物是视频 → 首帧/参考视频/入轨/链式再增强
  'video-upscale': {
    shot: [
      ['first-frame', '首帧 · 增强成片首帧直通'],
      ['ref-video', '参考视频 · 风格/动作参考'],
    ],
    vupscale: ['input', '输入视频 · 链式二次增强'],
    timeline: ['clip', '增强成片 · 整段入轨'],
  },
  'image-crop': {
    shot: [
      ['first-frame', '首帧 · 裁切直通'],
      ['ref-image', '参考图 · 裁切结果作 Ref2VA'],
    ],
    edit: ['input', '输入图 · 裁切结果'],
    upscale: ['input', '输入图 · 超分源'],
    stitch: ['piece', '拼接件 · 多图按画布位置排序'],
    split: ['input', '输入图 · 拆分源'],
    image: ['ref-image', '参考图'],
    timeline: ['clip', '静帧片段 · 入轨'],
  },
  'image-stitch': {
    shot: [
      ['first-frame', '首帧 · 拼接直通'],
      ['ref-image', '参考图 · 拼接结果作 Ref2VA'],
    ],
    edit: ['input', '输入图 · 拼接结果'],
    upscale: ['input', '输入图 · 超分源'],
    crop: ['input', '输入图 · 原图裁切'],
    stitch: ['piece', '拼接件 · 拼接结果再拼接'],
    split: ['input', '输入图 · 拼接长图再切片'],
    image: ['ref-image', '参考图'],
    timeline: ['clip', '静帧片段 · 入轨'],
  },
  // image-split 作为源的图片处理目标走动态 piece-N 端口(resolvePortOptions 特判);
  // 这里只列 shot / 参考图 / 时间线等固定端口(默认取第 1 片)
  'image-split': {
    shot: [
      ['first-frame', '首帧 · 第 1 片直通'],
      ['ref-image', '参考图 · 第 1 片作 Ref2VA'],
    ],
    image: ['ref-image', '参考图 · 第 1 片'],
    timeline: ['clip', '静帧片段 · 第 1 片入轨'],
  },
  'audio-ref': {
    shot: ['ref-audio', '音轨参考 · 带声直出'],
    timeline: ['audio-track', '音轨 · 随片导出'],
  },
  document: {
    image: ['prompt', '提示词 · 全文注入'],
    shot: ['prompt', '提示词 · 全文注入'],
    edit: ['prompt', '提示词 · 全文注入'],
    doc: ['prompt', '文档引用'],
    director: ['prompt', '编排依据 · 全文注入'],
    storyboard: ['prompt', '分镜依据 · 全文注入'],
  },
  storyboard: {
    image: ['prompt', '提示词 · 按行注入(铺节点物化)'],
    shot: ['prompt', '提示词 · 按行注入(铺节点物化)'],
    edit: ['prompt', '提示词 · 按行注入'],
    timeline: ['sequence', '分镜序列 · 按行入轨'],
    director: ['prompt', '编排依据 · 按行注入'],
  },
  director: {
    timeline: ['sequence', '镜头编排 · 入轨'],
    doc: ['prompt', '文档引用'],
  },
  timeline: {
    doc: ['prompt', '文档引用'],
  },
  'workflow-input': {
    '*': ['slot-<名称>', '按槽位类型匹配目标端口'],
  },
};

/** 目标类型兜底(与源无关:任何**产物型**节点都可收口) */
const BY_TARGET: Record<string, PortRow> = {
  'wf-output': ['output', '产物汇聚 · 运行收口'],
};

/** 图片产物类节点(静帧直通) */
export const IMAGE_KINDS = ['image-gen', 'image-edit', 'image-upscale', 'image-crop', 'image-stitch', 'image-split'];

/** 视频产物类节点(视频直通:video-upscale 产物是 mp4,不能当静帧用) */
export const VIDEO_KINDS = ['video-upscale'];

/** 能收口到 workflow-output 的源(必须与 dispatch 的收集逻辑一致,否则弹窗会承诺不存在的边) */
const COLLECTABLE_KINDS = ['shot', 'director', 'audio-ref', 'asset', ...IMAGE_KINDS, ...VIDEO_KINDS];

/**
 * 镜头**画面规格**:shot → shot 接续时整组从上游继承(比例 + 档位三件套)。
 * 不含 `frames` / `seconds`——时长属于内容决策,由本镜头自己定。
 * 下游节点 data 置 `specOverride: true` 表示用户手动改过,不再被继承覆盖。
 */
export const SHOT_SPEC_KEYS = [
  'aspect',
  'width',
  'height',
  'customWidth',
  'customHeight',
  'tier',
  'steps',
  'layers',
  'reuse',
] as const;

/** 从源节点 data 里取出已定义的画面规格(未定义的键不覆盖下游) */
export function pickShotSpec(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SHOT_SPEC_KEYS) {
    if (data[k] !== undefined) out[k] = data[k];
  }
  return out;
}

function mediaTypeOf(n: CanvasNode): string {
  return String((n.data as { mediaType?: string } | undefined)?.mediaType ?? 'image');
}

/** 端口 → 简短标签(连接时的角色选择 chips / 拖拽选择弹层用) */
export const PORT_LABEL: Record<string, string> = {
  'first-frame': '首帧参考',
  'last-frame': '尾帧参考',
  'ref-image': '参考图',
  'ref-audio': '音频参考',
  'ref-video': '参考视频',
  prompt: '提示词',
  input: '输入图',
  /** 视频增强的输入端口:语义是「待增强的视频」,与图片节点的「输入图」区分 */
  'input-video': '输入视频',
  piece: '拼接件',
  clip: '入轨',
};

/**
 * 领域 kind → 节点库短 id(dstTypeId)归一表。
 * BY_KIND/asset 矩阵的目标键是 NodeTag 短 id(image/edit/crop/…),而拖拽连到**已存在节点**
 * 时(快照加载的节点没有 tag)传入的是长 kind —— 不归一会静默查不到端口、连线无反应。
 */
export const KIND_TO_TAGID: Record<string, string> = {
  'image-gen': 'image',
  'image-edit': 'edit',
  'image-upscale': 'upscale',
  'video-upscale': 'vupscale',
  'image-crop': 'crop',
  'image-stitch': 'stitch',
  'image-split': 'split',
  document: 'doc',
  'audio-ref': 'audio',
  'workflow-input': 'wf-input',
  'workflow-output': 'wf-output',
};

/** 拆分节点片数:已跑出产物按实际片数,否则按参数配置推算(上限 16) */
export function splitPieceCount(n: CanvasNode): number {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const actual = Array.isArray(d.pieces) ? d.pieces.length : 0;
  if (actual > 0) return actual;
  const mode = String(d.mode ?? 'grid');
  const conf = mode === 'grid'
    ? Number(d.gridCols ?? 3) * Number(d.gridRows ?? 3)
    : Number(d.count ?? 3);
  return Math.min(Math.max(2, Math.round(conf) || 2), 16);
}

/**
 * 解析:该源 → 该目标类型的所有可用端口选项(首个为默认)。
 * 多数组合只有一个端口;asset(图) → shot 支持「首帧参考 / 参考图参考」两种,由连接时 UI 选择。
 */
export function resolvePortOptions(src: CanvasNode, dstTypeId: string): PortResolution[] {
  // 长 kind(快照加载的节点无 tag,拖拽连线传入 kind)归一为节点库短 id
  dstTypeId = KIND_TO_TAGID[dstTypeId] ?? dstTypeId;
  const byId = BY_ID[src.id]?.[dstTypeId];
  if (byId) return [{ port: byId[0], desc: byId[1] }];

  // asset 按媒体类型细分(图片 / 视频 / 音频 / 文档)——资源节点只作输入源,端口语义随媒体类型变化
  if (src.kind === 'asset') {
    const mt = mediaTypeOf(src);
    // 图片资源 → 镜头:可当「首帧参考」或「参考图参考」(节点手册 §3.2:ref-image/first-frame 并存)
    if (mt === 'image' && dstTypeId === 'shot') {
      return [
        { port: 'first-frame', desc: '首帧参考 · 此图作为镜头第一帧(FL2VA)' },
        { port: 'ref-image', desc: '参考图 · Ref2VA 身份/场景锁定' },
      ];
    }
    const TABLES: Record<string, Record<string, PortRow>> = {
      image: {
        shot: ['ref-image', '参考图 · Ref2VA'],
        image: ['ref-image', '参考图'],
        edit: ['input', '输入图 · 原图编辑'],
        upscale: ['input', '输入图 · 超分源'],
        crop: ['input', '输入图 · 原图裁切'],
        stitch: ['piece', '拼接件 · 多图按画布位置排序'],
        split: ['input', '输入图 · 拆分源'],
        timeline: ['clip', '静帧片段 · 入轨'],
      },
      video: {
        shot: ['ref-video', '参考视频 · 风格/动作参考'],
        edit: ['input', '取帧源 · 首/尾帧'],
        vupscale: ['input', '输入视频 · 超分/修脸源'],
        timeline: ['clip', '视频素材 · 入轨'],
      },
      audio: {
        shot: ['ref-audio', '音轨参考 · 带声直出'],
        timeline: ['audio-track', '音轨 · 随片导出'],
      },
      document: {
        shot: ['prompt', '提示词 · 全文注入'],
        image: ['prompt', '提示词 · 全文注入'],
        edit: ['prompt', '提示词 · 全文注入'],
        doc: ['prompt', '文档引用'],
        director: ['prompt', '编排依据 · 全文注入'],
        storyboard: ['prompt', '分镜依据 · 全文注入'],
      },
    };
    // noUncheckedIndexedAccess 下索引访问均可能 undefined,空表兜底(查不到 → [])
    const table = TABLES[mt] ?? TABLES.image ?? {};
    const hit = table[dstTypeId];
    if (hit) return [{ port: hit[0], desc: hit[1] }];
    // 素材/文档 → 工作流入口槽位(设计稿表缺此项,按 §11 迁移映射表 7/9 号补齐)
    if (dstTypeId === 'wf-input') return [{ port: 'slot-<名称>', desc: '按槽位类型匹配槽位' }];
    return [];
  }

  if (src.kind === 'document' && dstTypeId === 'wf-input') {
    return [{ port: 'slot-<名称>', desc: '文本槽位 · 全文注入' }];
  }

  // image-split 作为源 → 图片处理目标:动态 piece-N 端口(按片数出「取第几片」chips,默认第 1 片)
  if (src.kind === 'image-split') {
    const PIECE_TARGETS: Record<string, string> = {
      edit: '输入图',
      upscale: '输入图 · 超分源',
      crop: '输入图 · 原图裁切',
      stitch: '拼接件',
      split: '输入图 · 拆分源',
    };
    const useAs = PIECE_TARGETS[dstTypeId];
    if (useAs) {
      const count = splitPieceCount(src);
      return Array.from({ length: count }, (_, i) => ({
        port: `piece-${i + 1}`,
        desc: `第 ${i + 1} 片 · ${useAs}`,
      }));
    }
  }

  const byKind = BY_KIND[src.kind ?? '']?.[dstTypeId];
  if (byKind) {
    // 单条 tuple(如 ['first-frame', '首帧 · 直通'])/ 多条 tuple 数组(图片产物 → shot 双端口)统一展开
    const rows: PortRow[] = Array.isArray(byKind[0]) ? (byKind as PortRow[]) : [byKind as PortRow];
    return rows.map(([port, desc]) => ({ port, desc }));
  }

  // 收口到 workflow-output:仅限真正产出产物的节点(与 dispatch 的 kind 匹配一致)
  const byTarget = BY_TARGET[dstTypeId];
  if (byTarget && COLLECTABLE_KINDS.includes(src.kind ?? '')) {
    return [{ port: byTarget[0], desc: byTarget[1] }];
  }

  return [];
}

/** 解析:该源 → 该目标类型是否有可用连接器;有则返回默认(首个)端口锚定 */
export function resolvePort(src: CanvasNode, dstTypeId: string): PortResolution | null {
  return resolvePortOptions(src, dstTypeId)[0] ?? null;
}

/** 「+」弹窗:该类型是否该列出(只列出有可用连接器的类型) */
export function hasConnector(src: CanvasNode, dstTypeId: string): boolean {
  return resolvePortOptions(src, dstTypeId).length > 0;
}
