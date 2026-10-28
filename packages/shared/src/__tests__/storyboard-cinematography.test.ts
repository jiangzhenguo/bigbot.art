/**
 * 分镜表摄影/声音扩展列(2026-10-28,调研改造第 2 步)。
 * 重点回归:旧 10 列表不缺列报错、不按新列下标猜值;新字段只在有值时进入提示词。
 */
import { describe, expect, it } from 'vitest';
import {
  STORYBOARD_CORE_HEAD,
  STORYBOARD_EXTENDED_HEAD,
  STORYBOARD_HEAD,
  assembleH3Prompt,
  assembleZImagePrompt,
  defaultStoryboardMarkdown,
  rowCell,
} from '../prompt';
import { parseGfmTable } from '../table';

const cinematicValues: Record<string, string> = {
  镜号: '1',
  画面描述: '女主推开门，看到桌上的信',
  '对白/旁白': '别回头',
  景别: '中景',
  运镜: '缓慢推近（让观众读到信）',
  '时长(s)': '3',
  需配图: '是',
  '提示词(可选)': '',
  衔接: '硬切',
  角色: '女主',
  焦段: '标准，中浅景深',
  水平角度: '斜侧 3/4',
  机位高度: '平视',
  构图: '门框负空间',
  视线: '信纸抬头',
  焦点: '门把手',
  稳定性: '微晃',
  光位: '走廊冷白顶光，桌面暖台灯',
  声景: '纸张摩擦声与冰箱低鸣',
  配乐: '低速弦乐，60 BPM',
  '站位(blocking)': '女主在画面左，距桌三步',
  节拍: '揭示信的存在',
};

function cinematicRow(): { head: string[]; row: string[] } {
  const head = [...STORYBOARD_HEAD] as string[];
  return { head, row: head.map((name) => cinematicValues[name] ?? '') };
}

describe('STORYBOARD_HEAD — 扩展列与旧表兼容', () => {
  it('核心 10 列顺序不变，扩展 12 列只追加在尾部', () => {
    expect(STORYBOARD_HEAD).toHaveLength(22);
    expect([...STORYBOARD_HEAD.slice(0, 10)]).toEqual([...STORYBOARD_CORE_HEAD]);
    expect([...STORYBOARD_HEAD.slice(10)]).toEqual([...STORYBOARD_EXTENDED_HEAD]);
  });

  it('新分镜默认表的表头与数据行都是 22 列，核心默认值不漂移', () => {
    const table = parseGfmTable(defaultStoryboardMarkdown());
    expect(table).not.toBeNull();
    expect(table!.head).toHaveLength(22);
    expect(table!.rows).toHaveLength(1);
    expect(table!.rows[0]).toHaveLength(22);
    expect(rowCell(table!.rows[0], table!.head, '镜号')).toBe('1');
    expect(rowCell(table!.rows[0], table!.head, '时长(s)')).toBe('5');
    expect(rowCell(table!.rows[0], table!.head, '需配图')).toBe('是');
    expect(rowCell(table!.rows[0], table!.head, '衔接')).toBe('硬切');
  });

  it('旧 10 列短行读取扩展列返回空串，核心列不串位', () => {
    const head = [...STORYBOARD_CORE_HEAD] as string[];
    const row = ['1', '她开门', '无', '中景', '固定', '3', '否', '', '硬切', ''];
    expect(rowCell(row, head, '画面描述')).toBe('她开门');
    expect(rowCell(row, head, '角色')).toBe('');
    expect(rowCell(row, head, '焦段')).toBe('');
    expect(rowCell(row, head, '站位(blocking)')).toBe('');
  });
});

describe('assembleH3Prompt — 摄影/声音/站位扩展字段', () => {
  it('T2VA:Camera 拆成独立摄影行，声音与站位分别归段', () => {
    const { head, row } = cinematicRow();
    const { text } = assembleH3Prompt(row, head, '写实');
    expect(text).not.toContain('Camera:');
    expect(text).toContain('Shot Size: 中景');
    expect(text).toContain('Horizontal Angle: 斜侧 3/4');
    expect(text).toContain('Height: 平视');
    expect(text).toContain('Lens Intent: 标准，中浅景深');
    expect(text).toContain('Movement: 缓慢推近（让观众读到信）');
    expect(text).toContain('Composition: 门框负空间');
    expect(text).toContain('Eyeline: 信纸抬头');
    expect(text).toContain('Focus: 门把手');
    expect(text).toContain('Stability: 微晃');
    expect(text).toContain('Blocking: 女主在画面左，距桌三步');
    expect(text).toContain('Lighting: 走廊冷白顶光，桌面暖台灯');
    expect(text).toContain('Audio: 口型同步 · 纸张摩擦声与冰箱低鸣');
    expect(text).toContain('Music: 低速弦乐，60 BPM');
    // 节拍是规划/审阅元数据,不作为抽象画面指令注入。
    expect(text).not.toContain('揭示信的存在');
  });

  it('Ref2VA:沿用官方固定段名，声景与配乐进入正确声音段', () => {
    const { head, row } = cinematicRow();
    const { text } = assembleH3Prompt(row, head, '写实', [{ name: '女主', kind: 'character' }]);
    expect(text).toContain('Shot Size: 中景');
    expect(text).toContain('Horizontal Angle: 斜侧 3/4');
    expect(text).toContain('Blocking: 女主在画面左，距桌三步');
    expect(text).toContain('overall_soundscape: 口型同步的人声 · 纸张摩擦声与冰箱低鸣');
    expect(text).toContain('non_diegetic_music: 低速弦乐，60 BPM');
    expect(text).not.toContain('non_diegetic_music: N/A');
  });

  it('旧 10 列表:只拆景别与运镜，不补空的摄影/声音/站位行', () => {
    const head = [...STORYBOARD_CORE_HEAD] as string[];
    const row = ['1', '她开门', '无', '中景', '固定', '3', '否', '', '硬切', ''];
    const { text } = assembleH3Prompt(row, head, '写实');
    expect(text).toContain('Shot Size: 中景');
    expect(text).toContain('Movement: 固定');
    expect(text).toContain('Audio: 环境音');
    for (const absent of [
      'Camera:',
      'Horizontal Angle:',
      'Height:',
      'Lens Intent:',
      'Composition:',
      'Eyeline:',
      'Focus:',
      'Stability:',
      'Blocking:',
      'Lighting:',
      'Music:',
    ]) {
      expect(text).not.toContain(absent);
    }
  });

  it('Ref2VA 旧表没有配乐时仍写 N/A', () => {
    const head = [...STORYBOARD_CORE_HEAD] as string[];
    const row = ['1', '她开门', '无', '中景', '固定', '3', '否', '', '硬切', ''];
    const { text } = assembleH3Prompt(row, head, '写实', [{ name: '女主', kind: 'character' }]);
    expect(text).toContain('overall_soundscape: 环境音');
    expect(text).toContain('non_diegetic_music: N/A');
  });
});

describe('assembleZImagePrompt — 静帧继承同一行摄影决策', () => {
  it('构图、光位与站位进入六段式，声音字段不误入图片提示词', () => {
    const { head, row } = cinematicRow();
    const { text } = assembleZImagePrompt(row, head, '写实');
    expect(text).toContain('场景：女主推开门，看到桌上的信 · 站位:女主在画面左，距桌三步');
    expect(text).toContain('构图：中景 · 焦段:标准，中浅景深 · 水平角度:斜侧 3/4 · 机位高度:平视');
    expect(text).toContain('构图:门框负空间');
    expect(text).toContain('视线:信纸抬头');
    expect(text).toContain('焦点:门把手');
    expect(text).toContain('走廊冷白顶光，桌面暖台灯');
    expect(text).not.toContain('纸张摩擦声');
    expect(text).not.toContain('低速弦乐');
  });
});
