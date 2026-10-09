/**
 * 图片节点检查器通用表单块 — 画幅预设 / 多 seed 编辑器 / 采样滑块 / 上游来源卡 / 图像强度 / 输出尺寸 / 扩图四边 / 行动条
 * 纯展示 + 受控回调,不触碰 window.bigbotart(容器层负责接线)。
 */
import { useEffect, useRef, useState } from 'react';
import { ASPECTS, ratioOf } from './image-aspects';
import { previewUrlOf } from '../media';
import {
  OUTPUT_SIZE_PRESETS,
  parseSizeInput,
} from './ImageEditInspector';

export { ASPECTS, ratioOf } from './image-aspects';

export function AspectPresets({
  width,
  height,
  onChange,
  disabled,
}: {
  width: number;
  height: number;
  onChange: (patch: { width: number; height: number }) => void;
  disabled?: boolean;
}) {
  const ratio = ratioOf(width, height);
  return (
    <div className="f-sec" data-od-id="field-aspect">
      <div className="f-sec-h"><span className="lbl">画幅</span></div>
      <div className="aspect" style={disabled ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
        {ASPECTS.map((a) => (
          <span
            key={a.key}
            className={`ap${ratio === a.key ? ' on' : ''}`}
            onClick={() => onChange({ width: a.w, height: a.h })}
          >
            <span className="glyph" style={{ aspectRatio: a.key.replace(':', '/') }} />
            <span className="lbl">{a.label}</span>
          </span>
        ))}
      </div>
      <div className="f-row" style={disabled ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
        <span className="f-lbl">宽</span>
        <input className="f-in med mono" type="number" value={width} onChange={(e) => onChange({ width: Number(e.target.value) || 0, height })} />
        <span className="f-lbl">高</span>
        <input className="f-in med mono" type="number" value={height} onChange={(e) => onChange({ width, height: Number(e.target.value) || 0 })} />
        <span className="mut" style={{ fontSize: 10.5 }}>{ratio ? `· ${ratio} 已对齐` : ''}</span>
      </div>
    </div>
  );
}

// ── 多 seed chip 编辑器(回车追加 / × 删除 / 空则随机) ──
export function SeedEditor({
  seeds,
  onChange,
  disabled,
}: {
  seeds: number[];
  onChange: (seeds: number[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="f-sec" data-od-id="field-seeds">
      <div className="f-sec-h">
        <span className="lbl">Seed</span>
        <span className="mut" style={{ fontSize: 10.5 }}>
          {seeds.length === 0 ? '随机 · 生成 1 张 PNG' : `${seeds.length} 个 · 生成 ${seeds.length} 张 PNG`}
        </span>
      </div>
      <div className="seeds" style={disabled ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
        {seeds.map((s, i) => (
          <span key={`${s}-${i}`} className="chip rem">
            {s}
            <i
              onClick={() => onChange(seeds.filter((_, j) => j !== i))}
            >
              ×
            </i>
          </span>
        ))}
        <input
          placeholder="回车添加 · 留空随机"
          inputMode="numeric"
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const v = Number((e.target as HTMLInputElement).value.trim());
            if (Number.isInteger(v) && v >= 0 && !seeds.includes(v)) onChange([...seeds, v]);
            (e.target as HTMLInputElement).value = '';
          }}
        />
      </div>
      <div className="seeds-hint">
        <span>多 seed 以独立参数传给 CLI(<code>--seed 42 43</code>),每张一个产物,并入 Take 历史</span>
      </div>
    </div>
  );
}

// ── 采样:steps 滑块(4-50,带标尺)+ guidance 数字 ──
export function StepsGuidanceField({
  steps,
  guidance,
  onChange,
  disabled,
}: {
  steps: number;
  guidance: number;
  onChange: (patch: { steps?: number; guidance?: number }) => void;
  disabled?: boolean;
}) {
  return (
    <div className="f-sec" style={disabled ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
      <div className="f-sec-h"><span className="lbl">采样</span></div>
      <div className="f-row">
        <span className="f-lbl">steps</span>
        <div className="range" style={{ flex: 1, minWidth: 120 }}>
          <input
            type="range"
            min={4}
            max={50}
            value={steps}
            onChange={(e) => onChange({ steps: Number(e.target.value) })}
          />
          <span className="val mono">{steps}</span>
        </div>
        <span className="f-lbl" style={{ marginLeft: 10 }}>guidance</span>
        <input
          className="f-in mono"
          type="number"
          step={0.1}
          value={guidance}
          onChange={(e) => onChange({ guidance: Number(e.target.value) })}
        />
      </div>
      <div className="range-scale">
        <span>4</span><span>12</span><span>24 (默认)</span><span>36</span><span>50</span>
      </div>
    </div>
  );
}

// ── 上游输入图来源卡片(只读展示,由连线/资产绑定) ──
export function UpstreamCard({
  label,
  sub,
  src,
  pill,
}: {
  label: string;
  sub: string;
  src?: string | null;
  pill: string;
}) {
  return (
    <div className="f-sec">
      <div className="f-sec-h">
        <span className="lbl">输入图</span>
        <span className="mut" style={{ fontSize: 10.5 }}>由连线自动绑定</span>
      </div>
      <div className="upstream">
        <span className="uprev">{src ? <img src={src} alt="" /> : null}</span>
        <div className="grow ucut">
          <div className="ulabel">{label}</div>
          <div className="usub">{sub}</div>
        </div>
        <span className="upill">{pill}</span>
      </div>
    </div>
  );
}

// ── 参考图来源解析(纯函数,供单测) ──
/** 单张参考图的解析结果:可直接显示的 URL + 展示文案 */
export interface RefImageItem {
  nodeId: string;
  /** 参考图节点的标题(缺失时回落为 id) */
  title: string;
  /** 可直接显示的 URL;null = 拿不到图(节点没跑/资产没加载) */
  src: string | null;
  /** 来源说明(asset 素材 / 产物直通 / 未就绪的具体原因) */
  note: string;
  /** 源节点是否还在画布上(被删掉的参考图要显式标注,而不是静默显示空框) */
  missing: boolean;
}

/**
 * 把 image-edit 的 `data.refImageFrom`(ref-image 入边派生态)解析成可渲染的参考图列表。
 *
 * ⚠️ 为什么要单独一条链路:ref-image 与 input 是**两个不同端口** ——
 * input 是「被编辑的底图」,ref-image 是「参考」,语义互不相干。
 * 早期实现把两者都塞进「输入图」那张卡(ref-image 只作为无底图时的兜底),
 * 结果「连了参考图却在输入图卡里看到它」,用户分不清到底哪张是被编辑对象。
 * 现在 ref-image 有自己独立的展示区,本函数是它的唯一数据源。
 *
 * 与 `upstreamImagePath` 同口径:asset 节点取 `assetCache[data.assetId]`,
 * 其余图片节点取 `data.resultPath`。
 */
export function resolveRefImages(args: {
  refImageFrom?: Array<{ nodeId?: string }>;
  nodes: Array<{ id: string; title?: string; kind?: string; data?: Record<string, unknown> }>;
  assetCache: Record<string, string>;
}): RefImageItem[] {
  const { refImageFrom, nodes, assetCache } = args;
  const list = (refImageFrom ?? []).filter((r) => r?.nodeId);
  return list.map((r) => {
    const id = r.nodeId!;
    const n = nodes.find((x) => x.id === id);
    if (!n) {
      // 源节点被删了:边没了但 data 还留着派生态的窗口期,必须说清楚而不是显示空框
      return { nodeId: id, title: id, src: null, note: '源节点已删除', missing: true };
    }
    const d = (n.data ?? {}) as Record<string, unknown>;
    const isAsset = n.kind === 'asset';
    const assetId = String(d.assetId ?? '');
    const path = isAsset ? (assetCache[assetId] ?? '') : String(d.resultPath ?? '');
    const note = path
      ? isAsset
        ? 'asset · 素材直通'
        : `${n.kind ?? '图片'} · 产物直通`
      : isAsset
        ? assetId
          ? `资产未加载(${assetId})`
          : '节点未绑定资产'
        : '上游暂无产物';
    return {
      nodeId: id,
      title: n.title || id,
      src: path ? previewUrlOf(path) : null,
      note,
      missing: false,
    };
  });
}

/**
 * 参考图展示区(image-edit 的 `ref-image` 端口专用,只读)。
 *
 * 与「输入图」卡**并列但语义独立**:这里展示的每一张都是「参考」,
 * 不参与「被编辑对象」的判定。多图时以网格铺开,每张带序号与来源说明;
 * 拿不到图的那一格显式标出原因(未跑/未加载/节点已删),不留白框。
 */
export function RefImagesCard({
  items,
  caption,
}: {
  items: RefImageItem[];
  /** 右上角说明(如「作为参考 · 非被编辑对象」) */
  caption?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="f-sec" data-od-id="ref-images-card">
      <div className="f-sec-h">
        <span className="lbl">参考图</span>
        <span className="mut" style={{ fontSize: 10.5 }}>
          {caption ?? '作为参考 · 非被编辑对象'}
        </span>
      </div>
      <div className="refgrid">
        {items.map((it, i) => (
          <div className="refcell" key={`${it.nodeId}-${i}`} data-od-id="ref-cell">
            <span className={`refthumb${it.src ? '' : ' empty'}`}>
              {it.src ? <img src={it.src} alt={it.title} loading="lazy" /> : null}
              <b className="refidx">{i + 1}</b>
            </span>
            <div className="refmeta">
              <div className="reftitle" title={it.title}>
                {it.title}
              </div>
              <div className={`refnote${it.missing || !it.src ? ' warn' : ''}`}>{it.note}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="seeds-hint" style={{ fontSize: 10.5 }}>
        <span>
          共 {items.length} 张 · 提交时按此顺序传给引擎(首张锚定几何)
          {items.some((x) => !x.src) ? ' · 有参考图未就绪,提交可能失败' : ''}
        </span>
      </div>
    </div>
  );
}

// ── I2I 图像强度滑块(0-1)→ --i2i-mode latent + --image-strength ──
export function ImageStrengthField({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="f-sec" data-od-id="field-image-strength" style={disabled ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
      <div className="f-sec-h">
        <span className="lbl">图像强度</span>
        <span className="mut" style={{ fontSize: 10.5 }}>→ <code>--i2i-mode latent</code></span>
      </div>
      <div className="range">
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="val mono">{value.toFixed(2)}</span>
      </div>
      <div className="range-scale">
        <span>0 (保留原图)</span><span>0.5</span><span>1 (完全重画)</span>
      </div>
      <div className="gs-sub" style={{ fontSize: 10.5 }}>推荐 0.35–0.6 · 低于 0.2 改不动,高于 0.8 会丢构图</div>
    </div>
  );
}

// ── 像素面积预算(output-resolution,仅 Qwen-Image-2.1 参考编辑)──
/**
 * `--output-resolution` 档位选择。
 *
 * ⚠️ **这个控件改的是清晰度,不是宽高比** —— 输出比例由**最后一张**参考图决定
 * (见 providers/mlxgen.ts 的 isQwen21Edit 注释)。控件里必须显式写出这件事,
 * 否则用户会以为调大它就能把竖版输出变横版(实测踩过:输入图 16:9 而参考图 3:4,
 * 输出跟着参考图变 896×1184,提示词里「保持四宫格布局」因此失效)。
 *
 * `predicted` = 按「最后一张参考图」比例 + 当前预算算出的预测尺寸;拿不到比例时为 null。
 */
export function OutputResolutionField({
  value,
  stops,
  predicted,
  onChange,
  disabled,
}: {
  value: number;
  stops: readonly number[];
  /** 预测输出尺寸(可能为 null = 拿不到最后一张参考图的比例) */
  predicted: { w: number; h: number } | null;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  /* 存量节点可能存了档位之外的值(手工填 / 历史值):一并列进选项,避免显示成空 */
  const options = stops.includes(value) ? stops : [...stops, value].sort((a, b) => a - b);
  return (
    <div className="f-sec" data-od-id="field-output-resolution" style={disabled ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
      <div className="f-sec-h">
        <span className="lbl">像素预算</span>
        <span className="mut" style={{ fontSize: 10.5 }}>→ <code>--output-resolution</code></span>
      </div>
      <div className="row g6" style={{ flexWrap: 'wrap' }}>
        {options.map((s) => (
          <span key={s} className={`chip${value === s ? ' on' : ''}`} onClick={() => onChange(s)}>
            {s}
            <span className="small mono">{s === 1024 ? 'default' : s > 1024 ? '高清' : '省算力'}</span>
          </span>
        ))}
      </div>
      {predicted ? (
        <div className="gs-sub" style={{ fontSize: 10.5 }} data-od-id="output-resolution-predicted">
          预计输出 <b className="mono">{predicted.w}×{predicted.h}</b> · 比例跟随<b>最后一张</b>参考图
        </div>
      ) : (
        <div className="gs-sub" style={{ fontSize: 10.5 }}>
          比例跟随<b>最后一张</b>参考图(现在拿不到它的尺寸,无法预测输出大小)
        </div>
      )}
      <div className="gs-sub" style={{ fontSize: 10.5 }}>
        ⚠️ 只改清晰度,<b>改不了宽高比</b> · 想锁比例请让最后一张参考图是目标比例(可加「图片裁切」节点)
      </div>
    </div>
  );
}

// ── 输出尺寸(显式 --width/--height,仅 Qwen-Image-2.1 参考编辑)──
/**
 * 输出尺寸控件:预设比例档位 + 自定义宽高输入。
 *
 * 语义(2026-10-08 读 mlx-gen 源码 + 真跑实测):
 *  - 编辑**可以**指定任意尺寸,**宽高比不受参考图约束**(实测参考图 3:4 → 输出 16:9 成功);
 *  - 「跟随参考图」= 不传 `--width/--height`,由引擎按最后一张参考图比例推导;
 *  - 硬约束只有一条:≥32 且 **32 的倍数**,否则 CLI 直接 exit。
 *
 * UI 上必须把「跟随参考图(默认)」与「指定尺寸」做成**互斥两态** ——
 * 否则用户不清楚自己到底是在用默认还是在覆盖。
 */
export function OutputSizeField({
  width,
  height,
  autoSize,
  predicted,
  presetLabel,
  onPickPreset,
  onManual,
  onUseAuto,
  disabled,
}: {
  width?: number;
  height?: number;
  /** true = 不传尺寸、跟随最后一张参考图比例 */
  autoSize: boolean;
  /** 跟随参考图时预测出的尺寸(拿不到比例为 null) */
  predicted: { w: number; h: number } | null;
  /** 命中的预设标签;null = 自定义 */
  presetLabel: string | null;
  onPickPreset: (p: { w: number; h: number }) => void;
  onManual: (w: number, h: number) => void;
  onUseAuto: () => void;
  disabled?: boolean;
}) {
  const [wRaw, setWRaw] = useState(width != null ? String(width) : '');
  const [hRaw, setHRaw] = useState(height != null ? String(height) : '');
  useEffect(() => {
    setWRaw(width != null ? String(width) : '');
    setHRaw(height != null ? String(height) : '');
  }, [width, height]);

  const wNum = parseSizeInput(wRaw);
  const hNum = parseSizeInput(hRaw);
  /** 填了但非法 → 明确报错(不静默规整,避免「显示 720 实跑别的」的静默不一致) */
  const wBad = wRaw.trim() !== '' && wNum === null;
  const hBad = hRaw.trim() !== '' && hNum === null;
  const canApply = wNum !== null && hNum !== null && (wNum !== width || hNum !== height);

  return (
    <div className="f-sec" data-od-id="field-output-size" style={disabled ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
      <div className="f-sec-h">
        <span className="lbl">输出尺寸</span>
        <span className="mut" style={{ fontSize: 10.5 }}>→ <code>--width</code> / <code>--height</code></span>
      </div>

      <div className="row g6" style={{ flexWrap: 'wrap' }}>
        <span className={`chip${autoSize ? ' on' : ''}`} onClick={onUseAuto} data-od-id="size-auto">
          跟随参考图
          <span className="small mono">{predicted ? `${predicted.w}×${predicted.h}` : 'auto'}</span>
        </span>
        {OUTPUT_SIZE_PRESETS.map((p) => (
          <span
            key={p.label}
            className={`chip${!autoSize && presetLabel === p.label ? ' on' : ''}`}
            onClick={() => onPickPreset(p)}
          >
            {p.label}
            <span className="small mono">{p.w}×{p.h}</span>
          </span>
        ))}
      </div>

      <div className="f-row" style={{ marginTop: 6 }}>
        <span className="f-lbl">自定义</span>
        <input
          className={`f-in mono${wBad ? ' f-in-bad' : ''}`}
          style={{ width: 76 }}
          placeholder="宽"
          value={wRaw}
          aria-invalid={wBad}
          data-od-id="size-width"
          onChange={(e) => setWRaw(e.target.value)}
        />
        <span className="mut">×</span>
        <input
          className={`f-in mono${hBad ? ' f-in-bad' : ''}`}
          style={{ width: 76 }}
          placeholder="高"
          value={hRaw}
          aria-invalid={hBad}
          data-od-id="size-height"
          onChange={(e) => setHRaw(e.target.value)}
        />
        <button
          className="btn btn-s btn-sm"
          type="button"
          disabled={!canApply}
          data-od-id="size-apply"
          onClick={() => { if (wNum !== null && hNum !== null) onManual(wNum, hNum); }}
        >
          应用
        </button>
      </div>

      {wBad || hBad ? (
        <div className="f-hint f-hint-bad" data-od-id="size-invalid">
          宽高必须是 <b>32 的倍数</b>且 ≥32(如 1280、704、864)。写成 720 这类非 32 倍数会被引擎拒绝。
        </div>
      ) : (
        <div className="gs-sub" style={{ fontSize: 10.5 }}>
          {autoSize
            ? '不传尺寸,由引擎按最后一张参考图比例自动推导'
            : `指定 ${width}×${height} · 不再跟随参考图比例`}
          {' · '}手动填写须为 <b>32 的倍数</b>
        </div>
      )}
    </div>
  );
}

// ── Outpaint 四边 padding(像素,步长 8)+ 导出尺寸示意 ──
export function OutpaintPads({
  sides,
  inputW,
  inputH,
  onChange,
  disabled,
}: {
  sides: { top: number; right: number; bottom: number; left: number };
  inputW?: number;
  inputH?: number;
  onChange: (sides: { top: number; right: number; bottom: number; left: number }) => void;
  disabled?: boolean;
}) {
  const set = (k: keyof typeof sides, v: number) => onChange({ ...sides, [k]: Math.max(0, v) });
  const bigPad = Math.max(sides.top, sides.right, sides.bottom, sides.left);
  return (
    <div className="f-sec" data-od-id="field-outpaint-pads" style={disabled ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
      <div className="f-sec-h">
        <span className="lbl">扩图边距</span>
        <span className="mut" style={{ fontSize: 10.5 }}>→ <code>--outpaint-padding</code> · 像素</span>
      </div>
      <div className="pad-grid">
        {(
          [
            ['Top', 'top'],
            ['Right', 'right'],
            ['Bottom', 'bottom'],
            ['Left', 'left'],
          ] as const
        ).map(([label, k]) => (
          <div className="pg" key={k}>
            <span>{label}</span>
            <input
              className="mono"
              type="number"
              min={0}
              step={8}
              value={sides[k]}
              onChange={(e) => set(k, Number(e.target.value) || 0)}
            />
          </div>
        ))}
      </div>
      {/* 视觉示意:上下左右以加描边色块表达 */}
      <div
        className="outpaint-svg"
        style={{
          position: 'relative',
          border: '1px solid var(--border-soft)',
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden',
          height: 96,
        }}
      >
        {sides.top ? (
          <div style={{ position: 'absolute', left: '14%', right: '14%', top: 0, height: `${Math.min(24, Math.max(6, sides.top / 20))}px`, background: 'repeating-linear-gradient(45deg,rgba(0,113,227,.18) 0 6px,transparent 6px 12px)' }} />
        ) : null}
        {sides.bottom ? (
          <div style={{ position: 'absolute', left: '14%', right: '14%', bottom: 0, height: `${Math.min(24, Math.max(6, sides.bottom / 20))}px`, background: 'repeating-linear-gradient(45deg,rgba(0,113,227,.18) 0 6px,transparent 6px 12px)' }} />
        ) : null}
        {sides.left ? (
          <div style={{ position: 'absolute', top: '10%', bottom: '10%', left: 0, width: `${Math.max(6, Math.min(30, sides.left / 14))}px`, background: 'repeating-linear-gradient(45deg,rgba(0,113,227,.18) 0 6px,transparent 6px 12px)' }} />
        ) : null}
        {sides.right ? (
          <div style={{ position: 'absolute', top: '10%', bottom: '10%', right: 0, width: `${Math.max(6, Math.min(30, sides.right / 14))}px`, background: 'repeating-linear-gradient(45deg,rgba(0,113,227,.18) 0 6px,transparent 6px 12px)' }} />
        ) : null}
        <div
          style={{
            position: 'absolute', left: '14%', right: '14%', top: '16%', bottom: '16%',
            display: 'grid', placeItems: 'center', border: '1px solid var(--border)',
          }}
        >
          <span className="mono mut" style={{ fontSize: 10.5 }}>
            原图 {inputW && inputH ? `${inputW}×${inputH}` : '—'}
          </span>
        </div>
      </div>
      {inputW && inputH ? (
        <div className="f-row">
          <span className="mut" style={{ fontSize: 10.5 }}>导出尺寸</span>
          <span className="mono" style={{ fontSize: 11.5 }}>
            {inputW + sides.left + sides.right}×{inputH + sides.top + sides.bottom}
          </span>
        </div>
      ) : null}
      {bigPad > 0 && (bigPad / Math.max(1, inputH || 1)) > 0.5 ? (
        <div className="gs-sub" style={{ fontSize: 10.5, color: 'var(--danger)' }}>任一边扩图比例 &gt; 50%,建议降低 padding 或分次扩图</div>
      ) : null}
    </div>
  );
}

// ── 遮罩编辑器(inpaint):框选矩形 / 拖入 PNG / 保存为遮罩资产 ──
// 遮罩生成不依赖底图像素:黑底 + 白矩形(白=重绘,黑=保留),天然无 CORS 风险。

export function MaskField({
  baseSrc,
  maskAssetId,
  maskSrc,
  onSave,
  onClear,
  onChangeAssetId,
  toastMsg,
}: {
  baseSrc: string | null;
  maskAssetId: string;
  maskSrc: string | null;
  onSave: (dataUrl: string) => void;
  onClear: () => void;
  onChangeAssetId: (v: string) => void;
  toastMsg: (m: string) => void;
}) {
  const zoneRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [drawing, setDrawing] = useState(false);

  const rectOf = (e: React.PointerEvent) => {
    const el = zoneRef.current;
    if (!el) return { x: 0, y: 0 };
    const b = el.getBoundingClientRect();
    return { x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height };
  };
  const onDown = (e: React.PointerEvent) => {
    if (!baseSrc) return;
    const p = rectOf(e);
    setRect({ x: p.x, y: p.y, w: 0, h: 0 });
    setDrawing(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drawing || !rect) return;
    const p = rectOf(e);
    setRect({ x: Math.min(rect.x, p.x), y: Math.min(rect.y, p.y), w: Math.abs(p.x - rect.x), h: Math.abs(p.y - rect.y) });
  };
  const onUp = () => setDrawing(false);

  const [maskInput, setMaskInput] = useState('');

  const saveMask = () => {
    if (!rect || rect.w < 0.005 || rect.h < 0.005) { toastMsg('先框选一个遮罩区域'); return; }
    // 黑底白矩形遮罩(尺寸跟随底图自然尺寸,缺省 1024)
    const gen = (w: number, h: number): void => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) { toastMsg('画布不可用'); return; }
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      ctx.fillRect(Math.round(rect.x * w), Math.round(rect.y * h), Math.round(rect.w * w), Math.round(rect.h * h));
      onSave(c.toDataURL('image/png'));
    };
    if (!baseSrc) { gen(1024, 1024); return; }
    const img = new Image();
    img.onload = () => gen(img.naturalWidth || 1024, img.naturalHeight || 1024);
    img.onerror = () => toastMsg('底图加载失败,无法按原尺寸生成遮罩');
    img.src = baseSrc;
  };
  const onDropFile = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (!f || !f.type.startsWith('image/')) { toastMsg('拖入的不是图片'); return; }
    const rd = new FileReader();
    rd.onload = () => onSave(String(rd.result));
    rd.readAsDataURL(f);
  };

  return (
    <div className="f-sec" data-od-id="field-mask">
      <div className="f-sec-h">
        <span className="lbl">遮罩</span>
        <span className="mut" style={{ fontSize: 10.5 }}>→ <code>--mask-path</code> · 必填</span>
      </div>
      {maskAssetId ? (
        <div className="upstream">
          <span className="uprev">{maskSrc ? <img src={maskSrc} alt="遮罩" /> : null}</span>
          <div className="grow ucut">
            <div className="ulabel">遮罩资产已绑定</div>
            <div className="usub mono">{maskAssetId}</div>
          </div>
          <span className="upill" onClick={onClear} style={{ cursor: 'pointer' }}>清除</span>
        </div>
      ) : (
        <div
          className="mask-zone"
          onDrop={onDropFile}
          onDragOver={(e) => e.preventDefault()}
        >
          <div className="mask-tools">
            <span className="tool on">框选</span>
            <span className="mut" style={{ fontSize: 10.5 }}>· 或拖入已制好的遮罩 PNG(白=重绘)</span>
          </div>
          <div
            ref={zoneRef}
            className="mask-canvas"
            style={{ cursor: baseSrc ? 'crosshair' : 'not-allowed' }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
          >
            {baseSrc ? <img className="src" src={baseSrc} alt="" /> : <div className="mask-tip">需先绑定输入图</div>}
            {rect && rect.w > 0.002 && rect.h > 0.002 ? (
              <div
                className="mask"
                style={{
                  left: `${rect.x * 100}%`, top: `${rect.y * 100}%`,
                  width: `${rect.w * 100}%`, height: `${rect.h * 100}%`,
                }}
              />
            ) : null}
          </div>
          <div className="seeds-hint" style={{ fontSize: 10.5 }}>
            <span>
              {rect ? `遮罩区 ${Math.round(rect.w * 100)}%×${Math.round(rect.h * 100)}% · ` : ''}
              <a onClick={saveMask} style={{ cursor: 'pointer', color: 'var(--accent)' }}>保存遮罩为资产</a>
              {' · '}也可以手填遮罩 Asset ID
            </span>
          </div>
          <input
            className="f-in mono"
            style={{ width: '100%' }}
            placeholder="遮罩 Asset ID(与框选二选一,回车生效)"
            value={maskInput}
            onChange={(e) => setMaskInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && maskInput.trim()) {
                onChangeAssetId(maskInput.trim());
                setMaskInput('');
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

export function ActionBar({
  primary,
  primaryLabel,
  primaryIcon,
  disabled,
  secondary,
  onSecondary,
  hint,
}: {
  primary: () => void;
  primaryLabel: string;
  primaryIcon?: 'gen' | 'regen';
  disabled?: boolean;
  secondary?: string;
  onSecondary?: () => void;
  hint?: string;
}) {
  return (
    <div className="action-bar">
      <button className="btn btn-p" data-od-id="cta-generate" type="button" disabled={disabled} onClick={primary} style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}>
        {primaryIcon === 'regen' ? (
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.8}><path d="M11.5 7a4.5 4.5 0 1 1-1.3-3.2M11.5 2v3h-3" /></svg>
        ) : (
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.8}><path d="M3 7h8M7 3l4 4-4 4" /></svg>
        )}
        {primaryLabel}
      </button>
      {secondary ? (
        <button className="btn btn-s" type="button" onClick={onSecondary}>{secondary}</button>
      ) : null}
      {hint ? <span className="mut" style={{ fontSize: 10.5, alignSelf: 'center' }}>{hint}</span> : null}
    </div>
  );
}