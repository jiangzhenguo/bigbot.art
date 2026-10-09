import React, { useState, useEffect, useCallback, useRef } from 'react';
import HomePage from './pages/HomePage';
import CanvasPage from './pages/CanvasPage';
import AssetsPage from './pages/AssetsPage';
import SkillsPage from './pages/SkillsPage';
import TimelinePage from './pages/TimelinePage';
import SettingsPage from './pages/SettingsPage';
import OnboardingPage from './pages/OnboardingPage';
import ProjectsPage from './pages/ProjectsPage';
import ErrorBoundary from './components/ErrorBoundary';
import { I18nProvider, translate, type Lang } from './i18n';
import type { CanvasSnapshot, ProjectCanvases } from '@bigbotart/shared';

export type Page = 'home' | 'canvas' | 'assets' | 'skills' | 'timeline' | 'settings' | 'onboarding' | 'projects';

/** 页面中文名(返回按钮文案用) */
const PAGE_LABEL: Record<Page, string> = {
  home: '首页',
  canvas: '画布',
  assets: '资源管理',
  skills: 'Skills 库',
  timeline: '时间线',
  settings: '设置',
  onboarding: '引导',
  projects: '项目列表',
};

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
  /* 界面语言(启动时从 settings.json 回填,设置页切换即持久化) */
  const [lang, setLangState] = useState<Lang>('zh-CN');
  /* 简易导航栈:handleNavigate 压栈,详情页「返回」经 handleBack 出栈回到来源页
     (此前资源管理页写死回画布/凭 projects.length 猜来源,返回目标不对) */
  const navStackRef = useRef<Page[]>([]);
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
    window.bigbotart
      .getSettings()
      .then((s) => {
        if (s.language) setLangState(s.language);
      })
      .catch((e) => console.error('读取语言设置失败', e));
  }, []);

  /** 切换界面语言(立即生效 + 持久化到 settings.json) */
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    window.bigbotart.setSettings({ language: l }).catch((e) => console.error('保存语言设置失败', e));
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
      navStackRef.current.push(currentPage);
      if (navStackRef.current.length > 20) navStackRef.current.shift();
      setCurrentPage(page);
    },
    [projectId, currentPage],
  );

  /** 返回上一页(资源管理等详情页用);栈空兜底回首页 */
  const handleBack = useCallback(() => {
    const prev = navStackRef.current.pop();
    const target: Page = !prev ? 'home' : prev === 'canvas' && !projectId ? 'projects' : prev;
    setCurrentPage(target);
  }, [projectId]);

  /** 来源页文案(返回按钮标签);导航栈只在事件里改,渲染期读取最新值即可 */
  const backLabel = translate(lang, PAGE_LABEL[navStackRef.current[navStackRef.current.length - 1] ?? 'home']);

  const handleGenerate = async (
    brief: string,
    opts?: {
      skillId?: string | null;
      llm?: import('@bigbotart/shared').LlmSource | null;
      attachments?: Array<{ id: string; name: string; kind: string; localPath: string }>;
    },
  ) => {
    try {
      // 首页「生成」= 总是开一个新项目(新创作空间),不复用当前项目
      const p = await window.bigbotart.createProject(brief.slice(0, 24) || '新项目');
      await loadProjects();
      setProjectId(p.id);
      const pid = p.id;
      await loadCanvasesForProject(pid);

      // 模型带入:首页选择的 LLM 来源写为新项目的项目级覆盖(画布 Agent 优先读项目级覆盖)
      if (opts?.llm) {
        await window.bigbotart.setProjectLlm(pid, opts.llm).catch((e) => console.error('设置项目 LLM 失败', e));
      }
      // 资源带入:首页附件从全局资产转为项目资源(项目资源页可见;对话发送时主进程会再拷入项目文件夹)
      for (const a of opts?.attachments ?? []) {
        await window.bigbotart.updateAsset(a.id, { projectId: pid }).catch((e) => console.error('资产归入项目失败', e));
      }

      // 先跳转:项目与画布就绪后立刻进画布(规划是秒级 LLM 调用,期间用户已能看到画布);
      // 规划/对话随后经 bba-plan-ready / bba-newchat-ready 事件投递给已挂载的 CanvasPage
      setCurrentPage('canvas');

      const st = await window.bigbotart.agentStart();
      if (!st.running) throw new Error('Agent 启动失败');
      // 附件注入:首页导入的真实资产以引用注记拼进规划 brief(assetId 可供 Agent 引用)
      const attNote = opts?.attachments?.length
        ? `\n\n[参考附件:${opts.attachments.map((a) => `${a.name}(${a.kind},assetId=${a.id})`).join('、')}]`
        : '';
      // 新模式(分镜表):Agent 先出分镜表(表格可干预),进画布确认后一键铺节点
      const plan = await window.bigbotart.agentPlanStoryboard(brief + attNote, { projectId: pid });
      sessionStorage.setItem('bba.plan', JSON.stringify(plan));
      window.dispatchEvent(new Event('bba-plan-ready'));
      // 技能带入:选中的技能注入到新项目当前画布(对话自动加载指令段)
      if (opts?.skillId) {
        try {
          const pc = await window.bigbotart.loadProjectCanvases(pid);
          const canvasId = pc.activeCanvasId ?? pc.canvases[0]?.id;
          if (canvasId) await window.bigbotart.skillActivate(pid, canvasId, opts.skillId);
        } catch (e) {
          console.error('激活技能失败', e);
        }
      }
      // 对话带入:首页 brief(含附件)作为画布 Agent 的首条消息,由 CanvasPage 自动发送
      sessionStorage.setItem('bba.newChat', JSON.stringify({ text: brief, attachments: opts?.attachments ?? [] }));
      window.dispatchEvent(new Event('bba-newchat-ready'));
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

  /**
   * 导入 .bba 项目包 → 新建项目并进入它的画布。
   *
   * 主进程负责解包落盘(项目/画布/Take/记忆/附件);渲染层只做三件事:
   * 刷新项目列表、选中新项目、就地把新项目的画布装进状态再跳画布。
   * ⚠️ 弹对话框 + 解包是**秒级到分钟级**的操作(大附件包),期间不能改导航状态,
   * 否则用户会先看到一个空画布。
   */
  const handleImportProject = async () => {
    try {
      const res = await window.bigbotart.importProjectPackage();
      if (res.canceled) return;
      if (!res.ok || !res.project) {
        alert(`导入失败: ${res.error ?? '未知错误'}`);
        return;
      }
      await loadProjects();
      const pid = res.project.id;
      setProjectId(pid);
      await loadCanvasesForProject(pid);
      setCurrentPage('canvas');
      // 非致命问题(缺产物/附件缺失)必须让用户看见 —— 否则「导入了但节点是空的」无从解释
      if (res.warnings?.length) {
        alert(`项目「${res.project.name}」已导入,但有 ${res.warnings.length} 项提醒:\n\n${res.warnings.join('\n')}`);
      }
    } catch (e) {
      console.error('导入项目包失败', e);
      alert(`导入失败: ${e instanceof Error ? e.message : String(e)}`);
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
    <I18nProvider lang={lang} setLang={setLang}>
    <>
      {/* macOS 无边框窗口:顶部全局拖拽条(为悬浮红绿灯让位,点击拖动移动窗口;背景随当前页) */}
      <div className="titlebar-drag" data-page={currentPage} />
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
            onImportProject={handleImportProject}
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
            onBack={handleBack}
            backLabel={backLabel}
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
          <SettingsPage onNavigate={handleNavigate} onBack={handleBack} backLabel={backLabel} />
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
            onBack={handleBack}
            backLabel={backLabel}
          />
        </ErrorBoundary>
      )}
    </>
    </I18nProvider>
  );
}