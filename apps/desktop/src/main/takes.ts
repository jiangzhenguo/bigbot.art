/**
 * TakeStore — shot 节点的 Take 历史(每次生成 = 一条 Take,保留历史不覆盖)
 * 持久化:~/.bigbotart/workspaces/<projectId>/takes.json(2026-09-29 起按工作空间收敛;
 * 旧路径 takes-<projectId>.json 由 migrate.ts 启动时搬迁)
 *
 * 与 AssetStore / SkillStore 同模式:
 * - 项目维度一份 JSON,增量小、查找方便
 * - Take 与 shotNodeId 关联,节点删除不级联(历史保留)
 * - takeId 与 RenderJob.takeId 对应,Job 完成时自动 append
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ShotTakeHistory, Take } from '@bigbotart/shared';
import { probeMedia } from './assets.js';
import { takesFile } from './workspace-paths.js';

interface TakeDoc {
  takes: Take[];
}

export class TakeStore {
  private cache = new Map<string, TakeDoc>(); // projectId → doc

  private file(projectId: string): string {
    return takesFile(projectId);
  }

  private load(projectId: string): TakeDoc {
    const cached = this.cache.get(projectId);
    if (cached) return cached;
    const f = this.file(projectId);
    mkdirSync(dirname(f), { recursive: true });
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
    const f = this.file(projectId);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(doc, null, 2));
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

  /** 更新一条 Take(状态变化 / 写 resultPath / finishedAt / elapsedSec / durationSec / error) */
  async patch(projectId: string, takeId: string, patch: Partial<Take>): Promise<Take | null> {
    const doc = this.load(projectId);
    const idx = doc.takes.findIndex((t) => t.id === takeId);
    if (idx < 0) return null;
    const next = { ...doc.takes[idx], ...patch } as Take;
    if (next.status === 'succeeded' || next.status === 'failed' || next.status === 'cancelled') {
      if (!next.finishedAt) next.finishedAt = new Date().toISOString();
      // 生成耗时(墙钟)始终记入 elapsedSec;durationSec 只作无产物时的兜底
      if (next.createdAt) {
        next.elapsedSec = Math.max(0, (Date.parse(next.finishedAt) - Date.parse(next.createdAt)) / 1000);
        if (next.durationSec === undefined) next.durationSec = next.elapsedSec;
      }
    }
    // 成功且有产物:媒体时长(ffprobe 异步探测,不阻塞主进程)记入 durationSec(时间线/剪辑用真实视频长度);
    // 生成耗时保留在 elapsedSec 不被覆盖。历史记录里旧 Take 的 durationSec 可能是生成耗时,
    // 时间线侧已有 metadata 兜底纠正,这里语义统一为「媒体时长」
    if (next.status === 'succeeded' && next.resultPath && existsSync(next.resultPath)) {
      const meta = await probeMedia(next.resultPath, 'video');
      if (meta.durationSec !== undefined) next.durationSec = meta.durationSec;
    }
    doc.takes[idx] = next;
    this.save(projectId);
    return next;
  }

  /** 列出项目下全部 Take(按 createdAt 倒序,最新在前) */
  list(projectId: string): Take[] {
    return [...this.load(projectId).takes].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /**
   * 清理「孤儿 Take」——残留的 queued/running 记录(2026-09-29)。
   *
   * **为什么需要**:`RenderQueue` 的 jobs 是**纯内存**的(`render-queue.ts` 的 `private jobs = []`),
   * 应用一旦退出/崩溃,**队列没了但 Take 记录留在磁盘上**。下次启动后这些 Take 永远停在
   * `queued`/`running` —— 检查器里显示成「排队中」永不消失,用户以为任务还在跑(实际早随进程消失)。
   * 真实场景:生成中重启应用(或开发时热重启),就会留下这类记录。
   *
   * 语义:进程已不可能再更新这些 Take,故一律标记为 `failed` 并写明原因(比「排队中」诚实,
   * 也符合红线 R6 不静默吞)。**不改已终态的 Take**,也不删产物文件。
   *
   * @param projectIds 要清理的项目;由调用方从 ProjectStore 取(避免本模块反向依赖)
   * @returns 清理条数与明细(供日志总线留痕)
   */
  reconcileOrphaned(projectIds: string[]): { cleaned: number; details: Array<{ projectId: string; takeId: string; from: string }> } {
    const details: Array<{ projectId: string; takeId: string; from: string }> = [];
    const now = new Date().toISOString();
    for (const pid of projectIds) {
      const doc = this.load(pid);
      let changed = false;
      for (const t of doc.takes) {
        if (t.status !== 'queued' && t.status !== 'running') continue;
        details.push({ projectId: pid, takeId: t.id, from: t.status });
        t.status = 'failed';
        t.error = '应用已重启,该任务不再运行(队列为内存态,重启后无法续跑)';
        t.finishedAt = now;
        if (t.createdAt) {
          t.elapsedSec = Math.max(0, (Date.parse(now) - Date.parse(t.createdAt)) / 1000);
        }
        changed = true;
      }
      if (changed) this.save(pid);
    }
    return { cleaned: details.length, details };
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
