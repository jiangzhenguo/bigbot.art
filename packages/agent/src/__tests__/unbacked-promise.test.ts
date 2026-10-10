/**
 * 「只承诺未执行」闸单测(2026-10-09 「测试1」画布事故)
 *
 * 事故形态:用户「2个美女在飞机机翼上打斗」→ 模型连问两轮 ask.user(风格/强度)→
 * 用户答完后,模型回「明白:**写实电影感 + 激烈打斗**——我开始出分镜表。」**本轮零工具调用**。
 *
 * 三条独立证据:
 *   ① recall 里这条 assistant 前后没有任何 tool 记录;
 *   ② canvases.json 的 nodes 始终为 []、version 停在 6(仅渲染层空画布 flush);
 *   ③ 没有 failed 记录 —— 不是看门狗超时,是模型自己说完话就结束了本轮。
 *
 * 与第三变体(已完成谎报,unbacked-claim.test.ts)的关系:
 * 同一病灶的两副面孔,区别只在**时态** —— 那边认「已提交」,这边认「我开始」。
 * 承诺态更隐蔽:用户看到「我开始出分镜表」会以为马上有产出,实际进程已结束。
 *
 * ⚠️ 本文件同时锁**不误伤**:prompt 里大量正常对话都以动作动词开头,
 * 一旦误判就会把正常收尾也回灌重试,白烧一轮 token。
 */
import { describe, it, expect } from 'vitest';
import {
  isUnbackedPromiseClaim,
  unbackedPromiseNudge,
  composeUnbackedPromiseReply,
} from '../pi-chat';

describe('isUnbackedPromiseClaim — 事故原话必须命中', () => {
  it('事故原话「明白:**写实电影感 + 激烈打斗**——我开始出分镜表。」命中', () => {
    expect(
      isUnbackedPromiseClaim('明白:**写实电影感 + 激烈打斗**——我开始出分镜表。', false),
    ).toBe(true);
  });

  it('「我开始出分镜表。」命中', () => {
    expect(isUnbackedPromiseClaim('我开始出分镜表。', false)).toBe(true);
  });
});

describe('isUnbackedPromiseClaim — 三类承诺句式', () => {
  it('① 我 + 开始/马上/这就/先 + 动作', () => {
    const cases = [
      '我现在就出分镜表。',
      '我马上创建节点。',
      '我这就去生成。',
      '我先铺节点。',
      '我们开始生成。',
    ];
    for (const c of cases) expect(isUnbackedPromiseClaim(c, false), c).toBe(true);
  });

  it('② 接下来/然后 + 我 + 会/来 + 动作', () => {
    const cases = [
      '接下来我会生成分镜表。',
      '然后我来创建角色卡节点。',
      '下一步我会提交生成。',
      '下面我会导出时间线。',
    ];
    for (const c of cases) expect(isUnbackedPromiseClaim(c, false), c).toBe(true);
  });

  it('③ 正在 + 动作(进行态)', () => {
    const cases = ['正在生成分镜表。', '正在创建节点,请稍候。'];
    for (const c of cases) expect(isUnbackedPromiseClaim(c, false), c).toBe(true);
  });
});

describe('isUnbackedPromiseClaim — 口语动词(2026-10-09 「飞机」事故)', () => {
  /* 事故原话:「我**先建**苏青的角色卡」—— 动词表里当时只有「创建」「新建」,
     没有单字「建」,于是承诺态闸失配,零工具调用被当正常回复放行,任务停住。
     同一个坑已踩三次(出分镜表漏「出」、铺节点漏「铺」、建角色卡漏「建」):
     **按书面语建表,模型说口语**。 */

  it('★ 事故原话「我先建苏青的角色卡」必须命中', () => {
    expect(isUnbackedPromiseClaim('我先建苏青的角色卡,生成后用 vision.caption 自检。', false)).toBe(true);
  });

  it('各类口语说法都能命中(动词表已补 + 句式结构兜底)', () => {
    const cases = [
      '我来建角色卡。',
      '我先做角色卡。',
      '我先搞一下场景卡。',
      '我先弄个节点。',
      '我马上去做角色卡。',
      '接下来我会生成分镜表。',
      '我先建苏青的角色卡',
    ];
    for (const c of cases) expect(isUnbackedPromiseClaim(c, false), c).toBe(true);
  });

  it('★ 句式结构兜底:即使动词不在白名单里也能命中', () => {
    /* PROMISE_STRUCTURE_RE 判「第一人称 + 意愿副词 + 动作 + 宾语」,
       不依赖具体动词 —— 这是治「动词表永远补不完」的那一层。 */
    expect(isUnbackedPromiseClaim('我先搭一个角色卡', false)).toBe(true);
    expect(isUnbackedPromiseClaim('我来拉一条连线', false)).toBe(true);
  });
});

describe('isUnbackedPromiseClaim — 硬约束', () => {
  it('本轮真的调了工具 → 一律放行(hadCalls=true)', () => {
    expect(isUnbackedPromiseClaim('我开始出分镜表。', true)).toBe(false);
  });

  it('空回复不算承诺', () => {
    expect(isUnbackedPromiseClaim('', false)).toBe(false);
    expect(isUnbackedPromiseClaim('   ', false)).toBe(false);
  });

  it('否定语气不算承诺(「没法生成」)', () => {
    expect(isUnbackedPromiseClaim('我现在没法生成,提示词是空的。', false)).toBe(false);
  });

  it('征询语气不算承诺(「接下来我会生成 3 个方案供你选」)', () => {
    expect(isUnbackedPromiseClaim('接下来我会生成 3 个方案,需要我继续吗?', false)).toBe(false);
  });

  it('讲步骤不算承诺(「我先把节点建好,然后才能提交」)', () => {
    expect(isUnbackedPromiseClaim('我先把节点建好,然后才能提交生成。', false)).toBe(false);
  });
});

describe('isUnbackedPromiseClaim — 绝不误伤正常对话', () => {
  it('无第一人称承诺结构的说明句一律放行', () => {
    const safe = [
      '生成背视图需要先有一张正面参考图。',
      '删除节点是不可逆的操作。',
      '更新提示词后需要重新提交。',
      '连接这两个节点即可。',
      '接下来需要你确认风格方向。',
      '分镜表已经出好了,请查看。', // 完成态 → 由另一个闸管,不该被本闸误拦(本闸不认「出好了」)
      '画布上目前有 3 个节点。',
      '这个方案有几种风格可选:写实、3D 卡通、日式动画。',
    ];
    for (const s of safe) expect(isUnbackedPromiseClaim(s, false), s).toBe(false);
  });

  it('被动/第三方表述不算模型承诺', () => {
    expect(isUnbackedPromiseClaim('提交后系统会生成视频。', false)).toBe(false);
  });
});

describe('两段文案', () => {
  it('催促指令指名道姓给出工具名 + 引用原话', () => {
    const nudge = unbackedPromiseNudge('明白:写实电影感 + 激烈打斗——我开始出分镜表。');
    expect(nudge).toContain('本轮没有发出任何工具调用');
    expect(nudge).toContain('storyboard.plan');
    expect(nudge).toContain('我开始出分镜表');
    expect(nudge).toContain('只发工具调用');
  });

  it('重试仍无调用 → 保留原话但打上未执行标记', () => {
    const out = composeUnbackedPromiseReply('我开始出分镜表。');
    expect(out).toContain('我开始出分镜表');
    expect(out).toContain('未实际执行');
  });

  it('空回复收尾文案不冒充成功', () => {
    const out = composeUnbackedPromiseReply('');
    expect(out).toContain('未实际执行');
    expect(out).toContain('没有发出任何工具调用');
  });
});
