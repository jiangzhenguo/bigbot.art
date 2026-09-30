import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import type {
  AccelPack,
  AppSettings,
  CloudProviderEntry,
  LlmSource,
  LocalModelInfo,
  LocalRuntimeModels,
  RuntimeProbe,
} from '@bigbotart/shared';
import PageTopBar from '../components/PageTopBar';
import { ToolModelsSection } from './ToolModelsSection';
import { useI18n, useT } from '../i18n';

interface SettingsPageProps {
  onNavigate: (
    page: 'home' | 'canvas' | 'assets' | 'skills' | 'timeline' | 'settings' | 'onboarding' | 'projects',
  ) => void;
  /** 返回上一页(App 导航栈出栈,回到来源页) */
  onBack: () => void;
  /** 返回按钮文案(来源页名,如「画布」「首页」) */
  backLabel: string;
}

type GroupKey = 'general' | 'llm' | 'toolModels' | 'engines' | 'queue' | 'storage' | 'models' | 'lora';

/** 面包屑当前组名(与侧栏导航文案一致) */
const GROUP_LABEL: Record<GroupKey, string> = {
  general: '通用',
  llm: 'LLM 来源',
  toolModels: '工具模型',
  engines: '引擎(Provider)',
  queue: '队列与资源',
  storage: '存储与项目',
  models: '模型下载',
  lora: '加速 LoRA',
};

/** LLM 来源单选(设计稿 data-llm 的五档) */
type LlmKey = 'lmstudio' | 'ollama' | 'pimlx' | 'openai-compat' | 'cloud';

/** 本地运行时探测的三种来源 */
type LocalKind = 'lmstudio' | 'ollama' | 'pimlx';

/** settings.llm.kind → LlmKey(none/未知回退 lmstudio) */
const KIND_TO_KEY: Record<LlmSource['kind'], LlmKey> = {
  cloud: 'cloud',
  lmstudio: 'lmstudio',
  ollama: 'ollama',
  'mlx-provider': 'pimlx',
  'openai-compatible': 'openai-compat',
  none: 'lmstudio',
};

/** OpenAI 兼容端点默认地址(输入为空时的兜底,placeholder 照设计稿) */
const COMPAT_DEFAULT_URL = 'http://127.0.0.1:8000/v1';

/** 探测返回前的设计稿默认端点 */
const DEFAULT_ENDPOINT: Record<LocalKind, string> = {
  lmstudio: 'http://127.0.0.1:1234/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  pimlx: 'http://127.0.0.1:8099/v1',
};

/** 供应商目录条目(「＋ 添加供应商」弹层,pv-grid) */
interface PvCatalogEntry {
  id: string;
  av: string;
  name: string;
  sub: string;
  host: string;
  models: Array<{ id: string; note?: string }>;
}

/** 供应商目录:设计稿 PV_CATALOG 8 项(文案 1:1)+ 追加 6 项 */
const PV_CATALOG: PvCatalogEntry[] = [
  { id: 'custom', av: '自', name: '自定义云服务', sub: 'OpenAI 兼容端点', host: '', models: [] },
  { id: 'deepseek', av: 'D', name: 'DeepSeek', sub: 'deepseek-chat / reasoner', host: 'https://api.deepseek.com/v1', models: [
    { id: 'deepseek-chat', note: 'V3.2 · 对话' }, { id: 'deepseek-reasoner', note: 'R1 · 推理' },
  ] },
  { id: 'siliconflow', av: '硅', name: '硅基流动', sub: 'SiliconFlow · 多模型聚合', host: 'https://api.siliconflow.cn/v1', models: [
    { id: 'deepseek-ai/DeepSeek-V3', note: '对话' }, { id: 'deepseek-ai/DeepSeek-R1', note: '推理' },
    { id: 'Qwen/Qwen2.5-72B-Instruct', note: '对话' }, { id: 'Qwen/Qwen2.5-7B-Instruct', note: '高速' },
    { id: 'THUDM/glm-4-9b-chat', note: '对话' },
  ] },
  { id: 'bailian', av: '云', name: '阿里云百炼', sub: 'DashScope · Qwen 系列', host: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [
    { id: 'qwen-max', note: '旗舰' }, { id: 'qwen-plus', note: '均衡' }, { id: 'qwen-turbo', note: '高速' }, { id: 'qwen-long', note: '长文本' },
  ] },
  { id: 'volc', av: '火', name: '火山引擎', sub: '方舟 Ark · 豆包系列', host: 'https://ark.cn-beijing.volces.com/api/v3', models: [
    { id: 'doubao-pro-32k', note: '旗舰' }, { id: 'doubao-lite-32k', note: '轻量' },
  ] },
  { id: 'hunyuan', av: '混', name: '腾讯混元', sub: '混元大模型', host: 'https://api.hunyuan.cloud.tencent.com/v1', models: [
    { id: 'hunyuan-pro', note: '旗舰' }, { id: 'hunyuan-standard', note: '标准' },
  ] },
  { id: 'openrouter', av: 'OR', name: 'OpenRouter', sub: '多供应商聚合', host: 'https://openrouter.ai/api/v1', models: [
    { id: 'openai/gpt-4o', note: 'OpenAI' }, { id: 'anthropic/claude-3.5-sonnet', note: 'Anthropic' },
  ] },
  { id: 'nim', av: 'N', name: '英伟达 NIM', sub: 'NVIDIA NIM 端点', host: 'https://integrate.api.nvidia.com/v1', models: [
    { id: 'meta/llama-3.1-70b-instruct', note: 'Llama 3.1 · 70B' },
  ] },
  { id: 'opencode-go', av: 'OC', name: 'opencode go', sub: 'OpenAI 兼容', host: '', models: [] },
  { id: 'minimax', av: 'M', name: 'MiniMax', sub: 'MiniMax 系列', host: 'https://api.minimaxi.com/v1', models: [] },
  { id: 'kimi', av: 'K', name: 'Kimi（月之暗面）', sub: 'kimi-k2 等', host: 'https://api.moonshot.cn/v1', models: [] },
  { id: 'zcode', av: 'Z', name: 'zcode', sub: 'OpenAI 兼容', host: '', models: [] },
  { id: 'openai', av: 'O', name: 'OpenAI', sub: 'gpt 系列', host: 'https://api.openai.com/v1', models: [] },
  { id: 'claude', av: 'C', name: 'Claude（兼容端点）', sub: 'Anthropic 兼容', host: 'https://api.anthropic.com/v1', models: [] },
];

/** lm-select 弹层条目(本地模型 / compat 远端模型共用) */
interface LmPopItem {
  id: string;
  label: string;
  sizeBytes?: number;
  vramGb?: number;
  note?: string;
  needsDownload?: boolean;
  /** 当前已加载(本地)/当前选中(compat) */
  selected?: boolean;
}

/**
 * LmPopover — lm-select 的下拉弹层(设计稿 lmPop)。
 * createPortal 到 body,position:fixed 定位在按钮下方;
 * Esc / 点外 / 滚动 / resize 关闭(照 CanvasSwitcher 全局点击模式)。
 * 样式用全局 .lm-pop 选择器(见 design-pages.css 尾部)。
 */
function LmPopover(props: {
  anchor: HTMLElement;
  title: string;
  items: LmPopItem[];
  /** true=本地来源,选中项额外显示「已加载」标;compat 只看 ✓ */
  markLoaded?: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const { anchor, title, items, markLoaded, onSelect, onClose } = props;
  const t = useT();
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  /* 打开时定位到按钮下方(固定定位,监听 resize 与滚动) */
  useLayoutEffect(() => {
    const place = (): void => {
      const r = anchor.getBoundingClientRect();
      setPos({
        left: Math.max(8, Math.min(r.left, window.innerWidth - 356)),
        top: r.bottom + 6,
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onClose, true); // 面板滚动即关闭
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [anchor, onClose]);

  /* 点弹层外 / Esc 关闭(点按钮本身由按钮 onClick 负责开关) */
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (popRef.current && popRef.current.contains(t)) return;
      if (anchor.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div ref={popRef} className="lm-pop" role="listbox" style={pos ?? undefined}>
      <div className="lm-phead">{title}</div>
      {items.map((it) => (
        <button
          key={it.id}
          className="lm-item"
          role="option"
          aria-selected={!!it.selected}
          onClick={() => {
            onSelect(it.id);
            onClose();
          }}
        >
          <span className="ck">{it.selected ? '✓' : ''}</span>
          <span className="grow mono">{it.label}</span>
          {(it.sizeBytes != null || it.vramGb != null || it.needsDownload || it.note) && (
            <span className="sz">
              {it.sizeBytes != null ? `${(it.sizeBytes / 1e9).toFixed(1)} GB · ` : ''}
              {t('显存 ≈ {v} GB', { v: it.vramGb ?? '—' })}
              {it.note ? ` · ${it.note}` : ''}
              {it.needsDownload ? t(' · 需下载') : ''}
            </span>
          )}
          {markLoaded && it.selected && <span className="ld">{t('已加载')}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}

interface DownloadState {
  status: 'idle' | 'downloading' | 'done' | 'failed' | 'cancelled';
  /** 主进程下载任务 id(轮询/取消用) */
  jobId?: string;
  pct?: number;
  error?: string;
}

/** 模型下载列表里可下载的条目(按 .mdl-row 顺序) */
const MODEL_IDS = ['qwen-image-2.1', 'qwen-image-edit', 'flux2-klein-9b', 'seedvr2-3b', 'qwen2.5-vl'] as const;

/** 模型 id → huggingface repo(mlxgen download 参数,与主进程白名单同口径) */
const MODEL_REPO: Record<'z-image-turbo' | (typeof MODEL_IDS)[number], string> = {
  'z-image-turbo': 'AbstractFramework/z-image-turbo-8bit',
  // 2.1 统一用 bf16 全量:文生图 + 参考编辑(qwen21.edit)三能力全有;
  // 原 8bit 社区导出无 vision tower(做不了编辑)已移除(2026-09-28)
  'qwen-image-2.1': 'Qwen/Qwen-Image-2.1',
  'qwen-image-edit': 'mlx-community/Qwen-Image-Edit-8bit',
  'flux2-klein-9b': 'AbstractFramework/flux.2-klein-9b-8bit',
  'seedvr2-3b': 'AbstractFramework/seedvr2-3b-8bit',
  'qwen2.5-vl': 'Qwen/Qwen2.5-VL-7B-Instruct',
};

export default function SettingsPage({ onNavigate, onBack, backLabel }: SettingsPageProps) {
  /* ---- 分组切换 ---- */
  const [group, setGroup] = useState<GroupKey>('llm');

  /* ---- LLM 单选(五档) ---- */
  const [llm, setLlm] = useState<LlmKey>('lmstudio');
  /** 最近一次持久化的 llm 来源(云端当前模型高亮 / radio 联动用) */
  const [llmSource, setLlmSource] = useState<LlmSource | null>(null);

  /* ---- 本地运行时探测 + 加载(llmLocalModels / llmLoadModel) ---- */
  interface LocalRowState {
    info: LocalRuntimeModels | null;
    /** 正在加载的模型 id(按钮 spinner + badge「加载模型中…」) */
    loading: string | null;
    loadError: string | null;
    hint: string | null;
  }
  const [locals, setLocals] = useState<Record<LocalKind, LocalRowState>>({
    lmstudio: { info: null, loading: null, loadError: null, hint: null },
    ollama: { info: null, loading: null, loadError: null, hint: null },
    pimlx: { info: null, loading: null, loadError: null, hint: null },
  });

  /* ---- lm-select 弹层(3 个本地来源 + compat 模型选择共用) ---- */
  const [lmPop, setLmPop] = useState<{ kind: LocalKind | 'compat'; anchor: HTMLElement } | null>(null);

  /* ---- OpenAI 兼容端点(测试连接 → 模型选择 → API Key 存钥匙串) ---- */
  const [compatUrl, setCompatUrl] = useState('');
  const [compatModel, setCompatModel] = useState('');
  const [compatTest, setCompatTest] = useState<{
    state: 'idle' | 'testing' | 'ok' | 'err';
    modelCount?: number;
    detail?: string;
  }>({ state: 'idle' });
  const [compatModels, setCompatModels] = useState<string[]>([]);
  const [compatKey, setCompatKey] = useState('');
  const [compatKeySaved, setCompatKeySaved] = useState(false);
  const [compatHint, setCompatHint] = useState<string | null>(null);

  /* ---- 云端 Provider 管理(cloudProviders 全量持久化;凭据只走钥匙串) ---- */
  const [cloudProviders, setCloudProviders] = useState<CloudProviderEntry[]>([]);
  const [expandedPv, setExpandedPv] = useState<Set<string>>(new Set());
  const [pvKeyVals, setPvKeyVals] = useState<Record<string, string>>({});
  const [pvKeyErr, setPvKeyErr] = useState<Record<string, string>>({});
  const [pvHostVals, setPvHostVals] = useState<Record<string, string>>({});
  const [pvChecks, setPvChecks] = useState<Record<string, {
    state: 'idle' | 'checking' | 'ok' | 'err';
    modelCount?: number;
    detail?: string;
  }>>({});
  const [cloudHint, setCloudHint] = useState<string | null>(null);
  const [addPvOpen, setAddPvOpen] = useState(false);
  /* 删除供应商两步确认:第一次点击进入确认态(3.2s 未再点自动复位) */
  const [pvDelConfirm, setPvDelConfirm] = useState<string | null>(null);
  const pvDelTimer = useRef<number | null>(null);

  /* ---- 添加模型弹层(打开即 llmListRemoteModels 真拉取) ---- */
  const [mdlFor, setMdlFor] = useState<string | null>(null);
  const [mdlOvlOpen, setMdlOvlOpen] = useState(false);
  const [mdlState, setMdlState] = useState<
    { status: 'loading' } | { status: 'ready'; models: string[] } | { status: 'error'; detail: string }
  >({ status: 'loading' });
  const [mdlSel, setMdlSel] = useState<Set<string>>(new Set());

  /* 短暂提示计时器 */
  const hintTimers = useRef<Record<string, number>>({});
  const flashHint = (key: string, msg: string): void => {
    const set: Record<string, (v: string | null) => void> = {
      lmstudio: (v) => setLocals((s) => ({ ...s, lmstudio: { ...s.lmstudio, hint: v } })),
      ollama: (v) => setLocals((s) => ({ ...s, ollama: { ...s.ollama, hint: v } })),
      pimlx: (v) => setLocals((s) => ({ ...s, pimlx: { ...s.pimlx, hint: v } })),
      compat: setCompatHint,
      cloud: setCloudHint,
    };
    set[key]?.(msg);
    window.clearTimeout(hintTimers.current[key]);
    hintTimers.current[key] = window.setTimeout(() => set[key]?.(null), 3200);
  };

  /* ---- 渲染模式:真实推理(仅由 getSettings 回填,点击经 setSettings 持久化) ---- */
  const [renderReal, setRenderReal] = useState(false);
  /** h3 视频生成:SSD 流式读权重(--ssd-streaming),全局开关,默认关 */
  const [ssdStreaming, setSsdStreaming] = useState(false);

  /* ---- 开关 ---- */
  const [sw, setSw] = useState<Record<string, boolean>>({
    'general.restore': true,
    'queue.videoSlot': true,
    'queue.exclusive': true,
    'queue.previewJump': false,
    'storage.projectLock': true,
  });
  const toggleSw = (id: string): void => setSw((s) => ({ ...s, [id]: !s[id] }));

  /* ---- 通用:外观 / 语言 chip ---- */
  const [appearance, setAppearance] = useState<'系统' | '浅色' | '深色'>('系统');
  /* 界面语言:全局 i18n 上下文(切换即生效并持久化到 settings.json,见 App.setLang) */
  const { lang, setLang } = useI18n();
  const t = useT();

  /* ==== LLM:本地来源辅助 ==== */

  /** 当前展示的模型:已加载优先,否则第一条,否则 null */
  const loadedModel = (info: LocalRuntimeModels | null): LocalModelInfo | null => {
    if (!info) return null;
    return info.models.find((m) => m.loaded) ?? info.models[0] ?? null;
  };

  const localEndpoint = (kind: LocalKind): string =>
    locals[kind].info?.endpoint ?? DEFAULT_ENDPOINT[kind];

  const localLoadedLabel = (kind: LocalKind): string => {
    const info = locals[kind].info;
    const m = loadedModel(info);
    return m ? m.displayName || m.id : t('未加载');
  };

  const localBadge = (kind: LocalKind): ReactNode => {
    const st = locals[kind];
    if (st.loading) {
      return (
        <span className="badge">
          <span className="spin" />
          {t('加载模型中…')}
        </span>
      );
    }
    if (st.loadError) {
      return (
        <span className="badge err" title={st.loadError}>
          {st.loadError}
        </span>
      );
    }
    const info = st.info;
    if (!info) {
      return (
        <span className="badge">
          <span className="spin" />
          {t('探测中…')}
        </span>
      );
    }
    if (!info.available) {
      return (
        <span className="badge" title={info.detail}>
          {info.detail ?? t('未检测到')}
        </span>
      );
    }
    if (kind === 'pimlx') {
      return (
        <span className="badge ok">
          <span className="dot ok" />
          {t('已就绪 · 模型按需下载')}
        </span>
      );
    }
    return (
      <span className="badge ok">
        <span className="dot ok" />
        {t('已连接 · 模型自动发现')}
      </span>
    );
  };

  const vramRow = (kind: LocalKind): ReactNode => {
    const info = locals[kind].info;
    if (!info) return null;
    const m = loadedModel(info);
    if (!m || m.vramGb == null) return null;
    const total = info.memTotalGb || 64;
    const pct = Math.min(100, (m.vramGb / total) * 100);
    const warn = m.vramGb >= total * 0.75;
    return (
      <div className="vram">
        <span className="vram-track">
          <span className={`vram-fill${warn ? ' warn' : ''}`} style={{ width: `${pct}%` }} />
        </span>
        <span className="vram-txt mono">
          {t('显存预估 ≈ {v} GB / {total} GB 统一内存 · 与生成引擎共享', { v: m.vramGb, total })}
        </span>
      </div>
    );
  };

  const localSub = (kind: LocalKind): string => {
    const info = locals[kind].info;
    if (kind === 'pimlx') {
      return t('MLX 原生 4bit · 免代理直跑 · 支持工具调用与识图（VLM）· 首次加载自动从 HuggingFace 拉取');
    }
    const n = info ? info.models.filter((m) => m.supportsTools).length : 0;
    if (kind === 'ollama') {
      return t('原生 API :11434 · 兼容 OpenAI /v1 · 发现 {n} 个支持工具调用的已装模型 · 热加载切换约 8s', { n });
    }
    return t('发现 {n} 个本地模型 · 单模型驻留显存，切换时自动卸载旧模型（约 20s · 首次 Metal 预热）', { n });
  };

  /** 加载本地模型 → 更新 loaded/vram/badge → 持久化 llm + lmStudioModel → radio 自动 on */
  const loadLocal = async (kind: LocalKind, id: string): Promise<void> => {
    setLocals((s) => ({ ...s, [kind]: { ...s[kind], loading: id, loadError: null } }));
    let ok = false;
    let errMsg = '';
    try {
      const res = await window.bigbotart.llmLoadModel(kind, id);
      if (!res.ok) throw new Error(res.error ?? t('加载失败'));
      ok = true;
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e);
    }
    if (!ok) {
      setLocals((s) => ({ ...s, [kind]: { ...s[kind], loading: null, loadError: errMsg } }));
      return;
    }
    setLocals((s) => {
      const info = s[kind].info;
      if (!info) {
        return { ...s, [kind]: { ...s[kind], loading: null, loadError: null } };
      }
      return {
        ...s,
        [kind]: {
          ...s[kind],
          loading: null,
          loadError: null,
          info: { ...info, models: info.models.map((m) => ({ ...m, loaded: m.id === id })) },
        },
      };
    });
    const kindSource: LlmSource =
      kind === 'lmstudio'
        ? { kind: 'lmstudio', model: id }
        : kind === 'ollama'
          ? { kind: 'ollama', model: id }
          : { kind: 'mlx-provider', model: id };
    const patch: Partial<AppSettings> = { llm: kindSource };
    if (kind === 'lmstudio') patch.lmStudioModel = id;
    try {
      const s = await window.bigbotart.setSettings(patch);
      setLlmSource(s.llm ?? kindSource);
    } catch {
      setLlmSource(kindSource);
    }
    setLlm(KIND_TO_KEY[kindSource.kind]);
  };

  /** 持久化指定 llm 来源(同时更新 llmSource,供云端高亮等) */
  const persistKind = (src: LlmSource): void => {
    setLlmSource(src);
    void window.bigbotart
      .setSettings({ llm: src })
      .then((s) => setLlmSource(s.llm ?? src))
      .catch(() => setLlmSource(src));
  };

  /** radio 直接点击:有已加载/已配置模型才持久化,否则仅选中并提示先配置 */
  const onLlmRadio = (key: LlmKey): void => {
    setLlm(key);
    switch (key) {
      case 'lmstudio':
      case 'ollama':
      case 'pimlx': {
        const info = locals[key].info;
        // 已驻留的模型优先;没有驻留时回退到清单首个模型并顺带加载它
        // (此前无 loaded 就只闪提示、不落盘,用户的显式选择被丢弃 → 「选了也不能用」)
        const target = info?.models.find((m) => m.loaded) ?? info?.models[0] ?? null;
        if (target) {
          const src: LlmSource =
            key === 'lmstudio'
              ? { kind: 'lmstudio', model: target.id }
              : key === 'ollama'
                ? { kind: 'ollama', model: target.id }
                : { kind: 'mlx-provider', model: target.id };
          const patch: Partial<AppSettings> = { llm: src };
          if (key === 'lmstudio') patch.lmStudioModel = target.id;
          setLlmSource(src);
          void window.bigbotart
            .setSettings(patch)
            .then((s) => setLlmSource(s.llm ?? src))
            .catch(() => setLlmSource(src));
          // 未驻留:后台把它加载进显存(失败在弹层里给出错误,不阻断选择落盘)
          if (!target.loaded) void loadLocal(key, target.id);
        } else {
          flashHint(key, t('尚未加载模型 —— 请先在下方的「加载模型」中选择要驻留的模型'));
        }
        return;
      }
      case 'openai-compat':
        if (compatModel) {
          persistKind({ kind: 'openai-compatible', baseUrl: compatUrl.trim() || COMPAT_DEFAULT_URL, model: compatModel });
        } else {
          flashHint('compat', t('请先「测试连接」并在下方选择模型'));
        }
        return;
      case 'cloud': {
        const cur = llmSource?.kind === 'cloud' ? llmSource : null;
        if (cur?.model && cloudProviders.some((p) => p.id === cur.provider && p.models.includes(cur.model!))) {
          persistKind({ kind: 'cloud', provider: cur.provider, model: cur.model });
          return;
        }
        // radio 点击必须真正生效:自动挑一个可用的云端供应商(已启用+有模型,优先已配 key),
        // 选中其首个模型并启用该供应商;一个都没有才提示先配置(此前只闪提示不选中,重启后看似"丢回本地")
        const target =
          cloudProviders.find((p) => p.enabled && p.models.length > 0 && p.hasKey) ??
          cloudProviders.find((p) => p.enabled && p.models.length > 0) ??
          cloudProviders.find((p) => p.models.length > 0);
        if (target) {
          if (!target.enabled) patchProvider(target.id, (p) => ({ ...p, enabled: true }));
          persistKind({ kind: 'cloud', provider: target.id, model: target.models[0]! });
        } else {
          flashHint('cloud', t('请先添加云端供应商并选择模型'));
        }
        return;
      }
    }
  };

  /* ==== LLM:lm-select 弹层 ==== */
  const openLmPop = (kind: LocalKind | 'compat', e: React.MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    const anchor = e.currentTarget;
    setLmPop((cur) => (cur && cur.kind === kind && cur.anchor === anchor ? null : { kind, anchor }));
  };

  const lmPopItems = (kind: LocalKind | 'compat'): LmPopItem[] => {
    if (kind === 'compat') {
      return compatModels.map((id) => ({ id, label: id, selected: compatModel === id }));
    }
    const info = locals[kind].info;
    if (!info) return [];
    return info.models.map((m) => ({
      id: m.id,
      label: m.displayName || m.id,
      sizeBytes: m.sizeBytes,
      vramGb: m.vramGb,
      note: m.note,
      needsDownload: m.needsDownload,
      selected: !!m.loaded,
    }));
  };

  /* ==== LLM:OpenAI 兼容端点 ==== */
  const testCompat = async (): Promise<void> => {
    if (compatTest.state === 'testing') return;
    const url = compatUrl.trim() || COMPAT_DEFAULT_URL;
    setCompatTest({ state: 'testing' });
    try {
      const r = await window.bigbotart.llmTestConnection({ baseUrl: url });
      if (!r.ok) {
        setCompatTest({ state: 'err', detail: r.detail ?? t('连接失败') });
        return;
      }
      setCompatTest({ state: 'ok', modelCount: r.modelCount, detail: r.detail });
      const list = await window.bigbotart.llmListRemoteModels({ baseUrl: url });
      setCompatModels(list.ok ? list.models : []);
    } catch (e) {
      setCompatTest({ state: 'err', detail: e instanceof Error ? e.message : String(e) });
    }
  };

  const compatBadge = (): ReactNode => {
    switch (compatTest.state) {
      case 'testing':
        return (
          <span className="badge">
            <span className="spin" />
            {t('连接中…')}
          </span>
        );
      case 'ok':
        return (
          <span className="badge ok">
            <span className="dot ok" />
            {t('已连接 · {n} 个模型 · v1 兼容', { n: compatTest.modelCount ?? 'N' })}
          </span>
        );
      case 'err':
        return (
          <span className="badge err" title={compatTest.detail}>
            {compatTest.detail ?? t('连接失败')}
          </span>
        );
      default:
        return null;
    }
  };

  const selectCompatModel = (id: string): void => {
    setCompatModel(id);
    setLlm('openai-compat');
    persistKind({ kind: 'openai-compatible', baseUrl: compatUrl.trim() || COMPAT_DEFAULT_URL, model: id });
  };

  const saveCompatKey = async (): Promise<void> => {
    if (!compatKey.trim()) return;
    try {
      const r = await window.bigbotart.credentialSet('openai-compat', compatKey.trim());
      if (r.ok) {
        setCompatKey('');
        setCompatKeySaved(true);
      } else {
        flashHint('compat', r.error ?? t('保存失败'));
      }
    } catch (e) {
      flashHint('compat', e instanceof Error ? e.message : String(e));
    }
  };

  /* ==== LLM:云端 Provider ==== */
  const persistCloud = (next: CloudProviderEntry[]): void => {
    const prev = cloudProviders;
    setCloudProviders(next);
    void window.bigbotart.setSettings({ cloudProviders: next }).catch(() => setCloudProviders(prev));
  };
  const patchProvider = (id: string, fn: (p: CloudProviderEntry) => CloudProviderEntry): void => {
    persistCloud(cloudProviders.map((p) => (p.id === id ? fn(p) : p)));
  };
  const togglePv = (id: string): void => {
    setExpandedPv((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const togglePvEnabled = (e: React.MouseEvent<HTMLSpanElement>, id: string): void => {
    e.stopPropagation();
    patchProvider(id, (p) => ({ ...p, enabled: !p.enabled }));
  };
  const savePvKey = async (id: string): Promise<void> => {
    const key = (pvKeyVals[id] ?? '').trim();
    if (!key) return;
    try {
      const r = await window.bigbotart.credentialSet(id, key);
      if (r.ok) {
        setPvKeyVals((v) => ({ ...v, [id]: '' }));
        setPvKeyErr((e) => ({ ...e, [id]: '' }));
        patchProvider(id, (p) => ({ ...p, hasKey: true }));
      } else {
        setPvKeyErr((e) => ({ ...e, [id]: r.error ?? t('保存失败') }));
      }
    } catch (err) {
      setPvKeyErr((e) => ({ ...e, [id]: err instanceof Error ? err.message : String(err) }));
    }
  };
  const checkPvHost = async (id: string): Promise<void> => {
    const p = cloudProviders.find((x) => x.id === id);
    if (!p) return;
    const host = (pvHostVals[id] ?? p.host).trim();
    if (!host) {
      setPvChecks((c) => ({ ...c, [id]: { state: 'err', detail: t('未设置 API Host') } }));
      return;
    }
    if (host !== p.host) patchProvider(id, (x) => ({ ...x, host }));
    setPvChecks((c) => ({ ...c, [id]: { state: 'checking' } }));
    try {
      const r = await window.bigbotart.llmTestConnection({ baseUrl: host, providerId: id });
      setPvChecks((c) => ({
        ...c,
        [id]: r.ok ? { state: 'ok', modelCount: r.modelCount } : { state: 'err', detail: r.detail ?? t('连接失败') },
      }));
    } catch (e) {
      setPvChecks((c) => ({ ...c, [id]: { state: 'err', detail: e instanceof Error ? e.message : String(e) } }));
    }
  };
  const pvCheckBadge = (id: string): ReactNode => {
    const c = pvChecks[id];
    if (!c || c.state === 'idle') return null;
    if (c.state === 'checking') {
      return (
        <span className="badge">
          <span className="spin" />
          {t('检查中…')}
        </span>
      );
    }
    if (c.state === 'ok') {
      return (
        <span className="badge ok">
          <span className="dot ok" />
          {t('连接正常 · v1 兼容')}
        </span>
      );
    }
    return (
      <span className="badge err" title={c.detail}>
        {c.detail ?? t('连接失败')}
      </span>
    );
  };
  const selectCloudModel = (id: string, model: string): void => {
    setLlm('cloud');
    // 选中即启用:停用状态的供应商被选中后 chat 会报「云端供应商已停用」,选中语义应包含启用
    const p = cloudProviders.find((x) => x.id === id);
    if (p && !p.enabled) patchProvider(id, (x) => ({ ...x, enabled: true }));
    persistKind({ kind: 'cloud', provider: id, model });
  };
  /** 删除云端供应商:两步确认;连带删钥匙串凭据、当前 llm 回退本地默认、清理项目级覆盖 */
  const removeProvider = async (id: string): Promise<void> => {
    if (pvDelConfirm !== id) {
      setPvDelConfirm(id);
      window.clearTimeout(pvDelTimer.current ?? undefined);
      pvDelTimer.current = window.setTimeout(() => setPvDelConfirm(null), 3200);
      return;
    }
    window.clearTimeout(pvDelTimer.current ?? undefined);
    setPvDelConfirm(null);
    persistCloud(cloudProviders.filter((p) => p.id !== id));
    void window.bigbotart.credentialDelete(id).catch(() => {});
    if (llmSource?.kind === 'cloud' && llmSource.provider === id) {
      // 当前来源被删 → 回退本地默认(与 DEFAULTS 同口径:model 缺省由主进程补 lmStudioModel)
      setLlm('lmstudio');
      persistKind({ kind: 'lmstudio' });
    }
    // 项目级覆盖引用该供应商的,清掉(否则下次对话报「云端供应商不存在」)
    try {
      const projects = await window.bigbotart.listProjects();
      for (const pr of projects) {
        if (pr.llmOverride?.kind === 'cloud' && pr.llmOverride.provider === id) {
          void window.bigbotart.setProjectLlm(pr.id, null).catch(() => {});
        }
      }
    } catch {
      /* 项目列表读取失败不阻塞删除 */
    }
  };
  const delPvModel = (e: React.MouseEvent<HTMLButtonElement>, id: string, model: string): void => {
    e.stopPropagation();
    patchProvider(id, (p) => ({ ...p, models: p.models.filter((m) => m !== model) }));
  };
  const hostShort = (p: CloudProviderEntry): string =>
    p.host ? p.host.replace(/^https?:\/\//, '') : t('未设置 API Host');
  /** 当前生效的云端选择(设置页里高亮对应 pv-mrow / 云 radio 联动) */
  const curCloudSource = llmSource?.kind === 'cloud' ? llmSource : null;

  const addProvider = (c: PvCatalogEntry): void => {
    const id = c.id === 'custom' ? `custom-${Date.now()}` : c.id;
    const entry: CloudProviderEntry = {
      id,
      name: c.name,
      avatar: c.av,
      sub: c.sub,
      host: c.host,
      models: [],
      enabled: false,
      hasKey: false,
    };
    const next = [...cloudProviders, entry];
    setCloudProviders(next);
    setExpandedPv((s) => new Set(s).add(id));
    setPvHostVals((v) => ({ ...v, [id]: c.host }));
    setAddPvOpen(false);
    void window.bigbotart.setSettings({ cloudProviders: next }).catch(() => setCloudProviders(cloudProviders));
  };

  /* ==== LLM:添加模型弹层(GET /v1/models 真拉取) ==== */
  const fetchMdl = async (pid: string): Promise<void> => {
    const p = cloudProviders.find((x) => x.id === pid);
    if (!p) return;
    setMdlState({ status: 'loading' });
    try {
      const r = await window.bigbotart.llmListRemoteModels({ baseUrl: p.host, providerId: pid });
      if (r.ok && r.models.length > 0) setMdlState({ status: 'ready', models: r.models });
      else setMdlState({ status: 'error', detail: r.error ?? t('该供应商未返回可枚举的模型清单') });
    } catch (e) {
      setMdlState({ status: 'error', detail: e instanceof Error ? e.message : String(e) });
    }
  };
  const openMdl = async (pid: string): Promise<void> => {
    setMdlFor(pid);
    setMdlSel(new Set());
    setMdlOvlOpen(true);
    await fetchMdl(pid);
  };
  const toggleMdlSel = (mid: string): void => {
    setMdlSel((s) => {
      const n = new Set(s);
      if (n.has(mid)) n.delete(mid);
      else n.add(mid);
      return n;
    });
  };
  /** 「全选」只选未添加项(设计稿 mfoot 行为) */
  const mdlAll = (): void => {
    if (mdlState.status !== 'ready') return;
    const p = cloudProviders.find((x) => x.id === mdlFor);
    if (!p) return;
    setMdlSel(new Set(mdlState.models.filter((m) => !p.models.includes(m))));
  };
  const addMdlOk = (): void => {
    if (!mdlFor) return;
    const ids = [...mdlSel];
    if (!ids.length) return;
    patchProvider(mdlFor, (x) => ({ ...x, models: [...new Set([...x.models, ...ids])] }));
    setMdlOvlOpen(false);
  };

  /* ---- 挂载时回填持久化设置(getSettings) ---- */
  useEffect(() => {
    let alive = true;
    void window.bigbotart
      .getSettings()
      .then((s: AppSettings) => {
        if (!alive) return;
        setRenderReal(s.renderMode === 'real');
        setSsdStreaming(s.ssdStreaming === true);
        setLlmSource(s.llm ?? null);
        if (s.llm?.kind) setLlm(KIND_TO_KEY[s.llm.kind] ?? 'lmstudio');
        if (s.llm?.kind === 'openai-compatible') {
          if (s.llm.baseUrl) setCompatUrl(s.llm.baseUrl);
          if (s.llm.model) setCompatModel(s.llm.model);
        }
        const provs = s.cloudProviders ?? [];
        setCloudProviders(provs);
        setPvHostVals(Object.fromEntries(provs.map((p) => [p.id, p.host])));
        if (provs[0]) setExpandedPv(new Set([provs[0].id]));
      })
      .catch(() => {
        /* 设置读取失败:保持设计稿默认值 */
      });
    return () => {
      alive = false;
    };
  }, []);

  /* ---- 挂载时并行探测三个本地运行时(llmLocalModels) ---- */
  useEffect(() => {
    let alive = true;
    const kinds: LocalKind[] = ['lmstudio', 'ollama', 'pimlx'];
    void Promise.all(kinds.map((k) => window.bigbotart.llmLocalModels(k)))
      .then((rs) => {
        if (!alive) return;
        setLocals((prev) => {
          const next = { ...prev };
          rs.forEach((r, i) => {
            const k = kinds[i]!;
            next[k] = { ...next[k], info: r, loadError: null };
          });
          return next;
        });
      })
      .catch(() => {
        /* 探测失败:保持默认占位 */
      });
    return () => {
      alive = false;
    };
  }, []);

  /* ---- 切换分组时关闭所有弹层(避免弹层悬浮在别的分组上) ---- */
  useEffect(() => {
    if (group !== 'llm') {
      setLmPop(null);
      setAddPvOpen(false);
      setMdlOvlOpen(false);
    }
  }, [group]);

  /* ---- Esc 关闭两个弹层 ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setAddPvOpen(false);
      setMdlOvlOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /* ---- 渲染模式开关:真实推理(demo / real) ---- */
  const toggleRenderMode = (): void => {
    const next = !renderReal;
    setRenderReal(next);
    void window.bigbotart
      .setSettings({ renderMode: next ? 'real' : 'demo' })
      .catch(() => setRenderReal(!next));
  };

  /* ---- SSD 流式读权重开关(h3 视频生成 --ssd-streaming,全局默认关) ---- */
  const toggleSsdStreaming = async (): Promise<void> => {
    const next = !ssdStreaming;
    setSsdStreaming(next);
    try {
      await window.bigbotart.setSettings({ ssdStreaming: next });
    } catch {
      setSsdStreaming(!next);
    }
  };

  /* ---- 引擎探测(真实接线 window.bigbotart.probeRuntimes) ---- */
  const [probes, setProbes] = useState<RuntimeProbe[]>([]);
  const [detecting, setDetecting] = useState(false);
  const probe = async (): Promise<void> => {
    if (detecting) return;
    setDetecting(true);
    try {
      setProbes(await window.bigbotart.probeRuntimes());
    } catch (e) {
      console.error('引擎探测失败', e);
    } finally {
      setDetecting(false);
    }
  };
  const findProbe = (id: RuntimeProbe['id']): RuntimeProbe | undefined =>
    probes.find((p) => p.id === id);

  /* ---- ComfyUI ---- */
  const [comfy, setComfy] = useState<{ chip: string; btn: string; busy: boolean; done: boolean }>({
    chip: t('未连接'),
    btn: t('连接'),
    busy: false,
    done: false,
  });
  const connectComfy = (): void => {
    if (comfy.busy || comfy.done) return;
    setComfy({ chip: t('连接中…'), btn: t('连接'), busy: true, done: false });
    window.setTimeout(
      () => setComfy({ chip: t('未响应 · 稍后可在向导中安装'), btn: t('重试'), busy: false, done: false }),
      1300,
    );
  };

  /* ---- Wan2.2 / Bernini-R 启用 ---- */
  const [wanEnabled, setWanEnabled] = useState(false);

  /* ---- 模型下载(mlxgen 真实下载:spawn mlxgen download + 进度轮询) ---- */
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({});
  /** 已下载状态:id → 已就绪(主进程按 HF 缓存目录探测) */
  const [mlxReady, setMlxReady] = useState<Record<string, boolean>>({});
  const refreshMlxModels = (): void => {
    void window.bigbotart
      .mlxgenModels()
      .then((list) => setMlxReady(Object.fromEntries(list.map((m) => [m.id, m.downloaded]))))
      .catch(() => {});
  };
  /** 轮询定时器表(model id → interval;unmount 统一清理,防旧 timer 泄漏) */
  const pollTimers = useRef<Record<string, number>>({});
  const stopPolling = (id: string): void => {
    const t = pollTimers.current[id];
    if (t) {
      window.clearInterval(t);
      delete pollTimers.current[id];
    }
  };
  /** 对指定下载任务轮询进度,终态(running 以外)停表 + 刷新就绪状态 */
  const startPolling = (id: string, jobId: string): void => {
    stopPolling(id);
    pollTimers.current[id] = window.setInterval(() => {
      void window.bigbotart
        .mlxgenDownloadStatus(jobId)
        .then((st) => {
          setDownloads((d) => ({
            ...d,
            [id]: { status: st.status === 'running' ? 'downloading' : st.status, jobId, pct: st.pct ?? 0, error: st.error },
          }));
          if (st.status !== 'running') {
            stopPolling(id);
            refreshMlxModels();
          }
        })
        .catch(() => {});
    }, 700);
  };
  /** 进入设置页/页面刷新时,恢复主进程仍在进行的下载任务进度(此前 startDownload 的 jobId 只存在组件 state) */
  const pollActiveDownloads = (): void => {
    void window.bigbotart
      .mlxgenDownloadActive()
      .then((tasks) => {
        for (const t of tasks) {
          setDownloads((d) =>
            d[t.id]?.status === 'downloading' ? d : { ...d, [t.id]: { status: 'downloading', jobId: t.jobId, pct: t.pct ?? 0 } },
          );
          startPolling(t.id, t.jobId);
        }
      })
      .catch(() => {});
  };
  useEffect(() => {
    refreshMlxModels();
    pollActiveDownloads();
    return () => {
      for (const id of Object.keys(pollTimers.current)) stopPolling(id);
    };
  }, []);

  const startDownload = (id: string): void => {
    const repoId = MODEL_REPO[id as keyof typeof MODEL_REPO] ?? '';
    if (!repoId) return;
    void window.bigbotart
      .mlxgenDownload(repoId)
      .then((res) => {
        const jobId = res.jobId;
        if (!res.ok || !jobId) {
          setDownloads((d) => ({ ...d, [id]: { status: 'failed', error: res.error ?? t('启动下载失败') } }));
          return;
        }
        setDownloads((d) => ({ ...d, [id]: { status: 'downloading', jobId, pct: 0 } }));
        startPolling(id, jobId);
      })
      .catch(() => {
        setDownloads((d) => ({ ...d, [id]: { status: 'failed', error: t('下载启动失败') } }));
      });
  };

  /** 取消进行中的下载(主进程终止子进程/中止 fetch,保留断点续传) */
  const cancelDownload = (id: string, jobId?: string): void => {
    if (!jobId) {
      stopPolling(id);
      setDownloads((d) => ({ ...d, [id]: { status: 'cancelled', error: t('已取消') } }));
      return;
    }
    void window.bigbotart
      .mlxgenDownloadCancel(jobId)
      .then((r) => {
        stopPolling(id);
        setDownloads((d) => ({ ...d, [id]: { status: r.ok ? 'cancelled' : 'downloading', jobId, error: r.ok ? t('已取消 · 保留断点续传') : r.error ?? t('取消失败') } }));
        if (r.ok) refreshMlxModels();
      })
      .catch(() => {
        stopPolling(id);
        setDownloads((d) => ({ ...d, [id]: { status: 'cancelled', jobId, error: t('已取消') } }));
      });
  };

  /* ---- 🚀 加速 LoRA(蒸馏模型包)---- */
  const [accelPacks, setAccelPacks] = useState<AccelPack[]>([]);
  const [accelMsg, setAccelMsg] = useState<string | null>(null);
  const [accelForm, setAccelForm] = useState({ name: '', path: '', steps: 8 as 4 | 8 });
  const refreshAccel = (): void => {
    // 防御:主进程/preload 未重建时通道可能不存在(HMR 先于 main 热更),缺失则降级空列表,不白屏
    const api = window.bigbotart;
    if (typeof api.accelList !== 'function') {
      console.warn('[accel] accelList 通道不可用(主进程/preload 未重载?)· 加速 LoRA 列表为空');
      setAccelPacks([]);
      return;
    }
    void api.accelList().then(setAccelPacks).catch(() => setAccelPacks([]));
  };
  useEffect(() => {
    refreshAccel();
  }, []);
  const installAccel = (): void => {
    if (!accelForm.name.trim() || !accelForm.path.trim()) {
      setAccelMsg(t('请填名称与目录路径'));
      return;
    }
    void window.bigbotart.accelInstall(accelForm).then((r) => {
      if (r.ok) {
        setAccelPacks(r.packs ?? []);
        setAccelForm({ name: '', path: '', steps: 8 });
        setAccelMsg(t('已安装「{name}」· 登记完成(文件未拷贝)', { name: accelForm.name.trim() }));
      } else {
        setAccelMsg(r.error ?? t('安装失败'));
      }
    });
  };
  const removeAccel = (id: string): void => {
    void window.bigbotart.accelRemove(id).then((r) => {
      if (r.ok) {
        setAccelPacks(r.packs ?? []);
        setAccelMsg(t('已删除登记(磁盘文件保留)'));
      } else {
        setAccelMsg(r.error ?? t('删除失败'));
      }
    });
  };
  const setDefaultAccel = (id: string): void => {
    void window.bigbotart.accelSetDefault(id).then((r) => {
      if (r.ok) setAccelPacks(r.packs ?? []);
      else setAccelMsg(r.error ?? t('操作失败'));
    });
  };

  /* ---- 引擎状态渲染:探测结果优先,否则回退设计稿默认文案 ---- */
  const engineBadge = (id: RuntimeProbe['id']): { text: string; ok: boolean } => {
    const p = findProbe(id);
    if (p) {
      if (p.status === 'ready') return { text: p.version ? t('已就绪 · {v}', { v: p.version }) : t('已就绪'), ok: true };
      if (p.status === 'error') return { text: t('异常'), ok: false };
      return { text: t('未检测到'), ok: false };
    }
    return { text: t('检测'), ok: false };
  };

  const h3 = engineBadge('h3c');

  return (
    <div className="pg-settings">
      <div className="app" data-od-id="settings-app">
        {/* ── 公共顶部栏:返回来源页 + 面包屑(与资源/技能页同款) ── */}
        <PageTopBar
          odId="settings"
          backLabel={backLabel}
          onBack={onBack}
          crumb={
            <>
              <b>{t('设置')}</b>
              <span className="chev">›</span>
              <span>{t(GROUP_LABEL[group])}</span>
            </>
          }
        />
        <div className="sbody">
        {/* 左:设置导航(brand/「设置」标签已移除,页面标题在公共顶栏面包屑) */}
        <aside className="side" data-od-id="settings-nav">
          <div className="side-nav" style={{ marginTop: 12 }}>
            <a
              className={`side-link${group === 'general' ? ' on' : ''}`}
              data-panel="general"
              onClick={() => setGroup('general')}
            >
              {t('通用')}
            </a>
            <a
              className={`side-link${group === 'llm' ? ' on' : ''}`}
              data-panel="llm"
              onClick={() => setGroup('llm')}
            >
              {t('LLM 来源')}
            </a>
            <a
              className={`side-link${group === 'toolModels' ? ' on' : ''}`}
              data-panel="toolModels"
              onClick={() => setGroup('toolModels')}
            >
              {t('工具模型')}
            </a>
            <a
              className={`side-link${group === 'engines' ? ' on' : ''}`}
              data-panel="engines"
              onClick={() => setGroup('engines')}
            >
              {t('引擎（Provider）')}
            </a>
            <a
              className={`side-link${group === 'queue' ? ' on' : ''}`}
              data-panel="queue"
              onClick={() => setGroup('queue')}
            >
              {t('队列与资源')}
            </a>
            <a
              className={`side-link${group === 'storage' ? ' on' : ''}`}
              data-panel="storage"
              onClick={() => setGroup('storage')}
            >
              {t('存储与项目')}
            </a>
            <a
              className={`side-link${group === 'models' ? ' on' : ''}`}
              data-panel="models"
              onClick={() => setGroup('models')}
            >
              {t('模型下载')}
            </a>
            <a
              className={`side-link${group === 'lora' ? ' on' : ''}`}
              data-panel="lora"
              onClick={() => setGroup('lora')}
            >
              {t('🚀 加速 LoRA')}
            </a>
            <a
              className="side-link"
              href="onboarding.html"
              onClick={(e) => {
                e.preventDefault();
                onNavigate('onboarding');
              }}
            >
              {t('引擎引导向导…')}
            </a>
          </div>
          <div className="side-foot">
            <div className="local-card">
              <b style={{ color: 'var(--fg)' }}>{t('本地优先')}</b>
              <br />
              {t('不自动上传任何数据；云端 LLM 仅在显式配置凭据后启用。')}
            </div>
          </div>
        </aside>

        {/* 右:面板 */}
        <main className="panel" data-od-id="settings-panel">
          <div className="panel-in">
            {/* 通用 */}
            <div className="group" data-group="general" hidden={group !== 'general'}>
              <div className="gh">
                <b>{t('通用')}</b>
              </div>
              <div className="srow">
                <div className="grow">
                  <b>{t('外观')}</b>
                  <div className="sub">{t('跟随系统（当前：浅色）')}</div>
                </div>
                <span
                  className={`chip${appearance === '系统' ? ' on' : ''}`}
                  onClick={() => setAppearance('系统')}
                >
                  {t('系统')}
                </span>
                <span
                  className={`chip${appearance === '浅色' ? ' on' : ''}`}
                  onClick={() => setAppearance('浅色')}
                >
                  {t('浅色')}
                </span>
                <span
                  className={`chip${appearance === '深色' ? ' on' : ''}`}
                  onClick={() => setAppearance('深色')}
                >
                  {t('深色')}
                </span>
              </div>
              <div className="srow">
                <div className="grow">
                  <b>{t('语言')}</b>
                  <div className="sub">{t('界面文案语言')}</div>
                </div>
                <span
                  className={`chip${lang === 'zh-CN' ? ' on' : ''}`}
                  data-od-id="lang-zh"
                  onClick={() => setLang('zh-CN')}
                >
                  简体中文
                </span>
                <span
                  className={`chip${lang === 'en' ? ' on' : ''}`}
                  data-od-id="lang-en"
                  onClick={() => setLang('en')}
                >
                  English
                </span>
              </div>
              <div className="srow">
                <div className="grow">
                  <b>{t('启动时恢复上次项目')}</b>
                  <div className="sub">{t('多标签页并发时带项目锁标记')}</div>
                </div>
                <span
                  className={`sw${sw['general.restore'] ? ' on' : ''}`}
                  data-sw=""
                  onClick={() => toggleSw('general.restore')}
                />
              </div>
              <div className="srow" data-od-id="settings-ssd-streaming">
                <div className="grow">
                  <b>{t('SSD 流式读权重（--ssd-streaming）')}</b>
                  <div className="sub">{t('h3 视频生成专用 · 省 RAM（峰值≈6GB）但慢约 30%；64GB+ 默认关更快，内存紧张（OOM/被系统杀进程）时再开')}</div>
                </div>
                <span
                  className={`sw${ssdStreaming ? ' on' : ''}`}
                  data-sw=""
                  onClick={() => void toggleSsdStreaming()}
                />
              </div>
            </div>

            {/* LLM 来源 */}
            <div className="group" data-group="llm" data-od-id="settings-llm" hidden={group !== 'llm'}>
              <div className="gh">
                <b>{t('LLM 来源（Agent 内核 · Pi Harness）')}</b>
                <span className="spacer" />
                <span className="mono mut" style={{ fontSize: 11 }}>
                  {t('仅列出支持工具调用的模型')}
                </span>
              </div>

              {/* ── 本地 · LM Studio ── */}
              <div className="srow" style={{ alignItems: 'flex-start' }}>
                <span
                  className={`radio${llm === 'lmstudio' ? ' on' : ''}`}
                  onClick={() => onLlmRadio('lmstudio')}
                />
                <div className="grow">
                  <b>{t('本地 · LM Studio（默认，自动发现）')}</b>
                  <div className="row g8" style={{ marginTop: 9 }}>
                    <span className="input-w mono">{localEndpoint('lmstudio')}</span>
                    {localBadge('lmstudio')}
                  </div>
                  <div className="row g8" style={{ marginTop: 9 }}>
                    <button
                      className={`lm-select${locals.lmstudio.loading ? ' loading' : ''}`}
                      aria-haspopup="listbox"
                      title={t('选择要加载到 LM Studio 的模型')}
                      onClick={(e) => openLmPop('lmstudio', e)}
                    >
                      <span className="mut" style={{ fontSize: 11 }}>{t('加载模型')}</span>
                      {locals.lmstudio.loading ? (
                        <b className="mono">
                          <span className="spin" style={{ display: 'inline-block', verticalAlign: -2 }} /> {t('加载中…')}
                        </b>
                      ) : (
                        <b className="mono">{localLoadedLabel('lmstudio')}</b>
                      )}
                      <span className="lm-caret">▾</span>
                    </button>
                  </div>
                  {vramRow('lmstudio')}
                  <div className="sub">{localSub('lmstudio')}</div>
                  {locals.lmstudio.hint && (
                    <div className="sub" style={{ color: 'var(--warn)', marginTop: 8 }}>{locals.lmstudio.hint}</div>
                  )}
                </div>
              </div>

              {/* ── 本地 · Ollama ── */}
              <div className="srow" style={{ alignItems: 'flex-start' }}>
                <span
                  className={`radio${llm === 'ollama' ? ' on' : ''}`}
                  onClick={() => onLlmRadio('ollama')}
                />
                <div className="grow">
                  <b>{t('本地 · Ollama（自动发现）')}</b>
                  <div className="row g8" style={{ marginTop: 9 }}>
                    <span className="input-w mono">{localEndpoint('ollama')}</span>
                    {localBadge('ollama')}
                  </div>
                  <div className="row g8" style={{ marginTop: 9 }}>
                    <button
                      className={`lm-select${locals.ollama.loading ? ' loading' : ''}`}
                      aria-haspopup="listbox"
                      title={t('选择 Ollama 加载的模型')}
                      onClick={(e) => openLmPop('ollama', e)}
                    >
                      <span className="mut" style={{ fontSize: 11 }}>{t('加载模型')}</span>
                      {locals.ollama.loading ? (
                        <b className="mono">
                          <span className="spin" style={{ display: 'inline-block', verticalAlign: -2 }} /> {t('加载中…')}
                        </b>
                      ) : (
                        <b className="mono">{localLoadedLabel('ollama')}</b>
                      )}
                      <span className="lm-caret">▾</span>
                    </button>
                  </div>
                  {vramRow('ollama')}
                  <div className="sub">{localSub('ollama')}</div>
                  {locals.ollama.hint && (
                    <div className="sub" style={{ color: 'var(--warn)', marginTop: 8 }}>{locals.ollama.hint}</div>
                  )}
                </div>
              </div>

              {/* ── 本地 · pi-mlx-provider ── */}
              <div className="srow" style={{ alignItems: 'flex-start' }}>
                <span
                  className={`radio${llm === 'pimlx' ? ' on' : ''}`}
                  onClick={() => onLlmRadio('pimlx')}
                />
                <div className="grow">
                  <b>{t('本地 · pi-mlx-provider（免 LM Studio）')}</b>
                  <div className="sub mono">{t('@sinamtz/pi-mlx-provider · MLX-VLM server · Apple Silicon 直跑')}</div>
                  <div className="row g8" style={{ marginTop: 9 }}>
                    {localBadge('pimlx')}
                  </div>
                  <div className="row g8" style={{ marginTop: 9 }}>
                    <button
                      className={`lm-select${locals.pimlx.loading ? ' loading' : ''}`}
                      aria-haspopup="listbox"
                      title={t('选择 pi-mlx 加载的模型')}
                      onClick={(e) => openLmPop('pimlx', e)}
                    >
                      <span className="mut" style={{ fontSize: 11 }}>{t('加载模型')}</span>
                      {locals.pimlx.loading ? (
                        <b className="mono">
                          <span className="spin" style={{ display: 'inline-block', verticalAlign: -2 }} /> {t('加载中…')}
                        </b>
                      ) : (
                        <b className="mono">{localLoadedLabel('pimlx')}</b>
                      )}
                      <span className="lm-caret">▾</span>
                    </button>
                  </div>
                  {vramRow('pimlx')}
                  <div className="sub">{localSub('pimlx')}</div>
                  {locals.pimlx.hint && (
                    <div className="sub" style={{ color: 'var(--warn)', marginTop: 8 }}>{locals.pimlx.hint}</div>
                  )}
                </div>
              </div>

              {/* ── 本地 · OpenAI 兼容端点 ── */}
              <div className="srow" style={{ alignItems: 'flex-start' }}>
                <span
                  className={`radio${llm === 'openai-compat' ? ' on' : ''}`}
                  onClick={() => onLlmRadio('openai-compat')}
                />
                <div className="grow">
                  <b>{t('本地 · OpenAI 兼容端点')}</b>
                  <div className="row g8" style={{ marginTop: 9 }}>
                    <span className="input-w">
                      <input
                        placeholder={t('vLLM / llama.cpp 等兼容端点，如 http://127.0.0.1:8000/v1')}
                        value={compatUrl}
                        onChange={(e) => setCompatUrl(e.target.value)}
                      />
                    </span>
                    <button className="btn btn-s btn-sm" onClick={() => void testCompat()}>
                      {t('测试连接')}
                    </button>
                    {compatBadge()}
                  </div>
                  {compatTest.state === 'ok' && compatModels.length > 0 && (
                    <div className="row g8" style={{ marginTop: 9 }}>
                      <button
                        className="lm-select"
                        aria-haspopup="listbox"
                        title={t('选择要使用的模型')}
                        onClick={(e) => openLmPop('compat', e)}
                      >
                        <span className="mut" style={{ fontSize: 11 }}>{t('选择模型')}</span>
                        <b className="mono">{compatModel || t('未选择')}</b>
                        <span className="lm-caret">▾</span>
                      </button>
                    </div>
                  )}
                  <div className="row g8" style={{ marginTop: 9 }}>
                    <span className="input-w">
                      <input
                        type="password"
                        placeholder={compatKeySaved ? t('已保存到本机钥匙串 ••••••••') : t('sk-… · 仅存本机钥匙串')}
                        value={compatKey}
                        onChange={(e) => setCompatKey(e.target.value)}
                      />
                    </span>
                    <button className="btn btn-s btn-sm" onClick={() => void saveCompatKey()}>
                      {t('保存')}
                    </button>
                  </div>
                  {compatHint && (
                    <div className="sub" style={{ color: 'var(--warn)', marginTop: 8 }}>
                      {compatHint}
                    </div>
                  )}
                </div>
              </div>

              {/* ── 云端 Provider ── */}
              <div className="srow" style={{ alignItems: 'flex-start' }}>
                <span
                  className={`radio${llm === 'cloud' ? ' on' : ''}`}
                  onClick={() => onLlmRadio('cloud')}
                />
                <div className="grow">
                  <b>{t('云端 Provider（可选增强）')}</b>
                  <div className="sub">{t('按供应商管理凭据与模型 · 均为 OpenAI 兼容协议 · 凭据仅存本机钥匙串')}</div>
                  <div className="pv-list" id="pvList">
                    {cloudProviders.length === 0 && (
                      <div className="pv-empty" style={{ border: 0 }}>{t('尚未配置云端供应商')}</div>
                    )}
                    {cloudProviders.map((p) => (
                      <div
                        key={p.id}
                        className={`pv${p.enabled ? '' : ' off'}${expandedPv.has(p.id) ? ' open' : ''}`}
                        data-pv={p.id}
                      >
                        <div className="pv-row" data-pv-row="" onClick={() => togglePv(p.id)}>
                          <span className="pv-av">{p.avatar}</span>
                          <div className="grow">
                            <b>{p.name}</b>
                            <div className="pv-sub mono">{hostShort(p)} · {t('{n} 个模型', { n: p.models.length })}</div>
                          </div>
                          <span
                            className={`sw${p.enabled ? ' on' : ''}`}
                            data-pv-sw=""
                            role="switch"
                            aria-checked={p.enabled}
                            title={t('启用 / 停用')}
                            onClick={(e) => togglePvEnabled(e, p.id)}
                          />
                          <span className="pv-caret">›</span>
                        </div>
                        {expandedPv.has(p.id) && (
                          <div className="pv-detail">
                            <div className="pv-frow">
                              <span className="pv-flbl">API Key</span>
                              <span className="input-w">
                                <input
                                  type="password"
                                  data-pv-key=""
                                  placeholder={p.hasKey ? t('已保存到本机钥匙串 ••••••••') : t('sk-… · 仅存本机钥匙串')}
                                  value={pvKeyVals[p.id] ?? ''}
                                  onChange={(e) => setPvKeyVals((v) => ({ ...v, [p.id]: e.target.value }))}
                                />
                              </span>
                              <button className="btn btn-s btn-sm" data-pv-save="" onClick={() => void savePvKey(p.id)}>
                                {t('保存')}
                              </button>
                            </div>
                            {pvKeyErr[p.id] && (
                              <div className="sub" style={{ color: 'var(--warn)' }}>{pvKeyErr[p.id]}</div>
                            )}
                            <div className="pv-frow">
                              <span className="pv-flbl">API Host</span>
                              <span className="input-w mono">
                                <input
                                  data-pv-host=""
                                  placeholder="https://…"
                                  value={pvHostVals[p.id] ?? p.host}
                                  onChange={(e) => setPvHostVals((v) => ({ ...v, [p.id]: e.target.value }))}
                                />
                              </span>
                              <button className="btn btn-s btn-sm" data-pv-check="" onClick={() => void checkPvHost(p.id)}>
                                {t('检查')}
                              </button>
                              {pvCheckBadge(p.id)}
                            </div>
                            <div className="pv-mhead">
                              <span className="lbl">{t('模型 · {n}', { n: p.models.length })}</span>
                              <span className="spacer" />
                              <button className="btn btn-s btn-sm" data-pv-addm="" onClick={() => void openMdl(p.id)}>
                                {t('＋ 添加模型')}
                              </button>
                            </div>
                            {p.models.length === 0 ? (
                              <div className="pv-empty">{t('尚未添加模型 —— 添加后会出现在画布 Agent 的模型选择器中')}</div>
                            ) : (
                              p.models.map((m) => {
                                const cur = curCloudSource?.provider === p.id && curCloudSource.model === m;
                                return (
                                  <div
                                    key={m}
                                    className={`pv-mrow${cur ? ' on' : ''}`}
                                    title={cur ? t('当前 LLM 来源') : t('点击设为当前 LLM 来源')}
                                    onClick={() => selectCloudModel(p.id, m)}
                                  >
                                    <div className="grow">
                                      <b className="mono">{m}</b>
                                    </div>
                                    {cur && <span className="pv-sel">✓</span>}
                                    <button
                                      className="pv-mdel"
                                      title={t('移除模型')}
                                      aria-label={t('移除模型')}
                                      onClick={(e) => delPvModel(e, p.id, m)}
                                    >
                                      ×
                                    </button>
                                  </div>
                                );
                              })
                            )}
                            <div className="pv-frow" style={{ marginTop: 10 }}>
                              <span className="spacer" />
                              <button
                                className="btn btn-s btn-sm"
                                data-od-id={`provider-del-${p.id}`}
                                style={{ color: 'var(--warn)' }}
                                title={t('删除该供应商(连同本机钥匙串凭据;不影响已生成的画布内容)')}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void removeProvider(p.id);
                                }}
                              >
                                {pvDelConfirm === p.id ? t('再点一次确认删除') : t('删除供应商')}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <button
                    className="btn btn-s btn-sm"
                    id="pvAddBtn"
                    data-od-id="provider-add-btn"
                    style={{ marginTop: 10 }}
                    onClick={() => setAddPvOpen(true)}
                  >
                    {t('＋ 添加供应商')}
                  </button>
                  {cloudHint && (
                    <div className="sub" style={{ color: 'var(--warn)', marginTop: 8 }}>{cloudHint}</div>
                  )}
                </div>
              </div>

              {/* ── 项目级覆盖说明 ── */}
              <div className="srow" style={{ background: 'var(--surface-warm)' }}>
                <div className="grow" style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)' }}>
                  <b style={{ color: 'var(--fg)' }}>{t('项目级覆盖')}</b> ·
                  {t('每个项目可单独指定 LLM 来源（项目设置面板）；未配置本地模型时自动回退云端，或纯模板 + 手工（AI-optional）。')}
                </div>
              </div>

              {/* lm-select 弹层(Portal 到 body,全局 .lm-pop 样式) */}
              {lmPop && (
                <LmPopover
                  anchor={lmPop.anchor}
                  title={t('选择要加载的本地模型')}
                  markLoaded={lmPop.kind !== 'compat'}
                  items={lmPopItems(lmPop.kind)}
                  onSelect={(id) => {
                    if (lmPop.kind === 'compat') {
                      selectCompatModel(id);
                    } else {
                      void loadLocal(lmPop.kind, id);
                    }
                  }}
                  onClose={() => setLmPop(null)}
                />
              )}

              {/* 弹层:添加供应商(Portal 到 body) */}
              {addPvOpen &&
                createPortal(
                  <div
                    className="ovl"
                    id="pvOvl"
                    onClick={(e) => {
                      if (e.target === e.currentTarget) setAddPvOpen(false);
                    }}
                  >
                    <div className="mcard" role="dialog" aria-label={t('添加供应商')} data-od-id="provider-add-dialog">
                      <div className="mhead">
                        <b>{t('添加供应商')}</b>
                        <span className="mut" style={{ fontSize: 11 }}>{t('均为 OpenAI 兼容协议')}</span>
                        <span className="spacer" />
                        <button className="mx" data-ovl-x="" aria-label={t('关闭')} onClick={() => setAddPvOpen(false)}>
                          ×
                        </button>
                      </div>
                      <div className="pv-grid" id="pvGrid">
                        {PV_CATALOG.map((c) => {
                          const added = cloudProviders.some((p) => p.id === c.id);
                          return (
                            <button
                              key={c.id}
                              className={`pv-opt${added ? ' added' : ''}`}
                              data-addpv={c.id}
                              disabled={added}
                              onClick={() => addProvider(c)}
                            >
                              <span className="pv-av">{c.av}</span>
                              <span className="grow">
                                <b>{c.name}</b>
                                <i>{c.sub}</i>
                              </span>
                              {added && <span className="mut" style={{ fontSize: 11, flex: 'none' }}>{t('已添加')}</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>,
                  document.body,
                )}

              {/* 弹层:添加模型(打开即 llmListRemoteModels 真拉取;样式按 settings.html 设计稿) */}
              {mdlOvlOpen &&
                mdlFor &&
                (() => {
                  const p = cloudProviders.find((x) => x.id === mdlFor);
                  if (!p) return null;
                  const mdlEp = (host: string): string => {
                    const h = host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
                    return h.endsWith('/v1') ? `${h}/models` : `${h}/v1/models`;
                  };
                  return createPortal(
                    <div
                      className="ovl"
                      id="mdlOvl"
                      onClick={(e) => {
                        if (e.target === e.currentTarget) setMdlOvlOpen(false);
                      }}
                    >
                      <div className="mcard" role="dialog" aria-label={t('添加模型')} data-od-id="model-add-dialog">
                        <div className="mhead">
                          <b id="mdlTitle">{t('添加模型 · {name}', { name: p.name })}</b>
                          <span className="spacer" />
                          <button
                            className={`mx mdl-refresh${mdlState.status === 'loading' ? ' spinning' : ''}`}
                            data-od-id="model-refresh-btn"
                            title={t('重新拉取模型列表')}
                            aria-label={t('重新拉取模型列表')}
                            disabled={mdlState.status === 'loading'}
                            onClick={() => void fetchMdl(mdlFor)}
                          >
                            <svg
                              viewBox="0 0 24 24"
                              width="13"
                              height="13"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                              <polyline points="21 3 21 9 15 9" />
                            </svg>
                          </button>
                          <button className="mx" data-ovl-x="" aria-label={t('关闭')} onClick={() => setMdlOvlOpen(false)}>
                            ×
                          </button>
                        </div>
                        <div className="mdl-meta" id="mdlMeta">
                          <span className="mono">GET {mdlEp(p.host)}</span>
                          <span className="spacer" />
                          {mdlState.status === 'loading' && <span>{t('拉取中…')}</span>}
                          {mdlState.status === 'ready' && (
                            <span>{t('{n} 个模型 · 刚刚更新', { n: mdlState.models.length })}</span>
                          )}
                          {mdlState.status === 'error' && (
                            <span style={{ color: 'var(--danger)' }}>{t('加载失败')}</span>
                          )}
                        </div>
                        <div className="mlist" id="mdlList">
                          {mdlState.status === 'loading' && (
                            <div className="mdl-loading">
                              <span className="spin" />
                              {t('正在从 {ep} 拉取模型列表…', { ep: mdlEp(p.host) })}
                            </div>
                          )}
                          {mdlState.status === 'error' && (
                            <div className="mdl-error">
                              <div className="mdl-error-title">{t('模型清单加载失败')}</div>
                              <div className="mdl-error-detail">{mdlState.detail}</div>
                            </div>
                          )}
                          {mdlState.status === 'ready' &&
                            mdlState.models.map((m) => {
                              const added = p.models.includes(m);
                              return (
                                <div
                                  key={m}
                                  className={`mrow${added ? ' added' : mdlSel.has(m) ? ' on' : ''}`}
                                  data-mid={added ? undefined : m}
                                  onClick={added ? undefined : () => toggleMdlSel(m)}
                                >
                                  <span className="mck">✓</span>
                                  <div className="grow">
                                    <b className="mono">{m}</b>
                                  </div>
                                  {added && <span className="mtag">{t('已添加')}</span>}
                                </div>
                              );
                            })}
                          {mdlState.status === 'ready' && mdlState.models.length === 0 && (
                            <div className="pv-empty">{t('该供应商未返回可用模型')}</div>
                          )}
                        </div>
                        <div className="mfoot">
                          <button
                            className="btn btn-g btn-sm"
                            id="mdlAll"
                            disabled={mdlState.status !== 'ready'}
                            onClick={mdlAll}
                          >
                            {t('全选')}
                          </button>
                          <span className="spacer" />
                          <span className="mut" style={{ fontSize: 11 }} id="mdlCnt">
                            {t('已选 {n} 个', { n: mdlSel.size })}
                          </span>
                          <button
                            className="btn btn-p btn-sm"
                            id="mdlOk"
                            disabled={mdlSel.size === 0}
                            onClick={addMdlOk}
                          >
                            {t('添加所选')}
                          </button>
                        </div>
                      </div>
                    </div>,
                    document.body,
                  );
                })()}
            </div>

            {/* 🆕 工具模型(2026-09-29 v1) */}
            <div hidden={group !== 'toolModels'}>
              <ToolModelsSection />
            </div>

            {/* 引擎 */}
            <div
              className="group"
              data-group="engines"
              data-od-id="settings-engines"
              hidden={group !== 'engines'}
            >
              <div className="gh">
                <b>{t('引擎（Provider 注册表）')}</b>
              </div>
              <div className="srow">
                <div className="grow">
                  <b>{t('真实推理')}</b>
                  <div className="sub">{t('关闭时一律用占位引擎演示，秒回；开启后引擎就绪则真实生成（慢）')}</div>
                </div>
                <span
                  className={`sw${renderReal ? ' on' : ''}`}
                  data-sw=""
                  onClick={toggleRenderMode}
                />
              </div>
              <div className="srow">
                <div className="grow">
                  <b>{t('h3.c（视频主引擎）')}</b>
                  <div className="sub mono">
                    {t('模型目录 ~/models/h3 · 144GB · 带声直出 · 能力：文生/首帧/尾帧/首尾帧/Ref2VA/参考视频音频')}
                  </div>
                </div>
                <span className="chip on">{t('默认 · 视频')}</span>
                <button className="btn btn-s btn-sm" data-detect="" onClick={probe} disabled={detecting}>
                  {detecting ? <span className="spin" /> : h3.text}
                </button>
              </div>
              <div className="srow">
                <div className="grow">
                  <b>{t('mlxgen（图片主引擎）')}</b>
                  <div className="sub mono">{t('Z-Image-Turbo 默认 · Qwen Edit / FLUX.2 Klein / SeedVR2 · 模型按需下载')}</div>
                </div>
                <span className="chip on">{t('默认 · 图片')}</span>
                <button className="btn btn-s btn-sm" onClick={() => setGroup('models')}>
                  {t('管理模型')}
                </button>
              </div>
              <div className="srow">
                <div className="grow">
                  <b>{t('ComfyUI（补充引擎）')}</b>
                  <div className="sub mono">{t('http://127.0.0.1:8188 · 仅 localhost · 导入 workflow_api.json（krea2 可直接导入）')}</div>
                </div>
                <span className="chip" id="comfyChip">
                  {comfy.chip}
                </span>
                <button
                  className="btn btn-s btn-sm"
                  id="comfyBtn"
                  onClick={connectComfy}
                  disabled={comfy.busy}
                >
                  {comfy.btn}
                </button>
              </div>
              <div className="srow">
                <div className="grow">
                  <b>{t('备选视频：mlxgen Wan2.2 / Bernini-R')}</b>
                  <div className="sub mono">{t('资源空闲时可用；能力差异在节点 UI 可见（不支持的模式禁用）')}</div>
                </div>
                <span className="chip">{t('可选')}</span>
                <button
                  className="btn btn-s btn-sm"
                  id="wanBtn"
                  onClick={() => setWanEnabled(true)}
                  disabled={wanEnabled}
                  style={wanEnabled ? { opacity: 0.6 } : undefined}
                >
                  {wanEnabled ? t('已启用 ✓') : t('启用')}
                </button>
              </div>
              </div>

            {/* 队列与资源 */}
            <div className="group" data-group="queue" data-od-id="settings-queue" hidden={group !== 'queue'}>
              <div className="gh">
                <b>{t('队列与资源')}</b>
              </div>
              <div className="srow">
                <div className="grow">
                  <b>{t('视频槽位')}</b>
                  <div className="sub mono">{t('同一时刻一个 h3 任务 · FIFO')}</div>
                </div>
                <span
                  className={`sw${sw['queue.videoSlot'] ? ' on' : ''}`}
                  data-sw=""
                  onClick={() => toggleSw('queue.videoSlot')}
                />
              </div>
              <div className="srow">
                <div className="grow">
                  <b>{t('图片槽位与视频槽位互斥')}</b>
                  <div className="sub mono">{t('64GB 内存策略 · 不并发双引擎')}</div>
                </div>
                <span
                  className={`sw${sw['queue.exclusive'] ? ' on' : ''}`}
                  data-sw=""
                  onClick={() => toggleSw('queue.exclusive')}
                />
              </div>
              <div className="srow">
                <div className="grow">
                  <b>{t('预览档优先插队')}</b>
                  <div className="sub mono">{t('需用户确认后执行')}</div>
                </div>
                <span
                  className={`sw${sw['queue.previewJump'] ? ' on' : ''}`}
                  data-sw=""
                  onClick={() => toggleSw('queue.previewJump')}
                />
              </div>
              <div className="srow">
                <div className="grow">
                  <b>{t('首次 Metal 预热提示')}</b>
                  <div className="sub mono">{t('约 30 分钟 · 档位防呆白名单已启用')}</div>
                </div>
                <span className="badge ok">{t('已提示')}</span>
              </div>
            </div>

            {/* 存储与项目 */}
            <div
              className="group"
              data-group="storage"
              data-od-id="settings-storage"
              hidden={group !== 'storage'}
            >
              <div className="gh">
                <b>{t('存储与项目')}</b>
              </div>
              <div className="srow">
                <div className="grow">
                  <b>{t('数据目录')}</b>
                  <div className="sub mono">{t('~/.bigbotart · SQLite（node:sqlite）+ 本地媒体目录')}</div>
                </div>
                <button className="btn btn-s btn-sm">{t('更改…')}</button>
              </div>
              <div className="srow">
                <div className="grow">
                  <b>{t('项目锁')}</b>
                  <div className="sub mono">{t('多标签页并发锁（参考 H3Mise）')}</div>
                </div>
                <span
                  className={`sw${sw['storage.projectLock'] ? ' on' : ''}`}
                  data-sw=""
                  onClick={() => toggleSw('storage.projectLock')}
                />
              </div>
              <div className="srow">
                <div className="grow">
                  <b>{t('画布 JSON 导出 / 导入')}</b>
                  <div className="sub mono">{t('可复现：每个 Take 记录完整参数 + seed + 引擎版本')}</div>
                </div>
                <button className="btn btn-s btn-sm">{t('导出')}</button>
              </div>
            </div>

            {/* 模型下载 */}
            <div
              className="group"
              data-group="models"
              data-od-id="settings-models"
              hidden={group !== 'models'}
            >
              <div className="gh">
                <b>{t('模型下载')}</b>
                <span className="spacer" />
                <span className="mono mut" style={{ fontSize: 11 }}>
                  {t('按需下载 · 断点续传')}
                </span>
              </div>
              <div className="mdl-row">
                <div className="grow">
                  <b>Ornith-1.5-35B-A3B · MLX 4bit</b>
                  <div className="sub mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {t('LLM · 推荐')}
                  </div>
                </div>
                <span className="badge ok">{t('已就绪')}</span>
              </div>
              {(['z-image-turbo', ...MODEL_IDS] as const).map((id) => {
                // 模型大小按 HF 官方文件清单实测(2026-09,hf-mirror tree 汇总 / ModelScope 直连清单):
                //   z-image-turbo-8bit 10.99GB · Qwen-Image-2.1-bf16 ~33GB · qwen-image-edit-8bit 37.5GB · flux.2-klein-9b-8bit ~18GB · seedvr2-3b-8bit 4.72GB · qwen2.5-vl-7b 16.6GB
                const meta: Record<'z-image-turbo' | (typeof MODEL_IDS)[number], { name: string; desc: string }> = {
                  'z-image-turbo': { name: 'Z-Image-Turbo', desc: t('文生图 · 推荐 · ~11GB') },
                  'qwen-image-2.1': { name: 'Qwen-Image-2.1 (bf16 全量)', desc: t('文生图 / 参考编辑 1-10 张 · ~33GB') },
                  'qwen-image-edit': { name: 'Qwen Image Edit', desc: t('指令编辑 / Inpaint · 推荐 · 37.5GB') },
                  'flux2-klein-9b': { name: 'FLUX.2 Klein 9B', desc: t('多参考生成/编辑 · Outpaint · ~18GB') },
                  'seedvr2-3b': { name: 'SeedVR2 3B', desc: t('超分修复 · 可选 · ~4.7GB') },
                  'qwen2.5-vl': { name: 'Qwen2.5-VL', desc: t('视觉 LLM · Agent 识图 · 可选 · ~16.6GB') },
                };
                const m = meta[id];
                const dl = downloads[id] ?? { status: 'idle' as const, pct: 0 };
                const ready = mlxReady[id] === true;
                return (
                  <div className="mdl-row" key={id}>
                    <div className="grow">
                      <b>{m.name}</b>
                      <div className="sub mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                        {m.desc}
                      </div>
                      {dl.status === 'failed' && (
                        <div className="mut" style={{ fontSize: 11, color: 'var(--danger)' }}>
                          {dl.error ?? t('下载失败')}
                        </div>
                      )}
                    </div>
                    {ready ? (
                      <span className="badge ok">{t('已就绪')}</span>
                    ) : dl.status === 'idle' ? (
                      <button className="btn btn-s btn-sm" data-dl="" onClick={() => startDownload(id)}>
                        {t('下载')}
                      </button>
                    ) : dl.status === 'downloading' ? (
                      <div style={{ minWidth: 130 }}>
                        <div className="row" style={{ justifyContent: 'space-between', fontSize: 10.5 }}>
                          <span className="mut">{t('下载中')}</span>
                          <span className="mono mut pct">{Math.round(dl.pct ?? 0)}%</span>
                        </div>
                        <div className="pbar" style={{ marginTop: 4 }}>
                          <i style={{ width: `${dl.pct ?? 0}%` }} />
                        </div>
                        <button
                          className="btn btn-s btn-sm"
                          type="button"
                          data-cancel-dl={id}
                          style={{ marginTop: 6 }}
                          onClick={() => cancelDownload(id, dl.jobId)}
                        >
                          {t('取消下载')}
                        </button>
                      </div>
                    ) : dl.status === 'cancelled' ? (
                      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                        <span className="badge" title={dl.error}>{t('已取消')}</span>
                        <button className="btn btn-s btn-sm" data-dl="" onClick={() => startDownload(id)}>
                          {t('重新下载')}
                        </button>
                      </div>
                    ) : (
                      <span className="badge">{dl.error ? t('下载出错') : t('未下载')}</span>
                    )}
                  </div>
                );
              })}
              <div className="mdl-row">
                <div className="grow mut">{t('更多：GLM-4 / DeepSeek / Llama 3.x / Mistral / Phi / Gemma 3 / MiniCPM…（§5.2.4 清单）')}</div>
              </div>
            </div>

            {/* 🚀 加速 LoRA(蒸馏模型包):h3.c 不接受 --lora,加速 = 蒸馏目录(-d)+ 4/8 步 */}
            <div className="group" data-group="lora" data-od-id="settings-lora" hidden={group !== 'lora'}>
              <div className="gh">
                <b>{t('🚀 加速 LoRA')}</b>
                <span className="spacer" />
                <span className="mono mut" style={{ fontSize: 11 }}>
                  {t('蒸馏模型包 · h3.c -d 加速目录(非 .safetensors)')}
                </span>
              </div>
              <div className="srow">
                <div className="grow">
                  <b>{t('蒸馏模型包管理')}</b>
                  <div className="sub">
                    {t('镜头开启「加速 LoRA」时 -d 换用所选包目录 + 4/8 步 · 默认包在镜头未选包时兜底(手册 §8)')}
                  </div>
                </div>
                <span className="badge ok">
                  {t('{a}/{b} 就绪', { a: accelPacks.filter((p) => p.exists).length, b: accelPacks.length })}
                </span>
              </div>
              {accelPacks.length === 0 ? (
                <div className="srow">
                  <div className="grow mut">{t('还没有模型包 · 在下方安装(如手册 §1.2 的 MiniMax-H3-turbo-T8test 目录)')}</div>
                </div>
              ) : (
                accelPacks.map((p) => (
                  <div className="mdl-row" key={p.id}>
                    <div className="grow">
                      <b>
                        {p.name}
                        {p.default ? t(' · 默认') : ''}
                      </b>
                      <div className="sub mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                        {p.path} · {t('推荐 {n} 步', { n: p.steps ?? 8 })}
                      </div>
                    </div>
                    {p.exists ? (
                      <span className="badge ok">{t('就绪')}</span>
                    ) : (
                      <span className="badge err">{t('目录缺失')}</span>
                    )}
                    {!p.default && (
                      <button className="btn btn-s btn-sm" onClick={() => setDefaultAccel(p.id)}>
                        {t('设默认')}
                      </button>
                    )}
                    <button className="btn btn-s btn-sm" onClick={() => removeAccel(p.id)}>
                      {t('删除')}
                    </button>
                  </div>
                ))
              )}
              <div className="srow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                <b>{t('安装模型包')}</b>
                <div className="row g8" style={{ flexWrap: 'wrap' }}>
                  <span className="input-w">
                    <input
                      placeholder={t('名称,如 MiniMax-H3-turbo-T8test')}
                      value={accelForm.name}
                      onChange={(e) => setAccelForm((f) => ({ ...f, name: e.target.value }))}
                    />
                  </span>
                  <span className="input-w">
                    <input
                      className="mono"
                      placeholder="/path/to/turbo-model-dir"
                      value={accelForm.path}
                      onChange={(e) => setAccelForm((f) => ({ ...f, path: e.target.value }))}
                    />
                  </span>
                  <span className="mut" style={{ fontSize: 11, alignSelf: 'center' }}>{t('推荐步数')}</span>
                  {([4, 8] as const).map((s) => (
                    <span
                      key={s}
                      className={`chip${accelForm.steps === s ? ' on' : ''}`}
                      onClick={() => setAccelForm((f) => ({ ...f, steps: s }))}
                    >
                      {t('{n} 步', { n: s })}
                    </span>
                  ))}
                  <button className="btn btn-p btn-sm" onClick={installAccel}>
                    {t('安装')}
                  </button>
                </div>
                {accelMsg ? (
                  <div className="mut" style={{ fontSize: 11 }}>
                    {accelMsg}
                  </div>
                ) : (
                  <div className="mut" style={{ fontSize: 11 }}>
                    {t('目录须存在且含 FL2VA/(turbo 目录结构);登记不拷贝文件,删除只注销不删磁盘 · h3.c 不接受 --lora, 此为蒸馏模型包加速(手册 §8)')}
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>
        </div>
      </div>
    </div>
  );
}