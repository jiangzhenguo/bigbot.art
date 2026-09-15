import React, { useEffect, useMemo, useState } from 'react';
import type { Asset } from '@bigbotart/shared';

export type AssetsPageTarget =
  | 'home'
  | 'canvas'
  | 'assets'
  | 'skills'
  | 'timeline'
  | 'settings'
  | 'onboarding'
  | 'projects';

interface AssetsPageProps {
  onNavigate: (page: AssetsPageTarget) => void;
}

/* ------------------------------------------------------------------ *
 * 设计稿 assets.js 中的演示数据（ASSETS 表）
 * 图片按渲染进程约定使用相对 ./assets/ 路径
 * ------------------------------------------------------------------ */

interface AssetDef {
  name: string;
  img: string | null;
  play?: boolean;
  gray?: boolean;
  wave?: boolean;
  doc?: boolean;
  meta: Array<[string, string]>;
  refs: Array<[string, string]>;
  params: string;
}

const ASSETS: Record<string, AssetDef> = {
  'char-f': {
    name: '角色 · 女主 v3',
    img: './assets/char-female.jpg',
    meta: [
      ['类型', '角色设定 · 参考图'],
      ['尺寸', '1023×665 · JPEG'],
      ['注入', 'Ref2VA 提示词 · 身份锁定'],
      ['来源', '导入 · 3 天前'],
    ],
    refs: [
      ['镜头 01 · 首帧参考', '画布'],
      ['镜头 02 · Ref2VA 锁定', '画布'],
      ['镜头 03 · Ref2VA 锁定', '画布'],
    ],
    params:
      'ref2va_weight: 0.82\nprompt_anchor: "女主, rust jacket, short hair"\nnegative: "extra fingers, deformed hands"',
  },
  'char-m': {
    name: '角色 · 男主 v1',
    img: './assets/char-male.jpg',
    meta: [
      ['类型', '角色设定 · 参考图'],
      ['尺寸', '1023×681 · JPEG'],
      ['注入', 'Ref2VA 提示词 · 身份锁定'],
      ['来源', '导入 · 3 天前'],
    ],
    refs: [
      ['镜头 02 · Ref2VA 锁定', '画布'],
      ['镜头 04 · Ref2VA 锁定', '画布'],
    ],
    params: 'ref2va_weight: 0.78\nprompt_anchor: "男主, teal coat"\nnegative: "extra fingers"',
  },
  'env-v': {
    name: '环境 · 河谷日景 v1',
    img: './assets/env-valley.jpg',
    meta: [
      ['类型', '环境 · 场景/风格参考'],
      ['尺寸', '1024×733 · JPEG'],
      ['用法', '提示词「风格统一」注入'],
    ],
    refs: [
      ['镜头 01 · 风格参考', '画布'],
      ['镜头 03 · 风格参考', '画布'],
    ],
    params: 'style_phrase: "wide river valley, midday, paper-collage palette"',
  },
  'env-d': {
    name: '环境 · 黄昏空镜 v2',
    img: './assets/env-dusk.jpg',
    meta: [
      ['类型', '环境 · 场景参考'],
      ['尺寸', '1024×683 · JPEG'],
      ['用法', '首帧候选 · 空镜'],
    ],
    refs: [['镜头 05 · 首帧候选', '画布']],
    params: 'style_phrase: "grassland dusk, amber sky, empty shot"',
  },
  'prop-b': {
    name: '物品 · 保温杯 v1',
    img: './assets/prop-bottle.jpg',
    meta: [
      ['类型', '物品 · 产品参考'],
      ['尺寸', '1023×682 · JPEG'],
      ['用法', '首帧 / 图片编辑参考'],
    ],
    refs: [['电商项目 · 镜头 02', '画布']],
    params: 'product_anchor: "matte insulated bottle, side view"\nmaterial: stainless steel, sage',
  },
  'prop-logo': {
    name: '物品 · 品牌 Logo',
    img: null,
    meta: [
      ['类型', '品牌资产 · SVG'],
      ['尺寸', '矢量 · 52×52 显示'],
      ['用法', '片头复用 · 可存为 Skill'],
    ],
    refs: [['电商项目 · 片头', '时间线']],
    params: 'brand_mark: droplet\nusage: intro sting, watermark corner',
  },
  take3: {
    name: '镜1_Take3.mp4',
    img: './assets/shot-01.jpg',
    play: true,
    meta: [
      ['规格', '1920×1080 · 10.0s · MP4'],
      ['编码', 'H.264 + AAC · 音轨内嵌'],
      ['引擎', 'h3.c 0.4.2 · seed 88213 · 默认档'],
      ['大小', '86 MB'],
    ],
    refs: [
      ['镜头 01 · Selected Take', '画布'],
      ['时间线 · 片段 1', '时间线'],
      ['尾帧 → 镜2 参考候选', '连续性'],
    ],
    params: 'steps: 30 · layers: 28 · tier: default\nmode: FL2VA · ref: sb-river 首帧\nprompt: 五段式 · 纸拼贴 · 跃河',
  },
  take2: {
    name: '镜1_Take2.mp4',
    img: './assets/shot-01.jpg',
    gray: true,
    meta: [
      ['状态', '失败 · OOM（显存峰值）'],
      ['引擎', 'h3.c 0.4.2 · seed 88190'],
      ['诊断', '已存 · 建议降档或减 layers'],
    ],
    refs: [['—', '未被引用']],
    params: 'steps: 30 · layers: 32 · tier: default\nerror: metal_oom at layer 29',
  },
  s2t1: {
    name: '镜2_Take1.mp4',
    img: './assets/shot-02.jpg',
    play: true,
    meta: [
      ['规格', '1280×720 · 8.0s · MP4'],
      ['引擎', 'h3.c 0.4.2 · 草稿档'],
      ['状态', '校验 Agent 复核中'],
    ],
    refs: [['镜头 02 · 候选 Take', '画布']],
    params: 'steps: 20 · layers: 24 · tier: draft\nmode: FL2VA · ref: 镜1 尾帧',
  },
  sb1: {
    name: '分镜静帧_v2_s88213',
    img: './assets/sb-river.jpg',
    meta: [
      ['类型', '图片 · 分镜静帧'],
      ['尺寸', '832×480 · 16:9'],
      ['引擎', 'mlxgen · Z-Image-Turbo'],
      ['seed', '88213'],
    ],
    refs: [['镜头 01 · 首帧', '画布']],
    params: 'model: z-image-turbo\nsize: 832x480 · steps: 8\nprompt: 纸拼贴 · 女主跃河',
  },
  sb2: {
    name: '分镜静帧_v2_s88214',
    img: './assets/env-valley.jpg',
    meta: [
      ['类型', '图片 · 分镜静帧'],
      ['尺寸', '832×480 · 16:9'],
      ['引擎', 'mlxgen · Z-Image-Turbo'],
      ['seed', '88214'],
    ],
    refs: [['镜头 03 · 首帧候选', '画布']],
    params: 'model: z-image-turbo\nsize: 832x480 · steps: 8\nprompt: 纸拼贴 · 河谷空镜',
  },
  audio1: {
    name: '草原环境声.mp3',
    img: null,
    wave: true,
    meta: [
      ['类型', '音频 · 导入'],
      ['时长', '02:41 · 44.1kHz'],
      ['用法', '--ref-audio · 带声直出'],
    ],
    refs: [['镜头 02 · 音轨参考', '画布']],
    params: 'loudness: -23 LUFS → 统一至 -14\nchannels: stereo',
  },
  briefdoc: {
    name: '草原之河_Brief.md',
    img: null,
    doc: true,
    meta: [
      ['类型', '文档 · Markdown'],
      ['同步', '画布镜像 · 实时'],
      ['结构', '场景 / 角色 / 风格'],
    ],
    refs: [['Brief 文档节点', '画布']],
    params: '# 草原之河\n场景: 草原 / 宽河\n角色: 女主, 男主\n风格: 纸拼贴',
  },
  dircam: {
    name: '运镜小样_低机位.mp4',
    img: './assets/env-dusk.jpg',
    play: true,
    meta: [
      ['类型', '视频 · 运镜参考'],
      ['规格', '1280×720 · 8.0s'],
      ['引擎', 'h3.c · 预览档'],
    ],
    refs: [['导演台节点 · 运镜参考', '画布']],
    params: 'camera: low angle dolly\ntier: preview',
  },
};

/** 资产卡的搜索词：等价于设计稿里的 card.textContent */
interface AssetCardDef {
  assetId: string;
  /** 卡片标题（<b>） */
  title: string;
  /** 卡片副标题（.mono） */
  sub: string;
  cat: 'role' | 'env' | 'prop' | 'media';
  mtype?: 'image' | 'video' | 'audio' | 'doc';
  badge?: { text: string; cls: string };
  img?: string;
  imgStyle?: React.CSSProperties;
  /** 非图片缩略图（品牌 Logo / 文档图标 / 音频波形 / 视频占位） */
  thumbKind?: 'brand' | 'doc' | 'wave' | 'play';
  newCard?: { label: string };
}

const ROLE_CARDS: AssetCardDef[] = [
  {
    assetId: 'char-f',
    title: '角色 · 女主 v3',
    sub: '身份锁定 · 3 镜头引用',
    cat: 'role',
    badge: { text: 'Ref2VA', cls: 'tag' },
    img: './assets/char-female.jpg',
  },
  {
    assetId: 'char-m',
    title: '角色 · 男主 v1',
    sub: '身份锁定 · 2 镜头引用',
    cat: 'role',
    badge: { text: 'Ref2VA', cls: 'tag' },
    img: './assets/char-male.jpg',
  },
  { assetId: '', title: '', sub: '', cat: 'role', newCard: { label: '新建角色 · 参考图 + 提示词注入' } },
];

const ENV_CARDS: AssetCardDef[] = [
  {
    assetId: 'env-v',
    title: '环境 · 河谷日景 v1',
    sub: '风格参考注入 · 2 镜头引用',
    cat: 'env',
    img: './assets/env-valley.jpg',
  },
  {
    assetId: 'env-d',
    title: '环境 · 黄昏空镜 v2',
    sub: '首帧候选 · 1 镜头引用',
    cat: 'env',
    img: './assets/env-dusk.jpg',
  },
  { assetId: '', title: '', sub: '', cat: 'env', newCard: { label: '新建环境 · 场景参考 + 风格措辞' } },
];

const PROP_CARDS: AssetCardDef[] = [
  {
    assetId: 'prop-b',
    title: '物品 · 保温杯 v1',
    sub: '首帧 / 编辑参考 · 1 镜头引用',
    cat: 'prop',
    img: './assets/prop-bottle.jpg',
  },
  {
    assetId: 'prop-logo',
    title: '物品 · 品牌 Logo',
    sub: '品牌资产 · 片头复用',
    cat: 'prop',
    thumbKind: 'brand',
  },
  { assetId: '', title: '', sub: '', cat: 'prop', newCard: { label: '新建物品 · 产品图 + 材质 / 角度' } },
];

const MEDIA_CARDS: AssetCardDef[] = [
  {
    assetId: 'take3',
    title: '镜1_Take3.mp4',
    sub: 'h3.c · 默认档 · 带声 ✓',
    cat: 'media',
    mtype: 'video',
    badge: { text: '视频 · 10s', cls: 'tag' },
    img: './assets/shot-01.jpg',
  },
  {
    assetId: 'take2',
    title: '镜1_Take2.mp4',
    sub: '诊断已存 · 可重试',
    cat: 'media',
    mtype: 'video',
    badge: { text: '失败 · OOM', cls: 'err tag' },
    img: './assets/shot-01.jpg',
    imgStyle: { filter: 'grayscale(1)', opacity: 0.6 },
  },
  {
    assetId: 's2t1',
    title: '镜2_Take1.mp4',
    sub: 'h3.c · 草稿档 · 8s',
    cat: 'media',
    mtype: 'video',
    badge: { text: '校验中', cls: 'warn tag' },
    img: './assets/shot-02.jpg',
  },
  {
    assetId: 'sb1',
    title: '分镜静帧_v2_s88213',
    sub: 'Z-Image-Turbo · 832×480',
    cat: 'media',
    mtype: 'image',
    img: './assets/sb-river.jpg',
  },
  {
    assetId: 'sb2',
    title: '分镜静帧_v2_s88214',
    sub: 'Z-Image-Turbo · 832×480',
    cat: 'media',
    mtype: 'image',
    img: './assets/env-valley.jpg',
  },
  {
    assetId: 'audio1',
    title: '草原环境声.mp3',
    sub: '导入 · 02:41 · 作 --ref-audio',
    cat: 'media',
    mtype: 'audio',
    thumbKind: 'wave',
  },
  {
    assetId: 'briefdoc',
    title: '草原之河_Brief.md',
    sub: '画布镜像 · 同步中',
    cat: 'media',
    mtype: 'doc',
    thumbKind: 'doc',
  },
  {
    assetId: 'dircam',
    title: '运镜小样_低机位.mp4',
    sub: '导演台 · h3 预览档',
    cat: 'media',
    mtype: 'video',
    badge: { text: '视频 · 8s', cls: 'tag' },
    img: './assets/env-dusk.jpg',
  },
];

const SECTIONS: Array<{
  id: 'role' | 'env' | 'prop' | 'media';
  title: string;
  mut: string;
  cards: AssetCardDef[];
}> = [
  { id: 'role', title: '角色', mut: '身份锁定 · Ref2VA 提示词注入', cards: ROLE_CARDS },
  { id: 'env', title: '环境', mut: '场景 / 风格参考 · 首帧候选', cards: ENV_CARDS },
  { id: 'prop', title: '物品', mut: '道具 / 产品参考 · 品牌资产', cards: PROP_CARDS },
  { id: 'media', title: '最近生成与导入', mut: 'Take 自动归档 · 命名带 seed', cards: MEDIA_CARDS },
];

const CATEGORY_CHIPS: Array<{ cat: string; label: string }> = [
  { cat: 'all', label: '全部 128' },
  { cat: 'role', label: '角色 4' },
  { cat: 'env', label: '环境 6' },
  { cat: 'prop', label: '物品 11' },
];

const MTYPE_CHIPS: Array<{ mtype: 'image' | 'video' | 'audio' | 'doc'; label: string }> = [
  { mtype: 'image', label: '图片 64' },
  { mtype: 'video', label: '视频 41' },
  { mtype: 'audio', label: '音频 9' },
  { mtype: 'doc', label: '文档 14' },
];

const WAVE_BARS = [14, 26, 36, 20, 30, 16, 34, 22, 12, 28, 18, 32, 14, 24];

/** 卡片全文，用于搜索命中（对齐设计稿的 card.textContent 匹配） */
function cardText(c: AssetCardDef): string {
  if (c.newCard) return c.newCard.label;
  return `${c.title} ${c.sub} ${c.badge?.text ?? ''}`;
}

/** 真实资产 → 「最近生成与导入」分区的卡片（替代 MEDIA_CARDS 演示数据） */
function assetToCard(a: Asset): AssetCardDef {
  const mtype: NonNullable<AssetCardDef['mtype']> = a.kind === 'document' ? 'doc' : a.kind;
  const dims: string[] = [];
  if (a.width && a.height) dims.push(`${a.width}×${a.height}`);
  if (a.durationSec != null) dims.push(`${a.durationSec}s`);
  const dimsText = dims.join(' · ');
  const ext = (a.mime ?? '').split('/')[1]?.toUpperCase() ?? '';
  const sub = [dimsText, ext].filter(Boolean).join(' · ') || mtype;
  const base: AssetCardDef = {
    assetId: a.id,
    title: a.name,
    sub,
    cat: 'media',
    mtype,
  };
  switch (a.kind) {
    case 'image':
      return {
        ...base,
        img: `bba-asset://${a.localPath.split('/').pop()}`,
        badge: dimsText ? { text: `图片 · ${dimsText}`, cls: 'tag' } : undefined,
      };
    case 'video':
      return {
        ...base,
        thumbKind: 'play',
        badge: a.durationSec != null ? { text: `视频 · ${a.durationSec}s`, cls: 'tag' } : undefined,
      };
    case 'audio':
      return {
        ...base,
        thumbKind: 'wave',
        badge: a.durationSec != null ? { text: `音频 · ${a.durationSec}s`, cls: 'tag' } : undefined,
      };
    default:
      return { ...base, thumbKind: 'doc' };
  }
}

export default function AssetsPage({ onNavigate }: AssetsPageProps) {
  /* 选中资产 + 删除联动状态（对应 assets.js 的 sel / delNote） */
  const [selectedAsset, setSelectedAsset] = useState<string>('char-f');
  const [deletedAsset, setDeletedAsset] = useState<string | null>(null);
  const [delNoteOpen, setDelNoteOpen] = useState<boolean>(false);

  /* 真实资产库（listAssets 载入,导入后刷新） */
  const [assets, setAssets] = useState<Asset[]>([]);
  /* 导入/删除失败的提示文案（null = 不显示） */
  const [importNote, setImportNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    window.bigbotart
      .listAssets()
      .then((list) => {
        if (live) setAssets(list);
      })
      .catch((e) => {
        if (live) setImportNote(`资产列表加载失败:${(e as Error).message}`);
      });
    return () => {
      live = false;
    };
  }, []);

  /* 筛选状态：分类 + 媒体类型 + 搜索（对应 assets.js 的 cat / mtype / q） */
  const [cat, setCat] = useState<string>('all');
  const [mtype, setMtype] = useState<string | null>(null);
  const [q, setQ] = useState<string>('');

  const detail: AssetDef = ASSETS[selectedAsset] ?? ASSETS['char-f']!;

  const visibleSections = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return SECTIONS.map((s) => {
      const showSect = (cat === 'all' || cat === s.id) && (s.id === 'media' || !mtype);
      /* 「最近生成与导入」分区由真实资产驱动（替代 MEDIA_CARDS 演示数据） */
      const src = s.id === 'media' ? assets.map(assetToCard) : s.cards;
      const cards = showSect
        ? src.filter((c) => {
            if (mtype && c.mtype !== mtype) return false;
            if (needle && !cardText(c).toLowerCase().includes(needle)) return false;
            return true;
          })
        : [];
      return { ...s, showSect, cards };
    });
  }, [cat, mtype, q, assets]);

  const selectCategory = (next: string) => {
    setCat(next);
    setMtype(null);
  };

  const toggleMtype = (next: 'image' | 'video' | 'audio' | 'doc') => {
    setMtype((prev) => (prev !== next ? next : null));
  };

  const handleImport = async () => {
    try {
      const res = await window.bigbotart.importAssets();
      /* 用户取消（assets 与 failed 均为空）:静默返回 */
      if (res.assets.length === 0 && res.failed.length === 0) return;
      /* 导入成功后刷新列表,新导入的资产卡随之显示 */
      if (res.assets.length > 0) {
        const list = await window.bigbotart.listAssets();
        setAssets(list);
      }
      if (res.failed.length > 0) {
        const bad = res.failed.map((f) => `${f.name}:${f.error}`).join('、');
        setImportNote(`导入完成:成功 ${res.assets.length} 项,失败 ${res.failed.length} 项 — ${bad}`);
      } else {
        setImportNote(null);
      }
    } catch (e) {
      setImportNote(`导入失败:${(e as Error).message}`);
    }
  };

  const handleDeleteConfirm = async () => {
    const id = selectedAsset;
    setDelNoteOpen(false);
    /* 演示资产（角色/环境/物品）不调 IPC,保留原有置灰联动 */
    if (!assets.some((a) => a.id === id)) {
      setDeletedAsset(id);
      return;
    }
    try {
      const res = await window.bigbotart.deleteAsset(id);
      if (res.ok) {
        setAssets((prev) => prev.filter((a) => a.id !== id));
        setDeletedAsset(id);
        setImportNote(null);
      } else {
        setImportNote(`删除失败:${res.error ?? '未知错误'}`);
      }
    } catch (e) {
      setImportNote(`删除失败:${(e as Error).message}`);
    }
  };

  return (
    <div className="pg-assets">
      <div className="app" data-od-id="assets-app">
        {/* 工具条 */}
        <header className="topbar" data-od-id="assets-toolbar">
          <button className="btn btn-g btn-sm" onClick={() => onNavigate('home')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="m14 6-6 6 6 6" />
            </svg>
            资产中心
          </button>
          <span className="sep" />
          <button className="btn btn-p btn-sm" id="importBtn" data-od-id="assets-import" onClick={handleImport}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M12 5v14M5 12h14" />
            </svg>
            导入资产
          </button>
          <span className="sep" />
          {CATEGORY_CHIPS.map((c) => (
            <button
              key={c.cat}
              className={`chip${cat === c.cat ? ' on' : ''}`}
              data-cat={c.cat}
              onClick={() => selectCategory(c.cat)}
            >
              {c.label}
            </button>
          ))}
          <span className="sep" />
          {MTYPE_CHIPS.map((c) => (
            <button
              key={c.mtype}
              className={`chip${mtype === c.mtype ? ' on' : ''}`}
              data-mtype={c.mtype}
              onClick={() => toggleMtype(c.mtype)}
            >
              {c.label}
            </button>
          ))}
          <span className="spacer" />
          <div className="search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              id="searchInput"
              placeholder="搜索资产 / seed / 提示词…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </header>

        <div className="work">
          {/* 资产网格 */}
          <main className="grid-area" data-od-id="assets-grid">
            {importNote && (
              <div className="del-note" id="importNote" role="status" style={{ marginBottom: 12 }}>
                {importNote}
              </div>
            )}
            {visibleSections.map((s) => (
              <React.Fragment key={s.id}>
                {s.showSect && (
                  <>
                    <div className="sect-h" data-cat-sect={s.id}>
                      <b>{s.title}</b>
                      <span className="mut">{s.mut}</span>
                    </div>
                    <div className="agrid" data-cat-grid={s.id}>
                      {s.cards.map((c, i) => {
                        if (c.newCard) {
                          return (
                            <div className="acard new" data-cat={c.cat} key={`${s.id}-new-${i}`}>
                              <svg
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                              >
                                <path d="M12 5v14M5 12h14" />
                              </svg>
                              <span style={{ fontSize: 'var(--text-xs)' }}>{c.newCard.label}</span>
                            </div>
                          );
                        }
                        const sel = selectedAsset === c.assetId;
                        const gone = deletedAsset === c.assetId;
                        return (
                          <div
                            className={`acard${sel ? ' sel' : ''}`}
                            data-asset={c.assetId}
                            data-cat={c.cat}
                            data-type={c.mtype}
                            key={c.assetId}
                            style={gone ? { opacity: 0.35, pointerEvents: 'none' } : undefined}
                            onClick={() => {
                              if (gone) return;
                              setSelectedAsset(c.assetId);
                              setDelNoteOpen(false);
                            }}
                          >
                            {c.thumbKind === 'brand' ? (
                              <div
                                className="athumb"
                                style={{ display: 'grid', placeItems: 'center', background: 'var(--surface)' }}
                              >
                                <svg width="52" height="52" viewBox="0 0 52 52">
                                  <rect width="52" height="52" rx="12" style={{ fill: 'var(--fg)' }} />
                                  <path
                                    d="M26 12c5 6 9 9.6 9 14a9 9 0 1 1-18 0c0-4.4 4-8 9-14Z"
                                    style={{ fill: 'var(--bg)' }}
                                  />
                                </svg>
                              </div>
                            ) : c.thumbKind === 'doc' ? (
                              <div
                                className="athumb"
                                style={{ display: 'grid', placeItems: 'center', background: 'var(--surface)' }}
                              >
                                <svg
                                  width="34"
                                  height="34"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  style={{ stroke: 'var(--muted)' }}
                                  strokeWidth="1.5"
                                >
                                  <path d="M6 2h9l5 5v15H6Z" />
                                  <path d="M14 2v6h6M9 13h8M9 17h5" />
                                </svg>
                              </div>
                            ) : c.thumbKind === 'wave' ? (
                              <div className="athumb wavebox">
                                {WAVE_BARS.map((h, wi) => (
                                  <i key={wi} style={{ height: `${h}px` }} />
                                ))}
                              </div>
                            ) : c.thumbKind === 'play' ? (
                              <div
                                className="athumb"
                                style={{ display: 'grid', placeItems: 'center', background: 'var(--surface)' }}
                              >
                                <svg
                                  width="34"
                                  height="34"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  style={{ stroke: 'var(--muted)' }}
                                  strokeWidth="1.5"
                                >
                                  <circle cx="12" cy="12" r="9" />
                                  <path d="M10 8.6v6.8l5.6-3.4Z" style={{ fill: 'var(--muted)' }} stroke="none" />
                                </svg>
                                {c.badge && <span className={`badge ${c.badge.cls}`}>{c.badge.text}</span>}
                              </div>
                            ) : (
                              <div className="athumb">
                                <img src={c.img} alt="" style={c.imgStyle} />
                                {c.badge && <span className={`badge ${c.badge.cls}`}>{c.badge.text}</span>}
                              </div>
                            )}
                            <div className="ai">
                              <b>{c.title}</b>
                              <div className="mono">{c.sub}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </React.Fragment>
            ))}
          </main>

          {/* 右:详情面板 */}
          <aside className="detail" data-od-id="assets-detail">
            <div className="detail-in">
              <div>
                <div className="lbl" style={{ marginBottom: 8 }}>
                  资产详情
                </div>
                <b id="dName" style={{ fontSize: 'var(--text-base)' }}>
                  {detail.name}
                </b>
              </div>

              {detail.img ? (
                <div className="dpreview" id="dPreview">
                  <img
                    src={detail.img}
                    alt="资产预览"
                    id="dImg"
                    style={{
                      filter: detail.gray ? 'grayscale(1)' : undefined,
                      opacity: detail.gray ? 0.6 : 1,
                    }}
                  />
                  {detail.play && (
                    <span className="play">
                      <span>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8 5.5v13l11-6.5Z" />
                        </svg>
                      </span>
                    </span>
                  )}
                </div>
              ) : (
                <div className="dpreview" id="dPreview" style={{ display: 'none' }} />
              )}

              <div>
                <div className="lbl" style={{ marginBottom: 8 }}>
                  自动元数据
                </div>
                <div className="kv" id="dMeta">
                  {detail.meta.map((m, i) => (
                    <div className="kr" key={i}>
                      <span>{m[0]}</span>
                      <span className="mono">{m[1]}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="lbl" style={{ marginBottom: 8 }}>
                  绑定与引用
                </div>
                <div className="kv" id="dRefs">
                  {detail.refs.map((m, i) => (
                    <div className="kr" key={i}>
                      <span>{m[0]}</span>
                      <span className="mut">{m[1]}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="lbl" style={{ marginBottom: 8 }}>
                  完整生成参数（可复现）
                </div>
                <div className="parambox mono" id="dParams">
                  {detail.params}
                </div>
              </div>

              <div className="row g6" style={{ flexWrap: 'wrap' }}>
                <button className="btn btn-s btn-sm">拖到画布</button>
                <button className="btn btn-s btn-sm">设为首帧</button>
                <button className="btn btn-s btn-sm">归档</button>
                <span className="spacer" />
                <button className="btn btn-g btn-sm btn-danger" id="delBtn" onClick={() => setDelNoteOpen(true)}>
                  删除
                </button>
              </div>

              {delNoteOpen && (
                <div className="del-note" id="delNote">
                  删除将提示联动：画布节点与时间线片段同步移除。
                  <div className="row g6" style={{ marginTop: 8 }}>
                    <button className="btn btn-d btn-sm" id="delConfirm" onClick={handleDeleteConfirm}>
                      确认删除
                    </button>
                    <button className="btn btn-g btn-sm" id="delCancel" onClick={() => setDelNoteOpen(false)}>
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
