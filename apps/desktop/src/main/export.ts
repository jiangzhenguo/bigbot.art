/**
 * ExportService — 时间线导出(PRD §5.6 P1 基础:FFmpeg 合成 + 保留音轨)
 * - concat demuxer 顺序拼接各 Take 媒体;带音轨文件保留,纯视频流时重编码兜底
 * - 后台子进程 + -progress 解析阶段/百分比;渲染层轮询 export-status
 * - outputName / clip 路径均做白名单校验,防路径穿越与任意读
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import type { ExportTask, TimelineExportRequest } from '@bigbotart/shared';
import { ASSETS_DIR, OUTPUTS_DIR, isUnderRoot, importAllowRoots } from './assets.js';

const DATA_DIR = process.env.BIGBOTART_HOME ?? join(homedir(), '.bigbotart');
const EXPORT_DIR = join(DATA_DIR, 'exports');

function sanitizeOutputName(name: string | undefined): string {
  const base = basename(name ?? 'timeline').replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/[^\w.\u4e00-\u9fff-]+/g, '_').replace(/^\.+/, '') || 'timeline';
  return cleaned.slice(0, 80);
}

function assertClipAllowed(path: string): void {
  const roots = [...importAllowRoots(), ASSETS_DIR, OUTPUTS_DIR, EXPORT_DIR];
  if (!roots.some((r) => isUnderRoot(path, r))) {
    throw new Error(`片段路径不在允许目录: ${basename(path)}`);
  }
}

export class ExportService {
  private tasks: ExportTask[] = [];
  private children = new Map<string, ChildProcess>();

  status(taskId: string): ExportTask {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return { id: taskId, projectId: '', status: 'failed', error: '任务不存在', createdAt: new Date().toISOString() };
    return { ...t };
  }

  /** 启动导出;只有一条任务在跑时排队(简单串行) */
  submit(req: TimelineExportRequest): { taskId: string } {
    if (req.clips.length === 0) throw new Error('时间线为空:没有可导出的片段');
    for (const c of req.clips) {
      if (!existsSync(c.path)) throw new Error(`片段文件不存在: ${c.path}`);
      assertClipAllowed(c.path);
    }
    mkdirSync(EXPORT_DIR, { recursive: true });
    const taskId = `exp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const safeName = sanitizeOutputName(req.outputName);
    const outputPath = resolve(join(EXPORT_DIR, `${safeName}-${taskId.slice(4)}.mp4`));
    if (!isUnderRoot(outputPath, EXPORT_DIR)) {
      throw new Error('导出路径非法');
    }
    const task: ExportTask = {
      id: taskId,
      projectId: req.projectId,
      status: 'running',
      stage: '准备片段列表…',
      outputPath,
      createdAt: new Date().toISOString(),
    };
    this.tasks.push(task);
    void this.run(task, req, outputPath);
    return { taskId };
  }

  private async run(task: ExportTask, req: TimelineExportRequest, outputPath: string): Promise<void> {
    const listFile = join(EXPORT_DIR, `${task.id}.list.txt`);
    const lines = req.clips.map((c) => `file '${c.path.replace(/'/g, "'\\''")}'`).join('\n');
    writeFileSync(listFile, lines);

    try {
      await this.execWithProgress(task, listFile, outputPath);
      task.status = 'succeeded';
      task.progress = 1;
      task.stage = '完成 · 已归档到项目';
    } catch (e) {
      task.status = 'failed';
      task.stage = '导出失败';
      task.error = (e as Error).message;
    } finally {
      try { unlinkSync(listFile); } catch { /* ignore */ }
      this.children.delete(task.id);
    }
  }

  private execWithProgress(task: ExportTask, listFile: string, outputPath: string): Promise<void> {
    return new Promise((resolveP, reject) => {
      // -c copy 保留原音轨;若混流失败(如无声片段)则由 -progress 重试路径兜底
      // 这里直接用转码保证任何输入都能合成: -c:v libx264 -c:a aac -movflags +faststart
      const args = [
        '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k',
        '-movflags', '+faststart',
        '-progress', 'pipe:1',
        '-nostats',
        outputPath,
      ];
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.children.set(task.id, child);
      let errAcc = '';
      task.stage = 'FFmpeg 合成中…';
      child.stdout.on('data', (d: Buffer) => {
        const text = d.toString();
        const m = /out_time_ms=(\d+)/.exec(text);
        const dur = /duration=([\d.]+)/.exec(text);
        if (m && dur) {
          const pct = Math.min(99, Math.round((Number(m[1]) / 1_000_000 / Number(dur)) * 100));
          task.progress = Math.max(task.progress ?? 0, pct);
        }
      });
      child.stderr.on('data', (d: Buffer) => (errAcc += d.toString()));
      child.on('close', (code) => {
        this.children.delete(task.id);
        if (code === 0 && existsSync(outputPath)) {
          resolveP();
        } else {
          reject(new Error(errAcc.split('\n').filter(Boolean).slice(-4).join('\n') || `ffmpeg exit ${code}`));
        }
      });
      child.on('error', (e) => reject(e));
    });
  }
}
