import React, { useState, useEffect, useRef } from 'react';
import type { AppSettings, Asset, LlmSource, RenderJob, Skill } from '@bigbotart/shared';
import { usePrompt } from '../components/usePrompt';
import { useRenderQueue } from './useRenderQueue';
import { useT } from '../i18n';
import { llmDisplayName } from './agent/llm-display';
import brandIcon from '../assets/icon.png';

export type HomePageTarget =
  | 'home'
  | 'canvas'
  | 'assets'
  | 'skills'
  | 'timeline'
  | 'settings'
  | 'onboarding'
  | 'projects';

/** 生成请求附带的选项(技能 + 模型 + 参考附件),由 App 带新项目进画布 Agent */
export interface GenerateOpts {
  skillId?: string | null;
  /** 首页选择的 LLM 来源 → 写为新项目的项目级覆盖(画布 Agent 优先读项目级) */
  llm?: LlmSource | null;
  attachments?: Array<{ id: string; name: string; kind: string; localPath: string }>;
}

interface HomePageProps {
  onNavigate: (page: HomePageTarget) => void;
  onGenerate: (brief: string, opts?: GenerateOpts) => void;
  onNewProject: (name?: string) => void;
  projects: Array<{ id: string; name: string; createdAt: string }>;
  onSelectProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onRenameProject: (id: string, name: string) => void;
  engineStatus: {
    h3c: { ready: boolean; text: string };
    mlxgen: { ready: boolean; text: string };
    llm: { ready: boolean; text: string };
  };
}

const QUICK_SKILLS = [
  { label: '剧情短片', fill: '用三幕结构写一部 45 秒剧情短片：主角在旧车站错过一班列车，却在站台重逢多年未见的朋友。', skill: '剧情短片' },
  { label: '电商产品', fill: '为保温杯生成 3 个视角的产品视频：侧视旋转、开盖特写、户外使用场景，统一浅灰背景。', skill: '电商产品' },
  { label: '科普讲解', fill: '做一支 60 秒科普短片解释日全食：从月球轨道切入，到贝利珠瞬间，图文穿插。', skill: '科普讲解' },
  { label: '水墨', fill: '水墨风格山水短片：远山、孤舟、留白，镜头缓慢横移，30 秒。', skill: '水墨' },
  { label: '纸拼贴', fill: '帮我在导演台搭一场戏：男女主在草原上走，遇到一条很宽的河，女主跃过河，男主在岸边踱步。纸拼贴风格，60 秒以内。', skill: '纸拼贴剧情片' },
];

/** 附件媒体类型中文名(t() key,与 assets 字典共用) */
const KIND_LABEL: Record<string, string> = { image: '图片', video: '视频', audio: '音频', document: '文档' };

/** 资产缩略图(仅图片有;与 AssetCard.thumbOf 同口径) */
function thumbOf(a: { kind: string; localPath: string }): string | null {
  if (a.kind === 'image' && a.localPath) return `bba-asset://${a.localPath.split('/').pop()}`;
  return null;
}

const PROJ_THUMBS = ['./assets/shot-01.jpg', './assets/eclipse.jpg', './assets/prop-bottle.jpg', './assets/ink.jpg'];

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 引擎 provider 展示名(队列状态文案用) */
const PROVIDER_LABEL: Record<string, string> = { h3c: 'h3.c', mlxgen: 'mlxgen', mock: '演示', llm: 'LLM' };

/** t() 的函数签名(模块级纯函数无法直接用 hook,由组件注入) */
type TFn = (s: string, vars?: Record<string, string | number>) => string;

/** 首页 live-card 三态视图数据(纯函数;运行中 / 排队中 / 空闲) */
function liveCardView(
  t: TFn,
  running: RenderJob | null,
  queued: number,
  projects: Array<{ id: string; name: string }>,
): { title: string; badge: string; pct: number; showBar: boolean; note: string; projectId?: string } {
  if (running) {
    const provider = t(PROVIDER_LABEL[running.provider] ?? running.provider);
    const pct = Math.round((running.progress ?? 0) * 100);
    const name = running.projectId ? projects.find((p) => p.id === running.projectId)?.name : undefined;
    return {
      title: name ?? t('渲染任务'),
      badge: `${provider} · ${pct}%`,
      pct,
      showBar: true,
      note: `${provider} ${running.stage ?? t('生成中…')}`,
      projectId: running.projectId,
    };
  }
  if (queued > 0) {
    return {
      title: t('任务排队中'),
      badge: t('排队 #{n}', { n: queued }),
      pct: 0,
      showBar: false,
      note: t('{n} 个任务等待 · FIFO 串行', { n: queued }),
    };
  }
  return { title: t('队列空闲'), badge: t('空闲'), pct: 0, showBar: false, note: t('暂无进行中任务 · 点此进入画布') };
}

export default function HomePage({
  onNavigate,
  onGenerate,
  onNewProject,
  projects,
  onSelectProject,
  onDeleteProject,
  onRenameProject,
  engineStatus,
}: HomePageProps) {
  const t = useT();
  const [brief, setBrief] = useState('');
  /* ── 真实 LLM 来源(getSettings 回填;切换经 setSettings 持久化) ── */
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [llmSrc, setLlmSrc] = useState<LlmSource | null>(null);
  /* ── 真实技能列表(listSkills);skillId=null = 无技能 ── */
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillId, setSkillId] = useState<string | null>(null);
  const [showModelPop, setShowModelPop] = useState(false);
  const [showSkillPop, setShowSkillPop] = useState(false);
  /* ── 真实附件(importAssets 从磁盘导入进资产库) ── */
  const [attachments, setAttachments] = useState<Asset[]>([]);
  const [hoverId, setHoverId] = useState<string | null>(null);

  /* 挂载时拉取设置与技能列表 */
  useEffect(() => {
    let alive = true;
    window.bigbotart
      .getSettings()
      .then((s) => {
        if (!alive) return;
        setAppSettings(s);
        setLlmSrc(s.llm ?? null);
      })
      .catch((e) => console.error('读取设置失败', e));
    window.bigbotart
      .listSkills()
      .then((list) => {
        if (alive) setSkills(list);
      })
      .catch((e) => console.error('读取技能列表失败', e));
    return () => {
      alive = false;
    };
  }, []);

  const llmLabel = llmDisplayName(llmSrc, appSettings);
  const skillName = skillId ? (skills.find((s) => s.id === skillId)?.name ?? t('无技能')) : t('无技能');
  const cloudProviders = appSettings?.cloudProviders ?? [];

  /* ── 真实渲染队列:主进程 RenderQueue 状态(提交/进度/完成/取消 均经 onQueueChanged 推送) ── */
  const { running, queued } = useRenderQueue();
  const live = liveCardView(t, running, queued, projects);

  /* ── 新建项目弹窗 ── */
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const newInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (newOpen) newInputRef.current?.focus();
  }, [newOpen]);
  const openNewProject = () => {
    setNewName('');
    setNewOpen(true);
  };
  const submitNewProject = () => {
    const name = newName.trim();
    onNewProject(name || t('未命名项目 {n}', { n: projects.length + 1 }));
    setNewOpen(false);
  };

  const areaRef = React.useRef<HTMLTextAreaElement>(null);
  const modelChipRef = React.useRef<HTMLButtonElement>(null);
  const modelPopRef = React.useRef<HTMLDivElement>(null);
  const skillChipRef = React.useRef<HTMLButtonElement>(null);
  const skillPopRef = React.useRef<HTMLDivElement>(null);

  // 弹层交互:点击弹层/按钮内部不动,点空白或 Esc 关闭(对应 home.js 的 closeAll / bindPop)
  React.useEffect(() => {
    if (!showModelPop && !showSkillPop) return;
    const insidePop = (t: Node | null) =>
      [modelChipRef, modelPopRef, skillChipRef, skillPopRef].some((r) => r.current?.contains(t));
    const onDown = (e: MouseEvent) => {
      if (!insidePop(e.target as Node)) {
        setShowModelPop(false);
        setShowSkillPop(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowModelPop(false);
        setShowSkillPop(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showModelPop, showSkillPop]);

  const handleGenerate = () => {
    if (!brief.trim()) return;
    onGenerate(brief, {
      skillId,
      llm: llmSrc,
      attachments: attachments.map((a) => ({ id: a.id, name: a.name, kind: a.kind, localPath: a.localPath })),
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleGenerate();
    }
  };

  /* 切换 LLM 来源:本地默认 / 云端供应商模型,写回 settings.json */
  const pickLlm = (src: LlmSource) => {
    setLlmSrc(src);
    setShowModelPop(false);
    window.bigbotart
      .setSettings({ llm: src })
      .then((s) => {
        setAppSettings(s);
        setLlmSrc(s.llm ?? src);
      })
      .catch((e) => console.error('保存 LLM 来源失败', e));
  };

  const handlePickSkill = (id: string | null) => {
    setSkillId(id);
    setShowSkillPop(false);
  };

  const handleQuickSkill = (fill: string, skillName: string) => {
    setBrief(fill);
    // 按名称匹配真实技能(内置技能如「纸拼贴剧情片」在技能库中;匹配不到则为无技能)
    setSkillId(skills.find((s) => s.name === skillName)?.id ?? null);
    areaRef.current?.focus();
  };

  /* 真实附件导入:系统对话框选文件 → 复制进资产库(全局);取消则静默 */
  const handleAddAttachment = async () => {
    try {
      const res = await window.bigbotart.importAssets();
      if (res.assets.length === 0) return;
      setAttachments((prev) => [...prev, ...res.assets.filter((a) => !prev.some((x) => x.id === a.id))]);
    } catch (e) {
      console.error('导入附件失败', e);
    }
  };

  const handleRemoveAttachment = (index: number) => {
    setAttachments(attachments.filter((_, i) => i !== index));
  };

  const { ask: askPrompt, dialog: promptDialog } = usePrompt();

  const handleRename = async (id: string, currentName: string) => {
    const next = await askPrompt({ title: t('重命名项目'), initial: currentName });
    if (next && next.trim() && next !== currentName) {
      onRenameProject(id, next.trim());
    }
  };

  const handleDelete = (id: string, name: string) => {
    if (confirm(t('确定删除项目「{name}」吗?此操作不可恢复。', { name }))) {
      onDeleteProject(id);
    }
  };

  const renderSideLink = (item: { label: string; page: HomePageTarget }, icon: React.ReactNode) => (
    <a
      className={`side-link${item.page === 'home' ? ' on' : ''}`}
      href="#"
      onClick={(e) => {
        e.preventDefault();
        onNavigate(item.page);
      }}
    >
      {icon}
      {t(item.label)}
    </a>
  );

  return (
    <div className="pg-home">
      {promptDialog}
      <div className="app" data-od-id="home-app">
        {/* 左导航 */}
        <aside className="side" data-od-id="home-nav">
          <a
            className="side-brand"
            href="#"
            title={t('返回原型总览')}
            onClick={(e) => {
              e.preventDefault();
              onNavigate('home');
            }}
          >
            <span className="mk has-img">
              <img src={brandIcon} alt="BigBotArt" />
            </span>
            BigBotArt
          </a>
          <div style={{ padding: '2px 12px 10px' }}>
            <button className="btn btn-s" style={{ width: '100%' }} id="newProject" data-od-id="home-new-project" onClick={openNewProject}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <path d="M12 5v14M5 12h14" />
              </svg>
              {t('新建项目')}
            </button>
          </div>
          <nav className="side-nav">
            <div className="lbl">{t('创作')}</div>
            {renderSideLink(
              { label: '首页', page: 'home' },
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M3 10.5 12 3l9 7.5" />
                <path d="M5.5 9.5V21h13V9.5" />
              </svg>,
            )}
            {renderSideLink(
              { label: '画布工作台', page: 'canvas' },
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>,
            )}
            <div className="lbl">{t('资源')}</div>
            {renderSideLink(
              { label: '资产中心', page: 'assets' },
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <circle cx="9" cy="10" r="1.8" />
                <path d="m4.5 18 5-5 3.5 3.5 3-3 3.5 3.5" />
              </svg>,
            )}
            {renderSideLink(
              { label: 'Skills 库', page: 'skills' },
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="m12 3 2.2 5.3L20 9.2l-4.2 3.9 1.2 5.9-5-3-5 3 1.2-5.9L4 9.2l5.8-.9Z" />
              </svg>,
            )}
            <div className="lbl">{t('系统')}</div>
            {renderSideLink(
              { label: '设置', page: 'settings' },
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <circle cx="12" cy="12" r="3" />
                <path d="M19 12a7 7 0 0 0-.14-1.4l2.1-1.63-2-3.46-2.48 1a7 7 0 0 0-2.42-1.4L13.7 2.5h-3.4l-.36 2.61a7 7 0 0 0-2.42 1.4l-2.48-1-2 3.46 2.1 1.63a7 7 0 0 0 0 2.8l-2.1 1.63 2 3.46 2.48-1a7 7 0 0 0 2.42 1.4l.36 2.61h3.4l.36-2.61a7 7 0 0 0 2.42-1.4l2.48 1 2-3.46-2.1-1.63c.09-.46.14-.93.14-1.4Z" />
              </svg>,
            )}
            {renderSideLink(
              { label: '引擎引导向导', page: 'onboarding' },
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M12 2 4 6v6c0 5 3.4 8.4 8 10 4.6-1.6 8-5 8-10V6Z" />
                <path d="m9 12 2 2 4-4.5" />
              </svg>,
            )}
          </nav>
          <div className="side-foot" data-od-id="home-engine-status">
            <div className="lbl" style={{ marginBottom: '8px' }}>{t('引擎状态')}</div>
            <div className="eng-card">
              <div className="row">
                <span className="row g6">
                  <span className={`dot${engineStatus.h3c.ready ? ' ok' : ''}`}></span>
                  {t('视频槽位 · h3.c')}
                </span>
                <span className="mono mut" style={{ fontSize: '11px' }}>{engineStatus.h3c.text}</span>
              </div>
              <div className="row">
                <span className="row g6">
                  <span className={`dot${engineStatus.mlxgen.ready ? ' ok' : ''}`}></span>
                  {t('图片槽位 · mlxgen')}
                </span>
                <span className="mono mut" style={{ fontSize: '11px' }}>{engineStatus.mlxgen.text}</span>
              </div>
              <div className="row">
                <span className="row g6">
                  <span className={`dot${engineStatus.llm.ready ? ' ok' : ''}`}></span>
                  LLM
                </span>
                <span className="mono" style={{ fontSize: '11px' }}>{engineStatus.llm.text}</span>
              </div>
            </div>
          </div>
        </aside>

        {/* 中间:需求输入 */}
        <main className="intake" data-od-id="home-intake">
          <p className="lbl" style={{ margin: 0 }}>{t('本地优先 · 全部数据留在本机')}</p>
          <h1>{t('今天想创作什么？')}</h1>

          <div className="composer" data-od-id="intake-composer">
            {attachments.length > 0 && (
              <div className="attach-row" id="attachRow">
                {attachments.map((att, i) => {
                  const thumb = thumbOf(att);
                  return (
                    <span className="attach" key={att.id}>
                      <span className="thumb">
                        {thumb ? <img src={thumb} alt="" /> : null}
                      </span>
                      <span>{att.name}</span>
                      <span className="mono mut" style={{ fontSize: '10px' }}>{t(KIND_LABEL[att.kind] ?? att.kind)}</span>
                      <button className="x" aria-label={t('移除附件')} onClick={() => handleRemoveAttachment(i)}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                          <path d="M6 6l12 12M18 6 6 18" />
                        </svg>
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
            <textarea
              id="intakeText"
              ref={areaRef}
              placeholder={t('一句话描述你的视频 / 图片需求，例如：「帮我在导演台搭一场戏：男女主在草原上走，遇到一条很宽的河……」')}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <div className="row g8" style={{ borderTop: '1px solid var(--border-soft)', paddingTop: '10px', marginTop: '8px', position: 'relative' }}>
              <button className="btn btn-g btn-sm" id="attachBtn" onClick={handleAddAttachment}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="m21 11.5-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.85 1.85 0 0 1-2.6-2.6l7.8-7.8" />
                </svg>
                {t('参考图 / 文件')}
              </button>
              <button
                className="chip"
                id="modelChip"
                ref={modelChipRef}
                data-od-id="intake-model"
                onClick={() => {
                  setShowSkillPop(false);
                  setShowModelPop((v) => !v);
                }}
              >
                {llmLabel}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
              {showModelPop && (
                <div className="pop open" id="modelPop" ref={modelPopRef} style={{ bottom: '44px', left: '150px' }}>
                  <div className="pop-it" onClick={() => pickLlm({ kind: 'lmstudio', model: appSettings?.lmStudioModel })}>
                    {`${appSettings?.lmStudioModel ?? '默认模型'} · 本地`}
                    {llmSrc?.kind === 'lmstudio' && <span className="ck">✓</span>}
                  </div>
                  {cloudProviders.flatMap((p) =>
                    p.models.map((m) => (
                      <div
                        key={`${p.id}:${m}`}
                        className="pop-it"
                        onClick={() => pickLlm({ kind: 'cloud', provider: p.id, model: m })}
                      >
                        {m} · {p.name}
                        {llmSrc?.kind === 'cloud' && llmSrc.provider === p.id && llmSrc.model === m && <span className="ck">✓</span>}
                      </div>
                    )),
                  )}
                  <div
                    className="pop-it dim"
                    onClick={() => {
                      setShowModelPop(false);
                      onNavigate('settings');
                    }}
                  >
                    {t('更多模型 · 到设置页配置…')}
                  </div>
                </div>
              )}
              <button
                className="chip"
                id="skillChip"
                ref={skillChipRef}
                data-od-id="intake-skill"
                onClick={() => {
                  setShowModelPop(false);
                  setShowSkillPop((v) => !v);
                }}
              >
                {skillName}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
              {showSkillPop && (
                <div className="pop open" id="skillPop" ref={skillPopRef} style={{ bottom: '44px', left: '290px' }}>
                  <div className="pop-it" onClick={() => handlePickSkill(null)}>
                    {t('无技能 · 自由编排')}
                    {skillId === null && <span className="ck">✓</span>}
                  </div>
                  {skills.map((s) => (
                    <div key={s.id} className="pop-it" data-skill={s.id} onClick={() => handlePickSkill(s.id)}>
                      {s.name}
                      {skillId === s.id && <span className="ck">✓</span>}
                    </div>
                  ))}
                  {skills.length === 0 && <div className="pop-it dim">{t('技能库为空 · 可在 Skills 库页创建')}</div>}
                </div>
              )}
              <span className="spacer"></span>
              <span className="mono mut" style={{ fontSize: '11px' }}>{t('规划 Agent · {model}', { model: llmLabel })}</span>
              <button className="btn btn-p" id="goBtn" data-od-id="intake-generate" onClick={handleGenerate}>
                {t('生成')}
              </button>
            </div>
          </div>

          <div className="skill-quick" data-od-id="skill-quick">
            <span className="lbl" style={{ width: '100%', textAlign: 'center', marginBottom: '2px' }}>{t('从 Skill 模板开始')}</span>
            {QUICK_SKILLS.map((opt) => (
              <button key={opt.label} className="chip" data-fill={opt.fill} data-skillpick={opt.skill} onClick={() => handleQuickSkill(t(opt.fill), opt.skill)}>
                {t(opt.label)}
              </button>
            ))}
          </div>

          <div style={{ width: '100%', maxWidth: '660px', marginTop: '34px' }}>
            <span className="lbl">{t('也可以这样开始')}</span>
            <div className="alt-grid">
              <div className="card" data-od-id="alt-i2v">
                <b>{t('图片 → 视频管线')}</b>
                <span className="mut">{t('Z-Image 静帧作首帧')}</span>
              </div>
              <div className="card" data-od-id="alt-batch">
                <b>{t('批量产品视频')}</b>
                <span className="mut">{t('多角度图逐镜生成')}</span>
              </div>
              <div className="card" data-od-id="alt-import">
                <b>{t('导入 H3Mise 项目')}</b>
                <span className="mut">{t('M3 · 迁移既有数据')}</span>
              </div>
            </div>
          </div>
        </main>

        {/* 右:项目流 */}
        <aside className="proj" data-od-id="home-projects">
          <div className="proj-head">
            <b style={{ fontSize: 'var(--text-sm)' }}>{t('项目流')}</b>
            <button className="btn btn-g btn-sm" onClick={() => onNavigate('projects')}>
              {t('全部项目')}
            </button>
          </div>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-soft)' }}>
            <div className="lbl" style={{ marginBottom: '8px' }}>{t('进行中')}</div>
            <div
              className="live-card"
              data-od-id="live-project"
              onClick={() => {
                // 有活跃任务时精确进入其所属项目(否则当前会话没有项目上下文,App 会先跳项目列表)
                const pid = live.projectId && projects.some((p) => p.id === live.projectId) ? live.projectId : null;
                if (pid) onSelectProject(pid);
                else onNavigate('canvas');
              }}
            >
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b>{live.title}</b>
                <span className="badge">
                  <span className={`dot${live.showBar ? ' live' : ''}`}></span>
                  {live.badge}
                </span>
              </div>
              {live.showBar ? (
                <div className="pbar" style={{ margin: '10px 0 8px' }}>
                  <i style={{ width: `${live.pct}%` }}></i>
                </div>
              ) : (
                <div style={{ height: '5px', margin: '10px 0 8px' }} />
              )}
              <div className="mono mut" style={{ fontSize: '11px' }}>{live.note}</div>
            </div>
          </div>
          <div className="proj-body">
            <span className="lbl">{t('最近项目')}</span>
            {projects.length === 0 ? (
              <div className="mut" style={{ textAlign: 'center', padding: '26px 0', fontSize: 'var(--text-xs)' }}>
                {t('暂无项目，点「生成」开始')}
              </div>
            ) : (
              projects.map((p, i) => {
                const thumb = PROJ_THUMBS[i % PROJ_THUMBS.length] ?? './assets/shot-01.jpg';
                const showActions = hoverId === p.id;
                return (
                  <div
                    key={p.id}
                    className="proj-card"
                    style={{ position: 'relative' }}
                    onClick={() => onSelectProject(p.id)}
                    onMouseEnter={() => setHoverId(p.id)}
                    onMouseLeave={() => setHoverId(null)}
                  >
                    <span className="thumb">
                      <img src={thumb} alt={t('{name}封面', { name: p.name })} />
                    </span>
                    <div className="grow">
                      <b>{p.name}</b>
                      <div className="mut" style={{ fontSize: 'var(--text-xs)' }}>
                        {t('创建于 {date}', { date: formatDate(p.createdAt) })}
                      </div>
                    </div>
                    {/* 悬停时出现的重命名 / 删除操作(静态结构保持不变,仅获焦时显示) */}
                    {showActions && (
                      <span
                        className="row g6"
                        style={{
                          position: 'absolute',
                          top: '50%',
                          right: '6px',
                          transform: 'translateY(-50%)',
                          background: 'var(--bg)',
                          borderRadius: 'var(--radius-sm)',
                          padding: '2px',
                          boxShadow: 'var(--elev-raised)',
                          zIndex: 2,
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          className="ibtn"
                          style={{ width: '24px', height: '24px' }}
                          aria-label={t('重命名项目')}
                          title={t('重命名')}
                          onClick={() => handleRename(p.id, p.name)}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                          </svg>
                        </button>
                        <button
                          className="ibtn"
                          style={{ width: '24px', height: '24px' }}
                          aria-label={t('删除项目')}
                          title={t('删除')}
                          onClick={() => handleDelete(p.id, p.name)}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                            <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
                          </svg>
                        </button>
                      </span>
                    )}
                  </div>
                );
              })
            )}
            <div className="proj-card" style={{ borderStyle: 'dashed', justifyContent: 'center', color: 'var(--muted)' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M12 5v14M5 12h14" />
              </svg>
              {t('从 H3Mise 导入项目…')}
            </div>
          </div>
        </aside>
      </div>

      {/* 新建项目弹窗 */}
      {newOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(29,29,31,.38)',
            WebkitBackdropFilter: 'blur(3px)',
            backdropFilter: 'blur(3px)',
            zIndex: 100,
            display: 'grid',
            placeItems: 'center',
          }}
          onClick={() => setNewOpen(false)}
        >
          <div
            style={{
              width: 380,
              boxSizing: 'border-box',
              background: 'var(--glass-bg-strong)',
              WebkitBackdropFilter: 'var(--glass-blur)',
              backdropFilter: 'var(--glass-blur)',
              border: '1px solid var(--glass-border)',
              borderRadius: 16,
              boxShadow: 'var(--glass-shadow), var(--glass-spec)',
              padding: 22,
            }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setNewOpen(false);
            }}
          >
            <h3
              style={{
                margin: 0,
                fontFamily: 'var(--font-display)',
                fontSize: 'var(--text-lg)',
                fontWeight: 600,
                letterSpacing: '-.01em',
              }}
            >
              {t('新建项目')}
            </h3>
            <p style={{ margin: '4px 0 14px', color: 'var(--muted)', fontSize: 'var(--text-xs)', lineHeight: 1.6 }}>
              {t('为你的创作单独建一个画布与资产空间，数据全部留在本机。')}
            </p>
            <input
              ref={newInputRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitNewProject();
                if (e.key === 'Escape') setNewOpen(false);
              }}
              placeholder={t('项目名称，如：草原之河 · 短剧')}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '9px 12px',
                border: '1px solid var(--border)',
                borderRadius: 10,
                fontSize: 'var(--text-sm)',
                background: 'var(--bg)',
                color: 'var(--fg)',
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button className="btn btn-g btn-sm" onClick={() => setNewOpen(false)}>
                {t('取消')}
              </button>
              <button className="btn btn-p btn-sm" onClick={submitNewProject}>
                {t('创建项目')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}