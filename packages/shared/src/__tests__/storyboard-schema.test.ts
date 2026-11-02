/**
 * 分镜表结构门(调研改造第 3 步)。
 * 公共 seam:checkStoryboardSchema —— 规划、主进程铺节点、渲染层铺节点共用。
 */
import { describe, expect, it } from 'vitest';
import { STORYBOARD_CORE_HEAD, STORYBOARD_HEAD } from '../prompt';
import { checkStoryboardSchema } from '../storyboard-schema';

const fullCinematic: Record<string, string> = {
  焦段: '标准，中浅景深',
  水平角度: '斜侧 3/4',
  机位高度: '平视',
  构图: '门框负空间',
  视线: '信纸抬头',
  焦点: '信纸抬头',
  稳定性: '稳定',
};

function row(head: string[], n: number, cells: Record<string, string> = {}): string[] {
  const base: Record<string, string> = {
    镜号: String(n),
    画面描述: `镜头 ${n} 的可见动作`,
    '对白/旁白': '无',
    景别: '中景',
    运镜: '固定',
    '时长(s)': '3',
    需配图: '否',
    衔接: n === 1 ? '硬切' : '接尾帧',
    角色: '女主',
    ...cells,
  };
  return head.map((name) => base[name] ?? '');
}

describe('checkStoryboardSchema · composition 门', () => {
  it('开始填写摄影字段后，逐镜要求六类构图信息完整并指名缺列', () => {
    const head = [...STORYBOARD_HEAD] as string[];
    const rows = [
      row(head, 1, fullCinematic),
      row(head, 2, { ...fullCinematic, 焦段: '', 视线: '', 机位高度: '' }),
    ];
    const issues = checkStoryboardSchema({ head, rows });
    const composition = issues.filter((i) => i.gate === 'composition' && i.severity === 'error');
    expect(composition).toHaveLength(1);
    expect(composition[0]).toMatchObject({ row: 2 });
    expect(composition[0]!.message).toContain('焦段');
    expect(composition[0]!.message).toContain('视线');
    expect(composition[0]!.message).toContain('机位高度');
  });

  it('旧 10 列表与扩展字段全空的兜底表不被构图门误伤', () => {
    const oldHead = [...STORYBOARD_CORE_HEAD] as string[];
    const oldRows = [row(oldHead, 1), row(oldHead, 2)];
    expect(checkStoryboardSchema({ head: oldHead, rows: oldRows }).filter((i) => i.gate === 'composition')).toEqual([]);

    const newHead = [...STORYBOARD_HEAD] as string[];
    const blankExtended = [row(newHead, 1), row(newHead, 2)];
    expect(checkStoryboardSchema({ head: newHead, rows: blankExtended }).filter((i) => i.gate === 'composition')).toEqual([]);
  });

  it('六类构图字段全部填写时不报构图错误', () => {
    const head = [...STORYBOARD_HEAD] as string[];
    const issues = checkStoryboardSchema({ head, rows: [row(head, 1, fullCinematic)] });
    expect(issues.filter((i) => i.gate === 'composition')).toEqual([]);
  });
});

describe('checkStoryboardSchema · cut-change 门', () => {
  it('硬切前后景别、水平角度、人物关系完全相同时只警告并建议合并', () => {
    const head = [...STORYBOARD_HEAD] as string[];
    const cells = { ...fullCinematic, '站位(blocking)': '女主在画面左，男主在画面右' };
    const issues = checkStoryboardSchema({
      head,
      rows: [row(head, 1, cells), row(head, 2, { ...cells, 衔接: '硬切' })],
    });
    const cuts = issues.filter((i) => i.gate === 'cut-change');
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({ row: 2, severity: 'warning' });
    expect(cuts[0]!.message).toContain('合并');
  });

  it('接尾帧、角度变化或人物关系变化都不误报无意义切点', () => {
    const head = [...STORYBOARD_HEAD] as string[];
    const cells = { ...fullCinematic, '站位(blocking)': '女主在画面左，男主在画面右' };
    const scenarios: Array<{ name: string; next: Record<string, string> }> = [
      { name: '接尾帧', next: { ...cells, 衔接: '接尾帧' } },
      { name: '角度变化', next: { ...cells, 衔接: '硬切', 水平角度: '正面' } },
      { name: '关系变化', next: { ...cells, 衔接: '硬切', '站位(blocking)': '女主走到画面中央，男主退到画外' } },
    ];
    for (const scenario of scenarios) {
      const issues = checkStoryboardSchema({ head, rows: [row(head, 1, cells), row(head, 2, scenario.next)] });
      expect(issues.filter((i) => i.gate === 'cut-change'), scenario.name).toEqual([]);
    }
  });

  it('旧表缺水平角度时未知不视为相同，不制造警告', () => {
    const head = [...STORYBOARD_CORE_HEAD] as string[];
    const issues = checkStoryboardSchema({ head, rows: [row(head, 1), row(head, 2, { 衔接: '硬切' })] });
    expect(issues.filter((i) => i.gate === 'cut-change')).toEqual([]);
  });
});

describe('checkStoryboardSchema · duration 门', () => {
  it('20 个汉字按 4 字/秒估算为 5 秒，超过 3 秒镜长时指名建议值', () => {
    const head = [...STORYBOARD_CORE_HEAD] as string[];
    const issues = checkStoryboardSchema({
      head,
      rows: [row(head, 1, { '对白/旁白': '一二三四五六七八九十一二三四五六七八九十', '时长(s)': '3' })],
    });
    const duration = issues.filter((i) => i.gate === 'duration' && i.severity === 'error');
    expect(duration).toHaveLength(1);
    expect(duration[0]).toMatchObject({ row: 1 });
    expect(duration[0]!.message).toContain('约 5');
    expect(duration[0]!.message).toContain('3');
    expect(duration[0]!.message).toContain('5');
  });

  it('单镜超过 15 秒上限时拒绝，并允许调用方显式调整上限', () => {
    const head = [...STORYBOARD_CORE_HEAD] as string[];
    const rows = [row(head, 1, { '时长(s)': '16' })];
    const issues = checkStoryboardSchema({ head, rows });
    expect(issues.filter((i) => i.gate === 'duration' && i.severity === 'error')).toHaveLength(1);
    expect(issues[0]!.message).toContain('15');
    expect(checkStoryboardSchema({ head, rows, maxShotSeconds: 20 }).filter((i) => i.gate === 'duration')).toEqual([]);
  });

  it('声明目标总时长时，全表合计必须在 ±15% 内并给出范围', () => {
    const head = [...STORYBOARD_CORE_HEAD] as string[];
    const rows = [row(head, 1), row(head, 2), row(head, 3)];
    const issues = checkStoryboardSchema({ head, rows, targetSeconds: 30 });
    const duration = issues.filter((i) => i.gate === 'duration' && i.severity === 'error');
    expect(duration).toHaveLength(1);
    expect(duration[0]!.message).toContain('9');
    expect(duration[0]!.message).toContain('25.5');
    expect(duration[0]!.message).toContain('34.5');
    expect(checkStoryboardSchema({ head, rows, targetSeconds: 9 }).filter((i) => i.gate === 'duration')).toEqual([]);
  });

  it('缺失、非数字或非正数镜长不能静默进入铺节点', () => {
    const head = [...STORYBOARD_CORE_HEAD] as string[];
    for (const invalid of ['', 'abc', '0', '-2']) {
      const issues = checkStoryboardSchema({ head, rows: [row(head, 1, { '时长(s)': invalid })] });
      const duration = issues.filter((i) => i.gate === 'duration' && i.severity === 'error');
      expect(duration, invalid || '(空)').toHaveLength(1);
      expect(duration[0]!.message).toContain('正数');
    }
  });
});
