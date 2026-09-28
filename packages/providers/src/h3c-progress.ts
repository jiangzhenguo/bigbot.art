/**
 * h3 进度行解析 + 阶段加权总进度 + 停滞判定(A/B/C)
 *
 * ── 背景:为什么需要这个 ──
 * 原实现的进度条是**时间估算**,与引擎实际进度无关:
 *     pct = min(0.99, elapsed / etaSec)   // etaSec = 档位分钟数 × 面积系数 × 加速系数
 * 后果:① h3 快则提前爬到 99% 干等;② h3 慢则爬到 99% 后长时间不动而看不出异常;
 *       ③ 首次 Metal shader 编译(~30 分钟)完全不计入;④ 无法区分「慢」与「死」。
 * 实测:一个 864×480/8 步的任务真实跑了 9 分钟、累计 CPU 仅 42 秒(明显卡死),
 * 而进度条一直在正常爬升 —— 进度条的**说谎**比没有更误导。
 *
 * ── 真实进度从哪来 ──
 * h3 的进度回调逐阶段写 **stderr**(不是 stdout!):
 *     h3.c main.c:168 / h3_cli.c:122
 *     fprintf(stderr, "\r%-25s %4d/%-4d", phase, completed, total);
 * 形如 `\rdenoise                    5/8`。phase 语义化,完整清单见 H3_PHASE_WEIGHTS。
 * 关键:这份数据此前**一直从 stderr 流经我们手里**,只是被当成「错误尾巴」丢进 errAcc。
 *
 * ── 本模块的三件事 ──
 * A. `parseProgressLine` —— 把一行 stderr 文本解析成 {phase, done, total}(纯函数)。
 * B. `phaseWeightedProgress` —— 跨阶段加权成**单调递增**的总百分比,阶段内按 done/total 细分。
 * C. `StallDetector` —— 长时间「无进度变化」判定停滞:进度条停住不动本身就是可诊断信号。
 *
 * 设计约束(与 video-post.ts 的既有做法同口径):
 *   - 进度**单调不减**:阶段切换或重试都不得回退(UI 上回退比不动更像 bug)。
 *   - 未知 phase 不猜权重:落到「其他」桶,只保证单调,不虚报百分比。
 */

/** h3 进度事件(单行解析结果) */
export interface H3ProgressEvent {
  /** 阶段名(h3 原样输出,如 'denoise' / 'text encoder' / 'FFmpeg') */
  phase: string;
  /** 该阶段已完成量 */
  done: number;
  /** 该阶段总量 */
  total: number;
}

/**
 * 阶段权重表:B 的核心 —— 把「各阶段的耗时代价」写成相对权重。
 *
 * 依据:各阶段是**串行**的,总耗时 ≈ 各阶段之和。denoise 是绝对大头(去噪主循环,
 * 步数 × 每步全网络前向),text/vision 编码次之,VAE 权重加载再次,FFmpeg 编码很轻。
 * 权重只需**相对**合理(它们归一化成百分比),不追求精确。
 *
 * ⚠️ `denoise enqueue` 是 denoise 的排队子阶段,归到同一桶,避免重复计入。
 */
export const H3_PHASE_WEIGHTS: Record<string, number> = {
  tokenizer: 1,
  'text encoder': 8,
  'Qwen vision': 10,
  'video VAE load': 6,
  'preview VAE load': 4,
  'audio VAE': 3,
  'audio VAE encoder': 3,
  'video VAE encoder': 5,
  denoise: 55,
  // ⚠️ `denoise enqueue` 是**独立阶段**(h3_dit.c:2674 在每步**入队时**上报,
  //    而 `denoise` 在每步**完成时**上报:h3_dit.c:2781/2817/2850)。
  //    二者交错进行,不能并成一个桶 —— 实测把 enqueue 并进 denoise 会算出 60.6%
  //    低于 denoise 8/8 的 95%,纯函数层面就是回退。
  //    给它极小权重(仅表示"已进入去噪期"),并放在 denoise **之前**的位置语义上;
  //    实际单调性由 ProgressTracker 兜底 clamp。
  'denoise enqueue': 0.5,
  FFmpeg: 5,
};

/** 权重未登记时的兜底桶(宁可少报,不虚报) */
export const H3_UNKNOWN_PHASE_WEIGHT = 1;

/** phase → 归一化后的「桶名」(与权重表键对齐;enqueue 是独立阶段,不并入 denoise) */
export function phaseBucket(phase: string): string {
  return phase.trim();
}

/**
 * A · 解析一行 h3 进度输出。
 *
 * 输入是 stderr 里以 `\r` 覆盖刷新的片段,形如:
 *   `denoise                    5/8`
 *   `text encoder              32/50`
 * 返回 null 表示这行**不是**进度行(调用方应把它当普通日志/错误保留)。
 *
 * 注意 h3 上游还有 `\r` 与偶发 `\n` 终止(阶段结束时 `fputc('\n')`),
 * 切分由调用方负责(见 splitProgressChunks)。
 */
export function parseProgressLine(raw: string): H3ProgressEvent | null {
  const line = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim(); // 顺带剥 ANSI 转义
  if (!line) return null;
  // <phase 名(可含空格)> <done>/<total>
  const m = /^(.*?)\s+(\d+)\s*\/\s*(\d+)$/.exec(line);
  if (!m) return null;
  const phase = m[1]!.trim();
  const done = Number(m[2]);
  const total = Number(m[3]);
  if (!phase) return null;
  if (!Number.isFinite(done) || !Number.isFinite(total)) return null;
  if (total <= 0 || done < 0 || done > total) return null;
  return { phase, done, total };
}

/**
 * 把 stderr 累积缓冲切成「待解析片段」,返回 [可解析片段, 未完成的尾部]。
 *
 * h3 用 `\r` 覆盖同一行,也用 `\n` 结束一个阶段。两者都作为分隔符;
 * 尾部(最后一段不完整的数据)必须留到下次,否则会解析到被截断的 `denoise 5/` 之类。
 */
export function splitProgressChunks(buf: string): [string[], string] {
  const parts = buf.split(/[\r\n]+/);
  const tail = parts.pop() ?? '';
  return [parts, tail];
}

/**
 * B · 跨阶段加权总进度(单调递增)。
 *
 * 算法:每个桶按「已走过的阶段权重之和 + 当前阶段内进度 × 本阶段权重」累计,再除以总权重。
 * 单调性由调用方通过 `ProgressTracker` 保证(它会 clamp 到历史最大值),
 * 本函数是**纯计算**,同样的输入给同样的输出。
 *
 * @param current 当前进度事件;null 表示还没有任何真实进度
 * @returns 0..1;未知阶段只贡献兜底权重,**不虚报**
 */
export function phaseWeightedProgress(current: H3ProgressEvent | null): number {
  if (!current) return 0;
  const totalWeight = Object.entries(H3_PHASE_WEIGHTS)
    .filter(([name]) => !(name in INTERLEAVED_PHASES))
    .reduce((sum, [, w]) => sum + w, 0);
  if (totalWeight <= 0) return 0;

  // 交错阶段(如 denoise enqueue):它只表示「已进入被交错的那个时期」,**自身不携带完成度**
  // (h3 在每步入队时报 enqueue、完成时报 denoise,二者共享同一段进度)。
  // 若在此返回一个值,交错发生时必然低于已推进的 denoise → 纯函数层面出现回退。
  // 因此这里返回上一个已确认的进度点(时期起点),保持单调;真实推进由 denoise 提供。
  const host = INTERLEAVED_PHASES[current.phase.trim()];
  if (host) {
    let before = 0;
    for (const [name, w] of Object.entries(H3_PHASE_WEIGHTS)) {
      if (name in INTERLEAVED_PHASES || w <= 0) continue;
      if (isPhasePassed(name, host)) before += w;
    }
    return Math.min(1, Math.max(0, before / totalWeight));
  }

  const bucket = phaseBucket(current.phase);
  let doneWeight = 0;
  for (const [name, w] of Object.entries(H3_PHASE_WEIGHTS)) {
    if (name in INTERLEAVED_PHASES) continue;
    if (w <= 0) continue;
    if (phaseBucket(name) === bucket) continue; // 当前阶段单独算
    if (isPhasePassed(name, bucket)) doneWeight += w;
  }
  const curWeight = H3_PHASE_WEIGHTS[bucket] ?? H3_UNKNOWN_PHASE_WEIGHT;
  const frac = current.total > 0 ? Math.min(1, Math.max(0, current.done / current.total)) : 0;
  const pct = (doneWeight + frac * curWeight) / totalWeight;
  return Math.min(1, Math.max(0, pct));
}

/** 该阶段名对应的权重(enqueue 归并到 denoise) */
function phaseWeightOf(name: string): number {
  return H3_PHASE_WEIGHTS[phaseBucket(name)] ?? H3_UNKNOWN_PHASE_WEIGHT;
}

/**
 * 判断 `name` 阶段是否「已经走完」(即出现在 `current` 阶段之前)。
 *
 * 依据:权重表的**书写顺序即执行顺序**(与 h3.c 的 emit 顺序一致:
 * tokenizer → text encoder → vision → VAE load → denoise → FFmpeg)。
 * 这比在事件里维护状态简单,且对「跳过某些阶段」(如无 ref-image 就不走 Qwen vision)天然健壮。
 */
function isPhasePassed(name: string, currentBucket: string): boolean {
  const order = H3_PHASE_ORDER;
  const i = order.indexOf(phaseBucket(name));
  const j = order.indexOf(currentBucket);
  if (i < 0 || j < 0) return false; // 未知阶段不参与「已走过」推断
  return i < j;
}

/**
 * 阶段执行顺序(用于「已走过哪些阶段」的推断)。
 *
 * ⚠️ `denoise enqueue` 与 `denoise` 是**交错**的(同一段去噪期里,每步入队时报 enqueue、
 *    完成时报 denoise),不存在先后关系 —— 把它们排成线性序列必然导致其中一方被算作
 *    「已走过」而虚高或回退。因此这里**不列入** enqueue;它走下面的专用分支。
 */
export const H3_PHASE_ORDER: string[] = [
  'tokenizer',
  'text encoder',
  'Qwen vision',
  'video VAE load',
  'preview VAE load',
  'audio VAE',
  'audio VAE encoder',
  'video VAE encoder',
  'denoise',
  'FFmpeg',
];

/**
 * 交错阶段:这些阶段与 `H3_PHASE_ORDER` 里的某个阶段**同时发生**,不是独立进度点。
 * 它们只表示「已经进入该时期」,进度取「进入该时期的下限」,绝不对外报回退值。
 */
const INTERLEAVED_PHASES: Record<string, string> = {
  'denoise enqueue': 'denoise',
};

/**
 * 进度跟踪器:保证**单调不减** + 提供 C(停滞判定)所需的时间信息。
 *
 * 单调性为什么重要:阶段切换/重试/乱序 chunk 都可能让算术结果回退,
 * 而 UI 上进度条往回跳比停住更像故障(video-post.ts 也踩过同一坑:
 * 「拼回」阶段把 96% 拽回 27%)。这里 clamp 到历史最大值。
 */
export class ProgressTracker {
  private maxPct = 0;
  private lastEvent: H3ProgressEvent | null = null;
  /** 最近一次「进度真的前进了」的时间戳(ms) */
  private lastAdvanceAt: number;
  private startedAt: number;

  constructor(now: number = Date.now()) {
    this.lastAdvanceAt = now;
    this.startedAt = now;
  }

  /**
   * 喂入一行 stderr 文本。
   * @returns 解析到的进度事件(不是进度行则为 null);调用方据此决定是否更新 UI
   */
  pushLine(raw: string, now: number = Date.now()): H3ProgressEvent | null {
    const ev = parseProgressLine(raw);
    if (!ev) return null;
    // 「前进」的判定:阶段换了,或同阶段 done 变大
    const changed =
      !this.lastEvent ||
      phaseBucket(ev.phase) !== phaseBucket(this.lastEvent.phase) ||
      ev.done > this.lastEvent.done;
    if (changed) this.lastAdvanceAt = now;
    this.lastEvent = ev;
    // 交错阶段(denoise enqueue)只更新 stageText / 续期停滞计时,**不参与进度计算** ——
    // 它与 denoise 共享同一段进度,拿它算会得到低于当前值的数(纯函数无历史,必然回退)。
    if (!(ev.phase.trim() in INTERLEAVED_PHASES)) {
      const pct = phaseWeightedProgress(ev);
      if (pct > this.maxPct) this.maxPct = pct;
    }
    return ev;
  }

  /** 当前总进度(单调,0..1) */
  get progress(): number {
    return this.maxPct;
  }

  /** 当前阶段文本(给 UI 显示「denoise 5/8」) */
  get stageText(): string | undefined {
    const e = this.lastEvent;
    if (!e) return undefined;
    return `${e.phase} ${e.done}/${e.total}`;
  }

  /** 距上次「进度真的前进」过了多久(ms) */
  stalledFor(now: number = Date.now()): number {
    return now - this.lastAdvanceAt;
  }

  /** 任务已跑多久(ms) */
  elapsed(now: number = Date.now()): number {
    return now - this.startedAt;
  }
}

/* ───────────────────────── C:停滞判定 ───────────────────────── */

/**
 * 停滞判定的两个阈值(ms)。
 *
 * 为什么需要:C 的目标是回答「它是慢还是死了」。你实测踩过的那次 ——
 * 9 分钟真实时间、累计 CPU 仅 42 秒、所有线程 `S` 睡眠 —— 进度条却仍在爬升。
 * 有了真实进度后,「进度停在 denoise 5/8 不动」就是最强的诊断信号。
 *
 * 分级(避免误报:单步推理本身可能很久):
 *   - SUSPECT(120s):提示「疑似停滞」,UI 可给黄色标识,但**不判失败**;
 *   - LIKELY_DEAD(300s):提示「可能已卡死」,建议用户取消。
 * 注意:首次 Metal shader 编译约 30 分钟,但那段发生在**加载期**(会有 VAE load 进度),
 * 若完全无进度行则是另一回事 —— 由 `hasAnyProgress` 区分。
 */
export const STALL_SUSPECT_MS = 120_000;
export const STALL_LIKELY_DEAD_MS = 300_000;

export type StallLevel = 'ok' | 'suspect' | 'likely-dead';

/**
 * 停滞等级判定。
 *
 * @param stalledMs 距上次进度前进的毫秒数
 * @param hasAnyProgress 是否解析到过任何真实进度(没有进度行 ≠ 停滞,可能还没开始)
 */
export function stallLevel(stalledMs: number, hasAnyProgress: boolean): StallLevel {
  if (!hasAnyProgress) return 'ok'; // 还没有进度可比对,不误报
  if (stalledMs >= STALL_LIKELY_DEAD_MS) return 'likely-dead';
  if (stalledMs >= STALL_SUSPECT_MS) return 'suspect';
  return 'ok';
}

/** 停滞时给用户的**可执行**文案(带上停在哪个阶段 —— 这是排查的关键信息) */
export function stallMessage(level: StallLevel, stageText: string | undefined, stalledMs: number): string | undefined {
  if (level === 'ok') return undefined;
  const where = stageText ? `停在「${stageText}」` : '无阶段信息';
  const secs = Math.round(stalledMs / 1000);
  if (level === 'likely-dead') {
    return `可能已卡死:${where},已 ${secs} 秒无进展。建议取消任务后重试(或用 h3 --info 检查模型目录完整性)。`;
  }
  return `疑似停滞:${where},已 ${secs} 秒无进展(长片段单步可能较慢,先观察)。`;
}
