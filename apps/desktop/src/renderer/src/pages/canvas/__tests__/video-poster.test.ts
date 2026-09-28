/**
 * 视频封面帧抽取测试(P2)
 *
 * 「渲染视频时画布卡」的主因之一是画布上大量真实 <video> 元素 ——
 * 即使 preload="metadata"、从不播放,每个 video 仍要独立的媒体合成层
 * 与解码器上下文。extractPoster 把纯展示场景的 video 换成抽帧静态图。
 *
 * 用**依赖注入**测(extractPoster 的第三个参数),不引 jsdom:
 * 本项目 vitest 跑在 environment:'node' 且未装 jsdom,为一段状态机引一个
 * 大依赖不划算 —— 注入假 DOM 反而让失败分支(超时/解码错误/尺寸异常)
 * 更容易构造,而这些恰恰是最该被锁住的路径。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { extractPoster, type PosterDeps } from '../media.js';

/** 假 video:记录属性写入,并暴露触发事件的手段 */
interface FakeVideo {
  muted: boolean;
  playsInline: boolean;
  preload: string;
  crossOrigin: string;
  videoWidth: number;
  videoHeight: number;
  src: string;
  onloadeddata: (() => void) | null;
  onerror: (() => void) | null;
  removed: boolean;
  loadCalls: number;
  removeAttribute: (n: string) => void;
  load: () => void;
  fireLoad: () => void;
  fireError: () => void;
}

function makeDeps(opts: { w?: number; h?: number; behavior?: 'loaded' | 'error' | 'silent'; noCanvas?: boolean; throwInDraw?: boolean } = {}) {
  const videos: FakeVideo[] = [];
  let loadCalls = 0;
  let now = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let seq = 1;

  const deps: PosterDeps = {
    createVideo: () => {
      const v = {
        muted: false,
        playsInline: false,
        preload: '',
        crossOrigin: '',
        videoWidth: opts.w ?? 640,
        videoHeight: opts.h ?? 360,
        src: '',
        onloadeddata: null as (() => void) | null,
        onerror: null as (() => void) | null,
        removed: false,
        loadCalls: 0,
        removeAttribute: () => {
          v.removed = true;
        },
        load: () => {
          v.loadCalls += 1;
          loadCalls += 1;
        },
        fireLoad: () => v.onloadeddata?.(),
        fireError: () => v.onerror?.(),
      };
      // 赋值 src 后异步触发(模拟真实加载时序)
      Object.defineProperty(v, 'src', {
        set() {
          queueMicrotask(() => {
            if (opts.behavior === 'loaded' || opts.behavior === undefined) v.fireLoad();
            else if (opts.behavior === 'error') v.fireError();
            // 'silent' → 不触发,交给超时分支
          });
        },
        get: () => '',
      });
      videos.push(v);
      return v as unknown as HTMLVideoElement;
    },
    createCanvas: opts.noCanvas
      ? () => null
      : (w, h) => ({
          draw: () => {
            if (opts.throwInDraw) throw new Error('tainted canvas');
          },
          toDataURL: () => `data:image/jpeg;base64,CANVAS_${w}x${h}`,
        }),
    setTimeout: (fn, ms) => {
      const id = seq++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
  };

  /** 手动推进虚拟时钟,触发到期的超时回调 */
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
  };

  return { deps, videos, advance, get loadCalls() { return loadCalls; } };
}

/** 每个用例用独立 src 避开模块级缓存(缓存是刻意的产品行为,不 reset) */
let uid = 0;
const nextSrc = () => `bba-output://t${++uid}.mp4`;

describe('extractPoster — 成功路径', () => {
  it('抽帧成功返回 dataURL', async () => {
    const { deps } = makeDeps();
    expect(await extractPoster(nextSrc(), 8000, deps)).toBe('data:image/jpeg;base64,CANVAS_320x180');
  });

  it('按 320px 上限等比缩放(不按原尺寸出图,省内存)', async () => {
    const { deps } = makeDeps({ w: 1920, h: 1080 });
    expect(await extractPoster(nextSrc(), 8000, deps)).toBe('data:image/jpeg;base64,CANVAS_320x180');
  });

  it('源本身小于 320px 时不放大', async () => {
    const { deps } = makeDeps({ w: 160, h: 90 });
    expect(await extractPoster(nextSrc(), 8000, deps)).toBe('data:image/jpeg;base64,CANVAS_160x90');
  });

  it('抽帧后主动释放解码器(video.load 被调用 + src 被移除)', async () => {
    const { deps, videos } = makeDeps();
    await extractPoster(nextSrc(), 8000, deps);
    expect(videos).toHaveLength(1);
    expect(videos[0]!.loadCalls).toBeGreaterThan(0);
    expect(videos[0]!.removed).toBe(true);
  });

  it('同一 src 第二次调用命中缓存,不再创建 video', async () => {
    const { deps, videos } = makeDeps();
    const src = nextSrc();
    await extractPoster(src, 8000, deps);
    expect(videos).toHaveLength(1);
    expect(await extractPoster(src, 8000, deps)).toBe('data:image/jpeg;base64,CANVAS_320x180');
    expect(videos).toHaveLength(1); // 关键:没有新建 video 元素
  });

  it('并发请求同一 src 复用同一 promise(只挂一个 video)', async () => {
    const { deps, videos } = makeDeps();
    const src = nextSrc();
    const [a, b] = await Promise.all([extractPoster(src, 8000, deps), extractPoster(src, 8000, deps)]);
    expect(a).toBe(b);
    expect(videos).toHaveLength(1); // 并发没有导致重复抽帧
  });

  it('不同 src 各自抽帧(互不串味)', async () => {
    const { deps, videos } = makeDeps();
    await extractPoster(nextSrc(), 8000, deps);
    await extractPoster(nextSrc(), 8000, deps);
    expect(videos).toHaveLength(2);
  });
});

describe('extractPoster — 失败路径(必须回退而非挂起)', () => {
  it('video error → 返回 null(调用方据此回退真实 video)', async () => {
    const { deps } = makeDeps({ behavior: 'error' });
    expect(await extractPoster(nextSrc(), 8000, deps)).toBeNull();
  });

  it('解码超时 → 返回 null 而不是永远挂起', async () => {
    const { deps, advance } = makeDeps({ behavior: 'silent' });
    const p = extractPoster(nextSrc(), 100, deps);
    advance(200); // 推进虚拟时钟越过超时
    expect(await p).toBeNull();
  });

  it('超时路径同样会释放 video(不留后台解码器)', async () => {
    const { deps, advance, videos } = makeDeps({ behavior: 'silent' });
    const p = extractPoster(nextSrc(), 100, deps);
    advance(200);
    await p;
    expect(videos[0]!.loadCalls).toBeGreaterThan(0);
    expect(videos[0]!.removed).toBe(true);
  });

  it('videoWidth 为 0(元数据异常)→ 返回 null', async () => {
    const { deps } = makeDeps({ w: 0, h: 0 });
    expect(await extractPoster(nextSrc(), 8000, deps)).toBeNull();
  });

  it('拿不到 2d context → 返回 null', async () => {
    const { deps } = makeDeps({ noCanvas: true });
    expect(await extractPoster(nextSrc(), 8000, deps)).toBeNull();
  });

  it('canvas 被跨源污染(抛错)→ 返回 null 而非崩溃', async () => {
    const { deps } = makeDeps({ throwInDraw: true });
    expect(await extractPoster(nextSrc(), 8000, deps)).toBeNull();
  });

  it('失败结果不进缓存:同 src 之后仍可重新抽取', async () => {
    const src = nextSrc();
    const fail = makeDeps({ behavior: 'error' });
    expect(await extractPoster(src, 8000, fail.deps)).toBeNull();
    // 换一套可成功的 deps,同一 src 应重新尝试(而非命中「失败缓存」)
    const ok = makeDeps();
    expect(await extractPoster(src, 8000, ok.deps)).toBe('data:image/jpeg;base64,CANVAS_320x180');
  });

  it('失败后 pending 被清理:不会把 null 结果永久挂在同 src 上', async () => {
    const src = nextSrc();
    const fail = makeDeps({ behavior: 'error' });
    await extractPoster(src, 8000, fail.deps);
    const ok = makeDeps();
    const r1 = await extractPoster(src, 8000, ok.deps);
    const r2 = await extractPoster(src, 8000, ok.deps);
    expect(r1).toBe(r2);
    expect(ok.videos).toHaveLength(1); // 第二次命中缓存
  });
});

describe('extractPoster — 状态机只跑一次', () => {
  it('loadeddata 与 error 都到达时,只结算一次(先到者胜)', async () => {
    const { deps, videos } = makeDeps({ behavior: 'loaded' });
    const src = nextSrc();
    const url = await extractPoster(src, 8000, deps);
    // 再补一个 error 事件:不应改变已缓存的结果
    videos[0]!.fireError();
    expect(url).toBe('data:image/jpeg;base64,CANVAS_320x180');
    expect(await extractPoster(src, 8000, deps)).toBe('data:image/jpeg;base64,CANVAS_320x180');
  });
});

describe('VideoPoster 回退语义', () => {
  it('失败时回退 VideoThumb(源码含该分支)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'media.tsx'), 'utf8');
    expect(src).toMatch(/if \(failed\) return <VideoThumb/);
  });

  it('抽帧中渲染占位(不白屏、不跳布局)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'media.tsx'), 'utf8');
    expect(src).toMatch(/抽帧中/);
  });

  it('NodeBody 的分镜表封面已改用 VideoPoster(不再常驻 video)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'nodes', 'NodeBody.tsx'), 'utf8');
    expect(src).toMatch(/<VideoPoster/);
    // 分镜表那一格不应再有裸 <video>(外观检查:文件里已无 preload="metadata" 的内联 video)
    expect(src).not.toMatch(/preload="metadata"/);
  });
});
