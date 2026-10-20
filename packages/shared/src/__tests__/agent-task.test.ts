import { describe, expect, it } from 'vitest';
import {
  decideShotPlanApproval,
  formatTodoPrompt,
  openShots,
  shotSubmitAllowed,
  validatePlanMarkdown,
  validateTodoList,
} from '../agent-task.js';

const shot = (id: string, label: string, resultPath?: string) => ({
  id,
  kind: 'shot',
  label,
  data: resultPath ? { resultPath } : {},
});

describe('validateTodoList', () => {
  it('接受整表并允许一项进行中', () => {
    const r = validateTodoList([
      { content: '建分镜表', status: 'completed' },
      { content: '出锚定图', status: 'in_progress' },
      { content: '写镜头提示词', status: 'pending' },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.todos).toHaveLength(3);
  });

  it('空数组是清空', () => {
    expect(validateTodoList([])).toEqual({ ok: true, todos: [] });
  });

  it('字符串化的 JSON 数组可以还原', () => {
    const r = validateTodoList('[{"content":"铺节点","status":"pending"}]');
    expect(r.ok).toBe(true);
  });

  it('两项进行中、空内容、重复、非法状态都拒绝', () => {
    expect(validateTodoList([
      { content: '甲', status: 'in_progress' },
      { content: '乙', status: 'in_progress' },
    ]).ok).toBe(false);
    expect(validateTodoList([{ content: '  ', status: 'pending' }]).ok).toBe(false);
    expect(validateTodoList([
      { content: '甲', status: 'pending' },
      { content: '甲', status: 'completed' },
    ]).ok).toBe(false);
    expect(validateTodoList([{ content: '甲', status: 'done' }]).ok).toBe(false);
  });
});

describe('formatTodoPrompt', () => {
  it('空清单不注入', () => {
    expect(formatTodoPrompt(undefined)).toBeUndefined();
    expect(formatTodoPrompt([])).toBeUndefined();
  });

  it('进行中排在待办前面', () => {
    const text = formatTodoPrompt([
      { content: '写词', status: 'pending' },
      { content: '出图', status: 'in_progress' },
    ]);
    expect(text?.indexOf('进行中:出图')).toBeLessThan(text?.indexOf('待办:写词') ?? 0);
    expect(text).toContain('未完成项继续做');
  });
});

describe('多镜提交闸', () => {
  const nodes = [shot('b', '镜头 02'), shot('a', '镜头 01'), shot('c', '镜头 03', '/tmp/done.mp4'), { id: 'g', kind: 'image-gen', label: '静帧' }];

  it('未出片镜头按 id 排序,已有产物的不算', () => {
    expect(openShots(nodes).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('不足两镜放行,两镜未批准拒绝,已批准的镜头放行', () => {
    expect(shotSubmitAllowed({ nodeId: 'a', nodes: [shot('a', '镜头 01')], approvedShotIds: undefined }).ok).toBe(true);
    const blocked = shotSubmitAllowed({ nodeId: 'a', nodes, approvedShotIds: undefined });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain('plan.present');
    expect(shotSubmitAllowed({ nodeId: 'a', nodes, approvedShotIds: ['a', 'b'] }).ok).toBe(true);
    expect(shotSubmitAllowed({ nodeId: 'z', nodes, approvedShotIds: ['a', 'b'] }).ok).toBe(false);
  });

  it('点头时镜头集合必须仍一致;没有待确认计划则静默跳过', () => {
    expect(decideShotPlanApproval(undefined, ['a', 'b'])).toEqual({ ok: false, silent: true });
    expect(decideShotPlanApproval(['a', 'b'], ['b', 'a'])).toEqual({ ok: true, approvedShotIds: ['a', 'b'] });
    const mismatch = decideShotPlanApproval(['a', 'b'], ['a', 'b', 'd']);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok && !mismatch.silent) expect(mismatch.reason).toContain('重新 plan.present');
  });
});

describe('validatePlanMarkdown', () => {
  it('要求标题和正文', () => {
    expect(validatePlanMarkdown('先提交两镜').ok).toBe(false);
    expect(validatePlanMarkdown('# 只写标题').ok).toBe(false);
    expect(validatePlanMarkdown('# 计划\n\n提交镜头 01 和镜头 02').ok).toBe(true);
  });
});
