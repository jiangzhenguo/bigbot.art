import { describe, expect, it } from 'vitest';
import {
  applyParamValues,
  applyParamValuesDeep,
  paramDisplayLabel,
  paramTokenKey,
} from '../skill-params.js';

describe('paramTokenKey / paramDisplayLabel', () => {
  it('剥花括号', () => {
    expect(paramTokenKey('{game_title}')).toBe('game_title');
    expect(paramTokenKey('主题')).toBe('主题');
  });

  it('已知占位用中文标签', () => {
    expect(paramDisplayLabel('{game_title}')).toBe('游戏标题');
    expect(paramDisplayLabel('{player1_name}')).toBe('玩家1名称');
    expect(paramDisplayLabel('主题')).toBe('主题');
  });

  it('未知英文占位去下划线', () => {
    expect(paramDisplayLabel('{foo_bar_baz}')).toBe('foo bar baz');
  });
});

describe('applyParamValues', () => {
  it('替换已填占位', () => {
    const text = '游戏名 {game_title} · 风格 {visual_style}';
    expect(applyParamValues(text, { game_title: '双人冒险', '{visual_style}': '像素' })).toBe(
      '游戏名 双人冒险 · 风格 像素',
    );
  });

  it('未填默认清空(铺节点)', () => {
    expect(applyParamValues('A{x}B{y}', { x: '1' })).toBe('A1B');
  });

  it('keepUnfilled 保留未填占位(激活指令)', () => {
    expect(applyParamValues('A{x}B{y}', { x: '1' }, { keepUnfilled: true })).toBe('A1B{y}');
  });
});

describe('applyParamValuesDeep', () => {
  it('递归改 node.data 字符串', () => {
    const data = { prompt: '关于{主题}', nested: { t: '{时长}秒' }, tags: ['{a}', 'ok'] };
    expect(applyParamValuesDeep(data, { 主题: '河', 时长: '45', a: 'x' })).toEqual({
      prompt: '关于河',
      nested: { t: '45秒' },
      tags: ['x', 'ok'],
    });
  });
});
