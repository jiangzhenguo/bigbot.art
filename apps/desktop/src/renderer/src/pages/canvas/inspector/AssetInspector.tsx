/**
 * AssetInspector — 资源(asset)节点检查器
 *
 * 从 InspectorBody 的 `case 'asset'` 内联块抽出,原因有实际约束:
 * 面板要记录**播放器实测元数据**(video/audio 的 loadedmetadata)才能让
 * 「媒体信息」显示的值与浏览器真正解码的那条轨一致 —— 而 `switch` 的 `case` 里
 * 不能放 hooks(`useState` 必须无条件按稳定顺序调用)。抽成独立组件后 hooks 合法。
 *
 * 分工:
 *  - 素材预览 + 媒体信息 = 只读展示(MediaInfoPanel 自己 ffprobe,不回写任何东西);
 *  - 媒体类型 / 资产 ID / 绑定按钮 = 可编辑语义(setData 走撤销栈)。
 *
 * ⚠️ **布局次序(2026-09-30 用户明确要求):参考图必须置顶。**
 * 与 image-gen / image-edit / video-upscale 等检查器的「预览置顶」同口径 ——
 * 资源节点被选中时,用户第一眼要看的是「这个资源长什么样」,而**不是**媒体类型
 * chips 和资产 ID 输入框。故整份检查器的顺序固定为:
 *   ① 素材预览 → ② 媒体信息 → ③ 绑定参数(媒体类型/资产 ID/按钮)→ ④ meta。
 * 绑定区(③)只是**改绑入口**,低频且有副作用,放参数区是常态:
 * 旧版布局下点开一个视频资源要先滚过「媒体类型 + 资产 ID + 两个按钮」才看得到画面。
 *
 * 配套(必须成对,否则同一张图会在面板里出现两遍):`InspectorPane` 顶部的
 * `selInfo.img` 整块预览对 asset 节点**不再渲染** —— 预览的唯一位置就是本组件最上方。
 */
import React, { useState } from 'react';
import { Lbl, KVSection, TextAreaField } from './fields';
import { ImagePreview } from './ImagePreview';
import { MediaInfoPanel } from './MediaInfoPanel';
import { previewUrlOf } from '../media';
import type { CanvasNode } from '../types';

/** 播放器实测元数据(loadedmetadata):比 ffprobe 探测更权威,优先展示 */
export interface LiveMediaMeta {
  width?: number;
  height?: number;
  durationSec?: number;
}

export interface AssetInspectorProps {
  node: CanvasNode;
  /** 写入节点 data(带撤销提交;由 InspectorBody 注入) */
  setData: (patch: Record<string, unknown>) => void;
  toastMsg: (msg: string) => void;
  /** assetId → 本地绝对路径(检查器探测与预览都用它) */
  assetCache: Record<string, string>;
  onOpenAssetPicker?: (nodeId: string) => void;
  /** InfoMap 里已有的 meta 行(如「资产未加载」提示;缺省不渲染) */
  meta?: Array<[string, string]>;
}

export function AssetInspector({
  node,
  setData,
  toastMsg,
  assetCache,
  onOpenAssetPicker,
  meta,
}: AssetInspectorProps) {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const mediaType = String(d.mediaType ?? 'image');
  const assetId = String(d.assetId ?? '');
  // 已绑定资产 = 媒体类型锁定(资源节点「不可自变」);未绑定时才允许选类型
  const locked = !!assetId;

  /** 播放器实测值:仅一次探测失败的兜底,故只在有真值时覆盖 */
  const [liveMeta, setLiveMeta] = useState<LiveMediaMeta>({});

  const src = assetId ? assetCache[assetId] : undefined;
  const url = src ? previewUrlOf(src) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* ── ① 素材预览:整份检查器的第一块(参考图/画面本身才是用户点开节点要找的东西)──
          按媒体类型给对应播放器(此前只支持图片,视频/音频看不到预览) */}
      {mediaType === 'image' ? (
        <>
          <ImagePreview src={url} label="素材预览" emptyHint="未绑定资产 · 绑定后显示完整图片" />
          <MediaInfoPanel path={src ?? null} kind="image" live={liveMeta} />
        </>
      ) : !url ? (
        <div className="mut" style={{ fontSize: 11 }}>
          {assetId ? `资产未加载 · ${assetId.slice(0, 16)}…` : '未绑定资产 · 绑定后显示预览'}
        </div>
      ) : mediaType === 'video' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Lbl>素材预览</Lbl>
            <video
              key={url}
              src={url}
              controls
              muted
              loop
              playsInline
              preload="metadata"
              // 播放器读到的元数据比 ffprobe 更权威(它就是真正要解码的那条轨):
              // 这里量到的宽高/时长交给媒体信息面板覆盖探测值
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                setLiveMeta({
                  width: v.videoWidth || undefined,
                  height: v.videoHeight || undefined,
                  durationSec: Number.isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : undefined,
                });
              }}
              style={{
                width: '100%',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-soft)',
                background: '#000',
                display: 'block',
              }}
            />
          </div>
          <MediaInfoPanel path={src ?? null} kind="video" live={liveMeta} />
        </div>
      ) : mediaType === 'audio' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Lbl>素材预览</Lbl>
            <audio
              key={url}
              src={url}
              controls
              preload="metadata"
              onLoadedMetadata={(e) => {
                const el = e.currentTarget;
                setLiveMeta({
                  durationSec: Number.isFinite(el.duration) ? Math.round(el.duration * 10) / 10 : undefined,
                });
              }}
              style={{ width: '100%' }}
            />
          </div>
          <MediaInfoPanel path={src ?? null} kind="audio" live={liveMeta} />
        </div>
      ) : (
        <>
          <div className="mut" style={{ fontSize: 11 }}>
            文档类资产无内联预览 · 双击资源节点或「在资源中心打开」查看
          </div>
          <MediaInfoPanel path={src ?? null} kind="document" />
        </>
      )}

      {/* ── ③ 绑定参数:媒体类型 / 资产 ID / 换绑按钮 ──
          改绑是低频且有副作用的操作,排在预览与媒体信息之后(点开资源先看到东西,
          再决定要不要换)。媒体类型 chips 只对**未绑定**资源开放 ——
          已绑定资产时媒体类型由该资产决定,是锁定值不是可选项。 */}
      <div className="f-sec">
        <div className="f-sec-h">
          <span className="lbl">媒体类型</span>
          <span className="mut" style={{ fontSize: 10.5 }}>{locked ? '已绑定资产 · 锁定' : '未绑定 · 可改'}</span>
        </div>
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
        <button className="btn btn-s btn-sm" onClick={() => onOpenAssetPicker?.(node.id)}>
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

      {/* ── ④ 补充 meta(如「资产未加载」提示;由调用方注入,缺省不渲染)── */}
      {meta?.length ? <KVSection rows={meta} /> : null}
    </div>
  );
}
