/**
 * 「用正文提问」闸单测(第七变体,2026-10-09 「飞机」项目事故)
 *
 * 事故链是**两轮**,第一轮埋雷、第二轮爆雷:
 *   15:21:54  assistant「故事大纲已落画布…」结尾「**请选下一步:**」
 *             ← 纯文本问句,**没有 ask.user 卡片**(该轮工具只有 list_nodes / create_node)
 *   15:22:58  用户「继续」
 *   15:23:02  assistant「我先建苏青的角色卡」← **工具调用数 = 0**,画布上没有任何角色卡
 *
 * 因果关系是决定性的:模型上一轮用正文问了「请选下一步」,于是把用户随后的「继续」
 * 理解成**对那个问题的回答** → 进入「交代计划」的说明模式,而不是「动手做」的执行模式。
 *
 * 实测相关性 100%(【飞机】项目 5 轮):
 *   - 用户输入前有 ask.user 卡片 → 本轮都调了工具(4/4)
 *   - 用户输入前没有卡片(裸「继续」)→ 零调用(1/1)
 *
 * ⚠️ 本闸的判据必须**窄**:第一版把「以问号结尾」也算征询,当场打破了 3 个既有集成用例
 * (「你好,有什么可以帮你?」「提示词已写好,要现在提交生成吗?」都是**完全正常**的收尾)。
 * 现在的判据要求**决策措辞 + 收在问题上**同时成立 —— 宁可漏判,不可误伤正常对话。
 */
import { describe, it, expect } from 'vitest';
import { isPlainTextAsk, plainTextAskNudge, composePlainTextAskReply } from '../pi-chat';

describe('isPlainTextAsk — 事故原话必须命中', () => {
  it('★ 事故原话「请选下一步:」(冒号结尾、没有问号)必须命中', () => {
    expect(isPlainTextAsk('故事大纲已落画布「机翼对决 · 故事大纲」。\n\n请选下一步:')).toBe(true);
  });

  it('冒号收束的征询(同形态不同措辞)', () => {
    expect(isPlainTextAsk('项目简报已落画布。请选下一步:')).toBe(true);
    expect(isPlainTextAsk('请选择接下来的方向:')).toBe(true);
  });

  it('问号收束的征询', () => {
    expect(isPlainTextAsk('要我继续吗?')).toBe(true);
    expect(isPlainTextAsk('是否需要我调整风格?')).toBe(true);
    expect(isPlainTextAsk('接下来怎么走?')).toBe(true);
  });
});

describe('isPlainTextAsk — 绝不误伤正常对话(踩过的坑)', () => {
  /* 这三条正是第一版判据打破的既有集成用例 —— 它们是**完全正常**的收尾,
     拦下来会让「干完活顺手问一句」也变成重试,属于典型过度拦截。 */

  it('寒暄式的问句不算征询(「你好,有什么可以帮你?」)', () => {
    expect(isPlainTextAsk('你好,有什么可以帮你?')).toBe(false);
  });

  it('干完活后顺口确认一句不算(「提示词已写好,要现在提交生成吗?」)', () => {
    expect(isPlainTextAsk('提示词已写好,要现在提交生成吗?')).toBe(false);
  });

  it('纯交付陈述(不带问号、不带征询措辞)', () => {
    expect(isPlainTextAsk('故事大纲已落画布「机翼对决 · 故事大纲」。')).toBe(false);
    expect(isPlainTextAsk('已创建 3 个镜头节点。')).toBe(false);
  });

  it('复述用户的话不算(「你说要不要加对白,我先答一句」)', () => {
    expect(isPlainTextAsk('你说要不要加对白?我的看法是默认无台词。')).toBe(false);
  });

  it('空回复不判', () => {
    expect(isPlainTextAsk('')).toBe(false);
    expect(isPlainTextAsk('   ')).toBe(false);
  });

  it('只有问号但没有决策措辞 → 放行(宁可漏判)', () => {
    expect(isPlainTextAsk('这是你想要的效果吗?')).toBe(false);
  });
});

describe('plainTextAskNudge — 纠正指令要点名后果', () => {
  const nudge = plainTextAskNudge('故事大纲已落画布。请选下一步:');

  it('引用原话结尾', () => {
    expect(nudge).toContain('请选下一步');
  });

  it('给出两条出路:要决策就用 ask.user / 不用决策就直接干', () => {
    expect(nudge).toContain('ask.user');
    expect(nudge).toContain('直接调用工具');
  });

  it('★ 说清后果:正文提问会让下一轮的「继续」被误读成回答', () => {
    expect(nudge).toContain('继续');
    expect(nudge).toContain('一个工具都不调');
  });

  it('要求复述提示后直接调工具', () => {
    expect(nudge).toContain('不要复述本提示');
  });
});

describe('composePlainTextAskReply — 收尾要提醒用户用执行指令', () => {
  it('保留模型的话并标注「这是纯文本提问」', () => {
    const out = composePlainTextAskReply('故事大纲已落画布。请选下一步:');
    expect(out).toContain('请选下一步');
    expect(out).toContain('纯文本提问');
  });

  it('★ 提醒用户别说「继续」(会被误读成回答),改用执行指令', () => {
    const out = composePlainTextAskReply('请选下一步:');
    expect(out).toContain('执行指令');
    expect(out).toContain('继续');
  });

  it('空回复也给明确说明', () => {
    const out = composePlainTextAskReply('');
    expect(out).toContain('确认卡片');
    expect(out).toContain('执行指令');
  });
});
