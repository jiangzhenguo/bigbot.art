import React from 'react';
import type { RenderJob, Asset, TimelineData, PromptSource } from '@bigbotart/shared';
import type { CanvasNode } from '../types';
import { ShotInspector } from './ShotInspector';
import { TimelineInspector } from './TimelineInspector';
import DocumentInspector from './DocumentInspector';
import StoryboardInspector from './StoryboardInspector';
import { ImageTakeSection } from './ImageTakeSection';
import { KVSection, Lbl, TextAreaField } from './fields';
import { ImagePreview } from './ImagePreview';
import { CropTakePreview } from './CropTakePreview';
import { previewUrlOf } from '../media';
import { ImageGenInspector } from './ImageGenInspector';
import { ImageEditInspector } from './ImageEditInspector';
import { MediaInfoPanel } from './MediaInfoPanel';
import { AssetInspector } from './AssetInspector';

export interface InspectorBodyProps {
  node: CanvasNode | undefined;
  infoMap: Record<string, { t: string; img: string | null; meta: Array<[string, string]> }>;
  setInfoMap: React.Dispatch<React.SetStateAction<Record<string, { t: string; img: string | null; meta: Array<[string, string]> }>>>;
  setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>;
  /** 撤销提交:参数编辑 = 一次离散编辑动作(记入历史,label 显示在撤销提示里) */
  onCommitEdit?: (label: string) => void;
  toastMsg: (msg: string) => void;
  projectId: string | null;
  activeCanvasId: string | null;
  jobs: RenderJob[];
  assetsList: Asset[];
  assetCache: Record<string, string>;
  runNode: (nodeId: string) => void;
  /** 当前画布全部节点(给 timeline 检查器查 shot 标题/Take 用) */
  nodes?: CanvasNode[];
  /** 跳到时间线页面 */
  onOpenTimelinePage?: () => void;
  /** 删除一条边(timeline 检查器「移出时间线」= 断开对应连线) */
  onRemoveEdge?: (sourceId: string, targetId: string) => void;
  /** 分镜表:铺节点(只建不跑) */
  onMaterializeStoryboard?: (sbNode: CanvasNode, aspect: string, tier: string) => void;
  /** 分镜表:整体撤销铺节点 */
  onUndoStoryboard?: (sbNode: CanvasNode) => void;
  /** 分镜表:按当前表重组提示词写回 */
  onResyncStoryboard?: (sbNode: CanvasNode) => void;
  /** 文档节点:「生成分镜表」→ Agent plan-storyboard */
  onPlanStoryboard?: (docNode: CanvasNode) => void;
  /** asset 节点:「从资源库选择…」→ 打开资产选择弹层 */
  onOpenAssetPicker?: (nodeId: string) => void;
}

export function InspectorBody({
  node,
  infoMap,
  setInfoMap,
  setNodes,
  onCommitEdit,
  toastMsg,
  projectId,
  activeCanvasId,
  jobs,
  assetsList,
  assetCache,
  runNode,
  nodes,
  onOpenTimelinePage,
  onRemoveEdge,
  onMaterializeStoryboard,
  onUndoStoryboard,
  onResyncStoryboard,
  onPlanStoryboard,
  onOpenAssetPicker,
}: InspectorBodyProps) {
  if (!node) return <div className="mut" style={{ fontSize: 12 }}>选中画布上的节点查看与编辑参数</div>;
  const d = (node.data ?? {}) as Record<string, unknown>;
  const setData = (patch: Record<string, unknown> | Partial<TimelineData>) => {
    onCommitEdit?.(`修改「${node.title}」参数`);
    setNodes((ns) => ns.map((n) => (n.id === node.id ? { ...n, data: { ...(n.data ?? {}), ...patch } } : n)));
  };
  const info = infoMap[node.id];
  const setInfo = (patch: Partial<{ t: string; img: string | null; meta: Array<[string, string]> }>) => {
    setInfoMap((m) => ({ ...m, [node.id]: { ...(m[node.id] ?? { t: node.title, img: null, meta: [] }), ...patch } }));
  };
  /** 图片节点切换 Take → 回写画布节点(产物预览 + 绑定标记;与 shot 检查器 onSelectTake 同语义) */
  const selectImageTake = (t: { id: string; attempt: number; status: string; resultPath?: string; pieces?: string[] }) => {
    onCommitEdit?.(`切换「${node.title}」的 Take`);
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== node.id) return n;
        const name = t.resultPath?.replace(/\\/g, '/').split('/').pop();
        return {
          ...n,
          ghost: t.status === 'succeeded' ? !t.resultPath : n.ghost,
          stale: false,
          badge: undefined,
          extra: t.resultPath
            ? `✓ ${t.pieces?.length ? `${t.pieces.length} 片 · ` : ''}${name}`
            : t.status === 'succeeded'
              ? '✓·无产物'
              : t.status === 'failed'
                ? '失败'
                : n.extra,
          data: {
            ...(n.data ?? {}),
            currentTakeId: t.id,
            resultPath: t.resultPath ?? undefined,
            // image-split:切换 Take 同步恢复该片组(piece-N 下游取片以 data.pieces 为准)
            ...(t.pieces ? { pieces: t.pieces } : {}),
          },
        };
      }),
    );
  };

  switch (node.kind) {
    case 'document': {
      return (
        <DocumentInspector
          node={node}
          setData={setData}
          toastMsg={toastMsg}
          onPlanStoryboard={onPlanStoryboard}
        />
      );
    }
    case 'storyboard': {
      return (
        <StoryboardInspector
          node={node}
          setData={setData}
          nodes={nodes ?? []}
          toastMsg={toastMsg}
          onMaterializeStoryboard={onMaterializeStoryboard}
          onUndoStoryboard={onUndoStoryboard}
          onResyncStoryboard={onResyncStoryboard}
        />
      );
    }
    case 'asset': {
      return (
        <AssetInspector
          node={node}
          setData={setData}
          toastMsg={toastMsg}
          assetCache={assetCache}
          onOpenAssetPicker={onOpenAssetPicker}
          meta={info?.meta}
        />
      );
    }
    case 'image-gen': {
      return (
        <ImageGenInspector
          node={node}
          setData={setData}
          jobs={jobs}
          projectId={projectId}
          runNode={runNode}
          toastMsg={toastMsg}
          onSelectTake={selectImageTake}
        />
      );
    }
    case 'image-edit': {
      return (
        <ImageEditInspector
          node={node}
          setData={setData}
          jobs={jobs}
          projectId={projectId}
          nodes={nodes ?? []}
          assetCache={assetCache}
          assetsList={assetsList}
          runNode={runNode}
          toastMsg={toastMsg}
          onSelectTake={selectImageTake}
        />
      );
    }
    case 'image-upscale': {
      const scale = Number(d.scale ?? 2);
      const model = String(d.model ?? 'AbstractFramework/seedvr2-3b-8bit');
      const upscaleResult = String(d.resultPath ?? '');
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* 产物预览置顶:此前该检查器完全没有预览块,产物只能靠底部 Take 历史看;
              统一到与其它图片节点一致 —— 点中节点即见增强结果 */}
          <ImagePreview src={upscaleResult ? previewUrlOf(upscaleResult) : null} label="增强结果" emptyHint="运行后显示增强结果" />
          <div>
            <Lbl>放大倍数</Lbl>
            <div className="row g6">
              {[2, 4].map((s) => (
                <span key={s} className={`chip${scale === s ? ' on' : ''}`} onClick={() => setData({ scale: s })}>
                  ×{s}
                </span>
              ))}
            </div>
          </div>
          <div>
            <Lbl>模型</Lbl>
            <input className="input-w mono" value={model} onChange={(e) => setData({ model: e.target.value })} style={{ width: '100%' }} />
          </div>
          <KVSection rows={[['引擎', 'mlxgen · SeedVR2'], ['输入', '来自上游节点产物或 asset']]} />
          <ImageTakeSection node={node} projectId={projectId} jobs={jobs} onSelectTake={selectImageTake} toastMsg={toastMsg} />
        </div>
      );
    }
    case 'video-upscale': {
      const scale = Number(d.scale ?? 2);
      const superRes = String(d.superRes ?? 'realesrgan');
      const srModel = String(d.srModel ?? 'realesrgan-x4plus');
      const faceModel = String(d.faceModel ?? 'gfpgan');
      const faceWeight = Number(d.faceWeight ?? 0.5);
      const fidelityWeight = Number(d.fidelityWeight ?? 0.7);
      const deblock = d.deblock === true;
      const device = String(d.device ?? 'mps');
      const inputAssetId = String(d.inputAssetId ?? '');
      const vidFrom = d.inputVideoFrom as { nodeId?: string } | undefined;
      const outPath = String(d.resultPath ?? '');
      const applied = (d.appliedStages as string[] | undefined) ?? [];
      // 输入视频路径:Asset ID 直绑 → 连线上游(asset 取资产,其余取产物)
      const srcPath = (() => {
        if (inputAssetId && assetCache[inputAssetId]) return assetCache[inputAssetId];
        if (vidFrom?.nodeId) {
          const up = (nodes ?? []).find((x) => x.id === vidFrom.nodeId);
          const upData = (up?.data ?? {}) as Record<string, unknown>;
          if (up?.kind === 'asset') {
            const aid = String(upData.assetId ?? '');
            if (aid && assetCache[aid]) return assetCache[aid];
          }
          return String(upData.resultPath ?? '') || null;
        }
        return null;
      })();
      const noSuperRes = superRes === 'none' || scale <= 1;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* 长任务进行中:检查器里给一块显眼的整体进度(节点卡可能不在视野内) */}
          {node.progress ? (
            <div className="vpost-progress" data-od-id="vpost-progress">
              <div className="row1">
                <span className="spin"></span>
                {node.progress.stage ? <span className="vp-stage">{node.progress.stage}</span> : null}
                <span>{node.progress.text}</span>
                {node.progress.pct !== undefined ? (
                  <span className="vp-pct">{Math.round(node.progress.pct * 100)}%</span>
                ) : null}
              </div>
              <span className={`pbar${node.progress.indet ? ' indet' : ''}`}>
                {node.progress.indet ? (
                  <i></i>
                ) : (
                  <i className="fill" style={{ width: `${Math.round((node.progress.pct ?? 0) * 100)}%` }}></i>
                )}
              </span>
            </div>
          ) : null}
          {/* 产物预览置顶:增强结果优先于源视频,都没有时下面给「连一个镜头/视频素材」的提示。
              此前这块压在整套超分/修脸参数之后,点中节点要一路滚到底才看得到结果 */}
          {outPath ? (
            <div>
              <Lbl>增强结果</Lbl>
              <video
                src={previewUrlOf(outPath) ?? ''}
                controls
                muted
                preload="metadata"
                style={{ width: '100%', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-soft)', background: '#000' }}
              />
              <div className="mono mut" style={{ fontSize: 11, marginTop: 4 }}>
                {d.width && d.height ? `${d.width}×${d.height}` : ''}
                {d.durationSec ? ` · ${d.durationSec}s` : ''}
              </div>
            </div>
          ) : srcPath ? (
            <div>
              <Lbl>源视频预览</Lbl>
              <video
                src={previewUrlOf(srcPath) ?? ''}
                controls
                muted
                preload="metadata"
                style={{ width: '100%', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-soft)', background: '#000' }}
              />
            </div>
          ) : null}
          <div>
            <Lbl>放大倍数</Lbl>
            <div className="row g6">
              {[1, 2, 3, 4].map((s) => (
                <span key={s} className={`chip${scale === s ? ' on' : ''}`} onClick={() => setData({ scale: s })}>
                  {s === 1 ? '×1 · 仅修脸' : `×${s}`}
                </span>
              ))}
            </div>
            <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>
              ×1(仅修脸不超分)可完全避免超分引起的运动方格(POST_PROCESSING.md §5.4 方案 C)
            </div>
          </div>
          <div>
            <Lbl>超分引擎</Lbl>
            <div className="row g6" style={{ flexWrap: 'wrap' }}>
              {([
                ['realesrgan', 'Real-ESRGAN'],
                ['none', '不超分'],
              ] as const).map(([v, label]) => (
                <span key={v} className={`chip${superRes === v ? ' on' : ''}`} onClick={() => setData({ superRes: v })}>
                  {label}
                </span>
              ))}
            </div>
          </div>
          {!noSuperRes && (
            <div>
              <Lbl>超分模型</Lbl>
              <div className="row g6" style={{ flexWrap: 'wrap' }}>
                {([
                  ['realesrgan-x4plus', '真人 / 照片'],
                  ['realesr-animevideov3', '动漫 / 插画'],
                  ['realesrgan-x4plus-anime', '动漫插画 · 锐边'],
                ] as const).map(([v, label]) => (
                  <span key={v} className={`chip${srModel === v ? ' on' : ''}`} onClick={() => setData({ srModel: v })}>
                    {label}
                  </span>
                ))}
              </div>
              <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>
                真人视频务必用 realesrgan-x4plus:动漫模型(animevideov3)对真人会产生方格
              </div>
            </div>
          )}
          <div>
            <Lbl>修脸模型</Lbl>
            <div className="row g6" style={{ flexWrap: 'wrap' }}>
              {([
                ['gfpgan', 'GFPGAN'],
                ['codeformer', 'CodeFormer'],
                ['none', '不修脸'],
              ] as const).map(([v, label]) => (
                <span key={v} className={`chip${faceModel === v ? ' on' : ''}`} onClick={() => setData({ faceModel: v })}>
                  {label}
                </span>
              ))}
            </div>
            <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>
              GFPGAN 质量优先;CodeFormer 更保留原始身份(保真度可调),慢约 30%
            </div>
          </div>
          {faceModel === 'gfpgan' && (
            <div>
              <Lbl>修脸强度 {faceWeight.toFixed(2)}</Lbl>
              <input
                type="range"
                min={0}
                max={1}
                step={0.1}
                value={faceWeight}
                onChange={(e) => setData({ faceWeight: Number(e.target.value) })}
                style={{ width: '100%' }}
              />
              <div className="mut" style={{ fontSize: 11 }}>0.3 轻修保留特征 · 0.5 默认 · 0.7+ 强修(偏「网红脸」)</div>
            </div>
          )}
          {faceModel === 'codeformer' && (
            <div>
              <Lbl>保真度 {fidelityWeight.toFixed(2)}</Lbl>
              <input
                type="range"
                min={0}
                max={1}
                step={0.1}
                value={fidelityWeight}
                onChange={(e) => setData({ fidelityWeight: Number(e.target.value) })}
                style={{ width: '100%' }}
              />
              <div className="mut" style={{ fontSize: 11 }}>0.5 偏修复(更平滑)· 0.7 默认 · 0.9 偏保真(保留原始脸)</div>
            </div>
          )}
          <div className="row g6">
            <div style={{ flex: 1 }}>
              <Lbl>计算设备</Lbl>
              <div className="row g6">
                {([
                  ['mps', 'MPS'],
                  ['cpu', 'CPU'],
                ] as const).map(([v, label]) => (
                  <span key={v} className={`chip${device === v ? ' on' : ''}`} onClick={() => setData({ device: v })}>
                    {label}
                  </span>
                ))}
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <Lbl>压缩块修复</Lbl>
              <div className="row g6">
                <span className={`chip${deblock ? ' on' : ''}`} onClick={() => setData({ deblock: !deblock })}>
                  {deblock ? '✓ 去块已开' : '去块'}
                </span>
              </div>
            </div>
          </div>
          <div className="mut" style={{ fontSize: 11 }}>
            运动区有 8×8 方格时开去块:ffmpeg deblock + 高码率重编码,放在超分之前(否则块会被放大成方格)
          </div>
          <TextAreaField
            label="输入视频 Asset ID(与连线二选一)"
            value={inputAssetId}
            rows={1}
            placeholder="asset-…"
            onChange={(v) => setData({ inputAssetId: v })}
          />
          {vidFrom?.nodeId ? (
            <div>
              <Lbl>输入视频源(由连线直通)</Lbl>
              <div className="mono mut" style={{ fontSize: 11 }}>
                节点 {vidFrom.nodeId.slice(0, 10)} · 上游成片/素材直接作为增强源
              </div>
            </div>
          ) : (
            <div className="mut" style={{ fontSize: 11 }}>连一个 镜头(shot) 或 视频 asset 可自动作为增强源</div>
          )}
          <KVSection
            rows={[
              ['引擎', 'Real-ESRGAN + GFPGAN/CodeFormer · 本地后处理'],
              ['CPU', device === 'mps' ? 'Apple Silicon GPU(Metal)' : 'CPU(慢)'],
              ['耗时', '每帧 1.2-1.5s:5s 片约 3-4 分钟 · 20s 片 10-12 分钟'],
            ]}
          />
          {applied.length > 0 ? (
            <div>
              <Lbl>上次执行阶段</Lbl>
              <div className="mono mut" style={{ fontSize: 11 }}>
                {applied.map((s, i) => <div key={i}>{i + 1}. {s}</div>)}
              </div>
            </div>
          ) : null}
          {outPath ? (
            <div>
              <Lbl>增强结果</Lbl>
              <video
                src={previewUrlOf(outPath) ?? ''}
                controls
                muted
                preload="metadata"
                style={{ width: '100%', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-soft)', background: '#000' }}
              />
              <div className="mono mut" style={{ fontSize: 11, marginTop: 4 }}>
                {d.width && d.height ? `${d.width}×${d.height}` : ''}
                {d.durationSec ? ` · ${d.durationSec}s` : ''}
              </div>
            </div>
          ) : srcPath ? (
            <div>
              <Lbl>源视频预览</Lbl>
              <video
                src={previewUrlOf(srcPath) ?? ''}
                controls
                muted
                preload="metadata"
                style={{ width: '100%', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-soft)', background: '#000' }}
              />
            </div>
          ) : null}
          <ImageTakeSection node={node} projectId={projectId} jobs={jobs} onSelectTake={selectImageTake} toastMsg={toastMsg} />
        </div>
      );
    }
    case 'image-crop': {
      const aspect = String(d.aspect ?? '9:16');
      const focus = String(d.focus ?? 'center');
      const inputAssetId = String(d.inputAssetId ?? '');
      const imgFrom = d.inputImageFrom as { nodeId?: string } | undefined;
      // 源图路径:Asset ID 直绑 → 连线上游(asset 节点取资产,其余取产物)
      const cropSrc = (() => {
        if (inputAssetId && assetCache[inputAssetId]) return assetCache[inputAssetId];
        if (imgFrom?.nodeId) {
          const up = (nodes ?? []).find((x) => x.id === imgFrom.nodeId);
          const upData = (up?.data ?? {}) as Record<string, unknown>;
          if (up?.kind === 'asset') {
            const aid = String(upData.assetId ?? '');
            if (aid && assetCache[aid]) return assetCache[aid];
          }
          return String(upData.resultPath ?? '') || null;
        }
        return null;
      })();
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* 产物预览置顶:点中节点即可看到裁剪结果(未生成时回退源图),
              不必先滚过目标画幅/锚点这些参数 */}
          <CropTakePreview node={node} projectId={projectId} srcFallback={cropSrc} />
          <div>
            <Lbl>目标画幅</Lbl>
            <div className="row g6" style={{ flexWrap: 'wrap' }}>
              {(['16:9', '9:16', '1:1', '4:3', '3:4', '2:3'] as const).map((a) => (
                <span key={a} className={`chip${aspect === a ? ' on' : ''}`} onClick={() => setData({ aspect: a })}>
                  {a}
                </span>
              ))}
            </div>
          </div>
          <div>
            <Lbl>裁切锚点</Lbl>
            <div className="row g6" style={{ flexWrap: 'wrap' }}>
              {([
                ['center', '居中'],
                ['left', '靠左'],
                ['right', '靠右'],
                ['top', '靠上'],
                ['bottom', '靠下'],
              ] as const).map(([v, label]) => (
                <span key={v} className={`chip${focus === v ? ' on' : ''}`} onClick={() => setData({ focus: v })}>
                  {label}
                </span>
              ))}
            </div>
            <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>1:1 → 9:16 时横向裁切,left/right 决定保留左半/右半;其余锚点同理</div>
          </div>
          <TextAreaField label="输入图 Asset ID(与连线二选一)" value={inputAssetId} rows={1} placeholder="asset-…" onChange={(v) => setData({ inputAssetId: v })} />
          {imgFrom?.nodeId ? (
            <div>
              <Lbl>输入图源(由连线直通)</Lbl>
              <div className="mono mut" style={{ fontSize: 11 }}>节点 {imgFrom.nodeId.slice(0, 10)} · 上游产物/素材直接作为裁剪源</div>
            </div>
          ) : (
            <div className="mut" style={{ fontSize: 11 }}>连一个 图片生成/编辑/增强 节点或 asset 可自动作为裁剪源</div>
          )}
          <KVSection rows={[['引擎', 'ffmpeg · 不推理'], ['输出', `裁剪至 ${aspect} · 保持原分辨率`]]} />
          <ImageTakeSection node={node} projectId={projectId} jobs={jobs} onSelectTake={selectImageTake} toastMsg={toastMsg} />
        </div>
      );
    }
    case 'image-stitch': {
      const mode = String(d.mode ?? 'column');
      const gridCols = Number(d.gridCols ?? 3);
      const gap = Number(d.gap ?? 0);
      const bg = String(d.bg ?? 'white');
      const piecesFrom = (d.piecesFrom as Array<{ nodeId?: string }> | undefined) ?? [];
      const outPath = String(d.resultPath ?? '');
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* 产物预览置顶:点中节点即见拼接结果,不必先滚过拼接方式/列数/间距 */}
          <ImagePreview src={outPath ? previewUrlOf(outPath) : null} label="拼接结果" emptyHint="运行后显示拼接结果" />
          <div>
            <Lbl>拼接方式</Lbl>
            <div className="row g6" style={{ flexWrap: 'wrap' }}>
              {([
                ['row', '横排'],
                ['column', '竖排长图'],
                ['grid', '网格'],
              ] as const).map(([v, label]) => (
                <span key={v} className={`chip${mode === v ? ' on' : ''}`} onClick={() => setData({ mode: v })}>
                  {label}
                </span>
              ))}
            </div>
          </div>
          {mode === 'grid' && (
            <div>
              <Lbl>网格列数(行数按图片数自动)</Lbl>
              <div className="row g6" style={{ flexWrap: 'wrap' }}>
                {[2, 3, 4].map((c) => (
                  <span key={c} className={`chip${gridCols === c ? ' on' : ''}`} onClick={() => setData({ gridCols: c })}>
                    {c} 列
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="row g6">
            <div style={{ flex: 1 }}>
              <Lbl>间距(px)</Lbl>
              <input
                className="input-w mono"
                type="number"
                min={0}
                max={200}
                value={gap}
                onChange={(e) => setData({ gap: Math.max(0, Number(e.target.value) || 0) })}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <Lbl>底色</Lbl>
              <input
                className="input-w mono"
                value={bg}
                onChange={(e) => setData({ bg: e.target.value })}
                placeholder="white / #ffffff"
                style={{ width: '100%' }}
              />
            </div>
          </div>
          <div>
            <Lbl>拼接件(由连线直通 · {piecesFrom.length} 件)</Lbl>
            {piecesFrom.length > 0 ? (
              <div className="mono mut" style={{ fontSize: 11 }}>
                {piecesFrom.map((p, i) => {
                  const up = (nodes ?? []).find((x) => x.id === p.nodeId);
                  return <div key={`${p.nodeId}-${i}`}>{i + 1}. {up?.title ?? p.nodeId ?? '?'}</div>;
                })}
                <div style={{ marginTop: 4 }}>顺序按源节点画布位置排({mode === 'row' ? '从左到右' : '从上到下'}),拖动上游节点可改序</div>
              </div>
            ) : (
              <div className="mut" style={{ fontSize: 11 }}>连 2-16 个 图片节点 / asset 作为拼接件(多值 piece 端口)</div>
            )}
          </div>
          <KVSection rows={[['引擎', 'ffmpeg · 不推理'], ['对齐', '按最小边等比缩放(只缩不放)'], ['输出', mode === 'grid' ? `网格 · ${gridCols} 列` : mode === 'row' ? '横排长图' : '竖排长图']]} />
          <ImageTakeSection node={node} projectId={projectId} jobs={jobs} onSelectTake={selectImageTake} toastMsg={toastMsg} />
        </div>
      );
    }
    case 'image-split': {
      const mode = String(d.mode ?? 'grid');
      const count = Number(d.count ?? 3);
      const gridCols = Number(d.gridCols ?? 3);
      const gridRows = Number(d.gridRows ?? 3);
      const inputAssetId = String(d.inputAssetId ?? '');
      const imgFrom = d.inputImageFrom as { nodeId?: string } | undefined;
      const pieces = (d.pieces as string[] | undefined) ?? [];
      const splitSrc = (() => {
        if (inputAssetId && assetCache[inputAssetId]) return assetCache[inputAssetId];
        if (imgFrom?.nodeId) {
          const up = (nodes ?? []).find((x) => x.id === imgFrom.nodeId);
          const upData = (up?.data ?? {}) as Record<string, unknown>;
          if (up?.kind === 'asset') {
            const aid = String(upData.assetId ?? '');
            if (aid && assetCache[aid]) return assetCache[aid];
          }
          return String(upData.resultPath ?? '') || null;
        }
        return null;
      })();
      const pieceCount = mode === 'grid' ? gridCols * gridRows : count;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* 产物预览置顶:点中节点即见切片结果(未跑过时回退源图),不必先滚过拆分方式/份数 */}
          {pieces.length > 0 ? (
            <div>
              <Lbl>切片结果(共 {pieces.length} 片 · 按切分形态排布)</Lbl>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${mode === 'rows' ? 1 : mode === 'cols' ? count : gridCols}, 1fr)`, gap: 3, alignItems: 'start' }}>
                {pieces.map((p, i) => (
                  <div key={p} style={{ position: 'relative', borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--border-soft)' }}>
                    <img src={previewUrlOf(p) ?? ''} alt={`第 ${i + 1} 片`} style={{ display: 'block', width: '100%', height: 'auto', objectFit: 'contain' }} />
                    <span className="mono" style={{ position: 'absolute', left: 4, top: 2, fontSize: 10, color: 'var(--fg)', background: 'var(--surface-warm)', padding: '0 4px', borderRadius: 4 }}>{i + 1}</span>
                  </div>
                ))}
              </div>
              <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>下游取片:从本节点连出时在「取第 N 片」里选;不选默认第 1 片</div>
            </div>
          ) : (
            <ImagePreview src={splitSrc ? previewUrlOf(splitSrc) : null} label="源图预览" emptyHint="运行后显示切片结果 · 未运行时显示源图" />
          )}
          <div>
            <Lbl>拆分方式</Lbl>
            <div className="row g6" style={{ flexWrap: 'wrap' }}>
              {([
                ['rows', '横切(长图切片)'],
                ['cols', '竖切'],
                ['grid', '网格(九宫格)'],
              ] as const).map(([v, label]) => (
                <span key={v} className={`chip${mode === v ? ' on' : ''}`} onClick={() => setData({ mode: v })}>
                  {label}
                </span>
              ))}
            </div>
          </div>
          {mode !== 'grid' ? (
            <div>
              <Lbl>份数(2-16)</Lbl>
              <div className="row g6" style={{ flexWrap: 'wrap' }}>
                {[2, 3, 4, 6, 9].map((c) => (
                  <span key={c} className={`chip${count === c ? ' on' : ''}`} onClick={() => setData({ count: c })}>
                    {c}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div className="row g6">
              <div style={{ flex: 1 }}>
                <Lbl>列数</Lbl>
                <input className="input-w mono" type="number" min={1} max={8} value={gridCols}
                  onChange={(e) => setData({ gridCols: Math.min(8, Math.max(1, Number(e.target.value) || 1)) })} style={{ width: '100%' }} />
              </div>
              <div style={{ flex: 1 }}>
                <Lbl>行数</Lbl>
                <input className="input-w mono" type="number" min={1} max={8} value={gridRows}
                  onChange={(e) => setData({ gridRows: Math.min(8, Math.max(1, Number(e.target.value) || 1)) })} style={{ width: '100%' }} />
              </div>
            </div>
          )}
          <TextAreaField label="输入图 Asset ID(与连线二选一)" value={inputAssetId} rows={1} placeholder="asset-…" onChange={(v) => setData({ inputAssetId: v })} />
          {imgFrom?.nodeId ? (
            <div>
              <Lbl>输入图源(由连线直通)</Lbl>
              <div className="mono mut" style={{ fontSize: 11 }}>节点 {imgFrom.nodeId.slice(0, 10)} · 上游产物/素材直接作为拆分源</div>
            </div>
          ) : (
            <div className="mut" style={{ fontSize: 11 }}>连一个 图片节点 / asset 可自动作为拆分源</div>
          )}
          <KVSection rows={[['引擎', 'ffmpeg · 不推理'], ['输出', `等分 ${pieceCount} 片(末行/末列吃余数)`], ['下游取值', '连线选 piece-N = 取第 N 片']]} />
          <ImageTakeSection node={node} projectId={projectId} jobs={jobs} onSelectTake={selectImageTake} toastMsg={toastMsg} />
        </div>
      );
    }
    case 'frame-grab': {
      /* 视频裁切取帧:从视频截一帧 → 导入资产库 + 产物是图片(供 image-edit/upscale/参考图下游)。
         不推理,ffmpeg 秒级完成;下游接的是**图片**,故与 image-crop 同类。 */
      const mode = String(d.mode ?? 'first');
      const seconds = Number(d.seconds);
      const atInvalid = mode === 'at' && (!Number.isFinite(seconds) || seconds < 0);
      const inputAssetId = String(d.inputAssetId ?? '');
      const vFrom = d.inputVideoFrom as { nodeId?: string } | undefined;
      const outPath = String(d.resultPath ?? '');
      const resultAssetId = String(d.resultAssetId ?? '');
      /* 视频源预览:资产直取本地路径;连线上游取 resultPath */
      const srcVideo = (() => {
        if (inputAssetId && assetCache[inputAssetId]) return assetCache[inputAssetId];
        if (vFrom?.nodeId) {
          const up = (nodes ?? []).find((x) => x.id === vFrom.nodeId);
          const upData = (up?.data ?? {}) as Record<string, unknown>;
          if (up?.kind === 'asset') {
            const aid = String(upData.assetId ?? '');
            if (aid && assetCache[aid]) return assetCache[aid];
          }
          return String(upData.resultPath ?? '') || null;
        }
        return null;
      })();
      const srcLabel = vFrom?.nodeId
        ? (nodes ?? []).find((x) => x.id === vFrom.nodeId)?.title ?? vFrom.nodeId
        : inputAssetId
          ? `资产 ${inputAssetId.slice(0, 8)}`
          : '';
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* 产物预览置顶:点中节点即见取到的静帧,不必先滚过取帧位置/时间点 */}
          <ImagePreview src={outPath ? previewUrlOf(outPath) : null} label="取帧结果" emptyHint="运行后显示裁切出的静帧" />
          {resultAssetId ? (
            <div className="mut mono" style={{ fontSize: 11 }}>
              已入资产库 · {resultAssetId}
            </div>
          ) : null}
          <div>
            <Lbl>取帧位置</Lbl>
            <div className="row g6" style={{ flexWrap: 'wrap' }}>
              {([
                ['first', '首帧'],
                ['last', '尾帧'],
                ['at', '指定时间点'],
              ] as const).map(([v, label]) => (
                <span key={v} className={`chip${mode === v ? ' on' : ''}`} onClick={() => setData({ mode: v })}>
                  {label}
                </span>
              ))}
            </div>
          </div>
          {mode === 'at' && (
            <div>
              <Lbl>时间点(秒)</Lbl>
              <input
                className="input-w mono"
                type="number"
                min={0}
                step={0.1}
                value={Number.isFinite(seconds) ? seconds : 0}
                onChange={(e) => setData({ seconds: Math.max(0, Number(e.target.value) || 0) })}
                style={{ width: '100%' }}
              />
              <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>
                超出片长的位置取不到帧(会明确报错,不会静默产出空文件)
              </div>
            </div>
          )}
          <div>
            <Lbl>视频源(由连线直通{srcLabel ? ` · ${srcLabel}` : ''})</Lbl>
            {srcVideo ? (
              <video
                src={previewUrlOf(srcVideo) ?? ''}
                controls
                muted
                style={{ width: '100%', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-soft)' }}
              />
            ) : (
              <div className="mut" style={{ fontSize: 11 }}>
                连一个 镜头 / 视频增强 / 视频素材(asset) 作为取帧源 —— 产物是图片,可再交给 图片编辑 / 图片增强
              </div>
            )}
          </div>
          <KVSection
            rows={[
              ['引擎', 'ffmpeg · 不推理 · 秒级'],
              ['产物', 'PNG 静帧(自动导入资产库)'],
              ['下游', '图片编辑 / 图片增强 / 图片裁切 / 镜头首帧'],
            ]}
          />
          <ImageTakeSection node={node} projectId={projectId} jobs={jobs} onSelectTake={selectImageTake} toastMsg={toastMsg} />
        </div>
      );
    }
    case 'shot': {
      return (
        <ShotInspector
          node={node}
          setData={setData}
          onSelectTake={(take) => {
            onCommitEdit?.(`切换「${node.title}」的 Take`);
            setNodes((ns) =>
              ns.map((n) => {
                if (n.id !== node.id) return n;
                const name = take.resultPath?.replace(/\\/g, '/').split('/').pop();
                return {
                  ...n,
                  ghost: take.status === 'succeeded' ? !take.resultPath : n.ghost,
                  stale: false,
                  badge: undefined,
                  extra: take.resultPath
                    ? `✓ ${name}`
                    : take.status === 'succeeded'
                      ? '✓·无产物'
                      : take.status === 'failed'
                        ? '失败'
                        : n.extra,
                  data: {
                    ...(n.data ?? {}),
                    currentTakeId: take.id,
                    resultPath: take.resultPath ?? undefined,
                  },
                };
              }),
            );
          }}
          projectId={projectId}
          activeCanvasId={activeCanvasId}
          jobs={jobs}
          assetsList={assetsList}
          assetCache={assetCache}
          runNode={(id) => void runNode(id)}
          toastMsg={toastMsg}
        />
      );
    }
    case 'director': {
      const prompt = String(d.prompt ?? '');
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <TextAreaField label="导演 prompt(运镜小样)" value={prompt} rows={8} placeholder="机位：低机位仰拍 · 运动：推进 → 拉远 · 景别：中景" onChange={(v) => setData({ prompt: v })} />
          <KVSection rows={[['引擎', '复用 shot 低档(P1 占位)'], ['产物', '运镜参考小样视频']]} />
        </div>
      );
    }
    case 'timeline': {
      return (
        <TimelineInspector
          node={node}
          setData={(patch) => setData(patch as Record<string, unknown>)}
          nodes={nodes ?? []}
          projectId={projectId}
          activeCanvasId={activeCanvasId}
          jobs={jobs}
          toastMsg={toastMsg}
          onOpenTimelinePage={onOpenTimelinePage}
          onRemoveEdge={onRemoveEdge}
        />
      );
    }
    case 'audio-ref': {
      const assetId = String(d.assetId ?? '');
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <TextAreaField label="音频资产 ID" value={assetId} rows={1} placeholder="asset-…" onChange={(v) => setData({ assetId: v })} />
          <button
            className="btn btn-s btn-sm"
            onClick={() => {
              void window.bigbotart.listAssets().then((all) => {
                const opts = all.filter((a) => a.kind === 'audio' || a.kind === 'video');
                if (!opts.length) {
                  toastMsg('资产库里没有音频/视频资产');
                  return;
                }
                const first = opts[0]!;
                setData({ assetId: first.id });
                toastMsg(`已绑定:${first.name}`);
              });
            }}
          >
            绑定最新音频 / 视频资产
          </button>
          <KVSection rows={[['用途', '--ref-audio 带声直出']]} />
        </div>
      );
    }
    case 'workflow-input': {
      const slots = (d.slots as Array<{ name: string; accept: string[]; required: boolean; value?: unknown }>) ?? [];
      const updateSlot = (i: number, patch: Record<string, unknown>) => {
        const next = slots.map((s, j) => (j === i ? { ...s, ...patch } : s));
        setData({ slots: next });
      };
      const removeSlot = (i: number) => setData({ slots: slots.filter((_, j) => j !== i) });
      const addSlot = () =>
        setData({ slots: [...slots, { name: `槽位-${slots.length + 1}`, accept: ['text'], required: false }] });
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Lbl>输入槽位 ×{slots.length}</Lbl>
            {slots.map((s, i) => (
              <div key={i} style={{ border: '1px solid var(--border-soft)', borderRadius: 8, padding: '8px 10px', marginBottom: 6 }}>
                <div className="row g6">
                  <input
                    className="input-w mono"
                    value={s.name}
                    style={{ flex: 1, fontWeight: 600 }}
                    onChange={(e) => updateSlot(i, { name: e.target.value })}
                  />
                  <button className="btn btn-g btn-sm" onClick={() => removeSlot(i)}>×</button>
                </div>
                <div className="row g6" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                  {(['image', 'video', 'audio', 'document', 'text'] as const).map((t) => (
                    <span
                      key={t}
                      className={`chip${s.accept.includes(t) ? ' on' : ''}`}
                      style={{ fontSize: 10, padding: '2px 8px' }}
                      onClick={() => {
                        const has = s.accept.includes(t);
                        updateSlot(i, { accept: has ? s.accept.filter((x) => x !== t) : [...s.accept, t] });
                      }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
                <div className="row g6" style={{ marginTop: 6 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                    <input
                      type="checkbox"
                      checked={s.required}
                      onChange={(e) => updateSlot(i, { required: e.target.checked })}
                    />
                    必填
                  </label>
                  <span className="mono mut" style={{ fontSize: 10, marginLeft: 'auto' }}>
                    {s.value ? '已填充 ✓' : '未填充'}
                  </span>
                </div>
              </div>
            ))}
            <button className="btn btn-s btn-sm" onClick={addSlot}>＋ 添加槽位</button>
          </div>
          <KVSection rows={[['语义', '工作流入口 · 槽位注入下游节点 data']]} />
        </div>
      );
    }
    case 'workflow-output': {
      const outputs = (d.outputs as Array<{ name: string; kind: string; sourceNodeIds: string[] }>) ?? [];
      const updateOut = (i: number, patch: Record<string, unknown>) =>
        setData({ outputs: outputs.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
      const removeOut = (i: number) => setData({ outputs: outputs.filter((_, j) => j !== i) });
      const addOut = () =>
        setData({ outputs: [...outputs, { name: `产物-${outputs.length + 1}`, kind: 'video', sourceNodeIds: [] }] });
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Lbl>产物汇聚 ×{outputs.length}</Lbl>
            {outputs.map((o, i) => (
              <div key={i} style={{ border: '1px solid var(--border-soft)', borderRadius: 8, padding: '8px 10px', marginBottom: 6 }}>
                <div className="row g6">
                  <input
                    className="input-w mono"
                    value={o.name}
                    style={{ flex: 1, fontWeight: 600 }}
                    onChange={(e) => updateOut(i, { name: e.target.value })}
                  />
                  <button className="btn btn-g btn-sm" onClick={() => removeOut(i)}>×</button>
                </div>
                <div className="row g6" style={{ marginTop: 6 }}>
                  {(['image', 'video', 'audio', 'document'] as const).map((k) => (
                    <span
                      key={k}
                      className={`chip${o.kind === k ? ' on' : ''}`}
                      style={{ fontSize: 10, padding: '2px 8px' }}
                      onClick={() => updateOut(i, { kind: k })}
                    >
                      {k}
                    </span>
                  ))}
                </div>
                <div className="row g6" style={{ marginTop: 6 }}>
                  <span className="mono mut" style={{ fontSize: 10 }}>×{o.sourceNodeIds.length} 个 source 节点</span>
                </div>
              </div>
            ))}
            <button className="btn btn-s btn-sm" onClick={addOut}>＋ 添加产物</button>
          </div>
          <KVSection rows={[['语义', '工作流出口 · 运行收口 · runs/<runId>/final/']]} />
        </div>
      );
    }
    default: {
      return (
        <div className="mut" style={{ fontSize: 12 }}>
          {node.extra ?? '该节点类型暂无专属编辑器'}
        </div>
      );
    }
  }
}
