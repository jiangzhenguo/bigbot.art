import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuntimeProbe, SelfCheckItem } from '@bigbotart/shared';

interface OnboardingPageProps {
  onNavigate: (
    page: 'home' | 'canvas' | 'assets' | 'skills' | 'timeline' | 'settings' | 'onboarding' | 'projects',
  ) => void;
}

/** 图片模型展示元数据(与主进程 KNOWN_MODELS 同口径;id 即下载标识) */
const IMAGE_MODELS: Array<{ id: string; name: string; desc: string; recommended?: boolean }> = [
  { id: 'z-image-turbo', name: 'Z-Image-Turbo', desc: '文生图 · ~11GB', recommended: true },
  { id: 'qwen-image-2.1', name: 'Qwen-Image-2.1', desc: '文生图 / 参考编辑 · 7.1B · ~33GB' },
  { id: 'qwen-image-edit', name: 'Qwen Image Edit', desc: '指令编辑 / Inpaint · 37.5GB' },
  { id: 'flux2-klein-9b', name: 'FLUX.2 Klein 9B', desc: '多参考生成/编辑 · Outpain ~18GB' },
  { id: 'seedvr2-3b', name: 'SeedVR2 3B', desc: '超分修复 · ~4.7GB' },
  { id: 'qwen2.5-vl', name: 'Qwen2.5-VL', desc: '视觉 LLM · Agent 识图 · ~16.6GB' },
];

/** 自检项占位(运行前展示「待检测」;真实结果由主进程返回,见 selfcheck.ts) */
const CHECK_ITEMS: Array<{ id: SelfCheckItem['id']; label: string }> = [
  { id: 'h3c', label: 'h3.c 视频引擎(二进制 + 模型 checkpoint)' },
  { id: 'mlxgen', label: 'mlxgen 图片引擎(CLI + 已下载模型)' },
  { id: 'llm', label: 'LLM 工具调用回环(端点 + tools 支持)' },
  { id: 'storage', label: '数据目录可写与渲染队列' },
];

/** 非 mlxgen 的模型:本应用无下载通道,明确标注手动(不假装能一键下) */
const MANUAL_MODELS: Array<{ name: string; desc: string; how: string }> = [
  {
    name: 'MiniMax-H3 视频模型组',
    desc: '文生视频 + 带声直出 · 144GB',
    how: '手动下载(本应用不代下)· 见 docs/MiniMax-H3-加速-LoRA-使用手册.md',
  },
  {
    name: 'Ornith-1.5-35B-A3B · MLX 4bit',
    desc: 'LLM · Agent 内核 · 19.4GB',
    how: '在 LM Studio 内下载(本应用不代下)',
  },
];

/**
 * 引擎引导向导 — 1:1 还原 OpenDesign 设计稿 onboarding.html
 * 根元素固定为 .pg-onboarding(样式在 design-pages.css,规则带 .pg-onboarding 前缀)
 * 交互参照 onboarding.js,引擎检测/安装接入 window.bigbotart 真实 IPC。
 */
export default function OnboardingPage({ onNavigate }: OnboardingPageProps) {
  const [cur, setCur] = useState(0);
  const [detectDone, setDetectDone] = useState(false);
  const [probes, setProbes] = useState<RuntimeProbe[]>([]);
  const [lms, setLms] = useState<{
    state: 'idle' | 'busy' | 'done';
    message: string;
  }>({ state: 'idle', message: '未安装 · 用于本地 LLM(Agent 内核)' });
  const [mgen, setMgen] = useState<{
    state: 'idle' | 'busy' | 'done';
    message: string;
  }>({ state: 'idle', message: '未安装 · pip 包(uv tool install)' });
  const [consent, setConsent] = useState(true);
  /** 模型 id → 进度(undefined=未开始,-1=失败,0..100=进行中/完成) */
  const [owns, setOwns] = useState<Record<string, number>>({});
  /** 模型 id → 主进程已知下载状态(挂载时回填,含本地直用目录命中的「已就绪」) */
  const [modelReady, setModelReady] = useState<Record<string, boolean>>({});
  const [checkHint, setCheckHint] = useState('点击「开始自检」');
  const [checking, setChecking] = useState(false);
  /** 自检真实结果(主进程 runSelfCheck 返回;null=尚未运行) */
  const [checks, setChecks] = useState<SelfCheckItem[] | null>(null);
  const [checkedAll, setCheckedAll] = useState(false);
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const dlTimersRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  };
  useEffect(() => clearTimers, []);
  useEffect(
    () => () => {
      Object.values(dlTimersRef.current).forEach(clearInterval);
    },
    [],
  );

  /* 挂载时回填全部图片模型的真实下载状态(本地直用目录命中也算已就绪) */
  useEffect(() => {
    let cancelled = false;
    const refreshModels = () =>
      window.bigbotart
        .mlxgenModels()
        .then((list) => {
          if (cancelled) return;
          const map: Record<string, boolean> = {};
          for (const m of list) map[m.id] = m.downloaded;
          setModelReady(map);
          // 已就绪的模型直接显示 100%(避免「已就绪」与进度条状态打架)
          setOwns((o) => {
            const next = { ...o };
            for (const m of list) if (m.downloaded && next[m.id] == null) next[m.id] = 100;
            return next;
          });
        })
        .catch(() => {});
    void refreshModels();
    /* 进入页面时恢复主进程仍在进行的下载任务(此前轮询只存在于组件 state) */
    void window.bigbotart
      .mlxgenDownloadActive()
      .then((active) => {
        if (cancelled) return;
        for (const a of active) startPolling(a.id, a.jobId, a.pct ?? 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // startPolling 为稳定回调(useCallback 无依赖),不随渲染变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = useCallback((i: number) => {
    clearTimers();
    setCur(Math.max(0, Math.min(3, i)));
  }, []);

  /* ── 步骤 1:环境探测(真实探测 + 设计稿渐进动画)── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let real: RuntimeProbe[] = [];
      try {
        real = await window.bigbotart.probeRuntimes();
      } catch {
        /* IPC 不可达时保持空列表,走设计稿默认文案 */
      }
      if (cancelled) return;
      setProbes(real);
      timersRef.current.push(
        setTimeout(() => {
          if (cancelled) return;
          setDetectDone(true);
        }, 700 + 4 * 650),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const probeRow = (
    state: 'ok' | 'warn' | 'err',
    name: string,
    text: string,
  ): JSX.Element => (
    <>
      {state === 'ok' ? (
        <span className="dot ok" />
      ) : state === 'warn' ? (
        <span className="dot" />
      ) : (
        <span className="dot err" />
      )}
      <div className="grow">
        <b>{name}</b>
        <div className="mut mono" style={{ fontSize: 11 }}>
          {text}
        </div>
      </div>
      {state === 'ok' ? (
        <span className="badge ok">已就绪</span>
      ) : state === 'warn' ? (
        <span className="badge warn">可配置</span>
      ) : (
        <span className="badge err">未就绪</span>
      )}
    </>
  );

  /* 运行时条目(接入真实探测结果) */
  const runtimeRows = [
    { key: 'h3c', name: 'h3.c 视频引擎', loading: '查找二进制与模型目录…' },
    { key: 'mlxgen', name: 'mlxgen 图片引擎', loading: '查找已下载模型…' },
    { key: 'lmstudio', name: 'LM Studio', loading: '探测 127.0.0.1:1234…' },
  ];

  const runtimeReady = (key: string): boolean =>
    probes.find((p) => p.id === key)?.status === 'ready';

  const runtimeReadyCount = runtimeRows.filter((r) => runtimeReady(r.key)).length;

  function DetectRow(props: {
    name: string;
    text: string;
    state?: 'ok' | 'warn' | 'err' | 'spin';
  }): JSX.Element {
    const { name, text, state = 'spin' } = props;
    return (
      <div className="d-row" data-d>
        {state === 'spin' ? (
          <>
            <span className="spin" />
            <div className="grow">
              <b>{name}</b>
              <div className="mut mono" style={{ fontSize: 11 }}>
                {text}
              </div>
            </div>
          </>
        ) : (
          probeRow(state, name, text)
        )}
      </div>
    );
  }

  /* 探测完成后用真实 probe 渲染单行(无 probe 时回到 spinning 行) */
  const detectRowForProbe = (
    key: string,
    name: string,
    loading: string,
  ): JSX.Element => {
    const probe = probes.find((p) => p.id === key);
    // key 必须挂在实际返回的根节点上(map 里调用时外面套不了 key,否则 React 报重复 key)
    if (!probe) return <DetectRow key={key} name={name} text={loading} />;
    const txt = [probe.version, probe.path, probe.detail].filter(Boolean).join(' · ');
    let st: 'ok' | 'warn' | 'err';
    if (probe.status === 'ready') st = 'ok';
    else if (probe.status === 'error') st = 'err';
    else st = 'warn';
    return <DetectRow key={key} name={name} text={txt || '未检测到'} state={st} />;
  };

  /* ── 步骤 2:LM Studio 安装(接入 installRuntime)── */
  const handleLmsInstall = async () => {
    if (lms.state !== 'idle') return;
    setLms({ state: 'busy', message: '安装中…' });
    let res: { ok: boolean; message: string } | null = null;
    try {
      res = await window.bigbotart.installRuntime('lmstudio');
    } catch {
      res = null;
    }
    timersRef.current.push(
      setTimeout(() => {
        setLms({
          state: 'done',
          message:
            res && res.ok
              ? '已安装 · 服务运行于 127.0.0.1:1234'
              : (res?.message ?? '安装失败 · 请手动安装 LM Studio'),
        });
      }, 2200),
    );
  };

  /* ── 步骤 2:mlxgen 安装(install-runtime 真实执行 uv tool install)── */
  const handleMgenInstall = async () => {
    if (mgen.state === 'busy') return;
    setMgen({ state: 'busy', message: '安装中…(uv tool install mlx-gen,可能数分钟)' });
    let res: { ok: boolean; message: string } | null = null;
    try {
      res = await window.bigbotart.installRuntime('mlxgen');
    } catch {
      res = null;
    }
    if (res?.ok) {
      setMgen({ state: 'done', message: '已安装 · pip 包' });
      try {
        setProbes(await window.bigbotart.probeRuntimes());
      } catch {
        /* 忽略探测失败 */
      }
    } else {
      setMgen({ state: 'idle', message: res?.message ?? '安装失败 · 请手动执行 uv tool install --upgrade mlx-gen' });
    }
  };

  /* ── 步骤 3:模型下载(mlxgen 通道真实执行;进度轮询)── */

  /** 轮询单个下载任务直到终态(挂载恢复与新建任务共用) */
  const startPolling = useCallback((id: string, jobId: string, initialPct: number) => {
    // 同一模型不重复起轮询(挂载恢复 + 用户点击可能撞车)
    if (dlTimersRef.current[id]) return;
    setOwns((o) => ({ ...o, [id]: initialPct }));
    const t = setInterval(() => {
      void window.bigbotart
        .mlxgenDownloadStatus(jobId)
        .then((st) => {
          if (st.status === 'running') {
            setOwns((o) => ({ ...o, [id]: Math.round(st.pct ?? 0) }));
            return;
          }
          clearInterval(t);
          delete dlTimersRef.current[id];
          if (st.status === 'done') {
            setOwns((o) => ({ ...o, [id]: 100 }));
            setModelReady((m) => ({ ...m, [id]: true }));
            void window.bigbotart.probeRuntimes().then(setProbes).catch(() => {});
          } else {
            setOwns((o) => ({ ...o, [id]: -1 }));
          }
        })
        .catch(() => {});
    }, 700);
    dlTimersRef.current[id] = t;
  }, []);

  /** 下载指定模型:repoId 由主进程白名单校验(id→repo 映射在主进程,渲染层只传 id 对应的 repo) */
  const handleDownload = useCallback(
    (id: string, repoId: string) => {
      if (owns[id] != null || modelReady[id]) return;
      setOwns((o) => ({ ...o, [id]: 0 }));
      void window.bigbotart
        .mlxgenDownload(repoId)
        .then((res) => {
          if (!res.ok || !res.jobId) {
            setOwns((o) => ({ ...o, [id]: -1 }));
            return;
          }
          startPolling(id, res.jobId, 0);
        })
        .catch(() => setOwns((o) => ({ ...o, [id]: -1 })));
    },
    [owns, modelReady, startPolling],
  );

  /* ── 步骤 4:自检(主进程真实探测:不再是无条件打勾的动画)── */
  const handleSelfcheck = async () => {
    if (checking || checkedAll) return;
    setChecking(true);
    setCheckHint('自检中…(真实探测引擎,不加载大模型)');
    try {
      const report = await window.bigbotart.runSelfCheck();
      setChecks(report.items);
      setCheckedAll(true);
      setCheckHint(
        report.passed === report.total
          ? `全部通过(${report.passed}/${report.total})`
          : `${report.passed}/${report.total} 项通过 · 失败的项可按提示修复后重试`,
      );
    } catch (e) {
      setChecks([
        {
          id: 'storage',
          label: '自检执行失败',
          ok: false,
          detail: (e as Error).message,
          hint: '见主进程日志',
          ms: 0,
        },
      ]);
      setCheckHint('自检执行失败 · 见主进程日志');
    } finally {
      setChecking(false);
    }
  };

  /** 重跑自检(失败的项修复后) */
  const handleRecheck = () => {
    setCheckedAll(false);
    setChecks(null);
    void handleSelfcheck();
  };

  const railSteps = [
    { n: '环境探测', s: '硬件 / 运行时 / 已装引擎' },
    { n: '安装组件', s: 'h3.c · mlxgen · LM Studio' },
    { n: '下载模型', s: '按需下载 · 可跳过' },
    { n: '自检', s: '冒烟测试 · 进入工作台' },
  ];

  return (
    <div className="pg-onboarding">
      <div className="wiz" data-od-id="onboarding">
        {/* 步骤轨 */}
        <div className="rail">
          <div className="rail-brand">
            <span className="mk">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <rect x="3" y="3" width="8" height="8" rx="2" />
                <rect x="13" y="13" width="8" height="8" rx="2" />
                <path d="M11 8h6a4 4 0 0 1 4 4v1" opacity=".65" />
              </svg>
            </span>
            BigBotArt
          </div>
          {railSteps.map((s, i) => (
            <div
              key={i}
              className={`step${cur === i ? ' on' : ''}${cur > i ? ' done' : ''}`}
              data-step={i}
            >
              <span className="n">{cur > i ? '✓' : i + 1}</span>
              <div>
                <b>{s.n}</b>
                <span>{s.s}</span>
              </div>
            </div>
          ))}
          <div className="rail-foot">本地优先:所有组件与模型均安装在本机,不自动上传任何数据。</div>
        </div>

        {/* 内容 */}
        <div className="body">
          {/* 1 探测 */}
          <section className={`pane${cur === 0 ? ' on' : ''}`} data-pane="0" data-od-id="ob-step-detect">
            <h1>正在探测你的环境</h1>
            <p className="sub">检测硬件、运行时与已安装的引擎组件,给出可配置建议。</p>
            <div id="detectList">
              {!detectDone ? (
                <>
                  <DetectRow name="硬件" text="检测芯片与内存…" />
                  <DetectRow name="运行时" text="Node / Python / FFmpeg…" />
                  {runtimeRows.map((r) => (
                    <DetectRow key={r.key} name={r.name} text={r.loading} />
                  ))}
                </>
              ) : (
                <>
                  <DetectRow name="硬件" text="Apple 芯片 · 统一内存" state="ok" />
                  <DetectRow name="运行时" text="Node / Python / FFmpeg" state="ok" />
                  {runtimeRows.map((r) => detectRowForProbe(r.key, r.name, r.loading))}
                </>
              )}
            </div>
            <div className="foot">
              <span className="mut" style={{ fontSize: 'var(--text-xs)' }} id="detectHint">
                {detectDone
                  ? `探测完成:${runtimeReadyCount} 项已就绪,${runtimeRows.length - runtimeReadyCount} 项可配置(LM Studio 将在下一步安装)`
                  : '探测中…'}
              </span>
              <span className="spacer" />
              <a
                className="btn btn-s"
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate('home');
                }}
              >
                跳过向导
              </a>
              <button
                className="btn btn-p"
                id="next0"
                data-od-id="ob-next"
                disabled={!detectDone}
                onClick={() => go(1)}
              >
                继续
              </button>
            </div>
          </section>

          {/* 2 安装 */}
          <section className={`pane${cur === 1 ? ' on' : ''}`} data-pane="1" data-od-id="ob-step-install">
            <h1>安装组件</h1>
            <p className="sub">仅安装缺失项;已就绪的组件自动跳过。</p>
            <div className="d-row">
              <span className="dot ok" />
              <div className="grow">
                <b>h3.c</b>
                <div className="mut mono" style={{ fontSize: 11 }}>
                  {runtimeReady('h3c')
                    ? `已就绪 · ${probes.find((p) => p.id === 'h3c')?.path ?? '本地部署'}`
                    : '未安装 · 本地部署(h3-metal)'}
                </div>
              </div>
              <span className="badge ok">{runtimeReady('h3c') ? '已就绪' : '可安装'}</span>
            </div>
            <div className="d-row">
              <span className={runtimeReady('mlxgen') ? 'dot ok' : 'dot'} />
              <div className="grow">
                <b>mlxgen</b>
                <div className="mut mono" style={{ fontSize: 11 }}>
                  {runtimeReady('mlxgen')
                    ? '已就绪 · pip 包'
                    : mgen.state === 'busy'
                      ? mgen.message
                      : mgen.message}
                </div>
              </div>
              {runtimeReady('mlxgen') || mgen.state === 'done' ? (
                <span className="badge ok">已就绪</span>
              ) : mgen.state === 'busy' ? (
                <span className="badge">安装中…</span>
              ) : (
                <button
                  className="btn btn-s"
                  id="mgenInstall"
                  style={{ padding: '7px 14px', fontSize: 'var(--text-xs)' }}
                  onClick={handleMgenInstall}
                >
                  安装
                </button>
              )}
            </div>
            <div className="d-row" id="lmsRow">
              <span className={lms.state === 'done' ? 'dot ok' : lms.state === 'busy' ? 'spin' : 'dot'} />
              <div className="grow">
                <b>LM Studio</b>
                <div className="mut mono" style={{ fontSize: 11 }}>
                  {lms.message}
                </div>
              </div>
              {lms.state === 'idle' ? (
                <button
                  className="btn btn-s"
                  id="lmsInstall"
                  style={{ padding: '7px 14px', fontSize: 'var(--text-xs)' }}
                  onClick={handleLmsInstall}
                >
                  安装
                </button>
              ) : lms.state === 'busy' ? (
                <span className="badge">安装中…</span>
              ) : (
                <span className="badge ok">已就绪</span>
              )}
            </div>
            <div className="consent">
              <input
                type="checkbox"
                id="consent"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <label htmlFor="consent">
                允许 BigBotArt 在本机安装上述组件并写入模型目录(~/models)。安装过程需要管理员授权,且不会上传任何个人数据。
              </label>
            </div>
            <div className="foot">
              <button className="btn btn-s" data-back onClick={() => go(0)}>
                上一步
              </button>
              <span className="spacer" />
              <button
                className="btn btn-p"
                data-next
                disabled={!consent}
                onClick={() => go(2)}
              >
                继续
              </button>
            </div>
          </section>

          {/* 3 下载 */}
          <section className={`pane${cur === 2 ? ' on' : ''}`} data-pane="2" data-od-id="ob-step-download">
            <h1>下载模型</h1>
            <p className="sub">
              图片模型支持应用内下载(断点续传);视频与 LLM 模型需手动获取,已明确标注。
            </p>
            <div className="mut" style={{ fontSize: 'var(--text-xs)', margin: '2px 0 6px' }}>
              图片引擎模型({IMAGE_MODELS.length} 个 · 至少装 1 个即可用)
            </div>
            {IMAGE_MODELS.map((m) => {
              const p = owns[m.id];
              const ready = modelReady[m.id] === true || p === 100;
              return (
                <div className="d-row" key={m.id} data-model={m.id}>
                  <div className="grow">
                    <b>
                      {m.name}
                      {m.recommended && (
                        <span className="badge" style={{ marginLeft: 6 }}>
                          推荐
                        </span>
                      )}
                    </b>
                    <div className="mut mono" style={{ fontSize: 11 }}>
                      {m.desc}
                    </div>
                  </div>
                  {ready ? (
                    <span className="badge ok">已就绪</span>
                  ) : p == null ? (
                    <button
                      className="btn btn-s"
                      data-dl={m.id}
                      style={{ padding: '7px 14px', fontSize: 'var(--text-xs)' }}
                      onClick={() =>
                        handleDownload(
                          m.id,
                          // repoId 与主进程白名单同口径(mlxgen-models.ts KNOWN_MODELS)
                          {
                            'z-image-turbo': 'AbstractFramework/z-image-turbo-8bit',
                            'qwen-image-2.1': 'Qwen/Qwen-Image-2.1',
                            'qwen-image-edit': 'mlx-community/Qwen-Image-Edit-8bit',
                            'flux2-klein-9b': 'AbstractFramework/flux.2-klein-9b-8bit',
                            'seedvr2-3b': 'AbstractFramework/seedvr2-3b-8bit',
                            'qwen2.5-vl': 'Qwen/Qwen2.5-VL-7B-Instruct',
                          }[m.id] ?? m.id,
                        )
                      }
                    >
                      下载
                    </button>
                  ) : p < 0 ? (
                    <span className="badge err">下载失败 · 见主进程日志</span>
                  ) : (
                    <div style={{ minWidth: 140 }}>
                      <div
                        className="row"
                        style={{ justifyContent: 'space-between', fontSize: 10.5 }}
                      >
                        <span className="mut">下载中</span>
                        <span className="mono mut pct">{Math.round(p)}%</span>
                      </div>
                      <div className="pbar" style={{ marginTop: 4 }}>
                        <i style={{ width: `${p}%` }} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="mut" style={{ fontSize: 'var(--text-xs)', margin: '10px 0 6px' }}>
              需手动获取(本应用不代下)
            </div>
            {MANUAL_MODELS.map((m) => (
              <div className="d-row" key={m.name}>
                <div className="grow">
                  <b style={{ color: 'var(--fg-2)' }}>{m.name}</b>
                  <div className="mono" style={{ fontSize: 11 }}>
                    {m.desc} · {m.how}
                  </div>
                </div>
                <span className="badge">手动</span>
              </div>
            ))}
            <div className="foot">
              <button className="btn btn-s" data-back onClick={() => go(1)}>
                上一步
              </button>
              <span className="spacer" />
              <button className="btn btn-s" data-next onClick={() => go(3)}>
                跳过
              </button>
              <button className="btn btn-p" data-next onClick={() => go(3)}>
                继续
              </button>
            </div>
          </section>

          {/* 4 自检 */}
          <section className={`pane${cur === 3 ? ' on' : ''}`} data-pane="3" data-od-id="ob-step-check">
            <h1>自检</h1>
            <p className="sub">
              真实探测每个引擎是否可用(轻量检查,不加载大模型、不触发真实推理)。
            </p>
            <div id="checkList">
              {checks == null
                ? CHECK_ITEMS.map((txt) => (
                    <div className="check" data-c key={txt.id}>
                      <span className="ck">{checking ? <span className="spin" /> : '·'}</span>
                      <div className="grow">{txt.label}</div>
                      <span className="mono mut" style={{ fontSize: 11 }} />
                    </div>
                  ))
                : checks.map((c) => (
                    <div className="check" data-c data-check={c.id} key={c.id}>
                      <span className={`ck${c.ok ? ' ok' : ' err'}`}>{c.ok ? '✓' : '×'}</span>
                      <div className="grow">
                        <b>{c.label}</b>
                        <div className="mut" style={{ fontSize: 11, lineHeight: 1.5 }}>
                          {c.detail}
                        </div>
                        {!c.ok && c.hint && (
                          <div style={{ fontSize: 11, color: 'var(--danger)', lineHeight: 1.5 }}>
                            → {c.hint}
                          </div>
                        )}
                      </div>
                      <span className="mono mut" style={{ fontSize: 11 }}>
                        {c.ms >= 1000 ? `${(c.ms / 1000).toFixed(1)}s` : `${c.ms}ms`}
                      </span>
                    </div>
                  ))}
            </div>
            <div className="foot">
              <button className="btn btn-s" data-back onClick={() => go(2)}>
                上一步
              </button>
              <span className="mut" style={{ fontSize: 'var(--text-xs)' }} id="checkHint">
                {checkHint}
              </span>
              <span className="spacer" />
              {checkedAll ? (
                <button className="btn btn-s" data-od-id="ob-recheck" onClick={handleRecheck}>
                  重新自检
                </button>
              ) : (
                <button
                  className="btn btn-p"
                  id="selfcheck"
                  data-od-id="ob-selfcheck"
                  disabled={checking}
                  onClick={() => void handleSelfcheck()}
                >
                  {checking ? '自检中…' : '开始自检'}
                </button>
              )}
              {checkedAll && (
                <button
                  className="btn btn-p"
                  id="enterBtn"
                  data-od-id="ob-enter"
                  onClick={() => onNavigate('home')}
                >
                  进入画布工作台 →
                </button>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}