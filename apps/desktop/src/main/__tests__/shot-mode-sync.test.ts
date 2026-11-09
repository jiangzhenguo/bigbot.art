/**
 * 镜头 mode 与连线同步(2026-10-12「测试技能2」事故回归)
 *
 * 事故:连了 ref-image 但 mode 停在 text2video → UI 显示「文生」、
 * 检查器按文生过滤参考槽;角色卡未建、七镜并行。
 */
import { describe, expect, it } from 'vitest';
import type { CanvasEdge, CanvasNode } from '@bigbotart/shared';
import {
  applyShotModeSyncOnConnect,
  healShotModeFromRefs,
  healStaleRefImageLock,
  syncShotModeForEdgeLabel,
} from '../tool-handlers';

const shot = (data: Record<string, unknown>): CanvasNode =>
  ({
    id: 's1',
    kind: 'shot',
    label: '镜头 01',
    position: { x: 0, y: 0 },
    width: 240,
    data,
    createdAt: 't',
    updatedAt: 't',
  }) as CanvasNode;

describe('syncShotModeForEdgeLabel', () => {
  it('ref-image → text2video 切到 ref-image', () => {
    const next = syncShotModeForEdgeLabel({ mode: 'text2video' }, 'ref-image');
    expect(next?.mode).toBe('ref-image');
  });

  it('first-frame → text2video 切到 first-frame', () => {
    const next = syncShotModeForEdgeLabel({ mode: 'text2video' }, 'first-frame');
    expect(next?.mode).toBe('first-frame');
  });

  it('modeOverride 时不动', () => {
    expect(syncShotModeForEdgeLabel({ mode: 'text2video', modeOverride: true }, 'ref-image')).toBeNull();
  });
});

describe('applyShotModeSyncOnConnect', () => {
  it('仅 ref-image 边 ⇒ mode=ref-image', () => {
    const n = shot({ mode: 'text2video' });
    const edges: CanvasEdge[] = [{ id: 'e1', source: 'g1', target: 's1', label: 'ref-image' }];
    expect(applyShotModeSyncOnConnect(n, edges, 'ref-image')).toBe(true);
    expect((n.data as { mode: string }).mode).toBe('ref-image');
  });

  it('同时有 first-frame 边时优先 first-frame', () => {
    const n = shot({ mode: 'text2video' });
    const edges: CanvasEdge[] = [
      { id: 'e1', source: 'g1', target: 's1', label: 'first-frame' },
      { id: 'e2', source: 'g2', target: 's1', label: 'ref-image' },
    ];
    expect(applyShotModeSyncOnConnect(n, edges, 'ref-image')).toBe(true);
    expect((n.data as { mode: string }).mode).toBe('first-frame');
  });

  it('非 shot 节点返回 false', () => {
    const n = { ...shot({}), kind: 'image-gen' } as CanvasNode;
    expect(applyShotModeSyncOnConnect(n, [], 'ref-image')).toBe(false);
  });

  it('过期的 ref-image 锁:只剩 first-frame 时改回首帧', () => {
    const n = shot({ mode: 'ref-image', modeOverride: true });
    const edges: CanvasEdge[] = [{ id: 'e1', source: 'still', target: 's1', label: 'first-frame' }];
    expect(applyShotModeSyncOnConnect(n, edges, 'first-frame')).toBe(true);
    expect((n.data as { mode: string; modeOverride?: boolean }).mode).toBe('first-frame');
    expect((n.data as { modeOverride?: boolean }).modeOverride).toBe(true);
  });

  it('ref-image 锁还连着参考图时不改', () => {
    const n = shot({ mode: 'ref-image', modeOverride: true });
    const edges: CanvasEdge[] = [{ id: 'e1', source: 'card', target: 's1', label: 'ref-image' }];
    expect(applyShotModeSyncOnConnect(n, edges, 'ref-image')).toBe(false);
    expect((n.data as { mode: string }).mode).toBe('ref-image');
  });
});

describe('healShotModeFromRefs', () => {
  it('有 ref-image、无 first-frame、mode 文生 → 愈合为 ref-image', () => {
    const next = healShotModeFromRefs({ mode: 'text2video' }, [{ role: 'ref-image' }]);
    expect(next?.mode).toBe('ref-image');
  });

  it('有 first-frame 时优先生效', () => {
    const next = healShotModeFromRefs(
      { mode: 'text2video' },
      [{ role: 'first-frame' }, { role: 'ref-image' }],
    );
    expect(next?.mode).toBe('first-frame');
  });

  it('已是正确 mode 不改写', () => {
    expect(healShotModeFromRefs({ mode: 'ref-image' }, [{ role: 'ref-image' }])).toBeNull();
  });

  it('modeOverride 不愈合', () => {
    expect(
      healShotModeFromRefs({ mode: 'text2video', modeOverride: true }, [{ role: 'ref-image' }]),
    ).toBeNull();
  });
});

describe('healStaleRefImageLock', () => {
  it('锁住的 ref-image 只有首帧时改回 first-frame', () => {
    const next = healStaleRefImageLock(
      { mode: 'ref-image', modeOverride: true },
      [{ role: 'first-frame' }],
    );
    expect(next?.mode).toBe('first-frame');
    expect(next?.modeOverride).toBe(true);
  });

  it('还有 ref-image 或用户锁的是文生时不动', () => {
    expect(
      healStaleRefImageLock({ mode: 'ref-image', modeOverride: true }, [{ role: 'ref-image' }]),
    ).toBeNull();
    expect(
      healStaleRefImageLock({ mode: 'text2video', modeOverride: true }, [{ role: 'first-frame' }]),
    ).toBeNull();
  });
});
