import { describe, it, expect, vi } from 'vitest';
import { waitUntilFlightFree } from '../flight-turn';

describe('waitUntilFlightFree', () => {
  it('没人占坑时不取消', async () => {
    const cancel = vi.fn();
    await waitUntilFlightFree({
      isInFlight: () => false,
      cancel,
      currentTail: () => undefined,
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('占坑时先取消,等那一轮收尾后再返回', async () => {
    let flying = true;
    let release!: () => void;
    const tail = new Promise<void>((r) => {
      release = r;
    });
    const cancel = vi.fn();
    let done = false;
    const p = waitUntilFlightFree({
      isInFlight: () => flying,
      cancel,
      currentTail: () => tail,
    }).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(done).toBe(false);
    flying = false;
    release();
    await p;
    expect(done).toBe(true);
  });

  it('前一轮刚让出又被占上时,再取消并再等一次', async () => {
    let flying = true;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const second = new Promise<void>((r) => {
      releaseSecond = r;
    });
    const tails = [first, second];
    let reads = 0;
    const cancel = vi.fn();
    const p = waitUntilFlightFree({
      isInFlight: () => flying,
      cancel,
      currentTail: () => tails[reads++],
    });
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(2);
    flying = false;
    releaseSecond();
    await p;
  });

  it('占着坑但没有收尾承诺时立刻返回,避免空等', async () => {
    const cancel = vi.fn();
    await waitUntilFlightFree({
      isInFlight: () => true,
      cancel,
      currentTail: () => undefined,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
