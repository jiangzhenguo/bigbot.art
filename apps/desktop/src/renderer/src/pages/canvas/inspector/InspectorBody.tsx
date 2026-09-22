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
  const selectImageTake = (t: { id: string; attempt: number; status: string; resultPath?: string }) => {
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
          extra: t.resultPath ? `✓ ${name}` : t.status === 'succeeded' ? '✓·无产物' : t.status === 'failed' ? '失败' : n.extra,
          data: {
            ...(n.data ?? {}),
            currentTakeId: t.id,
            resultPath: t.resultPath ?? undefined,
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
      const mediaType = String(d.mediaType ?? 'image');
      const assetId = String(d.assetId ?? '');
      // 已绑定资产 = 媒体类型锁定(资源节点「不可自变」);未绑定时才允许选类型
      const locked = !!assetId;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Lbl>媒体类型{locked ? ' · 已绑定锁定' : ''}</Lbl>
            <div className="row g6">
              {(['image', 'video', 'audio', 'document'] as const).map((t) => (
                <span
                  key={t}
                  className={`chip${mediaType === t ? ' on' : ''}${locked ? ' dis' : ''}`}
                  onClick={() => {
                    if (locked) {
                      toastMsg('已绑定资产,媒体类型锁定 · 右键「更换资产…」换绑');
                      return;
                    }
                    setData({ mediaType: t });
                  }}
                >
                  {t === 'image' ? '图片' : t === 'video' ? '视频' : t === 'audio' ? '音频' : '文档'}
                </span>
              ))}
            </div>
          </div>
          <TextAreaField
            label="资产 ID(从资产中心复制)"
            value={assetId}
            rows={1}
            placeholder="asset-xxxxxxxxxxxx-xxxx"
            onChange={(v) => setData({ assetId: v })}
          />
          <div className="row g6">
            <button
              className="btn btn-s btn-sm"
              onClick={() => node && onOpenAssetPicker && onOpenAssetPicker(node.id)}
            >
              从资源库选择…
            </button>
            <button
              className="btn btn-s btn-sm"
              onClick={() => {
                void window.bigbotart.listAssets().then((all) => {
                  const opts = all.filter((a) => a.kind === mediaType);
                  if (!opts.length) {
                    toastMsg(`资产库里没有 ${mediaType} 类资产`);
                    return;
                  }
                  const first = opts[0]!;
                  setData({ assetId: first.id });
                  toastMsg(`已绑定最新 ${mediaType} 资产:${first.name}`);
                });
              }}
            >
              绑定最新 {mediaType} 资产
            </button>
          </div>
          {mediaType === 'image' ? (
            assetId && assetCache[assetId] ? (
              <ImagePreview src={previewUrlOf(assetCache[assetId])} label="素材预览" />
            ) : (
              <ImagePreview src={null} label="素材预览" emptyHint="未绑定资产 · 绑定后显示完整图片" />
            )
          ) : null}
          {info?.meta ? <KVSection rows={info.meta} /> : null}
        </div>
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
          runNode={runNode}
          toastMsg={toastMsg}
          onSelectTake={selectImageTake}
        />
      );
    }
    case 'image-upscale': {
      const scale = Number(d.scale ?? 2);
      const model = String(d.model ?? 'AbstractFramework/seedvr2-3b-8bit');
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
          <CropTakePreview node={node} projectId={projectId} srcFallback={cropSrc} />
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
