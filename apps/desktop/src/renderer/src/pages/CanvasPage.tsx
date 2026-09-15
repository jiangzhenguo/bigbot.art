import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CanvasSnapshot, ProjectCanvases, RenderJob, LlmSource, Asset, NodeKind, ShotTakeHistory, Take, DebugLogEntry } from '@bigbotart/shared';
import CanvasSwitcher from '../components/CanvasSwitcher';
import MarkdownText from '../components/MarkdownText';

interface CanvasPageProps {
  onNavigate: (
    page:
      | 'home'
      | 'canvas'
      | 'assets'
      | 'skills'
      | 'timeline'
      | 'settings'
      | 'onboarding'
      | 'projects'
  ) => void;
  projectId: string | null;
  projectName: string;
  projectCanvases: ProjectCanvases | null;
  onSaveCanvas: (snap: CanvasSnapshot) => Promise<void> | void;
  onSwitchCanvas: (canvasId: string) => Promise<CanvasSnapshot | null>;
  onCreateCanvas: (name?: string) => Promise<CanvasSnapshot | null>;
  onDeleteCanvas: (canvasId: string) => Promise<string | null>;
  onRenameCanvas: (canvasId: string, name: string) => Promise<boolean>;
}

/* ══════════════════════════════════════════════════════════════
   画布数据结构 —— 与设计稿 canvas.js 的演示数据一一对应
   ══════════════════════════════════════════════════════════════ */

type EdgeClass = '' | 'stale' | 'ghost';

interface Edge {
  from: string;
  to: string;
  cls: EdgeClass;
  /** 🆕 语义标签(手册 §9):input-brief / first-frame / last-frame / ref-image / ref-audio / slot-<name> */
  label?: string;
}

interface CanvasNode {
  id: string;
  title: string;
  w: number;
  x: number;
  y: number;
  /** 幽灵节点(尚未产出) */
  ghost?: boolean;
  /** 上游改动导致过期 */
  stale?: boolean;
  /** Agent 正在此节点上重跑 */
  agentOn?: boolean;
  /** 节点头部状态点 */
  st?: 'ok' | 'warn';
  /** 节点头部背景覆盖(设计稿用 inline style 指定 --bg) */
  headBg?: string;
  badge?: string;
  /** 解析「+」时用于定位的实测高度(px,未缩放) */
  h?: number;
  kind?: NodeKind | 'plain';
  tag?: NodeTag;
  /** 弹层创建的节点的补充描述行 */
  extra?: string;
  /** 真实业务参数(来自 Agent 规划 / 项目画布快照),渲染与生成用 */
  data?: Record<string, unknown>;
}

/** 由弹层/节点面板创建的新节点的渲染参数 */
interface NodeTag {
  /** 展示层 id(节点库用),与 NodeKind 分开 */
  id: string;
  /** 领域层 kind(写入 CanvasNode.kind 与 CanvasSnapshot) */
  kind: NodeKind;
  name: string;
  sub: string;
  p1?: boolean;
  /** 🆕 v2 工作流专用节点(显示 WF 角标) */
  wf?: boolean;
}

/** 可导出的产物文件路径(右键「另存为」/「在 Finder 中显示」) */
const FINDER_PATH: Record<string, string> = {
  brief: 'briefs/草原之河.md',
  storyboard: 'takes/storyboard_seed88213.png',
  audio: 'refs/草原环境声.mp3',
  shot1: 'takes/shot_01_take3.mp4',
  shot2: 'takes/shot_02_take2.mp4',
  timeline: 'exports/草原之河_v2.mp4',
};

const NODE_TYPES: NodeTag[] = [
  { id: 'doc', kind: 'document', name: '提示词 / 文档', sub: 'Markdown · 五段式/六段式' },
  { id: 'asset', kind: 'asset', name: '资产引用', sub: '角色 / 环境 / 物品 · 资产中心' },
  { id: 'image', kind: 'image-gen', name: '图片生成', sub: 'mlxgen · Z-Image-Turbo' },
  { id: 'edit', kind: 'image-edit', name: '图片编辑', sub: '指令 / I2I / Inpaint / Outpaint' },
  { id: 'upscale', kind: 'image-upscale', name: '图片增强', sub: 'SeedVR2 超分', p1: true },
  { id: 'shot', kind: 'shot', name: '镜头（视频）', sub: 'h3.c · 文生/首帧/首尾帧/Ref2VA' },
  { id: 'director', kind: 'director', name: '导演台', sub: '运镜参考小样', p1: true },
  { id: 'audio', kind: 'audio-ref', name: '音频参考', sub: '--ref-audio 带声直出' },
  { id: 'timeline', kind: 'timeline', name: '时间线 / 剪辑', sub: 'FFmpeg 导出', p1: true },
  { id: 'comfy', kind: 'director', name: 'ComfyUI 工作流', sub: '导入 workflow_api.json', p1: true },
  { id: 'wf-input', kind: 'workflow-input', name: '工作流入口', sub: '声明输入槽位 · 资源容器', wf: true },
  { id: 'wf-output', kind: 'workflow-output', name: '工作流出口', sub: '产物汇聚 · 运行收口', wf: true },
];

const COMPAT: Record<string, string[]> = {
  brief: ['image', 'shot', 'doc', 'director'],
  storyboard: ['edit', 'upscale', 'shot', 'timeline'],
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
  shot: ['wf-output'],
  director: ['wf-output'],
  // asset 也可直接收口(素材直接当产物,虽然不推荐,但合法)
  asset: ['shot', 'edit', 'upscale', 'timeline', 'wf-input', 'wf-output'],
};

/** 档位 × 画幅白名单(防呆) */
const RES: Record<string, Record<string, string>> = {
  预览: { '16:9': '512×288', '9:16': '288×512', '1:1': '384×384' },
  草稿: { '16:9': '960×540', '9:16': '540×960', '1:1': '720×720' },
  默认: { '16:9': '1280×720', '9:16': '720×1280', '1:1': '960×960' },
  参考: { '16:9': '1920×1080' },
};
const ETA: Record<string, string> = {
  预览: '≈2 分钟',
  草稿: '≈4 分钟',
  默认: '≈8 分钟',
  参考: '≈22 分钟',
};

/** 尺寸白名单提示行 */
function resLine(aspect: string, tier: string): string {
  const r = (RES[tier] ?? {})[aspect];
  if (!r) return '该组合不在白名单 · 已禁用（capabilities）';
  return `输出 ${r} · 预计 ${ETA[tier]}（capabilities）`;
}

/* ── Shot 检查器(h3.c 档位 × 画幅,与 packages/providers h3c-command ASPECT_SIZES 对齐) ── */
const SHOT_ASPECTS = ['16:9', '9:16', '1:1', 'custom'] as const;
const SHOT_TIERS = ['preview', 'draft', 'default', 'reference'] as const;
/** 档位 × 画幅 → 宽高(全部 32 倍数合法档,H3_USAGE.md §4.2) */
const SHOT_SIZES: Record<'16:9' | '9:16' | '1:1', Record<(typeof SHOT_TIERS)[number], { width: number; height: number }>> = {
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
/** 档位预设(F/S/L/R + ETA)— H3_USAGE.md §4.3 四组 preset */
const SHOT_TIER_PRESETS: Record<(typeof SHOT_TIERS)[number], { label: string; steps: number; layers: number; reuse: number; frames: number; eta: string; note: string }> = {
  preview: { label: '预览', steps: 6, layers: 40, reuse: 2, frames: 22, eta: '≈4 分钟', note: '极速草稿(reuse2 防呆安全)' },
  draft: { label: '草稿', steps: 12, layers: 50, reuse: 2, frames: 56, eta: '≈9 分钟', note: '快速出片' },
  default: { label: '默认', steps: 20, layers: 50, reuse: 1, frames: 124, eta: '≈15 分钟', note: '5s 段甜点' },
  reference: { label: '参考', steps: 30, layers: 50, reuse: 1, frames: 124, eta: '≈30 分钟', note: 'high quality · gold 档' },
};
const SHOT_MODE_LABEL: Record<string, string> = {
  text2video: '文生',
  'first-frame': '首帧',
  'last-frame': '尾帧',
  'first-last': '首尾帧',
  'ref-image': 'Ref2VA',
};
/** 参考角色(按 mode 可用的)+ 需要的媒体类型 */
const SHOT_REF_ROLES: Record<string, Array<{ role: string; label: string; media: 'image' | 'audio' | 'video'; multiple?: boolean }>> = {
  text2video: [{ role: 'ref-audio', label: '音频参考', media: 'audio' }],
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
};

interface NodeInfo {
  t: string;
  img: string | null;
  meta: Array<[string, string]>;
}

/** 检查器:每个节点的参数表(与 canvas.js NODE_INFO 一致) */
const NODE_INFO_BASE: Record<string, NodeInfo> = {
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
      ['尺寸', '832×480 · 16:9'],
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
function initialNodes(): CanvasNode[] {
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

function initialEdges(): Edge[] {
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

const WAVE_BARS = [10, 18, 26, 14, 22, 30, 16, 24, 12, 20, 28, 14, 22, 10, 18, 26, 16, 12, 20, 8];

/** Agent 规划结果 → Agent 消息气泡内容 */
function planMsg(plan: { document?: unknown; shots?: unknown[]; report?: string; brief?: string }): React.ReactNode {
  const doc = plan.document as { data?: { markdown?: string }; label?: string } | undefined;
  const md = doc?.data?.markdown ?? plan.brief ?? '';
  const shots = plan.shots ?? [];
  return (
    <>
      <b>执行计划（已落到画布）</b>
      {md ? (
        <div className="mut" style={{ marginTop: 4, fontSize: '11px', whiteSpace: 'pre-wrap' }}>
          {md.slice(0, 240)}
        </div>
      ) : null}
      <div style={{ marginTop: 6 }}>
        <div className="step">
          <span className="sm sm-done">✓</span>
          <div>
            <b>创建 Brief 文档节点</b>
            <div className="mut" style={{ fontSize: '11px' }}>
              画布左侧 · 可编辑后增量重规划
            </div>
          </div>
        </div>
        <div className="step">
          <span className="sm sm-done">✓</span>
          <div>
            <b>分镜规划 {shots.length} 镜头</b>
            <div className="mut" style={{ fontSize: '11px' }}>
              {(plan.report ?? '').split('\n')[0] || '已按 H3 五段式拆分'}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function basenameOf(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? p;
}

/** 绝对产物路径 → bba-output:// 相对 URL(保留 mock/、images/ 等子目录) */
function outputUrlOf(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const markers = ['/.bigbotart/outputs/', '/outputs/'];
  for (const m of markers) {
    const i = norm.lastIndexOf(m);
    if (i >= 0) {
      const rel = norm.slice(i + m.length);
      return `bba-output://${rel.split('/').map(encodeURIComponent).join('/')}`;
    }
  }
  return `bba-output://${encodeURIComponent(basenameOf(p))}`;
}

/** 队列条:单个槽位(视频/图片)的当前任务 */
function queueItem(slot: 'video' | 'image', jobs: RenderJob[], nodes: CanvasNode[]): React.ReactNode {
  const job = jobs.find((j) => j.slot === slot && (j.status === 'running' || j.status === 'queued'));
  const node = job ? nodes.find((n) => n.id === job.nodeId) : undefined;
  const running = job?.status === 'running';
  const label = slot === 'video' ? '视频槽位' : '图片槽位';
  if (!job) {
    return (
      <span className="qitem mut">
        <span className="dot ok"></span>
        {label}：空闲
      </span>
    );
  }
  return (
    <span className="qitem">
      <span className="dot" style={{ background: 'var(--warn)' }}></span>
      {label}：{node?.title ?? job.nodeId}
      {running ? (
        <span className="pbar" style={{ width: 110 }}>
          <i style={{ width: `${Math.round((job.progress ?? 0) * 100)}%` }}></i>
        </span>
      ) : null}
      <span className="mono mut">{running ? (job.stage ?? '等待引擎…') : '排队中'}</span>
    </span>
  );
}

/* ══════════════════════════════════════════════════════════════
   画布 ↔ 项目快照双向转换(shared CanvasNode/CanvasEdge ↔ 本地渲染节点;kind 已对齐 shared NodeKind)
   ══════════════════════════════════════════════════════════════ */

/** 按手册 §9 推导边 label:brief→input-brief / asset→按角色 / wf-input→slot-<name> */
function deriveEdgeLabel(src: CanvasNode, dstTag: NodeTag): string | undefined {
  // document → 下游 prompt
  if (src.kind === 'document' && ['image-gen', 'image-edit', 'shot', 'director'].includes(dstTag.kind)) {
    return 'input-brief';
  }
  // asset → shot:按 asset.mediaType 映射到 ref 角色
  if (src.kind === 'asset' && dstTag.kind === 'shot') {
    const mt = String((src.data as { mediaType?: string })?.mediaType ?? 'image');
    if (mt === 'audio' || mt === 'video') return 'ref-audio';
    return 'ref-image';
  }
  // asset → image-edit:输入图
  if (src.kind === 'asset' && dstTag.kind === 'image-edit') return 'input-image';
  // wf-input → 操作节点:slot-<name>
  if (src.kind === 'workflow-input') {
    const slots = (src.data as { slots?: Array<{ name: string; accept: string[] }> })?.slots ?? [];
    const slot = slots.find((s) => {
      // 粗略匹配:slot.accept 含下游类型对应媒体
      if (dstTag.kind === 'shot') return s.accept.includes('text') || s.accept.includes('image') || s.accept.includes('audio');
      if (dstTag.kind === 'image-gen') return s.accept.includes('text');
      if (dstTag.kind === 'image-edit') return s.accept.includes('image') || s.accept.includes('text');
      if (dstTag.kind === 'audio-ref') return s.accept.includes('audio');
      if (dstTag.kind === 'document') return s.accept.includes('text');
      return true;
    });
    return slot ? `slot-${slot.name}` : `slot-默认`;
  }
  return undefined;
}
function makeInitialData(t: NodeTag): Record<string, unknown> {
  switch (t.kind) {
    case 'document':
      return { markdown: '' };
    case 'asset':
      return { assetId: '', mediaType: 'image' };
    case 'image-gen':
      return {
        engine: 'mlxgen',
        model: 'AbstractFramework/z-image-turbo-8bit',
        prompt: '',
        width: 1024,
        height: 1024,
        steps: 24,
        guidance: 1.0,
        seeds: [42],
      };
    case 'image-edit':
      return { engine: 'mlxgen', model: 'qwen-image-edit', prompt: '', mode: 'instruction' };
    case 'image-upscale':
      return { model: 'AbstractFramework/seedvr2-3b-8bit', scale: 2 };
    case 'shot':
      return {
        engine: 'h3c',
        mode: 'text2video',
        prompt: '',
        width: 1280,
        height: 720,
        frames: 124,
        steps: 30,
        layers: 50,
        reuse: 1,
        tier: 'default',
        seed: 7,
        refs: [],
      };
    case 'director':
      return { prompt: '' };
    case 'timeline':
      return { shotNodeIds: [] };
    case 'audio-ref':
      return { assetId: '' };
    case 'workflow-input':
      return { slots: [{ name: '主提示词', accept: ['text'], required: true }] };
    case 'workflow-output':
      return { outputs: [{ name: '成片', kind: 'video', sourceNodeIds: [] }] };
    default:
      return {};
  }
}

/** shared → 本地渲染节点(kind 已对齐,直接透传) */
function fromSharedNode(cn: { id: string; kind: string; label?: string; position?: { x: number; y: number }; width?: number; data?: unknown }): CanvasNode {
  return {
    id: cn.id,
    title: cn.label ?? cn.id,
    w: cn.width ?? 236,
    x: cn.position?.x ?? 40,
    y: cn.position?.y ?? 40,
    kind: (cn.kind as NodeKind) ?? 'shot',
    st: 'ok',
    data: (cn.data ?? {}) as Record<string, unknown>,
  };
}

/** 本地 → shared */
function toSharedNodes(ns: CanvasNode[]): Array<{ id: string; kind: string; label: string; position: { x: number; y: number }; width?: number; data: unknown; createdAt?: string; updatedAt?: string }> {
  return ns.map((n) => ({
    id: n.id,
    kind: n.kind ?? 'document',
    label: n.title,
    position: { x: n.x, y: n.y },
    width: n.w,
    data: n.data ?? defaultDataFor(n.kind ?? 'document'),
  }));
}

function toLocalEdges(ces: Array<{ id?: string; source: string; target: string; label?: string }>): Edge[] {
  return ces.map((e) => ({ from: e.source, to: e.target, cls: '', label: e.label }));
}

function toSharedEdges(es: Edge[]): Array<{ id?: string; source: string; target: string; label?: string }> {
  return es.map((e) => ({ source: e.from, target: e.to, label: e.label }));
}

/** 快照节点没有业务数据时给默认参数(便于渲染与生成;与 makeInitialData 一致) */
function defaultDataFor(kind: string): Record<string, unknown> {
  return makeInitialData({ id: '', kind: kind as NodeKind, name: '', sub: '' });
}

interface ModelOption {
  name: string;
  sub: string;
  source?: LlmSource;
  reset?: boolean;
}

const MODEL_OPTION_FALLBACK: ModelOption[] = [
  { name: '全局默认', sub: '跟随设置页 LLM 来源', reset: true },
];

const SKILLS = ['纸拼贴剧情片', '剧情短片', '电商产品', '科普讲解', '水墨'];

interface ChatMsg {
  id: number;
  kind: 'user' | 'agent' | 'sys';
  /** 纯文本消息 */
  text?: string;
  /** 富文本消息(执行计划/工具调用/校验卡) */
  rich?: React.ReactNode;
  /** 设计稿里的 data-od-id 标识 */
  odId?: string;
  /** 工具调用卡数据(kind=agent 时) */
  toolCall?: { name: string; args: Record<string, unknown>; status: 'running' | 'success' | 'error'; result?: string; nodeId?: string };
  /** loading 占位(发送后到回复前) */
  loading?: boolean;
}

/* ══ 图标:与设计稿内联 SVG 完全一致 ══ */

const ICON_DOC = (
  <>
    <path d="M6 2h9l5 5v15H6Z" />
    <path d="M14 2v6h6M9 13h8M9 17h5" />
  </>
);
const ICON_DOC_S = (
  <>
    <path d="M6 2h9l5 5v15H6Z" />
    <path d="M14 2v6h6" />
  </>
);
const ICON_IMAGE = (
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="1.8" />
    <path d="m4.5 18 5-5 3.5 3.5 3-3 3.5 3.5" />
  </>
);
const ICON_EDIT = (
  <>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </>
);
const ICON_UPSCALE = <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />;
const ICON_SHOT = (
  <>
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <path d="m10 9.5 5 2.5-5 2.5Z" />
  </>
);
const ICON_DIRECTOR = (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.5 8.5-2 5-5 2 2-5Z" />
  </>
);
const ICON_AUDIO = (
  <>
    <path d="M9 18V6l12-3v12" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="18.5" cy="15" r="2.5" />
  </>
);
const ICON_TIMELINE = (
  <>
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <path d="M7 5v14M17 5v14" />
  </>
);
const ICON_COMFY = (
  <>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
    <path d="M10 6.5h7a3.5 3.5 0 0 1 3.5 3.5v4" />
  </>
);
const ICON_ASSET = (
  <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z" />
);
const ICON_WF_INPUT = (
  <>
    <path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3" />
    <path d="m16 8 4 4-4 4M20 12H9" />
  </>
);
const ICON_WF_OUTPUT = (
  <>
    <path d="M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3" />
    <path d="m8 8-4 4 4 4M4 12h11" />
  </>
);

const PALETTE_ICONS: Record<string, React.ReactNode> = {
  doc: ICON_DOC,
  asset: ICON_ASSET,
  image: ICON_IMAGE,
  edit: ICON_EDIT,
  upscale: ICON_UPSCALE,
  shot: ICON_SHOT,
  director: ICON_DIRECTOR,
  audio: ICON_AUDIO,
  timeline: ICON_TIMELINE,
  comfy: ICON_COMFY,
  'wf-input': ICON_WF_INPUT,
  'wf-output': ICON_WF_OUTPUT,
};

const TYPE_ICON: Record<string, React.ReactNode> = {
  document: ICON_DOC_S,
  asset: ICON_ASSET,
  'image-gen': ICON_IMAGE,
  'image-edit': ICON_EDIT,
  'image-upscale': ICON_UPSCALE,
  shot: ICON_SHOT,
  director: ICON_DIRECTOR,
  'audio-ref': ICON_AUDIO,
  timeline: ICON_TIMELINE,
  'workflow-input': ICON_WF_INPUT,
  'workflow-output': ICON_WF_OUTPUT,
  plain: ICON_DOC_S,
};

/* ══════════════════════════════════════════════════════════════ */

/* ── 检查器主体:按 kind 渲染专属表单 ── */
interface InspectorBodyProps {
  node: CanvasNode | undefined;
  infoMap: Record<string, { t: string; img: string | null; meta: Array<[string, string]> }>;
  setInfoMap: React.Dispatch<React.SetStateAction<Record<string, { t: string; img: string | null; meta: Array<[string, string]> }>>>;
  setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>;
  toastMsg: (msg: string) => void;
  projectId: string | null;
  activeCanvasId: string | null;
  jobs: RenderJob[];
  assetsList: Asset[];
  assetCache: Record<string, string>;
  runNode: (nodeId: string) => void;
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="kr">
      <span>{k}</span>
      <span className="mono">{v}</span>
    </div>
  );
}

function KVSection({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="kv">
      {rows.map(([k, v]) => (
        <KV key={k} k={k} v={v} />
      ))}
    </div>
  );
}

function Lbl({ children }: { children: React.ReactNode }) {
  return (
    <div className="lbl" style={{ marginBottom: 8 }}>
      {children}
    </div>
  );
}

function TextAreaField({ label, value, onChange, rows = 4, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; rows?: number; placeholder?: string;
}) {
  return (
    <div>
      <Lbl>{label}</Lbl>
      <textarea
        className="input-w"
        rows={rows}
        style={{ width: '100%', resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 12 }}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Shot 检查器 — 4 态状态面板 + h3.c 完整表单 + Take 历史
   (对齐 states.html §3 已完成态 + §4;h3 参数对齐 H3_USAGE.md §4)
   ══════════════════════════════════════════════════════════════ */
interface ShotInspectorProps {
  node: CanvasNode;
  setData: (patch: Record<string, unknown>) => void;
  projectId: string | null;
  activeCanvasId: string | null;
  jobs: RenderJob[];
  assetsList: Asset[];
  assetCache: Record<string, string>;
  runNode: (nodeId: string) => void;
  toastMsg: (msg: string) => void;
}

/** 缩略图 src(asset localPath → bba-asset://) */
function thumbSrc(assetPath: string | undefined): string | null {
  if (!assetPath) return null;
  return `bba-asset://${assetPath.split('/').pop()}`;
}

/** 宽/高 → 合法 32 倍数(小于 32 取 32;h3 硬性要求) */
function clamp32(v: number, fallback = 544): number {
  const n = Number.isFinite(v) && v > 0 ? v : fallback;
  return Math.max(32, Math.round(n / 32) * 32);
}

/** 视频封面:从 <video> metadata 读真实宽高,按视频比例展示(不再固定 16:9) */
function VideoThumb({ src, badge }: { src: string; badge?: string }) {
  const [ar, setAr] = useState<string | undefined>();
  return (
    <div className="nthumb" style={{ position: 'relative', background: '#000', aspectRatio: ar ?? '16/9', overflow: 'hidden' }}>
      <video
        src={src}
        preload="metadata"
        muted
        playsInline
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (v.videoWidth && v.videoHeight) setAr(`${v.videoWidth} / ${v.videoHeight}`);
        }}
        style={{ width: '100%', height: '100%', objectFit: 'fill', display: 'block' }}
      />
      {badge ? (
        <span
          className="nmeta mono"
          style={{ position: 'absolute', left: 6, bottom: 6, margin: 0, background: 'rgba(0,0,0,.55)', color: '#fff', padding: '2px 7px', borderRadius: 6, fontSize: 10 }}
        >
          {badge}
        </span>
      ) : null}
    </div>
  );
}

function ShotInspector({
  node,
  setData,
  projectId,
  activeCanvasId,
  jobs,
  assetsList,
  assetCache,
  runNode,
  toastMsg,
}: ShotInspectorProps) {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const mode = String(d.mode ?? 'text2video');
  const tier = (String(d.tier ?? 'default') as (typeof SHOT_TIERS)[number]) in SHOT_TIER_PRESETS ? (String(d.tier ?? 'default') as (typeof SHOT_TIERS)[number]) : 'default';
  const aspect = (String(d.aspect ?? '16:9') as (typeof SHOT_ASPECTS)[number]) in SHOT_SIZES || String(d.aspect ?? '16:9') === 'custom' ? (String(d.aspect ?? '16:9') as (typeof SHOT_ASPECTS)[number]) : '16:9';
  const prompt = String(d.prompt ?? '');
  const seconds = Number(d.seconds ?? 0);
  const customWidth = Number(d.customWidth ?? 544);
  const customHeight = Number(d.customHeight ?? 544);
  const seed = Number(d.seed ?? 42);
  const refs = (d.refs ?? []) as Array<{ assetId: string; role: string }>;

  const preset = SHOT_TIER_PRESETS[tier];
  const isCustom = aspect === 'custom';
  // 推导值(比例 × 档位 / 自定义,32 倍数对齐)
  const derived = isCustom
    ? { width: clamp32(customWidth), height: clamp32(customHeight) }
    : (SHOT_SIZES[aspect as '16:9' | '9:16' | '1:1'][tier] ?? SHOT_SIZES['16:9'].default);
  // 节点 data 为权威:有 width/height 就尊重(选择 chips 已同步写入);否则回退推导
  const width = Number(d.width ?? derived.width);
  const height = Number(d.height ?? derived.height);

  // 当前运行/排队任务
  const job = jobs.find((j) => j.nodeId === node.id && (j.status === 'queued' || j.status === 'running'));
  const isRunning = !!job && job.status === 'running';
  const isQueued = !!job && job.status === 'queued';

  // Take 历史
  const [hist, setHist] = useState<ShotTakeHistory | null>(null);
  const refreshHist = useCallback(() => {
    if (!projectId) return;
    void window.bigbotart.takesHistory(projectId, node.id).then(setHist).catch(() => setHist(null));
  }, [projectId, node.id]);
  useEffect(() => {
    refreshHist();
  }, [refreshHist]);
  const takes = hist?.takes ?? [];
  const [selTakeId, setSelTakeId] = useState<string | undefined>();
  const curTake = (selTakeId ? takes.find((t) => t.id === selTakeId) : undefined) ?? takes[0] ?? null; // 默认最新

  // 参考角色(按 mode)
  const roleDefs = SHOT_REF_ROLES[mode] ?? SHOT_REF_ROLES['text2video'] ?? [];

  /** 添加参考:自动从资产库选第一个未绑定的匹配媒体 */
  const addRef = (roleDef: { role: string; label: string; media: 'image' | 'audio' | 'video'; multiple?: boolean }) => {
    if (roleDef.role === 'ref-image') {
      const count = refs.filter((r) => r.role === 'ref-image').length;
      if (count >= 9) {
        toastMsg('参考图最多 9 张');
        return;
      }
    }
    const candidate = assetsList.find((a) => a.kind === roleDef.media && !refs.some((r) => r.assetId === a.id));
    if (!candidate) {
      toastMsg(`没有可用的 ${roleDef.media} 资产 · 先去资产中心导入`);
      return;
    }
    setData({ refs: [...refs, { assetId: candidate.id, role: roleDef.role }] });
    toastMsg(`已绑定${roleDef.label} · ${candidate.name}`);
  };
  const removeRef = (i: number) => setData({ refs: refs.filter((_, j) => j !== i) });
  const setRefRole = (i: number, role: string) => setData({ refs: refs.map((r, j) => (j === i ? { ...r, role } : r)) });

  /** 提交生成(检查器主按钮):节点参数已在 chips 选择时写入 data,直接提交 */
  const submit = () => {
    if (!projectId) {
      toastMsg('先进一个项目再生成');
      return;
    }
    void runNode(node.id);
  };

  const aspectLabel = (a: string) => (a === '16:9' ? '16:9 横屏' : a === '9:16' ? '9:16 竖屏' : a === '1:1' ? '1:1 方' : '自定义');
  const resText = `${width}×${height} · ${aspectLabel(aspect)}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* ── 状态面板(ghost → 待生成 · running → 生产中 · 其余 → 已完成) ── */}
      {isRunning || isQueued ? (
        <div className="gstate run">
          <div className="gs-h">
            <span className="spin" />
            <b>{isRunning ? '生产中' : '排队中'}</b>
            <span className="right">{job?.slot === 'video' ? '视频槽位' : '—'}</span>
          </div>
          {isRunning ? (
            <div className="pbar">
              <i style={{ width: `${Math.round((job?.progress ?? 0) * 100)}%` }} />
            </div>
          ) : null}
          <div className="gs-sub mono">
            {job?.stage ?? (isQueued ? `队列第 ${(jobs.findIndex((j) => j.id === job?.id) + 1) || '?'} 位` : '')}
          </div>
          <div className="gs-act">
            <button
              className="btn btn-s btn-sm"
              onClick={() => {
                if (job) {
                  void window.bigbotart.cancelRender('h3c', { providerTaskId: job.id }).catch(() => undefined);
                  toastMsg('已取消任务');
                }
              }}
            >
              取消任务
            </button>
            <span className="f-hint">修改参数将标 stale,仅重跑受影响节点</span>
          </div>
        </div>
      ) : node.ghost || !curTake ? (
        <div className="gstate pend">
          <div className="gs-h">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3.5 2" />
            </svg>
            <b>待生成</b>
            <span className="right">{SHOT_TIER_PRESETS[tier].eta}</span>
          </div>
          <div className="gs-sub">h3.c · {SHOT_MODE_LABEL[mode]} · {resText} · 显存 ≈25GB</div>
          <button className="btn btn-p btn-sm" style={{ width: '100%' }} onClick={submit}>立即生成</button>
        </div>
      ) : (
        <div className="gok">
          <span className="dot ok" />生成完成 · Take {curTake.attempt} ✓
          {curTake.durationSec !== undefined ? ` · 耗时 ${Math.round(curTake.durationSec / 60)}分${Math.round(curTake.durationSec % 60)}秒` : ''}
          <span className="mono">{curTake.resultPath ? curTake.resultPath.split('/').pop() : ''}</span>
        </div>
      )}

      {/* 产物视频预览(仅已完成态) */}
      {curTake?.resultPath ? (
        <div className="preview">
          <video
            src={outputUrlOf(curTake.resultPath)}
            controls
            preload="metadata"
            style={{ width: '100%', height: 'auto', borderRadius: 'var(--radius-md)', display: 'block', background: '#000' }}
          />
        </div>
      ) : null}

      {/* ── 模式 ── */}
      <div className="f-sec">
        <div className="lbl">生成模式</div>
        <div className="f-chips">
          {Object.keys(SHOT_MODE_LABEL).map((m) => (
            <span key={m} className={`chip${mode === m ? ' on' : ''}`} onClick={() => setData({ mode: m, refs: refs.filter((r) => SHOT_REF_ROLES[m]?.some((rd) => rd.role === r.role)) })}>
              {SHOT_MODE_LABEL[m]}
            </span>
          ))}
        </div>
      </div>

      {/* ── 档位 × 画幅 ── */}
      <div className="f-sec">
        <div className="lbl">档位 × 画幅(白名单防呆)</div>
        <div className="f-row">
          <span className="f-lbl">比例</span>
          <div className="f-chips">
            {SHOT_ASPECTS.map((a) => (
              <span
                key={a}
                className={`chip${aspect === a ? ' on' : ''}`}
                onClick={() => {
                  if (a === 'custom') {
                    setData({ aspect: 'custom', width: clamp32(customWidth), height: clamp32(customHeight) });
                    return;
                  }
                  // 选比例 → 立即按当前档位写入节点参数
                  const sz = SHOT_SIZES[a as '16:9' | '9:16' | '1:1'][tier] ?? SHOT_SIZES['16:9'].default;
                  setData({ aspect: a, width: sz.width, height: sz.height });
                }}
              >
                {a === '16:9' ? '16:9' : a === '9:16' ? '9:16' : a === '1:1' ? '1:1' : '自定义'}
              </span>
            ))}
          </div>
        </div>
        <div className="f-row">
          <span className="f-lbl">档位</span>
          <div className="f-chips">
            {SHOT_TIERS.map((t) => (
              <span
                key={t}
                className={`chip${tier === t ? ' on' : ''}`}
                onClick={() => {
                  // 档位改动 → 自动落 F/S/L/R(预设),清空时长,并按当前比例写节点宽高
                  const p = SHOT_TIER_PRESETS[t];
                  const sz = isCustom
                    ? { width: clamp32(customWidth), height: clamp32(customHeight) }
                    : SHOT_SIZES[aspect as '16:9' | '9:16' | '1:1'][t] ?? SHOT_SIZES['16:9'].default;
                  setData({
                    tier: t,
                    steps: p.steps,
                    layers: p.layers,
                    reuse: p.reuse,
                    frames: p.frames,
                    seconds: 0,
                    width: sz.width,
                    height: sz.height,
                  });
                }}
              >
                {SHOT_TIER_PRESETS[t].label}
              </span>
            ))}
          </div>
        </div>
        {isCustom ? (
          <div className="f-row">
            <span className="f-lbl">宽</span>
            <input
              className="f-in"
              type="number"
              step={32}
              value={customWidth}
              onChange={(e) => {
                const v = Number(e.target.value);
                setData({ customWidth: v, width: clamp32(v) });
              }}
            />
            <span className="f-lbl">高</span>
            <input
              className="f-in"
              type="number"
              step={32}
              value={customHeight}
              onChange={(e) => {
                const v = Number(e.target.value);
                setData({ customHeight: v, height: clamp32(v) });
              }}
            />
            <span className="f-hint" style={{ marginLeft: 4 }}>须为 32 的倍数</span>
          </div>
        ) : null}
        <div className="f-hint">
          输出 {resText} · 预计 ≈{SHOT_TIER_PRESETS[tier].eta.replace('≈', '')} · {SHOT_TIER_PRESETS[tier].note}
        </div>
      </div>

      {/* ── 生成参数 F/S/L/R + seed ── */}
      <div className="f-sec">
        <div className="lbl">生成参数(F/S/L/R)</div>
        <div className="f-grid">
          <div className="fg">
            <span>帧数 F</span>
            <input
              className="f-in"
              type="number"
              value={Number(d.frames ?? 124)}
              onChange={(e) => {
                const f = Number(e.target.value);
                if (Number.isFinite(f) && f > 240) toastMsg('帧数超过 10 秒上限(240) · 建议用时长设置或拆多镜头段落');
                // 直接改帧数 → 清空时长(避免 seconds 优先覆盖),帧数显式生效
                setData({ frames: Number.isFinite(f) ? f : 0, seconds: 0 });
              }}
            />
          </div>
          <div className="fg">
            <span>步数 S</span>
            <input className="f-in" type="number" value={Number(d.steps ?? 20)} onChange={(e) => setData({ steps: Number(e.target.value) })} />
          </div>
          <div className="fg">
            <span>层数 L</span>
            <input className="f-in" type="number" value={Number(d.layers ?? 50)} onChange={(e) => setData({ layers: Number(e.target.value) })} />
          </div>
          <div className="fg">
            <span>复用 R</span>
            <input className="f-in" type="number" value={Number(d.reuse ?? 1)} onChange={(e) => setData({ reuse: Number(e.target.value) })} />
          </div>
        </div>
        <div className="f-row" style={{ marginTop: 6 }}>
          <span className="f-lbl">seed</span>
          <input className="f-in" type="number" value={seed} style={{ width: 76 }} onChange={(e) => setData({ seed: Number(e.target.value) })} />
          <span className="f-lbl">时长</span>
          <input
            className="f-in"
            type="number"
            min={1}
            max={10}
            value={seconds > 0 ? seconds : ''}
            placeholder={`${Math.round(Number(d.frames ?? 124) / 24)}s`}
            style={{ width: 52 }}
            onChange={(e) => {
              let s = Number(e.target.value);
              if (!Number.isFinite(s) || s <= 0) {
                setData({ seconds: 0 });
                return;
              }
              if (s > 10) {
                toastMsg('h3.c 单段时长最多 10 秒 · 更长请拆多镜头段落');
                s = 10;
              }
              // 选时长 → 帧数自动填上(24fps)
              setData({ seconds: s, frames: Math.round(s * 24) });
            }}
          />
          <span className="f-hint">最多 10s(24fps · 10s=240 帧)· 选时长自动填帧数</span>
        </div>
      </div>

      {/* ── 提示词 ── */}
      <div className="f-sec">
        <div className="lbl">提示词(H3 五段式)</div>
        <textarea
          className="f-ta"
          value={prompt}
          placeholder={'Scene: …\nAction: …\nCamera: …\nLook: …\nAudio: …'}
          onChange={(e) => setData({ prompt: e.target.value })}
        />
      </div>

      {/* ── 参考绑定(按 mode 出槽位;Ref2VA 多参考) ── */}
      <div className="f-sec">
        <div className="lbl">参考绑定</div>
        {refs.length === 0 ? (
          <div className="f-hint">绑定首/尾帧、参考图或音频后,生成时自动注入(--ref-* 参数)</div>
        ) : (
          refs.map((r, i) => {
            const path = assetCache[r.assetId];
            const def = roleDefs.find((rd) => rd.role === r.role);
            return (
              <div className="slot" key={`${r.assetId}-${i}`}>
                {path ? <span className="refprev"><img src={thumbSrc(path) ?? ''} alt="" /></span> : <span className="refprev" />}
                <span className="grow">
                  <div className="sname">{def?.label ?? r.role}</div>
                </span>
                <span className="sval">{r.assetId.slice(0, 10)}…</span>
                <button className="btn btn-xs" onClick={() => removeRef(i)} title="移除">×</button>
              </div>
            );
          })
        )}
        {roleDefs.map((rd) => {
          const bound = refs.filter((r) => r.role === rd.role).length;
          const maxed = rd.role === 'ref-image' && bound >= 9;
          return (
            <button
              key={rd.role}
              className="btn btn-s btn-sm"
              disabled={maxed}
              onClick={() => addRef(rd)}
              style={{ marginRight: 6 }}
            >
              ＋ {rd.label}
              {rd.multiple ? `(${bound}/9)` : ''}
            </button>
          );
        })}
      </div>

      {/* ── Take 历史 ── */}
      {takes.length > 1 ? (
        <div className="f-sec">
          <div className="lbl">Take 历史</div>
          <div className="f-chips">
            {takes.slice(0, 8).map((t) => (
              <span
                key={t.id}
                className={`chip${t.id === curTake?.id ? ' on' : ''}${t.status === 'failed' ? ' dis' : ''}`}
                onClick={() => setSelTakeId(t.id)}
                title={t.resultPath ?? t.error ?? `Take ${t.attempt}`}
              >
                T{t.attempt} · {t.status === 'succeeded' ? '✓' : t.status === 'failed' ? '✗' : t.status}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* ── 主按钮 ── */}
      <button className="btn btn-s" style={{ width: '100%' }} onClick={submit}>
        {curTake ? '重新生成' : '立即生成'}
      </button>
    </div>
  );
}

function InspectorBody({ node, infoMap, setInfoMap, setNodes, toastMsg, projectId, activeCanvasId, jobs, assetsList, assetCache, runNode }: InspectorBodyProps) {
  if (!node) return <div className="mut" style={{ fontSize: 12 }}>选中画布上的节点查看与编辑参数</div>;
  const d = (node.data ?? {}) as Record<string, unknown>;
  const setData = (patch: Record<string, unknown>) => {
    setNodes((ns) => ns.map((n) => (n.id === node.id ? { ...n, data: { ...(n.data ?? {}), ...patch } } : n)));
  };
  const info = infoMap[node.id];
  const setInfo = (patch: Partial<{ t: string; img: string | null; meta: Array<[string, string]> }>) => {
    setInfoMap((m) => ({ ...m, [node.id]: { ...(m[node.id] ?? { t: node.title, img: null, meta: [] }), ...patch } }));
  };

  switch (node.kind) {
    case 'document': {
      const md = String(d.markdown ?? '');
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <TextAreaField
            label="Markdown 内容"
            value={md}
            rows={10}
            placeholder="# 标题\n\n场景：…\n角色：…\n风格：…"
            onChange={(v) => setData({ markdown: v })}
          />
          <KVSection rows={[['字符数', String(md.length)], ['行数', String(md.split('\n').length)]]} />
        </div>
      );
    }
    case 'asset': {
      const mediaType = String(d.mediaType ?? 'image');
      const assetId = String(d.assetId ?? '');
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Lbl>媒体类型</Lbl>
            <div className="row g6">
              {(['image', 'video', 'audio', 'document'] as const).map((t) => (
                <span
                  key={t}
                  className={`chip${mediaType === t ? ' on' : ''}`}
                  onClick={() => setData({ mediaType: t })}
                >
                  {t === 'image' ? '图片' : t === 'video' ? '视频' : t === 'audio' ? '音频' : '文档'}
                </span>
              ))}
            </div>
          </div>
          <TextAreaField
            label="资产 ID(从资产中心复制)"
            value={assetId}
            rows={1}
            placeholder="asset-xxxxxxxxxxxx-xxxx"
            onChange={(v) => setData({ assetId: v })}
          />
          <button
            className="btn btn-s btn-sm"
            onClick={() => {
              void window.bigbotart.listAssets().then((all) => {
                const opts = all.filter((a) => a.kind === mediaType);
                if (!opts.length) {
                  toastMsg(`资产库里没有 ${mediaType} 类资产`);
                  return;
                }
                const first = opts[0]!;
                setData({ assetId: first.id });
                toastMsg(`已绑定最新 ${mediaType} 资产:${first.name}`);
              });
            }}
          >
            绑定最新 {mediaType} 资产
          </button>
          {info?.meta ? <KVSection rows={info.meta} /> : null}
        </div>
      );
    }
    case 'image-gen': {
      const model = String(d.model ?? 'AbstractFramework/z-image-turbo-8bit');
      const prompt = String(d.prompt ?? '');
      const w = Number(d.width ?? 1024);
      const h = Number(d.height ?? 1024);
      const seeds = (d.seeds as number[]) ?? [42];
      const steps = Number(d.steps ?? 24);
      const guidance = Number(d.guidance ?? 1.0);
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <TextAreaField label="提示词" value={prompt} rows={4} placeholder="晨雾弥漫的针叶林,远处湖面反射柔光,电影感广角" onChange={(v) => setData({ prompt: v })} />
          <div>
            <Lbl>模型</Lbl>
            <input
              className="input-w mono"
              value={model}
              onChange={(e) => setData({ model: e.target.value })}
              style={{ width: '100%' }}
            />
          </div>
          <div>
            <Lbl>宽 × 高</Lbl>
            <div className="row g6">
              <input className="input-w mono" type="number" value={w} style={{ width: 90 }} onChange={(e) => setData({ width: Number(e.target.value) })} />
              <span className="mut">×</span>
              <input className="input-w mono" type="number" value={h} style={{ width: 90 }} onChange={(e) => setData({ height: Number(e.target.value) })} />
            </div>
          </div>
          <div>
            <Lbl>步数 / 引导</Lbl>
            <div className="row g6">
              <input className="input-w mono" type="number" value={steps} style={{ width: 70 }} onChange={(e) => setData({ steps: Number(e.target.value) })} />
              <span className="mut">/</span>
              <input className="input-w mono" type="number" step="0.1" value={guidance} style={{ width: 70 }} onChange={(e) => setData({ guidance: Number(e.target.value) })} />
            </div>
          </div>
          <div>
            <Lbl>Seeds(逗号分隔)</Lbl>
            <input
              className="input-w mono"
              value={seeds.join(', ')}
              onChange={(e) =>
                setData({ seeds: e.target.value.split(/[,\\s]+/).filter(Boolean).map(Number).filter((x) => Number.isFinite(x)) })
              }
            />
          </div>
          <KVSection rows={[['引擎', 'mlxgen'], ['产物', `${seeds.length} 张 PNG`]]} />
        </div>
      );
    }
    case 'image-edit': {
      const mode = String(d.mode ?? 'instruction');
      const model = String(d.model ?? 'qwen-image-edit');
      const prompt = String(d.prompt ?? '');
      const inputAssetId = String(d.inputAssetId ?? '');
      const maskAssetId = String(d.maskAssetId ?? '');
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Lbl>编辑模式</Lbl>
            <div className="row g6" style={{ flexWrap: 'wrap' }}>
              {(['instruction', 'img2img', 'inpaint', 'outpaint'] as const).map((m) => (
                <span
                  key={m}
                  className={`chip${mode === m ? ' on' : ''}`}
                  onClick={() => setData({ mode: m })}
                >
                  {m === 'instruction' ? '指令编辑' : m === 'img2img' ? 'I2I' : m === 'inpaint' ? 'Inpaint' : 'Outpaint'}
                </span>
              ))}
            </div>
          </div>
          <TextAreaField label="指令 / Prompt" value={prompt} rows={3} placeholder="把背景换成日落,保留主体" onChange={(v) => setData({ prompt: v })} />
          <TextAreaField label="输入图 Asset ID" value={inputAssetId} rows={1} placeholder="asset-…" onChange={(v) => setData({ inputAssetId: v })} />
          {mode === 'inpaint' ? (
            <TextAreaField label="遮罩图 Asset ID(inpaint 必填)" value={maskAssetId} rows={1} placeholder="asset-…" onChange={(v) => setData({ maskAssetId: v })} />
          ) : null}
          <div>
            <Lbl>模型</Lbl>
            <input className="input-w mono" value={model} onChange={(e) => setData({ model: e.target.value })} style={{ width: '100%' }} />
          </div>
        </div>
      );
    }
    case 'image-upscale': {
      const scale = Number(d.scale ?? 2);
      const model = String(d.model ?? 'AbstractFramework/seedvr2-3b-8bit');
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Lbl>放大倍数</Lbl>
            <div className="row g6">
              {[2, 4].map((s) => (
                <span key={s} className={`chip${scale === s ? ' on' : ''}`} onClick={() => setData({ scale: s })}>
                  ×{s}
                </span>
              ))}
            </div>
          </div>
          <div>
            <Lbl>模型</Lbl>
            <input className="input-w mono" value={model} onChange={(e) => setData({ model: e.target.value })} style={{ width: '100%' }} />
          </div>
          <KVSection rows={[['引擎', 'mlxgen · SeedVR2'], ['输入', '来自上游节点产物或 asset']]} />
        </div>
      );
    }
    case 'shot': {
      return (
        <ShotInspector
          node={node}
          setData={setData}
          projectId={projectId}
          activeCanvasId={activeCanvasId}
          jobs={jobs}
          assetsList={assetsList}
          assetCache={assetCache}
          runNode={(id) => void runNode(id)}
          toastMsg={toastMsg}
        />
      );
    }
    case 'director': {
      const prompt = String(d.prompt ?? '');
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <TextAreaField label="导演 prompt(运镜小样)" value={prompt} rows={8} placeholder="机位：低机位仰拍 · 运动：推进 → 拉远 · 景别：中景" onChange={(v) => setData({ prompt: v })} />
          <KVSection rows={[['引擎', '复用 shot 低档(P1 占位)'], ['产物', '运镜参考小样视频']]} />
        </div>
      );
    }
    case 'timeline': {
      const shots = (d.shotNodeIds as string[]) ?? [];
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Lbl>入线镜头(shotNodeIds)</Lbl>
            {shots.length === 0 ? (
              <div className="mut" style={{ fontSize: 12 }}>通过上游 shot 节点连线自动入线</div>
            ) : (
              shots.map((sid, i) => (
                <div key={sid} className="refrow">
                  <span className="mono mut">#{i + 1}</span>
                  <span className="mono">{sid}</span>
                </div>
              ))
            )}
          </div>
          <KVSection rows={[['导出', 'FFmpeg · MP4 H.264+AAC'], ['音轨', '保留各 Take 内嵌音轨']]} />
        </div>
      );
    }
    case 'audio-ref': {
      const assetId = String(d.assetId ?? '');
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <TextAreaField label="音频资产 ID" value={assetId} rows={1} placeholder="asset-…" onChange={(v) => setData({ assetId: v })} />
          <button
            className="btn btn-s btn-sm"
            onClick={() => {
              void window.bigbotart.listAssets().then((all) => {
                const opts = all.filter((a) => a.kind === 'audio' || a.kind === 'video');
                if (!opts.length) {
                  toastMsg('资产库里没有音频/视频资产');
                  return;
                }
                const first = opts[0]!;
                setData({ assetId: first.id });
                toastMsg(`已绑定:${first.name}`);
              });
            }}
          >
            绑定最新音频 / 视频资产
          </button>
          <KVSection rows={[['用途', '--ref-audio 带声直出']]} />
        </div>
      );
    }
    case 'workflow-input': {
      const slots = (d.slots as Array<{ name: string; accept: string[]; required: boolean; value?: unknown }>) ?? [];
      const updateSlot = (i: number, patch: Record<string, unknown>) => {
        const next = slots.map((s, j) => (j === i ? { ...s, ...patch } : s));
        setData({ slots: next });
      };
      const removeSlot = (i: number) => setData({ slots: slots.filter((_, j) => j !== i) });
      const addSlot = () =>
        setData({ slots: [...slots, { name: `槽位-${slots.length + 1}`, accept: ['text'], required: false }] });
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Lbl>输入槽位 ×{slots.length}</Lbl>
            {slots.map((s, i) => (
              <div key={i} style={{ border: '1px solid var(--border-soft)', borderRadius: 8, padding: '8px 10px', marginBottom: 6 }}>
                <div className="row g6">
                  <input
                    className="input-w mono"
                    value={s.name}
                    style={{ flex: 1, fontWeight: 600 }}
                    onChange={(e) => updateSlot(i, { name: e.target.value })}
                  />
                  <button className="btn btn-g btn-sm" onClick={() => removeSlot(i)}>×</button>
                </div>
                <div className="row g6" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                  {(['image', 'video', 'audio', 'document', 'text'] as const).map((t) => (
                    <span
                      key={t}
                      className={`chip${s.accept.includes(t) ? ' on' : ''}`}
                      style={{ fontSize: 10, padding: '2px 8px' }}
                      onClick={() => {
                        const has = s.accept.includes(t);
                        updateSlot(i, { accept: has ? s.accept.filter((x) => x !== t) : [...s.accept, t] });
                      }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
                <div className="row g6" style={{ marginTop: 6 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                    <input
                      type="checkbox"
                      checked={s.required}
                      onChange={(e) => updateSlot(i, { required: e.target.checked })}
                    />
                    必填
                  </label>
                  <span className="mono mut" style={{ fontSize: 10, marginLeft: 'auto' }}>
                    {s.value ? '已填充 ✓' : '未填充'}
                  </span>
                </div>
              </div>
            ))}
            <button className="btn btn-s btn-sm" onClick={addSlot}>＋ 添加槽位</button>
          </div>
          <KVSection rows={[['语义', '工作流入口 · 槽位注入下游节点 data']]} />
        </div>
      );
    }
    case 'workflow-output': {
      const outputs = (d.outputs as Array<{ name: string; kind: string; sourceNodeIds: string[] }>) ?? [];
      const updateOut = (i: number, patch: Record<string, unknown>) =>
        setData({ outputs: outputs.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
      const removeOut = (i: number) => setData({ outputs: outputs.filter((_, j) => j !== i) });
      const addOut = () =>
        setData({ outputs: [...outputs, { name: `产物-${outputs.length + 1}`, kind: 'video', sourceNodeIds: [] }] });
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Lbl>产物汇聚 ×{outputs.length}</Lbl>
            {outputs.map((o, i) => (
              <div key={i} style={{ border: '1px solid var(--border-soft)', borderRadius: 8, padding: '8px 10px', marginBottom: 6 }}>
                <div className="row g6">
                  <input
                    className="input-w mono"
                    value={o.name}
                    style={{ flex: 1, fontWeight: 600 }}
                    onChange={(e) => updateOut(i, { name: e.target.value })}
                  />
                  <button className="btn btn-g btn-sm" onClick={() => removeOut(i)}>×</button>
                </div>
                <div className="row g6" style={{ marginTop: 6 }}>
                  {(['image', 'video', 'audio', 'document'] as const).map((k) => (
                    <span
                      key={k}
                      className={`chip${o.kind === k ? ' on' : ''}`}
                      style={{ fontSize: 10, padding: '2px 8px' }}
                      onClick={() => updateOut(i, { kind: k })}
                    >
                      {k}
                    </span>
                  ))}
                </div>
                <div className="row g6" style={{ marginTop: 6 }}>
                  <span className="mono mut" style={{ fontSize: 10 }}>×{o.sourceNodeIds.length} 个 source 节点</span>
                </div>
              </div>
            ))}
            <button className="btn btn-s btn-sm" onClick={addOut}>＋ 添加产物</button>
          </div>
          <KVSection rows={[['语义', '工作流出口 · 运行收口 · runs/<runId>/final/']]} />
        </div>
      );
    }
    default: {
      return (
        <div className="mut" style={{ fontSize: 12 }}>
          {node.extra ?? '该节点类型暂无专属编辑器'}
        </div>
      );
    }
  }
}

export default function CanvasPage({
  onNavigate,
  projectId,
  projectName,
  projectCanvases,
  onSaveCanvas,
  onSwitchCanvas,
  onCreateCanvas,
  onDeleteCanvas,
  onRenameCanvas,
}: CanvasPageProps) {
  const stageRef = useRef<HTMLElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const edgesSvgRef = useRef<SVGSVGElement | null>(null);
  const nodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const chatRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const gripRef = useRef<HTMLButtonElement | null>(null);
  const agentRef = useRef<HTMLElement | null>(null);
  const minimapRef = useRef<HTMLDivElement | null>(null);
  const toastTimer = useRef<number | null>(null);
  const queueTimer = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);

  /* ── 视图:平移 / 缩放(以指针为中心滚轮缩放) ── */
  const [view, setView] = useState({ x: 20, y: 10, z: 0.86 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [panning, setPanning] = useState(false);

  /* ── 画布数据 ── */
  const [nodes, setNodes] = useState<CanvasNode[]>(initialNodes);
  const [edges, setEdges] = useState<Edge[]>(initialEdges);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const [selected, setSelected] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [infoMap, setInfoMap] = useState<Record<string, NodeInfo>>(() => ({
    ...NODE_INFO_BASE,
  }));

  /* ── 面板 / 弹层 / 底部状态 ── */
  const [palCollapsed, setPalCollapsed] = useState(false);
  const [agentW, setAgentW] = useState(344);
  const [agentResizing, setAgentResizing] = useState(false);
  const [tab, setTab] = useState<'chat' | 'insp'>('chat');
  const [openPop, setOpenPop] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string } | null>(null);
  const [toast, setToast] = useState<{ msg: string; n: number } | null>(null);
  const [inspectTitle, setInspectTitle] = useState('镜头 02 · 男主踱步');

  /* ── 自增 id / 演示附件轮换 ── */
  const nextId = useRef(0);
  const msgId = useRef(100);

  /* ── M1:渲染队列(真实任务) + 画布持久化 ── */
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const bootRef = useRef(true); // 挂载期跳过首轮保存(等加载/规划落地)
  const prevJobState = useRef<Record<string, string>>({});
  const assetCache = useRef<Record<string, string>>({}); // assetId → localPath
  const [assetsList, setAssetsList] = useState<Asset[]>([]);
  /* ── Agent 对话:发送中/工具事件 ── */
  const [sending, setSending] = useState(false);

  /* ── 「+」下游节点弹层 ── */
  const [apFrom, setApFrom] = useState<string | null>(null);
  const [apOpen, setApOpen] = useState(false);
  const [apSearch, setApSearch] = useState('');
  const [apSel, setApSel] = useState<string | null>(null);
  const [apAspect, setApAspect] = useState('16:9');
  const [apTier, setApTier] = useState('默认');
  const [apShowAll, setApShowAll] = useState(false);

  /* ── 检查器:档位 × 画幅 ── */
  const [iAspect, setIAspect] = useState('16:9');
  const [iTier, setITier] = useState('默认');

  /* ── Agent 面板 ── */
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [model, setModel] = useState('Ornith-1.5-35B · 本地');
  /* 模型选择器:真实清单(已加载本地模型 + 已启用云端供应商模型),打开弹层时刷新 */
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(MODEL_OPTION_FALLBACK);
  const loadModelOptions = useCallback(async (): Promise<void> => {
    const opts: ModelOption[] = [];
    try {
      const kinds = [
        ['lmstudio', 'LM Studio', 'lmstudio'],
        ['ollama', 'Ollama', 'ollama'],
        ['pimlx', 'pi-mlx', 'mlx-provider'],
      ] as const;
      const runtimes = await Promise.all(
        kinds.map(([k]) => window.bigbotart.llmLocalModels(k).catch(() => null)),
      );
      runtimes.forEach((rt, i) => {
        const k = kinds[i];
        if (!rt?.available || !k) return;
        const [, label, sourceKind] = k;
        rt.models
          .filter((m) => m.loaded)
          .forEach((m) => {
            const dn = m.displayName ?? m.id;
            opts.push({
              name: `${dn} · 本地`,
              sub: `${dn} · ${label}`,
              source: { kind: sourceKind, model: m.id } as LlmSource,
            });
          });
      });
      const s = await window.bigbotart.getSettings();
      for (const p of s.cloudProviders ?? []) {
        if (!p.enabled || !p.models.length) continue;
        p.models.forEach((mid) =>
          opts.push({
            name: `${mid} · ${p.name}`,
            sub: `${mid} · ${p.name}${p.hasKey ? '' : ' · 缺 Key'}`,
            source: { kind: 'cloud', provider: p.id, model: mid },
          }),
        );
      }
    } catch {
      /* 清单拉取失败:保留全局默认兜底 */
    }
    opts.push(...MODEL_OPTION_FALLBACK);
    setModelOptions(opts);
  }, []);
  const [skill, setSkill] = useState('纸拼贴剧情片');
  const skillOn = !!skill && skill !== '无技能';

  /* ── 附件(真资产库导入) ── */
  const [attachments, setAttachments] = useState<Asset[]>([]);

  const resHint = resLine(apAspect, apTier);
  const inspHint = `${resLine(iAspect, iTier)} · 改动将标 stale，仅重跑受影响节点`;
  const selInfo = selected ? infoMap[selected] : undefined;
  const selNode = selected ? nodes.find((n) => n.id === selected) : undefined;

  const toastMsg = useCallback((msg: string) => {
    setToast({ msg, n: Date.now() });
  }, []);

  useEffect(() => {
    if (!toast) return;
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    const msg = toast.msg;
    toastTimer.current = window.setTimeout(() => {
      setToast((cur) => (cur && cur.msg === msg ? null : cur));
    }, 2400);
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, [toast]);

  /* ── 尺寸观测:连线端口 + 「+」弹层定位 ── */
  const measure = useCallback((id: string, h: number) => {
    const el = nodeRefs.current.get(id);
    if (!el) return;
    const w = el.offsetWidth;
    setNodes((ns) =>
      ns.some((n) => n.id === id && n.h === h && n.w === w)
        ? ns
        : ns.map((n) => (n.id === id ? { ...n, h, w } : n)),
    );
  }, []);

  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.node;
        if (!id) continue;
        measure(id, (e.target as HTMLElement).offsetHeight);
      }
    });
    nodeRefs.current.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [nodes.length, measure]);

  /* ── 节点定位 + 拖拽(scale 校正,和 canvas.js 一致) ── */
  const dragRef = useRef<{
    id: string;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
  } | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const z = viewRef.current.z;
      setNodes((ns) =>
        ns.map((n) =>
          n.id === d.id
            ? { ...n, x: d.ox + (e.clientX - d.sx) / z, y: d.oy + (e.clientY - d.sy) / z }
            : n,
        ),
      );
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  /* ── 空白处拖拽平移 ── */
  const panStartRef = useRef({ sx: 0, sy: 0, vx: 0, vy: 0 });
  const beginPan = (e: React.PointerEvent) => {
    panStartRef.current = {
      sx: e.clientX,
      sy: e.clientY,
      vx: viewRef.current.x,
      vy: viewRef.current.y,
    };
    setPanning(true);
  };
  useEffect(() => {
    if (!panning) return;
    const onMove = (e: PointerEvent) => {
      const s = panStartRef.current;
      setView((v) => ({ ...v, x: s.vx + (e.clientX - s.sx), y: s.vy + (e.clientY - s.sy) }));
    };
    const onUp = () => setPanning(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [panning]);

  /* ── 滚轮:以指针为中心缩放 ── */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0016);
        const nz = Math.min(1.3, Math.max(0.4, v.z * factor));
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const k = nz / v.z;
        return { z: nz, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k };
      });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  /* ── Agent 面板宽度 ── */
  const agentMax = useCallback(
    () => Math.min(620, Math.round(window.innerWidth * 0.5)),
    [],
  );

  const setAgentWidth = useCallback(
    (w: number, commit: boolean) => {
      const nw = Math.max(344, Math.min(agentMax(), Math.round(w)));
      setAgentW(nw);
      if (gripRef.current) gripRef.current.style.right = `${12 + nw - 6}px`;
      if (minimapRef.current) minimapRef.current.style.right = `${nw + 26}px`;
      if (commit) {
        try {
          localStorage.setItem('bba-agent-w', String(nw));
        } catch {
          /* 忽略存储异常 */
        }
      }
      return nw;
    },
    [agentMax],
  );

  useEffect(() => {
    let saved = 344;
    try {
      const raw = parseInt(localStorage.getItem('bba-agent-w') ?? '', 10);
      if (!Number.isNaN(raw)) saved = raw;
    } catch {
      /* 忽略存储异常 */
    }
    setAgentWidth(saved, false);
    const onResize = () => setAgentWidth(agentWRef.current, false);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [setAgentWidth]);

  const agentWRef = useRef(agentW);
  agentWRef.current = agentW;

  const agentDragRef = useRef<{ sx: number; w: number } | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = agentDragRef.current;
      if (!d) return;
      setAgentWidth(d.w + (d.sx - e.clientX), false);
    };
    const onUp = () => {
      if (!agentDragRef.current) return;
      agentDragRef.current = null;
      setAgentWidth(agentWRef.current, true);
      setAgentResizing(false);
      gripRef.current?.classList.remove('on');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [setAgentWidth]);

  /* ── 定位到节点(闪一下) ── */
  const locate = useCallback((id: string) => {
    setFlashId(id);
    window.setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), 1200);
  }, []);

  /* ══ 选择节点 → 检查器 ══ */
  const selectNode = useCallback((id: string | null) => {
    setSelected(id);
    if (!id) return;
    const info = NODE_INFO_BASE[id];
    setInfoMap((m) => {
      if (m[id] || !info) return m;
      return { ...m, [id]: info };
    });
    // 演示节点用 NODE_INFO_BASE 标题;新节点用自身 title
    const node = nodesRef.current.find((n) => n.id === id);
    setInspectTitle(info?.t ?? node?.title ?? id);
    setTab('insp');
  }, []);

  /* ══ 对话发送 / 打断 ══ */
  const autoGrow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  /* 把 Agent 规划物化为画布节点(保留已有节点,新增 Brief/镜头并连线) */
  /* 当前活动画布 id(派生自 props) */
  const activeCanvasId = projectCanvases?.activeCanvasId ?? '';
  const activeCanvas = projectCanvases?.canvases.find((c) => c.id === activeCanvasId);

  const materializePlan = useCallback(
    (plan: { document: unknown; shots: unknown[]; edges: Array<{ source: string; target: string }> }) => {
      const docNode = fromSharedNode(plan.document as never);
      const shotNodes = (plan.shots ?? []).map((s) => fromSharedNode(s as never));
      const all = [...shotNodes, docNode];
      const idSet = new Set(nodesRef.current.map((n) => n.id));
      const toAdd = all.filter((n) => !idSet.has(n.id));
      if (toAdd.length === 0) return;
      setNodes((ns) => [...ns, ...toAdd]);
      setEdges((es) => [
        ...es,
        ...plan.edges
          .filter((e) => { const a = idSet.has(e.source) || toAdd.some((n) => n.id === e.source); const b = idSet.has(e.target) || toAdd.some((n) => n.id === e.target); return a && b; })
          .map((e) => ({ from: e.source, to: e.target, cls: '' as const })),
      ]);
      toastMsg(`已新增 ${toAdd.length} 个节点到画布`);
    },
    [toastMsg],
  );

  const send = useCallback(
    (overrideText?: string) => {
      const v = (overrideText ?? chatInput).trim();
      if (!v || sending) return;
      const pid = projectId;
      const cid = activeCanvasId;
      if (!pid || !cid) {
        toastMsg('请先进入一个项目画布');
        return;
      }
      setMsgs((m) => [...m, { id: ++msgId.current, kind: 'user', text: v }]);
      setChatInput('');
      if (inputRef.current) {
        inputRef.current.value = '';
        autoGrow(inputRef.current);
      }
      // loading 气泡
      const loadingId = ++msgId.current;
      setSending(true);
      setMsgs((m) => [...m, { id: loadingId, kind: 'sys', loading: true, text: '思考中…' }]);
      if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;

      window.bigbotart
        .agentChat({ projectId: pid, canvasId: cid, text: v })
        .then((res) => {
          setMsgs((m) => {
            const rest = m.filter((x) => x.id !== loadingId);
            const out: ChatMsg[] = [...rest];
            // 工具调用卡
            for (const tc of res.toolCalls ?? []) {
              out.push({
                id: ++msgId.current,
                kind: 'agent',
                odId: 'agent-tools',
                toolCall: { name: tc.name, args: tc.args, status: tc.ok ? 'success' : 'error', result: tc.result, nodeId: tc.nodeId },
              });
            }
            if (res.aborted) {
              out.push({ id: ++msgId.current, kind: 'sys', text: '已打断 · 可直接在画布修改' });
            } else if (res.ok && res.reply) {
              out.push({ id: ++msgId.current, kind: 'agent', text: res.reply });
            } else if (!res.ok) {
              out.push({ id: ++msgId.current, kind: 'sys', text: `对话失败:${res.error ?? '未知错误'}` });
            }
            return out;
          });
        })
        .catch((e) => {
          setMsgs((m) => [
            ...m.filter((x) => x.id !== loadingId),
            { id: ++msgId.current, kind: 'sys', text: `对话失败:${e instanceof Error ? e.message : String(e)}` },
          ]);
        })
        .finally(() => {
          setSending(false);
          // 画布可能被工具改动:重新加载当前画布
          void window.bigbotart.loadProjectCanvases(pid).then(() => {
            // 触发 activeCanvasId 变化 effect 由 App 的 projectCanvases 刷新驱动;
            // 这里直接刷新本地节点(工具已改 store,重拉)
            void refreshCanvasFromStore();
          });
          if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
        });
    },
    [chatInput, projectId, activeCanvasId, sending],
  );

  /** 真实打断:中止 worker 内 LLM 请求 */
  const interrupt = useCallback(() => {
    if (!projectId) return;
    void window.bigbotart.agentCancel(projectId);
    setMsgs((m) => [
      ...m.filter((x) => !x.loading),
      { id: ++msgId.current, kind: 'sys', text: '已打断 · 可直接在画布修改,Agent 将基于当前画布增量重规划' },
    ]);
    setSending(false);
  }, [projectId]);


  /** 构建当前画布快照(节点+边)——给保存/切换前 flush-save 用 */
  const buildActiveSnapshot = useCallback((): CanvasSnapshot | null => {
    if (!activeCanvas) return null;
    return {
      id: activeCanvas.id,
      projectId: activeCanvas.projectId,
      name: activeCanvas.name,
      nodes: toSharedNodes(nodes) as never,
      edges: toSharedEdges(edges) as never,
      version: activeCanvas.version,
      createdAt: activeCanvas.createdAt,
      updatedAt: new Date().toISOString(),
    };
  }, [activeCanvas, nodes, edges]);

  /** 切换画布前先 flush 当前画布的未保存改动 */
  const flushSaveNow = useCallback(() => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const snap = buildActiveSnapshot();
    if (snap) void onSaveCanvas(snap);
  }, [buildActiveSnapshot, onSaveCanvas]);

  /** 切画布包装:先 flush-save 再走 onSwitchCanvas */
  const switchCanvas = useCallback(
    async (id: string): Promise<CanvasSnapshot | null> => {
      if (id === activeCanvasId) return activeCanvas ?? null;
      flushSaveNow();
      return onSwitchCanvas(id);
    },
    [activeCanvasId, activeCanvas, flushSaveNow, onSwitchCanvas],
  );

  /* 挂载 / 切换画布 / 项目切换:把 active 快照装进本地 nodes/edges */
  useEffect(() => {
    if (!projectCanvases || !activeCanvas) return;
    bootRef.current = true;
    setNodes(activeCanvas.nodes.map((n) => fromSharedNode(n as never)));
    setEdges(toLocalEdges(activeCanvas.edges as never));
    setSelected(null);
    setFlashId(null);
    setMsgs([{ id: ++msgId.current, kind: 'agent', odId: 'agent-plan', rich: PLAN_MSG }]);
    requestAnimationFrame(() => {
      bootRef.current = false;
    });
  }, [activeCanvasId, projectId]);

  /** 物化 sessionStorage 里的 Agent 规划(从首页跳到画布时) */
  useEffect(() => {
    const raw = sessionStorage.getItem('bba.plan');
    if (!raw) return;
    sessionStorage.removeItem('bba.plan');
    try {
      const plan = JSON.parse(raw) as {
        document: unknown;
        shots: unknown[];
        edges: Array<{ source: string; target: string }>;
        report?: string;
      };
      const docNode = fromSharedNode(plan.document as never);
      const shotNodes = (plan.shots ?? []).map((s) => fromSharedNode(s as never));
      setNodes([docNode, ...shotNodes]);
      setEdges(toLocalEdges(plan.edges ?? []));
      setSelected(shotNodes[0]?.id ?? docNode.id);
      setMsgs((m) => [
        ...m,
        { id: ++msgId.current, kind: 'agent', odId: 'agent-plan', rich: planMsg(plan) },
      ]);
    } catch (e) {
      console.error('规划落地失败', e);
    }
  }, []);

  /** 资产本地路径缓存(挂载时拉取) */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await window.bigbotart.listAssets();
        if (alive) {
          assetCache.current = Object.fromEntries(list.map((a) => [a.id, a.localPath]));
          setAssetsList(list);
        }
      } catch {
        /* 资产可为空 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);

  /** 工具改画布后:从 store 重新拉当前画布刷新节点 */
  const refreshCanvasFromStore = useCallback(async () => {
    if (!projectId || !activeCanvasId) return;
    try {
      const pc = await window.bigbotart.loadProjectCanvases(projectId);
      const cur = pc.canvases.find((c) => c.id === activeCanvasId);
      if (!cur) return;
      setNodes(cur.nodes.map((n) => fromSharedNode(n as never)));
      setEdges(toLocalEdges(cur.edges as never[]));
    } catch (e) {
      console.error('刷新画布失败', e);
    }
  }, [projectId, activeCanvasId]);

  /** 挂载时恢复当前画布的对话历史(recall) */
  useEffect(() => {
    if (!projectId || !activeCanvasId) return;
    let alive = true;
    void window.bigbotart.memoryGet(projectId).then((mem) => {
      if (!alive) return;
      const recent = mem.recall
        .filter((r) => r.canvasId === activeCanvasId)
        .slice(-20);
      if (recent.length === 0) return;
      const restored: ChatMsg[] = recent.map((r) => ({
        id: ++msgId.current,
        kind: r.role === 'user' ? 'user' : r.role === 'tool' ? 'agent' : 'agent',
        text: r.role === 'tool' ? undefined : r.content,
        toolCall: r.role === 'tool' && r.toolName
          ? { name: r.toolName, args: r.toolArgs ?? {}, status: 'success' as const, result: r.toolResult }
          : undefined,
      }));
      setMsgs((m) => [...restored, ...m.filter((x) => x.odId !== 'agent-plan' || m.length <= 1)]);
      // 若有历史则不显示演示开场
      setMsgs((m) => m.filter((x, i) => !(i === 0 && x.odId === 'agent-plan' && restored.length > 0)));
    });
    return () => {
      alive = false;
    };
  }, [projectId, activeCanvasId]);

  /** 订阅 Agent 实时事件(工具开始/结束 → 工具卡状态;连续性校验 → 校验卡) */
  useEffect(() => {
    const off = window.bigbotart.onAgentEvent((ev) => {
      if (ev.projectId && projectId && ev.projectId !== projectId) return;
      if (ev.canvasId && activeCanvasId && ev.canvasId !== activeCanvasId) return;
      if (ev.kind === 'tool-start' && ev.toolName) {
        setMsgs((m) => [
          ...m.filter((x) => !x.loading),
          {
            id: ++msgId.current,
            kind: 'agent',
            odId: 'agent-tools',
            toolCall: { name: ev.toolName!, args: ev.toolArgs ?? {}, status: 'running' },
          },
        ]);
      } else if (ev.kind === 'tool-end' && ev.toolName) {
        setMsgs((m) => {
          // 找最后一条同名 running 工具卡,更新为 success/error
          const idx = [...m].reverse().findIndex(
            (x) => x.toolCall !== undefined && x.toolCall.name === ev.toolName && x.toolCall.status === 'running',
          );
          if (idx < 0) return m;
          const realIdx = m.length - 1 - idx;
          const prev = m[realIdx];
          if (!prev?.toolCall) return m;
          const next = [...m];
          next[realIdx] = {
            ...prev,
            toolCall: {
              name: prev.toolCall.name,
              args: prev.toolCall.args,
              status: ev.ok ? 'success' : 'error',
              result: ev.result,
              nodeId: ev.nodeId,
            },
          };
          return next;
        });
        // 工具改了画布:刷新节点
        if (ev.toolName.startsWith('canvas.')) void refreshCanvasFromStore();
      } else if (ev.kind === 'continuity') {
        setMsgs((m) => [
          ...m,
          {
            id: ++msgId.current,
            kind: 'agent',
            odId: 'agent-check',
            rich: (
              <>
                <b className="mut">校验 Agent（自动）</b>
                <div className="mut" style={{ marginTop: 4, fontSize: '11px' }}>
                  {ev.issues?.length ? ev.issues.join('；') : (ev.result ?? '连续性校验通过')}
                </div>
              </>
            ),
          },
        ]);
      } else if (ev.kind === 'aborted') {
        setMsgs((m) => m.filter((x) => !x.loading));
      }
      if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
    });
    return off;
  }, [projectId, activeCanvasId, refreshCanvasFromStore]);

  /* 画布自动持久化(防抖 800ms;只在 active canvas 有内容时写) */
  useEffect(() => {
    if (bootRef.current || !projectId || !activeCanvas) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const snap = buildActiveSnapshot();
      if (snap) void onSaveCanvas(snap);
    }, 800);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, projectId, activeCanvasId]);

  /* 镜头产物回填:nodeId → 最新成功 Take resultPath(画布加载 + 任务完成后刷新)
     (历史 Take 只在 takes json,节点 data 可能缺 resultPath → 渲染时两层回退) */
  const [takeResults, setTakeResults] = useState<Record<string, string>>({});
  const refreshTakeResults = useCallback(async () => {
    if (!projectId) return;
    const shotIds = nodesRef.current.filter((x) => x.kind === 'shot').map((x) => x.id);
    if (shotIds.length === 0) return;
    const out: Record<string, string> = {};
    await Promise.all(
      shotIds.map(async (id) => {
        try {
          const h = await window.bigbotart.takesHistory(projectId, id);
          const ok = h?.takes?.find((t) => t.status === 'succeeded' && t.resultPath);
          if (ok?.resultPath) out[id] = ok.resultPath;
        } catch {
          /* 单个节点失败不影响其它 */
        }
      }),
    );
    setTakeResults(out);
  }, [projectId]);
  useEffect(() => {
    void refreshTakeResults();
  }, [refreshTakeResults]);

  /* 渲染队列轮询(1.2s)+ 任务完成时更新节点状态 */
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const list = await window.bigbotart.queueStatus();
        if (!alive) return;
        setJobs(list);
        // 完成/失败的任务回写节点:成功取 Take 缩略图,失败置 stale
        for (const j of list) {
          const prev = prevJobState.current[j.id];
          if (prev === j.status) continue;
          prevJobState.current[j.id] = j.status;
          if (j.status === 'succeeded') {
            setNodes((ns) =>
              ns.map((n) =>
                n.id === j.nodeId
                  ? {
                      ...n,
                      ghost: false,
                      stale: false,
                      badge: undefined,
                      extra: j.resultPath ? `✓ ${basenameOf(j.resultPath)}` : '✓ 生成完成',
                      // 产物路径存进节点 data(节点卡/检查器渲染视频用)
                      data: { ...(n.data ?? {}), resultPath: j.resultPath ?? (n.data as Record<string, unknown>)?.resultPath },
                    }
                  : n,
              ),
            );
          } else if (j.status === 'failed') {
            setNodes((ns) => ns.map((n) => (n.id === j.nodeId ? { ...n, badge: `失败 · ${j.error ?? '未知错误'}` } : n)));
          } else if (j.status === 'running') {
            setNodes((ns) => ns.map((n) => (n.id === j.nodeId ? { ...n, badge: j.stage ?? '生成中…' } : n)));
          }
        }
        // 任务状态变化后刷新镜头产物回填(完成后立即在节点卡显示视频)
        void refreshTakeResults();
      } catch {
        /* 轮询失败静默 */
      }
    };
    void poll();
    queueTimer.current = window.setInterval(poll, 1200);
    return () => {
      alive = false;
      if (queueTimer.current) window.clearInterval(queueTimer.current);
    };
  }, [refreshTakeResults]);

  useEffect(() => {
    const el = inputRef.current;
    if (el) el.value = chatInput;
  }, [chatInput]);

  /* 连线自动同步 refs:asset → shot 边(label=ref-audio/ref-image)自动写入下游 shot.data.refs
     (需求 7:音频/图片参考走连线自动注入;手动添加的 refs 保留,按 assetId+role 去重) */
  useEffect(() => {
    const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
    const patchMap = new Map<string, Array<{ assetId: string; role: string }>>();
    for (const e of edges) {
      const src = byId.get(e.from);
      const dst = byId.get(e.to);
      if (!src || !dst || dst.kind !== 'shot' || src.kind !== 'asset') continue;
      const role = e.label === 'ref-audio' ? 'ref-audio' : e.label === 'ref-image' ? 'ref-image' : undefined;
      if (!role) continue;
      const assetId = String((src.data as { assetId?: string })?.assetId ?? '');
      if (!assetId) continue;
      const entering = patchMap.get(e.to) ?? [];
      entering.push({ assetId, role });
      patchMap.set(e.to, entering);
    }
    if (patchMap.size === 0) return;
    setNodes((ns) =>
      ns.map((n) => {
        const entering = patchMap.get(n.id);
        if (!entering) return n;
        const refs = ((n.data?.refs as Array<{ assetId: string; role: string }> | undefined) ?? []).map((r) => ({ ...r }));
        for (const r of entering) {
          if (!refs.some((m) => m.assetId === r.assetId && m.role === r.role)) refs.push(r);
        }
        return { ...n, data: { ...n.data, refs } };
      }),
    );
  }, [edges]);

  /* ══ 「+」下游节点弹层 ══ */
  const openAddPop = useCallback(
    (nodeId: string) => {
      setApFrom(nodeId);
      setApSel(null);
      setApShowAll(false);
      setApSearch('');
      setApOpen(true);
      const n = nodesRef.current.find((x) => x.id === nodeId);
      if (n) {
        const x = Math.min(n.x + (n.w ?? 236) + 18, 1600 - 290);
        const y = Math.max(10, Math.min(n.y - 10, 1000 - 360));
        setApPos({ x, y });
      }
    },
    [],
  );

  const [apPos, setApPos] = useState({ x: 0, y: 0 });
  const closeAddPop = useCallback(() => setApOpen(false), []);

  /* 创建并连线 */
  const createFromPop = useCallback(() => {
    if (!apSel || !apFrom) return;
    const src = nodesRef.current.find((n) => n.id === apFrom);
    const t = NODE_TYPES.find((x) => x.id === apSel);
    if (!src || !t) return;
    const id = `new${++nextId.current}`;
    const meta =
      apSel === 'shot'
        ? `h3.c · ${apTier}档 · ${apAspect} ${(RES[apTier] ?? {})[apAspect] ?? ''} · 自动连线继承绑定`
        : t.sub;
    // 按 kind 初始化 data(写入 CanvasSnapshot;生成时走 RenderQueue)
    const initData = makeInitialData(t);
    setNodes((ns) => [
      ...ns,
      {
        id,
        title: t.name,
        w: 224,
        x: src.x + (src.w ?? 236) + 90,
        y: src.y + 40,
        ghost: true,
        kind: t.kind,
        tag: t,
        extra: meta,
        data: initData,
      } as CanvasNode,
    ]);
    // 按手册 §9 边 label:brief→input-brief / asset→按角色 / wf-input→slot-<name> / 其他不标
    const edgeLabel = deriveEdgeLabel(src, t);
    setEdges((es) => [...es, { from: apFrom, to: id, cls: 'ghost', label: edgeLabel }]);
    setInfoMap((m) => ({ ...m, [id]: { t: t.name, img: null, meta: [['来源', meta]] } }));
    closeAddPop();
  }, [apAspect, apFrom, apSel, apTier, closeAddPop]);

  /* 左侧面板:双击添加 + 拖拽添加
     双击:添加到当前画布视口中心附近、不与现有节点重叠;
     拖拽:鼠标松开时,以松开的屏幕坐标(经 view 变换)为节点中心放置。 */
  /** 取节点高度(渲染节点上有实测 h,否则按经验值估) */
  const nodeH = useCallback((n: CanvasNode) => n.h ?? 200, []);

  /** 找一个不与现有节点重叠的落点
   * - 默认锚点是 (cx, cy)(视口中心)
   * - 若重叠则围绕中心按螺旋向外搜索
   */
  const findFreeSpot = useCallback(
    (cx: number, cy: number, w: number, h: number): { x: number; y: number } => {
      const PAD = 28;
      const nodes = nodesRef.current;
      const overlap = (x: number, y: number) =>
        nodes.some((n) => {
          const nw = n.w ?? 224;
          const nh = nodeH(n);
          // AABB 相交(留 PAD 间隙)
          return !(
            x + w + PAD < n.x ||
            x - PAD > n.x + nw ||
            y + h + PAD < n.y ||
            y - PAD > n.y + nh
          );
        });
      let x = cx - w / 2;
      let y = cy - h / 2;
      if (!overlap(x, y)) return { x, y };
      // 螺旋扫描:右上右下左下左上依次外扩
      const step = 48;
      for (let ring = 1; ring <= 24; ring++) {
        for (let k = 0; k < ring * 8; k++) {
          const a = (k / (ring * 8)) * Math.PI * 2;
          x = cx - w / 2 + Math.round(Math.cos(a) * ring * step);
          y = cy - h / 2 + Math.round(Math.sin(a) * ring * step);
          if (!overlap(x, y)) return { x, y };
        }
      }
      // 兜底:在第一个节点右侧 24px 偏移
      const first = nodes[0];
      if (first) {
        return { x: first.x + (first.w ?? 224) + 24, y: first.y };
      }
      return { x: cx - w / 2, y: cy - h / 2 };
    },
    [nodeH],
  );

  /** 屏幕坐标 → 画布世界坐标(去掉 view 平移 + 缩放) */
  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const rect = stage.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: (clientX - rect.left - v.x) / v.z,
      y: (clientY - rect.top - v.y) / v.z,
    };
  }, []);

  /** 以视口中心为锚点双击添加 */
  const addFromPaletteDbl = useCallback(
    (typeId: string) => {
      const t = NODE_TYPES.find((x) => x.id === typeId);
      if (!t) return;
      const id = `pal${++nextId.current}`;
      const w = 224;
      const h = 200;
      // 画布视口中心 → 世界坐标
      const stage = stageRef.current;
      const cw = stage ? stage.clientWidth / 2 : 480;
      const ch = stage ? stage.clientHeight / 2 : 320;
      const v = viewRef.current;
      const cx = (cw - v.x) / v.z;
      const cy = (ch - v.y) / v.z;
      const spot = findFreeSpot(cx, cy, w, h);
      setNodes((ns) => [
        ...ns,
        {
          id,
          title: t.name,
          w,
          x: spot.x,
          y: spot.y,
          ghost: true,
          kind: t.kind,
          tag: t,
          data: makeInitialData(t),
        } as CanvasNode,
      ]);
    },
    [findFreeSpot],
  );

  /** 拖拽添加(鼠标松开时落到世界坐标,不与现有节点重叠) */
  const dropFromPalette = useCallback(
    (typeId: string, clientX: number, clientY: number) => {
      const t = NODE_TYPES.find((x) => x.id === typeId);
      if (!t) return;
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      // 检查落点是否在 stage 范围内
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return;
      const w = 224;
      const h = 200;
      const world = screenToWorld(clientX, clientY);
      const spot = findFreeSpot(world.x, world.y, w, h);
      const id = `pal${++nextId.current}`;
      setNodes((ns) => [
        ...ns,
        {
          id,
          title: t.name,
          w,
          x: spot.x,
          y: spot.y,
          ghost: true,
          kind: t.kind,
          tag: t,
          data: makeInitialData(t),
        } as CanvasNode,
      ]);
    },
    [findFreeSpot, screenToWorld],
  );

  /* ══ 右键菜单 ══ */
  const duplicateNode = useCallback(
    (id: string) => {
      const src = nodesRef.current.find((n) => n.id === id);
      if (!src) return;
      const nid = `dup${++nextId.current}`;
      setNodes((ns) => [
        ...ns,
        {
          ...src,
          id: nid,
          title: `${src.title} · 副本`,
          x: src.x + 30,
          y: src.y + 30,
          ghost: false,
          stale: false,
          agentOn: false,
          badge: undefined,
          flash: false,
        } as CanvasNode,
      ]);
      const info = NODE_INFO_BASE[id];
      if (info) {
        setInfoMap((m) => {
          const meta: Array<[string, string]> = [
            ['来源', `复制自「${info.t}」`],
            ['状态', '未运行 · 修改参数后可入队'],
            ...info.meta.slice(0, 1),
          ];
          return {
            ...m,
            [nid]: { t: `${info.t} · 副本`, img: info.img, meta },
          };
        });
      }
      selectNode(nid);
      toastMsg('已复制节点 · 副本不携带连线与运行状态');
    },
    [selectNode, toastMsg],
  );

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) => es.filter((e) => e.from !== id && e.to !== id));
      setInfoMap((m) => {
        const next = { ...m };
        delete next[id];
        return next;
      });
      setSelected((s) => (s === id ? null : s));
      toastMsg('已删除节点 · 相关连线已一并移除');
    },
    [toastMsg],
  );

  /* ── 全局点按:关闭工具行弹层(模型/技能/分支) ── */
  useEffect(() => {
    const closePops = () => setOpenPop(null);
    document.addEventListener('click', closePops);
    return () => document.removeEventListener('click', closePops);
  }, []);

  /* ══ 全局键盘 ══ */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const typing = !!active && /^(INPUT|TEXTAREA)$/.test(active.tagName);
      if (e.key === 'Escape') {
        closeAddPop();
        setOpenPop(null);
        setCtx(null);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd' && selected) {
        e.preventDefault();
        duplicateNode(selected);
        return;
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && selected && !typing) {
        e.preventDefault();
        deleteNode(selected);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeAddPop, deleteNode, duplicateNode, selected]);

  /* ══ 真实渲染:提交节点到主进程队列(槽位互斥) ══ */
  const runNode = useCallback(
    async (nodeId: string) => {
      const n = nodesRef.current.find((x) => x.id === nodeId);
      if (!n) {
        toastMsg('请先在画布上选中一个节点');
        return;
      }
      const d = (n.data ?? {}) as Record<string, unknown>;
      if (n.kind === 'timeline') {
        onNavigate('timeline');
        return;
      }
      if (n.kind === 'document') {
        toastMsg('文档节点无生成任务 · 可编辑后重新规划');
        return;
      }
      const isImage = n.kind === 'image-gen' || n.kind === 'image-edit' || n.kind === 'image-upscale';
      const slot: 'video' | 'image' = isImage ? 'image' : 'video';
      const engine = String(d.engine ?? (isImage ? 'mlxgen' : 'h3c'));

      // 参考绑定 → Provider references(首/尾帧、参考图、参考音频)
      const refs = (d.refs as Array<{ assetId: string; role: string }> | undefined) ?? [];
      const references = refs
        .map((r) => {
          const localPath = assetCache.current[r.assetId];
          if (!localPath) return null;
          return {
            asset: { id: r.assetId, kind: 'image', name: r.assetId, localPath, tags: [], createdAt: new Date().toISOString() },
            role: r.role,
            localPath,
          };
        })
        .filter(Boolean) as never[];

      const params = isImage
        ? {
            kind: 'generate',
            model: d.model,
            prompt: d.prompt,
            width: d.width,
            height: d.height,
            steps: d.steps,
            seeds: d.seeds,
          }
        : {
            kind: 'video',
            prompt: d.prompt,
            mode: d.mode,
            width: d.width,
            height: d.height,
            seconds: Number(d.seconds ?? 0) > 0 ? Number(d.seconds) : undefined,
            frames: Number(d.frames ?? 124),
            steps: Number(d.steps ?? 20),
            layers: Number(d.layers ?? 50),
            reuse: Number(d.reuse ?? 1),
            tier: d.tier,
            seed: d.seed,
          };

      setNodes((ns) => ns.map((x) => (x.id === nodeId ? { ...x, badge: '已入队 · 等待槽位…', ghost: false } : x)));
      try {
        // 先建 Take(queued),再提交任务带 takeId(主进程完成时自动写终态)
        let takeId: string | undefined;
        if (projectId && !isImage) {
          const t = await window.bigbotart.takesCreate(projectId, {
            shotNodeId: nodeId,
            status: 'queued',
            params,
          });
          takeId = t.id;
        }
        await window.bigbotart.submitRender({
          provider: engine as never,
          nodeId,
          slot,
          projectId: projectId ?? undefined,
          canvasId: activeCanvasId || undefined,
          takeId,
          params,
          references,
        });
        toastMsg(`已提交 ${engine} 任务 · ${n.title}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setNodes((ns) => ns.map((x) => (x.id === nodeId ? { ...x, badge: `提交失败 · ${msg}` } : x)));
        toastMsg(`提交失败:${msg}`);
      }
    },
    [onNavigate, toastMsg, projectId, activeCanvasId],
  );

  /* ══ 顶部动作 ══ */
  const [rerunDone, setRerunDone] = useState(false);
  const rerunAffected = () => {
    const ids = nodesRef.current.filter((n) => n.stale || n.agentOn).map((n) => n.id);
    if (ids.length === 0) {
      toastMsg('没有 stale 节点需要重跑');
      return;
    }
    ids.forEach((id) => void runNode(id));
    setRerunDone(true);
    toastMsg(`已提交 ${ids.length} 个受影响节点`);
  };

  const [agentRunText, setAgentRunText] = useState('Agent 已规划参数 · 等视频槽位 · 可提前改参');
  const runAll = () => {
    const ids = nodesRef.current.filter((n) => n.kind === 'shot' || n.kind === 'image-gen' || n.kind === 'image-edit' || n.kind === 'image-upscale').map((n) => n.id);
    if (ids.length === 0) {
      toastMsg('画布上没有可运行的生成节点');
      return;
    }
    ids.forEach((id) => void runNode(id));
    setAgentRunText(`已入队 ${ids.length} 个任务 · FIFO 依次执行`);
  };

  /* 调试面板:主进程日志总线(拉历史 + 订阅实时) */
  const [dbgOpen, setDbgOpen] = useState(false);
  const [dbgLogs, setDbgLogs] = useState<DebugLogEntry[]>([]);
  const dbgBodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!dbgOpen) return;
    let alive = true;
    void window.bigbotart.debugLogs().then((list) => {
      if (alive) setDbgLogs(list);
    }).catch(() => undefined);
    const off = window.bigbotart.onDebugLog((e) => {
      if (!alive) return;
      setDbgLogs((ls) => [...ls.slice(-499), e]);
    });
    return () => {
      alive = false;
      off();
    };
  }, [dbgOpen]);
  useEffect(() => {
    const el = dbgBodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [dbgLogs]);

  /* ══ 连线渲染 ══ */
  const edgePaths = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return edges
      .map((e) => {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (!a || !b) return null;
        const x1 = a.x + (a.w ?? 236);
        const y1 = a.y + (a.h ?? 0) / 2;
        const x2 = b.x;
        const y2 = b.y + (b.h ?? 0) / 2;
        const dx = Math.max(50, Math.abs(x2 - x1) / 2);
        return {
          key: `${e.from}-${e.to}`,
          cls: e.cls,
          d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
        };
      })
      .filter((p): p is { key: string; cls: EdgeClass; d: string } => p !== null);
  }, [edges, nodes]);

  useEffect(() => {
    // 尺寸变化后重绘连线(设计稿 drawEdges 的等价物)
    if (edgesSvgRef.current) edgesSvgRef.current.dataset.ready = '1';
  }, [edgePaths]);

  /* ══ 弹层里的可选类型(按上游输出兼容性过滤) ══ */
  const compat = apFrom ? COMPAT[apFrom] ?? NODE_TYPES.map((t) => t.id) : [];
  const q = apSearch.trim().toLowerCase();
  const visibleTypes = NODE_TYPES.filter(
    (t) => (!q || t.name.toLowerCase().includes(q)) && (compat.includes(t.id) || apShowAll),
  );
  const hiddenCount = apFrom
    ? NODE_TYPES.filter(
        (t) => !compat.includes(t.id) && (!q || t.name.toLowerCase().includes(q)) && !apShowAll,
      ).length
    : 0;
  const apFromLabel = apFrom
    ? nodes.find((n) => n.id === apFrom)?.title ?? apFrom
    : '—';
  const apTip = apSel
    ? `自动连线：${apFromLabel} → ${NODE_TYPES.find((t) => t.id === apSel)?.name ?? ''}`
    : '选中后自动连线并继承绑定';

  const zoomPct = `${Math.round(view.z * 100)}%`;

  /* 节点内部渲染(按 kind;demo 节点保留硬编码,新建节点走数据驱动) */
  const renderBody = (n: CanvasNode) => {
    // ── 演示节点硬编码(保持视觉一致性,不读 data) ──
    if (n.id === 'brief' && n.kind === 'document') {
      return (
        <div className="nb md-preview">
          <b>草原之河</b>
          <p>场景：草原 / 宽河 · 角色：女主、男主 · 风格：纸拼贴</p>
          <div className="nmeta mono">已编辑 · 下游 2 个节点 stale</div>
        </div>
      );
    }
    if (n.id === 'storyboard' && n.kind === 'image-gen') {
      return (
        <div className="nb">
          <div className="nthumb">
            <img src="./assets/sb-river.jpg" alt="分镜静帧：女主跃河纸拼贴静帧" />
          </div>
          <div className="nmeta mono">Z-Image-Turbo · 832×480 16:9 · seed 批量 ×4</div>
        </div>
      );
    }
    if (n.id === 'audio' && n.kind === 'audio-ref') {
      return (
        <div className="nb">
          <div className="wave">
            {WAVE_BARS.map((h, i) => (
              <i key={i} style={{ height: h }} />
            ))}
          </div>
          <div className="nmeta mono">草原环境声.mp3 · --ref-audio · 带声直出</div>
        </div>
      );
    }
    if (n.id === 'shot1' && n.kind === 'shot') {
      return (
        <div className="nb">
          <div className="nthumb">
            <img src="./assets/shot-01.jpg" alt="镜头 01 Take 3 画面：女主跃过河面" />
            <span className="play">
              <span>
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5.5v13l11-6.5Z" />
                </svg>
              </span>
            </span>
          </div>
          <div className="nmeta mono">h3.c · 首尾帧 · 默认档 · 16:9 1280×720 · 10s · 带声</div>
          <div className="takes">
            <span className="chip">Take 1</span>
            <span className="chip">Take 2</span>
            <span className="chip on">Take 3 ✓</span>
          </div>
        </div>
      );
    }
    if (n.id === 'shot2' && n.kind === 'shot') {
      return (
        <div className="nb">
          <div className="nthumb">
            <img
              src="./assets/shot-02.jpg"
              alt="镜头 02 重跑中画面：男主在岸边踱步"
              style={{ opacity: 0.55 }}
            />
            <span className="prog">
              <i style={{ width: '34%' }} />
            </span>
          </div>
          <div className="nmeta mono">上游 Brief 已修改 · 连续性：继承镜头 01 尾帧</div>
        </div>
      );
    }
    if (n.id === 'shot3' && n.kind === 'shot') {
      return (
        <div className="nb">
          <div
            className="nthumb"
            style={{
              border: '1.5px dashed var(--border)',
              background: 'var(--surface-warm)',
              aspectRatio: '16/9',
              display: 'grid',
              placeItems: 'center',
              color: 'var(--meta)',
              fontSize: '11px',
            }}
          >
            待生成 · 排队中
          </div>
          <div className="nmeta mono">{agentRunText}</div>
        </div>
      );
    }
    if (n.id === 'timeline' && n.kind === 'timeline') {
      return (
        <div className="nb">
          <div className="clipstrip">
            <span className="cs">
              <img src="./assets/shot-01.jpg" alt="镜1 片段" />
            </span>
            <span className="cs">
              <img src="./assets/shot-02.jpg" alt="镜2 片段" style={{ opacity: 0.55 }} />
            </span>
            <span className="cs wait"></span>
          </div>
          <div className="nmeta mono">stale · 等镜 02 / 03 完成后更新</div>
        </div>
      );
    }
    // ── 按 kind 数据驱动渲染(新建/复制/真实节点) ──
    const d = (n.data ?? {}) as Record<string, unknown>;
    switch (n.kind) {
      case 'document': {
        const md = String(d.markdown ?? '');
        return (
          <div className="nb md-preview">
            {md ? (
              <>
                <b style={{ display: 'block', marginBottom: 4 }}>{md.split('\n')[0]?.replace(/^#+\s*/, '') || '文档'}</b>
                <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>{md.slice(0, 120)}{md.length > 120 ? '…' : ''}</p>
              </>
            ) : (
              <div style={{ color: 'var(--meta)', fontSize: 11, padding: '8px 0' }}>空白文档 · 检查器里填写 Markdown</div>
            )}
          </div>
        );
      }
      case 'asset': {
        const mediaType = String(d.mediaType ?? 'image');
        const assetId = String(d.assetId ?? '');
        const emoji = mediaType === 'image' ? '🖼' : mediaType === 'video' ? '🎬' : mediaType === 'audio' ? '🎵' : '📄';
        return (
          <div className="nb">
            <div
              className="nthumb"
              style={{
                aspectRatio: '16/9',
                display: 'grid',
                placeItems: 'center',
                background: 'var(--surface-warm)',
                border: assetId ? 'none' : '1.5px dashed var(--border)',
                fontSize: 22,
              }}
            >
              {assetId ? (
                <span style={{ opacity: 0.85 }}>{emoji}</span>
              ) : (
                <span style={{ opacity: 0.5 }}>{emoji}</span>
              )}
            </div>
            <div className="nmeta mono">{assetId ? `资产 ${assetId.slice(0, 14)}… · ${mediaType}` : '未绑定资产 · 检查器里选择'}</div>
          </div>
        );
      }
      case 'image-gen': {
        const prompt = String(d.prompt ?? '');
        const model = String(d.model ?? 'mlxgen');
        const w = Number(d.width ?? 1024);
        const h = Number(d.height ?? 1024);
        const seeds = (d.seeds as number[]) ?? [];
        return (
          <div className="nb">
            <div className="nthumb" style={{ aspectRatio: '1/1', display: 'grid', placeItems: 'center', background: 'var(--surface-warm)', border: '1.5px dashed var(--border)', color: 'var(--meta)', fontSize: 11 }}>
              待生成 · {w}×{h}
            </div>
            <div className="nmeta mono">
              {prompt ? `${prompt.slice(0, 30)}${prompt.length > 30 ? '…' : ''}` : '未填提示词'} · {model.split('/').pop()}
            </div>
            {seeds.length > 1 ? <div className="nmeta mono" style={{ marginTop: 2 }}>seed 批量 ×{seeds.length}</div> : null}
          </div>
        );
      }
      case 'image-edit': {
        const mode = String(d.mode ?? 'instruction');
        const modeLabel = ({ instruction: '指令编辑', img2img: 'I2I', inpaint: 'Inpaint', outpaint: 'Outpaint' } as Record<string, string>)[mode] ?? mode;
        const prompt = String(d.prompt ?? '');
        return (
          <div className="nb">
            <div className="nthumb" style={{ aspectRatio: '16/9', display: 'grid', placeItems: 'center', background: 'var(--surface-warm)', border: '1.5px dashed var(--border)', color: 'var(--meta)', fontSize: 11 }}>
              {modeLabel} · 输入图待绑定
            </div>
            <div className="nmeta mono">{prompt ? `${prompt.slice(0, 30)}…` : '未填指令'}</div>
          </div>
        );
      }
      case 'image-upscale': {
        const scale = Number(d.scale ?? 2);
        return (
          <div className="nb">
            <div className="nthumb" style={{ aspectRatio: '16/9', display: 'grid', placeItems: 'center', background: 'var(--surface-warm)', border: '1.5px dashed var(--border)', color: 'var(--meta)', fontSize: 11 }}>
              ×{scale} 超分 · 输入待绑定
            </div>
            <div className="nmeta mono">SeedVR2 · ×{scale}</div>
          </div>
        );
      }
      case 'shot': {
        const mode = String(d.mode ?? 'text2video');
        const tier = (String(d.tier ?? 'default')) as (typeof SHOT_TIERS)[number];
        const aspect = (String(d.aspect ?? '16:9')) as (typeof SHOT_ASPECTS)[number];
        const prompt = String(d.prompt ?? '');
        const modeLabel = SHOT_MODE_LABEL[mode] ?? mode;
        // 实际尺寸:aspect + tier 推导(与 h3c-command resolveDimensions 一致),custom 用自定义
        const size = aspect === 'custom'
          ? { width: Number(d.customWidth ?? 544), height: Number(d.customHeight ?? 544) }
          : SHOT_SIZES[aspect as '16:9' | '9:16' | '1:1'][tier] ?? SHOT_SIZES['16:9'].default;
        const tierLabel = (SHOT_TIER_PRESETS[tier] ?? SHOT_TIER_PRESETS.default).label;
        // 产物(两层回退:节点 data.resultPath ← 轮询实时写;takeResults ← Take 历史回填)
        const resultPath = String(takeResults[n.id] ?? (d.resultPath as string) ?? '');
        return (
          <div className="nb">
            {resultPath ? (
              <VideoThumb src={outputUrlOf(resultPath)} badge={`✓ ${basenameOf(resultPath)}`} />
            ) : (
              <div className="nthumb" style={{ aspectRatio: '16/9', display: 'grid', placeItems: 'center', background: 'var(--surface-warm)', border: '1.5px dashed var(--border)', color: 'var(--meta)', fontSize: 11 }}>
                {modeLabel}
              </div>
            )}
            <div className="nmeta mono">h3.c · {modeLabel} · {tierLabel} · {size.width}×{size.height} · {prompt ? `${prompt.slice(0, 20)}…` : '未填提示词'}</div>
          </div>
        );
      }
      case 'director': {
        const prompt = String(d.prompt ?? '');
        return (
          <div className="nb">
            <div className="nthumb" style={{ aspectRatio: '16/9', display: 'grid', placeItems: 'center', background: 'var(--surface-warm)', border: '1.5px dashed var(--border)', color: 'var(--meta)', fontSize: 11 }}>
              运镜参考小样
            </div>
            <div className="nmeta mono">{prompt ? `${prompt.slice(0, 40)}…` : '未填导演 prompt'}</div>
          </div>
        );
      }
      case 'timeline': {
        const shots = (d.shotNodeIds as string[]) ?? [];
        return (
          <div className="nb">
            <div className="clipstrip">
              {shots.length === 0 ? (
                <span className="cs wait" style={{ flex: 1, textAlign: 'center', color: 'var(--meta)', fontSize: 11, padding: '16px 0' }}>
                  拖入镜头节点入线
                </span>
              ) : (
                shots.slice(0, 4).map((sid, i) => (
                  <span key={sid} className="cs" style={{ display: 'grid', placeItems: 'center', background: 'var(--surface-warm)', fontSize: 10 }}>
                    镜{i + 1}
                  </span>
                ))
              )}
            </div>
            <div className="nmeta mono">{shots.length} 个镜头入线 · FFmpeg 导出</div>
          </div>
        );
      }
      case 'audio-ref': {
        const assetId = String(d.assetId ?? '');
        return (
          <div className="nb">
            <div className="wave">
              {WAVE_BARS.map((h, i) => (
                <i key={i} style={{ height: h }} />
              ))}
            </div>
            <div className="nmeta mono">{assetId ? `资产 ${assetId.slice(0, 12)}… · --ref-audio` : '未绑定音频 · 检查器里选择'}</div>
          </div>
        );
      }
      case 'workflow-input': {
        const slots = (d.slots as Array<{ name: string; accept: string[]; required: boolean; value?: { kind: string } }>) ?? [];
        return (
          <div className="nb">
            <div className="nmeta mono" style={{ marginBottom: 6, color: 'var(--muted)' }}>输入槽位 ×{slots.length}</div>
            {slots.map((s, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', fontSize: 11 }}>
                <span style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                {s.accept.slice(0, 2).map((a) => (
                  <span key={a} className="badge" style={{ fontSize: 9, padding: '1px 5px' }}>{a}</span>
                ))}
                {s.required ? <span className="badge" style={{ fontSize: 9, padding: '1px 5px', background: 'color-mix(in oklab,var(--danger) 10%,transparent)', color: 'var(--danger)' }}>必填</span> : null}
                {s.value ? <span style={{ color: 'var(--success)', fontSize: 10 }}>✓</span> : <span style={{ color: 'var(--meta)', fontSize: 10 }}>—</span>}
              </div>
            ))}
          </div>
        );
      }
      case 'workflow-output': {
        const outputs = (d.outputs as Array<{ name: string; kind: string; sourceNodeIds: string[] }>) ?? [];
        return (
          <div className="nb">
            <div className="nmeta mono" style={{ marginBottom: 6, color: 'var(--muted)' }}>产物汇聚 ×{outputs.length}</div>
            {outputs.map((o, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', fontSize: 11 }}>
                <span style={{ fontWeight: 600, flex: 1 }}>{o.name}</span>
                <span className="badge" style={{ fontSize: 9, padding: '1px 5px' }}>{o.kind}</span>
                <span className="mono mut" style={{ fontSize: 9 }}>×{o.sourceNodeIds.length}</span>
              </div>
            ))}
          </div>
        );
      }
      default: {
        if (n.extra) {
          return (
            <div className="nb">
              <div
                className="nthumb"
                style={{
                  border: '1.5px dashed var(--border)',
                  background: 'var(--surface-warm)',
                  aspectRatio: '16/9',
                  display: 'grid',
                  placeItems: 'center',
                  color: 'var(--meta)',
                  fontSize: '11px',
                }}
              >
                待生成 · 排队中
              </div>
              <div className="nmeta mono">{n.extra}</div>
            </div>
          );
        }
        return (
          <div className="nb">
            <div className="nmeta mono">新节点 · 拖动画布标题栏调整位置，点「+」连接下游</div>
          </div>
        );
      }
    }
  };


  return (
    <div className={`pg-canvas${agentResizing ? ' agent-resizing' : ''}`}>
      <div className={`app${palCollapsed ? ' palette-collapsed' : ''}`} data-od-id="canvas-app">
        {/* 顶部工具条 */}
        <header className="topbar" data-od-id="canvas-toolbar">
          <button className="btn btn-g btn-sm" onClick={() => onNavigate('home')}>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
            >
              <path d="m14 6-6 6 6 6" />
            </svg>
            {projectName || '未命名项目'}
          </button>
          <CanvasSwitcher
            projectCanvases={projectCanvases}
            onSwitchCanvas={switchCanvas}
            onCreateCanvas={onCreateCanvas}
            onDeleteCanvas={onDeleteCanvas}
            onRenameCanvas={onRenameCanvas}
          />
          <span className="sep"></span>
          <button className="ibtn" title="撤销">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <path d="M8 5 3 10l5 5" />
              <path d="M3 10h11a7 7 0 0 1 0 14h-3" />
            </svg>
          </button>
          <button className="ibtn" title="重做">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <path d="m16 5 5 5-5 5" />
              <path d="M21 10H10a7 7 0 0 0 0 14h3" />
            </svg>
          </button>
          <span className="sep"></span>
          <button className="btn btn-g btn-sm">框选</button>
          <button className="btn btn-g btn-sm">连线</button>
          <span className="spacer"></span>
          <button
            className="chip"
            onClick={(e) => {
              e.stopPropagation();
              setOpenPop((p) => (p === 'branchPop' ? null : 'branchPop'));
            }}
          >
            分支：v2 实验
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          <div
            className={`pop${openPop === 'branchPop' ? ' open' : ''}`}
            style={{ top: 46, right: 210 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="pop-it">main · 主版本</div>
            <div className="pop-it">
              v2 实验 · 当前<span className="ck">✓</span>
            </div>
            <div className="pop-it dim">＋ 从当前画布新建分支…</div>
          </div>
          <button
            className="btn btn-s btn-sm"
            data-od-id="rerun-affected"
            disabled={rerunDone}
            style={rerunDone ? { opacity: 0.55 } : undefined}
            onClick={rerunAffected}
          >
            {rerunDone ? '重跑已排队 ✓' : `仅重跑受影响（${nodesRef.current.filter((n) => n.stale || n.agentOn).length}）`}
          </button>
          <button className="btn btn-s btn-sm" data-od-id="run-all" onClick={runAll}>
            运行全部
          </button>
          <button
            className="btn btn-s btn-sm"
            data-od-id="debug-toggle"
            style={dbgOpen ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
            onClick={() => setDbgOpen((v) => !v)}
          >
            {dbgOpen ? '调试面板 ▲' : '调试日志'}
          </button>
        </header>

        <div className="work">
          {/* 左:节点面板 */}
          <aside className="palette" data-od-id="canvas-palette">
            <div className="pal-head">
              <span className="lbl">节点面板 · 点击添加</span>
              <button
                className="pal-fold"
                title="收起节点面板"
                aria-label="收起节点面板"
                data-od-id="palette-collapse"
                onClick={(e) => {
                  e.stopPropagation();
                  setPalCollapsed(true);
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
                  <path d="m14 6-6 6 6 6" />
                </svg>
              </button>
            </div>
            {NODE_TYPES.map((t) => (
              <div
                className="pal-it"
                key={t.id}
                draggable
                title="双击添加到画布中心 · 或拖到画布内"
                onDoubleClick={() => addFromPaletteDbl(t.id)}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'copy';
                  e.dataTransfer.setData('application/x-bigbotart-palette', t.id);
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                  {PALETTE_ICONS[t.id]}
                </svg>
                <div>
                  <b>{t.name}</b>
                  <span>{t.sub}</span>
                </div>
                {t.p1 ? <span className="p1">P1</span> : t.wf ? <span className="p1">WF</span> : null}
              </div>
            ))}
          </aside>

          <button
            className="pal-expand"
            title="展开节点面板"
            aria-label="展开节点面板"
            data-od-id="palette-expand"
            onClick={() => setPalCollapsed(false)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
              <path d="m10 6 6 6-6 6" />
            </svg>
            节点面板
          </button>

          {/* 中:画布 */}
          <section
            className={`stage${panning ? ' panning' : ''}`}
            data-od-id="canvas-stage"
            ref={(el) => {
              stageRef.current = el;
            }}
            onPointerDown={(e) => {
              const t = e.target as HTMLElement;
              if (t !== e.currentTarget && !t.classList.contains('world') && t.tagName !== 'svg')
                return;
              beginPan(e);
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/x-bigbotart-palette')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }
            }}
            onDrop={(e) => {
              const typeId = e.dataTransfer.getData('application/x-bigbotart-palette');
              if (!typeId) return;
              e.preventDefault();
              dropFromPalette(typeId, e.clientX, e.clientY);
            }}
            onClick={() => {
              setSelected(null);
              closeAddPop();
              setCtx(null);
            }}
          >
            <div
              className="world"
              ref={worldRef}
              style={{
                transform: `translate(${view.x}px,${view.y}px) scale(${view.z})`,
              }}
              onClick={(e) => {
                if (e.target === e.currentTarget) {
                  setSelected(null);
                  closeAddPop();
                }
              }}
            >
              <svg className="edges" ref={edgesSvgRef}>
                {edgePaths.map((p) => (
                  <path key={p.key} className={p.cls} d={p.d} />
                ))}
              </svg>

              {nodes.map((n) => {
                const cls = [
                  'node',
                  n.ghost ? 'ghost' : '',
                  n.stale ? 'stale' : '',
                  n.agentOn ? 'agent-on' : '',
                  selected === n.id ? 'sel' : '',
                  flashId === n.id ? 'flash' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <div
                    key={n.id}
                    className={cls}
                    data-node={n.id}
                    ref={(el) => {
                      if (el) nodeRefs.current.set(n.id, el);
                      else nodeRefs.current.delete(n.id);
                    }}
                    style={{ left: n.x, top: n.y, width: n.w }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      selectNode(n.id);
                      e.stopPropagation();
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      closeAddPop();
                      setOpenPop(null);
                      selectNode(n.id);
                      setCtx({ x: e.clientX, y: e.clientY, id: n.id });
                    }}
                  >
                    {n.badge ? (
                      <span className="node-badge">
                        <span className="spin"></span>
                        {n.badge}
                      </span>
                    ) : null}
                    <div
                      className="nh"
                      style={n.headBg ? { background: n.headBg } : undefined}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        dragRef.current = {
                          id: n.id,
                          sx: e.clientX,
                          sy: e.clientY,
                          ox: n.x,
                          oy: n.y,
                        };
                        e.stopPropagation();
                      }}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.7}
                      >
                        {TYPE_ICON[n.kind ?? 'plain']}
                      </svg>
                      {n.title}
                      {n.st ? (
                        <span
                          className={`st dot${n.st === 'ok' ? ' ok' : ''}`}
                          style={n.st === 'warn' ? { background: 'var(--warn)' } : undefined}
                        ></span>
                      ) : null}
                    </div>
                    {renderBody(n)}
                    <span className="port"></span>
                    <button
                      className="node-add"
                      data-add={n.id}
                      aria-label="添加下游节点"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (apOpen && apFrom === n.id) closeAddPop();
                        else openAddPop(n.id);
                      }}
                    >
                      +
                    </button>
                  </div>
                );
              })}

              {/* 「+」下游节点弹层 */}
              <div
                className={`add-pop${apOpen ? ' open' : ''}`}
                data-od-id="node-add-popover"
                style={{ left: apPos.x, top: apPos.y }}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <div className="ap-h">
                  添加下游节点
                  <span
                    className="mono mut"
                    style={{ marginLeft: 'auto', fontSize: '10.5px', fontWeight: 400 }}
                  >
                    基于：{apFromLabel}
                  </span>
                </div>
                <div className="ap-s">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                  <input
                    placeholder="搜索节点类型…"
                    value={apSearch}
                    onChange={(e) => setApSearch(e.target.value)}
                  />
                </div>
                <div className="ap-list">
                  {visibleTypes.map((t) => {
                    const ok = compat.includes(t.id);
                    return (
                      <div
                        key={t.id}
                        className={`ap-row${apSel === t.id ? ' sel' : ''}${ok ? '' : ' dim'}`}
                        style={ok ? undefined : { opacity: 0.45 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setApSel(t.id);
                        }}
                      >
                        <div className="grow">
                          <b>{t.name}</b>
                          <div className="sub">
                            {t.sub}
                            {ok ? '' : ' · 输出不兼容'}
                          </div>
                        </div>
                        {t.id === 'shot' && ok ? <span className="rec">推荐</span> : null}
                        {t.p1 ? <span className="p1">P1</span> : t.wf ? <span className="p1">WF</span> : null}
                      </div>
                    );
                  })}
                  {hiddenCount > 0 ? (
                    <div
                      className="ap-more"
                      onClick={(e) => {
                        e.stopPropagation();
                        setApShowAll((v) => !v);
                      }}
                    >
                      其余 {hiddenCount} 类与当前输出不兼容 · {apShowAll ? '收起' : '展开全部'} ▾
                    </div>
                  ) : null}
                </div>
                <div className="ap-params" hidden={apSel !== 'shot'}>
                  <div className="ap-prow">
                    <span className="lbl">比例</span>
                    {['16:9', '9:16', '1:1'].map((a) => (
                      <span
                        key={a}
                        className={`chip${apAspect === a ? ' on' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setApAspect(a);
                          setApTier((t) =>
                            t !== '默认' && !((RES[t] ?? {})[a] ?? null) ? '默认' : t,
                          );
                        }}
                      >
                        {a}
                      </span>
                    ))}
                  </div>
                  <div className="ap-prow">
                    <span className="lbl">档位</span>
                    {['预览', '草稿', '默认', '参考'].map((t) => {
                      const ok = !!((RES[t] ?? {})[apAspect] ?? null);
                      return (
                        <span
                          key={t}
                          className={`chip${apTier === t && ok ? ' on' : ''}${ok ? '' : ' dis'}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!ok) return;
                            setApTier(t);
                          }}
                        >
                          {t}
                        </span>
                      );
                    })}
                  </div>
                  <div className="ap-res mono">{resHint}</div>
                </div>
                <div className="ap-f">
                  <span className="grow">{apTip}</span>
                  <button
                    className="btn btn-p btn-sm"
                    disabled={!apSel}
                    onClick={(e) => {
                      e.stopPropagation();
                      createFromPop();
                    }}
                  >
                    创建并连线
                  </button>
                </div>
              </div>
            </div>

            <div className="minimap" aria-hidden="true" ref={minimapRef}>
              <i style={{ left: 8, top: 34, width: 18, height: 12 }}></i>
              <i style={{ left: 32, top: 10, width: 20, height: 14 }}></i>
              <i style={{ left: 32, top: 48, width: 20, height: 12 }}></i>
              <i style={{ left: 62, top: 8, width: 22, height: 16 }}></i>
              <i style={{ left: 62, top: 36, width: 22, height: 16 }}></i>
              <i style={{ left: 62, top: 66, width: 22, height: 14 }}></i>
              <i style={{ left: 96, top: 28, width: 22, height: 14 }}></i>
              <span className="view" style={{ left: 24, top: 14, width: 76, height: 56 }}></span>
            </div>
            <div className="zoomctl">
              <button
                className="ibtn"
                style={{ width: 26, height: 26 }}
                onClick={(e) => {
                  e.stopPropagation();
                  setView((v) => ({ ...v, z: Math.max(0.4, v.z - 0.1) }));
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M5 12h14" />
                </svg>
              </button>
              <span
                className="zv mono mut"
                onClick={(e) => {
                  e.stopPropagation();
                  setView((v) => ({ ...v, x: 20, y: 10, z: 0.86 }));
                }}
                title="复位视图"
              >
                {zoomPct}
              </span>
              <button
                className="ibtn"
                style={{ width: 26, height: 26 }}
                onClick={(e) => {
                  e.stopPropagation();
                  setView((v) => ({ ...v, z: Math.min(1.3, v.z + 0.1) }));
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </div>
          </section>

          {/* 右:Agent 面板 */}
          <aside
            className="agent"
            data-od-id="agent-panel"
            ref={(el) => {
              agentRef.current = el;
            }}
            style={{ width: agentW }}
            onClick={() => setCtx(null)}
          >
            <div className="agent-tabs">
              <button
                className={`atab${tab === 'chat' ? ' on' : ''}`}
                data-od-id="tab-chat"
                onClick={() => setTab('chat')}
              >
                Agent 对话
              </button>
              <button
                className={`atab${tab === 'insp' ? ' on' : ''}`}
                data-od-id="tab-inspector"
                onClick={() => setTab('insp')}
              >
                检查器
              </button>
              <span className="spacer"></span>
              <span className="row g6 mono mut" style={{ fontSize: '10.5px' }}>
                <span className="dot ok"></span>pi · 运行中
              </span>
            </div>
            <div className="agent-llm mono">LLM:{model} · 项目级覆盖</div>

            {/* 对话 pane */}
            <div
              className="chat"
              ref={chatRef}
              style={{ display: tab === 'chat' ? undefined : 'none' }}
            >
              {msgs.map((m) => {
                if (m.kind === 'user') {
                  return (
                    <div className="msg-user" key={m.id}>
                      {m.text}
                    </div>
                  );
                }
                if (m.kind === 'sys') {
                  return (
                    <div className="msg-sys" key={m.id}>
                      {m.loading ? <span className="spin" style={{ marginRight: 6 }} /> : null}
                      {m.text}
                    </div>
                  );
                }
                if (m.toolCall) {
                  const tc = m.toolCall;
                  return (
                    <div className="msg-agent" key={m.id} data-od-id="agent-tools">
                      <div className="tool">
                        <div className="th">
                          <span className="mono" style={{ fontSize: '11px' }}>
                            {tc.name}
                          </span>
                          <span className="badge" style={{ marginLeft: 'auto' }}>
                            {tc.status === 'running' ? (
                              <>
                                <span className="dot" style={{ background: 'var(--warn)' }}></span>
                                运行中
                              </>
                            ) : tc.status === 'success' ? (
                              '成功'
                            ) : (
                              '失败'
                            )}
                          </span>
                          {tc.nodeId ? (
                            <span className="locate" onClick={() => locate(tc.nodeId!)}>
                              定位到节点 →
                            </span>
                          ) : null}
                        </div>
                        <div className="tb mono">
                          {tc.result ?? JSON.stringify(tc.args).slice(0, 140)}
                        </div>
                      </div>
                    </div>
                  );
                }
                return (
                  <div className="msg-agent" key={m.id} data-od-id={m.odId}>
                    {m.rich ?? (m.text ? <MarkdownText text={m.text} /> : null)}
                  </div>
                );
              })}


            </div>

            {/* 检查器 pane:按 kind 渲染专属表单 */}
            <div
              className={`insp${tab === 'insp' ? ' on' : ''}`}
              data-od-id="inspector"
            >
              <div>
                <div className="lbl" style={{ marginBottom: 8 }}>
                  {inspectTitle}
                </div>
                {selInfo && selInfo.img ? (
                  <div className="preview">
                    <img src={selInfo.img} alt="选中节点预览" />
                  </div>
                ) : null}
              </div>
              <InspectorBody
                node={selNode}
                infoMap={infoMap}
                setInfoMap={setInfoMap}
                setNodes={setNodes}
                toastMsg={toastMsg}
                projectId={projectId}
                activeCanvasId={activeCanvasId}
                jobs={jobs}
                assetsList={assetsList}
                assetCache={assetCache.current}
                runNode={(id) => void runNode(id)}
              />
              <button
                className="btn btn-s"
                style={{ width: '100%' }}
                onClick={() => {
                  if (selected) {
                    void runNode(selected);
                    toastMsg(`已提交重跑 · ${inspectTitle}`);
                  } else {
                    toastMsg('请先在画布上选中一个节点');
                  }
                }}
              >
                仅重跑该节点
              </button>
            </div>

            {/* 输入区 */}
            <div className="composer" data-od-id="agent-composer">
              <div className="attach-row">
                {attachments.map((a, i) => (
                  <span className="attach" key={a.id} title={a.localPath}>
                    <span className="thumb">
                      {a.kind === 'image' ? (
                        <img src={`bba-asset://${a.localPath.split('/').pop()}`} alt="" />
                      ) : (
                        <span className={`attach-kind attach-kind--${a.kind}`}>
                          {a.kind === 'video' ? '🎬' : a.kind === 'audio' ? '🎵' : '📄'}
                        </span>
                      )}
                    </span>
                    <span>{a.name}</span>
                    <span className="mono mut" style={{ fontSize: '10px' }}>
                      {a.kind}
                      {a.width ? ` · ${a.width}×${a.height}` : ''}
                      {a.durationSec ? ` · ${a.durationSec}s` : ''}
                    </span>
                    <button
                      className="x"
                      aria-label="移除附件"
                      onClick={() =>
                        setAttachments((list) => list.filter((x) => x.id !== a.id))
                      }
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2.4}
                      >
                        <path d="M6 6l12 12M18 6 6 18" />
                      </svg>
                    </button>
                  </span>
                ))}
              </div>
              <div className="input-box">
                {skillOn ? (
                  <span className="skill-tag" data-od-id="composer-skill-tag">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
                    </svg>
                    <span>
                      技能：<b style={{ fontWeight: 600 }}>{skill}</b>
                    </span>
                    <button
                      className="x"
                      aria-label="移除技能"
                      onClick={() => setSkill('无技能')}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2.4}
                      >
                        <path d="M6 6l12 12M18 6 6 18" />
                      </svg>
                    </button>
                  </span>
                ) : null}
                <textarea
                  rows={2}
                  ref={inputRef}
                  placeholder="追问 / 修改需求，如「镜2 改低机位仰拍」…"
                  onChange={(e) => {
                    setChatInput(e.target.value);
                    autoGrow(e.target);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
              </div>
              <div className="toolrow">
                <button
                  className="chip"
                  onClick={(e) => {
                    e.stopPropagation();
                    // dev/E2E 钩子:若 window.__bbaDevImportPaths 存在则用它,跳过 Finder(测试用)
                    const paths = (window as unknown as { __bbaDevImportPaths?: string[] }).__bbaDevImportPaths;
                    void window.bigbotart
                      .importAssets(paths?.length ? { paths } : undefined)
                      .then((res) => {
                        if (res.canceled || !res.assets?.length) return;
                        setAttachments((list) => [...list, ...res.assets]);
                        if (res.failed.length) {
                          toastMsg(`已导入 ${res.assets.length} 个;失败 ${res.failed.length}:${res.failed.map((f) => f.name).join(', ')}`);
                        }
                      });
                  }}
                >
                  ＋ 参考图 / 文件
                </button>
                <button
                  className="chip"
                  onClick={(e) => {
                    e.stopPropagation();
                    const opening = openPop !== 'modelPop';
                    setOpenPop((p) => (p === 'modelPop' ? null : 'modelPop'));
                    if (opening) void loadModelOptions();
                  }}
                >
                  模型:{model}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
                <div
                  className={`pop${openPop === 'modelPop' ? ' open' : ''}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  {modelOptions.map((m) => (
                    <div
                      className="pop-it"
                      key={m.name}
                      onClick={() => {
                        setModel(m.name);
                        setOpenPop(null);
                        if (!projectId) return;
                        void window.bigbotart
                          .setProjectLlm(projectId, m.reset ? null : (m.source ?? null))
                          .then(() => toastMsg(m.reset ? '已回退全局 LLM 默认' : `项目级 LLM 已切换 · ${m.name}`))
                          .catch((e) => console.error('设置项目 LLM 失败', e));
                      }}
                    >
                      {m.sub}
                      {model === m.name ? <span className="ck">✓</span> : null}
                    </div>
                  ))}
                  <div
                    className="pop-it dim"
                    style={{
                      borderTop: '1px solid var(--border-soft)',
                      marginTop: 4,
                      paddingTop: 9,
                    }}
                  >
                    项目级覆盖 · 规划时优先使用该 LLM
                  </div>
                </div>
                <button
                  className="chip"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenPop((p) => (p === 'skillPop' ? null : 'skillPop'));
                  }}
                >
                  ＋ 技能
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
                <div
                  className={`pop${openPop === 'skillPop' ? ' open' : ''}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div
                    className="pop-it"
                    onClick={() => {
                      setSkill('无技能');
                      setOpenPop(null);
                    }}
                  >
                    无技能 · 自由编排
                    {skill === '无技能' ? <span className="ck">✓</span> : null}
                  </div>
                  {SKILLS.map((s) => (
                    <div
                      className="pop-it"
                      key={s}
                      onClick={() => {
                        setSkill(s);
                        setOpenPop(null);
                      }}
                    >
                      {s}
                      {skill === s ? <span className="ck">✓</span> : null}
                    </div>
                  ))}
                </div>
              </div>
              <div className="composer-actions">
                <button className="btn btn-g btn-sm" onClick={interrupt}>
                  打断并改画布
                </button>
                <button className="btn btn-p btn-sm" onClick={() => send()}>
                  发送
                </button>
              </div>
            </div>
          </aside>

          {/* Agent 面板宽度拖拽把手 */}
          <button
            className="agent-grip"
            aria-label="拖拽调整 Agent 面板宽度"
            title="拖拽调整面板宽度 · 双击复位"
            data-od-id="agent-resize-handle"
            ref={gripRef}
            style={{ right: 12 + agentW - 6 }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              agentDragRef.current = { sx: e.clientX, w: agentW };
              gripRef.current?.classList.add('on');
              setAgentResizing(true);
              e.preventDefault();
              e.stopPropagation();
            }}
            onDoubleClick={() => {
              setAgentWidth(344, true);
              toastMsg('面板宽度已重置为默认');
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') {
                e.preventDefault();
                setAgentWidth(agentW + 16, true);
              } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                setAgentWidth(agentW - 16, true);
              }
            }}
          ></button>
        </div>

        {/* 底部队列条(真实队列状态) */}
        <footer className="queue" data-od-id="canvas-queue">
          <span className="lbl">队列</span>
          {queueItem('video', jobs, nodes)}
          {queueItem('image', jobs, nodes)}
          <span className="spacer"></span>
          <span className="mono mut" style={{ fontSize: '11px' }}>
            {jobs.filter((j) => j.status === 'queued').length > 0
              ? `${jobs.filter((j) => j.status === 'queued').length} 个排队 · FIFO 串行执行`
              : 'FIFO · 预览档可插队（需确认）'}
          </span>
        </footer>
      </div>

      {/* 节点右键菜单 */}
      <div
        className={`pop ctx${ctx ? ' open' : ''}`}
        role="menu"
        data-od-id="node-context-menu"
        style={
          ctx
            ? {
                left: Math.max(8, Math.min(ctx.x, window.innerWidth - 212 - 8)),
                top: Math.max(8, Math.min(ctx.y, window.innerHeight - 210 - 8)),
              }
            : undefined
        }
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <button className="pop-it" data-od-id="ctx-duplicate" onClick={onCtxDuplicate(ctx, duplicateNode)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
            <rect x="9" y="9" width="12" height="12" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          复制<span className="sc">⌘D</span>
        </button>
        <button
          className={`pop-it${isCtxGhost(ctx, nodes) ? ' dim' : ''}`}
          data-od-id="ctx-save-as"
          onClick={() => {
            if (!ctx || isCtxGhost(ctx, nodes)) return;
            const info = NODE_INFO_BASE[ctx.id];
            setCtx(null);
            if (info?.img) {
              const name = info.img.split('/').pop() ?? 'output.png';
              const a = document.createElement('a');
              a.href = info.img;
              a.download = name;
              document.body.appendChild(a);
              a.click();
              a.remove();
              toastMsg(`已导出「${name}」· 演示使用本地素材`);
            } else {
              toastMsg('该节点暂无可导出的产物文件（演示）');
            }
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
            <path d="M12 3v11m0 0 4.2-4.2M12 14l-4.2-4.2" />
            <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
          </svg>
          另存为…
        </button>
        <button
          className={`pop-it${isCtxGhost(ctx, nodes) ? ' dim' : ''}`}
          data-od-id="ctx-reveal-finder"
          onClick={() => {
            if (!ctx || isCtxGhost(ctx, nodes)) return;
            const id = ctx.id;
            setCtx(null);
            toastMsg(
              `已在 Finder 中显示 · ~/BigBotArt/草原之河/${FINDER_PATH[id] ?? 'takes/'}（演示）`,
            );
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          </svg>
          在 Finder 中显示
        </button>
        <div className="ctx-sep"></div>
        <button
          className="pop-it danger"
          data-od-id="ctx-delete"
          onClick={() => {
            if (!ctx) return;
            const id = ctx.id;
            setCtx(null);
            deleteNode(id);
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
            <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0-1 13a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 7" />
          </svg>
          删除<span className="sc">⌫</span>
        </button>
      </div>

      <div className={`toast${toast ? ' show' : ''}`} role="status" aria-live="polite">
        {toast?.msg ?? ''}
      </div>
      {/* projectId 目前仅用于数据落盘,画布演示数据固定 */}
      <span hidden data-project={projectId ?? ''}></span>

      {/* ── 调试面板(右下):主进程日志总线 ── */}
      {dbgOpen ? (
        <div className="dbg-panel" data-od-id="debug-panel">
          <div className="dbg-head">
            <span className="lbl">调试日志 · 实时(主进程)</span>
            <div className="dbg-acts">
              <button
                className="btn btn-s btn-xs"
                onClick={() => void window.bigbotart.debugClear().catch(() => undefined)}
              >
                清空
              </button>
              <button className="btn btn-s btn-xs" onClick={() => setDbgOpen(false)}>
                ✕
              </button>
            </div>
          </div>
          <div className="dbg-body mono" ref={dbgBodyRef}>
            {dbgLogs.length === 0 ? (
              <div className="mut">暂无日志 · 点「立即生成」后这里会实时显示队列 / h3 进度</div>
            ) : (
              dbgLogs.map((e, i) => (
                <div key={i} className={`dbg-line lv-${e.level}`}>
                  <span className="dbg-ts">{e.ts.slice(11, 23)}</span>
                  <span className="dbg-lv">{e.level}</span>
                  <span className="dbg-msg">{e.msg}</span>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 「复制」菜单项的处理(无选中节点时空操作) */
function onCtxDuplicate(
  ctx: { x: number; y: number; id: string } | null,
  fn: (id: string) => void,
) {
  return () => {
    if (!ctx) return;
    fn(ctx.id);
  };
}

/** 幽灵节点(尚无产物)在菜单里禁用导出类动作 */
function isCtxGhost(
  ctx: { x: number; y: number; id: string } | null,
  nodes: CanvasNode[],
): boolean {
  if (!ctx) return false;
  const n = nodes.find((x) => x.id === ctx.id);
  return !!n?.ghost;
}

/** 默认的「执行计划」消息(无来自首页的规划 JSON 时) */
const PLAN_MSG = (
  <>
    <b>执行计划（已落到画布）</b>{' '}
    <span className="badge" style={{ marginLeft: 4 }}>
      技能：纸拼贴剧情片
    </span>
    <div className="mut" style={{ marginTop: 4, fontSize: '11px' }}>
      60s 超出 h3.c 单次 ≤15s，已拆 5 镜头；2 个角色注入身份锁定。
    </div>
    <div style={{ marginTop: 6 }}>
      <div className="step">
        <span className="sm sm-done">✓</span>
        <div>
          <b>创建 Brief 文档节点</b>
          <div className="mut" style={{ fontSize: '11px' }}>
            → 画布（30, 110）
          </div>
        </div>
      </div>
      <div className="step">
        <span className="sm sm-done">✓</span>
        <div>
          <b>分镜规划：5 镜头</b>
          <div className="mut" style={{ fontSize: '11px' }}>
            镜1 走近河边 8s · 镜2 女主跃河 10s…
          </div>
        </div>
      </div>
      <div className="step">
        <span className="sm sm-done">✓</span>
        <div>
          <b>生成分镜静帧 ×5</b>
          <div className="mut" style={{ fontSize: '11px' }}>
            Z-Image-Turbo · 纸拼贴
          </div>
        </div>
      </div>
      <div className="step">
        <span className="sm sm-run">
          <span className="spin"></span>
        </span>
        <div>
          <b>生成镜头视频（进行中）</b>
          <div className="mut" style={{ fontSize: '11px' }}>
            镜1 ✓ · 镜2 重跑中 · 镜3 排队
          </div>
          <div className="pbar" style={{ marginTop: 5, width: 170 }}>
            <i style={{ width: '34%' }}></i>
          </div>
        </div>
      </div>
      <div className="step">
        <span className="sm sm-wait">5</span>
        <div className="mut">
          <b>组织进时间线</b>
          <div style={{ fontSize: '11px' }}>Selected Take 入线 · 保留音轨</div>
        </div>
      </div>
    </div>
  </>
);
