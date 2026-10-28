import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasNode, CanvasSnapshot, ExportTask, TimelineExportRequest } from '@bigbotart/shared';
import {
  TimelineExportCoordinator,
  collectReadyTimelineExports,
  timelineShotIds,
} from '../timeline-auto-export';

const P = 'p1';
const C = 'c1';

function shot(id: string, path?: string, label = id): CanvasNode {
  return {
    id,
    kind: 'shot',
    label,
    position: { x: 0, y: 0 },
    data: path ? { resultPath: path } : {},
  } as CanvasNode;
}

function timeline(id: string, shotNodeIds: string[], data: Record<string, unknown> = {}): CanvasNode {
  return {
    id,
    kind: 'timeline',
    label: '成片时间线',
    position: { x: 0, y: 0 },
    data: { shotNodeIds, ...data },
  } as CanvasNode;
}

function snap(nodes: CanvasNode[], edges: CanvasSnapshot['edges'] = []): CanvasSnapshot {
  return {
    id: C,
    projectId: P,
    name: '主画布',
    nodes,
    edges,
    groups: [],
    version: 1,
    viewport: { x: 0, y: 0, z: 1 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as CanvasSnapshot;
}

const exists = (p: string) => p.startsWith('/tmp/ok-');

describe('collectReadyTimelineExports — 全部入轨镜头就绪才自动拼接', () => {
  it('按 shotNodeIds 顺序收集 clips', () => {
    const s = snap([
      shot('s1', '/tmp/ok-1.mp4', '镜头 01'),
      shot('s2', '/tmp/ok-2.mp4', '镜头 02'),
      timeline('tl', ['s2', 's1']),
    ]);
    const ready = collectReadyTimelineExports(s, { fileExists: exists });
    expect(ready).toHaveLength(1);
    expect(ready[0]!.clips.map((c) => c.nodeId)).toEqual(['s2', 's1']);
    expect(ready[0]!.request.clips.map((c) => c.path)).toEqual(['/tmp/ok-2.mp4', '/tmp/ok-1.mp4']);
  });

  it('任一镜头缺产物则整条时间线不导出(不允许只拼一半)', () => {
    const s = snap([shot('s1', '/tmp/ok-1.mp4'), shot('s2'), timeline('tl', ['s1', 's2'])]);
    expect(collectReadyTimelineExports(s, { fileExists: exists })).toEqual([]);
  });

  it('已经导出成功的时间线不重复拼接', () => {
    const s = snap([
      shot('s1', '/tmp/ok-1.mp4'),
      timeline('tl', ['s1'], { resultPath: '/tmp/ok-final.mp4' }),
    ]);
    expect(collectReadyTimelineExports(s, { fileExists: exists })).toEqual([]);
  });

  it('没有 shotNodeIds 时按 clip 连线顺序回退', () => {
    const tl = timeline('tl', []);
    const s = snap([shot('s1', '/tmp/ok-1.mp4'), shot('s2', '/tmp/ok-2.mp4'), tl], [
      { id: 'e1', source: 's2', target: 'tl', label: 'clip' },
      { id: 'e2', source: 's1', target: 'tl', label: 'clip' },
    ] as CanvasSnapshot['edges']);
    expect(timelineShotIds(tl, s.edges)).toEqual(['s2', 's1']);
  });
});

describe('TimelineExportCoordinator — 自动提交与结果回写', () => {
  it('保存后自动 submit,成功后把 outputPath 写回时间线并去重', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'timeline-auto-'));
    const f1 = join(dir, '1.mp4');
    const f2 = join(dir, '2.mp4');
    writeFileSync(f1, 'x');
    writeFileSync(f2, 'x');
    const nodes = [shot('s1', f1, '镜头 01'), shot('s2', f2, '镜头 02'), timeline('tl', ['s1', 's2'])];
    let canvas = snap(nodes);
    let submits = 0;
    let lastReq: TimelineExportRequest | undefined;
    const store = {
      listProjects: () => [{ id: P }],
      loadProjectCanvases: () => ({ projectId: P, canvases: [canvas], activeCanvasId: C }),
      saveCanvasSnapshot: (next: CanvasSnapshot) => {
        canvas = { ...next };
        return { ok: true };
      },
    };
    const exportSvc = {
      submit: (req: TimelineExportRequest) => {
        submits += 1;
        lastReq = req;
        return { taskId: `exp-${submits}` };
      },
      status: (id: string): ExportTask => ({
        id, projectId: P, status: 'succeeded', outputPath: '/tmp/ok-final.mp4', createdAt: new Date().toISOString(),
      }),
    };
    const coordinator = new TimelineExportCoordinator(store as never, exportSvc as never, undefined, { pollMs: 1 });
    await coordinator.scanAll();
    for (let i = 0; i < 100 && !(canvas.nodes.find((n) => n.id === 'tl')?.data as { resultPath?: string })?.resultPath; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(submits).toBe(1);
    expect(lastReq?.clips.map((c) => c.nodeId)).toEqual(['s1', 's2']);
    expect((canvas.nodes.find((n) => n.id === 'tl')?.data as { resultPath?: string })?.resultPath).toBe('/tmp/ok-final.mp4');
    // 回写触发的下一次保存不应再提交一次
    coordinator.onCanvasSaved(canvas);
    await new Promise((r) => setTimeout(r, 10));
    expect(submits).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('手动 exportNode 缺片时明确失败,不提交 ffmpeg', async () => {
    const nodes = [shot('s1'), timeline('tl', ['s1'])];
    const canvas = snap(nodes);
    const store = {
      listProjects: () => [{ id: P }],
      loadProjectCanvases: () => ({ projectId: P, canvases: [canvas], activeCanvasId: C }),
      saveCanvasSnapshot: () => ({ ok: true }),
    };
    let submits = 0;
    const exportSvc = { submit: () => ({ taskId: `exp-${++submits}` }), status: () => ({ id: '', projectId: P, status: 'failed', createdAt: '' }) };
    const coordinator = new TimelineExportCoordinator(store as never, exportSvc as never, undefined, { pollMs: 1 });
    await expect(coordinator.exportNode(P, C, 'tl')).rejects.toThrow('缺少可用成片');
    expect(submits).toBe(0);
  });
});
