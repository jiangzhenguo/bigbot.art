import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { RenderJob, Asset, ShotTakeHistory, AccelPack } from '@bigbotart/shared';
import type { CanvasNode } from '../types';
import {
  SHOT_ASPECTS,
  SHOT_TIERS,
  SHOT_SIZES,
  SHOT_TIER_PRESETS,
  SHOT_MODE_LABEL,
  SHOT_REF_ROLES,
  h3AlignFrames,
  h3FramesForSeconds,
} from '../constants';
import { clamp32, thumbSrc, outputUrlOf } from '../media';

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
  const tier = (String(d.tier ?? 'default') as (typeof SHOT_TIERS)[number]) in SHOT_TIER_PRESETS ? (String(d.tier ?? 'default') as (typeof SHOT_TIERS)[number]) : 'default';
  const aspect = (String(d.aspect ?? '16:9') as (typeof SHOT_ASPECTS)[number]) in SHOT_SIZES || String(d.aspect ?? '16:9') === 'custom' ? (String(d.aspect ?? '16:9') as (typeof SHOT_ASPECTS)[number]) : '16:9';
  const prompt = String(d.prompt ?? '');
  const seconds = Number(d.seconds ?? 0);
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
  // 任务提交/完成时自动刷新 Take 历史:按本节点 job 签名(含状态)变化才重拉,
  // 长跑轮询期间签名不变不会重复请求 —— 同一节点连续生成,新版本立即可见
  const jobSigRef = useRef('');
  useEffect(() => {
    const mine = jobs.filter((j) => j.nodeId === node.id);
    const sig = `${node.id}|${mine.map((j) => `${j.id}:${j.status}`).join(',')}`;
    if (sig === jobSigRef.current) return;
    jobSigRef.current = sig;
    refreshHist();
  }, [jobs, node.id, refreshHist]);
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
      const p = String((t.params as { prompt?: string } | undefined)?.prompt ?? '').trim();
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
                  const sz = SHOT_SIZES[a as '16:9' | '9:16' | '1:1'][tier] ?? SHOT_SIZES['16:9'].default;
                  setSpec({ aspect: a, width: sz.width, height: sz.height });
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
          <input
            className="f-in"
            type="number"
            min={1}
            max={10}
            value={seconds > 0 ? seconds : ''}
            placeholder={`${Math.round(h3AlignFrames(Number(d.frames ?? 124)) / 24)}s`}
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
              // 选时长 → 帧数按 h3.c 规则自动填上(24fps 后对齐 5+17n;h3 --seconds 内部同此换算)
              setData({ seconds: s, frames: h3FramesForSeconds(s) });
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
          <div className="f-hint">绑定首/尾帧、参考图或音频后,生成时自动注入(--ref-* 参数)</div>
        ) : (
          refs.map((r, i) => {
            const path = r.path ?? assetCache[r.assetId ?? ''];
            const def = roleDefs.find((rd) => rd.role === r.role);
            const isShotSrc = !!r.path;
            return (
              <div className="slot" key={`${r.assetId ?? r.path}-${i}`}>
                {path ? <span className="refprev"><img src={isShotSrc ? outputUrlOf(path) : (thumbSrc(path) ?? '')} alt="" /></span> : <span className="refprev" />}
                <span className="grow">
                  <div className="sname">{def?.label ?? r.role}{r.auto ? ' · 自动' : ''}</div>
                  {isShotSrc ? <div className="mut mono" style={{ fontSize: 9 }}>上游镜头尾帧</div> : null}
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
            {takes.slice(0, 8).map((t) => (
              <span
                key={t.id}
                className={`chip${t.id === curTake?.id ? ' on' : ''}${t.status === 'failed' ? ' dis' : ''}`}
                onClick={() => selectTake(t)}
                title={t.resultPath ?? t.error ?? (t.status === 'succeeded' ? '无产物文件' : `Take ${t.attempt}`)}
              >
                T{t.attempt} · {t.status === 'succeeded' ? (t.resultPath ? '✓' : '✓·空') : t.status === 'failed' ? '✗' : t.status}
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
