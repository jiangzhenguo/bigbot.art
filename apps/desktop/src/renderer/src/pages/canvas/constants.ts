import {
  VIDEO_ASPECTS,
  VIDEO_TIERS,
  VIDEO_TIER_PRESETS,
  SHOT_SIZES as SHARED_SHOT_SIZES,
  HIDDEN_NODE_KINDS,
  isHiddenNodeKind,
  SHOT_MAX_SECONDS as SHARED_SHOT_MAX_SECONDS,
  type VideoAspect,
} from '@bigbotart/shared';
import type { NodeTag, CanvasNode, Edge, NodeInfo } from './types';

/**
 * 已实现、可用的节点类型 —— **节点面板 / 「+」弹层只列这一组**。
 *
 * ⚠️ 判定标准是「点了真的会出东西」,不是「类型定义里有这个 kind」:
 * 每一条都必须有 `CanvasPage.runNode` 的执行分支,或是纯引用/纯文档这类
 * 天然不需要执行分支的节点(document/storyboard/asset/timeline)。
 */
export const NODE_TYPES: NodeTag[] = [
  { id: 'doc', kind: 'document', name: '提示词 / 文档', sub: 'Markdown · 五段式/六段式' },
  { id: 'storyboard', kind: 'storyboard', name: '分镜表', sub: '脚本 · 一行 = 一个分镜' },
  { id: 'asset', kind: 'asset', name: '资产引用', sub: '角色 / 环境 / 物品 · 资产中心' },
  { id: 'image', kind: 'image-gen', name: '图片生成', sub: 'mlxgen · 默认模型按「设置 → 工具模型」' },
  { id: 'edit', kind: 'image-edit', name: '图片编辑', sub: '指令 / I2I / Inpaint / Outpaint' },
  { id: 'upscale', kind: 'image-upscale', name: '图片增强', sub: 'SeedVR2 超分' },
  { id: 'vupscale', kind: 'video-upscale', name: '视频增强', sub: '超分 + 合修脸 · Real-ESRGAN / SeedVR2' },
  { id: 'crop', kind: 'image-crop', name: '图片裁切', sub: '按画幅裁剪 · 1:1 → 9:16' },
  { id: 'stitch', kind: 'image-stitch', name: '图片拼接', sub: '多图横排/竖排/网格 · ffmpeg' },
  { id: 'split', kind: 'image-split', name: '图片拆分', sub: '长图切片 · 九宫格切图' },
  { id: 'shot', kind: 'shot', name: '镜头（视频）', sub: 'h3.c · 文生/首帧/首尾帧/参考图/参考视频' },
  { id: 'grab', kind: 'frame-grab', name: '视频裁切取帧', sub: '从视频截一帧 → 导出为图片资源' },
  { id: 'audio', kind: 'audio-ref', name: '音频参考', sub: '--ref-audio 带声直出' },
  { id: 'timeline', kind: 'timeline', name: '时间线 / 剪辑', sub: 'FFmpeg 导出' },
];

/**
 * 未实现节点的 kind —— **入口已下架**(2026-10-08),定义保留以便读旧项目文件。
 *
 * 判定标准是「有没有执行分支」:这三类在 `CanvasPage.runNode` 里没有任何分支,
 * 从面板建出来只会得到「连得起来、点运行没反应」的空壳(节点的渲染/检查器/
 * 连线派发仍在,所以已存在的老画布照常打开、照常显示,只是不再能从 UI 新建)。
 *
 * ⚠️ **真正的单一事实源在 `packages/shared/src/connector-map.ts` 的
 * `HIDDEN_NODE_KINDS`**(主进程拒绝 Agent 建节点时用的是它)。
 * 这里只是 re-export,禁止在渲染层再维护第二份名单 —— 两份表分叉正是
 * 2026-09「边画得出来但提交时被静默丢弃」闪烁事故的根因。
 *
 * 恢复入口的前置条件是**先补上 runNode 执行分支**,不是把名字加回来。
 */
export const HIDDEN_KINDS = HIDDEN_NODE_KINDS;

/** 该 kind 是否已下架(UI 不可建;Agent 侧同步拒绝) */
export const isHiddenKind = isHiddenNodeKind;

/**
 * 旧版演示画布的连线白名单(按**节点库短 id**)。
 *
 * ⚠️ 这是早期演示数据的兼容表,已被 `connectors.ts` 的 `resolvePortOptions` +
 * shared `validateEdge` 取代(那两处才是写边的权威判定)。保留它只为老演示数据,
 * 但它包含已下架的 `director` / `wf-*` —— **任何"按此表建节点"的路径都必须先过
 * `isHiddenKind`**,否则会从侧面把空壳节点放回画布。
 */
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

/**
 * 尺寸提示行 —— **直接读 `SHOT_SIZES`**,不再维护第二张尺寸表。
 *
 * ⚠️ 事故(2026-10):这里曾有一张独立的 `RES` 中文表,与 `SHOT_SIZES` 并存,
 * 于是同一个「默认档 16:9」弹层提示 1280×704、检查器显示另一个数,用户看到三个
 * 互不相同的分辨率。现在数值只有 `SHOT_SIZES` 一个来源,提示行不可能再与落盘值分叉。
 * 档位用 `tierKeyOf` 归一(兼容中文标签与英文 key),未知档位返回明确文案而非静默兜底。
 */
export function resLine(aspect: string, tier: string): string {
  const key = tierKeyOf(tier);
  const size = SHOT_SIZES[aspect as VideoAspect]?.[key];
  if (!size) return '该组合不在白名单 · 已禁用（capabilities）';
  const eta = VIDEO_TIER_PRESETS[key].eta;
  return `输出 ${size.width}×${size.height} · 预计 ${eta}（capabilities）`;
}

/* ── Shot 检查器(h3.c 档位 × 画幅,与 packages/providers h3c-command ASPECT_SIZES 对齐) ── */
/** 可选画幅 —— 单一真源在 shared(VIDEO_ASPECTS);这里只补一个 `custom`(走自定义宽高) */
export const SHOT_ASPECTS = [...VIDEO_ASPECTS, 'custom'] as const;
export const SHOT_TIERS = VIDEO_TIERS;
/**
 * 档位 × 画幅 → 宽高 —— **直接从 shared 取**(2026-10 收敛,不再是副本)。
 *
 * 此前这里是 `h3c-command.ASPECT_SIZES` 的手抄副本,而两者的旧比例(16:9/9:16/1:1)
 * 早就分叉了(9 档里 8 档不同,例:16:9/default 这里 1280×704、引擎 864×480)。
 * 现在渲染层与主进程都直接用 shared 的 `SHOT_SIZES`,新增比例只改一处。
 *
 * ⚠️ providers 因包边界不能 import shared,仍保留自己那份 `ASPECT_SIZES`;
 * 单测 `__tests__/shot-aspect.test.ts` 读两侧源码比对防分叉。
 */
export const SHOT_SIZES = SHARED_SHOT_SIZES;

/**
 * 弹层用的**中文档位标签 → 英文档位 key** 映射。
 *
 * ⚠️ 这层映射必须存在,否则取不到尺寸:`AddNodePopover` 的档位 chips 是
 * 「预览/草稿/默认/参考」(中文,给人看的),而 `SHOT_SIZES` / `SHOT_TIER_PRESETS`
 * 的键是 `preview/draft/default/reference`(英文,给机器用的)。
 * 直接把中文当 key 去查表会得到 `undefined`,而 `undefined` 又会**静默**退回到
 * `makeInitialData` 里那份硬编码尺寸(1280×720)—— 于是「弹层选 3:4 默认档,
 * 节点却是 16:9 的 1280×720」,又一次显示与实际不符的真实事故(2026-10)。
 * 故这里显式收口,且 `TIER_KEYS` 兜底保证任何未知标签都有确定语义。
 */
export const TIER_LABEL_TO_KEY: Record<string, (typeof VIDEO_TIERS)[number]> = {
  预览: 'preview',
  草稿: 'draft',
  默认: 'default',
  参考: 'reference',
};

/** 中文档位标签(或已是英文 key)→ 英文 key;未知标签一律回 'default' 而非 undefined */
export function tierKeyOf(labelOrKey: string): (typeof VIDEO_TIERS)[number] {
  if ((VIDEO_TIERS as readonly string[]).includes(labelOrKey)) {
    return labelOrKey as (typeof VIDEO_TIERS)[number];
  }
  return TIER_LABEL_TO_KEY[labelOrKey] ?? 'default';
}
/**
 * 档位预设(F/S/L/R + ETA)— **直接取 shared 的 `VIDEO_TIER_PRESETS`**(全链唯一真源)。
 *
 * ⚠️ 此前这张表在渲染层与 providers 各写一份,数值分叉过(弹窗 ETA 与检查器 ETA
 *    不一致,见 docs/连接器设计.md)。现在 ETA/步数只有 shared 一处:
 *    改档位 → 改 `packages/shared/src/prompt.ts` 的 `VIDEO_TIER_PRESETS`。
 * etaMin 供加速包按步数比例重算预计时间(粗估:少步数只压缩去噪段,权重加载与 VAE 解码是固定成本)。
 */
export const SHOT_TIER_PRESETS = VIDEO_TIER_PRESETS;

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

/** 时长输入框单段上限(= h3 引擎对齐后 ≈15s;与 shared.SHOT_MAX_SECONDS 同口径) */
export const SHOT_MAX_SECONDS = SHARED_SHOT_MAX_SECONDS;

/**
 * 解析时长输入框的一次按键(纯函数,便于单测)。
 *
 * ⚠️ 存在的唯一理由是修一个真实 bug(2026-10-09):
 * 旧实现直接 `Number(e.target.value)`,而 `type="number"` 在全选重输 / 退格删空时
 * 会先抛出**空串**,`Number('') === 0` 且 `0 <= 0` 成立 → 立刻 `setData({seconds:0})`
 * 把值清掉。用户看到「明明填了 5 秒,点一下变成 1 秒」(占位符回落到按 frames 推算的值)。
 *
 * 契约(调用方据此决定要不要写盘):
 *   - `keep: true`  → **不要碰节点数据**,本次输入只是中间态(空 / 半截 / 非法);
 *   - `keep: false` → 把 `seconds`/`frames` 写进节点(`clamped` 表示被上限截断过,要提示用户)。
 *
 * @param raw 输入框当前字符串
 */
export function parseSecondsInput(raw: string): {
  keep: boolean;
  seconds?: number;
  frames?: number;
  clamped?: boolean;
} {
  const t = String(raw ?? '').trim();
  // 空串 = 用户正在清空/重输,绝不能当成 0 写盘 —— 这是丢值的根因
  if (t === '') return { keep: true };
  const s = Number(t);
  // 非法中间态(如只打了 "-"、字母)同样保留草稿,不动数据
  if (!Number.isFinite(s) || s <= 0) return { keep: true };
  const clamped = s > SHOT_MAX_SECONDS;
  const seconds = clamped ? SHOT_MAX_SECONDS : s;
  return { keep: false, seconds, frames: h3FramesForSeconds(seconds), clamped };
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
  /** 关联生成 = h3 Ref2VA(`--ref-image`);UI 用「关联」对齐全中文模式名 */
  'ref-image': '关联',
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

