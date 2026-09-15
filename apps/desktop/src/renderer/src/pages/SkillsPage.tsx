import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Skill } from '@bigbotart/shared';

interface SkillsPageProps {
  onNavigate: (
    page: 'home' | 'canvas' | 'assets' | 'skills' | 'timeline' | 'settings' | 'onboarding' | 'projects',
  ) => void;
}

/* 与设计稿 skills.js 中的 SKILLS 表一致 */
interface SkillDef {
  name: string;
  sub: string;
  img: string;
  keep: string;
  params: string[];
}

const SKILLS: Record<string, SkillDef> = {
  paper: {
    name: '纸拼贴剧情片',
    sub: '剧情 · 5 节点 · 复用 7 次',
    img: './assets/sb-river.jpg',
    keep: '纸拼贴风格措辞 · 镜头节奏 · 档位模板 · 提示词结构',
    params: ['主题', '旁白', '时长', '角色'],
  },
  drama: {
    name: '剧情短片',
    sub: '剧情 · 三幕结构 · 复用 12 次',
    img: './assets/shot-02.jpg',
    keep: '三幕结构 · 冲突-转折-收束节奏 · 写实影调措辞',
    params: ['主题', '旁白', '时长'],
  },
  ecom: {
    name: '电商产品',
    sub: '多角度 · 批量管线 · 复用 9 次',
    img: './assets/prop-bottle.jpg',
    keep: '浅灰背景 · 产品居中构图 · 三视角镜头序列',
    params: ['产品', '视角', '时长'],
  },
  sci: {
    name: '科普讲解',
    sub: '图文穿插 · 节奏模板 · 复用 5 次',
    img: './assets/eclipse.jpg',
    keep: '图文穿插节奏 · 数据图示占位 · 旁白驱动结构',
    params: ['主题', '旁白', '时长'],
  },
  ink: {
    name: '水墨',
    sub: '风格 · 镜头语言 · 复用 3 次',
    img: './assets/ink.jpg',
    keep: '水墨笔触措辞 · 留白构图 · 缓慢横移运镜',
    params: ['主题', '时长'],
  },
  river: {
    name: '草原之河 · v2',
    sub: '保存于昨天 · 含 8 节点',
    img: './assets/shot-01.jpg',
    keep: '纸拼贴风格 · 双角色锁定 · 5 镜头结构',
    params: ['主题', '角色', '时长'],
  },
  bottle: {
    name: '保温杯三视角',
    sub: '派生自「电商产品」 · 含 6 节点',
    img: './assets/prop-bottle.jpg',
    keep: '浅灰背景 · 侧视/开盖/场景三视角',
    params: ['产品', '视角'],
  },
};

type Filter = 'all' | 'builtin' | 'mine' | 'fork';

interface SkillCardDef {
  skill?: string;
  kind: 'builtin' | 'mine' | 'fork';
  title: string;
  sub?: string;
  img?: string;
  imgStyle?: React.CSSProperties;
  pchs?: string[];
}

const BUILTIN_CARDS: SkillCardDef[] = [
  {
    skill: 'paper',
    kind: 'builtin',
    title: '纸拼贴剧情片',
    sub: '剧情 · 5 节点 · 复用 7 次',
    img: './assets/sb-river.jpg',
    pchs: ['主题', '旁白', '时长', '角色'],
  },
  {
    skill: 'drama',
    kind: 'builtin',
    title: '剧情短片',
    sub: '剧情 · 三幕结构 · 复用 12 次',
    img: './assets/shot-02.jpg',
    pchs: ['主题', '旁白', '时长'],
  },
  {
    skill: 'ecom',
    kind: 'builtin',
    title: '电商产品',
    sub: '多角度 · 批量管线 · 复用 9 次',
    img: './assets/prop-bottle.jpg',
    pchs: ['产品', '视角', '时长'],
  },
  {
    skill: 'sci',
    kind: 'builtin',
    title: '科普讲解',
    sub: '图文穿插 · 节奏模板 · 复用 5 次',
    img: './assets/eclipse.jpg',
    pchs: ['主题', '旁白', '时长'],
  },
  {
    skill: 'ink',
    kind: 'builtin',
    title: '水墨',
    sub: '风格 · 镜头语言 · 复用 3 次',
    img: './assets/ink.jpg',
    pchs: ['主题', '时长'],
  },
];

interface DerivRow {
  name: string;
  tag: string;
}

interface ParamDef {
  label: string;
  value?: string;
  placeholder?: string;
  numeric?: boolean;
  unit?: string;
}

function buildParams(skillId: string | null, skills: Skill[]): ParamDef[] {
  if (!skillId) return [];
  const params = SKILLS[skillId]?.params ?? skills.find((s) => s.id === skillId)?.params;
  if (!params) return [];
  return params.map((p): ParamDef => {
    if (p === '时长') return { label: '时长', value: '45', numeric: true, unit: '秒' };
    if (p === '角色') return { label: '角色', placeholder: '从资产中心选择…' };
    if (p === '旁白') return { label: '旁白', placeholder: '沿用模板文案结构…' };
    if (p === '主题' && skillId === 'paper') return { label: p, value: '日全食科普' };
    return { label: p, placeholder: `填写${p}…` };
  });
}

function paramKey(skillId: string | null, index: number): string {
  return `${skillId ?? 'none'}:${index}`;
}

/** 更新时间 → 友好文案(卡片副标题用) */
function fmtUpdated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '时间未知';
  const min = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  if (min < 1) return '刚刚更新';
  if (min < 60) return `${min} 分钟前更新`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前更新`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前更新`;
  return d.toLocaleDateString('zh-CN');
}

/** 错误提示:优先 alert 弹出,渲染层不可用时落到日志 */
function showError(msg: string, err?: unknown): void {
  const detail =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const text = detail ? `${msg}: ${detail}` : msg;
  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(text);
  }
  console.error('[SkillsPage]', msg, err ?? '');
}

export default function SkillsPage({ onNavigate }: SkillsPageProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>('paper');
  const [dur, setDur] = useState('45');
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [skills, setSkills] = useState<Skill[]>([]);
  const [derivs, setDerivs] = useState<DerivRow[]>([
    { name: '无字幕版', tag: '分支' },
    { name: '儿童版', tag: '分支' },
  ]);

  /* ---- 挂载时读取真实 Skills ---- */
  const refreshSkills = useCallback(async () => {
    try {
      setSkills(await window.bigbotart.listSkills());
    } catch (err) {
      showError('加载 Skill 失败', err);
    }
  }, []);

  useEffect(() => {
    void refreshSkills();
  }, [refreshSkills]);

  /** 真实 Skill → 设计稿「我的 Skill」卡片(副标题:节点数 · 参数 · 更新时间) */
  const mineCards: SkillCardDef[] = useMemo(
    () =>
      skills.map((s) => ({
        skill: s.id,
        kind: 'mine' as const,
        title: s.name,
        sub: `节点数 ${s.nodes.length} · 参数 ${s.params.length} · ${fmtUpdated(s.updatedAt)}`,
        pchs: s.params,
      })),
    [skills],
  );

  /** 详情面板选中项:内置模板走 SKILLS 表;真实 Skill 走列表映射 */
  const active = useMemo(() => {
    if (!selected) return null;
    const def = SKILLS[selected];
    if (def) return def;
    const real = skills.find((s) => s.id === selected);
    if (!real) return null;
    return {
      name: real.name,
      sub: `节点数 ${real.nodes.length} · 参数 ${real.params.length}`,
      img: '',
      keep: real.description ?? '节点结构 + 参数 + 提示词模板',
      params: real.params,
    };
  }, [selected, skills]);

  const params = useMemo(() => buildParams(selected, skills), [selected, skills]);

  const shotCalc = useMemo(() => {
    const v = parseInt(dur, 10);
    if (v > 0) return `${v}s → 自动拆 ${Math.max(1, Math.ceil(v / 15))} 镜`;
    return '';
  }, [dur]);

  const q = query.trim().toLowerCase();

  const cardVisible = (c: SkillCardDef): boolean => {
    if (filter === 'fork' && c.kind !== 'fork') return false;
    if (q) {
      const text = [c.title, c.sub ?? '', ...(c.pchs ?? [])].join(' ').toLowerCase();
      if (text.indexOf(q) < 0) return false;
    }
    return true;
  };

  const builtinShown = filter === 'all' || filter === 'builtin';
  const mineShown = filter === 'all' || filter === 'mine' || filter === 'fork';

  const handleSelect = (id: string) => {
    setSelected(id);
    setDur('45');
    setParamValues({});
  };

  const handleParamChange = (key: string, value: string) => {
    setParamValues((prev) => ({ ...prev, [key]: value }));
  };

  /** 保存当前画布为 Skill:取名字 → 取首个项目 id → 调 IPC → 刷新并选中新 Skill */
  const handleSaveSkill = async () => {
    try {
      const name = (prompt('Skill 名称', '我的 Skill') ?? '').trim();
      if (!name) return; // 取消或空名则返回
      const projects = await window.bigbotart.listProjects();
      const project = projects[0];
      if (!project) {
        showError('请先创建项目并搭建画布');
        return;
      }
      const saved = await window.bigbotart.saveSkill({ name, projectId: project.id });
      await refreshSkills();
      setSelected(saved.id);
      setDur('45');
      setParamValues({});
    } catch (err) {
      showError('保存 Skill 失败', err);
    }
  };

  const handleFork = () => {
    setDerivs((prev) => [...prev, { name: '新分支 · 未命名', tag: '刚刚' }]);
  };

  const handleApply = async () => {
    if (!selected) return;
    const skill = skills.find((s) => s.id === selected);
    if (!skill) {
      showError('请先选择一个「我的 Skill」再应用');
      return;
    }
    const projectName = (prompt('新项目名称', skill.name) ?? '').trim();
    if (!projectName) return; // 取消或空名
    try {
      await window.bigbotart.applySkill(skill.id, projectName);
      onNavigate('canvas');
    } catch (err) {
      showError('应用 Skill 失败', err);
    }
  };

  /** 删除我的 Skill:确认 → 调 IPC → 刷新 */
  const handleDelete = async (id: string, title: string) => {
    if (!confirm(`确定删除 Skill「${title}」?删除后不可恢复。`)) return;
    try {
      const res = await window.bigbotart.deleteSkill(id);
      if (!res.ok) {
        showError(res.error ?? '删除 Skill 失败');
        return;
      }
      if (selected === id) setSelected(null);
      await refreshSkills();
    } catch (err) {
      showError('删除 Skill 失败', err);
    }
  };

  const renderCard = (c: SkillCardDef, index: number) => (
    <div
      key={c.skill ?? `${c.kind}-${index}`}
      className={`scard${c.skill && c.skill === selected ? ' sel' : ''}`}
      data-skill={c.skill}
      data-kind={c.kind}
      style={cardVisible(c) ? undefined : { display: 'none' }}
      onClick={c.skill ? () => handleSelect(c.skill as string) : undefined}
    >
      <div className="sthumb">
        {c.img ? (
          <img src={c.img} alt={c.title} style={c.imgStyle} />
        ) : (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              inset: 8,
              border: '1px dashed var(--border)',
              borderRadius: 'var(--radius-sm)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--muted)',
              background:
                'linear-gradient(135deg, color-mix(in oklab, var(--accent) 10%, var(--surface)), var(--surface) 60%, color-mix(in oklab, var(--fg) 5%, var(--surface)))',
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </div>
        )}
        {c.kind === 'mine' && c.skill && (
          <button
            type="button"
            className="btn btn-s btn-sm"
            title="删除 Skill"
            onClick={(e) => {
              e.stopPropagation();
              void handleDelete(c.skill as string, c.title);
            }}
            style={{ position: 'absolute', top: 6, right: 6, padding: '2px 9px', fontSize: 11, lineHeight: '1.5' }}
          >
            删除
          </button>
        )}
      </div>
      <div className="si">
        <b>{c.title}</b>
        <div className="sub">{c.sub}</div>
        <div className="pchs">
          {(c.pchs ?? []).map((p) => (
            <span className="chip" key={p}>
              {p}
            </span>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <div className="pg-skills">
      <div className="app" data-od-id="skills-app">
        <header className="topbar" data-od-id="skills-toolbar">
          <button className="btn btn-g btn-sm" onClick={() => onNavigate('home')}>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
            >
              <path d="m14 6-6 6 6 6" />
            </svg>
            Skills 库
          </button>
          <span className="sep"></span>
          <button
            className="btn btn-s btn-sm"
            id="saveSkillBtn"
            data-od-id="skill-save"
            onClick={handleSaveSkill}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            保存当前画布为 Skill
          </button>
          <span className="sep"></span>
          <button
            className={`chip${filter === 'all' ? ' on' : ''}`}
            data-filter="all"
            onClick={() => setFilter('all')}
          >
            全部
          </button>
          <button
            className={`chip${filter === 'builtin' ? ' on' : ''}`}
            data-filter="builtin"
            onClick={() => setFilter('builtin')}
          >
            内置模板
          </button>
          <button
            className={`chip${filter === 'mine' ? ' on' : ''}`}
            data-filter="mine"
            onClick={() => setFilter('mine')}
          >
            我的 Skill
          </button>
          <button
            className={`chip${filter === 'fork' ? ' on' : ''}`}
            data-filter="fork"
            onClick={() => setFilter('fork')}
          >
            派生分支
          </button>
          <span className="spacer"></span>
          <div className="search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              id="searchInput"
              placeholder="搜索 Skill…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </header>

        <div className="work">
          <main className="grid-area" data-od-id="skills-grid">
            <div className="sect-h" data-sect="builtin" style={{ display: builtinShown ? '' : 'none' }}>
              <b>内置模板</b>
              <span className="mut">覆盖风格 / 镜头 / 节奏 / 提示词结构</span>
            </div>
            <div
              className="sgrid"
              data-sect-grid="builtin"
              style={{ display: builtinShown ? '' : 'none' }}
            >
              {BUILTIN_CARDS.map(renderCard)}
            </div>

            <div className="sect-h" data-sect="mine" style={{ display: mineShown ? '' : 'none' }}>
              <b>我的 Skill</b>
              <span className="mut">保存自画布 · 双向可编辑</span>
            </div>
            <div className="sgrid" data-sect-grid="mine" style={{ display: mineShown ? '' : 'none' }}>
              {mineCards.map(renderCard)}
              <div className="scard new" data-kind="mine">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
                <span style={{ fontSize: 'var(--text-xs)' }}>
                  从当前画布保存
                  <br />
                  节点结构 + 参数 + 提示词模板
                </span>
              </div>
            </div>
          </main>

          {/* 右:参数化 / 应用 */}
          <aside className="detail" data-od-id="skills-detail">
            <div className="detail-in">
              <div>
                <div className="lbl" style={{ marginBottom: '8px' }}>
                  Skill 详情
                </div>
                <b id="dName" style={{ fontSize: 'var(--text-base)' }}>
                  {active?.name ?? ''}
                </b>
                <div className="mut" style={{ fontSize: 'var(--text-xs)', marginTop: '2px' }} id="dSub">
                  {active?.sub ?? ''}
                </div>
              </div>
              <div className="dpreview">
                {active?.img ? (
                  <img id="dImg" src={active?.img ?? ''} alt="Skill 模板预览" />
                ) : (
                  <div
                    id="dImg"
                    style={{
                      width: '100%',
                      aspectRatio: '16 / 9',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--muted)',
                      border: '1px dashed var(--border)',
                      borderRadius: 'var(--radius-md)',
                      background:
                        'linear-gradient(135deg, color-mix(in oklab, var(--accent) 10%, var(--bg)), var(--bg) 60%, color-mix(in oklab, var(--fg) 5%, var(--bg)))',
                    }}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                    >
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </div>
                )}
              </div>
              <div>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span className="lbl">参数化字段</span>
                  <span className="hint mono" id="shotCalc">
                    {shotCalc}
                  </span>
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
                  id="paramList"
                >
                  {params.map((p, i) => {
                    const key = paramKey(selected, i);
                    if (p.numeric) {
                      return (
                        <div className="param" key={key}>
                          <span>{p.label}</span>
                          <input
                            id="durInput"
                            value={dur}
                            inputMode="numeric"
                            onChange={(e) => setDur(e.target.value)}
                          />
                          <span className="unit">{p.unit}</span>
                        </div>
                      );
                    }
                    return (
                      <div className="param" key={key}>
                        <span>{p.label}</span>
                        <input
                          placeholder={p.placeholder}
                          value={paramValues[key] ?? ''}
                          onChange={(e) => handleParamChange(key, e.target.value)}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
              <div>
                <div className="lbl" style={{ marginBottom: '8px' }}>
                  保留的视觉包装
                </div>
                <div className="keepbox" id="dKeep">
                  {active?.keep ?? ''}
                </div>
              </div>
              <button
                className="btn btn-p"
                style={{ width: '100%' }}
                id="applyBtn"
                data-od-id="skill-apply"
                onClick={handleApply}
              >
                应用到新项目
              </button>
              <div className="row g8">
                <button
                  className="btn btn-s btn-sm grow"
                  onClick={() => onNavigate('canvas')}
                >
                  编辑模板画布
                </button>
                <button className="btn btn-s btn-sm grow" id="forkBtn" onClick={handleFork}>
                  派生分支
                </button>
              </div>
              <div>
                <div className="lbl" style={{ marginBottom: '8px' }}>
                  派生版本
                </div>
                <div className="deriv" id="derivList">
                  {derivs.map((d, i) => (
                    <div className="dr" key={`${d.name}-${i}`}>
                      <span>{d.name}</span>
                      <span className="mono mut" style={{ fontSize: '11px' }}>
                        {d.tag}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
