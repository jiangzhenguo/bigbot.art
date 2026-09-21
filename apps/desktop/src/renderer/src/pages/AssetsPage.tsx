/**
 * AssetsPage — 资源管理(对齐设计稿 assets.html / project-assets.html)
 *
 * 双视图:
 * - 项目视图(projectId 给定,默认):项目头(返回画布/统计/打开总资源库)+ 项目分类/标签筛选 + 从画布产物导入
 * - 总资源库(viewPid=null):跨项目聚合头 + 项目过滤 + 全局分类
 *
 * 数据:一次拉总库 listAssets() + 分类 + 项目列表;视图内过滤。删除 = 软删(回收站,7 天后清理);
 * 详情面板由 pages/assets/AssetDetail 承担,卡片由 pages/assets/AssetCard 承担。
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { Asset, AssetCategory, AssetRef, Project } from '@bigbotart/shared';
import { AssetCard } from './assets/AssetCard';
import { AssetDetail } from './assets/AssetDetail';
import { usePrompt } from '../components/usePrompt';

export type AssetsPageTarget =
  | 'home'
  | 'canvas'
  | 'assets'
  | 'skills'
  | 'timeline'
  | 'settings'
  | 'onboarding'
  | 'projects';

interface AssetsPageProps {
  onNavigate: (page: AssetsPageTarget) => void;
  /** 进入时的项目上下文(画布入口);null = 直接打开总资源库 */
  projectId: string | null;
  projectName: string;
}

const KIND_LABEL: Record<string, string> = { image: '图片', video: '视频', audio: '音频', document: '文档' };

export default function AssetsPage({ onNavigate, projectId, projectName }: AssetsPageProps) {
  /* ── 数据 ── */
  const [allAssets, setAllAssets] = useState<Asset[]>([]);
  const [categories, setCategories] = useState<AssetCategory[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  /* ── 视图与筛选 ── */
  const [viewPid, setViewPid] = useState<string | null>(projectId); // null = 总资源库
  const [cat, setCat] = useState<string>('all');
  const [mtype, setMtype] = useState<string | null>(null);
  const [selTags, setSelTags] = useState<string[]>([]);
  const [q, setQ] = useState('');
  /* ── 选中与引用 ── */
  const [sel, setSel] = useState<string | null>(null);
  const [refs, setRefs] = useState<AssetRef[]>([]);
  /* ── 弹层 / 提示 ── */
  const [catInput, setCatInput] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [archOpen, setArchOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const toast = (m: string) => setNote(m);

  /* ---- 加载:总库 + 分类 + 项目 ---- */
  const load = async () => {
    try {
      const [list, cats, ps] = await Promise.all([
        window.bigbotart.listAssets(),
        window.bigbotart.listAssetCategories(),
        window.bigbotart.listProjects(),
      ]);
      setAllAssets(list);
      setCategories(cats);
      setProjects(ps);
    } catch (e) {
      setNote(`资源加载失败:${(e as Error).message}`);
    }
  };
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- 切换视图时刷新选中信息 ---- */
  useEffect(() => {
    setSel(null);
    setRefs([]);
    setCat('all');
    setMtype(null);
    setSelTags([]);
    setQ('');
  }, [viewPid]);

  /* ---- 选中资产 → 拉引用 ---- */
  useEffect(() => {
    if (!sel) {
      setRefs([]);
      return;
    }
    let alive = true;
    window.bigbotart
      .assetRefs(sel)
      .then((r) => {
        if (alive) setRefs(r);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [sel]);

  const selAsset = allAssets.find((a) => a.id === sel) ?? null;
  const viewName = projects.find((p) => p.id === viewPid)?.name || projectName;

  /* ---- 视图内资源 + 过滤 ---- */
  const baseList = useMemo(
    () => allAssets.filter((a) => !a.deletedAt && (viewPid ? a.projectId === viewPid : true)),
    [allAssets, viewPid],
  );
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return baseList.filter((a) => {
      if (cat !== 'all' && a.categoryId !== (cat === '_none' ? undefined : cat)) return false;
      if (mtype && a.kind !== mtype) return false;
      if (selTags.length && !selTags.every((t) => (a.tags ?? []).includes(t))) return false;
      if (needle) {
        const hay = `${a.name} ${a.id} ${(a.tags ?? []).join(' ')}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [baseList, cat, mtype, selTags, q]);

  /* 按分类分组(展示顺序:有分类的按 categories 顺序,最后未分类) */
  const groups = useMemo(() => {
    const g = new Map<string, Asset[]>();
    for (const a of filtered) {
      const key = a.categoryId ?? '_none';
      if (!g.has(key)) g.set(key, []);
      g.get(key)!.push(a);
    }
    const order = categories
      .filter((c) => !c.projectId || c.projectId === viewPid)
      .map((c) => c.id)
      .filter((id) => g.has(id));
    const rest = [...g.keys()].filter((k) => !order.includes(k)).sort((x, y) => (x === '_none' ? 1 : -1) - (y === '_none' ? 1 : -1));
    return [...order, ...rest].map((k) => ({ key: k, items: g.get(k)! }));
  }, [filtered, categories, viewPid]);

  const catName = (id: string) => (id === '_none' ? '未分类' : categories.find((c) => c.id === id)?.name ?? '未知');

  /* 全库标签频次(联想候选) */
  const tagStats = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of allAssets) for (const t of a.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].map(([t, n]) => ({ t, n })).sort((x, y) => y.n - x.n || x.t.localeCompare(y.t));
  }, [allAssets]);

  const activeTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of baseList) for (const t of a.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].map(([t, n]) => ({ t, n })).sort((x, y) => y.n - x.n);
  }, [baseList]);

  /* ---- 动作:导入 / 分类 / 更新 / 删除 / 归档 ---- */
  const handleImport = async () => {
    try {
      // 项目视图下导入,归属直接由主进程原子写入(projectId),避免导入后逐条 update 的分裂链路
      const res = await window.bigbotart.importAssets({ projectId: viewPid ?? undefined });
      if (res.assets.length === 0 && res.failed.length === 0) return; // 用户取消:静默
      await load();
      if (res.failed.length) {
        toast(`导入完成:成功 ${res.assets.length} 项,失败 ${res.failed.length} 项 — ${res.failed.map((f) => `${f.name}:${f.error}`).join('、')}`);
      } else {
        toast(`已导入 ${res.assets.length} 项资源${viewPid ? ' · 归入本项目' : ''}`);
      }
    } catch (e) {
      toast(`导入失败:${(e as Error).message}`);
    }
  };

  const createCategory = async () => {
    const input = document.getElementById('catAddInput') as HTMLInputElement | null;
    const name = input?.value.trim();
    if (!name) return;
    await window.bigbotart.createAssetCategory(name, viewPid ?? undefined).catch((e) => toast(`创建分类失败:${(e as Error).message}`));
    setCatInput(false);
    await load();
  };

  const { ask: askPrompt, dialog: promptDialog } = usePrompt();

  const renameCategory = async (id: string) => {
    const c = categories.find((x) => x.id === id);
    if (!c) return;
    const next = await askPrompt({ title: '重命名分类', initial: c.name });
    if (!next || next === c.name) return;
    const res = await window.bigbotart.renameAssetCategory(id, next).catch((e) => ({ ok: false as const, error: (e as Error).message }));
    if (!res.ok) toast(res.error ?? '重命名失败');
    await load();
  };

  const deleteCategory = async (id: string) => {
    const n = baseList.filter((a) => a.categoryId === id).length;
    if (n > 0 && !window.confirm(`分类「${catName(id)}」下有 ${n} 个资源。\n删除后这些资源将转「未分类」,原资源文件保留。\n继续?`)) return;
    const res = await window.bigbotart.deleteAssetCategory(id).catch((e) => ({ ok: false as const, error: (e as Error).message }));
    if (!res.ok) toast(res.error ?? '删除分类失败');
    await load();
  };

  const updateSel = async (patch: { name?: string; categoryId?: string | null; projectId?: string | null; tags?: string[] }): Promise<boolean> => {
    if (!sel) return false;
    const res = await window.bigbotart.updateAsset(sel, patch).catch(() => ({ ok: false as const, error: '更新失败' }));
    if (!res.ok) toast(res.error ?? '更新失败');
    await load();
    return res.ok;
  };

  const handleDelete = async () => {
    if (!sel || !selAsset) return;
    const msg = refs.length
      ? `「${selAsset.name}」被 ${refs.length} 处画布节点引用。\n删除后文件进入回收站(7 天后清理),引用节点标记为「资产已移除」。\n继续?`
      : `将「${selAsset.name}」移到回收站?(7 天后清理,期间可恢复)`;
    if (!window.confirm(msg)) return;
    const res = await window.bigbotart.deleteAsset(sel).catch((e) => ({ ok: false as const, error: (e as Error).message, refs: undefined }));
    if (!res.ok) {
      toast(res.error ?? '删除失败');
      return;
    }
    toast(`已移到回收站 ·「${selAsset.name}」`);
    setSel(null);
    await load();
  };

  /* 从画布产物导入 */
  const [archItems, setArchItems] = useState<Array<{ nodeId: string; name: string; path: string; meta: string }>>([]);
  const [archSel, setArchSel] = useState<Set<string>>(new Set());
  const [archCat, setArchCat] = useState('');
  const openArchive = async () => {
    if (!viewPid) return;
    try {
      const list = await window.bigbotart.listArchivableProducts(viewPid);
      setArchItems(list);
      setArchSel(new Set(list.map((i) => i.nodeId)));
      setArchCat('');
      setArchOpen(true);
    } catch (e) {
      toast(`读取画布产物失败:${(e as Error).message}`);
    }
  };
  const confirmArchive = async () => {
    if (!viewPid) return;
    const items = archItems.filter((i) => archSel.has(i.nodeId)).map((i) => ({ nodeId: i.nodeId, path: i.path }));
    if (!items.length) return;
    const res = await window.bigbotart
      .archiveProducts({ projectId: viewPid, items, categoryId: archCat || undefined })
      .catch((e) => ({ ok: false as const, assets: [] as Asset[], error: (e as Error).message }));
    if (!res.ok) toast(res.error ?? '归档失败');
    else toast(`已归档 ${res.assets.length} 个产物为项目资源`);
    setArchOpen(false);
    setSel(res.assets[0]?.id ?? null);
    await load();
  };

  /* 回收站 */
  const [trash, setTrash] = useState<Asset[]>([]);
  const openTrash = async () => {
    const t = await window.bigbotart.listTrash().catch(() => []);
    setTrash(t);
    setTrashOpen(true);
  };
  const restoreSel = async (id: string) => {
    const res = await window.bigbotart.restoreAsset(id).catch((e) => ({ ok: false as const, error: (e as Error).message }));
    if (!res.ok) toast(res.error ?? '恢复失败');
    setTrash(await window.bigbotart.listTrash().catch(() => []));
    await load();
  };
  const emptyTrash = async () => {
    if (!window.confirm('永久清空回收站?文件将被物理删除,不可恢复。')) return;
    await window.bigbotart.emptyTrash();
    setTrash(await window.bigbotart.listTrash().catch(() => []));
    await load();
  };

  const projectCats = categories.filter((c) => !c.projectId || c.projectId === (viewPid ?? undefined));

  return (
    <div className="pg-assets">
      {promptDialog}
      <div className="app" data-od-id="assets-app">
        {/* ── 头部:项目头(项目视图)/ 总库头 ── */}
        {viewPid ? (
          <section className="projhero" data-od-id="project-hero" style={{ padding: '18px 22px 10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button className="btn btn-g btn-sm" data-od-id="project-back" title="返回画布" onClick={() => onNavigate('canvas')}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="m14 6-6 6 6 6" />
                </svg>
                画布
              </button>
              <b style={{ fontSize: 14 }}>{viewName}</b>
              <span className="mut" style={{ fontSize: 11 }}>项目资源 · 仅本项目</span>
              <span className="spacer" />
              <a
                className="btn btn-s btn-sm"
                data-od-id="open-total-library"
                style={{ cursor: 'pointer' }}
                onClick={() => setViewPid(null)}
              >
                打开总资源库 →
              </a>
            </div>
            <div style={{ display: 'flex', gap: 26, marginTop: 10, flexWrap: 'wrap' }}>
              <span className="mono">{baseList.length} 资源总数</span>
              <span className="mono">{projectCats.length} 分类</span>
              <span className="mono ok">{baseList.filter((a) => a.source === 'product').length} 产物归档</span>
              <span className="mono">{baseList.filter((a) => !a.categoryId).length} 未分类</span>
            </div>
          </section>
        ) : (
          <section className="libhero" data-od-id="library-hero" style={{ padding: '18px 22px 10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                className="btn btn-g btn-sm"
                data-od-id="assets-back"
                onClick={() => (projects.length || projectId ? onNavigate('canvas') : onNavigate('home'))}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="m14 6-6 6 6 6" />
                </svg>
                {projectId ? '画布' : '首页'}
              </button>
              <b style={{ fontSize: 14 }}>总资源库</b>
              <span className="mut" style={{ fontSize: 11 }}>跨项目聚合 · 全局资源</span>
              <span className="spacer" />
              {projects.map((p) => {
                const n = allAssets.filter((a) => a.projectId === p.id && !a.deletedAt).length;
                return (
                  <button
                    key={p.id}
                    className={`chip${viewPid === p.id ? '' : ''}`}
                    style={{ fontSize: 11 }}
                    data-od-id={`proj-pill-${p.id}`}
                    onClick={() => setViewPid(p.id)}
                  >
                    {p.name} <span className="n">{n}</span>
                  </button>
                );
              })}
              {projects.length ? <span className="mut" style={{ fontSize: 11 }}>点项目名进入该项目资源页</span> : null}
            </div>
            <div style={{ display: 'flex', gap: 26, marginTop: 10, flexWrap: 'wrap' }}>
              <span className="mono">{allAssets.filter((a) => !a.deletedAt).length} 资源总数</span>
              <span className="mono">{projects.filter((p) => allAssets.some((a) => a.projectId === p.id)).length} 涉及项目</span>
              <span className="mono">{categories.filter((c) => !c.projectId).length} 全局分类</span>
              <span className="mono ok">{allAssets.filter((a) => a.source === 'product' && !a.deletedAt).length} 产物归档</span>
            </div>
          </section>
        )}

        {/* ── 工具条 ── */}
        <header className="topbar" data-od-id="assets-toolbar" style={{ marginTop: 2 }}>
          <span className="crumb" data-od-id="assets-crumb">
            <b>资源管理</b>
            <span className="chev">›</span>
            <span>{viewPid ? projectName : '总资源库'}</span>
          </span>
          <span className="sep" />
          {viewPid ? (
            <button className="btn btn-s btn-sm" id="archiveBtn" data-od-id="assets-archive-from-canvas" title="把画布里有产物的节点归档为项目资源" onClick={() => void openArchive()}>
              从画布产物导入
            </button>
          ) : null}
          <button className="btn btn-p btn-sm" id="importBtn" data-od-id="assets-import" onClick={handleImport}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M12 5v14M5 12h14" />
            </svg>
            导入
          </button>
          <span className="sep" />
          <button className="btn btn-s btn-sm" data-od-id="trash-view" onClick={() => void openTrash()}>
            回收站
          </button>
          <span className="spacer" />
          <div className="search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 13, height: 13 }}>
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input placeholder="搜索资源名 / id / 标签…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </header>

        {/* ── 筛选条:分类 + 媒体 + 标签 ── */}
        <div className="filters" data-od-id="assets-filters" style={{ padding: '10px 22px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="filter-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="lbl-mini" style={{ fontSize: 11, color: 'var(--meta)', flex: 'none' }}>分类</span>
            <div className="chips-scroller" style={{ display: 'flex', gap: 6, overflowX: 'auto', flex: 1 }} data-od-id="assets-cat-chips">
              <button className={`chip${cat === 'all' ? ' on' : ''}`} onClick={() => setCat('all')}>
                全部 <span className="n">{baseList.length}</span>
              </button>
              {projectCats.map((c) => (
                <button
                  key={c.id}
                  className={`chip${cat === c.id ? ' on' : ''}`}
                  data-od-id={`cat-chip-${c.id}`}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    renameCategory(c.id);
                  }}
                  title="右键重命名"
                  onClick={() => setCat(cat === c.id ? 'all' : c.id)}
                >
                  {c.name} <span className="n">{baseList.filter((a) => a.categoryId === c.id).length}</span>
                </button>
              ))}
              <button className={`chip${cat === '_none' ? ' on' : ''}`} onClick={() => setCat(cat === '_none' ? 'all' : '_none')}>
                未分类 <span className="n">{baseList.filter((a) => !a.categoryId).length}</span>
              </button>
              {catInput ? (
                <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  <input
                    id="catAddInput"
                    placeholder={viewPid ? '分类名' : '全局分类名'}
                    maxLength={14}
                    autoFocus
                    data-od-id="cat-add-input"
                    style={{ width: 90, fontSize: 11, padding: '3px 6px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)' }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void createCategory();
                      if (e.key === 'Escape') setCatInput(false);
                    }}
                    onBlur={() => void createCategory()}
                  />
                </span>
              ) : (
                <button className="chip add" data-od-id="cat-add" onClick={() => setCatInput(true)}>
                  ＋ 新建分类
                </button>
              )}
            </div>
            <span className="mut" style={{ fontSize: 11, flex: 'none' }}>
              {viewPid ? '项目分类 · 仅本项目可见' : `${categories.filter((c) => !c.projectId).length} 个全局分类`}
            </span>
          </div>
          <div className="filter-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="lbl-mini" style={{ fontSize: 11, color: 'var(--meta)', flex: 'none' }}>媒体</span>
            <div className="chips-scroller" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
              <button className={`chip${mtype === null ? ' on' : ''}`} onClick={() => setMtype(null)}>
                全部 <span className="n">{baseList.length}</span>
              </button>
              {(['image', 'video', 'audio', 'document'] as const).map((k) => (
                <button
                  key={k}
                  className={`chip${mtype === k ? ' on' : ''}`}
                  data-od-id={`mtype-${k}`}
                  onClick={() => setMtype(mtype === k ? null : k)}
                >
                  {KIND_LABEL[k]} <span className="n">{baseList.filter((a) => a.kind === k).length}</span>
                </button>
              ))}
            </div>
          </div>
          {activeTags.length ? (
            <div className="filter-row" data-od-id="assets-tag-chips" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="lbl-mini" style={{ fontSize: 11, color: 'var(--meta)', flex: 'none' }}>标签</span>
              {selTags.map((t) => (
                <button key={t} className="chip on" data-od-id={`tag-sel-${t}`} onClick={() => setSelTags((s) => s.filter((x) => x !== t))}>
                  {t} <span className="xbtn">×</span>
                </button>
              ))}
              {activeTags
                .filter((s) => !selTags.includes(s.t))
                .slice(0, 8)
                .map((s) => (
                  <button key={s.t} className="chip" data-od-id={`tag-add-${s.t}`} onClick={() => setSelTags((v) => [...v, s.t])}>
                    + {s.t} <span className="n">{s.n}</span>
                  </button>
                ))}
              {selTags.length ? (
                <button className="chip add" onClick={() => setSelTags([])}>清除筛选</button>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* ── 网格 + 详情 ── */}
        <div className="work">
          <main className="grid-area" data-od-id="assets-grid">
            {note ? (
              <div role="status" style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 8, background: 'var(--surface-warm)', color: 'var(--fg)', fontSize: 12 }}>
                {note}
              </div>
            ) : null}
            {filtered.length === 0 ? (
              <div className="empty" style={{ padding: '50px 20px', textAlign: 'center' }}>
                <b>{baseList.length === 0 ? '还没有资源' : '当前筛选条件下没有结果'}</b>
                <div className="mut" style={{ fontSize: 11, marginTop: 6 }}>
                  {baseList.length === 0 ? '点击「导入」添加图片 / 视频 / 音频 / 文档' : '试着清空标签或换个分类'}
                </div>
                {baseList.length === 0 ? (
                  <button className="btn btn-p btn-sm" style={{ marginTop: 12 }} data-od-id="empty-import" onClick={handleImport}>
                    导入资产
                  </button>
                ) : (
                  <button
                    className="btn btn-s btn-sm"
                    style={{ marginTop: 12 }}
                    onClick={() => {
                      setCat('all');
                      setMtype(null);
                      setSelTags([]);
                      setQ('');
                    }}
                  >
                    清除全部筛选
                  </button>
                )}
              </div>
            ) : (
              groups.map((g) => (
                <React.Fragment key={g.key}>
                  <div className="sect-h" data-cat-sect={g.key}>
                    <b>{catName(g.key)}</b>
                    <span className="mut">
                      {g.key === '_none' ? '没有归入任何分类的资源' : viewPid ? '项目分类' : '分类'}
                    </span>
                    <span className="pill">{g.items.length}</span>
                  </div>
                  <div className="agrid" data-cat-grid={g.key}>
                    {g.items.map((a) => (
                      <AssetCard
                        key={a.id}
                        asset={a}
                        categoryName={g.key === '_none' ? undefined : catName(g.key)}
                        refCount={refs.length && sel === a.id ? refs.length : undefined}
                        selected={sel === a.id}
                        onSelect={(id) => setSel(id)}
                      />
                    ))}
                  </div>
                </React.Fragment>
              ))
            )}
          </main>
          <aside className="detail" data-od-id="assets-detail">
            <AssetDetail
              asset={selAsset}
              categories={categories}
              projectId={viewPid}
              projectName={viewName}
              refs={refs}
              tagStats={tagStats}
              toastMsg={toast}
              onUpdate={updateSel}
              onDelete={() => void handleDelete()}
              onUseInCanvas={() => {
                toast('已打开画布 · 可在资产节点「更换资产…」中选择该资源');
                onNavigate('canvas');
              }}
            />
          </aside>
        </div>
      </div>

      {/* ── 从画布产物导入弹层(仅项目视图) ── */}
      {archOpen && (
        <div
          className="archive-pop"
          data-od-id="archive-from-canvas-pop"
          style={{ position: 'fixed', inset: 0, zIndex: 130, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,.35)' }}
          onClick={() => setArchOpen(false)}
        >
          <div className="pop open" style={{ width: 420, maxHeight: '70vh', display: 'block' }} onClick={(e) => e.stopPropagation()}>
            <div className="ap-h" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center' }}>
              <div style={{ flex: 1 }}>
                <b>从画布产物导入</b>
                <div className="mut" style={{ fontSize: 11, marginTop: 3 }}>勾选画布中有产物的节点 · 归档为本项目资源</div>
              </div>
              <button className="ibtn" aria-label="关闭" onClick={() => setArchOpen(false)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M6 18 18 6" /></svg>
              </button>
            </div>
            <div className="ap-list" style={{ padding: '4px 16px', overflowY: 'auto', maxHeight: 300 }}>
              {archItems.length === 0 ? (
                <div className="mut" style={{ padding: '16px 0' }}>本项目画布暂无已生成产物</div>
              ) : (
                archItems.map((it) => (
                  <label key={it.nodeId} className="row" style={{ gap: 8, padding: '8px 2px', alignItems: 'center', display: 'flex' }}>
                    <input
                      type="checkbox"
                      checked={archSel.has(it.nodeId)}
                      onChange={(e) => {
                        const next = new Set(archSel);
                        if (e.target.checked) next.add(it.nodeId);
                        else next.delete(it.nodeId);
                        setArchSel(next);
                      }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <b style={{ fontSize: 12, fontWeight: 600 }}>{it.name}</b>
                      <div className="mut" style={{ fontSize: 10.5 }}>{it.meta}</div>
                    </span>
                    <span className="badge ok" style={{ fontSize: 10 }}>可归档</span>
                  </label>
                ))
              )}
            </div>
            <div className="ap-foot" style={{ padding: '10px 16px', borderTop: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="mut" style={{ fontSize: 11 }}>归档到分类</span>
              <select
                style={{ flex: 1, padding: '5px 8px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', fontSize: 12 }}
                value={archCat}
                onChange={(e) => setArchCat(e.target.value)}
              >
                <option value="">未分类</option>
                {projectCats.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <button className="btn btn-g btn-sm" onClick={() => setArchOpen(false)}>取消</button>
              <button className="btn btn-p btn-sm" data-od-id="archive-confirm" disabled={archSel.size === 0} onClick={() => void confirmArchive()}>
                归档 {archSel.size} 个产物
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 回收站弹层 ── */}
      {trashOpen && (
        <div
          className="trash-pop"
          style={{ position: 'fixed', inset: 0, zIndex: 130, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,.35)' }}
          onClick={() => setTrashOpen(false)}
        >
          <div className="pop open" style={{ width: 460, maxHeight: '70vh', display: 'block' }} onClick={(e) => e.stopPropagation()}>
            <div className="ap-h" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center' }}>
              <b>回收站</b>
              <span className="mut" style={{ fontSize: 11, marginLeft: 8 }}>7 天后自动清理 · 期间可恢复</span>
              <span className="spacer" />
              <button className="btn btn-g btn-sm btn-danger" disabled={trash.length === 0} onClick={() => void emptyTrash()}>
                清空回收站
              </button>
            </div>
            <div style={{ padding: '4px 16px', overflowY: 'auto', maxHeight: 320 }}>
              {trash.length === 0 ? (
                <div className="mut" style={{ padding: '20px 0', textAlign: 'center' }}>回收站是空的</div>
              ) : (
                trash.map((a) => (
                  <div key={a.id} className="row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border-soft)' }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <b style={{ fontSize: 12 }}>{a.name}</b>
                      <div className="mut" style={{ fontSize: 10.5 }}>{a.kind} · {new Date(a.deletedAt ?? '').toLocaleString('zh-CN', { hour12: false })}</div>
                    </span>
                    <button className="btn btn-s btn-sm" data-od-id={`trash-restore-${a.id}`} onClick={() => void restoreSel(a.id)}>
                      恢复
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}