/**
 * 「段」——一次生成里的多个切(调研改造第 4 步)。
 *
 * 三条不变量:
 *  1. 没写「段」的老表行为**逐字不变**(一行一镜一提交);
 *  2. 同段多行的提示词按累计时刻切镜(`[Shot 2] At 00:03.000,`),且单切时与原组装器逐字等价;
 *  3. 段是原子单位:半铺出的段拒铺,不猜半段。
 */
import { describe, expect, it } from 'vitest';
import {
  assembleH3Prompt,
  assembleH3SegmentPrompt,
  formatCutTime,
  type H3SegmentCut,
  STORYBOARD_HEAD,
} from '../prompt.js';
import {
  blockedSegmentMessage,
  existingShotByRow,
  groupMaterializeSegments,
  planStoryboardMaterializeRows,
  rowSegmentKey,
  storyboardLinkFields,
  storyboardLinkOf,
} from '../storyboard-materialize.js';
import { checkStoryboardSchema, storyboardSchemaGateMessage } from '../storyboard-schema.js';

const HEAD = [...STORYBOARD_HEAD] as string[];

function row(n: number, cells: Record<string, string> = {}): string[] {
  const base: Record<string, string> = {
    镜号: String(n),
    画面描述: `可见动作 ${n}`,
    景别: '中景',
    运镜: '固定',
    '时长(s)': '3',
    需配图: '否',
    衔接: '硬切',
    角色: '',
    ...cells,
  };
  return HEAD.map((name) => base[name] ?? '');
}

function table(rows: string[][]) {
  return { head: HEAD, rows };
}

describe('formatCutTime — H3 官方切点时刻', () => {
  it('秒 → mm:ss.mmm,毫秒补零', () => {
    expect(formatCutTime(0)).toBe('00:00.000');
    expect(formatCutTime(3)).toBe('00:03.000');
    expect(formatCutTime(3.5)).toBe('00:03.500');
    expect(formatCutTime(12.25)).toBe('00:12.250');
    expect(formatCutTime(65.4)).toBe('01:05.400');
  });

  it('非法/负数不炸,按 0 处理', () => {
    expect(formatCutTime(Number.NaN)).toBe('00:00.000');
    expect(formatCutTime(-4)).toBe('00:00.000');
  });
});

describe('rowSegmentKey — 段列识别', () => {
  /** 自定义表头:别名列不在默认表里,所以这里现造一张表来验识别能力 */
  const withHead = (columns: string[], value: string) =>
    rowSegmentKey(columns.map((c) => (c === columns[0] ? value : '')), columns);

  it('认 段 / 段号 / 分组 / segment,取第一个非空', () => {
    expect(rowSegmentKey(row(1, { 段: '1' }), HEAD)).toBe('1');
    expect(withHead(['段号', '镜号'], 'E01-02')).toBe('E01-02');
    expect(withHead(['分组', '镜号'], 'A')).toBe('A');
    expect(withHead(['segment', '镜号'], 's1')).toBe('s1');
  });

  it('没写段 → 空串(旧表行为)', () => {
    expect(rowSegmentKey(row(1), HEAD)).toBe('');
  });
});

describe('assembleH3SegmentPrompt — 多切提示词', () => {
  const cuts = (rows: string[][], seconds: number[]): H3SegmentCut[] =>
    rows.map((r, i) => ({ row: r, seconds: seconds[i] ?? 0 }));

  it('单切逐字等价于 assembleH3Prompt(存量提示词零漂移)', () => {
    const r = row(1, { 画面描述: '她在门口站住', '对白/旁白': '我回来了', 光位: '顶光' });
    const before = assembleH3Prompt(r, HEAD, '冷灰风格锁');
    const after = assembleH3SegmentPrompt([{ row: r, seconds: 3 }], HEAD, '冷灰风格锁');
    expect(after.text).toBe(before.text);
    expect(after.explicit).toBe(before.explicit);
  });

  it('三切:切点时刻 = 前序秒数累计,第 1 切不带时刻', () => {
    const rows = [row(1, { 画面描述: '推门' }), row(2, { 画面描述: '看信' }), row(3, { 画面描述: '抬头' })];
    const out = assembleH3SegmentPrompt(cuts(rows, [2, 2.5, 4]), HEAD);
    expect(out.text).toContain('[Shot 1] Scene: 推门');
    expect(out.text).toContain('[Shot 2] At 00:02.000, Scene: 看信');
    expect(out.text).toContain('[Shot 3] At 00:04.500, Scene: 抬头');
    expect(out.text).not.toContain('[Shot 1] At');
  });

  it('带参考素材时逐切成段,retention 声明覆盖全部切', () => {
    const rows = [row(1, { 画面描述: '她推门' }), row(2, { 画面描述: '她抬头' })];
    const out = assembleH3SegmentPrompt(cuts(rows, [3, 2]), HEAD, undefined, [
      { name: '苏青', kind: 'character' },
    ]);
    expect(out.text).toContain('[Shot 1] 她推门');
    expect(out.text).toContain('[Shot 2] At 00:03.000, 她抬头');
    expect(out.text).toContain('<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved');
    expect(out.text).toContain('subject_definitions:');
    expect(out.text).toContain('overall_soundscape:');
  });

  it('显式提示词按切保留原文', () => {
    const rows = [
      row(1, { 画面描述: 'a', '提示词(可选)': 'Hand-written shot 1 body.' }),
      row(2, { 画面描述: 'b' }),
    ];
    const out = assembleH3SegmentPrompt(cuts(rows, [3, 2]), HEAD);
    expect(out.text).toContain('[Shot 1] Hand-written shot 1 body.');
    expect(out.text).toContain('[Shot 2] At 00:03.000, Scene: b');
    expect(out.explicit).toBe(false);
  });

  it('空数组不炸', () => {
    expect(assembleH3SegmentPrompt([], HEAD).text).toBe('');
  });
});

describe('groupMaterializeSegments — 按段合成一次生成', () => {
  const plansOf = (rows: string[][]) =>
    planStoryboardMaterializeRows({ head: HEAD, rows, canvasNodes: [] });

  it('没写段:每行自成一段、单切(旧行为)', () => {
    const rows = [row(1), row(2)];
    const { segments, blocked } = groupMaterializeSegments({ ...table(rows), plans: plansOf(rows) });
    expect(blocked).toHaveLength(0);
    expect(segments).toHaveLength(2);
    expect(segments.every((s) => s.cuts.length === 1)).toBe(true);
    expect(segments[0]!.segmentKey).toBe('');
  });

  it('同段三行 → 一段三切,Σ秒 = 各切之和', () => {
    const rows = [
      row(1, { 段: '1', '时长(s)': '4' }),
      row(2, { 段: '1', '时长(s)': '3' }),
      row(3, { 段: '1', '时长(s)': '2', 衔接: '硬切' }),
    ];
    const { segments } = groupMaterializeSegments({ ...table(rows), plans: plansOf(rows) });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.rowNos).toEqual([1, 2, 3]);
    expect(segments[0]!.seconds).toBe(9);
    expect(segments[0]!.cuts.map((c) => c.seconds)).toEqual([4, 3, 2]);
  });

  it('段跨断续行也聚合(连续性由结构门报错,这里不猜)', () => {
    const rows = [row(1, { 段: '1' }), row(2, { 段: '2' }), row(3, { 段: '1' })];
    const { segments } = groupMaterializeSegments({ ...table(rows), plans: plansOf(rows) });
    const seg1 = segments.find((s) => s.segmentKey === '1')!;
    expect(seg1.rowNos).toEqual([1, 3]);
  });

  it('半铺出的段 → blocked,且不产出半段', () => {
    const rows = [row(1, { 段: '1' }), row(2, { 段: '1' }), row(3, { 段: '1' })];
    const plans = plansOf(rows).filter((p) => p.rowNo !== 2); // 第 2 镜已铺
    const { segments, blocked } = groupMaterializeSegments({
      ...table(rows),
      plans,
      doneRows: [2],
    });
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.segmentKey).toBe('1');
    expect(blocked[0]!.doneRowNos).toEqual([2]);
    expect(segments).toHaveLength(0);
    expect(blockedSegmentMessage(blocked)).toContain('原子单位');
  });

  it('整段已铺完 → 不产出、也不 blocked', () => {
    const rows = [row(1, { 段: '1' }), row(2, { 段: '1' })];
    const { segments, blocked } = groupMaterializeSegments({
      ...table(rows),
      plans: [],
      doneRows: [1, 2],
    });
    expect(segments).toHaveLength(0);
    expect(blocked).toHaveLength(0);
  });
});

describe('段的多行归属 — storyboardRows', () => {
  it('单行不写 storyboardRows;多行写入并按行查得同一个 shot', () => {
    const one = storyboardLinkFields('sb', 2);
    expect(one.storyboardRows).toBeUndefined();
    const many = storyboardLinkFields('sb', 1, [2, 3]);
    expect(many.storyboardRows).toEqual([1, 2, 3]);
    const link = storyboardLinkOf(many);
    expect(link?.rows).toEqual([1, 2, 3]);
    expect(storyboardLinkOf(one)).toEqual({ nodeId: 'sb', row: 2 });

    const map = existingShotByRow([{ id: 'shot-a', kind: 'shot', data: many }], 'sb');
    expect(map.get(1)).toBe('shot-a');
    expect(map.get(2)).toBe('shot-a');
    expect(map.get(3)).toBe('shot-a');
  });
});

describe('结构门 — segment 门', () => {
  it('同段行不连续 → error 并指出行号', () => {
    const rows = [row(1, { 段: '1' }), row(2, { 段: '2' }), row(3, { 段: '1' })];
    const issues = checkStoryboardSchema(table(rows));
    const seg = issues.filter((i) => i.gate === 'segment' && i.severity === 'error');
    expect(seg).toHaveLength(1);
    expect(seg[0]!.message).toContain('第 1、3 行');
    expect(storyboardSchemaGateMessage(issues)).toContain('段「1」');
  });

  it('段合计超过单次生成上限 → error', () => {
    const rows = [
      row(1, { 段: '1', '时长(s)': '8' }),
      row(2, { 段: '1', '时长(s)': '9' }),
    ];
    const issues = checkStoryboardSchema(table(rows));
    expect(issues.some((i) => i.gate === 'segment' && i.message.includes('超过单次生成上限'))).toBe(true);
  });

  it('段内第 2 切写接尾帧 → 只警告,不阻断', () => {
    const rows = [
      row(1, { 段: '1', '时长(s)': '3' }),
      row(2, { 段: '1', '时长(s)': '3', 衔接: '接尾帧' }),
    ];
    const issues = checkStoryboardSchema(table(rows));
    const warn = issues.filter((i) => i.gate === 'segment' && i.severity === 'warning');
    expect(warn).toHaveLength(1);
    expect(warn[0]!.message).toContain('按硬切处理');
    expect(storyboardSchemaGateMessage(issues, 'error')).toBe('');
  });

  it('合法段不产生任何 segment 问题', () => {
    const rows = [
      row(1, { 段: '1', '时长(s)': '5' }),
      row(2, { 段: '1', '时长(s)': '5', 衔接: '硬切' }),
      row(3, { 段: '2', '时长(s)': '5' }),
    ];
    const issues = checkStoryboardSchema(table(rows));
    expect(issues.filter((i) => i.gate === 'segment')).toHaveLength(0);
  });
});
