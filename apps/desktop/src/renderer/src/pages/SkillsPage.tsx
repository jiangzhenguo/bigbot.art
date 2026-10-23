import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Skill } from '@bigbotart/shared';
import { paramDisplayLabel, paramTokenKey } from '@bigbotart/shared';
import { usePrompt } from '../components/usePrompt';
import PageTopBar from '../components/PageTopBar';
import { useT } from '../i18n';
import { isDesktopShell } from '../api/shell';

/** 卡片上最多露出几个可读参数名(其余收进「需 N 个参数」) */
const CARD_PARAM_PREVIEW = 2;

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

/** 演示用详情表(真实内置技能走 listSkills;此处仅兜底「水墨」等非出厂模板) */
const SKILLS: Record<string, SkillDef> = {
  drama: {
    name: '剧情短片',
    sub: '剧情 · 三幕结构 · 复用 12 次',
    img: './assets/shot-02.jpg',
    keep: '三幕结构 · 冲突-转折-收束节奏 · 写实影调措辞',
    params: ['主题', '旁白', '时长'],
  },
  ink: {
    name: '水墨',
    sub: '风格 · 镜头语言 · 复用 3 次',
    img: './assets/ink.jpg',
    keep: '水墨笔触措辞 · 留白构图 · 缓慢横移运镜',
    params: ['主题', '时长'],
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
  /** 原始占位列表(搜索用;卡片不直接铺 `{snake_case}`) */
  params?: string[];
  /** 🆕 卡片徽章(如「指令」「已激活」) */
  badges?: Array<{ label: string; kind: 'inst' | 'active' }>;
}

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

function buildParams(
  skillId: string | null,
  skills: Skill[],
  t: (s: string, vars?: Record<string, string | number>) => string,
): ParamDef[] {
  if (!skillId) return [];
  const params = SKILLS[skillId]?.params ?? skills.find((s) => s.id === skillId)?.params;
  if (!params) return [];
  return params.map((p): ParamDef => {
    const bare = paramTokenKey(p);
    const label = paramDisplayLabel(p);
    if (bare === '时长' || p === '时长') return { label, value: '45', numeric: true, unit: t('秒') };
    if (bare === '角色' || p === '角色') return { label, placeholder: t('从资产中心选择…') };
    if (bare === '旁白' || p === '旁白') return { label, placeholder: t('沿用模板文案结构…') };
    return { label, placeholder: t('填写{p}…', { p: label }) };
  });
}

function paramKey(skillId: string | null, index: number): string {
  return `${skillId ?? 'none'}:${index}`;
}

/** 把表单值收成 apply/activate 用的 `{name}` → 值 映射 */
function collectFilledParamMap(
  skillId: string | null,
  rawParams: string[],
  paramValues: Record<string, string>,
  dur: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  rawParams.forEach((p, i) => {
    const bare = paramTokenKey(p);
    const token = p.startsWith('{') ? p : `{${bare}}`;
    const key = paramKey(skillId, i);
    let val = paramValues[key] ?? '';
    if (bare === '时长' || p === '时长') val = dur;
    const trimmed = val.trim();
    if (!trimmed) return;
    out[token] = trimmed;
    out[bare] = trimmed;
  });
  return out;
}

/** 更新时间 → 友好文案(卡片副标题用) */
function fmtUpdated(iso: string, t: (s: string, vars?: Record<string, string | number>) => string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return t('时间未知');
  const min = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  if (min < 1) return t('刚刚更新');
  if (min < 60) return t('{n} 分钟前更新', { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('{n} 小时前更新', { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 7) return t('{n} 天前更新', { n: day });
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
  const t = useT();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
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
      showError(t('加载 Skill 失败'), err);
    }
  }, [t]);

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
          sub: t('节点数 {n} · 参数 {m} · {updated}', {
            n: s.nodes.length,
            m: s.params.length,
            updated: fmtUpdated(s.updatedAt, t),
          }),
          params: s.params,
          badges: [
            ...(s.instructions ? [{ label: t('指令'), kind: 'inst' as const }] : []),
            ...(activeSkillId === s.id ? [{ label: t('已激活'), kind: 'active' as const }] : []),
          ],
        })),
    [skills, activeSkillId, t],
  );

  /** 官方精选(出厂内置,builtin):封面占位,指令徽章 + 激活徽章 */
  const builtinCards: SkillCardDef[] = useMemo(
    () =>
      skills
        .filter((s) => s.builtin)
        .map((s) => ({
          skill: s.id,
          kind: 'builtin' as const,
          title: s.name,
          sub: s.description ?? t('双形态齐备 · 画布模板 + Agent 操作指令'),
          params: s.params,
          img: '',
          badges: [
            ...(s.instructions ? [{ label: t('指令'), kind: 'inst' as const }] : []),
            ...(activeSkillId === s.id ? [{ label: t('已激活'), kind: 'active' as const }] : []),
          ],
        })),
    [skills, activeSkillId, t],
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
      sub: t('节点数 {n} · 参数 {m}', { n: real.nodes.length, m: real.params.length }),
      img: '',
      keep: real.description ?? t('节点结构 + 参数 + 提示词模板'),
      params: real.params,
    };
  }, [selected, skills, t]);

  const params = useMemo(() => buildParams(selected, skills, t), [selected, skills, t]);

  const shotCalc = useMemo(() => {
    const v = parseInt(dur, 10);
    if (v > 0) return t('{v}s → 自动拆 {n} 镜', { v, n: Math.max(1, Math.ceil(v / 15)) });
    return '';
  }, [dur, t]);

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
      const text = [c.title, c.sub ?? '', ...(c.params ?? []), real?.instructions ?? '', real?.description ?? '']
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
      const name = await askPrompt({ title: t('Skill 名称'), initial: t('我的 Skill') });
      if (!name) return; // 取消或空名则返回
      // 第二步:(可选)把 Agent 操作要求写成指令段——确定空/取消 = 仅画布模板
      const instructions = await askPrompt({
        title: t('操作指令(可选,空则跳过)'),
        initial: '',
        placeholder: t('如「先 storyboard.plan 再 materialize,提交前 ask.user 确认档位;措辞段…」(支持 {占位})'),
      });
      const projects = await window.bigbotart.listProjects();
      const project = projects[0];
      if (!project) {
        showError(t('请先创建项目并搭建画布'));
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
      showError(t('保存 Skill 失败'), err);
    }
  };

  /** 从本地选一个技能文件夹或 .zip 包入库 */
  const handleImportSkill = async () => {
    try {
      const res = await window.bigbotart.importSkill();
      if (!res.ok) {
        if (!res.canceled) showError(res.error ?? t('导入 Skill 失败'));
        return;
      }
      await refreshSkills();
      const picked = res.skills[0] ?? res.skill;
      setSelected(picked.id);
      setInsDraft(picked.instructions ? { id: picked.id, text: picked.instructions, inject: picked.inject ?? 'full' } : null);
      setDur('45');
      setParamValues({});
    } catch (err) {
      showError(t('导入 Skill 失败'), err);
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
        showError(r.error ?? t('保存指令失败'));
        return;
      }
      await refreshSkills();
      setInsOpen(false);
      setInsDraft(null);
    } catch (err) {
      showError(t('保存指令失败'), err);
    } finally {
      setSavingIns(false);
    }
  };

  /** 🆕 注入指令到当前画布(skillActivate;需已打开项目+画布) */
  const handleActivate = async (skill: Skill) => {
    if (!projectId || !canvasId) {
      showError(t('请先打开一个项目与画布,再注入指令'));
      return;
    }
    if (!skill.instructions) {
      showError(t('「{name}」只有画布模板,没有操作指令段 · 可在下方编辑器中添加', { name: skill.name }));
      return;
    }
    try {
      const filled = collectFilledParamMap(skill.id, skill.params, paramValues, dur);
      const r = await window.bigbotart.skillActivate(
        projectId,
        canvasId,
        skill.id,
        Object.keys(filled).length ? filled : undefined,
      );
      if (!r.ok) {
        showError(r.error ?? t('注入指令失败'));
        return;
      }
      setActiveSkillId(skill.id);
    } catch (err) {
      showError(t('注入指令失败'), err);
    }
  };

  /** 🆕 取消当前画布的技能激活 */
  const handleDeactivate = async () => {
    if (!projectId || !canvasId) return;
    try {
      await window.bigbotart.skillDeactivate(projectId, canvasId);
      setActiveSkillId(null);
    } catch (err) {
      showError(t('停用失败'), err);
    }
  };

  const handleApply = async () => {
    if (!selected) return;
    const skill = skills.find((s) => s.id === selected);
    if (!skill) {
      showError(t('请先选择一个「我的 Skill」再应用'));
      return;
    }
    const projectName = await askPrompt({ title: t('新项目名称'), initial: skill.name });
    if (!projectName) return; // 取消或空名
    try {
      const filled = collectFilledParamMap(skill.id, skill.params, paramValues, dur);
      await window.bigbotart.applySkill(
        skill.id,
        projectName,
        false,
        Object.keys(filled).length ? filled : undefined,
      );
      onNavigate('canvas');
    } catch (err) {
      showError(t('应用 Skill 失败'), err);
    }
  };

  /** 删除我的 Skill:确认 → 调 IPC → 刷新 */
  const handleDelete = async (id: string, title: string) => {
    if (!confirm(t('确定删除 Skill「{title}」?删除后不可恢复。', { title }))) return;
    try {
      const res = await window.bigbotart.deleteSkill(id);
      if (!res.ok) {
        showError(res.error ?? t('删除 Skill 失败'));
        return;
      }
      if (selected === id) setSelected(null);
      await refreshSkills();
    } catch (err) {
      showError(t('删除 Skill 失败'), err);
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
            title={t('删除 Skill')}
            onClick={(e) => {
              e.stopPropagation();
              void handleDelete(c.skill as string, c.title);
            }}
            style={{ position: 'absolute', top: 6, right: 6, padding: '2px 9px', fontSize: 11, lineHeight: '1.5' }}
          >
            {t('删除')}
          </button>
        )}
      </div>
      <div className="si">
        <b>{c.title}</b>
        <div className="row g6" style={{ marginTop: 6 }}>
          {(c.badges ?? []).map((b) => (
            <span key={b.label} className={`badge ${b.kind === 'active' ? 'ok' : ''}`} style={{ fontSize: 10 }}>
              {b.label}
            </span>
          ))}
        </div>
        <div className="sub">{c.sub}</div>
        {(c.params?.length ?? 0) > 0 ? (
          <div className="pchs">
            <span className="chip" title={(c.params ?? []).map(paramDisplayLabel).join(' · ')}>
              {t('需 {n} 个参数', { n: c.params!.length })}
            </span>
            {(c.params ?? []).slice(0, CARD_PARAM_PREVIEW).map((p) => (
              <span className="chip" key={p}>
                {paramDisplayLabel(p)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="pg-skills">
      {promptDialog}
      <div className="app" data-od-id="skills-app">
        <PageTopBar odId="skills" backLabel={t('首页')} onBack={() => onNavigate('home')}>
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
            {t('保存当前画布为 Skill')}
          </button>
          <span className="sep"></span>
          <button
            className={`chip${filter === 'all' ? ' on' : ''}`}
            data-filter="all"
            onClick={() => setFilter('all')}
          >
            {t('全部')}
          </button>
          <button
            className={`chip${filter === 'builtin' ? ' on' : ''}`}
            data-filter="builtin"
            onClick={() => setFilter('builtin')}
          >
            {t('内置模板')}
          </button>
          <button
            className={`chip${filter === 'mine' ? ' on' : ''}`}
            data-filter="mine"
            onClick={() => setFilter('mine')}
          >
            {t('我的 Skill')}
          </button>
          <button
            className={`chip${filter === 'fork' ? ' on' : ''}`}
            data-filter="fork"
            onClick={() => setFilter('fork')}
          >
            {t('派生分支')}
          </button>
          <span className="spacer"></span>
          <div className="search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              id="searchInput"
              placeholder={t('搜索 Skill 名称、指令内容…')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </PageTopBar>

        <div className="work">
          <main className="grid-area" data-od-id="skills-grid">
            <div className="sect-h" data-sect="builtin" style={{ display: builtinShown ? '' : 'none' }}>
              <b>{t('官方精选')}</b>
              <span className="mut">{t('双形态齐备 · 画布模板 + Agent 操作指令')}</span>
            </div>
            <div
              className="sgrid"
              data-sect-grid="builtin"
              style={{ display: builtinShown ? '' : 'none' }}
            >
              {builtinCards.map(renderCard)}
            </div>

            <div className="sect-h" data-sect="mine" style={{ display: mineShown ? '' : 'none' }}>
              <b>{t('我的 Skill')}</b>
              <span className="mut">{t('从本地导入或从画布保存 · 可编辑')}</span>
            </div>
            <div className="sgrid" data-sect-grid="mine" style={{ display: mineShown ? '' : 'none' }}>
              {mineCards.map(renderCard)}
              {isDesktopShell() ? <div
                className="scard new"
                data-kind="mine"
                data-od-id="skill-import-card"
                role="button"
                tabIndex={0}
                onClick={() => void handleImportSkill()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void handleImportSkill();
                  }
                }}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 3v10" />
                  <path d="m8 9 4 4 4-4" />
                  <path d="M5 15v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4" />
                </svg>
                <span style={{ fontSize: 'var(--text-xs)' }}>
                  {t('从本地导入')}
                  <br />
                  {t('选择文件夹或 .zip 包')}
                </span>
              </div> : null}
            </div>
          </main>

          {/* 右:参数化 / 应用 */}
          <aside className="detail" data-od-id="skills-detail">
            <div className="detail-in">
              <div>
                <div className="lbl" style={{ marginBottom: '8px' }}>
                  {t('Skill 详情')}
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
                  <img id="dImg" src={active?.img ?? ''} alt={t('Skill 模板预览')} />
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
                  <span className="lbl">{t('参数化字段')}</span>
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
                  {t('保留的视觉包装')}
                </div>
                <div className="keepbox" id="dKeep">
                  {active?.keep ?? ''}
                </div>
              </div>
              {real && projectId ? (
                /* 🆕 操作指令(Agent 指令段):编辑/保存/注入——画布级配置事件 */
                <div>
                  <div className="row" style={{ justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span className="lbl">{t('操作指令(Agent)')}</span>
                    {real.instructions ? (
                      <span className="badge" title={`inject: ${real.inject ?? 'full'}`}>
                        {t('指令 · {mode}', { mode: real.inject ?? 'full' })}
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
                        placeholder={t('# 任务流程\n1. canvas.list_nodes 读需求…(支持 {占位};撰写规范见 docs/Agent技能文档-撰写指南与模板.md)')}
                        onChange={(e) => setInsDraft((d) => (d ? { ...d, text: e.target.value } : d))}
                      />
                      <div className="row g8">
                        {(['full', 'summary'] as const).map((m) => (
                          <span
                            key={m}
                            className={`chip${insDraft?.inject === m ? ' on' : ''}`}
                            onClick={() => setInsDraft((d) => (d ? { ...d, inject: m } : d))}
                          >
                            {m === 'full' ? t('全量注入') : t('摘要模式')}
                          </span>
                        ))}
                        <span className="mut" style={{ fontSize: 10.5, marginLeft: 'auto' }}>
                          {(insDraft?.text?.length ?? 0) > 4000 ? t('⚠ 超长建议摘要模式') : t('{n} 字', { n: insDraft?.text?.length ?? 0 })}
                        </span>
                      </div>
                      <div className="row g8">
                        <button className="btn btn-p btn-sm" data-od-id="skill-ins-save" disabled={savingIns} onClick={saveInstructions}>
                          {t('保存指令')}
                        </button>
                        <button className="btn btn-s btn-sm" onClick={() => setInsOpen(false)}>
                          {t('取消')}
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
                          {t('该技能仅画布模板——添加操作指令后,对话可自动按此执行')}
                        </div>
                      )}
                      <button className="btn btn-s btn-sm" data-od-id="skill-ins-edit" onClick={() => void openInsEditor(real)}>
                        {real.instructions ? t('编辑指令') : t('添加操作指令')}
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
                    {activeSkillId === real.id ? t('已注入当前画布 · 点击停用') : t('注入指令到当前画布')}
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
                {t('铺节点到新项目')}
              </button>
              <div className="row g8">
                <button
                  className="btn btn-s btn-sm grow"
                  onClick={() => onNavigate('canvas')}
                >
                  {t('编辑模板画布')}
                </button>
                <button className="btn btn-s btn-sm grow" id="forkBtn" onClick={handleFork}>
                  {t('派生分支')}
                </button>
              </div>
              <div>
                <div className="lbl" style={{ marginBottom: '8px' }}>
                  {t('派生版本')}
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
