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
import { pickTakeResultPath, latestTakeResultByNode } from '../inspector/useTakeResult';
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

/* ═══ 2026-10 事故回归 3:video-upscale 长任务期间离开画布页 → 节点 data 没回写 ═══
 *
 * 事故形态(飞机1 · new1-gta1):视频增强跑了 82 分钟(22:54→00:16),期间用户离开画布页,
 * 完成时渲染层那次 `setNodes` 落在已卸载组件上被丢弃 —— 而 Take 已由同一次回写流程写进主进程
 * (磁盘上有 29MB 产物、Take 里 resultPath 完整)。节点 data 为空 ⇒ 节点卡/检查器都不显示。
 * 现在画布侧一次性拉全部 Take 归组,不只 shot:video-upscale / 图片类节点同样有兜底。 */
describe('latestTakeResultByNode · 全项目 Take → 每节点最新成功产物', () => {
  type Row = { shotNodeId?: string; status?: string; resultPath?: string };

  it('事故形态:video-upscale 节点的成功 Take 能被归到该节点(此前只有 shot 会被查)', () => {
    const takes: Row[] = [
      { shotNodeId: 'new1-gta1', status: 'succeeded', resultPath: '/out/video-post/timeline-post-1.mp4' },
    ];
    expect(latestTakeResultByNode(takes)).toEqual({ 'new1-gta1': '/out/video-post/timeline-post-1.mp4' });
  });

  it('同一节点多条历史:takesList 按 createdAt 倒序 → 先到者即最新', () => {
    const takes: Row[] = [
      { shotNodeId: 'n1', status: 'succeeded', resultPath: '/out/new.mp4' },
      { shotNodeId: 'n1', status: 'succeeded', resultPath: '/out/old.mp4' },
    ];
    expect(latestTakeResultByNode(takes)['n1']).toBe('/out/new.mp4');
  });

  it('最新一条是失败/无产物时不会顶掉更早的成功产物', () => {
    const takes: Row[] = [
      { shotNodeId: 'n1', status: 'failed' },
      { shotNodeId: 'n1', status: 'succeeded', resultPath: '/out/ok.mp4' },
      { shotNodeId: 'n1', status: 'running' },
    ];
    expect(latestTakeResultByNode(takes)['n1']).toBe('/out/ok.mp4');
  });

  it('缺 shotNodeId / 非成功 / 空路径一律跳过(不产生空串键,避免 rendered 裂图)', () => {
    const takes: Row[] = [
      { status: 'succeeded', resultPath: '/out/anon.mp4' },
      { shotNodeId: 'n2', status: 'queued' },
      { shotNodeId: 'n3', status: 'succeeded', resultPath: '' },
    ];
    expect(latestTakeResultByNode(takes)).toEqual({});
  });

  it('多节点各自归组;空/undefined 输入 → 空表(不抛)', () => {
    const takes: Row[] = [
      { shotNodeId: 'a', status: 'succeeded', resultPath: '/o/a.mp4' },
      { shotNodeId: 'b', status: 'succeeded', resultPath: '/o/b.png' },
      { shotNodeId: 'a', status: 'failed' },
    ];
    expect(latestTakeResultByNode(takes)).toEqual({ a: '/o/a.mp4', b: '/o/b.png' });
    expect(latestTakeResultByNode([])).toEqual({});
    expect(latestTakeResultByNode(undefined)).toEqual({});
  });
});
