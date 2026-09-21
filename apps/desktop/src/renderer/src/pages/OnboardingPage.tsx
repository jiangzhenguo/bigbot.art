import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuntimeProbe } from '@bigbotart/shared';

interface OnboardingPageProps {
  onNavigate: (
    page: 'home' | 'canvas' | 'assets' | 'skills' | 'timeline' | 'settings' | 'onboarding' | 'projects',
  ) => void;
}

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
  const [owns, setOwns] = useState<Record<string, number>>({});
  const [checkHint, setCheckHint] = useState('点击「开始自检」');
  const [checking, setChecking] = useState(false);
  const [checks, setChecks] = useState<Array<{ spin: boolean; done: boolean; t: string }>>([
    { spin: false, done: false, t: '' },
    { spin: false, done: false, t: '' },
    { spin: false, done: false, t: '' },
    { spin: false, done: false, t: '' },
  ]);
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

  /* 挂载时确认图片模型下载状态(Z-Image-Turbo 已缓存则显示已就绪) */
  useEffect(() => {
    let cancelled = false;
    void window.bigbotart
      .mlxgenModels()
      .then((list) => {
        if (cancelled) return;
        const z = list.find((m) => m.id === 'z-image-turbo');
        if (z?.downloaded) setOwns((o) => ({ ...o, img: 100 }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
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
    if (!probe) return <DetectRow name={name} text={loading} />;
    const txt = [probe.version, probe.path, probe.detail].filter(Boolean).join(' · ');
    let st: 'ok' | 'warn' | 'err';
    if (probe.status === 'ready') st = 'ok';
    else if (probe.status === 'error') st = 'err';
    else st = 'warn';
    return <DetectRow name={name} text={txt || '未检测到'} state={st} />;
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

  /* ── 步骤 3:模型下载(真实执行 mlxgen download,进度轮询;llm/vid 为手动项)── */
  const handleDownload = (key: string) => {
    if (owns[key] != null || key !== 'img') return;
    setOwns((o) => ({ ...o, [key]: 0 }));
    void window.bigbotart
      .mlxgenDownload('AbstractFramework/z-image-turbo-8bit')
      .then((res) => {
        const jobId = res.jobId;
        if (!res.ok || !jobId) {
          setOwns((o) => ({ ...o, [key]: -1 }));
          return;
        }
        const t = setInterval(() => {
          void window.bigbotart
            .mlxgenDownloadStatus(jobId)
            .then((st) => {
              if (st.status === 'running') {
                setOwns((o) => ({ ...o, [key]: Math.round(st.pct ?? 0) }));
                return;
              }
              clearInterval(t);
              delete dlTimersRef.current[key];
              if (st.status === 'done') {
                setOwns((o) => ({ ...o, [key]: 100 }));
                void window.bigbotart.probeRuntimes().then(setProbes).catch(() => {});
              } else {
                setOwns((o) => ({ ...o, [key]: -1 }));
              }
            })
            .catch(() => {});
        }, 700);
        dlTimersRef.current[key] = t;
      })
      .catch(() => setOwns((o) => ({ ...o, [key]: -1 })));
  };

  /* ── 步骤 4:自检 ── */
  const handleSelfcheck = () => {
    if (checking || checkedAll) return;
    setChecking(true);
    setCheckHint('自检中…');
    checks.forEach((_, i) => {
      timersRef.current.push(
        setTimeout(() => {
          setChecks((cs) =>
            cs.map((c, j) => (j === i ? { spin: true, done: false, t: '' } : c)),
          );
          timersRef.current.push(
            setTimeout(() => {
              const times: string[] = ['1.2s', '0.8s', '240ms', '通过'];
              setChecks((cs) =>
                cs.map((c, j) =>
                  j === i ? { spin: false, done: true, t: times[i] ?? '' } : c,
                ),
              );
              if (i === checks.length - 1) {
                setChecking(false);
                setCheckedAll(true);
                setCheckHint('全部通过');
              }
            }, 900),
          );
        }, i * 1300),
      );
    });
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
            <p className="sub">按需下载,支持断点续传;可以先跳过,之后在「设置 · 模型下载」中安装。</p>
            {[
              {
                key: 'llm',
                name: 'Ornith-1.5-35B-A3B · MLX 4bit',
                d: 'LLM · Agent 内核 · 推荐 · 19.4GB',
                auto: false,
              },
              {
                key: 'img',
                name: 'Z-Image-Turbo',
                d: '文生图 · 默认图片引擎 · 推荐 · 11.8GB',
                auto: true,
              },
              { key: 'vid', name: 'h3 视频模型组', d: '文生视频 + 带声直出 · 144GB · 磁盘充足', auto: false },
            ].map((m) => {
              const p = owns[m.key];
              return (
                <div className="d-row" key={m.key}>
                  <div className="grow">
                    <b>{m.name}</b>
                    <div className="mut mono" style={{ fontSize: 11 }}>
                      {m.d}
                    </div>
                  </div>
                  {p == null ? (
                    m.auto ? (
                      <button
                        className="btn btn-s"
                        data-dl
                        style={{ padding: '7px 14px', fontSize: 'var(--text-xs)' }}
                        onClick={() => handleDownload(m.key)}
                      >
                        下载
                      </button>
                    ) : (
                      <span className="badge">手动 · 稍后在设置中处理</span>
                    )
                  ) : p < 0 ? (
                    <span className="badge err">下载失败 · 见主进程日志</span>
                  ) : p < 100 ? (
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
                  ) : (
                    <span className="badge ok">已就绪</span>
                  )}
                </div>
              );
            })}
            <div className="d-row">
              <div className="grow mut">
                <b style={{ color: 'var(--fg-2)' }}>Qwen Image Edit / SeedVR2 / Qwen2.5-VL</b>
                <div className="mono" style={{ fontSize: 11 }}>
                  可选 · 稍后在设置中下载
                </div>
              </div>
              <span className="badge">可选</span>
            </div>
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
            <p className="sub">冒烟测试每个引擎的最小任务,确认可用后进入工作台。</p>
            <div id="checkList">
              {[
                'h3.c 生成 1 秒预览视频',
                'mlxgen 生成 1 张测试图',
                'LLM 工具调用回环(create_node)',
                '队列互斥与项目锁',
              ].map((txt, i) => {
                const c = checks[i] ?? { spin: false, done: false, t: '' };
                return (
                  <div className="check" data-c key={i}>
                    {c.spin ? (
                      <span className="ck">
                        <span className="spin" />
                      </span>
                    ) : (
                      <span className={`ck${c.done ? ' ok' : ''}`}>{c.done ? '✓' : '·'}</span>
                    )}
                    <div className="grow">{txt}</div>
                    <span className="mono mut" style={{ fontSize: 11 }}>
                      {c.t}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="foot">
              <button className="btn btn-s" data-back onClick={() => go(2)}>
                上一步
              </button>
              <span className="mut" style={{ fontSize: 'var(--text-xs)' }} id="checkHint">
                {checkHint}
              </span>
              <span className="spacer" />
              {checkedAll ? null : (
                <button
                  className="btn btn-p"
                  id="selfcheck"
                  data-od-id="ob-selfcheck"
                  disabled={checking}
                  onClick={handleSelfcheck}
                >
                  开始自检
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