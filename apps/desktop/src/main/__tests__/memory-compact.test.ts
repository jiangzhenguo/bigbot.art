/**
 * MemoryStore clearConversation / compactConversation 单测(主进程 memory.ts)
 * - /clear:清空画布对话 recall + 对话压缩摘要(节点总结 summary 保留)
 * - /compact:裁剪旧消息为摘要(保留最近 keepLast 条),摘要合并进 conversationSummary
 * - buildContext:压缩摘要以「本画布对话摘要(已压缩)」注入
 *
 * 关键:memory.ts 的 DATA_DIR 在 import 时按 BIGBOTART_HOME 求值 →
 * 模块顶层先设临时目录,再在 beforeAll 里动态 import(绝不触碰真实 ~/.bigbotart)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasNode, CanvasEdge } from '@bigbotart/shared';

const tmpHome = mkdtempSync(join(tmpdir(), 'bbart-memory-test-'));
process.env.BIGBOTART_HOME = tmpHome;

/** 造一条 recall:canvasId + 序号,便于断言裁剪数量 */
function recallMessage(canvasId: string, i: number) {
  return {
    canvasId,
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `消息 ${i} · ${canvasId}`,
  };
}

let M: typeof import('../memory.js');
let store: import('../memory.js').MemoryStore;

beforeAll(async () => {
  M = await import('../memory.js');
  store = new M.MemoryStore();
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('MemoryStore.clearConversation(/clear)', () => {
  it('清空指定画布的 recall,其他画布不受影响', () => {
    const pid = `p-clear-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    for (let i = 1; i <= 5; i++) store.addRecall(pid, recallMessage('cA', i));
    for (let i = 1; i <= 3; i++) store.addRecall(pid, recallMessage('cB', i));

    const res = store.clearConversation(pid, 'cA');
    expect(res.cleared).toBe(5);
    expect(store.get(pid).recall.filter((r) => r.canvasId === 'cA')).toHaveLength(0);
    expect(store.get(pid).recall.filter((r) => r.canvasId === 'cB')).toHaveLength(3);
  });

  it('连同 conversationSummary 一起清除,但节点总结 summary 保留', () => {
    const pid = `p-clear2-${Date.now()}`;
    store.addRecall(pid, recallMessage('cA', 1));
    store.addRecall(pid, recallMessage('cA', 2));
    store.updateCanvasSummary(pid, 'cA', '3 个 shot 节点', 3);
    store.compactConversation(pid, 'cA', '摘要文本', 1);
    const mem = store.get(pid);
    expect(mem.canvasMemory['cA']?.conversationSummary).toBe('摘要文本');

    const res = store.clearConversation(pid, 'cA');
    expect(res.cleared).toBe(1);
    const after = store.get(pid);
    const cA = after.canvasMemory['cA'];
    expect(cA?.conversationSummary).toBeUndefined();
    expect(cA?.summary).toBe('3 个 shot 节点');
  });

  it('空画布清空返回 cleared=0', () => {
    const pid = `p-clear3-${Date.now()}`;
    const res = store.clearConversation(pid, 'cX');
    expect(res.cleared).toBe(0);
  });
});

describe('MemoryStore.compactConversation(/compact)', () => {
  it('只裁剪 keepLast 之后的消息,保留尾部承接上下文', () => {
    const pid = `p-compact-${Date.now()}`;
    for (let i = 1; i <= 12; i++) store.addRecall(pid, recallMessage('cA', i));

    const res = store.compactConversation(pid, 'cA', 'LLM 摘要', 5);
    expect(res.replaced).toBe(7);
    const left = store.get(pid).recall.filter((r) => r.canvasId === 'cA');
    expect(left).toHaveLength(5);
    // 保留的是最新的 5 条(消息 8..12)
    expect(left.at(-1)?.content).toBe('消息 12 · cA');
    expect(left[0]?.content).toBe('消息 8 · cA');
  });

  it('消息数 ≤ keepLast 时不做任何事(replaced=0,不写摘要)', () => {
    const pid = `p-compact2-${Date.now()}`;
    for (let i = 1; i <= 3; i++) store.addRecall(pid, recallMessage('cA', i));
    const res = store.compactConversation(pid, 'cA', '摘要', M.COMPACT_KEEP_LAST);
    expect(res.replaced).toBe(0);
    expect(store.get(pid).recall).toHaveLength(3);
  });

  it('多次 compact 摘要合并(追加而非覆盖)', () => {
    const pid = `p-compact3-${Date.now()}`;
    for (let i = 1; i <= 10; i++) store.addRecall(pid, recallMessage('cA', i));
    store.compactConversation(pid, 'cA', '第一段摘要', 5);
    for (let i = 11; i <= 15; i++) store.addRecall(pid, recallMessage('cA', i));
    store.compactConversation(pid, 'cA', '第二段摘要', 5);

    const cm = store.get(pid).canvasMemory['cA'];
    expect(cm?.conversationSummary).toBe('第一段摘要\n\n第二段摘要');
  });

  it('兜底摘要生成器:LLM 不可达时的确定性折叠', () => {
    const pid = `p-fallback-${Date.now()}`;
    store.addRecall(pid, { canvasId: 'cA', role: 'user', content: '帮我做一支短片' });
    store.addRecall(pid, { canvasId: 'cA', role: 'assistant', content: '好的,先出分镜表' });
    const fb = M.compactFallbackSummary(store.get(pid).recall);
    expect(fb).toContain('用户 帮我做一支短片');
    expect(fb).toContain('助手 好的,先出分镜表');
  });
});

describe('MemoryStore.buildContext 注入压缩摘要', () => {
  it('有 conversationSummary 时以「本画布对话摘要(已压缩)」注入 system prompt', () => {
    const pid = `p-ctx-${Date.now()}`;
    store.addRecall(pid, recallMessage('cA', 1));
    store.addRecall(pid, recallMessage('cA', 2));
    store.updateCanvasSummary(pid, 'cA', '画布节点总结', 2);
    store.compactConversation(pid, 'cA', '对话压缩摘要', 1);

    const ctx = store.buildContext(pid, 'cA', '继续');
    expect(ctx.systemPrompt).toContain('【本画布对话摘要(已压缩)】对话压缩摘要');
    // 当前画布节点总结不注入(只注入 conversationSummary),其他画布的 summary 走既有逻辑
  });
});
describe('MemoryStore 技能激活状态(activeSkillId)', () => {
  it('setActiveSkillId 持久化,getActiveSkillId 可读', () => {
    const pid = `p-skill-${Date.now()}`;
    store.setActiveSkillId(pid, 'cA', 'skill-paper');
    expect(store.getActiveSkillId(pid, 'cA')).toBe('skill-paper');
    // 落盘后重新读取仍保留(跨会话/重启不丢)
    // 2026-09-29 起记忆落在 workspaces/<pid>/memory.json(原 memory-<pid>.json 平铺)
    store.setActiveSkillId(pid, 'cA', 'skill-paper');
    store.get(pid); // 触发缓存读
    expect(JSON.parse(readFileSync(join(tmpHome, 'workspaces', pid, 'memory.json'), 'utf-8')).canvasMemory['cA'].activeSkillId).toBe('skill-paper');
  });

  it('deactivate(传 null)清除激活,其他画布不受影响', () => {
    const pid = `p-skill2-${Date.now()}`;
    store.setActiveSkillId(pid, 'cA', 'skill-a');
    store.setActiveSkillId(pid, 'cB', 'skill-b');
    store.setActiveSkillId(pid, 'cA', null);
    expect(store.getActiveSkillId(pid, 'cA')).toBeUndefined();
    expect(store.getActiveSkillId(pid, 'cB')).toBe('skill-b');
  });

  it('compactConversation 保留激活技能(压缩不清技能)', () => {
    const pid = `p-skill3-${Date.now()}`;
    store.updateCanvasSummary(pid, 'cA', 's', 1);
    store.setActiveSkillId(pid, 'cA', 'skill-paper');
    for (let i = 1; i <= 10; i++) store.addRecall(pid, recallMessage('cA', i));
    store.compactConversation(pid, 'cA', '摘要', 5);
    expect(store.getActiveSkillId(pid, 'cA')).toBe('skill-paper');
  });

  it('clearConversation 不丢激活技能', () => {
    const pid = `p-skill4-${Date.now()}`;
    store.setActiveSkillId(pid, 'cA', 'skill-paper');
    for (let i = 1; i <= 3; i++) store.addRecall(pid, recallMessage('cA', i));
    store.clearConversation(pid, 'cA');
    expect(store.getActiveSkillId(pid, 'cA')).toBe('skill-paper');
  });
});

describe('MemoryStore.buildContext 注入激活技能指令(@当前技能」段)', () => {
  const skillResolver = (id: string) =>
    ({
      'skill-paper': { name: '纸拼贴剧情片', instructions: '操作指令全文:先 storyboard.plan,再 materialize,提交前 ask.user 确认档位。', inject: 'full' as const },
      'skill-paper-summary': { name: '纸拼贴(摘要)', instructions: '这是一段用于验证 summary 截断的操作指令正文,包含完整的执行步骤说明:先读取需求文档,再规划分镜表,逐行材质化铺节点,提交前询问用户档位,生成后检查产物并导出时间线。这段文字故意写得比较长,以确保超过一百六十字符的摘要截断边界——本尾部句子的作用是验证 summary 模式只注入头部摘要、不携带全文尾部,此句必须出现在截断边界之后才不会误入上下文。', inject: 'summary' as const },
      'skill-empty': { name: '仅模板', instructions: undefined, inject: undefined },
    })[id] ?? undefined;

  it('激活技能(full)→ systemPrompt 注入【当前技能】与指令全文', () => {
    const pid = `p-skill-ctx-${Date.now()}`;
    store.setActiveSkillId(pid, 'cA', 'skill-paper');
    const ctx = store.buildContext(pid, 'cA', '继续', skillResolver);
    expect(ctx.systemPrompt).toContain('【当前技能】纸拼贴剧情片 的操作指令');
    expect(ctx.systemPrompt).toContain('先 storyboard.plan');
    expect(ctx.systemPrompt).toContain('提交前 ask.user 确认档位');
  });

  it('未激活技能 → 不注入任何【当前技能】段(零开销)', () => {
    const pid = `p-skill-ctx2-${Date.now()}`;
    store.updateCanvasSummary(pid, 'cA', 's', 1);
    const ctx = store.buildContext(pid, 'cA', '继续', skillResolver);
    expect(ctx.systemPrompt).not.toContain('【当前技能】');
  });

  it('summary 模式 → 只放头部摘要 + skills.read 提示', () => {
    const pid = `p-skill-ctx3-${Date.now()}`;
    store.setActiveSkillId(pid, 'cA', 'skill-paper-summary');
    const ctx = store.buildContext(pid, 'cA', '继续', skillResolver);
    expect(ctx.systemPrompt).toContain('【当前技能】纸拼贴(摘要)(summary 模式');
    expect(ctx.systemPrompt).toContain('skills.read(skillId="skill-paper-summary")');
    // 截断生效:不携带全文尾部那句(超过 160 字符截断);摘要含头部
    expect(ctx.systemPrompt).not.toContain('此句必须出现在截断边界之后');
    expect(ctx.systemPrompt).toContain('这是一段用于验证 summary 截断的操作指令正文');
  });

  it('激活的技能已被删除(resolve 返回 undefined)→ 安全跳过,不注入', () => {
    const pid = `p-skill-ctx4-${Date.now()}`;
    store.setActiveSkillId(pid, 'cA', 'skill-gone');
    const ctx = store.buildContext(pid, 'cA', '继续', skillResolver);
    expect(ctx.systemPrompt).not.toContain('【当前技能】');
    expect(ctx.systemPrompt).not.toContain('skill-gone');
  });

  it('激活无指令段的技能 → 注入模板提示,不注入指令', () => {
    const pid = `p-skill-ctx5-${Date.now()}`;
    store.setActiveSkillId(pid, 'cA', 'skill-empty');
    const ctx = store.buildContext(pid, 'cA', '继续', skillResolver);
    expect(ctx.systemPrompt).toContain('【当前技能】仅模板 · 画布模板已激活');
  });
});

describe('MemoryStore.buildContext · system 动作记录与当前画布状态注入', () => {
  /** 测试节点(data 与本用例无关,用 never 塞空) */
  function node(kind: CanvasNode['kind'], id: string, label: string): CanvasNode {
    return { id, kind, position: { x: 0, y: 0 }, label, data: {} as never, createdAt: '', updatedAt: '' };
  }

  it('system 角色的 recall → buildContext messages 原样注入(下一轮感知画布变化)', () => {
    const pid = `p-sys-ctx-${Date.now()}`;
    store.addRecall(pid, { canvasId: 'cA', role: 'user', content: '帮我做短片' });
    store.addRecall(pid, { canvasId: 'cA', role: 'assistant', content: '先出分镜表' });
    store.addRecall(pid, { canvasId: 'cA', role: 'system', content: '已创建节点 shot-abc · shot「镜头 1」' });
    const ctx = store.buildContext(pid, 'cA', '继续');
    const sysMsg = ctx.messages.find((m) => m.role === 'system');
    expect(sysMsg?.content).toBe('已创建节点 shot-abc · shot「镜头 1」');
  });

  it('tool 角色的 recall 不注入 messages(仅 user/assistant/system 注入)', () => {
    const pid = `p-sys-ctx2-${Date.now()}`;
    store.addRecall(pid, {
      canvasId: 'cA', role: 'tool', content: 'canvas.create_node({...})', toolName: 'canvas.create_node',
    });
    store.addRecall(pid, { canvasId: 'cA', role: 'user', content: '继续' });
    const ctx = store.buildContext(pid, 'cA', '继续');
    expect(ctx.messages.map((m) => m.role)).toEqual(['user']);
  });

  it('canvasStateSummary:kind 统计 + 关键连线(first-frame/prompt)注入 systemPrompt', () => {
    const doc = node('document', 'doc-1', 'Brief');
    const sb = node('storyboard', 'sb-1', '分镜表-01');
    const shot1 = node('shot', 'shot-1', '镜头 1');
    const shot2 = node('shot', 'shot-2', '镜头 2');
    const edges: CanvasEdge[] = [
      { id: 'e1', source: 'doc-1', target: 'shot-1', label: 'prompt' },
      { id: 'e2', source: 'shot-1', target: 'shot-2', label: 'first-frame' },
    ];
    const summary = M.MemoryStore.canvasStateSummary({ name: '主画布', nodes: [doc, sb, shot1, shot2], edges });
    expect(summary).toContain('「主画布」· 4 节点 / 2 连线');
    expect(summary).toContain('2个shot');
    expect(summary).toContain('关键连线');
    expect(summary).toContain('镜头 1 → 镜头 2(first-frame)');
    expect(summary).toContain('Brief → 镜头 1(prompt)');

    // 经 buildContext 传 canvas 快照也注入
    const pid = `p-canvas-ctx-${Date.now()}`;
    const ctx = store.buildContext(pid, 'cA', '继续', undefined, { name: '主画布', nodes: [doc, sb, shot1, shot2], edges });
    expect(ctx.systemPrompt).toContain('【当前画布】');
  });

  it('不传 canvas → 不注入【当前画布】段(向后兼容)', () => {
    const pid = `p-canvas-ctx2-${Date.now()}`;
    const ctx = store.buildContext(pid, 'cA', '继续');
    expect(ctx.systemPrompt).not.toContain('【当前画布】');
  });
});
