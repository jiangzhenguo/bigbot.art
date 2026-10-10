import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { RenderJob, Asset, ShotTakeHistory, AccelPack } from '@bigbotart/shared';
import { VIDEO_ASPECTS, VIDEO_ASPECT_LABEL, type VideoAspect } from '@bigbotart/shared';
import type { CanvasNode } from '../types';
import {
  SHOT_ASPECTS,
  SHOT_TIERS,
  SHOT_SIZES,
  SHOT_TIER_PRESETS,
  SHOT_MODE_LABEL,
  SHOT_REF_ROLES,
  tierKeyOf,
  h3AlignFrames,
  h3FramesForSeconds,
  parseSecondsInput,
  SHOT_MAX_SECONDS,
  h3OutputSeconds,
  MIN_SOUNDTRACK_SECONDS,
  MIN_SOUNDTRACK_FRAMES,
} from '../constants';
import { clamp32, thumbImageSrc, previewUrlOf, outputUrlOf, VideoPoster, formatDurationSec } from '../media';
import { takePromptOf, takeElapsedSec, takeRefreshSig, hasUnsettledTake } from './ImageTakeSection';

export interface ShotInspectorProps {
  node: CanvasNode;
  setData: (patch: Record<string, unknown>) => void;
  /** 切换 Take 时同步画布节点预览(resultPath / 角标) */
  onSelectTake?: (take: {
    id: string;
    attempt: number;
    status: string;
    resultPath?: string;
  }) => void;
  projectId: string | null;
  activeCanvasId: string | null;
  jobs: RenderJob[];
  assetsList: Asset[];
  assetCache: Record<string, string>;
  runNode: (nodeId: string) => void;
  toastMsg: (msg: string) => void;
}

export function ShotInspector({
  node,
  setData,
  onSelectTake,
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
  /*
   * 档位归一:`data.tier` 可能是英文 key(正常),也可能是**中文标签** ——
   * 2026-10 的一次缺陷让 `createFromPop` 把弹层的中文「默认」直接写进了 data.tier,
   * 存量节点里就留着这种值。用 `tierKeyOf` 一并接住,否则这些节点会显示成空档位,
   * 用户点开检查器看不到自己选的是哪一档。
   */
  const tier = tierKeyOf(String(d.tier ?? 'default'));
  const aspect = (() => {
    const raw = String(d.aspect ?? '16:9');
    if (raw === 'custom') return 'custom' as const;
    return (VIDEO_ASPECTS as readonly string[]).includes(raw) ? (raw as VideoAspect) : '16:9';
  })();
  const prompt = String(d.prompt ?? '');
  const seconds = Number(d.seconds ?? 0);
  /* 时长输入框的本地草稿(见下方输入的注释)。
     受控输入不能直接绑 data.seconds —— 空串中间态会把值清掉。
     这里以节点数据为准做同步:切换节点、或外部(Agent 工具/撤销)改了 seconds 时,
     草稿要跟着走,否则会显示过期内容。 */
  const [secDraft, setSecDraft] = useState(seconds > 0 ? String(seconds) : '');
  const secSyncRef = useRef(seconds);
  useEffect(() => {
    if (secSyncRef.current !== seconds) {
      secSyncRef.current = seconds;
      setSecDraft(seconds > 0 ? String(seconds) : '');
    }
  }, [seconds]);
  const customWidth = Number(d.customWidth ?? 544);
  const customHeight = Number(d.customHeight ?? 544);
  const seed = Number(d.seed ?? 42);
  const refs = (d.refs ?? []) as Array<{ assetId?: string; path?: string; role: string; auto?: boolean }>;
  /** 🚀 加速 LoRA(蒸馏模型包):enabled + 包 id + 步数档(提交时由主进程解析 -d/--steps) */
  const accel = (d.accel ?? {}) as { enabled?: boolean; packId?: string; steps?: 4 | 8 };

  /* 接续链画面规格继承:由连线派发写入 specFrom / specOverride(见 CanvasPage 统一边分派) */
  const specFromId = (d.specFrom as { nodeId?: string } | undefined)?.nodeId;
  const specOverridden = d.specOverride === true;
  /** 模式由接续连线自动切到「首帧」(未手动选过模式时) */
  const modeAutoSet =
    d.modeOverride !== true &&
    (mode === 'first-frame' || mode === 'first-last') &&
    (!!specFromId || refs.some((r) => r.auto === true && r.role === 'first-frame'));
  /** 用户手动改画面规格 ⇒ 脱离上游继承(可一键恢复) */
  const setSpec = (patch: Record<string, unknown>) => setData({ ...patch, specOverride: true });

  const preset = SHOT_TIER_PRESETS[tier];
  /** 输出时长(秒):用于「带音轨参考视频 ≥2 秒」的实时预警(与 h3c-command.validateParams 同口径) */
  const outputSeconds = h3OutputSeconds(d);
  const isCustom = aspect === 'custom';
  // 推导值(比例 × 档位 / 自定义,32 倍数对齐)
  const derived = isCustom
    ? { width: clamp32(customWidth), height: clamp32(customHeight) }
    : SHOT_SIZES[aspect][tier];
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
    void window.bigbotart.takesHistory(projectId, node.id).then((h) => {
      setHist(h);
      /* 落盘竞态兜底(与 ImageTakeSection 同口径):主进程已改为「Take 终态先落盘再 notify」,
         但「任务已完成、Take 仍是 queued」这条路上没有主动重试 —— 一旦某次恰好在 patch
         落盘前读到盘,界面就永久定格在错误状态(用户看到「生成成功但历史里没有」)。
         这里对「读到未终态记录」做一次短延时复检(仅一次,不轮询)。 */
      if (hasUnsettledTake(h?.takes)) {
        window.setTimeout(() => {
          void window.bigbotart
            .takesHistory(projectId, node.id)
            .then((again) => setHist(again))
            .catch(() => {
              /* 复检失败保留首次结果,不静默清空 */
            });
        }, 600);
      }
    }).catch(() => setHist(null));
  }, [projectId, node.id]);
  useEffect(() => {
    refreshHist();
  }, [refreshHist]);
  /* 任务提交/完成时自动刷新 Take 历史。
   *
   * ⚠️ 签名必须走 takeRefreshSig(与 ImageTakeSection 共用一个函数),不能只看 job:
   * 旧实现签名 = `<nodeId>|<job.id>:<status>,…`,只在**本节点的 job 出现在 jobs 列表里**
   * 时才会变。而 RenderQueue 的 jobs 是纯内存的 —— 应用重启 / 窗口重载 / 切画布再回来之后
   * 队列里没有这条 job(签名恒为 `<nodeId>|`),effect 首次挂载拉一次后**永不重拉**,
   * 于是磁盘上早已 succeeded 的 Take 在界面上永远不出现。
   * 真实事故(2026-10-09):镜头 03 生成成功、takes.json 里 T4 齐全、节点 currentTakeId 也指对了,
   * 但 Take 历史与预览都不显示。图片节点侧(ImageTakeSection)早就修过同一个 bug,
   * **shot 侧没跟上**,这次补齐。
   * 现在把**节点产物路径**也纳入签名:`resultPath` 出现/变化本身就是「历史一定变了」的强信号,
   * 与 job 是否存在无关(jobs 被清空、跨重启都拦不住它)。 */
  const histSigRef = useRef('');
  useEffect(() => {
    const sig = takeRefreshSig(node.id, jobs, (node.data as Record<string, unknown> | undefined)?.resultPath);
    if (sig === histSigRef.current) return;
    histSigRef.current = sig;
    refreshHist();
  }, [jobs, node.id, node.data, refreshHist]);
  const takes = hist?.takes ?? [];
  // 🚀 加速 LoRA:设置页登记的蒸馏模型包清单(主进程回填 exists)
  const [packs, setPacks] = useState<AccelPack[]>([]);
  useEffect(() => {
    // 防御:主进程/preload 未重建时通道可能不存在(HMR 先于 main 热更的场景),缺失则降级空列表,不白屏
    const api = window.bigbotart;
    if (typeof api.accelList !== 'function') {
      console.warn('[accel] accelList 通道不可用(主进程/preload 未重载?)· 加速 LoRA 降级为空列表');
      setPacks([]);
      return;
    }
    void api.accelList().then(setPacks).catch(() => setPacks([]));
  }, []);
  const defaultPackId = packs.find((p) => p.default)?.id ?? packs[0]?.id;
  const selPack = packs.find((p) => p.id === (accel.packId ?? defaultPackId));
  /** 最近一次生成实际用过的提示词(存档在 Take.params 里)——节点 prompt 为空时可用于找回 */
  const takePrompt = (() => {
    for (const t of takes) {
      const p = takePromptOf(t).trim();
      if (p) return p;
    }
    return '';
  })();
  const [selTakeId, setSelTakeId] = useState<string | undefined>();
  // 节点切换时清空手动选择,避免串 Take
  useEffect(() => {
    setSelTakeId(undefined);
  }, [node.id]);
  // 默认:手动选择 → 节点已绑定 currentTakeId → 成功且有产物 → 最新一条
  const boundTakeId = typeof d.currentTakeId === 'string' ? d.currentTakeId : undefined;
  const curTake =
    (selTakeId ? takes.find((t) => t.id === selTakeId) : undefined)
    ?? (boundTakeId ? takes.find((t) => t.id === boundTakeId) : undefined)
    ?? takes.find((t) => t.status === 'succeeded' && !!t.resultPath)
    ?? takes[0]
    ?? null;

  /** 当前 Take 的生成提示词 / 生成时长(存档在 Take.params / elapsedSec 里,切换 Take 即随之切换) */
  const curTakePrompt = curTake ? takePromptOf(curTake) : '';
  const curTakeTook = curTake ? formatDurationSec(takeElapsedSec(curTake)) : null;

  const selectTake = (t: (typeof takes)[number]) => {
    setSelTakeId(t.id);
    onSelectTake?.({
      id: t.id,
      attempt: t.attempt,
      status: t.status,
      resultPath: t.resultPath,
    });
  };

  // 🚀 加速 LoRA 生效后的预计时间与执行步数(按实际步数相对档位预设步数缩放)
  const tierSteps = preset.steps;
  const effSteps = accel.enabled ? (accel.steps ?? 8) : tierSteps;
  const etaText = accel.enabled
    ? `≈${Math.max(1, Math.round(preset.etaMin * (effSteps / tierSteps)))} 分钟`
    : preset.eta;

  // 参考角色(按 mode)
  const roleDefs = SHOT_REF_ROLES[mode] ?? SHOT_REF_ROLES['text2video'] ?? [];

  /** 单值角色(一个镜头只能有一个):已绑定就不再给「＋」入口 */
  const SINGLE_ROLES = ['first-frame', 'last-frame', 'ref-audio', 'ref-video'];
  /** 被用户停用的自动绑定角色(× 掉连线自动注入的项后写入,避免派发又把它加回来) */
  const suppressed = (d.refsSuppressed as string[] | undefined) ?? [];

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
    // 单值角色:手动绑定顶掉同名旧项(含连线自动注入的),并解除该角色的自动停用
    const base = SINGLE_ROLES.includes(roleDef.role) ? refs.filter((r) => r.role !== roleDef.role) : refs;
    const nextSuppressed = suppressed.filter((r) => r !== roleDef.role);
    setData({
      refs: [...base, { assetId: candidate.id, role: roleDef.role }],
      ...(nextSuppressed.length !== suppressed.length ? { refsSuppressed: nextSuppressed } : {}),
    });
    toastMsg(`已绑定${roleDef.label} · ${candidate.name}`);
  };
  /** 移除:自动注入的项要登记停用,否则下一轮派发会重新加回来 */
  const removeRef = (i: number) => {
    const target = refs[i];
    const next = refs.filter((_, j) => j !== i);
    if (target?.auto) {
      setData({ refs: next, refsSuppressed: [...new Set([...suppressed, target.role])] });
      toastMsg(`已解除自动绑定 · ${target.role}`);
      return;
    }
    setData({ refs: next });
  };
  const setRefRole = (i: number, role: string) => setData({ refs: refs.map((r, j) => (j === i ? { ...r, role } : r)) });
  /** 恢复某角色的自动绑定(连线重新接管) */
  const restoreAuto = (role: string) => setData({ refsSuppressed: suppressed.filter((r) => r !== role) });

  /** 提交生成(检查器主按钮):节点参数已在 chips 选择时写入 data,直接提交 */
  const submit = () => {
    if (!projectId) {
      toastMsg('先进一个项目再生成');
      return;
    }
    void runNode(node.id);
  };

  const aspectLabel = (a: string) =>
    a === 'custom' ? '自定义' : (VIDEO_ASPECT_LABEL[a as VideoAspect] ?? a);
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
            <span className="right">{etaText}</span>
          </div>
          <div className="gs-sub">h3.c · {SHOT_MODE_LABEL[mode]} · {resText} · 显存 ≈25GB</div>
          <button className="btn btn-p btn-sm" style={{ width: '100%' }} onClick={submit}>立即生成</button>
        </div>
      ) : (
        <div className="gok">
          <span className="dot ok" />生成完成 · Take {curTake.attempt} ✓
          {/* 生成耗时(墙钟)用 elapsedSec;历史数据缺该字段时回退 durationSec */}
          {(() => {
            const sec = curTake.elapsedSec ?? curTake.durationSec;
            return sec !== undefined ? ` · 耗时 ${Math.round(sec / 60)}分${Math.round(sec % 60)}秒` : '';
          })()}
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
      ) : curTake?.status === 'succeeded' ? (
        <div className="f-hint">此 Take 标记成功但无产物文件(多为 dry-run 空跑) · 可在 Take 历史切到有文件的版本,或重新生成</div>
      ) : null}

      {/* ── 模式 ── */}
      <div className="f-sec">
        <div className="lbl">生成模式</div>
        <div className="f-chips">
          {Object.keys(SHOT_MODE_LABEL).map((m) => (
            <span key={m} className={`chip${mode === m ? ' on' : ''}`} onClick={() => setData({ mode: m, modeOverride: true, refs: refs.filter((r) => SHOT_REF_ROLES[m]?.some((rd) => rd.role === r.role)) })}>
              {SHOT_MODE_LABEL[m]}
            </span>
          ))}
        </div>
        {modeAutoSet ? (
          <div className="f-hint" style={{ marginTop: 4 }}>
            由接续连线自动设为「{SHOT_MODE_LABEL[mode]}」· 手动点选任一模式即脱离自动
          </div>
        ) : null}
      </div>

      {/* ── 档位 × 画幅 ── */}
      <div className="f-sec">
        <div className="lbl">档位 × 画幅(白名单防呆)</div>
        {/* 接续链:画面规格默认继承上游镜头;手动改任意规格即转自定义,可一键恢复继承 */}
        {specFromId ? (
          <div className="f-hint" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            {specOverridden ? (
              <>
                <span>画面规格:自定义(已脱离上游镜头 {specFromId.slice(0, 10)})</span>
                <button className="btn btn-xs" onClick={() => setData({ specOverride: false })}>恢复继承</button>
              </>
            ) : (
              <span>画面规格继承自上游镜头 {specFromId.slice(0, 10)} · 比例与档位跟随上游</span>
            )}
          </div>
        ) : null}
        <div className="f-row">
          <span className="f-lbl">比例</span>
          <div className="f-chips">
            {SHOT_ASPECTS.map((a) => (
              <span
                key={a}
                className={`chip${aspect === a ? ' on' : ''}`}
                onClick={() => {
                  if (a === 'custom') {
                    setSpec({ aspect: 'custom', width: clamp32(customWidth), height: clamp32(customHeight) });
                    return;
                  }
                  // 选比例 → 立即按当前档位写入节点参数
                  const sz = SHOT_SIZES[a as VideoAspect][tier];
                  setSpec({ aspect: a, width: sz.width, height: sz.height });
                }}
              >
                {a === 'custom' ? '自定义' : a}
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
                    : SHOT_SIZES[aspect as VideoAspect][t];
                  setSpec({
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
                setSpec({ customWidth: v, width: clamp32(v) });
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
                setSpec({ customHeight: v, height: clamp32(v) });
              }}
            />
            <span className="f-hint" style={{ marginLeft: 4 }}>须为 32 的倍数</span>
          </div>
        ) : null}
        <div className="f-hint">
          输出 {resText} · 预计 {etaText} · {SHOT_TIER_PRESETS[tier].note}
        </div>
      </div>

      {/* ── 🚀 加速 LoRA(蒸馏模型包):h3.c 不接受 --lora,加速 = 换蒸馏目录 + 4/8 步 ── */}
      <div className="f-sec" data-od-id="shot-accel-lora">
        <div className="lbl">🚀 加速 LoRA</div>
        <div className="f-row">
          <span className="f-lbl">开关</span>
          <div className="f-chips">
            <span
              className={`chip${!accel.enabled ? ' on' : ''}`}
              onClick={() => setData({ accel: { ...accel, enabled: false } })}
            >
              关闭
            </span>
            <span
              className={`chip${accel.enabled ? ' on' : ''}`}
              onClick={() =>
                setData({
                  accel: { enabled: true, packId: accel.packId ?? defaultPackId, steps: accel.steps ?? 8 },
                })
              }
            >
              ⚡ 开启
            </span>
          </div>
        </div>
        {accel.enabled ? (
          <>
            <div className="f-row">
              <span className="f-lbl">步数</span>
              <div className="f-chips">
                {([4, 8] as const).map((s) => (
                  <span
                    key={s}
                    className={`chip${(accel.steps ?? 8) === s ? ' on' : ''}`}
                    onClick={() => setData({ accel: { ...accel, steps: s } })}
                  >
                    {s} 步{s === 8 ? ' · 推荐' : ''}
                  </span>
                ))}
              </div>
            </div>
            <div className="f-row">
              <span className="f-lbl">模型包</span>
              {packs.length === 0 ? (
                <span className="f-hint">暂无蒸馏模型包 · 去「设置 → 加速 LoRA」安装</span>
              ) : (
                <div className="f-chips">
                  {packs.map((p) => (
                    <span
                      key={p.id}
                      className={`chip${(accel.packId ?? defaultPackId) === p.id ? ' on' : ''}`}
                      onClick={() => setData({ accel: { ...accel, packId: p.id } })}
                    >
                      {p.name}
                      {p.default ? ' · 默认' : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="f-hint">
              开启后(真实推理时生效,demo/mock 模式不解析)-d 换 {selPack?.path ?? '默认蒸馏模型包'} · --steps {accel.steps ?? 8} · 省 60-80% 时间
              {accel.steps === 4 ? ' · 4 步边缘细节略糊' : ' · 8 步质量甜点'}
              · 加速不随接续链规格继承
            </div>
          </>
        ) : (
          <div className="f-hint">蒸馏模型包 + 4/8 步出片(省 60-80% 时间)· 需设置页装有 turbo 模型包</div>
        )}
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
                if (Number.isFinite(f) && f > h3FramesForSeconds(10)) {
                  toastMsg(`帧数超过 10 秒上限(≈${h3FramesForSeconds(10)} 帧) · 建议用时长设置或拆多镜头段落`);
                }
                // 直接改帧数 → 清空时长(避免 seconds 优先覆盖),帧数显式生效(h3 运行时会再对齐 5+17n)
                setData({ frames: Number.isFinite(f) ? f : 0, seconds: 0 });
              }}
            />
          </div>
          <div className="fg">
            <span>步数 S</span>
            {accel.enabled ? (
              <input
                className="f-in"
                type="number"
                value={effSteps}
                disabled
                title="加速 LoRA 已接管步数(真实推理时以 --steps 覆盖)"
              />
            ) : (
              <input className="f-in" type="number" value={Number(d.steps ?? 20)} onChange={(e) => setData({ steps: Number(e.target.value) })} />
            )}
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
        {accel.enabled ? (
          <div className="f-hint" style={{ marginTop: 6 }}>
            加速 LoRA 已接管步数(--steps {effSteps})· 此处 S 显示为实际执行值,不可改;可在上方「加速 LoRA → 步数」切 4/8
          </div>
        ) : null}
        <div className="f-row" style={{ marginTop: 6 }}>
          <span className="f-lbl">seed</span>
          <input className="f-in" type="number" value={seed} style={{ width: 76 }} onChange={(e) => setData({ seed: Number(e.target.value) })} />
          <span className="f-lbl">时长</span>
          {/* 时长输入:用**本地草稿态**接收键盘输入,只在值合法时才写进节点。
              ⚠️ 直接受控于 data.seconds 会有「点击即清零」的 bug(2026-10-09 实测):
              `type="number"` 的输入框在「全选后输入」「退格删到空」时会先抛出 `''`,
              而 `Number('') === 0` 且 `0 <= 0` 成立 → 旧代码立刻 `setData({seconds:0})` 把值清空,
              用户看到的就是「明明填了 5 秒,点一下变成 1 秒」(占位符回落到按 frames 推算的值)。
              现在:空/非法输入一律**不碰节点数据**,仅更新草稿;合法值才落盘。 */}
          <input
            className="f-in"
            type="number"
            min={1}
            max={10}
            value={secDraft}
            placeholder={`${Math.round(h3AlignFrames(Number(d.frames ?? 124)) / 24)}s`}
            style={{ width: 52 }}
            onChange={(e) => {
              const raw = e.target.value;
              setSecDraft(raw); // 键盘输入先落草稿,保证受控输入流畅
              const r = parseSecondsInput(raw);
              // keep=true 表示空/半截/非法 —— 中间态一律不写盘(丢值 bug 的根因)
              if (r.keep) return;
              if (r.clamped) {
                toastMsg(`h3.c 单段时长最多 ${SHOT_MAX_SECONDS} 秒 · 更长请拆多镜头段落`);
                setSecDraft(String(SHOT_MAX_SECONDS));
              }
              // 合法值才落盘:秒数 + 按 h3.c 规则对齐的帧数(5+17n)
              setData({ seconds: r.seconds, frames: r.frames });
            }}
            onBlur={() => {
              // 失焦时把草稿与节点数据对齐:输入了非法值/清空 → 回显真实数据,不留假象
              const t = String(seconds > 0 ? seconds : '');
              if (secDraft !== t) setSecDraft(t);
            }}
          />
          <span className="f-hint">最多 10s(24fps · 10s≈{h3FramesForSeconds(10)} 帧)· 选时长自动填对齐帧数(5+17n)</span>
        </div>
      </div>

      {/* ── 提示词 ── */}
      <div className="f-sec">
        <div className="lbl">提示词(H3 五段式)</div>
        {(() => {
          const pf = d.promptFrom as { nodeId?: string } | undefined;
          return pf?.nodeId ? (
            <div className="f-hint" style={{ marginBottom: 4 }}>
              提示词由文档节点 {pf.nodeId.slice(0, 10)} 注入(自身为空时生效)
            </div>
          ) : null;
        })()}
        {/* 节点 prompt 为空但 Take 里有原文 ⇒ 提供找回入口(数据丢失兜底) */}
        {!prompt.trim() && takePrompt ? (
          <div className="f-hint" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span>节点未保存提示词;最近一次生成用的是 Take 里的原文</span>
            <button className="btn btn-xs" onClick={() => setData({ prompt: takePrompt })}>
              用这条提示词
            </button>
          </div>
        ) : null}
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
          <div className="f-hint">绑定首/尾帧、参考图、参考视频或音频后,生成时自动注入(--ref-* 参数)</div>
        ) : (
          refs.map((r, i) => {
            const path = r.path ?? assetCache[r.assetId ?? ''];
            const def = roleDefs.find((rd) => rd.role === r.role);
            const isShotSrc = !!r.path;
            // 缩略图:视频必须走抽帧封面(旧实现把 mp4 塞进 <img> = 必然 onerror,
            // 参考视频那一行因此只剩空框);图片仍用 <img>。
            const thumb = thumbImageSrc(path);
            const srcNote =
              r.role === 'ref-video'
                ? (isShotSrc ? '视频产物 · 整段成片' : '视频素材')
                : isShotSrc ? '上游镜头尾帧' : '';
            return (
              <div className="slot" key={`${r.assetId ?? r.path}-${i}`}>
                {thumb?.kind === 'img' ? (
                  <span className="refprev"><img src={thumb.src} alt="" /></span>
                ) : thumb?.kind === 'video' ? (
                  <span className="refprev refprev-vid"><VideoPoster src={previewUrlOf(path) ?? ''} /></span>
                ) : (
                  <span className="refprev" />
                )}
                <span className="grow">
                  <div className="sname">{def?.label ?? r.role}{r.auto ? ' · 自动' : ''}</div>
                  {srcNote ? <div className="mut mono" style={{ fontSize: 9 }}>{srcNote}</div> : null}
                </span>
                <span className="sval">{r.assetId ? r.assetId.slice(0, 10) : '…'}</span>
                <button className="btn btn-xs" onClick={() => removeRef(i)} title="移除">×</button>
              </div>
            );
          })
        )}
        {roleDefs.map((rd) => {
          const bound = refs.filter((r) => r.role === rd.role).length;
          const maxed = rd.role === 'ref-image' && bound >= 9;
          // 单值角色已绑定(含连线自动绑定)⇒ 不再给重复入口;要换就点上方那条的 × 再绑
          if (SINGLE_ROLES.includes(rd.role) && bound > 0) return null;
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
        {/* 参考视频音轨开关:h3 --ref-video 会把源片内嵌音轨一起注入;只想借画面/动作时勾这里 */}
        {refs.some((r) => r.role === 'ref-video') ? (
          <>
            <label
              className="f-hint"
              data-od-id="shot-ref-video-silent"
              style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={d.refVideoSilent === true}
                onChange={(e) => setData({ refVideoSilent: e.target.checked })}
              />
              忽略参考视频音轨(改走 <code>--ref-silent-video</code>;不勾则连同源片声音一起参考)
            </label>
            {/* 时长下限预警(与 h3c-command.ts 的 validateParams 同口径,h3.c:1146):
                带音轨的参考视频要求输出 ≥2 秒,而 preview 档只有 22 帧(≈0.92s)→ 必然提交失败。
                提前在这里显示,避免用户提交后才在队列里看到 h3 的英文报错 */}
            {d.refVideoSilent !== true && outputSeconds < MIN_SOUNDTRACK_SECONDS ? (
              <div
                className="f-hint"
                data-od-id="shot-ref-video-duration-warn"
                style={{ marginTop: 4, color: 'var(--warn, #d08700)' }}
              >
                ⚠️ 参考视频带音轨时 h3 要求输出 ≥2 秒,当前 {outputSeconds.toFixed(2)} 秒:
                请提高帧数/时长(≥ {MIN_SOUNDTRACK_FRAMES} 帧),或勾选上面的「忽略参考视频音轨」。
              </div>
            ) : null}
          </>
        ) : null}
        {/* 用户 × 掉的自动绑定:给出恢复入口,避免"连线明明在却不再注入"的困惑 */}
        {suppressed.length > 0 ? (
          <div className="f-hint" style={{ marginTop: 6 }}>
            已停用自动绑定:{suppressed.map((role) => roleDefs.find((rd) => rd.role === role)?.label ?? role).join('、')}
            {suppressed.map((role) => (
              <button
                key={role}
                className="btn btn-xs"
                style={{ marginLeft: 6 }}
                onClick={() => restoreAuto(role)}
              >
                恢复
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* ── Take 历史 ── */}
      {takes.length > 1 ? (
        <div className="f-sec">
          <div className="lbl">Take 历史</div>
          <div className="f-chips">
            {takes.slice(0, 8).map((t) => {
              const took = formatDurationSec(takeElapsedSec(t));
              const pr = takePromptOf(t);
              const title = [
                `Take ${t.attempt} · ${t.status}`,
                `生成时长 ${took ?? '未知'}`,
                pr ? `提示词:${pr}` : '无提示词存档',
                t.resultPath ?? t.error,
              ]
                .filter(Boolean)
                .join('\n');
              return (
                <span
                  key={t.id}
                  className={`chip${t.id === curTake?.id ? ' on' : ''}${t.status === 'failed' ? ' dis' : ''}`}
                  onClick={() => selectTake(t)}
                  title={title}
                >
                  T{t.attempt} · {t.status === 'succeeded' ? (t.resultPath ? '✓' : '✓·空') : t.status === 'failed' ? '✗' : t.status}
                  {/* 生成时长(墙钟 elapsedSec,缺则回退 durationSec):缺失显式写「时长未知」 */}
                  <span className="mut" style={{ fontSize: 10, marginLeft: 4 }}>{took ?? '时长未知'}</span>
                </span>
              );
            })}
          </div>
          {/* 切到旧 Take 时提示词区仍显示节点当前 prompt,容易误判「这条就是用这段生成的」——
              这里把该 Take 存档的原文单独回显,口径与「本条 Take 实际提交的参数」对齐 */}
          {curTake ? (
            <div data-od-id="shot-take-prompt" style={{ marginTop: 8 }}>
              <div className="f-hint" style={{ marginBottom: 4 }}>
                当前 Take T{curTake.attempt} 的生成提示词{curTakeTook ? ` · 生成时长 ${curTakeTook}` : ''}
                {curTakePrompt ? '' : ' · 该 Take 未存档提示词'}
                {curTakePrompt && curTakePrompt !== prompt ? ' · 与上方节点提示词不同' : ''}
              </div>
              {curTakePrompt ? <textarea className="f-ta short mono" rows={3} readOnly value={curTakePrompt} /> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── 主按钮 ── */}
      <button className="btn btn-s" style={{ width: '100%' }} onClick={submit}>
        {curTake ? '重新生成' : '立即生成'}
      </button>
    </div>
  );
}
