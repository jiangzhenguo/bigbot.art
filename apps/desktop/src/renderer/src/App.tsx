import React, { useState, useEffect, useCallback } from 'react';
import HomePage from './pages/HomePage';
import CanvasPage from './pages/CanvasPage';
import AssetsPage from './pages/AssetsPage';
import SkillsPage from './pages/SkillsPage';
import TimelinePage from './pages/TimelinePage';
import SettingsPage from './pages/SettingsPage';
import OnboardingPage from './pages/OnboardingPage';
import ProjectsPage from './pages/ProjectsPage';
import ErrorBoundary from './components/ErrorBoundary';
import type { CanvasSnapshot, ProjectCanvases } from '@bigbotart/shared';

export type Page = 'home' | 'canvas' | 'assets' | 'skills' | 'timeline' | 'settings' | 'onboarding' | 'projects';

export interface ProjectItem {
  id: string;
  name: string;
  createdAt: string;
}

export interface EngineStatus {
  h3c: { ready: boolean; text: string };
  mlxgen: { ready: boolean; text: string };
  llm: { ready: boolean; text: string };
}

export default function App() {
  const [currentPage, setCurrentPage] = useState<Page>('home');
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectCanvases, setProjectCanvases] = useState<ProjectCanvases | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>({
    h3c: { ready: false, text: '检测中' },
    mlxgen: { ready: false, text: '检测中' },
    llm: { ready: false, text: '检测中' },
  });

  useEffect(() => {
    loadProjects();
    loadEngineStatus();
  }, []);

  async function loadProjects() {
    try {
      const list = await window.bigbotart.listProjects();
      setProjects(list.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt })));
    } catch (e) {
      console.error('加载项目失败', e);
    }
  }

  /** 加载项目下所有画布;若无画布自动建一个主画布 */
  const loadCanvasesForProject = useCallback(async (pid: string | null) => {
    if (!pid) {
      setProjectCanvases(null);
      return;
    }
    let pc = await window.bigbotart.loadProjectCanvases(pid);
    if (!pc.canvases || pc.canvases.length === 0) {
      // 空项目自动建主画布
      const main = await window.bigbotart.createCanvas(pid, '主画布');
      pc = { projectId: pid, canvases: [main], activeCanvasId: main.id };
    }
    setProjectCanvases(pc);
  }, []);

  async function loadEngineStatus() {
    try {
      const probes = await window.bigbotart.probeRuntimes();
      const h3 = probes.find((p) => p.id === 'h3c');
      const mlx = probes.find((p) => p.id === 'mlxgen');
      setEngineStatus({
        h3c: { ready: h3?.status === 'ready', text: h3?.status === 'ready' ? '就绪' : h3?.detected ? '异常' : '未安装' },
        mlxgen: { ready: mlx?.status === 'ready', text: mlx?.status === 'ready' ? '就绪' : mlx?.detected ? '异常' : '未安装' },
        llm: { ready: true, text: 'Ornith-1.5-35B' },
      });
    } catch (e) {
      console.error('引擎探测失败', e);
    }
  }

  const handleNavigate = useCallback(
    (page: Page) => {
      // 画布必须有项目上下文:未选项目时先去项目列表,避免空白页
      if (page === 'canvas' && !projectId) {
        setCurrentPage('projects');
        return;
      }
      setCurrentPage(page);
    },
    [projectId],
  );

  const handleGenerate = async (brief: string) => {
    try {
      let pid = projectId;
      if (!pid) {
        const p = await window.bigbotart.createProject(brief.slice(0, 24) || '新项目');
        await loadProjects();
        setProjectId(p.id);
        pid = p.id;
        await loadCanvasesForProject(pid);
      }
      const st = await window.bigbotart.agentStart();
      if (!st.running) throw new Error('Agent 启动失败');
      // 新模式(分镜表):Agent 先出分镜表(表格可干预),进画布确认后一键铺节点
      const plan = await window.bigbotart.agentPlanStoryboard(brief, { projectId: pid });
      sessionStorage.setItem('bba.plan', JSON.stringify(plan));
      setCurrentPage('canvas');
    } catch (e) {
      console.error('规划失败', e);
      alert('规划失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  /** 选中项目(进入画布) */
  const handleSelectProject = async (id: string) => {
    setProjectId(id);
    await loadCanvasesForProject(id);
    setCurrentPage('canvas');
  };

  /** 新建项目 → 进入画布 */
  const handleNewProject = async (name?: string) => {
    try {
      const p = await window.bigbotart.createProject(name ?? `未命名项目 ${projects.length + 1}`);
      await loadProjects();
      setProjectId(p.id);
      await loadCanvasesForProject(p.id);
      setCurrentPage('canvas');
    } catch (e) {
      console.error('创建项目失败', e);
    }
  };

  const handleDeleteProject = async (id: string) => {
    try {
      await window.bigbotart.deleteProject(id);
      if (projectId === id) {
        setProjectId(null);
        setProjectCanvases(null);
      }
      loadProjects();
    } catch (e) {
      console.error('删除项目失败', e);
    }
  };

  const handleRenameProject = async (id: string, name: string) => {
    try {
      await window.bigbotart.renameProject(id, name);
      loadProjects();
    } catch (e) {
      console.error('重命名项目失败', e);
    }
  };

  /* ── 多画布:CanvasPage 内部通过 props 调用以下函数;CanvasPage 自己负责本地节点状态,
       切画布时把当前快照写回 list 中 active 那份,再切到目标画布 ── */

  /** CanvasPage 调用:把当前画布快照写回(自动持久化) */
  const handleSaveCanvas = useCallback(async (snap: CanvasSnapshot) => {
    try {
      await window.bigbotart.saveCanvasSnapshot(snap);
    } catch (e) {
      console.error('保存画布失败', e);
    }
  }, []);

  /** 切换活动画布(CanvasPage 本地会写回当前快照) */
  const handleSwitchCanvas = useCallback(async (canvasId: string): Promise<CanvasSnapshot | null> => {
    if (!projectId) return null;
    try {
      await window.bigbotart.switchActiveCanvas(projectId, canvasId);
      // 刷新列表
      const pc = await window.bigbotart.loadProjectCanvases(projectId);
      setProjectCanvases(pc);
      return pc.canvases.find((c) => c.id === canvasId) ?? null;
    } catch (e) {
      console.error('切换画布失败', e);
      return null;
    }
  }, [projectId]);

  /** 新建画布 */
  const handleCreateCanvas = useCallback(async (name?: string): Promise<CanvasSnapshot | null> => {
    if (!projectId) return null;
    try {
      const c = await window.bigbotart.createCanvas(projectId, name);
      const pc = await window.bigbotart.loadProjectCanvases(projectId);
      setProjectCanvases(pc);
      return c;
    } catch (e) {
      console.error('新建画布失败', e);
      return null;
    }
  }, [projectId]);

  /** 删除画布 */
  const handleDeleteCanvas = useCallback(async (canvasId: string): Promise<string | null> => {
    if (!projectId) return null;
    try {
      const res = await window.bigbotart.deleteCanvas(projectId, canvasId);
      if (!res.ok) {
        alert(res.error ?? '删除画布失败');
        return null;
      }
      const pc = await window.bigbotart.loadProjectCanvases(projectId);
      setProjectCanvases(pc);
      return pc.activeCanvasId;
    } catch (e) {
      console.error('删除画布失败', e);
      return null;
    }
  }, [projectId]);

  /** 重命名画布 */
  const handleRenameCanvas = useCallback(async (canvasId: string, name: string): Promise<boolean> => {
    if (!projectId) return false;
    try {
      const res = await window.bigbotart.renameCanvas(projectId, canvasId, name);
      if (!res.ok) {
        alert(res.error ?? '重命名失败');
        return false;
      }
      const pc = await window.bigbotart.loadProjectCanvases(projectId);
      setProjectCanvases(pc);
      return true;
    } catch (e) {
      console.error('重命名画布失败', e);
      return false;
    }
  }, [projectId]);

  return (
    <>
      {currentPage === 'home' && (
        <ErrorBoundary name="首页">
          <HomePage
            onNavigate={handleNavigate}
            onGenerate={handleGenerate}
            onNewProject={handleNewProject}
            projects={projects}
            onSelectProject={handleSelectProject}
            onDeleteProject={handleDeleteProject}
            onRenameProject={handleRenameProject}
            engineStatus={engineStatus}
          />
        </ErrorBoundary>
      )}
      {currentPage === 'canvas' && projectId && (
        <ErrorBoundary name="画布">
          <CanvasPage
            onNavigate={handleNavigate}
            projectId={projectId}
            projectName={projects.find((p) => p.id === projectId)?.name ?? '未命名项目'}
            projectCanvases={projectCanvases}
            onSaveCanvas={handleSaveCanvas}
            onSwitchCanvas={handleSwitchCanvas}
            onCreateCanvas={handleCreateCanvas}
            onDeleteCanvas={handleDeleteCanvas}
            onRenameCanvas={handleRenameCanvas}
          />
        </ErrorBoundary>
      )}
      {currentPage === 'assets' && (
        <ErrorBoundary name="资产">
          <AssetsPage
            onNavigate={handleNavigate}
            projectId={projectId}
            projectName={projects.find((p) => p.id === projectId)?.name ?? '未命名项目'}
          />
        </ErrorBoundary>
      )}
      {currentPage === 'skills' && (
        <ErrorBoundary name="技能">
          <SkillsPage
            onNavigate={handleNavigate}
            projectId={projectId}
            canvasId={projectCanvases?.activeCanvasId ?? projectCanvases?.canvases[0]?.id ?? null}
          />
        </ErrorBoundary>
      )}
      {currentPage === 'timeline' && (
        <ErrorBoundary name="时间线">
          <TimelinePage
            onNavigate={handleNavigate}
            projectId={projectId}
            projectName={projects.find((p) => p.id === projectId)?.name ?? null}
          />
        </ErrorBoundary>
      )}
      {currentPage === 'settings' && (
        <ErrorBoundary name="设置">
          <SettingsPage onNavigate={handleNavigate} />
        </ErrorBoundary>
      )}
      {currentPage === 'onboarding' && (
        <ErrorBoundary name="引导">
          <OnboardingPage onNavigate={handleNavigate} />
        </ErrorBoundary>
      )}
      {currentPage === 'projects' && (
        <ErrorBoundary name="项目">
          <ProjectsPage
            projects={projects}
            onSelectProject={handleSelectProject}
            onDeleteProject={handleDeleteProject}
            onRenameProject={handleRenameProject}
            onNewProject={handleNewProject}
            onNavigate={handleNavigate}
          />
        </ErrorBoundary>
      )}
    </>
  );
}