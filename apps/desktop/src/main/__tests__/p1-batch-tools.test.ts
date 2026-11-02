/**
 * P1 批量工具入口。
 * 目标:把「多镜逐条 canvas.connect / h3.write_prompt」压成一次工具调用,
 * 减少 Agent 轮次,同时保留单条入口的全部校验与部分失败摘要。
 */
import { describe, expect, it } from 'vitest';
import type { CanvasEdge, CanvasNode } from '@bigbotart/shared';
import { ToolHandlers } from '../tool-handlers';

const PROJECT = 'proj-p1';
const CANVAS = 'cv-p1';
const CTX = { projectId: PROJECT, canvasId: CANVAS };

function node(id: string, kind: CanvasNode['kind'], label: string): CanvasNode {
  return {
    id,
    kind,
    label,
    position: { x: 0, y: 0 },
    data: kind === 'shot' ? { seconds: 5, mode: 'ref-image' } : { prompt: label },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as CanvasNode;
}

function harness(nodes: CanvasNode[]) {
  let canvases = [{
    id: CANVAS,
    projectId: PROJECT,
    name: '主画布',
    nodes,
    edges: [] as CanvasEdge[],
    groups: [],
    version: 1,
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  }];
  let saves = 0;
  const store = {
    loadProjectCanvases: () => structuredClone({ projectId: PROJECT, canvases }),
    saveCanvasSnapshot: (snap: typeof canvases[number]) => {
      saves += 1;
      canvases = [structuredClone(snap)];
      return { ok: true };
    },
  };
  /** 默认返回一段可辨识的长提示词;调用方可覆盖 */
  const h = new ToolHandlers(
    store as never,
    { get: () => undefined } as never,
    { get: () => undefined } as never,
    {} as never,
    {} as never,
    { getActiveSkillId: () => undefined } as never,
    {
      completeH3Prompt: async () => ({ ok: true, text: 'LONG-PROMPT-' + '剧情'.repeat(1200), model: 'stub' }),
    } as never,
  );
  return { h, edits: () => structuredClone(canvases[0]!), saves: () => saves };
}

describe('canvas.connect_many', () => {
  it('一次调用创建多条合法连线，只落盘一次', async () => {
    const { h, edits, saves } = harness([
      node('img-a', 'image-gen', '角色A'),
      node('img-b', 'image-gen', '角色B'),
      node('img-c', 'image-gen', '角色C'),
      node('shot-1', 'shot', '镜头 01'),
    ]);
    const res = await h.call('canvas.connect_many', {
      edges: [
        { from: 'img-a', to: 'shot-1', label: 'ref-image' },
        { from: 'img-b', to: 'shot-1', label: 'ref-image' },
        { from: 'img-c', to: 'shot-1', label: 'ref-image' },
      ],
    }, CTX);
    expect(res.ok).toBe(true);
    expect(edits().edges).toHaveLength(3);
    expect(saves()).toBe(1);
    expect(res.result).toContain('3');
  });

  it('部分失败仍保存成功项，并逐条列出失败原因', async () => {
    const { h, edits } = harness([
      node('img-a', 'image-gen', '角色A'),
      node('shot-1', 'shot', '镜头 01'),
      node('shot-2', 'shot', '镜头 02'),
    ]);
    const res = await h.call('canvas.connect_many', {
      edges: [
        { from: 'img-a', to: 'shot-1', label: 'ref-image' },
        { from: 'img-a', to: 'shot-2', label: 'sequence' },
      ],
    }, CTX);
    expect(res.ok).toBe(false);
    expect(edits().edges).toHaveLength(1);
    expect(res.result).toContain('1 条成功');
    expect(res.result).toContain('sequence');
  });
});

describe('h3.write_prompt / h3.write_prompts', () => {
  const longPrompt = 'LONG-PROMPT-' + '剧情'.repeat(1200);

  it('单条成功回包只给字数与短摘要，完整提示词仍写回节点', async () => {
    const { h, edits } = harness([node('shot-1', 'shot', '镜头 01')]);
    const res = await h.call('h3.write_prompt', { nodeId: 'shot-1', brief: '推门看到信' }, CTX);
    expect(res.ok).toBe(true);
    expect(res.result).toContain(`${longPrompt.length} 字`);
    expect(res.result).toContain('LONG-PROMPT-');
    expect(res.result.length).toBeLessThan(600);
    expect(res.result).not.toContain('剧情'.repeat(100));
    expect(res.result).toContain('canvas.get_node');
    const saved = edits().nodes.find((n) => n.id === 'shot-1')!;
    expect((saved.data as Record<string, unknown>).prompt).toBe(longPrompt);
  });

  it('一次调用按镜批量写入，结果只回摘要', async () => {
    const { h, edits, saves } = harness([
      node('shot-1', 'shot', '镜头 01'),
      node('shot-2', 'shot', '镜头 02'),
    ]);
    const res = await h.call('h3.write_prompts', {
      shots: [
        { nodeId: 'shot-1', brief: '第一镜' },
        { nodeId: 'shot-2', brief: '第二镜' },
      ],
    }, CTX);
    expect(res.ok).toBe(true);
    expect(res.result).toContain('2 条成功');
    expect(res.result.length).toBeLessThan(800);
    expect(res.result).not.toContain('剧情'.repeat(100));
    expect(saves()).toBe(2);
    for (const id of ['shot-1', 'shot-2']) {
      const saved = edits().nodes.find((n) => n.id === id)!;
      expect((saved.data as Record<string, unknown>).prompt).toBe(longPrompt);
    }
  });
});

describe('canvas.get_node · 默认摘要 / detail=true', () => {
  const longText = '可见动作'.repeat(800);

  it('默认不返回完整 shot prompt，只给长度与摘要', async () => {
    const shot = node('shot-1', 'shot', '镜头 01');
    shot.data = { ...(shot.data as Record<string, unknown>), prompt: longText, seconds: 5, resultPath: '/tmp/a.mp4' };
    const { h } = harness([shot]);
    const res = await h.call('canvas.get_node', { nodeId: 'shot-1' }, CTX);
    expect(res.ok).toBe(true);
    expect(res.result).toContain('prompt');
    expect(res.result).toContain(`${longText.length} 字`);
    expect(res.result.length).toBeLessThan(1200);
    expect(res.result).not.toContain('可见动作'.repeat(100));
    expect(res.result).toContain('/tmp/a.mp4');
  });

  it('detail=true 返回完整 data（长 prompt 可完整读出）', async () => {
    const shot = node('shot-1', 'shot', '镜头 01');
    shot.data = { ...(shot.data as Record<string, unknown>), prompt: longText };
    const { h } = harness([shot]);
    const res = await h.call('canvas.get_node', { nodeId: 'shot-1', detail: true }, CTX);
    expect(res.ok).toBe(true);
    expect(res.result).toContain(longText);
  });

  it('document 默认摘要给行数/字符数与短预览，不改 markdown 本体', async () => {
    const doc = node('doc-1', 'document', '长剧本');
    doc.data = { markdown: `# 标题\n\n${longText}` };
    const { h, edits } = harness([doc]);
    const res = await h.call('canvas.get_node', { nodeId: 'doc-1' }, CTX);
    expect(res.result).toContain('markdown');
    expect(res.result).toContain('字');
    expect(res.result.length).toBeLessThan(1200);
    expect(res.result).not.toContain('可见动作'.repeat(100));
    expect((edits().nodes[0]!.data as Record<string, unknown>).markdown).toContain(longText);
  });
});

describe('document.read · 行范围', () => {
  const doc = () => {
    const d = node('doc-1', 'document', '分镜文档');
    d.data = { markdown: Array.from({ length: 12 }, (_, i) => `L${i + 1} 内容`).join('\n') };
    return d;
  };

  it('startLine/endLine 只返回指定行，不返回前后文', async () => {
    const { h } = harness([doc()]);
    const res = await h.call('document.read', { nodeId: 'doc-1', startLine: 3, endLine: 5 }, CTX);
    expect(res.ok).toBe(true);
    expect(res.result).toContain('L3 内容');
    expect(res.result).toContain('L5 内容');
    expect(res.result).not.toContain('L2 内容');
    expect(res.result).not.toContain('L6 内容');
    expect(res.result).toContain('行 3–5');
  });

  it('非法范围明确拒绝，不静默读全文', async () => {
    const { h } = harness([doc()]);
    const bad = await h.call('document.read', { nodeId: 'doc-1', startLine: 8, endLine: 3 }, CTX);
    expect(bad.ok).toBe(false);
    expect(bad.result).toContain('startLine');
    expect(bad.result).toContain('endLine');
    const beyond = await h.call('document.read', { nodeId: 'doc-1', startLine: 1, endLine: 99 }, CTX);
    expect(beyond.ok).toBe(false);
    expect(beyond.result).toContain('12');
  });
});
