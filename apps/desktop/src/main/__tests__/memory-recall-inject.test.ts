/**
 * MemoryStore recall 注入窗口单测(主进程 memory.ts)
 * 真实事故:用户指令「编辑图片让女孩站立」经一轮 ask.user 往返后即掉出上下文 ——
 * 一轮「操作前必查」的工具调用(list_nodes + get_node×N)以 tool+system 双记录刷爆 12 条注入窗口。
 * 修复:
 *  1. recentRecall 窗口只数 user/assistant/system,tool 留痕记录不占窗口
 *  2. 连续重复的系统动作记录合并为「… ×N」
 *  3. 任务链首条用户指令(非 ask.user 应答)钉入 systemPrompt,掉出窗口也兜底
 *
 * 关键:memory.ts 的 DATA_DIR 在 import 时按 BIGBOTART_HOME 求值 →
 * 模块顶层先设临时目录,再在 beforeAll 里动态 import(绝不触碰真实 ~/.bigbotart)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-recall-inject-test-'));
process.env.BIGBOTART_HOME = tmpHome;

let M: typeof import('../memory.js');
let store: import('../memory.js').MemoryStore;

beforeAll(async () => {
  M = await import('../memory.js');
  store = new M.MemoryStore();
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

let seq = 0;
const pid = () => `p-inject-${Date.now()}-${seq++}`;

/** 造一条工具调用留痕(tool)+ 成功动作记录(system),与 agent-chat 写 recall 同口径 */
function addToolPair(p: string, canvasId: string, toolName: string, systemContent: string) {
  store.addRecall(p, { canvasId, role: 'tool', content: `${toolName}({})`, toolName });
  store.addRecall(p, { canvasId, role: 'system', content: systemContent });
}

describe('recentRecall 窗口只数可注入角色(修复 1)', () => {
  it('工具噪音刷爆原始窗口时,用户指令仍在注入消息里', () => {
    const p = pid();
    store.addRecall(p, { canvasId: 'cA', role: 'user', content: '编辑图片让女孩站立' });
    // 模拟一轮必查:list_nodes + get_node×5(各占 tool+system 两条,共 12 条原始记录)
    addToolPair(p, 'cA', 'canvas.list_nodes', '已执行 canvas.list_nodes');
    for (let i = 0; i < 5; i++) addToolPair(p, 'cA', 'canvas.get_node', '已执行 canvas.get_node');
    store.addRecall(p, {
      canvasId: 'cA', role: 'tool', content: 'ask.user(按哪种方案执行?)', toolName: 'ask.user',
    });
    store.addRecall(p, { canvasId: 'cA', role: 'user', content: '用 image-edit 编辑现有图' });

    const ctx = store.buildContext(p, 'cA', '用 image-edit 编辑现有图');
    const users = ctx.messages.filter((m) => m.role === 'user').map((m) => m.content);
    expect(users).toContain('编辑图片让女孩站立');
    expect(users).toContain('用 image-edit 编辑现有图');
    // tool 记录不进入注入消息
    expect(ctx.messages.every((m) => !m.content.startsWith('canvas.get_node('))).toBe(true);
  });

  it('recentRecall 返回值不含 tool 记录', () => {
    const p = pid();
    store.addRecall(p, { canvasId: 'cA', role: 'user', content: '指令' });
    addToolPair(p, 'cA', 'canvas.list_nodes', '已执行 canvas.list_nodes');
    const recent = store.recentRecall(p, 'cA');
    expect(recent.every((r) => r.role !== 'tool')).toBe(true);
    expect(recent.map((r) => r.role)).toEqual(['user', 'system']);
  });
});

describe('连续重复系统记录合并(修复 2)', () => {
  it('「已执行 canvas.get_node」×5 合并为一条 ×5', () => {
    const p = pid();
    store.addRecall(p, { canvasId: 'cA', role: 'user', content: '指令' });
    for (let i = 0; i < 5; i++) store.addRecall(p, { canvasId: 'cA', role: 'system', content: '已执行 canvas.get_node' });
    store.addRecall(p, { canvasId: 'cA', role: 'system', content: '已执行 canvas.list_nodes' });

    const ctx = store.buildContext(p, 'cA', '继续');
    const sys = ctx.messages.filter((m) => m.role === 'system').map((m) => m.content);
    expect(sys).toEqual(['已执行 canvas.get_node ×5', '已执行 canvas.list_nodes']);
  });

  it('不相邻的相同记录不合并;非 system 角色不合并', () => {
    const p = pid();
    store.addRecall(p, { canvasId: 'cA', role: 'system', content: '已执行 A' });
    store.addRecall(p, { canvasId: 'cA', role: 'user', content: '已执行 A' }); // 同文但 user 角色,不合并
    store.addRecall(p, { canvasId: 'cA', role: 'system', content: '已执行 A' });

    const ctx = store.buildContext(p, 'cA', '继续');
    expect(ctx.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      'system:已执行 A',
      'user:已执行 A',
      'system:已执行 A',
    ]);
  });
});

describe('选中节点规则(system prompt)', () => {
  it('buildContext 的 systemPrompt 含【选中节点】规则(默认操作对象 + 禁止绕道 assets.import)', () => {
    const p = pid();
    const ctx = store.buildContext(p, 'cA', '编辑这个图片');
    expect(ctx.systemPrompt).toContain('【选中节点】');
    expect(ctx.systemPrompt).toContain('禁止绕道 assets.import');
  });
});

describe('pinnedInstruction 任务链首条指令(修复 3)', () => {
  it('ask.user 应答不算新指令,钉住的仍是最初指令', () => {
    const p = pid();
    store.addRecall(p, { canvasId: 'cA', role: 'user', content: '编辑图片让女孩站立' });
    store.addRecall(p, { canvasId: 'cA', role: 'tool', content: 'ask.user(...)', toolName: 'ask.user' });
    store.addRecall(p, { canvasId: 'cA', role: 'user', content: '用 image-edit 编辑现有图' });
    store.addRecall(p, { canvasId: 'cA', role: 'tool', content: 'ask.user(...)', toolName: 'ask.user' });
    store.addRecall(p, { canvasId: 'cA', role: 'user', content: '我自己给 prompt' });

    expect(store.pinnedInstruction(p, 'cA')).toBe('编辑图片让女孩站立');
  });

  it('新指令(前面不是 ask.user 记录)替换钉住目标', () => {
    const p = pid();
    store.addRecall(p, { canvasId: 'cA', role: 'user', content: '旧任务' });
    store.addRecall(p, { canvasId: 'cA', role: 'assistant', content: '已完成' });
    store.addRecall(p, { canvasId: 'cA', role: 'user', content: '新任务' });

    expect(store.pinnedInstruction(p, 'cA')).toBe('新任务');
  });

  it('空画布 / 无用户消息时返回 undefined', () => {
    const p = pid();
    expect(store.pinnedInstruction(p, 'cA')).toBeUndefined();
    store.addRecall(p, { canvasId: 'cA', role: 'system', content: '已执行 canvas.list_nodes' });
    expect(store.pinnedInstruction(p, 'cA')).toBeUndefined();
  });

  it('buildContext:指令掉出窗口时注入【进行中的任务】,在窗口内则不重复', () => {
    const p = pid();
    store.addRecall(p, { canvasId: 'cA', role: 'user', content: '编辑图片让女孩站立' });
    // 在窗口内:不重复注入
    let ctx = store.buildContext(p, 'cA', '继续');
    expect(ctx.systemPrompt).not.toContain('【进行中的任务】');

    // 用 12+ 条非重复 system 记录把指令挤出窗口(每条内容不同,不会被合并)
    for (let i = 0; i < 13; i++) {
      store.addRecall(p, { canvasId: 'cA', role: 'system', content: `已执行 canvas.get_node 第${i}次` });
    }
    ctx = store.buildContext(p, 'cA', '继续');
    expect(ctx.messages.some((m) => m.content === '编辑图片让女孩站立')).toBe(false);
    expect(ctx.systemPrompt).toContain('【进行中的任务】');
    expect(ctx.systemPrompt).toContain('编辑图片让女孩站立');
  });
});

describe('按 token 预算装历史', () => {
  it('预算够时旧指令留在消息里;预算紧时丢掉并钉进系统提示', () => {
    const p = pid();
    store.addRecall(p, { canvasId: 'cA', role: 'user', content: '甲'.repeat(6_000) });
    store.addRecall(p, { canvasId: 'cA', role: 'assistant', content: '最新回复' });

    const wide = store.buildContext(p, 'cA', '继续', undefined, undefined, { historyTokenBudget: 80_000 });
    expect(wide.messages.some((m) => m.content.startsWith('甲'))).toBe(true);
    expect(wide.systemPrompt).not.toContain('【进行中的任务】');

    const tight = store.buildContext(p, 'cA', '继续', undefined, undefined, { historyTokenBudget: 2_000 });
    expect(tight.messages.some((m) => m.content === '最新回复')).toBe(true);
    expect(tight.messages.some((m) => m.content.startsWith('甲甲'))).toBe(false);
    expect(tight.systemPrompt).toContain('【进行中的任务】');
    expect(tight.systemPrompt).toContain('甲'.repeat(20));
  });

  it('超过压缩线时折掉旧记录,摘要进下一轮系统提示', () => {
    const p = pid();
    store.addRecall(p, { canvasId: 'cA', role: 'user', content: '最初要画一只猫' });
    for (let i = 0; i < 8; i++) {
      store.addRecall(p, { canvasId: 'cA', role: 'assistant', content: `第${i}轮很长的回复`.repeat(80) });
    }
    const res = store.autoCompact(p, 'cA', 200);
    expect(res.compacted).toBe(true);
    expect(res.replaced).toBeGreaterThan(0);
    const ctx = store.buildContext(p, 'cA', '继续', undefined, undefined, { historyTokenBudget: 80_000 });
    expect(ctx.systemPrompt).toContain('【对话自动摘要】');
    expect(ctx.systemPrompt).toContain('最初要画一只猫');
  });
});
