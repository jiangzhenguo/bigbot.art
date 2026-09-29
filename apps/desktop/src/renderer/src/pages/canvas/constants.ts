import type { NodeTag, CanvasNode, Edge, NodeInfo } from './types';

export const NODE_TYPES: NodeTag[] = [
  { id: 'doc', kind: 'document', name: '提示词 / 文档', sub: 'Markdown · 五段式/六段式' },
  { id: 'storyboard', kind: 'storyboard', name: '分镜表', sub: '脚本 · 一行 = 一个分镜' },
  { id: 'asset', kind: 'asset', name: '资产引用', sub: '角色 / 环境 / 物品 · 资产中心' },
  { id: 'image', kind: 'image-gen', name: '图片生成', sub: 'mlxgen · Z-Image-Turbo' },
  { id: 'edit', kind: 'image-edit', name: '图片编辑', sub: '指令 / I2I / Inpaint / Outpaint' },
  { id: 'upscale', kind: 'image-upscale', name: '图片增强', sub: 'SeedVR2 超分', p1: true },
  { id: 'vupscale', kind: 'video-upscale', name: '视频增强', sub: '超分 + 合修脸 · Real-ESRGAN/GFPGAN' },
  { id: 'crop', kind: 'image-crop', name: '图片裁切', sub: '按画幅裁剪 · 1:1 → 9:16' },
  { id: 'stitch', kind: 'image-stitch', name: '图片拼接', sub: '多图横排/竖排/网格 · ffmpeg' },
  { id: 'split', kind: 'image-split', name: '图片拆分', sub: '长图切片 · 九宫格切图' },
  { id: 'shot', kind: 'shot', name: '镜头（视频）', sub: 'h3.c · 文生/首帧/首尾帧/参考图/参考视频' },
  { id: 'grab', kind: 'frame-grab', name: '视频裁切取帧', sub: '从视频截一帧 → 导出为图片资源' },
  { id: 'director', kind: 'director', name: '导演台', sub: '运镜参考小样', p1: true },
  { id: 'audio', kind: 'audio-ref', name: '音频参考', sub: '--ref-audio 带声直出' },
  { id: 'timeline', kind: 'timeline', name: '时间线 / 剪辑', sub: 'FFmpeg 导出', p1: true },
  { id: 'comfy', kind: 'director', name: 'ComfyUI 工作流', sub: '导入 workflow_api.json', p1: true },
  { id: 'wf-input', kind: 'workflow-input', name: '工作流入口', sub: '声明输入槽位 · 资源容器', wf: true },
  { id: 'wf-output', kind: 'workflow-output', name: '工作流出口', sub: '产物汇聚 · 运行收口', wf: true },
];

export const COMPAT: Record<string, string[]> = {
  brief: ['image', 'shot', 'doc', 'director', 'storyboard'],
  storyboard: ['image', 'shot', 'edit', 'timeline', 'director'],
  audio: ['shot', 'timeline'],
  shot1: ['shot', 'timeline', 'edit'],
  shot2: ['shot', 'timeline', 'edit'],
  shot3: ['shot', 'timeline'],
  timeline: ['doc'],
  // 🆕 v2:workflow-input 可注入到任何操作节点;任何操作节点可收口到 workflow-output
  'wf-input': ['doc', 'image', 'edit', 'upscale', 'shot', 'director', 'audio', 'timeline', 'asset'],
  // 操作节点(除 wf-output 自身)都可作为 wf-output 的上游
  doc: ['wf-output'],
  image: ['wf-output'],
  edit: ['wf-output'],
  upscale: ['wf-output'],
  stitch: ['wf-output'],
  split: ['wf-output'],
  shot: ['wf-output'],
  director: ['wf-output'],
  // 视频增强:产物是视频 → 可作镜头参考/首帧,也可入轨、收口
  vupscale: ['shot', 'timeline', 'wf-output'],
  // asset 也可直接收口(素材直接当产物,虽然不推荐,但合法)
  asset: ['shot', 'edit', 'upscale', 'timeline', 'wf-input', 'wf-output'],
};

/** 档位 × 画幅白名单(防呆) */
export const RES: Record<string, Record<string, string>> = {
  预览: { '16:9': '512×288', '9:16': '288×512', '1:1': '384×384' },
  草稿: { '16:9': '960×540', '9:16': '540×960', '1:1': '720×720' },
  默认: { '16:9': '1280×720', '9:16': '720×1280', '1:1': '960×960' },
  参考: { '16:9': '1920×1080' },
};
export const ETA: Record<string, string> = {
  预览: '≈2 分钟',
  草稿: '≈4 分钟',
  默认: '≈8 分钟',
  参考: '≈22 分钟',
};

/** 尺寸白名单提示行 */
export function resLine(aspect: string, tier: string): string {
  const r = (RES[tier] ?? {})[aspect];
  if (!r) return '该组合不在白名单 · 已禁用（capabilities）';
  return `输出 ${r} · 预计 ${ETA[tier]}（capabilities）`;
}

/* ── Shot 检查器(h3.c 档位 × 画幅,与 packages/providers h3c-command ASPECT_SIZES 对齐) ── */
export const SHOT_ASPECTS = ['16:9', '9:16', '1:1', 'custom'] as const;
export const SHOT_TIERS = ['preview', 'draft', 'default', 'reference'] as const;
/** 档位 × 画幅 → 宽高(全部 32 倍数合法档,H3_USAGE.md §4.2) */
export const SHOT_SIZES: Record<'16:9' | '9:16' | '1:1', Record<(typeof SHOT_TIERS)[number], { width: number; height: number }>> = {
  '16:9': {
    preview: { width: 864, height: 480 },
    draft: { width: 864, height: 480 },
    default: { width: 1280, height: 704 },
    reference: { width: 1536, height: 768 },
  },
  '9:16': {
    preview: { width: 480, height: 864 },
    draft: { width: 576, height: 1024 },
    default: { width: 704, height: 1280 },
    reference: { width: 768, height: 1536 },
  },
  '1:1': {
    preview: { width: 544, height: 544 },
    draft: { width: 544, height: 544 },
    default: { width: 768, height: 768 },
    reference: { width: 1024, height: 1024 },
  },
};
/** 档位预设(F/S/L/R + ETA)— H3_USAGE.md §4.3 四组 preset;etaMin 供加速后按步数比例重算预计时间 */
export const SHOT_TIER_PRESETS: Record<(typeof SHOT_TIERS)[number], { label: string; steps: number; layers: number; reuse: number; frames: number; eta: string; etaMin: number; note: string }> = {
  preview: { label: '预览', steps: 6, layers: 40, reuse: 2, frames: 22, eta: '≈4 分钟', etaMin: 4, note: '极速草稿(reuse2 防呆安全)' },
  draft: { label: '草稿', steps: 12, layers: 50, reuse: 2, frames: 56, eta: '≈9 分钟', etaMin: 9, note: '快速出片' },
  default: { label: '默认', steps: 20, layers: 50, reuse: 1, frames: 124, eta: '≈15 分钟', etaMin: 15, note: '5s 段甜点' },
  reference: { label: '参考', steps: 30, layers: 50, reuse: 1, frames: 124, eta: '≈30 分钟', etaMin: 30, note: 'high quality · gold 档' },
};

/** h3.c 帧数对齐:向上进位到 5+17n(与 h3_align_frame_count 一致,H3_USAGE.md §6) */
export function h3AlignFrames(frames: number): number {
  const v = Math.max(5, Math.round(frames));
  const rem = ((v - 5) % 17 + 17) % 17;
  return rem === 0 ? v : v + 17 - rem;
}

/** h3.c 秒数(24fps)→ 应该写的帧数:按 h3 CLI --seconds 的换算(seconds×24 后对齐 5+17n) */
export function h3FramesForSeconds(seconds: number): number {
  return h3AlignFrames(seconds * 24);
}

/** h3 输出帧率(与 h3.c 的 H3_FPS 一致) */
export const H3_FPS = 24;

/**
 * 带**内嵌音轨**的参考视频要求的最小输出时长(h3 硬规则 h3.c:1146)。
 * 与 `packages/providers/src/h3c-command.ts` 的 `MIN_SOUNDTRACK_SECONDS` / `MIN_SOUNDTRACK_FRAMES`
 * 保持同口径 —— renderer 不 import providers(包边界),故这里复制常量;改一处要同步另一处。
 */
export const MIN_SOUNDTRACK_SECONDS = 2;
export const MIN_SOUNDTRACK_FRAMES = 56;

/** 镜头输出时长(秒):seconds 优先,否则 frames / H3_FPS */
export function h3OutputSeconds(data: Record<string, unknown>): number {
  const secs = Number(data.seconds ?? 0);
  if (secs > 0) return secs;
  return Number(data.frames ?? 0) / H3_FPS;
}
export const SHOT_MODE_LABEL: Record<string, string> = {
  text2video: '文生',
  'first-frame': '首帧',
  'last-frame': '尾帧',
  'first-last': '首尾帧',
  'ref-image': 'Ref2VA',
  'ref-video': '参考视频',
};
/** 参考角色(按 mode 可用的)+ 需要的媒体类型 */
export const SHOT_REF_ROLES: Record<string, Array<{ role: string; label: string; media: 'image' | 'audio' | 'video'; multiple?: boolean }>> = {
  text2video: [
    { role: 'ref-video', label: '参考视频', media: 'video' },
    { role: 'ref-audio', label: '音频参考', media: 'audio' },
  ],
  'first-frame': [
    { role: 'first-frame', label: '首帧', media: 'image' },
    { role: 'ref-audio', label: '音频参考', media: 'audio' },
  ],
  'last-frame': [
    { role: 'last-frame', label: '尾帧', media: 'image' },
    { role: 'ref-audio', label: '音频参考', media: 'audio' },
  ],
  'first-last': [
    { role: 'first-frame', label: '首帧', media: 'image' },
    { role: 'last-frame', label: '尾帧', media: 'image' },
    { role: 'ref-audio', label: '音频参考', media: 'audio' },
  ],
  'ref-image': [
    { role: 'ref-image', label: '参考图(1-9 张)', media: 'image', multiple: true },
    { role: 'ref-audio', label: '音频参考', media: 'audio' },
  ],
  'ref-video': [
    { role: 'ref-video', label: '参考视频', media: 'video' },
    { role: 'ref-audio', label: '音频参考', media: 'audio' },
  ],
};

/** 检查器:每个节点的参数表(与 canvas.js NODE_INFO 一致) */
export const NODE_INFO_BASE: Record<string, NodeInfo> = {
  brief: {
    t: '文档 · Brief',
    img: null,
    meta: [
      ['类型', 'Markdown 提示词文档'],
      ['结构', '五段式 · 场景/角色/风格'],
      ['状态', '已编辑 · 下游 2 节点 stale'],
    ],
  },
  storyboard: {
    t: '图片生成 · 分镜静帧',
    img: './assets/sb-river.jpg',
    meta: [
      ['引擎', 'mlxgen · Z-Image-Turbo'],
      ['尺寸', '1024×576 · 16:9'],
      ['seed', '批量 ×4 · 88213–88216'],
    ],
  },
  audio: {
    t: '音频参考',
    img: null,
    meta: [
      ['文件', '草原环境声.mp3 · 02:41'],
      ['绑定', '--ref-audio · 带声直出'],
      ['引用', '镜头 02'],
    ],
  },
  shot1: {
    t: '镜头 01 · 女主跃河',
    img: './assets/shot-01.jpg',
    meta: [
      ['引擎', 'h3.c 0.4.2'],
      ['模式', '首尾帧 FL2VA'],
      ['时长', '10s · 带声直出'],
    ],
  },
  shot2: {
    t: '镜头 02 · 男主踱步',
    img: './assets/shot-02.jpg',
    meta: [
      ['引擎', 'h3.c 0.4.2'],
      ['模式', '首尾帧 FL2VA'],
      ['时长', '10s · 带声直出'],
    ],
  },
  shot3: {
    t: '镜头 03 · 计划中（幽灵）',
    img: null,
    meta: [
      ['引擎', 'h3.c 0.4.2'],
      ['模式', '首帧'],
      ['状态', 'Agent 已规划 · 等视频槽位'],
    ],
  },
  timeline: {
    t: '时间线 / 剪辑',
    img: null,
    meta: [
      ['片段', '5 · 缺镜 02/03'],
      ['音轨', '保留各 Take 内嵌音轨'],
      ['导出', 'FFmpeg · MP4 H.264+AAC'],
    ],
  },
};

/** 演示节点(初始 state,取自 canvas.js 的画布初始状态) */
export function initialNodes(): CanvasNode[] {
  return [
    {
      id: 'brief',
      title: '文档 · Brief',
      w: 206,
      x: 40,
      y: 300,
      st: 'warn',
      kind: 'document',
    },
    {
      id: 'storyboard',
      title: '图片生成 · 分镜静帧',
      w: 224,
      x: 320,
      y: 60,
      st: 'ok',
      kind: 'image-gen',
    },
    { id: 'audio', title: '音频参考', w: 224, x: 320, y: 420, st: 'ok', kind: 'audio-ref' },
    { id: 'shot1', title: '镜头 01 · 女主跃河', w: 240, x: 620, y: 40, st: 'ok', kind: 'shot' },
    {
      id: 'shot2',
      title: '镜头 02 · 男主踱步',
      w: 240,
      x: 620,
      y: 310,
      stale: true,
      agentOn: true,
      badge: 'Agent 重跑中 · 剩 06:12',
      headBg: 'var(--bg)',
      kind: 'shot',
    },
    {
      id: 'shot3',
      title: '镜头 03 · 计划中',
      w: 240,
      x: 620,
      y: 580,
      ghost: true,
      kind: 'shot',
    },
    {
      id: 'timeline',
      title: '时间线 / 剪辑',
      w: 230,
      x: 960,
      y: 230,
      stale: true,
      headBg: 'var(--bg)',
      kind: 'timeline',
    },
  ];
}

export function initialEdges(): Edge[] {
  return [
    { from: 'brief', to: 'storyboard', cls: '' },
    { from: 'brief', to: 'audio', cls: '' },
    { from: 'storyboard', to: 'shot1', cls: '' },
    { from: 'storyboard', to: 'shot2', cls: '' },
    { from: 'storyboard', to: 'shot3', cls: 'ghost' },
    { from: 'audio', to: 'shot2', cls: '' },
    { from: 'shot1', to: 'shot2', cls: 'stale' },
    { from: 'shot1', to: 'timeline', cls: '' },
    { from: 'shot2', to: 'timeline', cls: 'stale' },
    { from: 'shot3', to: 'timeline', cls: 'ghost' },
  ];
}

export const WAVE_BARS = [10, 18, 26, 14, 22, 30, 16, 24, 12, 20, 28, 14, 22, 10, 18, 26, 16, 12, 20, 8];

