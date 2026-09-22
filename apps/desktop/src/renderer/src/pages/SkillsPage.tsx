import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Skill } from '@bigbotart/shared';
import { usePrompt } from '../components/usePrompt';
import PageTopBar from '../components/PageTopBar';

interface SkillsPageProps {
  onNavigate: (
    page: 'home' | 'canvas' | 'assets' | 'skills' | 'timeline' | 'settings' | 'onboarding' | 'projects',
  ) => void;
  /** 🆕 当前打开的项目/画布(「注入指令到当前画布」与「已激活」徽章需要;无项目时相关入口置灰) */
  projectId?: string | null;
  canvasId?: string | null;
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
  /** 🆕 卡片徽章(如「指令」「已激活」) */
  badges?: Array<{ label: string; kind: 'inst' | 'active' }>;
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

export default function SkillsPage({ onNavigate, projectId, canvasId }: SkillsPageProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>('paper-collage');
  const [dur, setDur] = useState('45');
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [skills, setSkills] = useState<Skill[]>([]);
  const [derivs, setDerivs] = useState<DerivRow[]>([
    { name: '无字幕版', tag: '分支' },
    { name: '儿童版', tag: '分支' },
  ]);
  /** 🆕 当前画布激活技能(进入查询恢复;详情/卡片徽章用) */
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null);
  /** 🆕 指令编辑器草稿(id → { text, inject });保存按钮落 skillUpdate */
  const [insDraft, setInsDraft] = useState<{ id: string; text: string; inject: 'full' | 'summary' } | null>(null);
  /** 🆕 指令编辑器是否展开(选中技能时按需打开) */
  const [insOpen, setInsOpen] = useState(false);
  const [savingIns, setSavingIns] = useState(false);

  /* ---- 挂载时读取真实 Skills + 恢复画布激活技能 ---- */
  const refreshSkills = useCallback(async () => {
    try {
      setSkills(await window.bigbotart.listSkills());
    } catch (err) {
      showError('加载 Skill 失败', err);
    }
  }, []);

  useEffect(() => {
    void refreshSkills();
    if (!projectId || !canvasId) return;
    void window.bigbotart
      .skillActive(projectId, canvasId)
      .then((s) => setActiveSkillId(s?.skillId ?? null))
      .catch(() => {});
  }, [refreshSkills, projectId, canvasId]);

  /** 真实 Skill → 设计稿「我的 Skill」卡片(副标题:节点数 · 参数 · 更新时间;含指令/激活徽章) */
  const mineCards: SkillCardDef[] = useMemo(
    () =>
      skills
        .filter((s) => !s.builtin)
        .map((s) => ({
          skill: s.id,
          kind: 'mine' as const,
          title: s.name,
          sub: `节点数 ${s.nodes.length} · 参数 ${s.params.length} · ${fmtUpdated(s.updatedAt)}`,
          pchs: s.params,
          badges: [
            ...(s.instructions ? [{ label: '指令', kind: 'inst' as const }] : []),
            ...(activeSkillId === s.id ? [{ label: '已激活', kind: 'active' as const }] : []),
          ],
        })),
    [skills, activeSkillId],
  );

  /** 官方精选(出厂内置,builtin):封面占位,指令徽章 + 激活徽章;渲染替换 BUILTIN_CARDS 演示数据 */
  const builtinCards: SkillCardDef[] = useMemo(
    () =>
      skills
        .filter((s) => s.builtin)
        .map((s) => ({
          skill: s.id,
          kind: 'builtin' as const,
          title: s.name,
          sub: s.description ?? '双形态齐备 · 画布模板 + Agent 操作指令',
          pchs: s.params,
          img: '',
          badges: [
            ...(s.instructions ? [{ label: '指令', kind: 'inst' as const }] : []),
            ...(activeSkillId === s.id ? [{ label: '已激活', kind: 'active' as const }] : []),
          ],
        })),
    [skills, activeSkillId],
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

  /** 技能 id → 真实技能(搜索指令内容 / 详情指令区用) */
  const skillOf = (id: string | null): Skill | undefined => skills.find((s) => s.id === id);

  /** 详情面板当前选中的真实技能(指令编辑器/注入按钮用;内置模板选中时为空) */
  const real = skillOf(selected);

  const cardVisible = (c: SkillCardDef): boolean => {
    if (filter === 'fork' && c.kind !== 'fork') return false;
    if (q) {
      // 搜索范围:标题 / 副标题 / 参数 / 指令内容(设计稿「搜索 Skill 名称、指令内容…」)
      const real = c.skill ? skillOf(c.skill) : undefined;
      const text = [c.title, c.sub ?? '', ...(c.pchs ?? []), real?.instructions ?? '', real?.description ?? '']
        .join(' ')
        .toLowerCase();
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
    setInsOpen(false);
    const real = skills.find((s) => s.id === id);
    setInsDraft(real ? { id: real.id, text: real.instructions ?? '', inject: real.inject ?? 'full' } : null);
  };

  const handleParamChange = (key: string, value: string) => {
    setParamValues((prev) => ({ ...prev, [key]: value }));
  };

  const { ask: askPrompt, dialog: promptDialog } = usePrompt();

  /** 保存当前画布为 Skill:取名 → 可选操作指令(设计稿「…操作指令整体入库」) → 调 IPC → 刷新并选中 */
  const handleSaveSkill = async () => {
    try {
      const name = await askPrompt({ title: 'Skill 名称', initial: '我的 Skill' });
      if (!name) return; // 取消或空名则返回
      // 第二步:(可选)把 Agent 操作要求写成指令段——确定空/取消 = 仅画布模板
      const instructions = await askPrompt({
        title: '操作指令(可选,空则跳过)',
        initial: '',
        placeholder: '如「先 storyboard.plan 再 materialize,提交前 ask.user 确认档位;措辞段…」(支持 {占位})',
      });
      const projects = await window.bigbotart.listProjects();
      const project = projects[0];
      if (!project) {
        showError('请先创建项目并搭建画布');
        return;
      }
      const saved = await window.bigbotart.saveSkill({
        name,
        projectId: project.id,
        canvasId: project.activeCanvasId ?? undefined,
        instructions: instructions ?? undefined,
      });
      await refreshSkills();
      setSelected(saved.id);
      setInsDraft(saved.instructions ? { id: saved.id, text: saved.instructions, inject: saved.inject ?? 'full' } : null);
      setDur('45');
      setParamValues({});
    } catch (err) {
      showError('保存 Skill 失败', err);
    }
  };

  const handleFork = () => {
    setDerivs((prev) => [...prev, { name: '新分支 · 未命名', tag: '刚刚' }]);
  };

  /** 🆕 打开指令编辑器:以真实技能指令为草稿(无则空) */
  const openInsEditor = (skill: Skill) => {
    setInsDraft({ id: skill.id, text: skill.instructions ?? '', inject: skill.inject ?? 'full' });
    setInsOpen(true);
  };

  /** 🆕 保存指令段(skillUpdate;空文本 = 移除指令,退回「仅画布模板」) */
  const saveInstructions = async () => {
    if (!insDraft) return;
    setSavingIns(true);
    try {
      const r = await window.bigbotart.skillUpdate(insDraft.id, {
        instructions: insDraft.text,
        inject: insDraft.inject,
      });
      if (!r.ok) {
        showError(r.error ?? '保存指令失败');
        return;
      }
      await refreshSkills();
      setInsOpen(false);
      setInsDraft(null);
    } catch (err) {
      showError('保存指令失败', err);
    } finally {
      setSavingIns(false);
    }
  };

  /** 🆕 注入指令到当前画布(skillActivate;需已打开项目+画布) */
  const handleActivate = async (skill: Skill) => {
    if (!projectId || !canvasId) {
      showError('请先打开一个项目与画布,再注入指令');
      return;
    }
    if (!skill.instructions) {
      showError(`「${skill.name}」只有画布模板,没有操作指令段 · 可在下方编辑器中添加`);
      return;
    }
    try {
      const r = await window.bigbotart.skillActivate(projectId, canvasId, skill.id);
      if (!r.ok) {
        showError(r.error ?? '注入指令失败');
        return;
      }
      setActiveSkillId(skill.id);
    } catch (err) {
      showError('注入指令失败', err);
    }
  };

  /** 🆕 取消当前画布的技能激活 */
  const handleDeactivate = async () => {
    if (!projectId || !canvasId) return;
    try {
      await window.bigbotart.skillDeactivate(projectId, canvasId);
      setActiveSkillId(null);
    } catch (err) {
      showError('停用失败', err);
    }
  };

  const handleApply = async () => {
    if (!selected) return;
    const skill = skills.find((s) => s.id === selected);
    if (!skill) {
      showError('请先选择一个「我的 Skill」再应用');
      return;
    }
    const projectName = await askPrompt({ title: '新项目名称', initial: skill.name });
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
        <div className="row g6" style={{ marginTop: -1 }}>
          {(c.badges ?? []).map((b) => (
            <span key={b.label} className={`badge ${b.kind === 'active' ? 'ok' : ''}`} style={{ fontSize: 10 }}>
              {b.label}
            </span>
          ))}
        </div>
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
      {promptDialog}
      <div className="app" data-od-id="skills-app">
        <PageTopBar odId="skills" backLabel="首页" onBack={() => onNavigate('home')}>
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
              placeholder="搜索 Skill 名称、指令内容…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </PageTopBar>

        <div className="work">
          <main className="grid-area" data-od-id="skills-grid">
            <div className="sect-h" data-sect="builtin" style={{ display: builtinShown ? '' : 'none' }}>
              <b>官方精选</b>
              <span className="mut">双形态齐备 · 画布模板 + Agent 操作指令</span>
            </div>
            <div
              className="sgrid"
              data-sect-grid="builtin"
              style={{ display: builtinShown ? '' : 'none' }}
            >
              {builtinCards.map(renderCard)}
            </div>

            <div className="sect-h" data-sect="mine" style={{ display: mineShown ? '' : 'none' }}>
              <b>我的 Skill</b>
              <span className="mut">保存自画布 · 节点结构 + 参数 + 操作指令 · 可编辑</span>
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
                  节点结构 + 参数 + 操作指令整体入库
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
              {real && projectId ? (
                /* 🆕 操作指令(Agent 指令段):编辑/保存/注入——画布级配置事件 */
                <div>
                  <div className="row" style={{ justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span className="lbl">操作指令(Agent)</span>
                    {real.instructions ? (
                      <span className="badge" title={`inject: ${real.inject ?? 'full'}`}>
                        指令 · {real.inject ?? 'full'}
                      </span>
                    ) : null}
                  </div>
                  {insOpen ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <textarea
                        className="f-ta mono"
                        rows={7}
                        data-od-id="skill-ins-editor"
                        value={insDraft?.text ?? ''}
                        placeholder={'# 任务流程\n1. canvas.list_nodes 读需求…(支持 {占位};撰写规范见 docs/Agent技能文档-撰写指南与模板.md)'}
                        onChange={(e) => setInsDraft((d) => (d ? { ...d, text: e.target.value } : d))}
                      />
                      <div className="row g8">
                        {(['full', 'summary'] as const).map((m) => (
                          <span
                            key={m}
                            className={`chip${insDraft?.inject === m ? ' on' : ''}`}
                            onClick={() => setInsDraft((d) => (d ? { ...d, inject: m } : d))}
                          >
                            {m === 'full' ? '全量注入' : '摘要模式'}
                          </span>
                        ))}
                        <span className="mut" style={{ fontSize: 10.5, marginLeft: 'auto' }}>
                          {(insDraft?.text?.length ?? 0) > 4000 ? '⚠ 超长建议摘要模式' : `${insDraft?.text?.length ?? 0} 字`}
                        </span>
                      </div>
                      <div className="row g8">
                        <button className="btn btn-p btn-sm" data-od-id="skill-ins-save" disabled={savingIns} onClick={saveInstructions}>
                          保存指令
                        </button>
                        <button className="btn btn-s btn-sm" onClick={() => setInsOpen(false)}>
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {real.instructions ? (
                        <pre className="keepbox mono" style={{ maxHeight: 96, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap' }}>
                          {real.instructions.length > 220 ? `${real.instructions.slice(0, 220)}…` : real.instructions}
                        </pre>
                      ) : (
                        <div className="mut" style={{ fontSize: 11, border: '1px dashed var(--border)', borderRadius: 8, padding: '8px 10px' }}>
                          该技能仅画布模板——添加操作指令后,对话可自动按此执行
                        </div>
                      )}
                      <button className="btn btn-s btn-sm" data-od-id="skill-ins-edit" onClick={() => void openInsEditor(real)}>
                        {real.instructions ? '编辑指令' : '添加操作指令'}
                      </button>
                    </div>
                  )}
                  <button
                    className="btn btn-s btn-sm"
                    style={{ width: '100%', marginTop: 8 }}
                    data-od-id="skill-activate"
                    disabled={!projectId || !canvasId}
                    onClick={() => (activeSkillId === real.id ? void handleDeactivate() : void handleActivate(real))}
                  >
                    {activeSkillId === real.id ? '已注入当前画布 · 点击停用' : '注入指令到当前画布'}
                  </button>
                </div>
              ) : null}
              <button
                className="btn btn-p"
                style={{ width: '100%' }}
                id="applyBtn"
                data-od-id="skill-apply"
                onClick={handleApply}
              >
                铺节点到新项目
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
