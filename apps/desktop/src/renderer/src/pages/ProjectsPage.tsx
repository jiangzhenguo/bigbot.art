import React, { useState } from 'react';
import { baseStyles, btnStyles, cardStyles, colors, spacing, textSizes } from '../styles/design';
import { usePrompt } from '../components/usePrompt';
import { useT } from '../i18n';
import PageTopBar from '../components/PageTopBar';

interface Project {
  id: string;
  name: string;
  createdAt: string;
}

interface ProjectsPageProps {
  onNavigate: (page: 'home' | 'canvas' | 'assets' | 'skills' | 'timeline' | 'settings' | 'onboarding' | 'projects') => void;
  /** 返回上一页(App 导航栈出栈,回到来源页) */
  onBack: () => void;
  /** 返回按钮文案(来源页名,如「首页」「画布」) */
  backLabel: string;
  projects: Project[];
  onSelectProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onNewProject: (name: string) => void;
}

export default function ProjectsPage({ onBack, backLabel, projects, onSelectProject, onDeleteProject, onRenameProject, onNewProject }: ProjectsPageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [showNewModal, setShowNewModal] = useState(false);
  const [newName, setNewName] = useState('');
  const { ask: askPrompt, dialog: promptDialog } = usePrompt();
  const t = useT();

  const filteredProjects = projects.filter((p) =>
    p.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleNewProject = () => {
    if (!newName.trim()) return;
    onNewProject(newName);
    setNewName('');
    setShowNewModal(false);
  };

  const handleRename = async (id: string, currentName: string) => {
    const newName = await askPrompt({ title: t('重命名项目'), initial: currentName });
    if (newName && newName !== currentName) {
      onRenameProject(id, newName);
    }
  };

  const handleDelete = (id: string, name: string) => {
    if (confirm(t('确定删除项目「{name}」吗?此操作不可恢复。', { name }))) {
      onDeleteProject(id);
    }
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  return (
    <div className="pg-projects" style={{ ...baseStyles.app, height: 'calc(100vh - 34px)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {promptDialog}
      {/* 公共顶部栏:返回来源页 + 面包屑 + 新建项目(与其它页同款) */}
      <PageTopBar odId="projects" backLabel={backLabel} onBack={onBack} crumb={<b>{t('项目管理')}</b>}>
        <span className="spacer" />
        <button className="btn btn-p btn-sm" data-od-id="project-new" onClick={() => setShowNewModal(true)}>
          {t('新建项目')}
        </button>
      </PageTopBar>

      {/* 主体 */}
      <div style={{ flex: 1, overflow: 'auto', padding: spacing[8], background: colors.bg }}>
        <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
          {/* 页头 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: spacing[4], marginBottom: spacing[8] }}>
            <h1 style={{ fontFamily: '"SF Pro Display", sans-serif', fontSize: textSizes.xl, fontWeight: 600, margin: 0 }}>{t('所有项目')}</h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2], padding: `${spacing[2]} ${spacing[3]}`, background: colors.surfaceWarm, border: `1px solid ${colors.border}`, borderRadius: '12px', width: '280px' }}>
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('搜索项目名称…')}
                style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: textSizes.sm }}
              />
            </div>
          </div>

          {/* 项目网格 */}
          {filteredProjects.length === 0 ? (
            <div style={{ textAlign: 'center', padding: `${spacing[12]} ${spacing[5]}`, color: colors.muted }}>
              <h2 style={{ fontSize: textSizes.lg, fontWeight: 600, color: colors.fg, margin: `${spacing[4]} 0 ${spacing[2]}` }}>{t('还没有项目')}</h2>
              <p style={{ fontSize: textSizes.sm, margin: `0 0 ${spacing[5]}` }}>{t('创建你的第一个项目,开始创作')}</p>
              <button onClick={() => setShowNewModal(true)} style={{ ...btnStyles.base, ...btnStyles.primary }}>{t('新建项目')}</button>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: spacing[4], marginTop: spacing[2] }}>
              {filteredProjects.map((p) => (
                <div key={p.id} className="proj-card" style={{ ...cardStyles.base, padding: spacing[4], display: 'flex', flexDirection: 'column', gap: spacing[3], cursor: 'pointer', position: 'relative' }} onClick={() => onSelectProject(p.id)}>
                  <div style={{ width: '100%', height: '120px', borderRadius: '8px', overflow: 'hidden', background: colors.surface, position: 'relative' }}>
                    <img src="./assets/env-dusk.jpg" alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <b style={{ display: 'block', fontSize: textSizes.sm, marginBottom: spacing[1] }}>{p.name}</b>
                    <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2], fontSize: '11px', color: colors.muted }}>
                      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: colors.success }}></span>
                      <span>{formatDate(p.createdAt)}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: spacing[2], marginTop: 'auto', paddingTop: spacing[2], borderTop: `1px solid ${colors.borderSoft}` }}>
                    <button onClick={(e) => { e.stopPropagation(); onSelectProject(p.id); }} style={{ ...btnStyles.base, ...btnStyles.secondary, flex: 1, fontSize: '11px', padding: `${spacing[1]} ${spacing[2]}` }}>{t('打开')}</button>
                    <button onClick={(e) => { e.stopPropagation(); handleRename(p.id, p.name); }} style={{ ...btnStyles.base, ...btnStyles.ghost, flex: 1, fontSize: '11px', padding: `${spacing[1]} ${spacing[2]}` }}>{t('重命名')}</button>
                    <button onClick={(e) => { e.stopPropagation(); handleDelete(p.id, p.name); }} style={{ ...btnStyles.base, ...btnStyles.danger, flex: 1, fontSize: '11px', padding: `${spacing[1]} ${spacing[2]}` }}>{t('删除')}</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 新建项目对话框 */}
      {showNewModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'grid', placeItems: 'center', zIndex: 100 }}>
          <div style={{ background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: '16px', boxShadow: '0 24px 70px rgba(0,0,0,.16)', width: '480px', maxWidth: '90vw', padding: spacing[6] }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: spacing[3], marginBottom: spacing[4] }}>
              <h2 style={{ fontSize: textSizes.base, fontWeight: 600, margin: 0 }}>{t('新建项目')}</h2>
              <button onClick={() => setShowNewModal(false)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontSize: '20px', color: colors.muted }}>×</button>
            </div>
            <div style={{ marginBottom: spacing[5] }}>
              <label style={{ display: 'block', fontSize: textSizes.sm, fontWeight: 500, marginBottom: spacing[2], color: colors.fg }}>{t('项目名称')}</label>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('输入项目名称,如:草原之河 · 短剧')}
                style={{ width: '100%', padding: `${spacing[2]} ${spacing[3]}`, border: `1px solid ${colors.border}`, borderRadius: '12px', fontSize: textSizes.sm, background: colors.surfaceWarm }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleNewProject(); }}
                autoFocus
              />
            </div>
            <div style={{ display: 'flex', gap: spacing[2], justifyContent: 'flex-end' }}>
              <button onClick={() => setShowNewModal(false)} style={{ ...btnStyles.base, ...btnStyles.ghost }}>{t('取消')}</button>
              <button onClick={handleNewProject} style={{ ...btnStyles.base, ...btnStyles.primary }}>{t('创建')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}