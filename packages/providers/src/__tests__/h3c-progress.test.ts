/**
 * h3 进度解析单测 — A(解析)/ B(阶段加权 + 单调)/ C(停滞判定)
 *
 * 动机:原进度条是**时间估算**(elapsed/etaSec),与引擎实际进度无关 ——
 * 实测一个 864×480/8 步的任务真跑 9 分钟、累计 CPU 仅 42 秒(明显卡死),
 * 进度条却一路正常爬升。本模块改用 h3 stderr 的**真实进度行**:
 *     fprintf(stderr, "\r%-25s %4d/%-4d", phase, completed, total)
 */
import { describe, it, expect } from 'vitest';
import {
  parseProgressLine,
  splitProgressChunks,
  phaseBucket,
  phaseWeightedProgress,
  ProgressTracker,
  stallLevel,
  stallMessage,
  STALL_SUSPECT_MS,
  STALL_LIKELY_DEAD_MS,
} from '../h3c-progress.js';

describe('A · parseProgressLine', () => {
  it('解析典型进度行(阶段名 + done/total,含大量对齐空格)', () => {
    expect(parseProgressLine('denoise                    5/8')).toEqual({ phase: 'denoise', done: 5, total: 8 });
  });

  it('阶段名含空格也能解析(text encoder / video VAE load)', () => {
    expect(parseProgressLine('text encoder              32/50')).toEqual({ phase: 'text encoder', done: 32, total: 50 });
    expect(parseProgressLine('video VAE load             0/36')).toEqual({ phase: 'video VAE load', done: 0, total: 36 });
    expect(parseProgressLine('Qwen vision               12/24')).toEqual({ phase: 'Qwen vision', done: 12, total: 24 });
  });

  it('done/total 无空格也接受(denoise 6/8)', () => {
    expect(parseProgressLine('denoise 6/8')).toEqual({ phase: 'denoise', done: 6, total: 8 });
  });

  it('剥离 ANSI 转义序列', () => {
    expect(parseProgressLine('\u001b[32mdenoise 5/8\u001b[0m')).toEqual({ phase: 'denoise', done: 5, total: 8 });
  });

  it('空行/纯空白 → null', () => {
    expect(parseProgressLine('')).toBeNull();
    expect(parseProgressLine('   ')).toBeNull();
    expect(parseProgressLine('\r')).toBeNull();
  });

  it('非进度行 → null(普通日志必须能原样保留为错误信息)', () => {
    expect(parseProgressLine('h3: prompt must not be empty')).toBeNull();
    expect(parseProgressLine('Metal device: M5 Pro')).toBeNull();
    expect(parseProgressLine('loading weights...')).toBeNull();
  });

  it('非法数值 → null(不猜测)', () => {
    expect(parseProgressLine('denoise 9/8')).toBeNull(); // done > total
    expect(parseProgressLine('denoise 0/0')).toBeNull(); // total 为 0
    expect(parseProgressLine('denoise -1/8')).toBeNull(); // 负数
    expect(parseProgressLine('denoise abc/8')).toBeNull();
  });
});

describe('A · splitProgressChunks', () => {
  it('按 \\r 与 \\n 切分,尾部不完整片段留给下次', () => {
    const [parts, tail] = splitProgressChunks('denoise 1/8\rdenoise 2/8\rdenoise 3/');
    expect(parts).toEqual(['denoise 1/8', 'denoise 2/8']);
    expect(tail).toBe('denoise 3/'); // 关键:截断的尾段不能拿去解析
  });

  it('阶段结束的 \\n 也作为分隔', () => {
    const [parts, tail] = splitProgressChunks('tokenizer 1/1\ntext encoder 0/50\r');
    expect(parts).toEqual(['tokenizer 1/1', 'text encoder 0/50']);
    expect(tail).toBe('');
  });
});

describe('A · 流式边界(真实 stderr 行为)', () => {
  it('按任意位置切断的 chunk 喂入,最后一段必须在 close 时冲刷', () => {
    // 真实事故:h3 进度行以 \r 分隔,最后一行后可能无换行;
    // 不冲刷尾部会丢掉最后一条进度(实测少了 FFmpeg 124/124,停在 95% 而非 100%)
    const pad = (x: string, w: number) => x.padEnd(w);
    const emit = (p2: string, d: number, t: number) => `\r${pad(p2, 25)} ${String(d).padStart(4)}/${String(t).padEnd(4)}`;
    const stream = emit('denoise', 8, 8) + emit('FFmpeg', 124, 124); // 末尾无换行

    const tracker = new ProgressTracker(0);
    let tail = '';
    // 逐字节喂(最恶劣的切断)
    for (const ch of stream) {
      const [parts, t] = splitProgressChunks(tail + ch);
      tail = t;
      for (const raw of parts) tracker.pushLine(raw, 1000);
    }
    expect(tracker.progress).toBeLessThan(1); // 尾部还攥在手里
    // 冲刷尾部(等价 h3c.ts 的 child.on('close'))
    for (const raw of [tail]) tracker.pushLine(raw, 2000);
    expect(tracker.progress).toBeCloseTo(1, 6); // 补上 FFmpeg 后到 100%
  });

  it('非进度行与进度行混流时,两类都被正确处理(错误信息不丢)', () => {
    const tracker = new ProgressTracker(0);
    const kept: string[] = [];
    const feed = (raw: string) => {
      const ev = tracker.pushLine(raw, 1000);
      if (!ev && raw.trim()) kept.push(raw);
    };
    feed('denoise 3/8');
    feed('h3: prompt must not be empty');
    feed('Metal device: M5 Pro');
    feed('denoise 4/8');
    expect(tracker.stageText).toBe('denoise 4/8');
    expect(kept).toEqual(['h3: prompt must not be empty', 'Metal device: M5 Pro']);
  });
});

describe('B · phaseBucket', () => {
  it('只做 trim,不做桶合并(enqueue 是独立阶段)', () => {
    expect(phaseBucket('denoise')).toBe('denoise');
    expect(phaseBucket(' FFmpeg ')).toBe('FFmpeg');
    // enqueue 与 denoise 是**交错**的两个阶段(入队 vs 完成),不能并桶
    expect(phaseBucket('denoise enqueue')).toBe('denoise enqueue');
  });
});

describe('B · 交错阶段(denoise enqueue)不得造成进度回退', () => {
  it('enqueue 不参与进度计算(与 denoise 共享同一段进度)', () => {
    const t = new ProgressTracker(0);
    t.pushLine('denoise 5/8', 1000);
    const at5 = t.progress;
    // 交错来一条 enqueue(真实 h3 行为:每步入队与完成交替上报)
    t.pushLine('denoise enqueue 6/8', 2000);
    expect(t.progress).toBe(at5); // 不涨也不回退
    // 但 stageText 更新(UI 能如实显示当前在做什么)
    expect(t.stageText).toBe('denoise enqueue 6/8');
    // 下一条 denoise 继续推进
    t.pushLine('denoise 6/8', 3000);
    expect(t.progress).toBeGreaterThan(at5);
  });

  it('乱序(先 enqueue 后 denoise)也不回退', () => {
    const t = new ProgressTracker(0);
    t.pushLine('denoise 8/8', 1000);
    const high = t.progress;
    t.pushLine('denoise enqueue 1/8', 2000);
    expect(t.progress).toBe(high);
  });
});

describe('B · phaseWeightedProgress', () => {
  it('无事件 → 0', () => {
    expect(phaseWeightedProgress(null)).toBe(0);
  });

  it('阶段内进度：denoise 0/8 与 8/8 之间递增，8/8 时进入后续阶段起点', () => {
    const p0 = phaseWeightedProgress({ phase: 'denoise', done: 0, total: 8 });
    const p4 = phaseWeightedProgress({ phase: 'denoise', done: 4, total: 8 });
    const p8 = phaseWeightedProgress({ phase: 'denoise', done: 8, total: 8 });
    expect(p0).toBeLessThan(p4);
    expect(p4).toBeLessThan(p8);
  });

  it('跨阶段单调递增(按执行顺序推进)', () => {
    const seq = [
      { phase: 'tokenizer', done: 1, total: 1 },
      { phase: 'text encoder', done: 50, total: 50 },
      { phase: 'denoise', done: 0, total: 8 },
      { phase: 'denoise', done: 8, total: 8 },
      { phase: 'FFmpeg', done: 124, total: 124 },
    ];
    const vals = seq.map(phaseWeightedProgress);
    for (let i = 1; i < vals.length; i++) {
      expect(vals[i]!, `第 ${i} 步(${seq[i]!.phase})应大于前一步`).toBeGreaterThanOrEqual(vals[i - 1]!);
    }
    // 最后(编码完成)应到 100%
    expect(vals[vals.length - 1]).toBeCloseTo(1, 5);
  });

  it('跳过未执行的阶段(无 ref-image 就没有 Qwen vision)不产生负进度', () => {
    // tokenizer 完成后直接进 denoise:权重表按顺序把中间的算作"已走过"
    const skip = phaseWeightedProgress({ phase: 'denoise', done: 0, total: 8 });
    const withVision = phaseWeightedProgress({ phase: 'Qwen vision', done: 24, total: 24 });
    expect(skip).toBeGreaterThan(withVision); // 顺序上 denoise 在 vision 之后
  });

  it('未知阶段用兜底权重,不虚报为高档位', () => {
    const unknown = phaseWeightedProgress({ phase: 'some new phase', done: 1, total: 2 });
    expect(unknown).toBeGreaterThanOrEqual(0);
    expect(unknown).toBeLessThanOrEqual(1);
  });

  it('结果始终落在 0..1', () => {
    for (const phase of ['tokenizer', 'denoise', 'FFmpeg', 'unknown x']) {
      const v = phaseWeightedProgress({ phase, done: 1, total: 1 });
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('B · ProgressTracker 单调性', () => {
  it('进度永不回退(阶段切换/乱序 chunk 也不回退)', () => {
    const t = new ProgressTracker(0);
    t.pushLine('denoise 8/8', 1000);
    const high = t.progress;
    // 之后来了一个更早阶段的行(乱序/重试)→ 不得回退
    t.pushLine('text encoder 1/50', 2000);
    expect(t.progress).toBe(high);
  });

  it('stageText 反映最近一次事件(给 UI 显示真实阶段)', () => {
    const t = new ProgressTracker(0);
    t.pushLine('denoise 5/8', 1000);
    expect(t.stageText).toBe('denoise 5/8');
    t.pushLine('FFmpeg 10/124', 2000);
    expect(t.stageText).toBe('FFmpeg 10/124');
  });

  it('非进度行不污染状态(返回 null)', () => {
    const t = new ProgressTracker(0);
    expect(t.pushLine('h3: some warning', 1000)).toBeNull();
    expect(t.progress).toBe(0);
    expect(t.stageText).toBeUndefined();
  });

  it('stalledFor 只在进度真的前进时重置', () => {
    const t = new ProgressTracker(0);
    t.pushLine('denoise 3/8', 10_000);
    expect(t.stalledFor(20_000)).toBe(10_000);
    // 同一阶段的**重复**行(done 没变,如 UI 重绘)→ 不算前进
    t.pushLine('denoise 3/8', 30_000);
    expect(t.stalledFor(40_000)).toBe(30_000); // 仍从 10_000 起算
    // done 变大 → 前进,重置
    t.pushLine('denoise 4/8', 50_000);
    expect(t.stalledFor(60_000)).toBe(10_000);
  });

  it('阶段切换即使 done 变小也算前进(denoise 8/8 → FFmpeg 0/124)', () => {
    const t = new ProgressTracker(0);
    t.pushLine('denoise 8/8', 10_000);
    t.pushLine('FFmpeg 0/124', 20_000);
    expect(t.stalledFor(21_000)).toBe(1_000);
  });
});

describe('C · 停滞判定', () => {
  it('没解析到任何进度 → 不误报(可能还没开始)', () => {
    expect(stallLevel(999_999, false)).toBe('ok');
  });

  it('有进度且未超阈值 → ok', () => {
    expect(stallLevel(0, true)).toBe('ok');
    expect(stallLevel(STALL_SUSPECT_MS - 1, true)).toBe('ok');
  });

  it('超过 120s → suspect(提示但不判失败)', () => {
    expect(stallLevel(STALL_SUSPECT_MS, true)).toBe('suspect');
    expect(stallLevel(STALL_LIKELY_DEAD_MS - 1, true)).toBe('suspect');
  });

  it('超过 300s → likely-dead', () => {
    expect(stallLevel(STALL_LIKELY_DEAD_MS, true)).toBe('likely-dead');
  });

  it('文案带上停在哪个阶段(排查关键信息)', () => {
    const msg = stallMessage('likely-dead', 'denoise 5/8', 320_000);
    expect(msg).toContain('denoise 5/8');
    expect(msg).toContain('卡死');
    expect(msg).toContain('320');
  });

  it('ok 时不出文案', () => {
    expect(stallMessage('ok', 'denoise 5/8', 1000)).toBeUndefined();
  });

  it('suspect 文案措辞比 likely-dead 缓和(不吓用户)', () => {
    const s = stallMessage('suspect', 'denoise 5/8', 130_000)!;
    expect(s).toContain('疑似');
    expect(s).not.toContain('卡死');
  });
});
