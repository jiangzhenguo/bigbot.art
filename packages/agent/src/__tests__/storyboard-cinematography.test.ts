/** storyboard.plan 两条产表路径的扩展列回归(LLM 映射 + 确定性兜底)。 */
import { describe, expect, it } from 'vitest';
import { STORYBOARD_HEAD, parseGfmTable, rowCell } from '@bigbotart/shared';
import { planStoryboardDeterministic } from '../plan';
import { PiPlanner, type LlmStoryboardOutput } from '../pi-planner';
import type { PlanStoryboardParams, PlanStoryboardResult } from '../protocol';

function dataOf(node: { data: unknown }): Record<string, unknown> {
  return node.data as Record<string, unknown>;
}

function tableOf(result: PlanStoryboardResult) {
  const table = parseGfmTable(String(dataOf(result.storyboard).markdown ?? ''));
  expect(table).not.toBeNull();
  return table!;
}

describe('planStoryboardDeterministic — 扩展列兜底', () => {
  it('每行都按完整 22 列表头落盘;扩展列留空而不挤占核心列', () => {
    const result = planStoryboardDeterministic({
      brief: '她推门。她看到桌上的信。她停下呼吸。',
      autoMaterialize: true,
    });
    const table = tableOf(result);
    expect(table.head).toEqual([...STORYBOARD_HEAD]);
    expect(table.rows.length).toBeGreaterThan(0);
    for (const row of table.rows) {
      expect(row).toHaveLength(22);
      expect(rowCell(row, table.head, '景别')).toBe('中景');
      expect(rowCell(row, table.head, '运镜')).toBe('固定');
      expect(rowCell(row, table.head, '焦段')).toBe('');
      expect(rowCell(row, table.head, '站位(blocking)')).toBe('');
    }
    expect(result.shots.length).toBe(table.rows.length);
    for (const shot of result.shots) {
      const prompt = String(dataOf(shot).prompt ?? '');
      expect(prompt).toContain('Shot Size: 中景');
      expect(prompt).toContain('Movement: 固定');
      expect(prompt).not.toContain('Camera:');
      expect(prompt).not.toContain('Horizontal Angle:');
    }
  });
});

describe('PiPlanner.toStoryboardPlanResult — LLM 扩展字段映射', () => {
  it('JSON 扩展字段逐列映射,站位键映射到站位(blocking),并进入铺节点提示词', () => {
    const out: LlmStoryboardOutput = {
      title: '信件',
      intro: '两切揭示信息',
      basePrompt: '写实',
      report: '完成',
      rows: [
        {
          画面描述: '女主推开门，看到桌上的信',
          对白: '别回头',
          景别: '中景',
          运镜: '缓慢推近',
          时长: 3,
          需配图: true,
          衔接: '硬切',
          角色: '女主',
          焦段: '标准，中浅景深',
          水平角度: '斜侧 3/4',
          机位高度: '平视',
          构图: '门框负空间',
          视线: '信纸抬头',
          焦点: '门把手',
          稳定性: '微晃',
          光位: '走廊冷白顶光',
          声景: '纸张摩擦声',
          配乐: '低速弦乐',
          站位: '女主在画面左，距桌三步',
          节拍: '揭示信的存在',
        },
      ],
    };
    const planner = new PiPlanner() as unknown as {
      toStoryboardPlanResult(params: PlanStoryboardParams, output: LlmStoryboardOutput): PlanStoryboardResult;
    };
    const result = planner.toStoryboardPlanResult({ brief: 'ignored', basePrompt: '写实', autoMaterialize: true }, out);
    const table = tableOf(result);
    expect(table.rows).toHaveLength(1);
    const row = table.rows[0]!;
    expect(row).toHaveLength(22);
    const expected: Record<string, string> = {
      画面描述: '女主推开门，看到桌上的信',
      '对白/旁白': '别回头',
      焦段: '标准，中浅景深',
      水平角度: '斜侧 3/4',
      机位高度: '平视',
      构图: '门框负空间',
      视线: '信纸抬头',
      焦点: '门把手',
      稳定性: '微晃',
      光位: '走廊冷白顶光',
      声景: '纸张摩擦声',
      配乐: '低速弦乐',
      '站位(blocking)': '女主在画面左，距桌三步',
      节拍: '揭示信的存在',
    };
    for (const [column, value] of Object.entries(expected)) {
      expect(rowCell(row, table.head, column)).toBe(value);
    }

    const shotPrompt = String(dataOf(result.shots[0]!).prompt ?? '');
    expect(shotPrompt).toContain('Horizontal Angle: 斜侧 3/4');
    expect(shotPrompt).toContain('Blocking: 女主在画面左，距桌三步');
    expect(shotPrompt).toContain('Audio: 口型同步 · 纸张摩擦声');
    expect(shotPrompt).toContain('Music: 低速弦乐');
    expect(shotPrompt).not.toContain('揭示信的存在');

    const imagePrompt = String(dataOf(result.images[0]!).prompt ?? '');
    expect(imagePrompt).toContain('焦段:标准，中浅景深');
    expect(imagePrompt).toContain('站位:女主在画面左，距桌三步');
    expect(imagePrompt).toContain('走廊冷白顶光');
  });

  it('LLM 未给扩展字段时全部留空,不虚构摄影参数', () => {
    const out: LlmStoryboardOutput = {
      title: '旧格式',
      intro: '',
      report: '',
      rows: [{ 画面描述: '她开门', 衔接: '硬切' }],
    };
    const planner = new PiPlanner() as unknown as {
      toStoryboardPlanResult(params: PlanStoryboardParams, output: LlmStoryboardOutput): PlanStoryboardResult;
    };
    const result = planner.toStoryboardPlanResult({ brief: 'ignored' }, out);
    const table = tableOf(result);
    const row = table.rows[0]!;
    expect(row).toHaveLength(22);
    expect(rowCell(row, table.head, '景别')).toBe('中景');
    expect(rowCell(row, table.head, '运镜')).toBe('固定');
    expect(rowCell(row, table.head, '焦段')).toBe('');
    expect(rowCell(row, table.head, '声景')).toBe('');
  });
});
