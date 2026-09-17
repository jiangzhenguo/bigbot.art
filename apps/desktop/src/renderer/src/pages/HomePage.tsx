import React, { useState, useEffect, useRef } from 'react';

export type HomePageTarget =
  | 'home'
  | 'canvas'
  | 'assets'
  | 'skills'
  | 'timeline'
  | 'settings'
  | 'onboarding'
  | 'projects';

interface HomePageProps {
  onNavigate: (page: HomePageTarget) => void;
  onGenerate: (brief: string) => void;
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

const DEFAULT_MODEL = 'Ornith-1.5-35B · 本地';

const MODELS = [
  { value: 'Ornith-1.5-35B · 本地', label: 'Ornith-1.5-35B-A3B · 本地' },
  { value: 'Ornith-1.5-9B · 本地', label: 'Ornith-1.5-9B · 本地' },
];

const SKILLS = [
  { name: '无技能', label: '无技能 · 自由编排' },
  { name: '纸拼贴剧情片', label: '纸拼贴剧情片' },
  { name: '剧情短片', label: '剧情短片' },
  { name: '电商产品', label: '电商产品' },
  { name: '科普讲解', label: '科普讲解' },
  { name: '水墨', label: '水墨' },
];

const QUICK_SKILLS = [
  { label: '剧情短片', fill: '用三幕结构写一部 45 秒剧情短片：主角在旧车站错过一班列车，却在站台重逢多年未见的朋友。', skill: '剧情短片' },
  { label: '电商产品', fill: '为保温杯生成 3 个视角的产品视频：侧视旋转、开盖特写、户外使用场景，统一浅灰背景。', skill: '电商产品' },
  { label: '科普讲解', fill: '做一支 60 秒科普短片解释日全食：从月球轨道切入，到贝利珠瞬间，图文穿插。', skill: '科普讲解' },
  { label: '水墨', fill: '水墨风格山水短片：远山、孤舟、留白，镜头缓慢横移，30 秒。', skill: '水墨' },
  { label: '纸拼贴', fill: '帮我在导演台搭一场戏：男女主在草原上走，遇到一条很宽的河，女主跃过河，男主在岸边踱步。纸拼贴风格，60 秒以内。', skill: '纸拼贴剧情片' },
];

const ATTACH_DEMOS = [
  { name: '女主设定 v3.png', tag: '角色锁定', img: './assets/char-female.jpg' },
  { name: '草原空镜.mov', tag: '运镜参考', img: './assets/env-dusk.jpg' },
];

const PROJ_THUMBS = ['./assets/shot-01.jpg', './assets/eclipse.jpg', './assets/prop-bottle.jpg', './assets/ink.jpg'];

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
  const [brief, setBrief] = useState('');
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [skill, setSkill] = useState('无技能');
  const [showModelPop, setShowModelPop] = useState(false);
  const [showSkillPop, setShowSkillPop] = useState(false);
  const [attachments, setAttachments] = useState<Array<{ name: string; tag: string; img: string }>>([]);
  const [attachIdx, setAttachIdx] = useState(0);
  const [hoverId, setHoverId] = useState<string | null>(null);

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
    onNewProject(name || `未命名项目 ${projects.length + 1}`);
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
    onGenerate(brief);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleGenerate();
    }
  };

  const handlePickModel = (value: string) => {
    setModel(value);
    setShowModelPop(false);
  };

  const handlePickSkill = (name: string) => {
    setSkill(name);
    setShowSkillPop(false);
  };

  const handleQuickSkill = (fill: string, skillName: string) => {
    setBrief(fill);
    setSkill(skillName);
    areaRef.current?.focus();
  };

  const handleAddAttachment = () => {
    if (attachIdx >= ATTACH_DEMOS.length) return;
    const d = ATTACH_DEMOS[attachIdx];
    if (!d) return;
    setAttachments([...attachments, d]);
    setAttachIdx(attachIdx + 1);
  };

  const handleRemoveAttachment = (index: number) => {
    setAttachments(attachments.filter((_, i) => i !== index));
  };

  const handleRename = (id: string, currentName: string) => {
    const next = prompt('重命名项目', currentName);
    if (next && next.trim() && next !== currentName) {
      onRenameProject(id, next.trim());
    }
  };

  const handleDelete = (id: string, name: string) => {
    if (confirm(`确定删除项目「${name}」吗?此操作不可恢复。`)) {
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
      {item.label}
    </a>
  );

  return (
    <div className="pg-home">
      <div className="app" data-od-id="home-app">
        {/* 左导航 */}
        <aside className="side" data-od-id="home-nav">
          <a
            className="side-brand"
            href="#"
            title="返回原型总览"
            onClick={(e) => {
              e.preventDefault();
              onNavigate('home');
            }}
          >
            <span className="mk">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="8" height="8" rx="2" />
                <rect x="13" y="13" width="8" height="8" rx="2" />
                <path d="M11 8h6a4 4 0 0 1 4 4v1" opacity=".65" />
              </svg>
            </span>
            BigBotArt
          </a>
          <div style={{ padding: '2px 12px 10px' }}>
            <button className="btn btn-s" style={{ width: '100%' }} id="newProject" data-od-id="home-new-project" onClick={openNewProject}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <path d="M12 5v14M5 12h14" />
              </svg>
              新建项目
            </button>
          </div>
          <nav className="side-nav">
            <div className="lbl">创作</div>
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
            <div className="lbl">资源</div>
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
            <div className="lbl">系统</div>
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
            <div className="lbl" style={{ marginBottom: '8px' }}>引擎状态</div>
            <div className="eng-card">
              <div className="row">
                <span className="row g6">
                  <span className={`dot${engineStatus.h3c.ready ? ' ok' : ''}`}></span>
                  视频槽位 · h3.c
                </span>
                <span className="mono mut" style={{ fontSize: '11px' }}>{engineStatus.h3c.text}</span>
              </div>
              <div className="row">
                <span className="row g6">
                  <span className={`dot${engineStatus.mlxgen.ready ? ' ok' : ''}`}></span>
                  图片槽位 · mlxgen
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
          <p className="lbl" style={{ margin: 0 }}>本地优先 · 全部数据留在本机</p>
          <h1>今天想创作什么？</h1>

          <div className="composer" data-od-id="intake-composer">
            {attachments.length > 0 && (
              <div className="attach-row" id="attachRow">
                {attachments.map((att, i) => (
                  <span className="attach" key={i}>
                    <span className="thumb">
                      <img src={att.img} alt="" />
                    </span>
                    <span>{att.name}</span>
                    <span className="mono mut" style={{ fontSize: '10px' }}>{att.tag}</span>
                    <button className="x" aria-label="移除附件" onClick={() => handleRemoveAttachment(i)}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                        <path d="M6 6l12 12M18 6 6 18" />
                      </svg>
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              id="intakeText"
              ref={areaRef}
              placeholder="一句话描述你的视频 / 图片需求，例如：「帮我在导演台搭一场戏：男女主在草原上走，遇到一条很宽的河……」"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <div className="row g8" style={{ borderTop: '1px solid var(--border-soft)', paddingTop: '10px', marginTop: '8px', position: 'relative' }}>
              <button className="btn btn-g btn-sm" id="attachBtn" onClick={handleAddAttachment}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="m21 11.5-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.85 1.85 0 0 1-2.6-2.6l7.8-7.8" />
                </svg>
                参考图 / 文件
              </button>
              <button
                className="chip"
                id="modelChip"
                ref={modelChipRef}
                onClick={() => {
                  setShowSkillPop(false);
                  setShowModelPop((v) => !v);
                }}
              >
                {model}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
              {showModelPop && (
                <div className="pop open" id="modelPop" ref={modelPopRef} style={{ bottom: '44px', left: '150px' }}>
                  {MODELS.map((m) => (
                    <div key={m.value} className="pop-it" data-model={m.value} onClick={() => handlePickModel(m.value)}>
                      {m.label}
                      {model === m.value && <span className="ck">✓</span>}
                    </div>
                  ))}
                  <div className="pop-it dim" data-model="">
                    云端模型 · 需先在设置中配置凭据
                  </div>
                </div>
              )}
              <button
                className="chip"
                id="skillChip"
                ref={skillChipRef}
                onClick={() => {
                  setShowModelPop(false);
                  setShowSkillPop((v) => !v);
                }}
              >
                {skill}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
              {showSkillPop && (
                <div className="pop open" id="skillPop" ref={skillPopRef} style={{ bottom: '44px', left: '290px' }}>
                  {SKILLS.map((s) => (
                    <div key={s.name} className="pop-it" data-skill={s.name} onClick={() => handlePickSkill(s.name)}>
                      {s.label}
                      {skill === s.name && <span className="ck">✓</span>}
                    </div>
                  ))}
                </div>
              )}
              <span className="spacer"></span>
              <span className="mono mut" style={{ fontSize: '11px' }}>规划 Agent · 本地 LLM</span>
              <button className="btn btn-p" id="goBtn" data-od-id="intake-generate" onClick={handleGenerate}>
                生成
              </button>
            </div>
          </div>

          <div className="skill-quick" data-od-id="skill-quick">
            <span className="lbl" style={{ width: '100%', textAlign: 'center', marginBottom: '2px' }}>从 Skill 模板开始</span>
            {QUICK_SKILLS.map((opt) => (
              <button key={opt.label} className="chip" data-fill={opt.fill} data-skillpick={opt.skill} onClick={() => handleQuickSkill(opt.fill, opt.skill)}>
                {opt.label}
              </button>
            ))}
          </div>

          <div style={{ width: '100%', maxWidth: '660px', marginTop: '34px' }}>
            <span className="lbl">也可以这样开始</span>
            <div className="alt-grid">
              <div className="card" data-od-id="alt-i2v">
                <b>图片 → 视频管线</b>
                <span className="mut">Z-Image 静帧作首帧</span>
              </div>
              <div className="card" data-od-id="alt-batch">
                <b>批量产品视频</b>
                <span className="mut">多角度图逐镜生成</span>
              </div>
              <div className="card" data-od-id="alt-import">
                <b>导入 H3Mise 项目</b>
                <span className="mut">M3 · 迁移既有数据</span>
              </div>
            </div>
          </div>
        </main>

        {/* 右:项目流 */}
        <aside className="proj" data-od-id="home-projects">
          <div className="proj-head">
            <b style={{ fontSize: 'var(--text-sm)' }}>项目流</b>
            <button className="btn btn-g btn-sm" onClick={() => onNavigate('projects')}>
              全部项目
            </button>
          </div>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-soft)' }}>
            <div className="lbl" style={{ marginBottom: '8px' }}>进行中</div>
            <div className="live-card" data-od-id="live-project" onClick={() => onNavigate('canvas')}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b>草原之河 · 短剧</b>
                <span className="badge">
                  <span className="dot live"></span>镜头 3/8
                </span>
              </div>
              <div className="pbar" style={{ margin: '10px 0 8px' }}>
                <i style={{ width: '38%' }}></i>
              </div>
              <div className="mono mut" style={{ fontSize: '11px' }}>h3.c 生成中 · 默认档 · 预计剩余 06:12</div>
            </div>
          </div>
          <div className="proj-body">
            <span className="lbl">最近项目</span>
            {projects.length === 0 ? (
              <div className="mut" style={{ textAlign: 'center', padding: '26px 0', fontSize: 'var(--text-xs)' }}>
                暂无项目，点「生成」开始
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
                      <img src={thumb} alt={`${p.name}封面`} />
                    </span>
                    <div className="grow">
                      <b>{p.name}</b>
                      <div className="mut" style={{ fontSize: 'var(--text-xs)' }}>
                        创建于 {formatDate(p.createdAt)}
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
                          aria-label="重命名项目"
                          title="重命名"
                          onClick={() => handleRename(p.id, p.name)}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                          </svg>
                        </button>
                        <button
                          className="ibtn"
                          style={{ width: '24px', height: '24px' }}
                          aria-label="删除项目"
                          title="删除"
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
              从 H3Mise 导入项目…
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
              新建项目
            </h3>
            <p style={{ margin: '4px 0 14px', color: 'var(--muted)', fontSize: 'var(--text-xs)', lineHeight: 1.6 }}>
              为你的创作单独建一个画布与资产空间，数据全部留在本机。
            </p>
            <input
              ref={newInputRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitNewProject();
                if (e.key === 'Escape') setNewOpen(false);
              }}
              placeholder="项目名称，如：草原之河 · 短剧"
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
                取消
              </button>
              <button className="btn btn-p btn-sm" onClick={submitNewProject}>
                创建项目
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}