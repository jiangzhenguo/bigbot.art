/**
 * 「工具失败却宣布成功」闸单测(第五变体,2026-10-09 「测试2」事故)
 *
 * 事故形态:
 *   08:13:29 用户「批准,按表铺 12 个 shot 节点(全部 preview 档)」
 *   08:13:03 storyboard.materialize({"nodeId":"storyboard-1791532265048-7l8p"})
 *             → ❌ 节点 storyboard-1791532265048-7l8p 不是分镜表(storyboard)节点
 *   08:13:35 Agent:「12 个 shot 已铺出,全部 preview 档…」  ← 谎报
 *   结果:画布 6 个节点,一个 shot 都没有;真实分镜表是 storyboard-1791533549516-ja9m。
 *
 * 为什么前面三个闸都拦不住:它们的判据全是 `hadCalls === false`(本轮**零**工具调用)。
 * 这次模型**调了**工具(只是传了幻觉 id 而失败),于是:
 *   - 截断闸:stopReason 正常,不触发;
 *   - 完成态闸:hadCalls 为 true,直接放行;
 *   - 承诺态闸:同上放行。
 * 本闸补的就是这个洞:**有失败 + 宣布成功** 即拦。
 */
import { describe, it, expect } from 'vitest';
import {
  isFalseSuccessAfterFailure,
  falseSuccessNudge,
  composeFalseSuccessReply,
} from '../pi-chat';

const MATERIALIZE_FAIL = [
  { name: 'storyboard.materialize', result: '节点 storyboard-1791532265048-7l8p 不是分镜表(storyboard)节点' },
];

describe('isFalseSuccessAfterFailure — 事故原话必须命中', () => {
  it('事故原话「12 个 shot 已铺出,全部 preview 档。」命中', () => {
    expect(
      isFalseSuccessAfterFailure('12 个 shot 已铺出,全部 preview 档。节点标题逐镜标明 Hook 便于扫读。', [
        'storyboard.materialize',
      ]),
    ).toBe(true);
  });

  it('各类完成态措辞都命中', () => {
    const cases = [
      '已创建 12 个节点。',
      '分镜表已生成。',
      '已提交生成,完成后画布会自动刷新。',
      '节点已更新完成。',
      '已删除该节点。',
    ];
    for (const c of cases) {
      expect(isFalseSuccessAfterFailure(c, ['canvas.update_node']), c).toBe(true);
    }
  });

  it('承诺态措辞也命中(工具失败了还宣布接下来要做)', () => {
    expect(isFalseSuccessAfterFailure('接下来我会生成 12 个 shot。', ['storyboard.materialize'])).toBe(true);
    expect(isFalseSuccessAfterFailure('我开始铺节点。', ['storyboard.materialize'])).toBe(true);
  });
});

describe('isFalseSuccessAfterFailure — 硬约束', () => {
  it('本轮没有工具失败 → 一律不拦(交给前三个闸)', () => {
    expect(isFalseSuccessAfterFailure('已创建 12 个节点。', [])).toBe(false);
  });

  it('空回复不判(没有可纠正的话)', () => {
    expect(isFalseSuccessAfterFailure('', ['storyboard.materialize'])).toBe(false);
    expect(isFalseSuccessAfterFailure('   ', ['storyboard.materialize'])).toBe(false);
  });

  it('模型老实承认失败 → 放行,绝不误伤诚实汇报', () => {
    const honest = [
      'storyboard.materialize 失败了,节点 id 不存在,我改用画布上真实的分镜表。',
      '铺节点失败:传的 id 找不到。',
      '没能铺出节点,因为没有可用的分镜表。',
      '该操作报错,原因是节点不存在。',
    ];
    for (const h of honest) {
      expect(isFalseSuccessAfterFailure(h, ['storyboard.materialize']), h).toBe(false);
    }
  });

  it('征询语气(在问用户怎么办)不算宣布成功', () => {
    expect(isFalseSuccessAfterFailure('铺节点失败了,要不要我改用另一个分镜表?需要我继续吗?', ['storyboard.materialize'])).toBe(false);
  });

  it('闲聊/说明句不含完成或承诺声明 → 不拦', () => {
    expect(isFalseSuccessAfterFailure('画布上目前有几个分镜表节点?', ['storyboard.materialize'])).toBe(false);
    expect(isFalseSuccessAfterFailure('这个方案有几种做法。', ['storyboard.materialize'])).toBe(false);
  });
});

describe('falseSuccessNudge — 纠正指令必须点名失败与真实报错', () => {
  const nudge = falseSuccessNudge('12 个 shot 已铺出。', MATERIALIZE_FAIL);

  it('引用模型原话 + 明确告知有工具失败', () => {
    expect(nudge).toContain('12 个 shot 已铺出');
    expect(nudge).toContain('本轮有工具调用失败了');
  });

  it('逐条给出失败工具名与真实报错(这是本次事故的关键 —— 模型没读报错)', () => {
    expect(nudge).toContain('storyboard.materialize');
    expect(nudge).toContain('不是分镜表');
  });

  it('给出可执行指引:别凭记忆拼 id,不确定就先 list_nodes', () => {
    expect(nudge).toContain('canvas.list_nodes');
    expect(nudge).toContain('不要凭记忆拼 id');
  });

  it('禁止复述提示、禁止再宣布完成', () => {
    expect(nudge).toContain('不要复述本提示');
  });
});

describe('composeFalseSuccessReply — 收尾必须标未成功', () => {
  it('保留模型的话但标注未成功执行 + 真实报错', () => {
    const out = composeFalseSuccessReply('12 个 shot 已铺出。', MATERIALIZE_FAIL);
    expect(out).toContain('12 个 shot 已铺出');
    expect(out).toContain('未成功执行');
    expect(out).toContain('storyboard.materialize');
    expect(out).toContain('不是分镜表');
  });

  it('空回复也如实说明失败(不冒充成功)', () => {
    const out = composeFalseSuccessReply('', MATERIALIZE_FAIL);
    expect(out).toContain('执行失败');
    expect(out).toContain('storyboard.materialize');
  });

  it('多个工具失败时全部列出(去重)', () => {
    const out = composeFalseSuccessReply('都搞定了。', [
      { name: 'canvas.create_node', result: 'kind 非法' },
      { name: 'canvas.create_node', result: 'kind 非法' },
      { name: 'canvas.connect', result: '端口不匹配' },
    ]);
    expect(out).toContain('canvas.create_node');
    expect(out).toContain('canvas.connect');
  });
});
