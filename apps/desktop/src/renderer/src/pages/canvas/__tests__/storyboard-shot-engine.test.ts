/**
 * 分镜表铺出的 shot 必须走真实 h3。
 *
 * 历史事故(2026-10-28):renderMode=real、h3 就绪,但这条路径把 data.engine
 * 写死成 mock,只产出 1 秒占位 MP4。这里直接测构造器行为,不再扫描 CanvasPage 源码。
 */
import { describe, expect, it } from 'vitest';
import type { MaterializeRowPlan } from '@bigbotart/shared';
import { materializedShotData } from '../storyboard';

describe('分镜表铺出的镜头必须走真实 h3', () => {
  it("data.engine 固定为 'h3c'，且带分镜行归属", () => {
    const plan = {
      rowNo: 3,
      strategy: 'ref',
      shotMode: 'ref-image',
      modeOverride: true,
      createKeyframe: false,
      keyframeAs: 'ref-image',
      refNodeIds: [],
      subjects: [],
    } as MaterializeRowPlan;
    const data = materializedShotData({
      prompt: 'H3 提示词',
      plan,
      width: 1024,
      height: 576,
      seconds: 5,
      frames: 121,
      tier: 'default',
      seed: 44,
      storyboardId: 'sb-1',
    });
    expect(data.engine).toBe('h3c');
    expect(data.engine).not.toBe('mock');
    expect(data.mode).toBe('ref-image');
    expect(data.modeOverride).toBe(true);
    expect(data.prompt).toBe('H3 提示词');
    expect(data.storyboardId).toBe('sb-1');
    expect(data.storyboardRow).toBe(3);
    /* 单切不写段/多行归属,老画布结构保持不变 */
    expect(data.segment).toBeUndefined();
    expect(data.storyboardRows).toBeUndefined();
  });

  it('段内多切:节点带 segment 切表与全部行号(与主进程同结构)', () => {
    const plan = {
      rowNo: 1,
      strategy: 'text',
      shotMode: 'text2video',
      modeOverride: false,
      createKeyframe: false,
      keyframeAs: 'first-frame',
      refNodeIds: [],
      subjects: [],
    } as MaterializeRowPlan;
    const cuts = [
      { rowNo: 1, seconds: 4, size: '中景', move: '固定' },
      { rowNo: 2, seconds: 3, size: '近景', move: '推' },
    ];
    const data = materializedShotData({
      prompt: '[Shot 1] …\n\n[Shot 2] At 00:04.000, …',
      plan,
      width: 1024,
      height: 576,
      seconds: 7,
      frames: 169,
      tier: 'default',
      seed: 42,
      storyboardId: 'sb-1',
      rows: [1, 2],
      segment: { rows: [1, 2], seconds: 7, cuts },
    });
    expect(data.seconds).toBe(7);
    expect(data.storyboardRows).toEqual([1, 2]);
    expect(data.segment).toEqual({ rows: [1, 2], seconds: 7, cuts });
  });
});
