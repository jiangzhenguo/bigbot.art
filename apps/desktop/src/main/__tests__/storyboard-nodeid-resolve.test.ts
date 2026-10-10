/**
 * storyboard.materialize / plan 的 nodeId 解析与报错单测(2026-10-09 「测试2」事故)
 *
 * 事故:Agent 调用 materialize 时传了一个**幻觉 id** `storyboard-1791532265048-7l8p`
 * —— 画布上根本没有这个节点(真实的是 `storyboard-1791533549516-ja9m`)。
 * 它是把「项目简报 document 的创建时间戳」和「storyboard 前缀」拼出来的。
 * 旧实现在 tool-handlers.ts 是裸 `find(n => n.id === nodeId)`,只回一句
 * 「节点 xxx 不是分镜表(storyboard)节点」:不说画布上有哪些分镜表,模型下一轮只能继续猜。
 *
 * 本文件锁三件事:
 *   ① **标题容错**:模型把标题当 id 传时能救回(与 canvas.get_node 等入口同口径);
 *   ② **失败给候选**:id 不存在时,报错必须列出画布上真实的分镜表节点;
 *   ③ **传错类型说清楚**:传了 document 的 id 时,要说明它是什么并指出真正的分镜表。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ⚠️ 先于任何主进程模块加载:数据目录指向临时 HOME,绝不触碰真实用户数据(R5)
const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-sb-resolve-'));
process.env.BIGBOTART_HOME = tmpHome;

const PROJECT = 'p-sb-resolve';
const CANVAS = 'c-sb-resolve';

const MARKDOWN = [
  '# 标准镜头表',
  '',
  '| 镜号 | 画面描述 | 对白/旁白 | 景别 | 运镜 | 时长(s) | 需配图 |',
  '|---|---|---|---|---|---|---|',
  '| 1 | 机翼上两人对峙 | 无 | 远景 | 航拍侧移 | 5 | 否 |',
].join('\n');

let ToolHandlers: typeof import('../tool-handlers.js').ToolHandlers;

/** 画布:一个 document + 一个真实分镜表(标题「云端决斗 · 标准镜头表」)+ 另一个同名干扰项 */
function makeStore(withTwoStoryboards = false) {
  const nodes: Array<Record<string, unknown>> = [
    {
      id: 'document-1791532265048-jzyj',
      kind: 'document',
      label: '云端决斗 · 项目简报',
      position: { x: 0, y: 0 },
      data: { markdown: '# 简报\n内容' },
    },
    {
      id: 'storyboard-1791533549516-ja9m',
      kind: 'storyboard',
      label: '云端决斗 · 标准镜头表',
      position: { x: 60, y: 80 },
      data: { markdown: MARKDOWN, aspect: '16:9', tier: 'preview' },
    },
  ];
  if (withTwoStoryboards) {
    nodes.push({
      id: 'storyboard-1791539999999-zzzz',
      kind: 'storyboard',
      label: '云端决斗 · 标准镜头表', // 与上面同名 → 标题解析应判歧义
      position: { x: 600, y: 80 },
      data: { markdown: MARKDOWN, aspect: '16:9', tier: 'preview' },
    });
  }
  const snapshot = {
    id: CANVAS,
    name: '主画布',
    version: 1,
    nodes,
    edges: [],
    groups: [],
    updatedAt: new Date().toISOString(),
  };
  return {
    loadProjectCanvases: () => ({ projectId: PROJECT, canvases: [snapshot] }),
    saveCanvasSnapshot: () => ({ ok: true }),
    __snapshot: snapshot,
  } as unknown as import('../store.js').ProjectStore & { __snapshot: typeof snapshot };
}

function makeHandlers(store: import('../store.js').ProjectStore) {
  return new ToolHandlers(
    store,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {},
  );
}

const ctx = { projectId: PROJECT, canvasId: CANVAS };

beforeAll(async () => {
  ToolHandlers = (await import('../tool-handlers.js')).ToolHandlers;
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

async function runMaterialize(nodeId: string, withTwo = false) {
  const store = makeStore(withTwo);
  const h = makeHandlers(store);
  const res = await h.call('storyboard.materialize', { nodeId, aspect: '16:9', tier: 'preview' }, ctx);
  return { res, snapshot: store.__snapshot };
}

describe('materialize · id 不存在时给出候选(事故核心)', () => {
  it('幻觉 id → 报错里必须列出画布上真实的分镜表 id', async () => {
    // 事故原样:这个 id 在画布上不存在
    const { res } = await runMaterialize('storyboard-1791532265048-7l8p');
    expect(res.ok).toBe(false);
    expect(res.result).toContain('不存在');
    // 关键:把真实分镜表端出来,模型下一轮就有据可依,不必继续猜
    expect(res.result).toContain('storyboard-1791533549516-ja9m');
    expect(res.result).toContain('云端决斗 · 标准镜头表');
  });

  it('报错指引「先 canvas.list_nodes 现拉 id」', async () => {
    const { res } = await runMaterialize('storyboard-does-not-exist');
    expect(res.result).toContain('canvas.list_nodes');
    expect(res.result).toContain('不要凭记忆拼 id');
  });

  it('画布上没有分镜表时,提示先用 storyboard.plan 生成', async () => {
    // 用一个只有 document 的画布
    const store = makeStore();
    (store.__snapshot as { nodes: unknown[] }).nodes = [
      { id: 'document-1', kind: 'document', label: '简报', position: { x: 0, y: 0 }, data: { markdown: 'x' } },
    ];
    const h = makeHandlers(store);
    const res = await h.call('storyboard.materialize', { nodeId: 'storyboard-x' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('storyboard.plan');
  });
});

describe('materialize · 标题容错(与 canvas.get_node 同口径)', () => {
  it('传标题(不是 id)也能铺节点 —— 旧实现在这里也会失败', async () => {
    const { res, snapshot } = await runMaterialize('云端决斗 · 标准镜头表');
    expect(res.ok).toBe(true);
    const shots = (snapshot.nodes as Array<{ kind: string }>).filter((n) => n.kind === 'shot');
    expect(shots.length).toBe(1); // 表格 1 行 → 1 个 shot
  });

  it('标题去空白后唯一即可命中(容忍排版差异)', async () => {
    const { res } = await runMaterialize('云端决斗·标准镜头表');
    expect(res.ok).toBe(true);
  });

  it('同名标题(歧义)→ 报错并列候选 id,不猜', async () => {
    const { res } = await runMaterialize('云端决斗 · 标准镜头表', true);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('匹配到多个节点');
    expect(res.result).toContain('storyboard-1791533549516-ja9m');
    expect(res.result).toContain('storyboard-1791539999999-zzzz');
  });
});

describe('materialize · 传了非分镜表节点要说清楚', () => {
  it('传 document 的 id → 说明它是什么,并指出真正的分镜表', async () => {
    const { res } = await runMaterialize('document-1791532265048-jzyj');
    expect(res.ok).toBe(false);
    expect(res.result).toContain('document');
    expect(res.result).toContain('不是分镜表');
    expect(res.result).toContain('storyboard-1791533549516-ja9m'); // 给出正确去处
  });
});

describe('storyboard.plan · nodeId 也走解析(修复前是裸 find)', () => {
  it('传标题也能读到 document 的 markdown(旧实现会误报「需要 brief 文本」)', async () => {
    const store = makeStore();
    const h = makeHandlers(store);
    const res = await h.call('storyboard.plan', { nodeId: '云端决斗 · 项目简报' }, ctx);
    /* 没注入 planStoryboard 时会走到「服务未注入」——但**必须先成功解析到 brief**。
       修复前是裸 find(id)，传标题查不到 → 静默落到「需要 brief 文本」;
       这条断言锁的正是「标题被正确解析成本轮的 brief 来源」。 */
    expect(res.result).not.toContain('需要 brief 文本');
    expect(res.result).toContain('分镜表规划服务未注入');
  });

  it('nodeId 不存在 → 明确报错(不再静默变成「没给 brief」)', async () => {
    const store = makeStore();
    const h = makeHandlers(store);
    const res = await h.call('storyboard.plan', { nodeId: 'document-does-not-exist' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.result).toContain('不存在');
  });
});

describe('materialize · 正常路径不受影响', () => {
  it('传真实 id → 成功铺出节点', async () => {
    const { res, snapshot } = await runMaterialize('storyboard-1791533549516-ja9m');
    expect(res.ok).toBe(true);
    // materialize 不回传 nodeId(只有 storyboard.plan 回传),这里锁的是「真的铺出来了」
    expect(res.result).toContain('已从分镜表铺出');
    const shots = (snapshot.nodes as Array<{ kind: string }>).filter((n) => n.kind === 'shot');
    expect(shots.length).toBe(1);
  });
});
