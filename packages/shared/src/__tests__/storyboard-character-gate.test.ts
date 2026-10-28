import { describe, expect, it } from 'vitest';
import { checkStoryboardCharacterGate } from '../storyboard-character-gate';

const HEAD = ['镜号', '画面描述', '对白/旁白', '景别', '运镜', '时长(s)', '需配图', '提示词(可选)', '衔接', '角色'];

function row(n: number, desc: string, role = ''): string[] {
  return [String(n), desc, '', '中景', '固定', '5', '是', '', n === 1 ? '硬切' : '接尾帧', role];
}

describe('checkStoryboardCharacterGate — 重复角色必须先有角色卡', () => {
  it('真实「T台冲突」形态:女模跨镜复现但角色列全空 → 指名行号并拦截', () => {
    const rows = [
      row(1, 'T台尽头,两名亚洲女模在聚光灯下对峙'),
      row(2, '两人互相推搡格挡'),
      row(3, '一名女模被推搡踉跄失衡'),
      row(4, '保安与工作人员冲上制住两人'),
      row(5, '两人被拉开后各自整理仪态'),
    ];
    const issues = checkStoryboardCharacterGate({ head: HEAD, rows, canvasNodes: [] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'unnamed-recurring', name: '模特', rows: [1, 3] });
  });

  it('角色列重复点名但画布无卡 → missing-card;即使只缺真实节点也不静默通过', () => {
    const issues = checkStoryboardCharacterGate({
      head: HEAD,
      rows: [row(1, '两人对峙', '女模A'), row(2, '继续推搡', '女模A')],
      canvasNodes: [],
    });
    expect(issues).toEqual([{ kind: 'missing-card', name: '女模A', rows: [1, 2] }]);
  });

  it('已有对应角色卡且角色列点名 → 放行', () => {
    const issues = checkStoryboardCharacterGate({
      head: HEAD,
      rows: [row(1, '两人对峙', '女模A'), row(2, '继续推搡', '女模A')],
      canvasNodes: [{ id: 'card-a', kind: 'image-gen', label: '角色卡·女模A' }],
    });
    expect(issues).toEqual([]);
  });

  it('只出镜一次的人物不要求建卡', () => {
    expect(checkStoryboardCharacterGate({ head: HEAD, rows: [row(1, '一名女模走过')], canvasNodes: [] })).toEqual([]);
    expect(checkStoryboardCharacterGate({ head: HEAD, rows: [row(1, '空荡的T台与灯光')], canvasNodes: [] })).toEqual([]);
  });

  it('纸拼贴技能可用静帧锁构图:放行无名复现人物,但显式重复卡名缺失仍拦截', () => {
    const base = { head: HEAD, canvasNodes: [], activeSkillId: 'paper-collage-explainer' };
    expect(checkStoryboardCharacterGate({ ...base, rows: [row(1, '女孩翻纸'), row(2, '女孩继续翻纸')] })).toEqual([]);
    expect(checkStoryboardCharacterGate({ ...base, rows: [row(1, '女孩翻纸', '小纸'), row(2, '继续', '小纸')] })).toHaveLength(1);
  });
});
