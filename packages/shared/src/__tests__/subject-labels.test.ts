/**
 * H3 Ref2VA `<Subject n>` 标签段单测(2026-10-09 「角色卡连不上」事故)
 *
 * 事故:测试2 画布里 3 张角色卡/场景卡**零出边**,是彻底的孤岛;
 * 而且提示词里完全没有 `<Picture n>` / `<Subject n>` 引用 ——
 * 也就是说即使连上了,h3 也只会「看到图」而不知道要继承什么。
 *
 * 官方 Ref2VA 规范(<https://github.com/benny108/minimax-h3-prompt-engineering-cn>):
 *   「若图片只提供人物身份,应在对应 `<Subject N>` 中引用图片」
 *   「<Subject 1> is the young woman in <Picture 1>, with long dark hair...」
 *
 * 本文件的铁律:**<Picture n> 的编号 = 数组顺序 = 参考图连线顺序**。
 * 编号与图错位比不写标签更糟(模型会拿场景图当角色继承)。
 */
import { describe, it, expect } from 'vitest';
import { assembleH3Prompt, buildSubjectLabels, buildRetentionAnalysis } from '../prompt';

const HEAD = ['镜号', '画面描述', '对白/旁白', '景别', '运镜', '时长(s)', '需配图'];
const ROW = ['1', '机翼上两人对峙', '无', '远景', '航拍侧移', '5', '是'];

describe('buildSubjectLabels — 标签段组装', () => {
  it('角色 → identity lock,场景 → scene lock', () => {
    const out = buildSubjectLabels([
      { name: '苏青', kind: 'character' },
      { name: '叶莲娜', kind: 'character' },
      { name: '机翼', kind: 'scene' },
    ]);
    expect(out).toContain('<Subject 1> is 苏青 in <Picture 1> (identity lock: face, hair, outfit).');
    expect(out).toContain('<Subject 2> is 叶莲娜 in <Picture 2> (identity lock: face, hair, outfit).');
    expect(out).toContain('<Subject 3> is the environment in <Picture 3> (scene lock');
  });

  it('编号严格按数组顺序(= 连线顺序)', () => {
    const out = buildSubjectLabels([
      { name: 'A', kind: 'character' },
      { name: 'B', kind: 'character' },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toContain('<Subject 1>');
    expect(lines[0]).toContain('<Picture 1>');
    expect(lines[0]).toContain('A');
    expect(lines[1]).toContain('<Subject 2>');
    expect(lines[1]).toContain('<Picture 2>');
    expect(lines[1]).toContain('B');
  });

  it('空 / 无参数 → 空串(调用方据此不插入该段)', () => {
    expect(buildSubjectLabels(undefined)).toBe('');
    expect(buildSubjectLabels([])).toBe('');
  });

  it('名字为空白的条目被跳过,且不占编号(不产出半截标签)', () => {
    const out = buildSubjectLabels([
      { name: '  ', kind: 'character' }, // 无效 → 跳过
      { name: '苏青', kind: 'character' },
    ]);
    // 苏青应是 Subject 1(而不是 2)—— 否则标签与图错位
    expect(out).toContain('<Subject 1> is 苏青 in <Picture 1>');
    expect(out).not.toContain('<Subject 2>');
  });

  it('名字前后空白被裁剪', () => {
    const out = buildSubjectLabels([{ name: '  苏青  ', kind: 'character' }]);
    expect(out).toContain('<Subject 1> is 苏青 in <Picture 1>');
  });

  it('9 张(上限)全部产出', () => {
    const subs = Array.from({ length: 9 }, (_, i) => ({
      name: `角色${i + 1}`,
      kind: 'character' as const,
    }));
    const out = buildSubjectLabels(subs).split('\n');
    expect(out).toHaveLength(9);
    expect(out[8]).toContain('<Picture 9>');
  });
});

describe('buildSubjectLabels — traits 具体特征(2026-10-09 实测漂移修复)', () => {
  /* 实测:只写笼统的 `identity lock: face, hair, outfit` 时,
     角色卡是「黑色短发 + 黑夹克」→ 出片「黑色爆炸头 + 黑皮衣」;
     另一角色卡「金色马尾 + 黑战术服」→ 出片「金色盘发 + 红外套」。
     颜色/大色块能对上,发型与服装款式会漂 → 必须逐条列出特征。 */

  it('给了 traits → 逐条列出并用 must match exactly', () => {
    const out = buildSubjectLabels([
      { name: '苏青', kind: 'character', traits: '黑色齐耳短发、黑色皮夹克' },
    ]);
    expect(out).toContain('must match exactly');
    expect(out).toContain('黑色齐耳短发、黑色皮夹克');
  });

  it('角色标签带「不许改」硬约束(含糊的 lock 力度不够)', () => {
    const out = buildSubjectLabels([{ name: '苏青', kind: 'character', traits: '黑色短发' }]);
    expect(out).toContain('Do not change');
    expect(out).toContain('hairstyle');
  });

  it('场景 traits → must match exactly + 具体地标', () => {
    const out = buildSubjectLabels([
      { name: '机翼', kind: 'scene', traits: '波音777机翼、日落暖橙光、舱门缝在左上' },
    ]);
    expect(out).toContain('scene lock — must match exactly');
    expect(out).toContain('舱门缝在左上');
  });

  it('不给 traits → 退回原来的通用槽位说明(向后兼容,不倒退成空标签)', () => {
    const out = buildSubjectLabels([{ name: '苏青', kind: 'character' }]);
    expect(out).toContain('identity lock: face, hair, outfit');
    expect(out).toContain('Do not change'); // 硬约束仍在
  });

  it('traits 为空白 → 与不给等价', () => {
    const a = buildSubjectLabels([{ name: '苏青', kind: 'character', traits: '   ' }]);
    expect(a).toContain('identity lock: face, hair, outfit');
    expect(a).not.toContain('must match exactly');
  });

  it('traits 也要裁掉前后空白', () => {
    const out = buildSubjectLabels([
      { name: '苏青', kind: 'character', traits: '  黑色短发  ' },
    ]);
    expect(out).toContain('must match exactly: 黑色短发)');
  });
});

describe('buildRetentionAnalysis — 官方保留关系段(2026-10-09 补)', () => {
  /* 背景:官方 Ref2VA 骨架把「参考素材保留关系」单列一段,逐主体声明保留强度。
     只写一句笼统的 identity lock 时,模型收到的是「请保持一致」这种**无强度**的要求。
     真实事故:角色卡定义为「深灰战术背心」,提示词却在 4 处反复写 `red coat`,
     参考图与文字冲突 → 锁不住。 */

  it('角色 → fully_preserved,逐项列出保留内容', () => {
    const out = buildRetentionAnalysis([{ name: '苏青', kind: 'character' }]);
    expect(out).toContain('retention_analysis:');
    expect(out).toContain('<Subject 1>');
    expect(out).toContain('fully_preserved');
    expect(out).toContain('face, hairstyle, hair color, outfit design, and body proportions');
    expect(out).toContain('<Picture 1>');
  });

  it('场景 → 保留的是布局/地标/光位(而非逐像素照搬)', () => {
    const out = buildRetentionAnalysis([{ name: '机翼', kind: 'scene' }]);
    expect(out).toContain('fully_preserved');
    expect(out).toContain('spatial layout, landmarks, and lighting direction');
  });

  it('编号与 subject 顺序一致(错位比不写更糟)', () => {
    const out = buildRetentionAnalysis([
      { name: 'A', kind: 'character' },
      { name: 'B', kind: 'character' },
    ]);
    const lines = out.split('\n');
    expect(lines[1]).toContain('<Subject 1>');
    expect(lines[1]).toContain('<Picture 1>');
    expect(lines[2]).toContain('<Subject 2>');
    expect(lines[2]).toContain('<Picture 2>');
  });

  it('空 / 无参数 → 空串(调用方据此不插入该段)', () => {
    expect(buildRetentionAnalysis(undefined)).toBe('');
    expect(buildRetentionAnalysis([])).toBe('');
    expect(buildRetentionAnalysis([{ name: '  ', kind: 'character' }])).toBe('');
  });

  it('可指定镜头标签(默认 [Shot 1])', () => {
    const out = buildRetentionAnalysis([{ name: '苏青', kind: 'character' }], ['[Shot 1]', '[Shot 2]']);
    expect(out).toContain('appears in [Shot 1], [Shot 2]');
  });

  it('空白名条目被跳过,不占编号(与 buildSubjectLabels 同口径)', () => {
    const out = buildRetentionAnalysis([
      { name: '   ', kind: 'character' },
      { name: '苏青', kind: 'character' },
    ]);
    /* retention_analysis 只引 `<Subject n>`,**不重复写名字** ——
       名字已在 subject_definitions 段定义(官方结构如此:同一主体两处措辞漂移会导致指代不一致)。
       这里锁的是「空白条目没占掉 1 号」。 */
    expect(out).toContain('<Subject 1>');
    expect(out).not.toContain('<Subject 2>');
  });
});

describe('assembleH3Prompt — Ref2VA 镜(带参考素材)', () => {
  it('走 h3 官方分段结构:subject_definitions → retention_analysis → 正文 → 声音段', () => {
    const { text } = assembleH3Prompt(ROW, HEAD, '写实电影感', [
      { name: '苏青', kind: 'character' },
      { name: '机翼', kind: 'scene' },
    ]);
    // 官方 Ref2VA 骨架的固定段名(模型按段名解析,不能自造)
    expect(text).toContain('subject_definitions:');
    expect(text).toContain('retention_analysis:');
    expect(text).toContain('detailed_description:');
    expect(text).toContain('overall_soundscape:');
    expect(text).toContain('non_diegetic_music:');
    // 段序:subject_definitions 在最前,detailed_description 在其后
    expect(text.indexOf('subject_definitions:')).toBeLessThan(text.indexOf('retention_analysis:'));
    expect(text.indexOf('retention_analysis:')).toBeLessThan(text.indexOf('detailed_description:'));
    expect(text.indexOf('detailed_description:')).toBeLessThan(text.indexOf('overall_soundscape:'));
  });

  it('两个主体都出现在 subject_definitions 里,编号连续', () => {
    const { text } = assembleH3Prompt(ROW, HEAD, '写实', [
      { name: '苏青', kind: 'character' },
      { name: '机翼', kind: 'scene' },
    ]);
    expect(text).toContain('<Subject 1>');
    expect(text).toContain('<Subject 2>');
    // 标签段在正文段之前(官方结构:先定义主体,再描述画面)
    expect(text.indexOf('<Subject 1>')).toBeLessThan(text.indexOf('detailed_description:'));
  });

  it('正文与运镜仍在(detailed_description 段内)', () => {
    const { text } = assembleH3Prompt(ROW, HEAD, '写实电影感', [{ name: '苏青', kind: 'character' }]);
    // 官方分段结构里正文以 [Shot 1] 起头(不再是自造的 Scene: 前缀)
    expect(text).toContain('[Shot 1] 机翼上两人对峙');
    expect(text).toContain('Camera: 远景 · 航拍侧移');
    expect(text).toContain('Look: 写实电影感');
    expect(text).toContain('Action: 无对白');
  });

  it('不传 subjects(FL2VA 镜)→ 与旧行为完全一致,仍是五段式', () => {
    const withOut = assembleH3Prompt(ROW, HEAD, '写实电影感');
    expect(withOut.text).not.toContain('<Subject');
    expect(withOut.text).not.toContain('<Picture');
    expect(withOut.text).not.toContain('retention_analysis');
    expect(withOut.text.startsWith('Scene: ')).toBe(true);
  });

  it('传空数组 → 同样无标签段(等价于不传)', () => {
    const a = assembleH3Prompt(ROW, HEAD, '写实', []);
    const b = assembleH3Prompt(ROW, HEAD, '写实');
    expect(a.text).toBe(b.text);
  });

  it('全空白名字 → 退回无标签(不产出半截标签段)', () => {
    const { text } = assembleH3Prompt(ROW, HEAD, '写实', [{ name: '   ', kind: 'character' }]);
    expect(text).not.toContain('<Subject');
    expect(text.startsWith('Scene: ')).toBe(true);
  });

  it('explicit(表格「提示词(可选)」有值)→ 尊重作者原文,不注入标签段', () => {
    const head = [...HEAD, '提示词(可选)'];
    const row = [...ROW, '作者自己写的提示词 <Subject 1> is X in <Picture 1>.'];
    const { explicit, text } = assembleH3Prompt(row, head, '写实', [{ name: '苏青', kind: 'character' }]);
    expect(explicit).toBe(true);
    expect(text).toBe('作者自己写的提示词 <Subject 1> is X in <Picture 1>.');
    // 不得被自动标签覆盖/追加
    expect(text).not.toContain('[object');
  });
});

describe('assembleH3Prompt — 回归:原有五段结构不变', () => {
  it('对白镜仍走「对白「xxx」」形态', () => {
    const head = ['镜号', '画面描述', '对白/旁白', '景别', '运镜', '时长(s)', '需配图'];
    const row = ['1', '两人对视', '你来了', '近景', '慢推', '3', '是'];
    const { text } = assembleH3Prompt(row, head, '写实');
    expect(text).toContain('Action: 对白「你来了」');
    expect(text).toContain('Audio: 口型同步 · 环境音');
  });

  it('无对白镜保持「无对白」文案', () => {
    const { text } = assembleH3Prompt(ROW, HEAD, '写实');
    expect(text).toContain('Action: 无对白 · 以肢体动作推进');
    expect(text).toContain('Audio: 环境音 · 水声与风声');
  });

  it('basePrompt 缺省兜底不变', () => {
    const { text } = assembleH3Prompt(ROW, HEAD);
    expect(text).toContain('Look: 电影感，自然光影，写实');
  });
});
