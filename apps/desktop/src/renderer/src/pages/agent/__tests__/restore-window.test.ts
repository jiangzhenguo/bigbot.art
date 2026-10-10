/**
 * 历史恢复窗口单测(2026-10-09 「agent 对话消失了?」事故)
 *
 * 事故形态:用户重启 App 打开「测试1」画布,发现整段对话不见了。
 * 数据**完好**(45 条 recall 一条不少),是渲染层 `slice(-20)` 把它挡在了窗口外:
 *   最后 20 条 = 10 tool + 10 system(全是机器记录),
 *   被挤掉的 25 条里装着全部 12 条真实对话。
 *
 * 触发条件极具体:Agent 在「铺节点并生成」后一口气发了 **8 个 engine.submit**,
 * 每个产生 tool + system 两条 → 单轮吃掉 16+ 条额度。平时轮次短不会触发。
 *
 * 本文件的第一个用例就是**照抄这次事故的真实 recall 序列**,防止回归。
 */
import { describe, it, expect } from 'vitest';
import type { RecallMessage } from '@bigbotart/shared';
import { selectRestoreWindow, RESTORE_HUMAN_LIMIT } from '../restore-window';

let seq = 0;
function rec(role: RecallMessage['role'], content: string, toolName?: string): RecallMessage {
  seq += 1;
  return {
    canvasId: 'cA',
    role,
    content,
    id: `m${seq}`,
    createdAt: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    ...(toolName ? { toolName } : {}),
  } as RecallMessage;
}

/** 事故原样:12 条人类对话 + 中间穿插的工具记录 + 结尾 8 个 engine.submit 尾巴 */
function accidentRecall(): RecallMessage[] {
  const r: RecallMessage[] = [];
  r.push(rec('user', '你能干什么？'));
  r.push(rec('assistant', '我是 BigBotArt 画布工作台里的视频创作 Agent…'));
  r.push(rec('user', '2个美女在飞机机翼上打斗。'));
  r.push(rec('assistant', '这个机翼打斗场景,你想要哪种视觉风格?'));
  r.push(rec('tool', 'ask.user(这个机翼打斗场景…)', 'ask.user'));
  r.push(rec('user', '写实电影感'));
  r.push(rec('assistant', '写实风格下,打斗场景的强度怎么定?'));
  r.push(rec('tool', 'ask.user(写实风格下…)', 'ask.user'));
  r.push(rec('user', '激烈打斗'));
  r.push(rec('assistant', '明白:写实电影感 + 激烈打斗——我开始出分镜表。'));
  r.push(rec('user', '继续,直接出分镜表'));
  r.push(rec('assistant', '分镜表已就绪,接下来怎么走?'));
  r.push(rec('tool', 'storyboard.plan({...})', 'storyboard.plan'));
  r.push(rec('system', '已生成分镜表(节点 sb-1)'));
  r.push(rec('tool', 'ask.user(分镜表已就绪,接下来怎么走?)', 'ask.user'));
  r.push(rec('user', '铺节点并生成'));
  r.push(rec('assistant', '8 个首帧图已全部提交…'));
  r.push(rec('tool', 'storyboard.materialize({...})', 'storyboard.materialize'));
  r.push(rec('system', '已按分镜表 sb-1 铺出生成节点'));
  r.push(rec('tool', 'canvas.list_nodes({})', 'canvas.list_nodes'));
  r.push(rec('system', '已执行 canvas.list_nodes'));
  // 8 个 engine.submit → 16 条机器记录(压垮窗口的元凶)
  for (let i = 0; i < 8; i++) {
    r.push(rec('tool', `engine.submit({"nodeId":"img-${i}"})`, 'engine.submit'));
    r.push(rec('system', `已提交生成 img-${i}`));
  }
  return r;
}

describe('selectRestoreWindow — 事故序列回归', () => {
  it('旧口径 slice(-20) 会把人类对话全部挤掉(先证明事故可复现)', () => {
    const all = accidentRecall();
    const old = all.slice(-20);
    const human = old.filter((r) => r.role === 'user' || r.role === 'assistant');
    // 铁证:最后 20 条里一条人类对话都没有 —— 用户看到的就是"对话消失了"
    expect(human).toHaveLength(0);
  });

  it('新口径必须保住全部人类对话,一条都不能少', () => {
    const all = accidentRecall();
    const win = selectRestoreWindow(all);
    const human = win.filter((r) => r.role === 'user' || r.role === 'assistant');
    const expected = all.filter((r) => r.role === 'user' || r.role === 'assistant');
    // 12 条人类对话全部回显(远小于 20 条额度,不该被截)
    expect(human).toHaveLength(expected.length);
    expect(human.map((r) => r.content)).toEqual(expected.map((r) => r.content));
  });

  it('事故里的关键用户指令必须在窗口内', () => {
    const win = selectRestoreWindow(accidentRecall());
    const texts = win.map((r) => r.content);
    expect(texts).toContain('2个美女在飞机机翼上打斗。');
    expect(texts).toContain('激烈打斗');
    expect(texts).toContain('铺节点并生成');
  });

  it('保持原有时间顺序(不能被重排)', () => {
    const win = selectRestoreWindow(accidentRecall());
    const ids = win.map((r) => r.id);
    const sorted = [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    expect(ids).toEqual(sorted);
  });
});

describe('selectRestoreWindow — 额度只数人类记录', () => {
  it('人类消息超过额度时,只保留最近的 N 条(且含其后的机器记录)', () => {
    const all: RecallMessage[] = [];
    for (let i = 1; i <= 30; i++) {
      all.push(rec('user', `问题 ${i}`));
      all.push(rec('assistant', `回答 ${i}`));
      all.push(rec('tool', `canvas.list_nodes({})`, 'canvas.list_nodes'));
      all.push(rec('system', '已执行 canvas.list_nodes'));
    }
    const win = selectRestoreWindow(all, 4);
    const human = win.filter((r) => r.role === 'user' || r.role === 'assistant');
    expect(human).toHaveLength(4); // 4 条 = 2 轮问答
    expect(human[0]?.content).toBe('问题 29');
  });

  it('中间夹大量机器记录不影响人类额度', () => {
    const all: RecallMessage[] = [rec('user', '开头指令')];
    for (let i = 0; i < 200; i++) all.push(rec('system', `机器记录 ${i}`));
    all.push(rec('assistant', '结尾回复'));
    const win = selectRestoreWindow(all, 2);
    const human = win.filter((r) => r.role === 'user' || r.role === 'assistant');
    // 200 条机器记录夹在中间,两条人类消息依然都在
    expect(human.map((r) => r.content)).toEqual(['开头指令', '结尾回复']);
  });

  it('ask.user 卡片算人类记录(用户要能看到待确认项)', () => {
    const all: RecallMessage[] = [rec('user', '做视频')];
    for (let i = 0; i < 50; i++) all.push(rec('system', `噪音 ${i}`));
    all.push(rec('tool', 'ask.user(选哪种风格?)', 'ask.user'));
    const win = selectRestoreWindow(all, 2);
    const texts = win.map((r) => r.content);
    expect(texts).toContain('做视频');
    expect(texts).toContain('ask.user(选哪种风格?)');
  });
});

describe('selectRestoreWindow — 边界', () => {
  it('空 recall → 空数组', () => {
    expect(selectRestoreWindow([])).toEqual([]);
  });

  it('全是机器记录 → 从第 0 条起全部返回(不返回空,否则用户什么都看不到)', () => {
    const all: RecallMessage[] = [
      rec('tool', 'canvas.list_nodes({})', 'canvas.list_nodes'),
      rec('system', '已执行 canvas.list_nodes'),
    ];
    expect(selectRestoreWindow(all)).toHaveLength(2);
  });

  it('记录数少于额度 → 原样返回', () => {
    const all: RecallMessage[] = [rec('user', 'a'), rec('assistant', 'b')];
    expect(selectRestoreWindow(all)).toEqual(all);
  });

  it('默认额度是 20(与旧行为同数量级)', () => {
    expect(RESTORE_HUMAN_LIMIT).toBe(20);
  });
});
