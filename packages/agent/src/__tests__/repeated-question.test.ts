/**
 * 「复述老问题」闸单测(第六变体,2026-10-09 「测试3」事故)
 *
 * 事故原样(recall 实录):
 *   14:25:33  assistant「2个美女在机翼上战斗——想走哪种动作风格?(选流派后我会按此锁风格+设计角色)」
 *             + **ask.user 卡片**,用户答「皮克斯式风格化格斗」
 *   14:26:03  assistant + ask.user 卡片「项目简报已就位。请确认是否按此推进到「故事大纲」…」
 *   14:27:09  用户「确认,推进故事大纲」
 *   14:27:11  assistant「2个美女在机翼上战斗——想走哪种动作风格?(选流派后我会按此锁风格+设计角色)」
 *             ← **逐字复述**,**没有卡片**,该轮工具调用数 = 0
 *
 * 后果:界面是一条**没有可点选项**的纯文本气泡,用户无从回答 → 对话卡死(用户报「又停住了」)。
 *
 * 为什么已有防重闸没拦住:那段「同一问题逐字重复 → 驳回」的判定写在 `if (askCall)` 分支内,
 * 只有模型**再次调用 ask.user** 时才执行。这次模型压根没调工具,直接走
 * `calls.length === 0` 分支被当成正常回复返回。
 */
import { describe, it, expect } from 'vitest';
import {
  isRepeatedPlainTextQuestion,
  repeatedQuestionNudge,
  composeRepeatedQuestionReply,
} from '../pi-chat';

/** 事故现场那句问题(原样) */
const ACCIDENT_Q = '2个美女在机翼上战斗——想走哪种动作风格?(选流派后我会按此锁风格+设计角色)';

describe('isRepeatedPlainTextQuestion — 事故原话必须命中', () => {
  it('事故原话:逐字复述上一次 ask.user 的问题 → 命中', () => {
    expect(isRepeatedPlainTextQuestion(ACCIDENT_Q, ACCIDENT_Q)).toBe(true);
  });

  it('复述时换行/空格有微差也算(与 ask 分支内判据同口径)', () => {
    const withBreaks = ACCIDENT_Q.replace('——', '——\n').replace('?', ' ? ');
    expect(isRepeatedPlainTextQuestion(withBreaks, ACCIDENT_Q)).toBe(true);
  });

  it('确认闸那种「确认继续吗?」被复述也命中', () => {
    const q = '即将执行 2 项不可轻易撤销的操作,确认继续吗?';
    expect(isRepeatedPlainTextQuestion(q, q)).toBe(true);
  });
});

describe('isRepeatedPlainTextQuestion — 硬约束(绝不误伤正常追问)', () => {
  it('从没问过任何问题(lastAsked=null)→ 不拦', () => {
    expect(isRepeatedPlainTextQuestion(ACCIDENT_Q, null)).toBe(false);
  });

  it('★ 换成新问题(哪怕句式很像)→ 不拦 —— 否则会掐死正常对话', () => {
    expect(isRepeatedPlainTextQuestion('那镜头数想控制在几个?', ACCIDENT_Q)).toBe(false);
    // 同一个开场但问题实质不同(补充条件)也必须放行
    expect(
      isRepeatedPlainTextQuestion(`${ACCIDENT_Q}还是说你想要无对白的纯动作?`, ACCIDENT_Q),
    ).toBe(false);
  });

  it('正常回复(非问句)不拦', () => {
    expect(isRepeatedPlainTextQuestion('故事大纲已落画布,请确认是否进入角色卡。', ACCIDENT_Q)).toBe(false);
  });

  it('空回复不判', () => {
    expect(isRepeatedPlainTextQuestion('', ACCIDENT_Q)).toBe(false);
    expect(isRepeatedPlainTextQuestion('   ', ACCIDENT_Q)).toBe(false);
  });
});

describe('repeatedQuestionNudge — 纠正指令必须点名并督促推进', () => {
  const nudge = repeatedQuestionNudge(ACCIDENT_Q);

  it('引用模型原话 + 明确「已经回答过了」', () => {
    expect(nudge).toContain('2个美女在机翼上战斗');
    expect(nudge).toContain('已经回答过');
  });

  it('给出可执行指引:先去查画布状态(事故里查一次就知道图已出好)', () => {
    expect(nudge).toContain('canvas.list_nodes');
    expect(nudge).toContain('resultPath');
  });

  it('要求确需决策时用 ask.user 工具,不许写成正文', () => {
    expect(nudge).toContain('ask.user');
    expect(nudge).toContain('不要写成正文');
  });

  it('禁止复述提示,要求直接调工具', () => {
    expect(nudge).toContain('不要复述本提示');
  });
});

describe('composeRepeatedQuestionReply — 收尾必须标注未推进', () => {
  it('保留模型的话但标注「重复提问、本轮未推进」', () => {
    const out = composeRepeatedQuestionReply(ACCIDENT_Q);
    expect(out).toContain('2个美女在机翼上战斗');
    expect(out).toContain('重复提问');
    expect(out).toContain('没有推进');
  });

  it('给出用户可操作的下一步提示', () => {
    const out = composeRepeatedQuestionReply(ACCIDENT_Q);
    expect(out).toContain('继续');
  });

  it('空回复也给明确说明(不静默)', () => {
    const out = composeRepeatedQuestionReply('');
    expect(out).toContain('重复');
    expect(out).toContain('没有推进任务');
  });
});
