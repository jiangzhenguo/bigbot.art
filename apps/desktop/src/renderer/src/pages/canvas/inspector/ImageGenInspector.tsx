/**
 * ImageGenInspector — 图片生成节点检查器(对齐设计稿 ①/②/③/⑧/⑨)
 * 提示词 + 负向提示词 + 模型下拉 + 画幅预设 + 采样滑块 + seed chips + 生成行动 + 产物预览
 */
import React, { useEffect, useState } from 'react';
import type { RenderJob } from '@bigbotart/shared';
import type { CanvasNode } from '../types';
import { ImagePreview } from './ImagePreview';
import { ImageTakeSection } from './ImageTakeSection';
import { KVSection } from './fields';
import { ModelCombo, matchModel } from './ModelCombo';
import { GenStatePanel } from './GenState';
import { AspectPresets, SeedEditor, StepsGuidanceField, ActionBar } from './image-ui';
import { previewUrlOf } from '../media';

export interface ImageGenInspectorProps {
  node: CanvasNode;
  setData: (patch: Record<string, unknown>) => void;
  jobs: RenderJob[];
  projectId: string | null;
  runNode: (nodeId: string) => void;
  toastMsg: (m: string) => void;
  onSelectTake?: (t: { id: string; attempt: number; status: string; resultPath?: string }) => void;
}

export function ImageGenInspector(p: ImageGenInspectorProps) {
  const { node, setData, jobs, projectId, runNode, toastMsg, onSelectTake } = p;
  const d = (node.data ?? {}) as Record<string, unknown>;
  const model = String(d.model ?? 'AbstractFramework/z-image-turbo-8bit');
  const prompt = String(d.prompt ?? '');
  const negative = String(d.negativePrompt ?? '');
  const w = Number(d.width ?? 1024);
  const h = Number(d.height ?? 1024);
  const steps = Number(d.steps ?? 24);
  const guidance = Number(d.guidance ?? 1.0);
  const seeds = Array.isArray(d.seeds) ? (d.seeds as number[]) : [];
  const resultPath = String(d.resultPath ?? '');
  const hasTake = !!d.currentTakeId || !!resultPath;

  const running = jobs.some((j) => j.nodeId === node.id && j.status === 'running');
  const [modelReady, setModelReady] = useState<boolean>(true);
  useEffect(() => {
    const repo = matchModel(model)?.repoId;
    if (!repo) return;
    void window.bigbotart.mlxgenModels().then((list) => setModelReady(!!list.find((m) => m.repoId === repo)?.downloaded)).catch(() => {});
  }, [model]);

  const onDownloadModel = () => {
    const repo = matchModel(model)?.repoId;
    if (!repo) { toastMsg(`当前为自定义模型 ${model},请到设置页下载`); return; }
    void window.bigbotart.mlxgenDownload(repo).then((r) => toastMsg(r.ok ? `已开始下载 ${repo} · 完成后点重新生成` : `下载启动失败:${r.error ?? ''}`));
  };
  const onArchive = () => {
    if (!projectId || !resultPath) { toastMsg('暂无产物可入库'); return; }
    void window.bigbotart
      .archiveProducts({ projectId, items: [{ nodeId: node.id, path: resultPath }] })
      .then((r) => toastMsg(r.ok ? `已归档 ${r.assets.length} 项到资产库` : `归档失败:${r.error ?? ''}`))
      .catch(() => toastMsg('归档失败'));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <GenStatePanel
        node={node}
        jobs={jobs}
        takesCount={hasTake ? 1 : 0}
        runNode={runNode}
        toastMsg={toastMsg}
        modelDownloaded={modelReady}
        onDownloadModel={onDownloadModel}
      />

      {resultPath ? (
        <div className="kv">
          <div className="f-sec-h"><span className="lbl">产物预览</span><span className="mut" style={{ fontSize: 10.5 }}>{hasTake ? 'Take · 可点下方历史切换' : ''}</span></div>
          <ImagePreview src={previewUrlOf(resultPath)} label="" />
          <div className="row g6">
            <button className="btn btn-s btn-sm" data-od-id="cta-archive" type="button" onClick={onArchive}>作为素材入库</button>
          </div>
        </div>
      ) : null}

      <div style={running ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
        <div className="f-sec">
          <div className="f-sec-h"><span className="lbl">提示词</span></div>
          <textarea
            className="f-ta"
            rows={4}
            placeholder="晨雾弥漫的针叶林,远处湖面反射柔光,电影感广角"
            value={prompt}
            onChange={(e) => setData({ prompt: e.target.value })}
          />
        </div>
        <div className="f-sec">
          <div className="f-sec-h"><span className="lbl">负向提示词</span><span className="mut" style={{ fontSize: 10.5 }}>→ <code>--negative-prompt</code> · 蒸馏模型不支持会报错</span></div>
          <textarea
            className="f-ta short mono"
            rows={2}
            placeholder="低饱和,模糊,变形,水印"
            value={negative}
            onChange={(e) => setData({ negativePrompt: e.target.value })}
          />
        </div>
      </div>

      <div className="f-sec">
        <div className="f-sec-h"><span className="lbl">模型</span><span className="mut" style={{ fontSize: 10.5 }}>来自 capabilities().models</span></div>
        <ModelCombo value={model} onChange={(v) => setData({ model: v })} disabled={running} />
      </div>

      <AspectPresets
        width={w}
        height={h}
        disabled={running}
        onChange={(patch) => setData({ ...patch })}
      />

      <StepsGuidanceField
        steps={steps}
        guidance={guidance}
        disabled={running}
        onChange={(patch) => setData({ ...patch })}
      />

      <SeedEditor
        seeds={seeds}
        disabled={running}
        onChange={(v) => setData({ seeds: v })}
      />

      <KVSection
        rows={[
          ['引擎', 'mlxgen'],
          ['产物', `${Math.max(1, seeds.length)} × PNG · ${w}×${h}`],
          ['预计', `≈ ${Math.round(8 + seeds.length * 30)} 秒 · 显存 ≈ 12 GB`],
        ]}
      />

      <ActionBar
        primary={() => runNode(node.id)}
        primaryLabel={hasTake ? '重新生成' : '生成'}
        primaryIcon={hasTake ? 'regen' : 'gen'}
        disabled={running}
        secondary="保存预设"
        onSecondary={() => toastMsg('预设保存规划中 · 后续版本开放')}
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