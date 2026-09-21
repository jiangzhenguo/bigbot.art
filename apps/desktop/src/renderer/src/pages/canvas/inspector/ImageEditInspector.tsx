/**
 * ImageEditInspector — 图片编辑节点检查器(对齐设计稿 ④/⑤/⑥/⑦/⑩)
 * 模式 chips(instruction / img2img / inpaint / outpaint)+ 各自专属参数区:
 *   img2img → 图像强度滑块(→ --i2i-mode latent + --image-strength)
 *   inpaint → 可视化遮罩(拖入 PNG / 框选生成 → 保存为遮罩资产 → --mask-path)
 *   outpaint → 四边 padding(→ --outpaint-padding top,right,bottom,left)
 */
import React, { useEffect, useState } from 'react';
import type { RenderJob } from '@bigbotart/shared';
import type { CanvasNode } from '../types';
import { ImageTakeSection } from './ImageTakeSection';
import { KVSection } from './fields';
import { ModelCombo, matchModel } from './ModelCombo';
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

export function ImageEditInspector(p: ImageEditInspectorProps) {
  const { node, setData, jobs, projectId, nodes, assetCache, runNode, toastMsg, onSelectTake } = p;
  const d = (node.data ?? {}) as Record<string, unknown>;
  const mode = String(d.mode ?? 'instruction');
  const model = String(d.model ?? 'mlx-community/Qwen-Image-Edit-8bit');
  const prompt = String(d.prompt ?? '');
  const inputAssetId = String(d.inputAssetId ?? '');
  const maskAssetId = String(d.maskAssetId ?? '');
  const imageStrength = Number(d.imageStrength ?? 0.5);
  const outpaintSides = (d.outpaintSides as { top: number; right: number; bottom: number; left: number } | undefined)
    ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const frameSrc = d.inputFrameSource as { videoNodeId?: string; at?: 'first' | 'last' } | undefined;
  const imgFrom = d.inputImageFrom as { nodeId?: string } | undefined;
  const hasTake = !!d.currentTakeId || !!String(d.resultPath ?? '');
  const running = jobs.some((j) => j.nodeId === node.id && j.status === 'running');

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
            <span key={m.key} className={`chip${mode === m.key ? ' on' : ''}`} onClick={() => setData({ mode: m.key })}>
              {m.label}
              <span className="small mono">{m.mono}</span>
            </span>
          ))}
        </div>
      </div>

      <UpstreamCard label={up.label} sub={up.sub} src={up.src} pill={up.pill} />

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
      </div>

      <KVSection
        rows={[
          ['引擎', 'mlxgen · generate 子命令'],
          ['路由', mode === 'instruction' ? 'edit-reference(自动)' : mode === 'img2img' ? 'latent img2img' : mode === 'inpaint' ? 'masked-edit' : 'outpaint'],
          ['输入', inputAssetId ? 'Asset 直绑' : frameSrc ? 'shot 抽帧' : imgFrom ? '上游直通' : '待绑定'],
        ]}
      />

      <ActionBar
        primary={() => runNode(node.id)}
        primaryLabel={hasTake ? '重新编辑' : '编辑'}
        primaryIcon={hasTake ? 'regen' : 'gen'}
        disabled={!canSubmit}
        secondary="保存预设"
        onSecondary={() => toastMsg('预设保存规划中 · 后续版本开放')}
        hint={submitHint}
      />

      <ImageTakeSection
        node={node}
        projectId={projectId}
        jobs={jobs}
        onSelectTake={onSelectTake}
        toastMsg={toastMsg}
      />
    </div>
  );
}