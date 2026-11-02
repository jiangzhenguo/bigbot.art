/**
 * P0 回归:LLM 分镜单元格含换行时,GFM 序列化不得把数据行变成不可解析文本。
 * 真实事故:7 个分镜全部跨行,parseGfmTable 读成 0 行,materialize 假报「均已铺出」,
 * 模型只能手工建 7 镜、连 21 条边,最终烧满 20 个 LLM 工具轮次。
 */
import { describe, expect, it } from 'vitest';
import { STORYBOARD_HEAD, planStoryboardMaterializeRows } from '../index';
import { parseGfmTable, storyboardTableShapeIssue, tableToGfm, verifyGfmTableRoundTrip } from '../table';

describe('GFM 多行单元格 · 序列化/解析无损往返', () => {
  it('多行分镜单元格回读仍是 1 行、原文不丢,且能生成 1 个铺节点计划', () => {
    const head = [...STORYBOARD_HEAD] as string[];
    const description = '第一行可见动作\n第二行连续性衔接\n第三行资产锁定';
    const row = head.map((name) => ({
      镜号: '1',
      画面描述: description,
      '对白/旁白': '无',
      景别: '中景',
      运镜: '固定',
      '时长(s)': '5',
      需配图: '是',
      衔接: '硬切',
    } as Record<string, string>)[name] ?? '');

    const gfm = tableToGfm(head, [row]);
    const parsed = parseGfmTable(gfm);
    expect(parsed).not.toBeNull();
    expect(parsed!.rows).toHaveLength(1);
    expect(parsed!.rows[0]![head.indexOf('画面描述')]).toBe(description);

    const plans = planStoryboardMaterializeRows({ head: parsed!.head, rows: parsed!.rows });
    expect(plans).toHaveLength(1);
  });

  it('回读自检能拦住「生成 1 行、回读 0 行」的坏表，并对合法多行表返回 null', () => {
    const bad = [
      '| 镜号 | 画面描述 |',
      '|---|---|',
      '| 1 | 第一行动作',
      '第二行裸换行,不属于合法单行 GFM。',
    ].join('\n');
    const issue = verifyGfmTableRoundTrip(bad, 1, 2);
    expect(issue).toContain('生成 1 行');
    expect(issue).toContain('回读 0 行');

    const goodRow = ['1', '第一行动作\n第二行衔接'];
    const good = tableToGfm(['镜号', '画面描述'], [goodRow]);
    expect(verifyGfmTableRoundTrip(good, 1, 2)).toBeNull();
  });

  it('0 个有效数据行返回可执行错误，正常表返回 null', () => {
    expect(storyboardTableShapeIssue({ head: ['镜号', '画面描述'], rows: [] })).toContain('0 个有效数据行');
    expect(storyboardTableShapeIssue({ head: ['镜号', '画面描述'], rows: [] })).toContain('多行单元格');
    expect(storyboardTableShapeIssue({ head: ['镜号', '画面描述'], rows: [['1', '她开门']] })).toBeNull();
  });
});
