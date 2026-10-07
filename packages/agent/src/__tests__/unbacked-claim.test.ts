/**
 * 「承诺未兑现」闸单测(2026-10-07 「舞蹈」主画布假成功事故)
 *
 * 事故形态:用户说「生成」,模型回「已提交生成,完成后画布会自动刷新。」,
 * 但**一个工具调用都没发**。三条独立证据钉死了这个事实:
 *   ① 真提交耗时 23.15s,这一轮 1.6s 就返回;
 *   ② recall 里这条 assistant 前后没有任何 tool 记录;
 *   ③ takes.json 里没有对应 take(真提交哪怕失败也先落一条 queued)。
 *
 * 后果:节点 prompt 齐全、resultPath 空,用户以为在生成、实际什么都没发生。
 * 这是「假成功」家族的第三个变体(前两个:stopReason==='length' 的截断、
 * 批次1 的静默看门狗假失败)。本文件锁住判定与两段文案。
 */
import { describe, it, expect } from 'vitest';
import {
  isUnbackedCompletionClaim,
  unbackedClaimNudge,
  composeUnbackedClaimReply,
} from '../pi-chat';

describe('isUnbackedCompletionClaim — 事故原话必须命中', () => {
  it('事故原话「已提交生成,完成后画布会自动刷新。」命中', () => {
    expect(isUnbackedCompletionClaim('已提交生成,完成后画布会自动刷新。', false)).toBe(true);
  });

  it('「重提交 new24-ix8p(背视图)。」命中 —— 用户第二次追问也没真执行', () => {
    expect(isUnbackedCompletionClaim('重提交 new24-ix8p(背视图)。', false)).toBe(true);
  });

  it('各类动作完成声明都命中', () => {
    const claims = [
      '已生成好了',
      '已经提交了生成任务',
      '已创建节点并连线',
      '已删除该节点',
      '已导出时间线',
      '刚刚重新生成完毕',
      '已更新节点参数',
      '已导入 3 项资源',
    ];
    for (const c of claims) {
      expect(isUnbackedCompletionClaim(c, false), c).toBe(true);
    }
  });
});

describe('isUnbackedCompletionClaim — 真实调用过就不拦(不误伤)', () => {
  it('本轮确实有工具调用(hadCalls=true)→ 一律放行', () => {
    // 成功那轮的真实话术:伴随 engine.submit,绝不能拦
    expect(isUnbackedCompletionClaim('已提交生成「图片编辑」(new23-ix8p)', true)).toBe(false);
    expect(isUnbackedCompletionClaim('已更新节点 new24-ix8p', true)).toBe(false);
  });
});

describe('isUnbackedCompletionClaim — 征询/计划语气不能误判', () => {
  it('「要现在提交生成吗?」= 征询,不拦', () => {
    // 事故的**上一轮**正是这句话 —— 拦了它会把正常提问变成错误
    expect(isUnbackedCompletionClaim('已写好背视图提示词。要现在提交生成吗?', false)).toBe(false);
  });

  it('其他征询/计划语气', () => {
    const asks = [
      '是否要提交生成?',
      '需要我提交吗?',
      '要不要现在生成?',
      '可以生成吗?',
      '请确认后再提交',
      '我建议先生成侧视图',
      '计划接下来提交生成',
      '准备提交生成',
    ];
    for (const a of asks) {
      expect(isUnbackedCompletionClaim(a, false), a).toBe(false);
    }
  });
});

describe('isUnbackedCompletionClaim — 失败/否定语气不能误判', () => {
  it('「提交失败」类不拦(它没谎报成功)', () => {
    const fails = [
      '提交失败了,稍后重试',
      '无法提交生成,缺少输入图',
      '未能生成,请检查连线',
      '还没有提交',
      '已取消本次生成',
    ];
    for (const f of fails) {
      expect(isUnbackedCompletionClaim(f, false), f).toBe(false);
    }
  });
});

describe('isUnbackedCompletionClaim — 普通对话不拦', () => {
  it('不含完成声明的回复一律放行', () => {
    const ok = [
      '你好,有什么可以帮你?',
      '这张图的光线可以再暖一点',
      '当前画布有 21 个节点',
      '',
      '   ',
    ];
    for (const t of ok) {
      expect(isUnbackedCompletionClaim(t, false), JSON.stringify(t)).toBe(false);
    }
  });

  /* 🚨 以下 5 条是**压力测试抓出来的真实误伤**。
     放宽「动词开头」句式以覆盖事故里的「重提交 new24-ix8p」之后,这些正常句子
     一度被判成谎报 —— 若上线,用户每问一句流程说明都会被塞回一轮纠正指令(白烧 token
     且答非所问)。钉在这里防回归。 */
  it('说明/指示语气:动词开头但在讲流程或性质,不是完成声明', () => {
    const explanatory = [
      '生成背视图需要先有一张正面参考图',
      '删除节点是不可逆的',
      '更新提示词后需要重新提交',
      '连接这两个节点即可',
      '导出时间线会生成一个 zip',
      '提交之前请先确认连线',
      '生成的话要先选模型',
    ];
    for (const t of explanatory) {
      expect(isUnbackedCompletionClaim(t, false), t).toBe(false);
    }
  });

  it('带具体宾语的动词开头才是完成声明(与上一条互为对照)', () => {
    // 同样的动词开头,+ 宾语 → 命中;+ 说明词 → 放行
    expect(isUnbackedCompletionClaim('重提交 new24-ix8p(背视图)。', false)).toBe(true);
    expect(isUnbackedCompletionClaim('生成完成', false)).toBe(true);
    expect(isUnbackedCompletionClaim('创建了节点', false)).toBe(true);
  });
});

describe('unbackedClaimNudge — 纠正指令', () => {
  it('点名要求调用 engine.submit,并引用模型谎报的原话', () => {
    const n = unbackedClaimNudge('已提交生成,完成后画布会自动刷新。');
    expect(n).toContain('engine.submit');
    expect(n).toContain('已提交生成');
    // 必须明确告知「没有发出任何工具调用」这个事实
    expect(n).toMatch(/没有发出任何工具调用|未真正发生/);
  });

  it('明令禁止重复提问与重写提示词(避免白烧一轮)', () => {
    const n = unbackedClaimNudge('已提交生成');
    expect(n).toMatch(/不要重复提问/);
    expect(n).toMatch(/不要重新写提示词/);
  });

  it('超长原话截断引用,不把整段提示词灌回去', () => {
    const long = '已提交生成' + 'x'.repeat(500);
    const n = unbackedClaimNudge(long);
    expect(n.length).toBeLessThan(400);
  });
});

describe('composeUnbackedClaimReply — 收尾必须留痕', () => {
  it('保留模型原话,但明确标注未实际执行', () => {
    const s = composeUnbackedClaimReply('已提交生成,完成后画布会自动刷新。');
    expect(s).toContain('已提交生成'); // 不丢模型的话
    expect(s).toMatch(/未实际执行/);
    expect(s).toMatch(/没有发出任何工具调用|仍未发出/);
  });

  it('空回复时给出可执行的失败说明,而不是空字符串', () => {
    const s = composeUnbackedClaimReply('');
    expect(s.length).toBeGreaterThan(0);
    expect(s).toMatch(/未发生|没有发出/);
  });

  it('绝不出现「已提交」这类会让用户误以为成功的措辞收尾', () => {
    const s = composeUnbackedClaimReply('已提交生成');
    // 原话里当然有「已提交」(那是被引用的模型原话),
    // 关键是必须同时带上否定标记,不能只有肯定句
    expect(s).toMatch(/⚠️/);
  });
});
