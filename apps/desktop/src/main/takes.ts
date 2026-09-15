/**
 * TakeStore — shot 节点的 Take 历史(每次生成 = 一条 Take,保留历史不覆盖)
 * 持久化:~/.bigbotart/takes-<projectId>.json
 *
 * 与 AssetStore / SkillStore 同模式:
 * - 项目维度一份 JSON,增量小、查找方便
 * - Take 与 shotNodeId 关联,节点删除不级联(历史保留)
 * - takeId 与 RenderJob.takeId 对应,Job 完成时自动 append
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ShotTakeHistory, Take } from '@bigbotart/shared';

const DATA_DIR = process.env.BIGBOTART_HOME ?? join(homedir(), '.bigbotart');

interface TakeDoc {
  takes: Take[];
}

export class TakeStore {
  private cache = new Map<string, TakeDoc>(); // projectId → doc

  private file(projectId: string): string {
    return join(DATA_DIR, `takes-${projectId}.json`);
  }

  private load(projectId: string): TakeDoc {
    const cached = this.cache.get(projectId);
    if (cached) return cached;
    mkdirSync(DATA_DIR, { recursive: true });
    const f = this.file(projectId);
    if (existsSync(f)) {
      try {
        const doc = JSON.parse(readFileSync(f, 'utf-8')) as TakeDoc;
        this.cache.set(projectId, doc);
        return doc;
      } catch {
        /* fallthrough */
      }
    }
    const empty: TakeDoc = { takes: [] };
    this.cache.set(projectId, empty);
    return empty;
  }

  private save(projectId: string): void {
    const doc = this.cache.get(projectId);
    if (!doc) return;
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(this.file(projectId), JSON.stringify(doc, null, 2));
  }

  /** 追加一条新 Take(新跑/重跑都走这个;attempt 自动累加) */
  append(projectId: string, partial: Omit<Take, 'id' | 'attempt' | 'createdAt'>): Take {
    const doc = this.load(projectId);
    const existing = doc.takes.filter((t) => t.shotNodeId === partial.shotNodeId);
    const attempt = existing.length ? Math.max(...existing.map((t) => t.attempt)) + 1 : 1;
    const take: Take = {
      id: `take-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      attempt,
      createdAt: new Date().toISOString(),
      ...partial,
    };
    doc.takes.push(take);
    this.save(projectId);
    return take;
  }

  /** 更新一条 Take(状态变化 / 写 resultPath / finishedAt / durationSec / error) */
  patch(projectId: string, takeId: string, patch: Partial<Take>): Take | null {
    const doc = this.load(projectId);
    const idx = doc.takes.findIndex((t) => t.id === takeId);
    if (idx < 0) return null;
    const next = { ...doc.takes[idx], ...patch } as Take;
    if (next.status === 'succeeded' || next.status === 'failed' || next.status === 'cancelled') {
      if (!next.finishedAt) next.finishedAt = new Date().toISOString();
      if (next.durationSec === undefined && next.createdAt) {
        next.durationSec = Math.max(0, (Date.parse(next.finishedAt) - Date.parse(next.createdAt)) / 1000);
      }
    }
    doc.takes[idx] = next;
    this.save(projectId);
    return next;
  }

  /** 列出项目下全部 Take(按 createdAt 倒序,最新在前) */
  list(projectId: string): Take[] {
    return [...this.load(projectId).takes].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** 列出指定 shot 节点的 Take 历史(按 attempt 倒序) */
  listByNode(projectId: string, shotNodeId: string): Take[] {
    return this.list(projectId).filter((t) => t.shotNodeId === shotNodeId);
  }

  /** 取单个 Take */
  get(projectId: string, takeId: string): Take | undefined {
    return this.load(projectId).takes.find((t) => t.id === takeId);
  }

  /** shot 节点的完整历史(给 UI 用) */
  history(projectId: string, shotNodeId: string, currentTakeId?: string): ShotTakeHistory {
    const takes = this.listByNode(projectId, shotNodeId);
    const cur = currentTakeId && takes.some((t) => t.id === currentTakeId) ? currentTakeId : takes[0]?.id;
    return { shotNodeId, takes, currentTakeId: cur };
  }

  /** 删除单条 Take(不删产物文件,只删元数据) */
  delete(projectId: string, takeId: string): { ok: boolean; error?: string } {
    const doc = this.load(projectId);
    const idx = doc.takes.findIndex((t) => t.id === takeId);
    if (idx < 0) return { ok: false, error: 'Take 不存在' };
    doc.takes.splice(idx, 1);
    this.save(projectId);
    return { ok: true };
  }
}
