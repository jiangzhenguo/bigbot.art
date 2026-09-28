/**
 * canvas.update_node 集成单测 — 「假成功」回归防护
 *
 * 真实事故(2026-09-28 主画布对话):
 *   模型调 canvas.update_node 时把 data **序列化成了 JSON 字符串**:
 *     {"nodeId":"new9-nhz9","data":"{\"prompt\": \"# Camera 运镜\\n..."}
 *   旧实现 `typeof a.data === 'object'` 对字符串为 false → 整段 patch 被静默跳过,
 *   却仍然返回「✓ 已更新节点「镜头（视频）」」。模型以为写好了,继续 engine.submit,
 *   最后 h3 报 `h3: prompt must not be empty`(节点 prompt 长度实际为 0)。
 *
 * 本组用例锁死三件事:
 *   ① 字符串化 data 必须被解析并**真的写进节点**;
 *   ② 非法 data 必须**明确报错**,不允许返回成功;
 *   ③ 合法对象照常工作(不回归)。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { CanvasNode } from '@bigbotart/shared';

const PROJECT = 'proj-test';
const CANVAS = 'cv-test';

let ToolHandlers: typeof import('../tool-handlers.js').ToolHandlers;

interface Snap {
  projectId: string;
  canvases: Array<{
    id: string;
    nodes: CanvasNode[];
    edges: unknown[];
    groups: unknown[];
    version: number;
    updatedAt: string;
  }>;
}

/** 最小 store stub:一张画布 + 一个 shot 节点 */
function makeStore(nodes: CanvasNode[]): { store: unknown; snapshot: Snap } {
  const snapshot: Snap = {
    projectId: PROJECT,
    canvases: [
      { id: CANVAS, nodes, edges: [], groups: [], version: 1, updatedAt: new Date().toISOString() },
    ],
  };
  return {
    snapshot,
    store: {
      loadProjectCanvases: () => ({ projectId: PROJECT, canvases: snapshot.canvases }),
      saveCanvasSnapshot: () => ({ ok: true }),
    },
  };
}

const shot = (id: string, label: string, prompt = ''): CanvasNode =>
  ({ id, kind: 'shot', label, position: { x: 0, y: 0 }, data: { engine: 'h3c', prompt } }) as unknown as CanvasNode;

function handlersWith(nodes: CanvasNode[]) {
  const { store, snapshot } = makeStore(nodes);
  const h = new ToolHandlers(store as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  return { h, snapshot };
}

/** 调用工具(handler 表是私有的,走公开的 call 入口) */
async function call(h: InstanceType<typeof ToolHandlers>, tool: string, args: Record<string, unknown>) {
  return h.call(tool, args, { projectId: PROJECT, canvasId: CANVAS });
}

beforeAll(async () => {
  ToolHandlers = (await import('../tool-handlers.js')).ToolHandlers;
});

describe('canvas.update_node — 字符串化 data(事故现场形态)', () => {
  it('data 传 JSON 字符串 → prompt 真的落进节点(修复前这里静默跳过)', async () => {
    const { h, snapshot } = handlersWith([shot('new9-nhz9', '镜头（视频）')]);
    const payload = JSON.stringify({ prompt: '# Camera 运镜\nStatic medium shot, gently pushing in.' });
    const res = await call(h, 'canvas.update_node', { nodeId: 'new9-nhz9', data: payload });
    expect(res.ok).toBe(true);
    const node = snapshot.canvases[0]!.nodes[0]!;
    expect(String((node.data as { prompt?: string }).prompt)).toContain('Static medium shot');
    expect(String((node.data as { prompt?: string }).prompt).length).toBeGreaterThan(0);
  });

  it('标题当 nodeId 也能写入(与标题容错叠加)', async () => {
    const { h, snapshot } = handlersWith([shot('shot-real-id', '镜头 03')]);
    const res = await call(h, 'canvas.update_node', {
      nodeId: '镜头 03',
      data: JSON.stringify({ prompt: '风景' }),
    });
    expect(res.ok).toBe(true);
    expect(String((snapshot.canvases[0]!.nodes[0]!.data as { prompt?: string }).prompt)).toBe('风景');
  });

  it('data 是坏 JSON → 明确报错,且节点**未被修改**(绝不假成功)', async () => {
    const { h, snapshot } = handlersWith([shot('n1', '镜头', '原有提示词')]);
    const res = await call(h, 'canvas.update_node', { nodeId: 'n1', data: '{"prompt": 没引号}' });
    expect(res.ok).toBe(false);
    expect(res.result).toContain('不是合法 JSON');
    // 关键:失败时不能留下半成品
    expect(String((snapshot.canvases[0]!.nodes[0]!.data as { prompt?: string }).prompt)).toBe('原有提示词');
  });

  it('data 是数组 → 报错(不把数组当对象)', async () => {
    const { h } = handlersWith([shot('n1', '镜头')]);
    const res = await call(h, 'canvas.update_node', { nodeId: 'n1', data: '[1,2]' });
    expect(res.ok).toBe(false);
  });

  it('data 是数字 → 报错', async () => {
    const { h } = handlersWith([shot('n1', '镜头')]);
    const res = await call(h, 'canvas.update_node', { nodeId: 'n1', data: 42 });
    expect(res.ok).toBe(false);
  });
});

describe('canvas.update_node — 顶层 prompt 参数(B 方案:长文本走独立字符串)', () => {
  it('顶层 prompt 直接写入 data.prompt(不经 data 对象,规避序列化)', () => {
    const { h, snapshot } = handlersWith([shot('n1', '镜头（视频）')]);
    const long = '# 场景\n中式庭院,深色木质雕花门…\n\n# 动作\n人物站立,双手交叠…';
    return call(h, 'canvas.update_node', { nodeId: 'n1', prompt: long }).then((res) => {
      expect(res.ok).toBe(true);
      expect(String((snapshot.canvases[0]!.nodes[0]!.data as { prompt?: string }).prompt)).toBe(long);
    });
  });

  it('顶层 prompt 与 data.prompt 同时给 → 顶层优先', () => {
    const { h, snapshot } = handlersWith([shot('n1', '镜头')]);
    return call(h, 'canvas.update_node', {
      nodeId: 'n1',
      prompt: '顶层内容',
      data: { prompt: 'data 内容', width: 544 },
    }).then((res) => {
      expect(res.ok).toBe(true);
      const d = snapshot.canvases[0]!.nodes[0]!.data as { prompt?: string; width?: number };
      expect(d.prompt).toBe('顶层内容');
      expect(d.width).toBe(544); // data 里的其他字段照常合并
    });
  });

  it('只给顶层 prompt、不给 data 也能写(最小调用)', () => {
    const { h, snapshot } = handlersWith([shot('n1', '镜头')]);
    return call(h, 'canvas.update_node', { nodeId: 'n1', prompt: 'hi' }).then((res) => {
      expect(res.ok).toBe(true);
      expect((snapshot.canvases[0]!.nodes[0]!.data as { prompt?: string }).prompt).toBe('hi');
    });
  });

  it('顶层 prompt 传非字符串 → 明确报错(不静默)', () => {
    const { h } = handlersWith([shot('n1', '镜头')]);
    return call(h, 'canvas.update_node', { nodeId: 'n1', prompt: { a: 1 } }).then((res) => {
      expect(res.ok).toBe(false);
      expect(res.result).toContain('prompt 必须是字符串');
    });
  });

  it('顶层 prompt 支持多行与特殊字符(真实提示词形态)', () => {
    const { h, snapshot } = handlersWith([shot('n1', '镜头')]);
    const md = '# Camera 运镜\nStatic medium shot, gently pushing in.\n\n含"引号"与\\反斜杠';
    return call(h, 'canvas.update_node', { nodeId: 'n1', prompt: md }).then((res) => {
      expect(res.ok).toBe(true);
      expect((snapshot.canvases[0]!.nodes[0]!.data as { prompt?: string }).prompt).toBe(md);
    });
  });

  it('旧的 data.prompt 写法仍然有效(向后兼容)', () => {
    const { h, snapshot } = handlersWith([shot('n1', '镜头')]);
    return call(h, 'canvas.update_node', { nodeId: 'n1', data: { prompt: '旧写法' } }).then((res) => {
      expect(res.ok).toBe(true);
      expect((snapshot.canvases[0]!.nodes[0]!.data as { prompt?: string }).prompt).toBe('旧写法');
    });
  });

  it('标题当 nodeId + 顶层 prompt 也能写(与容错叠加)', () => {
    const { h, snapshot } = handlersWith([shot('real-id', '镜头 03')]);
    return call(h, 'canvas.update_node', { nodeId: '镜头 03', prompt: 'x' }).then((res) => {
      expect(res.ok).toBe(true);
      expect((snapshot.canvases[0]!.nodes[0]!.data as { prompt?: string }).prompt).toBe('x');
    });
  });
});

describe('canvas.update_node — 正常对象路径(不回归)', () => {
  it('对象 data 合并进现有字段(未提及的键保留)', async () => {
    const { h, snapshot } = handlersWith([shot('n1', '镜头', 'old')]);
    const res = await call(h, 'canvas.update_node', { nodeId: 'n1', data: { prompt: 'new', width: 544 } });
    expect(res.ok).toBe(true);
    const d = snapshot.canvases[0]!.nodes[0]!.data as { prompt?: string; width?: number; engine?: string };
    expect(d.prompt).toBe('new');
    expect(d.width).toBe(544);
    expect(d.engine).toBe('h3c'); // 原有字段保留
  });

  it('只改 label 不传 data 也能成功', async () => {
    const { h, snapshot } = handlersWith([shot('n1', '旧标题')]);
    const res = await call(h, 'canvas.update_node', { nodeId: 'n1', label: '新标题' });
    expect(res.ok).toBe(true);
    expect(snapshot.canvases[0]!.nodes[0]!.label).toBe('新标题');
  });

  it('直写 refs 仍被忽略并给出说明(refs 由连线推导,既有约定不破)', async () => {
    const { h, snapshot } = handlersWith([shot('n1', '镜头')]);
    const res = await call(h, 'canvas.update_node', { nodeId: 'n1', data: { refs: [{ role: 'ref-image' }] } });
    expect(res.ok).toBe(true);
    expect(res.result).toContain('refs 由连线推导已忽略');
    expect((snapshot.canvases[0]!.nodes[0]!.data as { refs?: unknown }).refs).toBeUndefined();
  });

  it('节点不存在 → 报错', async () => {
    const { h } = handlersWith([shot('n1', '镜头')]);
    const res = await call(h, 'canvas.update_node', { nodeId: 'ghost', data: { prompt: 'x' } });
    expect(res.ok).toBe(false);
    expect(res.result).toContain('不存在');
  });
});
