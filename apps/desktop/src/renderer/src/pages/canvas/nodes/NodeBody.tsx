/**
 * NodeBody — 节点卡片内容区(按 kind 数据驱动渲染)
 *
 * 拆分自 CanvasPage 的 renderBody(n)(原 1889–2272 行):
 * 卡片内容 = 节点 data 的投影,与检查器同源;纯展示,只依赖 node + takeResults。
 */
import React from 'react';
import type { TimelineData } from '@bigbotart/shared';
import {
  parseGfmTable,
  docMarkers,
  sbStats,
  rowNeedsImage,
} from '@bigbotart/shared';
import type { CanvasNode } from '../types';
import {
  SHOT_MODE_LABEL,
  SHOT_SIZES,
  SHOT_TIERS,
  SHOT_ASPECTS,
  SHOT_TIER_PRESETS,
  WAVE_BARS,
} from '../constants';
import { sbMaterializedRows, sbImgCount, sbDirty } from '../storyboard';
import { basenameOf, outputUrlOf, clamp32, thumbSrc, VideoThumb, VideoPoster } from '../media';
import { TimelineExportPreview } from '../TimelineExportPreview';

interface NodeBodyProps {
  node: CanvasNode;
  /** 当前画布全部节点(分镜表「已铺行」统计需要;其余 kind 用不到) */
  nodes: CanvasNode[];
  /** nodeId → 最新成功 Take 产物路径(产物回填);渲染时 data.resultPath 优先 */
  takeResults: Record<string, string>;
  /** assetId → 资产展示元信息(asset 节点渲染用;缺省 = 空表) */
  assetMeta?: Record<string, { name: string; kind: string; categoryName?: string; src: string | null }>;
}

export function NodeBody({ node: n, nodes, takeResults, assetMeta = {} }: NodeBodyProps) {
  const d = (n.data ?? {}) as Record<string, unknown>;
  /** 产物路径:节点 data 优先,回退 Take 回填 */
  const productOf = (node: CanvasNode) =>
    String((node.data as Record<string, unknown> | undefined)?.resultPath ?? takeResults[node.id] ?? '');

  switch (n.kind) {
    case 'document': {
      const md = String(d.markdown ?? '');
      const tb = parseGfmTable(md);
      const mk = docMarkers(md);
      return (
        <div className="nb md-preview">
          {tb ? (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table className="tbl-mini">
                  <thead>
                    <tr>
                      {tb.head.slice(0, 3).map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tb.rows.slice(0, 2).map((r, i) => (
                      <tr key={i}>
                        {tb.head.slice(0, 3).map((_, c) => (
                          <td key={c}>{r[c] ?? ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="rowsum">
                <span className="badge">{tb.rows.length} 行 · {tb.head.length} 列</span>
                {mk.prompt ? (
                  <span className="mkblock">```prompt 块 → 已命中</span>
                ) : mk.shot ? (
                  <span className="mkblock">标题块 → 已命中</span>
                ) : (
                  <span className="mkblock" style={{ borderStyle: 'dashed', background: 'transparent' }}>无标记 · 全文兜底</span>
                )}
              </div>
            </>
          ) : md ? (
            <>
              <b style={{ display: 'block', marginBottom: 4 }}>{md.split('\n')[0]?.replace(/^#+\s*/, '') || '文档'}</b>
              <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>{md.slice(0, 120)}{md.length > 120 ? '…' : ''}</p>
            </>
          ) : (
            <div style={{ color: 'var(--meta)', fontSize: 11, padding: '8px 0' }}>空白文档 · 检查器里填写 Markdown</div>
          )}
        </div>
      );
    }
    case 'storyboard': {
      const md = String(d.markdown ?? '');
      const tb = parseGfmTable(md);
      const rows = tb?.rows ?? [];
      const head = tb?.head ?? [];
      const st = sbStats(head, rows);
      const matRows = sbMaterializedRows(n.id, nodes);
      const dirty = sbDirty(n, nodes);
      const base = String(d.basePrompt ?? '');
      const more = rows.length > 3 ? `+${rows.length - 3} 行未显示` : '';
      const stateLine = matRows.length
        ? `已铺 ${matRows.length} shot${sbImgCount(n.id, nodes) ? ` + ${sbImgCount(n.id, nodes)} image-gen` : ''} · 未触发运行${dirty ? ' · 表格已改' : ''}`
        : `待铺节点 · ${st.n} shot + ${st.imgs} image-gen`;
      return (
        <div className="nb">
          {tb ? (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table className="tbl-mini">
                  <thead>
                    <tr>
                      <th style={{ width: 26 }}>镜</th>
                      <th>画面描述</th>
                      <th style={{ width: 36 }}>时长</th>
                      <th style={{ width: 40 }}>配图</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 3).map((r, i) => (
                      <tr key={i}>
                        <td className="n">{r[0] ?? i + 1}</td>
                        <td>{r[1] ?? ''}</td>
                        <td>{r[5] ?? ''}s</td>
                        <td>{rowNeedsImage(r, head) ? '是' : '否'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="rowsum">
                <span className="badge">{st.n} 行</span>
                <span className="badge">需配图 {st.imgs}</span>
                <span className="more">合计 {st.secs}s</span>
                <span className="more">{more}</span>
              </div>
              {base ? <div className="nparams">basePrompt · {base}</div> : null}
            </>
          ) : (
            <div style={{ color: 'var(--meta)', fontSize: 11, padding: '8px 0' }}>分镜表 · 检查器里编辑表格</div>
          )}
          <div className="nmeta mono">{stateLine}</div>
        </div>
      );
    }
    case 'asset': {
      const mediaType = String(d.mediaType ?? 'image');
      const assetId = String(d.assetId ?? '');
      const am = assetMeta[assetId];
      // 已绑定资产:按媒体类型渲染真实内容(缩略图 contain / 视频封面 / 波形 / 文档图标)
      if (am) {
        return (
          <div className="nb">
            {am.kind === 'image' && am.src ? (
              <div className="nthumb fit">
                <img src={am.src} alt={am.name} loading="lazy" />
              </div>
            ) : am.kind === 'video' ? (
              <VideoThumb src={am.src ?? ''} badge={am.name} />
            ) : am.kind === 'audio' ? (
              <div className="wave">
                {WAVE_BARS.map((h, i) => (
                  <i key={i} style={{ height: h }} />
                ))}
              </div>
            ) : (
              <div
                className="nthumb"
                style={{
                  aspectRatio: '16/9',
                  display: 'grid',
                  placeItems: 'center',
                  background: 'var(--surface-warm)',
                  border: '1.5px dashed var(--border)',
                  fontSize: 22,
                }}
              >
                📄
              </div>
            )}
            <div className="nmeta mono">
              {am.name} · {am.kind}
              {am.categoryName ? ` · ${am.categoryName}` : ''}
            </div>
          </div>
        );
      }
      const emoji = mediaType === 'image' ? '🖼' : mediaType === 'video' ? '🎬' : mediaType === 'audio' ? '🎵' : '📄';
      return (
        <div className="nb">
          <div
            className="nthumb"
            style={{
              aspectRatio: '16/9',
              display: 'grid',
              placeItems: 'center',
              background: 'var(--surface-warm)',
              border: assetId ? 'none' : '1.5px dashed var(--border)',
              fontSize: 22,
            }}
          >
            {assetId ? (
              <span style={{ opacity: 0.85 }}>{emoji}</span>
            ) : (
              <span style={{ opacity: 0.5 }}>{emoji}</span>
            )}
          </div>
          <div className="nmeta mono">{assetId ? `资产未加载 ${assetId.slice(0, 14)}… · ${mediaType}` : '未绑定资产 · 检查器里选择'}</div>
        </div>
      );
    }
    case 'image-gen': {
      const prompt = String(d.prompt ?? '');
      const model = String(d.model ?? 'mlxgen');
      const w = Number(d.width ?? 1024);
      const h = Number(d.height ?? 1024);
      const seeds = (d.seeds as number[]) ?? [];
      const outImg = productOf(n);
      return (
        <div className="nb">
          {outImg ? (
            <div className="nthumb fit"><img src={outputUrlOf(outImg)} alt="图片产物" /></div>
          ) : (
          <div className="nthumb" style={{ aspectRatio: '1/1', display: 'grid', placeItems: 'center', background: 'var(--surface-warm)', border: '1.5px dashed var(--border)', color: 'var(--meta)', fontSize: 11 }}>
            待生成 · {w}×{h}
          </div>
          )}
          <div className="nmeta mono">
            {prompt ? `${prompt.slice(0, 30)}${prompt.length > 30 ? '…' : ''}` : '未填提示词'} · {model.split('/').pop()}
          </div>
          {seeds.length > 1 ? <div className="nmeta mono" style={{ marginTop: 2 }}>seed 批量 ×{seeds.length}</div> : null}
        </div>
      );
    }
    case 'image-edit': {
      const mode = String(d.mode ?? 'instruction');
      const modeLabel = ({ instruction: '指令编辑', img2img: 'I2I', inpaint: 'Inpaint', outpaint: 'Outpaint' } as Record<string, string>)[mode] ?? mode;
      const prompt = String(d.prompt ?? '');
      const outImg = productOf(n);
      // 输入图状态与检查器同源:手填资产 > 连线静帧 > 连线取帧
      const inputState = String(d.inputAssetId ?? '')
        ? `输入图 · 资产 ${String(d.inputAssetId).slice(0, 8)}`
        : (d.inputImageFrom as { nodeId?: string } | undefined)?.nodeId
          ? `输入图 · 节点 ${String((d.inputImageFrom as { nodeId?: string }).nodeId).slice(0, 8)}`
          : (d.inputFrameSource as { videoNodeId?: string } | undefined)?.videoNodeId
            ? `输入帧 · ${(d.inputFrameSource as { at?: string }).at === 'last' ? '尾帧' : '首帧'}`
            : '输入图待绑定';
      return (
        <div className="nb">
          {outImg ? (
            <div className="nthumb fit"><img src={outputUrlOf(outImg)} alt="编辑产物" /></div>
          ) : (
            <div className="nthumb" style={{ aspectRatio: '16/9', display: 'grid', placeItems: 'center', background: 'var(--surface-warm)', border: '1.5px dashed var(--border)', color: 'var(--meta)', fontSize: 11 }}>
              {modeLabel} · {inputState}
            </div>
          )}
          <div className="nmeta mono">{prompt ? `${prompt.slice(0, 30)}…` : '未填指令'}</div>
        </div>
      );
    }
    case 'image-upscale': {
      const scale = Number(d.scale ?? 2);
      const outImg = productOf(n);
      const inputState = String(d.inputAssetId ?? '')
        ? `输入 · 资产 ${String(d.inputAssetId).slice(0, 8)}`
        : (d.inputImageFrom as { nodeId?: string } | undefined)?.nodeId
          ? `输入 · 节点 ${String((d.inputImageFrom as { nodeId?: string }).nodeId).slice(0, 8)}`
          : '输入待绑定';
      return (
        <div className="nb">
          {outImg ? (
            <div className="nthumb fit"><img src={outputUrlOf(outImg)} alt="超分产物" /></div>
          ) : (
            <div className="nthumb" style={{ aspectRatio: '16/9', display: 'grid', placeItems: 'center', background: 'var(--surface-warm)', border: '1.5px dashed var(--border)', color: 'var(--meta)', fontSize: 11 }}>
              ×{scale} 超分 · {inputState}
            </div>
          )}
          <div className="nmeta mono">SeedVR2 · ×{scale}</div>
        </div>
      );
    }
    case 'image-crop': {
      const aspect = String(d.aspect ?? '9:16');
      const focus = String(d.focus ?? 'center');
      const outImg = productOf(n);
      const inputState = String(d.inputAssetId ?? '')
        ? `输入 · 资产 ${String(d.inputAssetId).slice(0, 8)}`
        : (d.inputImageFrom as { nodeId?: string } | undefined)?.nodeId
          ? `输入 · 节点 ${String((d.inputImageFrom as { nodeId?: string }).nodeId).slice(0, 8)}`
          : '输入待绑定';
      // 缩略图比例 = 目标画幅(9:16 → 9/16),不固定在 16:9 框里裁切;
      // 产物 contain 完整可见,占位框同比例(裁剪节点的样子就是图片的样子)
      const ratio = aspect.replace(':', '/');
      return (
        <div className="nb">
          {outImg ? (
            <div className="nthumb">
              <img
                src={outputUrlOf(outImg)}
                alt="裁切产物"
                style={{ aspectRatio: ratio, objectFit: 'contain', background: 'var(--surface-warm)' }}
              />
            </div>
          ) : (
            <div className="nthumb" style={{ aspectRatio: ratio, display: 'grid', placeItems: 'center', background: 'var(--surface-warm)', border: '1.5px dashed var(--border)', color: 'var(--meta)', fontSize: 11 }}>
              裁剪至 {aspect} · {inputState}
            </div>
          )}
          <div className="nmeta mono">{aspect} · {focus} · 保持原分辨率</div>
        </div>
      );
    }
    case 'image-stitch': {
      const mode = String(d.mode ?? 'column');
      const modeLabel = mode === 'row' ? '横排' : mode === 'grid' ? `网格×${Number(d.gridCols ?? 3)}` : '竖排长图';
      const gap = Number(d.gap ?? 0);
      const pieces = (d.piecesFrom as Array<{ nodeId?: string }> | undefined) ?? [];
      const outImg = productOf(n);
      return (
        <div className="nb">
          {outImg ? (
            <div className="nthumb fit"><img src={outputUrlOf(outImg)} alt="拼接产物" /></div>
          ) : (
            <div className="nthumb" style={{ aspectRatio: '16/9', display: 'grid', placeItems: 'center', background: 'var(--surface-warm)', border: '1.5px dashed var(--border)', color: 'var(--meta)', fontSize: 11 }}>
              {modeLabel}拼接 · {pieces.length > 0 ? `${pieces.length} 件` : '待连拼接件'}
            </div>
          )}
          <div className="nmeta mono">{modeLabel} · {pieces.length} 件{gap > 0 ? ` · 间距 ${gap}px` : ''}</div>
        </div>
      );
    }
    case 'image-split': {
      const mode = String(d.mode ?? 'grid');
      const count = Number(d.count ?? 3);
      const gridCols = Number(d.gridCols ?? 3);
      const modeLabel = mode === 'rows' ? `横切 ${count} 段` : mode === 'cols' ? `竖切 ${count} 段` : `${gridCols}×${Number(d.gridRows ?? 3)} 网格`;
      const pieces = (d.pieces as string[] | undefined) ?? [];
      const inputState = String(d.inputAssetId ?? '')
        ? `输入 · 资产 ${String(d.inputAssetId).slice(0, 8)}`
        : (d.inputImageFrom as { nodeId?: string } | undefined)?.nodeId
          ? `输入 · 节点 ${String((d.inputImageFrom as { nodeId?: string }).nodeId).slice(0, 8)}`
          : '输入待绑定';
      // 切片按切分形态排布:横切=单列横条竖叠 / 竖切=N 列竖条 / 网格=M 列;自然比例无缝拼回原图观感
      const viewCols = mode === 'rows' ? 1 : mode === 'cols' ? count : gridCols;
      return (
        <div className="nb">
          {pieces.length > 0 ? (
            <div className="nthumb" style={{ display: 'grid', gridTemplateColumns: `repeat(${viewCols}, 1fr)`, gap: 2, background: 'var(--surface-warm)', alignItems: 'start' }}>
              {pieces.map((p, i) => (
                <img key={p} src={outputUrlOf(p)} alt={`第 ${i + 1} 片`} style={{ width: '100%', height: 'auto', display: 'block', objectFit: 'contain' }} />
              ))}
            </div>
          ) : (
            <div className="nthumb" style={{ aspectRatio: '16/9', display: 'grid', placeItems: 'center', background: 'var(--surface-warm)', border: '1.5px dashed var(--border)', color: 'var(--meta)', fontSize: 11 }}>
              {modeLabel} · {inputState}
            </div>
          )}
          <div className="nmeta mono">{modeLabel}{pieces.length > 0 ? ` · 已切 ${pieces.length} 片` : ''}</div>
        </div>
      );
    }
    case 'video-upscale': {
      const scale = Number(d.scale ?? 2);
      const srModel = String(d.srModel ?? 'realesrgan-x4plus');
      const faceModel = String(d.faceModel ?? 'gfpgan');
      const deblock = d.deblock === true;
      const applied = (d.appliedStages as string[] | undefined) ?? [];
      const outVid = String(d.resultPath ?? '');
      const inputState = String(d.inputAssetId ?? '')
        ? `输入 · 资产 ${String(d.inputAssetId).slice(0, 8)}`
        : (d.inputVideoFrom as { nodeId?: string } | undefined)?.nodeId
          ? `输入 · 节点 ${String((d.inputVideoFrom as { nodeId: string }).nodeId).slice(0, 8)}`
          : '输入待绑定';
      const faceLabel = faceModel === 'none' ? '不修脸' : faceModel === 'gfpgan' ? 'GFPGAN' : 'CodeFormer';
      const summary = [
        d.superRes === 'none' || scale <= 1 ? '不超分' : `×${scale}`,
        faceLabel,
        ...(deblock ? ['去块'] : []),
      ].join(' · ');
      return (
        <div className="nb">
          {outVid ? (
            <VideoThumb src={outputUrlOf(outVid)} badge={applied.length ? applied.join(' → ') : summary} />
          ) : (
            <div className="nthumb" style={{ aspectRatio: '16/9', display: 'grid', placeItems: 'center', background: 'var(--surface-warm)', border: '1.5px dashed var(--border)', color: 'var(--meta)', fontSize: 11, textAlign: 'center', padding: 6 }}>
              {summary}
              <br />
              {inputState}
            </div>
          )}
          <div className="nmeta mono">{summary}{applied.length > 1 ? ` · ${applied.length} 阶段` : ''}</div>
        </div>
      );
    }
    case 'shot': {
      const mode = String(d.mode ?? 'text2video');
      // 白名单归一(与 ShotInspector 同规则):老数据/自定义画幅(如 '5:3')不在表内 → 回退 16:9,
      // 否则 SHOT_SIZES[aspect] 为 undefined,点卡片会 "Cannot read properties of undefined (reading 'default')"
      const tierRaw = String(d.tier ?? 'default');
      const tier = (tierRaw in SHOT_TIER_PRESETS ? tierRaw : 'default') as (typeof SHOT_TIERS)[number];
      const aspectRaw = String(d.aspect ?? '16:9');
      const aspect = (aspectRaw === 'custom' || aspectRaw in SHOT_SIZES ? aspectRaw : '16:9') as (typeof SHOT_ASPECTS)[number];
      const prompt = String(d.prompt ?? '');
      const modeLabel = SHOT_MODE_LABEL[mode] ?? mode;
      // 尺寸以**节点 data 为权威**(与检查器同一规则);缺失时才按 aspect × tier 推导
      const derivedSize = aspect === 'custom'
        ? { width: clamp32(Number(d.customWidth ?? 544)), height: clamp32(Number(d.customHeight ?? 544)) }
        : SHOT_SIZES[aspect as '16:9' | '9:16' | '1:1'][tier] ?? SHOT_SIZES['16:9'].default;
      const size = { width: Number(d.width ?? derivedSize.width), height: Number(d.height ?? derivedSize.height) };
      const tierLabel = (SHOT_TIER_PRESETS[tier] ?? SHOT_TIER_PRESETS.default).label;
      const resultPath = productOf(n);
      const refs = (d.refs as Array<{ role?: string; auto?: boolean }> | undefined) ?? [];
      const inherited = !!(d.specFrom as { nodeId?: string } | undefined)?.nodeId && d.specOverride !== true;
      return (
        <div className="nb">
          {resultPath ? (
            <VideoThumb src={outputUrlOf(resultPath)} badge={`✓ ${basenameOf(resultPath)}`} />
          ) : (
            <div className="nthumb" style={{ aspectRatio: '16/9', display: 'grid', placeItems: 'center', background: 'var(--surface-warm)', border: '1.5px dashed var(--border)', color: 'var(--meta)', fontSize: 11 }}>
              {modeLabel} · 待生成
            </div>
          )}
          <div className="nmeta mono">
            h3.c · {modeLabel} · {tierLabel} · {size.width}×{size.height}
            {refs.length ? ` · ${refs.length} 参考` : ''}
            {inherited ? ' · 继承上游规格' : ''}
          </div>
          <div className="nmeta mono" style={{ marginTop: 2 }}>
            {prompt ? `${prompt.slice(0, 20)}…` : '未填提示词'}
          </div>
        </div>
      );
    }
    case 'director': {
      const prompt = String(d.prompt ?? '');
      return (
        <div className="nb">
          <div className="nthumb" style={{ aspectRatio: '16/9', display: 'grid', placeItems: 'center', background: 'var(--surface-warm)', border: '1.5px dashed var(--border)', color: 'var(--meta)', fontSize: 11 }}>
            运镜参考小样
          </div>
          <div className="nmeta mono">{prompt ? `${prompt.slice(0, 40)}…` : '未填导演 prompt'}</div>
        </div>
      );
    }
    case 'timeline': {
      const shots = (d.shotNodeIds as string[]) ?? [];
      const lastExport = (d.lastExport as TimelineData['lastExport']) ?? undefined;
      return (
        <div className="nb">
          {lastExport?.path ? (
            <TimelineExportPreview lastExport={lastExport} />
          ) : null}
          <div className="clipstrip" style={lastExport?.path ? { marginTop: 7 } : undefined}>
            {shots.length === 0 ? (
              <span className="cs wait" style={{ flex: 1, textAlign: 'center', color: 'var(--meta)', fontSize: 11, padding: '16px 0' }}>
                拖入镜头节点入线
              </span>
            ) : (
              shots.slice(0, 4).map((sid, i) => {
                const cover = takeResults[sid];
                if (!cover) {
                  return (
                    <span key={sid} className="cs wait" title={`镜${i + 1} · 待生成`} style={{ display: 'grid', placeItems: 'center', color: 'var(--meta)', fontSize: 10 }}>
                      {i + 1}
                    </span>
                  );
                }
                const src = outputUrlOf(cover);
                const isVid = /\.(mp4|mov|webm|m4v)$/i.test(src);
                return (
                  <span key={sid} className="cs" title={`镜${i + 1} · 已生成`}>
                    {isVid ? (
                      /* 纯展示的一格封面(P2):改用抽帧静态图,不再常驻 <video>。
                         这里最多同屏 4 个,而每个 video 元素都要独立的媒体合成层
                         与解码器上下文 —— 画布上几十个节点累积起来相当可观。
                         抽帧失败会自动回退真实 video(见 VideoPoster),不会白屏。 */
                      <VideoPoster
                        src={src}
                        alt={`镜${i + 1} 片段封面`}
                        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', background: '#000' }}
                      />
                    ) : (
                      <img src={src} alt={`镜${i + 1} 片段封面`} />
                    )}
                  </span>
                );
              })
            )}
          </div>
          <div className="nmeta mono">
            {lastExport?.path
              ? `已生成成片 · ${shots.length} 片段 · ${lastExport.durationSec ? `${lastExport.durationSec.toFixed(1)}s` : ''} · 可预览`
              : `${shots.length} 个镜头入线 · FFmpeg 导出`}
          </div>
        </div>
      );
    }
    case 'audio-ref': {
      const assetId = String(d.assetId ?? '');
      return (
        <div className="nb">
          <div className="wave">
            {WAVE_BARS.map((h, i) => (
              <i key={i} style={{ height: h }} />
            ))}
          </div>
          <div className="nmeta mono">{assetId ? `资产 ${assetId.slice(0, 12)}… · --ref-audio` : '未绑定音频 · 检查器里选择'}</div>
        </div>
      );
    }
    case 'workflow-input': {
      const slots = (d.slots as Array<{ name: string; accept: string[]; required: boolean; value?: { kind: string } }>) ?? [];
      return (
        <div className="nb">
          <div className="nmeta mono" style={{ marginBottom: 6, color: 'var(--muted)' }}>输入槽位 ×{slots.length}</div>
          {slots.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', fontSize: 11 }}>
              <span style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
              {s.accept.slice(0, 2).map((a) => (
                <span key={a} className="badge" style={{ fontSize: 9, padding: '1px 5px' }}>{a}</span>
              ))}
              {s.required ? <span className="badge" style={{ fontSize: 9, padding: '1px 5px', background: 'color-mix(in oklab,var(--danger) 10%,transparent)', color: 'var(--danger)' }}>必填</span> : null}
              {s.value ? <span style={{ color: 'var(--success)', fontSize: 10 }}>✓</span> : <span style={{ color: 'var(--meta)', fontSize: 10 }}>—</span>}
            </div>
          ))}
        </div>
      );
    }
    case 'workflow-output': {
      const outputs = (d.outputs as Array<{ name: string; kind: string; sourceNodeIds: string[] }>) ?? [];
      return (
        <div className="nb">
          <div className="nmeta mono" style={{ marginBottom: 6, color: 'var(--muted)' }}>产物汇聚 ×{outputs.length}</div>
          {outputs.map((o, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', fontSize: 11 }}>
              <span style={{ fontWeight: 600, flex: 1 }}>{o.name}</span>
              <span className="badge" style={{ fontSize: 9, padding: '1px 5px' }}>{o.kind}</span>
              <span className="mono mut" style={{ fontSize: 9 }}>×{o.sourceNodeIds.length}</span>
            </div>
          ))}
        </div>
      );
    }
    default: {
      if (n.extra) {
        return (
          <div className="nb">
            <div
              className="nthumb"
              style={{
                border: '1.5px dashed var(--border)',
                background: 'var(--surface-warm)',
                aspectRatio: '16/9',
                display: 'grid',
                placeItems: 'center',
                color: 'var(--meta)',
                fontSize: '11px',
              }}
            >
              待生成 · 排队中
            </div>
            <div className="nmeta mono">{n.extra}</div>
          </div>
        );
      }
      return (
        <div className="nb">
          <div className="nmeta mono">新节点 · 拖动画布标题栏调整位置，点「+」连接下游</div>
        </div>
      );
    }
  }
}