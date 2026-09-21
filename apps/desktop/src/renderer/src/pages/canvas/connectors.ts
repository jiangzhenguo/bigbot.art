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

/** 源节点 kind → 目标类型 → 端口 */
const BY_KIND: Record<string, Record<string, PortRow>> = {
  shot: {
    shot: ['first-frame', '首帧 · 上游尾帧自动取帧'],
    edit: ['input', '输入帧 · 首/尾帧可取'],
    timeline: ['clip', '视频片段 · 整段入轨'],
  },
  'image-gen': {
    shot: ['first-frame', '首帧 · 直通'],
    edit: ['input', '输入图 · 直通'],
    upscale: ['input', '输入图 · 超分源'],
    crop: ['input', '输入图 · 原图裁切'],
    image: ['ref-image', '参考图'],
    timeline: ['clip', '静帧片段 · 入轨'],
  },
  'image-edit': {
    shot: ['first-frame', '首帧 · 直通'],
    edit: ['input', '输入图 · 直通'],
    upscale: ['input', '输入图 · 超分源'],
    crop: ['input', '输入图 · 原图裁切'],
    timeline: ['clip', '静帧片段 · 入轨'],
  },
  'image-upscale': {
    shot: ['first-frame', '首帧 · 直通'],
    edit: ['input', '输入图 · 直通'],
    crop: ['input', '输入图 · 原图裁切'],
    image: ['ref-image', '参考图'],
    timeline: ['clip', '静帧片段 · 入轨'],
  },
  'image-crop': {
    shot: ['first-frame', '首帧 · 裁切直通'],
    edit: ['input', '输入图 · 裁切结果'],
    upscale: ['input', '输入图 · 超分源'],
    image: ['ref-image', '参考图'],
    timeline: ['clip', '静帧片段 · 入轨'],
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
export const IMAGE_KINDS = ['image-gen', 'image-edit', 'image-upscale', 'image-crop'];

/** 能收口到 workflow-output 的源(必须与 dispatch 的收集逻辑一致,否则弹窗会承诺不存在的边) */
const COLLECTABLE_KINDS = ['shot', 'director', 'audio-ref', 'asset', ...IMAGE_KINDS];

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
  clip: '入轨',
};

/**
 * 解析:该源 → 该目标类型的所有可用端口选项(首个为默认)。
 * 多数组合只有一个端口;asset(图) → shot 支持「首帧参考 / 参考图参考」两种,由连接时 UI 选择。
 */
export function resolvePortOptions(src: CanvasNode, dstTypeId: string): PortResolution[] {
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
        timeline: ['clip', '静帧片段 · 入轨'],
      },
      video: {
        shot: ['ref-video', '参考视频 · 风格/动作参考'],
        edit: ['input', '取帧源 · 首/尾帧'],
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

  const byKind = BY_KIND[src.kind ?? '']?.[dstTypeId];
  if (byKind) return [{ port: byKind[0], desc: byKind[1] }];

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
