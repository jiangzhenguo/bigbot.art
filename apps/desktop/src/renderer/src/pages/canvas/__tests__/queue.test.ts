import { describe, expect, it } from 'vitest';
import type { RenderJob } from '@bigbotart/shared';
import { activeQueueJobs, jobStatusLabel, slotLabel } from '../queue';

function job(partial: Partial<RenderJob> & Pick<RenderJob, 'id' | 'status'>): RenderJob {
  return {
    nodeId: 'n1',
    provider: 'h3c',
    slot: 'video',
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
    ...partial,
  };
}

describe('activeQueueJobs', () => {
  it('只保留排队与运行中,运行中排前', () => {
    const list = activeQueueJobs([
      job({ id: 'a', status: 'queued', createdAt: '2026-10-22T00:00:02.000Z' }),
      job({ id: 'b', status: 'succeeded' }),
      job({ id: 'c', status: 'running', createdAt: '2026-10-22T00:00:01.000Z' }),
      job({ id: 'd', status: 'cancelled' }),
      job({ id: 'e', status: 'queued', createdAt: '2026-10-22T00:00:00.000Z' }),
    ]);
    expect(list.map((j) => j.id)).toEqual(['c', 'e', 'a']);
  });
});

describe('文案', () => {
  it('slot / status 标签', () => {
    expect(slotLabel('video')).toBe('视频');
    expect(slotLabel('image')).toBe('图片');
    expect(jobStatusLabel(job({ id: '1', status: 'queued' }))).toBe('排队中');
    expect(jobStatusLabel(job({ id: '2', status: 'running', stage: 'denoise 3/8' }))).toBe('denoise 3/8');
  });
});
