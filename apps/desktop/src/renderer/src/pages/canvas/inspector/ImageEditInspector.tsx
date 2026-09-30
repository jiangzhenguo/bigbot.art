/**
 * ImageEditInspector — 图片编辑节点检查器(对齐设计稿 ④/⑤/⑥/⑦/⑩)
 * 模式 chips(instruction / img2img / inpaint / outpaint)+ 各自专属参数区:
 *   img2img → 图像强度滑块(→ --i2i-mode latent + --image-strength)
 *   inpaint → 可视化遮罩(拖入 PNG / 框选生成 → 保存为遮罩资产 → --mask-path)
 *   outpaint → 四边 padding(→ --outpaint-padding top,right,bottom,left)
 */
import React, { useEffect, useRef, useState } from 'react';
import type { RenderJob } from '@bigbotart/shared';
import type { CanvasNode } from '../types';
import { ImageTakeSection } from './ImageTakeSection';
import { useTakeResult } from './useTakeResult';
import { ImagePreview } from './ImagePreview';
import { KVSection } from './fields';
import { ModelCombo, matchModel } from './ModelCombo';
import { capabilityOf, resolveImageModel } from '@bigbotart/shared';
import { getToolModelsSync } from '../tool-models-store';
import { GenStatePanel } from './GenState';
import { UpstreamCard, ImageStrengthField, OutpaintPads, MaskField, ActionBar } from './image-ui';
import { previewUrlOf } from '../media';

export interface ImageEditInspectorProps {
  node: CanvasNode;
  setData: (patch: Record<string, unknown>) => void;
  jobs: RenderJob[];
  projectId: string | null;
  nodes: CanvasNode[];
  assetCache: Record<string, string>;
  runNode: (nodeId: string) => void;
  toastMsg: (m: string) => void;
  onSelectTake?: (t: { id: string; attempt: number; status: string; resultPath?: string }) => void;
}

const MODE_META: Array<{ key: string; label: string; mono: string }> = [
  { key: 'instruction', label: '指令', mono: 'instruction' },
  { key: 'img2img', label: 'I2I', mono: 'img2img' },
  { key: 'inpaint', label: '局部重绘', mono: 'inpaint' },
  { key: 'outpaint', label: '扩图', mono: 'outpaint' },
];

/**
 * 图片编辑默认采样步数。
 *
 * ⚠️ 根因记录(2026-09-29 真实事故「图片编辑不改 step 直接就是 40 步」):
 *   此前这里默认 4,且注释明写「仅作滑块初始值展示——不写回 data」;
 *   而 provider `mlxgen.ts` 的 Qwen-Image-2.1 参考编辑分支又硬兜底 `p.steps ?? 40`。
 *   两套默认互不认识 → **滑块显示 4、实跑 40**,提交参数里压根没有 `steps` 键
 *   (实测 take 存档确认),用户完全无从察觉。2.1 bf16 上 40 步约 4 分钟,
 *   是 6 步版(54-92s)的 6-7 倍耗时。
 *
 * 修法(A 方案,用户 2026-09-29 指定):默认值改 30,且**未设置时显式写回 data**。
 * 硬约束:「滑块显示几步 = 实际跑几步」。provider 侧的 `?? 30` 降级为安全网
 * (历史节点 / Agent 直传 data 未带 steps 时),不再是一套隐藏默认值。
 *
 * ⚠️ 改动本值时必须同步 `packages/providers/src/mlxgen.ts` 参考编辑分支的兜底值
 * (renderer 不能 import providers —— 包边界)。单测 `__tests__/edit-steps-default.test.ts` 锁一致性。
 */
export const DEFAULT_EDIT_STEPS = 30;

/**
 * 各编辑模式可用的已知模型 + 推荐默认(2026-09 mlxgen capabilities 实测,矩阵见
 * docs/工具模型选择-产品设计与技术方案.md §2.1.1):
 * - instruction:Qwen Edit / flux2 / **Qwen-Image-2.1**(qwen21.edit,1-10 张参考图。
 *   2026-09-29 缺陷 B 修复:此前 allowed 漏了 2.1,用户选了 2.1 一切模式就被自动切走)
 * - img2img(latent):z-image / flux2 / **Qwen-Image-2.1**(qwen21.latent;
 *   2026-09-29 缺陷 A 已修:Provider 不再误拒 2.1,故入列)
 * - inpaint/outpaint → qwen.edit handler(Qwen Edit / flux2);2.1 实测无 mask/outpaint 能力
 * 自定义 repoId(matchModel 匹配不到)不自动切换,由用户自行负责。
 */
const MODE_MODELS: Record<string, { allowed: string[]; recommend: string }> = {
  instruction: { allowed: ['mlx-community/Qwen-Image-Edit-8bit', 'AbstractFramework/flux.2-klein-9b-8bit', 'Qwen/Qwen-Image-2.1'], recommend: 'mlx-community/Qwen-Image-Edit-8bit' },
  img2img: { allowed: ['AbstractFramework/z-image-turbo-8bit', 'AbstractFramework/flux.2-klein-9b-8bit', 'Qwen/Qwen-Image-2.1'], recommend: 'AbstractFramework/z-image-turbo-8bit' },
  inpaint: { allowed: ['mlx-community/Qwen-Image-Edit-8bit', 'AbstractFramework/flux.2-klein-9b-8bit', 'AbstractFramework/z-image-turbo-8bit'], recommend: 'mlx-community/Qwen-Image-Edit-8bit' },
  outpaint: { allowed: ['mlx-community/Qwen-Image-Edit-8bit', 'AbstractFramework/flux.2-klein-9b-8bit'], recommend: 'mlx-community/Qwen-Image-Edit-8bit' },
};

/** 模式切换判定(纯函数,供单测):当前已知模型不支持目标模式时给出推荐切换目标,否则 null */
export function modeSwitchDecision(currentModel: string, targetMode: string): { recommend: string } | null {
  const rule = MODE_MODELS[targetMode];
  const curRepo = matchModel(currentModel)?.repoId;
  if (rule && curRepo && !rule.allowed.includes(curRepo)) return { recommend: rule.recommend };
  return null;
}

export function ImageEditInspector(p: ImageEditInspectorProps) {
  const { node, setData, jobs, projectId, nodes, assetCache, runNode, toastMsg, onSelectTake } = p;
  const d = (node.data ?? {}) as Record<string, unknown>;
  const mode = String(d.mode ?? 'instruction');
  // 未显式选模型时显示缺省解析结果(按当前 mode 对应的能力;2026-09-29 v1)
  const model = String(d.model ?? '').trim() || (resolveImageModel(getToolModelsSync(), capabilityOf('image-edit', mode)) ?? '');
  const prompt = String(d.prompt ?? '');
  const inputAssetId = String(d.inputAssetId ?? '');
  const maskAssetId = String(d.maskAssetId ?? '');
  const imageStrength = Number(d.imageStrength ?? 0.5);
  const steps = Number(d.steps ?? DEFAULT_EDIT_STEPS);
  /** data 里是否有显式步数(未设置时下面 effect 会补写,补写前提交侧会走 provider 兜底) */
  const hasExplicitSteps = d.steps !== undefined && Number.isFinite(Number(d.steps));
  /* 补写默认步数:仅在缺失时执行一次(用户拖动滑块后 data.steps 存在,不再覆盖)。
     ⚠️⚠️ 依赖数组**故意只放节点 id**,不放 hasExplicitSteps / setData —— 这是防「无限重渲染」的硬要求:
       - `setData` 由 InspectorBody 内联定义,**每次渲染都是新引用**;
       - 写入 steps 后 props 里的 `d.steps` 要等下一轮渲染才更新,故本轮 `hasExplicitSteps` 仍为 false。
     若把这两者放进依赖,effect 会在「写入 → 重渲染 → 依赖变化 → 再写入」间自我维持,
     实测直接打爆 React 的 `Maximum update depth exceeded`(2026-09-29 真实事故,日志刷屏 672 条)。
     以 node.id 为界即可:切节点时才重新判断是否需要补写。 */
  const setDataRef = useRef(setData);
  setDataRef.current = setData;
  /** 是否已有显式步数:从 ref 读,避免进入 effect 依赖(见上方注释) */
  const hasExplicitStepsRef = useRef(hasExplicitSteps);
  hasExplicitStepsRef.current = hasExplicitSteps;
  const nodeId = node.id;
  useEffect(() => {
    // 已有显式步数(用户调过 / 补写过)不再覆盖
    if (hasExplicitStepsRef.current) return;
    setDataRef.current({ steps: DEFAULT_EDIT_STEPS });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上方注释:稳定依赖,防止自维持死循环
  }, [nodeId]);
  const outpaintSides = (d.outpaintSides as { top: number; right: number; bottom: number; left: number } | undefined)
    ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const frameSrc = d.inputFrameSource as { videoNodeId?: string; at?: 'first' | 'last' } | undefined;
  const imgFrom = d.inputImageFrom as { nodeId?: string } | undefined;
  // 产物路径:节点 data 优先,缺失时回退 Take 历史里最新成功产物(2026-09-29 事故修复)
  const resultPath = useTakeResult(node.id, projectId, d.resultPath, jobs) ?? '';
  const hasTake = !!d.currentTakeId || !!resultPath;
  const running = jobs.some((j) => j.nodeId === node.id && j.status === 'running');

  // 模式切换:当前模型不在该模式可用集合里时自动切到推荐模型(自定义模型不动)
  const onModeChange = (m: string) => {
    const decision = modeSwitchDecision(model, m);
    if (decision) {
      const to = matchModel(decision.recommend);
      setData({ mode: m, model: decision.recommend });
      toastMsg(`「${MODE_META.find((x) => x.key === m)?.label ?? m}」模式不支持当前模型,已自动切换为 ${to?.name ?? decision.recommend}`);
    } else {
      setData({ mode: m });
    }
  };

  const onArchive = () => {
    if (!projectId || !resultPath) { toastMsg('暂无产物可入库'); return; }
    void window.bigbotart
      .archiveProducts({ projectId, items: [{ nodeId: node.id, path: resultPath }] })
      .then((r) => toastMsg(r.ok ? `已归档 ${r.assets.length} 项到资产库` : `归档失败:${r.error ?? ''}`))
      .catch(() => toastMsg('归档失败'));
  };

  // ── 输入图来源解析(Asset 直绑 > shot 抽帧 > 图片直通) ──
  const up = (() => {
    if (inputAssetId && assetCache[inputAssetId]) {
      return { src: previewUrlOf(assetCache[inputAssetId]), label: 'Asset 直绑', sub: inputAssetId, pill: 'Asset 直绑' };
    }
    if (frameSrc?.videoNodeId) {
      const vn = nodes.find((n) => n.id === frameSrc.videoNodeId);
      return { src: null as string | null, label: vn?.title ?? 'shot 节点', sub: `取帧 · ${frameSrc.at === 'last' ? '尾帧' : '首帧'}`, pill: '抽帧' };
    }
    if (imgFrom?.nodeId) {
      const upNode = nodes.find((n) => n.id === imgFrom.nodeId);
      const pd = (upNode?.data ?? {}) as Record<string, unknown>;
      const path = String(pd.resultPath ?? '');
      return { src: path ? previewUrlOf(path) : null, label: upNode?.title ?? imgFrom.nodeId, sub: `${upNode?.kind ?? '图片'} · 产物直通`, pill: '直通' };
    }
    return { src: null as string | null, label: '无输入', sub: '连一个 shot / 图片节点 / asset,或填输入图资产', pill: '待绑定' };
  })();

  // 输入图自然尺寸(outpaint 导出尺寸推算用)
  const [inputDims, setInputDims] = useState<{ w?: number; h?: number }>({});
  useEffect(() => {
    if (!up.src) { setInputDims({}); return; }
    const img = new Image();
    img.onload = () => setInputDims({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => setInputDims({});
    img.src = up.src;
    return () => { img.onload = null; img.onerror = null; };
  }, [up.src]);

  const upstreamStale = imgFrom?.nodeId ? !!nodes.find((n) => n.id === imgFrom.nodeId)?.stale : false;

  const [modelReady, setModelReady] = useState(true);
  useEffect(() => {
    const repo = matchModel(model)?.repoId;
    if (!repo) return;
    void window.bigbotart
      .mlxgenModels()
      .then((list) => setModelReady(!!list.find((m) => m.repoId === repo)?.downloaded))
      .catch(() => {});
  }, [model]);

  const canSubmit = !running && !upstreamStale && !(mode === 'inpaint' && !maskAssetId);
  const submitHint =
    upstreamStale
      ? '上游已变更 · 请先同步上游'
      : mode === 'inpaint' && !maskAssetId
        ? '请先绘制/选择遮罩'
        : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <GenStatePanel
        node={node}
        jobs={jobs}
        takesCount={hasTake ? 1 : 0}
        runNode={runNode}
        toastMsg={toastMsg}
        modelDownloaded={modelReady}
        onDownloadModel={() => {
          const repo = matchModel(model)?.repoId;
          if (!repo) { toastMsg('当前为自定义模型,请到设置页下载'); return; }
          void window.bigbotart.mlxgenDownload(repo).then((r) => toastMsg(r.ok ? `已开始下载 ${repo}` : `下载失败:${r.error ?? ''}`));
        }}
      />

      {upstreamStale ? (
        <div className="stale-banner" data-od-id="stale-banner">
          <div className="sb-ico">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.7}><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3" /></svg>
          </div>
          <div className="sb-meta">
            <b>上游已变化 · 当前编辑基于旧产物</b>
            <div className="sb-sub">提交时自动使用上游最新产物;上游重新生成后建议重跑本节点。</div>
          </div>
          <div className="sb-acts">
            <button className="btn btn-p btn-sm" type="button" onClick={() => runNode(node.id)}>同步上游并重跑</button>
          </div>
        </div>
      ) : null}

      {/* 编辑模式 chips */}
      <div className="f-sec">
        <div className="f-sec-h"><span className="lbl">编辑模式</span></div>
        <div className="modes" style={running ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
          {MODE_META.map((m) => (
            <span key={m.key} className={`chip${mode === m.key ? ' on' : ''}`} onClick={() => onModeChange(m.key)}>
              {m.label}
              <span className="small mono">{m.mono}</span>
            </span>
          ))}
        </div>
      </div>

      <UpstreamCard label={up.label} sub={up.sub} src={up.src} pill={up.pill} />
      {/* 输入图大图预览(有源时;点 ⛶ 可全屏) */}
      {up.src ? <ImagePreview src={up.src} alt="输入图预览" /> : null}

      {/* 产物预览(与 image-gen 检查器同模式) */}
      {resultPath ? (
        <div className="kv" data-od-id="edit-result-preview">
          <div className="f-sec-h"><span className="lbl">产物预览</span><span className="mut" style={{ fontSize: 10.5 }}>{hasTake ? 'Take · 可点下方历史切换' : ''}</span></div>
          <ImagePreview src={previewUrlOf(resultPath)} label="" />
          <div className="row g6">
            <button className="btn btn-s btn-sm" data-od-id="cta-archive" type="button" onClick={onArchive}>作为素材入库</button>
          </div>
        </div>
      ) : null}

      {/* 输入图 Asset ID(与连线二选一,保留原能力) */}
      <div className="f-sec" style={running ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
        <div className="f-sec-h"><span className="lbl">输入图 Asset ID(与连线二选一)</span></div>
        <input
          className="f-in full mono"
          placeholder="asset-…"
          value={inputAssetId}
          onChange={(e) => setData({ inputAssetId: e.target.value })}
        />
      </div>

      {frameSrc?.videoNodeId ? (
        <div className="f-sec" style={running ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
          <div className="f-sec-h"><span className="lbl">取帧</span></div>
          <div className="row g6">
            {(['first', 'last'] as const).map((at) => (
              <span
                key={at}
                className={`chip${(frameSrc.at ?? 'first') === at ? ' on' : ''}`}
                onClick={() => setData({ inputFrameSource: { videoNodeId: frameSrc.videoNodeId, at } })}
              >
                {at === 'first' ? '首帧' : '尾帧'}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div style={running ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
        <div className="f-sec">
          <div className="f-sec-h"><span className="lbl">编辑指令</span><span className="mut" style={{ fontSize: 10.5 }}>告诉模型「改什么」</span></div>
          <textarea
            className="f-ta"
            rows={3}
            placeholder="把背景换成日落,保留主体"
            value={prompt}
            onChange={(e) => setData({ prompt: e.target.value })}
          />
        </div>

        {mode === 'img2img' ? (
          <ImageStrengthField value={imageStrength} onChange={(v) => setData({ imageStrength: v })} />
        ) : null}

        {mode === 'inpaint' ? (
          <MaskField
            baseSrc={up.src}
            maskAssetId={maskAssetId}
            maskSrc={maskAssetId && assetCache[maskAssetId] ? previewUrlOf(assetCache[maskAssetId]) : null}
            onSave={(dataUrl) => {
              void window.bigbotart
                .savePngAsset({ name: `mask-${node.id}`, dataUrl, projectId: projectId ?? undefined, tags: ['遮罩'] })
                .then((r) => {
                  if (r.ok && r.assetId) {
                    setData({ maskAssetId: r.assetId });
                    toastMsg(`遮罩已保存为资产 ${r.assetId}`);
                  } else {
                    toastMsg(`遮罩保存失败:${r.error ?? ''}`);
                  }
                })
                .catch(() => toastMsg('遮罩保存失败'));
            }}
            onClear={() => setData({ maskAssetId: '' })}
            onChangeAssetId={(v) => setData({ maskAssetId: v })}
            toastMsg={toastMsg}
          />
        ) : null}

        {mode === 'outpaint' ? (
          <OutpaintPads
            sides={outpaintSides}
            inputW={inputDims.w}
            inputH={inputDims.h}
            onChange={(sides) => setData({ outpaintSides: sides })}
          />
        ) : null}

        <div className="f-sec">
          <div className="f-sec-h"><span className="lbl">模型</span></div>
          <ModelCombo value={model} onChange={(v) => setData({ model: v })} disabled={running} />
        </div>

        {/* 采样步数:编辑原本没有该控件,导致编辑质量被静默固定在模型自身默认步数
            (实测 2026-09:flux.2-klein / z-image 不传 --steps 时都是 4 步,对去水印、改动作
            这类细活明显不够)。现在默认 30 并**写回 data**(见上方 DEFAULT_EDIT_STEPS 注释),
            滑块显示几步就实跑几步;拖动即覆盖。min 保留下限 4 以兼容存量节点里的小步数 */}
        <div className="f-sec">
          <div className="f-sec-h">
            <span className="lbl">采样</span>
            <span className="mut" style={{ fontSize: 10.5 }}>默认 {DEFAULT_EDIT_STEPS} 步 · 拖动可覆盖</span>
          </div>
          <div className="f-row">
            <span className="f-lbl">steps</span>
            <div className="range" style={{ flex: 1, minWidth: 120 }}>
              <input
                type="range"
                min={4}
                max={50}
                value={steps}
                disabled={running}
                onChange={(e) => setData({ steps: Number(e.target.value) })}
              />
              <span className="val mono">{steps}</span>
            </div>
          </div>
        </div>
      </div>

      <KVSection
        rows={[
          ['引擎', 'mlxgen · generate 子命令'],
          ['路由', mode === 'instruction' ? 'edit-reference(自动)' : mode === 'img2img' ? 'latent img2img' : mode === 'inpaint' ? 'masked-edit' : 'outpaint'],
          ['输入', inputAssetId ? 'Asset 直绑' : frameSrc ? 'shot 抽帧' : imgFrom ? '上游直通' : '待绑定'],
        ]}
      />

      <ImageTakeSection
        node={node}
        projectId={projectId}
        jobs={jobs}
        onSelectTake={onSelectTake}
        toastMsg={toastMsg}
      />

      {/* 运行行动条放最底部,与检查器面板的「仅重跑该节点」按钮相邻;措辞与其他检查器统一为「运行」 */}
      <ActionBar
        primary={() => runNode(node.id)}
        primaryLabel={hasTake ? '重新运行' : '运行'}
        primaryIcon={hasTake ? 'regen' : 'gen'}
        disabled={!canSubmit}
        hint={submitHint}
      />
    </div>
  );
}