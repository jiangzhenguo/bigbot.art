/**
 * ToolModelsSection — 设置页「工具模型」分组(2026-09-29 v1)
 *
 * 按能力指定默认模型:节点未显式选模型时,生成/Agent 缺省取这里的值
 * (优先级:节点 data.model > 本设置 > DEFAULT_TOOL_MODELS)。
 * 设计:docs/工具模型选择-产品设计与技术方案.md §5。
 */
import React, { useEffect, useState } from 'react';
import type { AppSettings, ToolModelBinding } from '@bigbotart/shared';
import {
  DEFAULT_TOOL_MODELS,
  MODEL_CAPABILITIES,
  supportsCapability,
  type ImageCapability,
} from '@bigbotart/shared';
import { ModelCombo, matchModel, IMAGE_MODELS } from '../pages/canvas/inspector/ModelCombo';
import { setToolModelsCache } from '../pages/canvas/tool-models-store';
import { useT } from '../i18n';

/** 图片能力行的展示元数据(顺序即 UI 顺序) */
const IMAGE_ROWS: Array<{ cap: ImageCapability; label: string; hint: string }> = [
  { cap: 'image.generate', label: '文生图', hint: 'image-gen 节点 · 无参考图' },
  { cap: 'image.multiReference', label: '多参考生成', hint: 'image-gen 带 ref-image 连线 · 当前仅 Flux.2 Klein 支持(无上限)' },
  { cap: 'image.img2img', label: '图生图', hint: 'image-edit · 图生图(latent)' },
  { cap: 'image.instruction', label: '指令编辑', hint: 'image-edit · 指令编辑(2.1 支持 1-10 张参考图)' },
  { cap: 'image.inpaint', label: '局部重绘', hint: 'image-edit · Inpaint(需遮罩)' },
  { cap: 'image.outpaint', label: '扩图', hint: 'image-edit · Outpaint' },
  { cap: 'image.upscale', label: '图片超分', hint: 'image-upscale · SeedVR2' },
];

/** 视觉关键字启发式(决策 7 §4.2.1:模型名无这些字样时提示「可能无视觉能力」) */
const VISION_HINT_RE = /vl|vision|visual|minicpm-v|llava|qwen2\.5-vl|qwen3-vl|internvl/i;

export function ToolModelsSection() {
  const t = useT();
  const [tm, setTm] = useState<ToolModelBinding>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cloudProviders, setCloudProviders] = useState<AppSettings['cloudProviders']>([]);
  // vision 行的紧凑表单状态
  const [vlmModel, setVlmModel] = useState('');
  const [visionKind, setVisionKind] = useState<'none' | 'mlxgen-caption' | 'lmstudio' | 'cloud' | 'openai-compatible'>('none');
  const [visionCloudId, setVisionCloudId] = useState('');
  const [visionCompatUrl, setVisionCompatUrl] = useState('');

  /* 挂载回填 */
  useEffect(() => {
    let alive = true;
    void window.bigbotart.getSettings().then((s: AppSettings) => {
      if (!alive) return;
      const cur = s.toolModels ?? {};
      setTm(cur);
      setCloudProviders(s.cloudProviders ?? []);
      const v = cur.vision;
      if (cur.captionLocal) { setVisionKind('mlxgen-caption'); setVlmModel(cur.captionLocal.model ?? ''); }
      else if (!v) setVisionKind('none');
      else if (v.kind === 'lmstudio') { setVisionKind('lmstudio'); setVlmModel(v.model ?? ''); }
      else if (v.kind === 'cloud') { setVisionKind('cloud'); setVisionCloudId(v.provider); setVlmModel(v.model ?? ''); }
      else if (v.kind === 'openai-compatible') { setVisionKind('openai-compatible'); setVisionCompatUrl(v.baseUrl); setVlmModel(v.model ?? ''); }
      else setVisionKind('none');
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  const save = (next: ToolModelBinding) => {
    setTm(next);
    setSaving(true);
    void window.bigbotart
      .setSettings({ toolModels: next })
      .then(() => setToolModelsCache(next))
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  const setCap = (cap: ImageCapability, repoId: string) => {
    save({ ...tm, image: { ...(tm.image ?? {}), [cap]: repoId } });
  };

  const capValue = (cap: ImageCapability): string =>
    tm.image?.[cap] && tm.image[cap]!.trim() ? tm.image[cap]! : DEFAULT_TOOL_MODELS[cap];

  /**
   * 保存看图通道。两条通道**互斥**:选一条就把另一条显式置 undefined
   * (settings.json 是整体替换 toolModels,JSON.stringify 会丢掉 undefined 键 → 真的被清掉)。
   */
  const saveVision = (kind: typeof visionKind, model: string, cloudId: string, compatUrl: string) => {
    const next: ToolModelBinding = { ...tm, vision: undefined, captionLocal: undefined };
    if (kind === 'mlxgen-caption') next.captionLocal = { model: model.trim() || undefined };
    else if (kind === 'lmstudio') next.vision = { kind: 'lmstudio', model: model.trim() || undefined };
    else if (kind === 'cloud' && cloudId) next.vision = { kind: 'cloud', provider: cloudId, model: model.trim() || undefined };
    else if (kind === 'openai-compatible' && compatUrl.trim()) next.vision = { kind: 'openai-compatible', baseUrl: compatUrl.trim(), model: model.trim() || undefined };
    save(next);
  };

  /* 当前生效的看图来源(三态透明化,决策 7) */
  const visionStatus = (() => {
    if (tm.captionLocal) {
      return {
        ok: true,
        text: tm.captionLocal.model?.trim()
          ? `${t('已配置')}:${t('本地引擎 mlxgen-caption')} · ${tm.captionLocal.model.trim()}`
          : `${t('已配置')}:${t('本地引擎 mlxgen-caption')} · ${t('自动发现本机 MLX Qwen3-VL 检查点')}`,
      };
    }
    const v = tm.vision;
    if (v && v.kind !== 'none') {
      const modelName =
        v.kind === 'cloud'
          ? (v.model ?? cloudProviders?.find((p) => p.id === v.provider)?.models[0] ?? '')
          : ('model' in v ? (v.model ?? '') : '');
      const uncertain = modelName && !VISION_HINT_RE.test(modelName);
      return {
        ok: true,
        text: `${t('已配置')}:${modelName || v.kind}${uncertain ? ` · ${t('⚠️ 该模型可能无视觉能力')}` : ''}`,
      };
    }
    return {
      ok: false,
      text: t('未配置:按回退链(env BIGBOTART_VL_* → 主 LLM → 本地默认);失败时会给出配置指引'),
    };
  })();

  const enabledCloud = (cloudProviders ?? []).filter((p) => p.enabled && p.hasKey);

  return (
    <div className="group" data-group="toolModels" data-od-id="settings-tool-models">
      <div className="gh">
        <b>{t('工具模型')}</b>
        <span className="spacer" />
        <span className="mono mut" style={{ fontSize: 11 }}>
          {saving ? t('保存中…') : loaded ? t('已保存即生效') : ''}
        </span>
      </div>
      <div className="tm-intro">
        {t('这里设置的模型,会在对应节点没有单独指定模型时生效;节点检查器里显式选的模型始终优先。Agent 对话 / 规划 / 压缩的模型请到「LLM 来源」设置。')}
      </div>

      {/* ── A. 图片生成 ── */}
      <div className="tm-sec">
        <span className="lbl">{t('图片生成')}</span>
        <span className="tm-note">{t('下拉按能力过滤(实测矩阵);未下载的模型可直接点徽章下载')}</span>
      </div>
      {IMAGE_ROWS.map((row) => {
        const val = capValue(row.cap);
        const isDefault = val === DEFAULT_TOOL_MODELS[row.cap];
        return (
          <div className="srow" key={row.cap} style={{ alignItems: 'flex-start' }}>
            <div className="grow">
              <b>{t(row.label)}</b>
              <div className="sub" style={{ marginTop: 2 }}>{t(row.hint)}</div>
              <div className="row g8" style={{ marginTop: 8 }}>
                <ModelCombo
                  value={val}
                  onChange={(repoId) => setCap(row.cap, repoId)}
                  filter={(m) => supportsCapability(m.repoId, row.cap)}
                />
                {!isDefault ? (
                  <button
                    className="btn btn-s btn-sm"
                    type="button"
                    title={`恢复默认:${matchModel(DEFAULT_TOOL_MODELS[row.cap])?.name ?? DEFAULT_TOOL_MODELS[row.cap]}`}
                    onClick={() => setCap(row.cap, DEFAULT_TOOL_MODELS[row.cap])}
                  >
                    {t('恢复默认')}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}

      {/* ── B. 看图反推 ── */}
      <div className="tm-sec">
        <span className="lbl">{t('看图反推')}</span>
        <span className="tm-note">{t('vision.caption · 图片 → 提示词(Agent 看图的通道)')}</span>
      </div>
      <div className="srow" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <div className="row g8" style={{ marginBottom: 10 }}>
            <span className={`badge${visionStatus.ok ? ' ok' : ''}`}>
              {visionStatus.ok ? <span className="dot ok" /> : null}
              {visionStatus.text}
            </span>
          </div>
          <div className="row g8">
            <select
              className="sel"
              value={visionKind}
              onChange={(e) => {
                const k = e.target.value as typeof visionKind;
                setVisionKind(k);
                saveVision(k, vlmModel, visionCloudId, visionCompatUrl);
              }}
            >
              <option value="none">{t('未配置(按回退链)')}</option>
              <option value="mlxgen-caption">{t('本地 · mlxgen-caption(免 LM Studio)')}</option>
              <option value="lmstudio">{t('本地 · LM Studio')}</option>
              <option value="cloud">{t('云端供应商')}</option>
              <option value="openai-compatible">{t('OpenAI 兼容端点')}</option>
            </select>
            {visionKind === 'cloud' ? (
              <select
                className="sel"
                value={visionCloudId}
                onChange={(e) => {
                  setVisionCloudId(e.target.value);
                  saveVision('cloud', vlmModel, e.target.value, visionCompatUrl);
                }}
              >
                <option value="">{t('选择供应商…')}</option>
                {enabledCloud.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            ) : null}
            {visionKind === 'openai-compatible' ? (
              <span className="input-w mono">
                <input
                  placeholder="https://…/v1"
                  value={visionCompatUrl}
                  onChange={(e) => {
                    setVisionCompatUrl(e.target.value);
                  }}
                  onBlur={() => saveVision('openai-compatible', vlmModel, visionCloudId, visionCompatUrl)}
                />
              </span>
            ) : null}
          </div>
          {visionKind !== 'none' ? (
            <div className="row g8 tm-field">
              <span className="input-w mono">
                <input
                  placeholder={
                    visionKind === 'cloud'
                      ? t('模型名(留空 = 供应商首个模型)')
                      : visionKind === 'mlxgen-caption'
                        ? t('checkpoint 目录路径 / owner/name 仓库 id(留空 = 自动发现)')
                        : t('模型名(如 qwen3-vl-8b-instruct)')
                  }
                  value={vlmModel}
                  onChange={(e) => setVlmModel(e.target.value)}
                  onBlur={() => saveVision(visionKind, vlmModel, visionCloudId, visionCompatUrl)}
                />
              </span>
            </div>
          ) : null}
          {visionKind === 'mlxgen-caption' ? (
            <div className="sub" style={{ marginTop: 6 }}>
              {t(
                '提示:走 mlx-gen 新增的 mlxgen-caption(本地 MLX Qwen3-VL,不需要启动 LM Studio)。留空即自动发现 ~/.lmstudio/models、~/ai/models 与本机 HF 缓存里的 MLX 格式 Qwen3-VL(「模型下载」里的 Qwen3-VL 8B caption 下完,或已在 LM Studio 里,都会被认到)。**填 LM Studio 的模型名也行**——会自动匹配到本机那份 checkpoint;填错(既不是目录也不是仓库 id 又匹配不到)时会明确告诉你原因。引擎命令缺失时会给安装指引。',
              )}
            </div>
          ) : null}
          {visionKind === 'lmstudio' ? (
            <div className="sub" style={{ marginTop: 6 }}>
              {t('提示:请在 LM Studio 里加载一个**视觉**模型(Qwen3-VL / Qwen2.5-VL 等),再把模型名填在这里。若不想开 LM Studio,把上面改成「本地 · mlxgen-caption」。')}
            </div>
          ) : null}
        </div>
      </div>

      {/* ── C. 视频镜头(只读) ── */}
      <div className="tm-sec">
        <span className="lbl">{t('视频镜头')}</span>
      </div>
      <div className="srow">
        <div className="grow">
          <b>h3.c · MiniMax-H3</b>
          <div className="sub">{t('本地 checkpoint(约 144GB),暂不支持更换;就绪状态见「引擎」分组探测。')}</div>
        </div>
      </div>
    </div>
  );
}

export { IMAGE_MODELS };
