/**
 * SkillStore — Skills 库(PRD §5.5 P0 基础)
 * - 保存:把项目画布(节点结构 + 参数 + 提示词模板)深拷贝为 Skill
 * - 应用:Skill 克隆到新项目画布(换新 id 实体化),返回新项目
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Skill, CanvasNode, CanvasEdge, Project } from '@bigbotart/shared';
import type { ProjectStore } from './store';

const DATA_DIR = process.env.BIGBOTART_HOME ?? join(homedir(), '.bigbotart');
const SKILLS_FILE = join(DATA_DIR, 'skills.json');

/** 从节点数据里收集参数占位,如 {主题} {旁白} {时长} */
export function collectParams(nodes: CanvasNode[]): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\{([^{}]{1,20})\}/g)) out.add(`{${m[1]}}`);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  nodes.forEach((n) => walk(n.data));
  return [...out];
}

export class SkillStore {
  private skills: Skill[] = [];

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
    this.skills = this.read();
  }

  private read(): Skill[] {
    if (!existsSync(SKILLS_FILE)) return [];
    try {
      return JSON.parse(readFileSync(SKILLS_FILE, 'utf-8')) as Skill[];
    } catch {
      return [];
    }
  }

  private persist() {
    writeFileSync(SKILLS_FILE, JSON.stringify(this.skills, null, 2));
  }

  list(): Skill[] {
    return [...this.skills].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  get(id: string): Skill | undefined {
    return this.skills.find((s) => s.id === id);
  }

  delete(id: string): { ok: boolean; error?: string } {
    const idx = this.skills.findIndex((s) => s.id === id);
    if (idx < 0) return { ok: false, error: 'Skill 不存在' };
    this.skills.splice(idx, 1);
    this.persist();
    return { ok: true };
  }

  /** 保存当前项目画布为 Skill */
  save(name: string, snapshot: { id?: string; projectId: string; nodes: CanvasNode[]; edges: CanvasEdge[] }): Skill {
    const now = new Date().toISOString();
    const skill: Skill = {
      id: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      nodes: JSON.parse(JSON.stringify(snapshot.nodes)),
      edges: JSON.parse(JSON.stringify(snapshot.edges)),
      params: collectParams(snapshot.nodes),
      description: snapshot.nodes.filter((n) => n.kind === 'document').map((n) => (n.data as { markdown?: string }).markdown ?? '').join('\n').slice(0, 200) || undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.skills.push(skill);
    this.persist();
    return skill;
  }

  /** 应用到新项目:克隆节点(新 id)、建项目、写画布 */
  apply(skillId: string, projectName: string, store: ProjectStore): Project {
    const skill = this.get(skillId);
    if (!skill) throw new Error('Skill 不存在');
    // 替换参数占位为空(用户可在画布上改)
    const repl = (v: unknown): unknown => {
      if (typeof v === 'string') return v.replace(/\{[^{}]{1,20}\}/g, '');
      if (Array.isArray(v)) return v.map(repl);
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(o)) out[k] = repl(o[k]);
        return out;
      }
      return v;
    };
    const idMap = new Map<string, string>();
    const nid = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const nodes = skill.nodes.map((n) => {
      const id = nid(n.kind);
      idMap.set(n.id, id);
      return {
        ...JSON.parse(JSON.stringify(n)),
        id,
        data: repl(n.data),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
    const edges = skill.edges.map((e) => ({
      ...e,
      id: nid('edge'),
      source: idMap.get(e.source) ?? e.source,
      target: idMap.get(e.target) ?? e.target,
    }));
    const project = store.createProject(projectName);
    const now = new Date().toISOString();
    store.saveCanvasSnapshot({
      id: project.activeCanvasId || 'main',
      projectId: project.id,
      name: '主画布',
      nodes,
      edges,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    return project;
  }
}