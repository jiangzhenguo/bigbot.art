/**
 * useTakeResult 纯函数测试 —— 「Take 已落盘但节点不回写」事故回归(2026-09-29)
 *
 * 事故形态:节点 `pal7-lfy3` 的 Take 记录完整(status=succeeded、resultPath 有值、产物文件
 * 真实存在 1.4M PNG),但节点 `data.resultPath` 始终为空 → 检查器预览不显示、归档按钮失效。
 * 检查器此前**只读 data.resultPath**,没有任何 Take 兜底。
 *
 * `pickTakeResultPath` 是与 shot 节点 `takeResults` 同口径的兜底选择器:
 * 从 Take 历史里挑「最新一条 status=succeeded 且有 resultPath」的产物。
 */
import { describe, it, expect } from 'vitest';
import { pickTakeResultPath } from '../inspector/useTakeResult';
import { takeStatusLabel } from '../inspector/ImageTakeSection';

type T = { status?: string; resultPath?: string };

describe('pickTakeResultPath · 从 Take 历史挑最新成功产物', () => {
  it('典型场景:多条历史,取最后一条成功且有产物的', () => {
    const takes: T[] = [
      { status: 'failed' },
      { status: 'succeeded', resultPath: '/a/1.png' },
      { status: 'queued' },
      { status: 'succeeded', resultPath: '/a/2.png' },
    ];
    expect(pickTakeResultPath(takes)).toBe('/a/2.png');
  });

  it('事故形态:只有一条成功 Take(节点 data 没回写)→ 仍能取到产物', () => {
    const takes: T[] = [{ status: 'succeeded', resultPath: '/out/pal7-lfy3_mlgen.png' }];
    expect(pickTakeResultPath(takes)).toBe('/out/pal7-lfy3_mlgen.png');
  });

  it('成功的 Take 但无 resultPath(如失败后重跑未完成)→ 跳过它', () => {
    const takes: T[] = [
      { status: 'succeeded', resultPath: '/a/old.png' },
      { status: 'succeeded' }, // 无产物
    ];
    expect(pickTakeResultPath(takes)).toBe('/a/old.png');
  });

  it('只有排队/运行中的 Take → 无兜底(不误报有产物)', () => {
    const takes: T[] = [{ status: 'queued' }, { status: 'running' }];
    expect(pickTakeResultPath(takes)).toBeUndefined();
  });

  it('全部失败 → undefined', () => {
    const takes: T[] = [{ status: 'failed' }, { status: 'failed' }];
    expect(pickTakeResultPath(takes)).toBeUndefined();
  });

  it('空历史 / undefined / 非数组 → undefined(不抛)', () => {
    expect(pickTakeResultPath([])).toBeUndefined();
    expect(pickTakeResultPath(undefined)).toBeUndefined();
    expect(pickTakeResultPath(null as unknown as T[])).toBeUndefined();
  });

  it('空字符串 resultPath 视为无产物(不返回空串导致 preview 裂图)', () => {
    const takes: T[] = [{ status: 'succeeded', resultPath: '' }];
    expect(pickTakeResultPath(takes)).toBeUndefined();
  });

  it('倒序查找:即使历史未按时间排序,也以数组末位为准(与 ImageTakeSection curTake 同口径)', () => {
    const takes: T[] = [
      { status: 'succeeded', resultPath: '/newest.png' },
      { status: 'succeeded', resultPath: '/older.png' },
    ];
    expect(pickTakeResultPath(takes)).toBe('/older.png');
  });
});

/* ═══ 2026-09-29 事故回归 2:Take 状态显示与「切换 Take 后预览消失」 ═══ */

describe('takeStatusLabel · 状态文案中文映射', () => {
  it('queued 必须显示「排队中」而不是裸英文 queued(用户会误判成卡住)', () => {
    expect(takeStatusLabel({ status: 'queued' })).toBe('排队中');
  });

  it('running → 生成中;cancelled → 已取消', () => {
    expect(takeStatusLabel({ status: 'running' })).toBe('生成中');
    expect(takeStatusLabel({ status: 'cancelled' })).toBe('已取消');
  });

  it('succeeded 有产物 → ✓;无产物 → ✓·无产物(不谎报成功)', () => {
    expect(takeStatusLabel({ status: 'succeeded', resultPath: '/a.png' })).toBe('✓');
    expect(takeStatusLabel({ status: 'succeeded' })).toBe('✓·无产物');
  });

  it('failed → ✗;未知状态原样回显(不吞)', () => {
    expect(takeStatusLabel({ status: 'failed' })).toBe('✗');
    expect(takeStatusLabel({ status: 'weird' })).toBe('weird');
    expect(takeStatusLabel({})).toBe('未知');
  });
});
