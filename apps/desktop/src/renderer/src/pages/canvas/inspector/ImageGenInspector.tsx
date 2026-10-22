/**
 * ImageGenInspector — 图片生成节点检查器(对齐设计稿 ①/②/③/⑧/⑨)
 * 提示词 + 负向提示词 + 模型下拉 + 画幅预设 + 采样滑块 + seed chips + 生成行动 + 产物预览
 */
import React, { useEffect, useState } from 'react';
import type { RenderJob } from '@bigbotart/shared';
import type { CanvasNode } from '../types';
import { ImagePreview } from './ImagePreview';
import { ImageTakeSection } from './ImageTakeSection';
import { useTakeResult } from './useTakeResult';
import { KVSection } from './fields';
import { ModelCombo, matchModel } from './ModelCombo';
import { capabilityOf, resolveImageModel, defaultGenerateSteps } from '@bigbotart/shared';
import { useToolModels } from '../tool-models-store';
import { GenStatePanel } from './GenState';
import { AspectPresets, SeedEditor, StepsGuidanceField, ActionBar } from './image-ui';
import { previewUrlOf } from '../media';
import { SaveToLibraryButton } from './SaveToLibraryButton';

export interface ImageGenInspectorProps {
  node: CanvasNode;
  setData: (patch: Record<string, unknown>) => void;
  jobs: RenderJob[];
  projectId: string | null;
  runNode: (nodeId: string) => void;
  toastMsg: (m: string) => void;
  onSelectTake?: (t: { id: string; attempt: number; status: string; resultPath?: string }) => void;
  /** 入库后刷新画布侧资产清单 */
  onSaved?: () => void;
}

export function ImageGenInspector(p: ImageGenInspectorProps) {
  const { node, setData, jobs, projectId, runNode, toastMsg, onSelectTake, onSaved } = p;
  const d = (node.data ?? {}) as Record<string, unknown>;
  // 未显式选模型时显示缺省解析结果(设置页工具模型 > 内置默认;2026-09-29 v1)
  // ⚠️ 必须用订阅式 useToolModels(2026-10-14):getToolModelsSync 冷启动时缓存未加载,
  //    会显示内置默认 z-image 而非设置页配置的模型(实际提交是对的,显示在说谎)。
  const toolModels = useToolModels();
  // 有 ref-image 入边时缺省走参考编辑(image.instruction → 2.1),不是 Klein multi-reference
  const hasRefImages = Array.isArray(d.refImageFrom) && (d.refImageFrom as unknown[]).length > 0;
  const model =
    String(d.model ?? '').trim() ||
    (resolveImageModel(toolModels, capabilityOf('image-gen', undefined, hasRefImages)) ?? '');
  const prompt = String(d.prompt ?? '');
  const negative = String(d.negativePrompt ?? '');
  const w = Number(d.width ?? 1024);
  const h = Number(d.height ?? 1024);
  // 缺省步数按解析出的模型走(2026-10-14):Turbo=8 / Qwen-2.1=40 / 其它=24,
  // 与 provider 同一份表(defaultGenerateSteps);节点创建不再写死 steps:24
  const steps = Number(d.steps ?? defaultGenerateSteps(model));
  const guidance = Number(d.guidance ?? 1.0);
  const seeds = Array.isArray(d.seeds) ? (d.seeds as number[]) : [];
  // 产物路径:节点 data 优先,缺失时回退 Take 历史里最新成功产物(2026-09-29 事故修复)
  const resultPath = useTakeResult(node.id, projectId, d.resultPath, jobs) ?? '';
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
            <SaveToLibraryButton
              projectId={projectId}
              items={[{ nodeId: node.id, path: resultPath, name: node.title, caption: prompt }]}
              toastMsg={toastMsg}
              onSaved={onSaved}
            />
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
        {hasRefImages ? (
          <div className="f-hint" style={{ marginTop: 6 }}>
            已连参考图 · 缺省走 Qwen-Image-2.1 参考编辑(指令驱动);要「首图定构图」的多参考生成请显式选 Flux.2 Klein
          </div>
        ) : null}
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

      <ImageTakeSection
        node={node}
        projectId={projectId}
        jobs={jobs}
        onSelectTake={onSelectTake}
        toastMsg={toastMsg}
      />

      {/* 运行行动条放最底部,与检查器面板的「仅重跑该节点」按钮相邻(「保存预设」未实现已下线) */}
      <ActionBar
        primary={() => runNode(node.id)}
        primaryLabel={hasTake ? '重新生成' : '生成'}
        primaryIcon={hasTake ? 'regen' : 'gen'}
        disabled={running}
      />
    </div>
  );
}