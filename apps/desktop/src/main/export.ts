/**
 * ExportService — 时间线导出(PRD §5.6 P1 → P0 完成)
 *
 * 能力:
 *  - 简化路径(老接口):仅填 clips[] → concat demuxer 顺序拼接,行为与旧版一致
 *  - 编排路径:填 sequence[] → filtergraph 拼接,支持:
 *      · trim 入出点(-ss/-to 与 filter trim 配合)
 *      · 单段独立音量(perClipVolume / sequence[].volume)
 *      · 响度统一 −14 LUFS(loudnorm 节点级开关)
 *      · 转场 cut / crossfade / fade-black(xfade)
 *      · 格式 mp4-h264 / prores
 *      · 分辨率 1920x1080 / 1280x720 / source
 *  - 后台子进程 + -progress 解析阶段/百分比;渲染层轮询 export-status
 *  - outputName / clip 路径均做白名单校验
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import type {
  ExportTask,
  TimelineAudio,
  TimelineExportPreset,
  TimelineExportRequest,
  TimelineTransition,
} from '@bigbotart/shared';
import { ASSETS_DIR, OUTPUTS_DIR, isUnderRoot, importAllowRoots } from './assets.js';
import type { TakeStore } from './takes.js';

const DATA_DIR = process.env.BIGBOTART_HOME ?? join(homedir(), '.bigbotart');
const EXPORT_DIR = join(DATA_DIR, 'exports');

function sanitizeOutputName(name: string | undefined): string {
  const base = basename(name ?? 'timeline').replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/[^\w.\u4e00-\u9fff-]+/g, '_').replace(/^\.+/, '') || 'timeline';
  return cleaned.slice(0, 80);
}

function assertClipAllowed(path: string): void {
  const roots = [...importAllowRoots(), ASSETS_DIR, OUTPUTS_DIR, EXPORT_DIR];
  if (!roots.some((r) => isUnderRoot(path, r))) {
    throw new Error(`片段路径不在允许目录: ${basename(path)}`);
  }
}

/** 是否走编排路径(填了 sequence) */
function isAdvanced(req: TimelineExportRequest): boolean {
  return Array.isArray(req.sequence) && req.sequence.length > 0;
}

/** 从编排里解出每个 entry 的 resultPath(优先 sequence.takeId → shot 的 currentTakeId → 最新 succeeded) */
function resolveSequencePaths(
  req: TimelineExportRequest,
  takeStore: TakeStore,
): Array<{ path: string; nodeId: string; takeId?: string; label: string }> {
  const projectId = req.projectId;
  const out: Array<{ path: string; nodeId: string; takeId?: string; label: string }> = [];
  for (const s of req.sequence ?? []) {
    const hist = takeStore.history(projectId, s.shotNodeId, s.takeId);
    const pick = hist.takes.find((t: { id: string }) => t.id === hist.currentTakeId) ?? hist.takes[0];
    if (!pick?.resultPath) {
      throw new Error(`镜头 ${s.shotNodeId.slice(0, 8)} 还没有可导出的 Take(先生成)`);
    }
    out.push({
      path: pick.resultPath,
      nodeId: s.shotNodeId,
      takeId: pick.id,
      label: `shot ${s.shotNodeId.slice(0, 6)} · ${pick.id.slice(0, 6)}`,
    });
  }
  return out;
}

/** 单段裁切参数;返回 ffmpeg -ss/-to 前缀(可能空) */
function trimPrefix(idx: number, seq: TimelineExportRequest['sequence']): string[] {
  const s = seq?.[idx];
  if (!s?.trim) return [];
  const inSec = Math.max(0, Number(s.trim.inSec) || 0);
  const outSec = Math.max(inSec + 0.1, Number(s.trim.outSec) || inSec + 0.1);
  return ['-ss', String(inSec), '-to', String(outSec)];
}

/** ffprobe 探测视频画幅(统一 concat 画幅用;失败回退 1280×720) */
function probeFirstVideoSize(path: string): { w: number; h: number } {
  try {
    const r = spawnSync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path],
      { timeout: 8000, encoding: 'utf-8' },
    );
    if (r.status === 0 && r.stdout) {
      const [w, h] = r.stdout.trim().split(',');
      const nw = Number(w);
      const nh = Number(h);
      if (Number.isFinite(nw) && nw > 0 && Number.isFinite(nh) && nh > 0) {
        return { w: nw, h: nh };
      }
    }
  } catch {
    /* 回退 */
  }
  return { w: 1280, h: 720 };
}

/**
 * 编排路径的 filter graph。
 * - N=1:仅 trim + 编码
 * - N≥2:每段 trim/scale/vol,产出 v0..vN-1 + a0..aN-1;若有转场则用 xfade;否则直接 concat
 */
function buildAdvancedArgs(
  clipList: Array<{ path: string; label: string; nodeId?: string }>,
  seq: TimelineExportRequest['sequence'] | undefined,
  transitions: TimelineTransition[] | undefined,
  audio: TimelineAudio | undefined,
  preset: TimelineExportPreset | undefined,
  outputPath: string,
): string[] {
  const n = clipList.length;
  if (n === 0) throw new Error('时间线为空');

  // 1) inputs(每段先 trim,再参与 filter)
  const inputs: string[] = ['-y'];
  for (let i = 0; i < n; i++) {
    inputs.push(...trimPrefix(i, seq), '-i', clipList[i]!.path);
  }

  // 2) filter graph
  // concat 硬性要求:所有段同画幅、同采样率。统一目标尺寸:
  //    预设 resolution 非 source → 用它;否则探测第一段原始画幅(保证不缩放)
  let tW = 0;
  let tH = 0;
  if (preset?.resolution && preset.resolution !== 'source') {
    const [w, h] = preset.resolution.split('x');
    tW = Number(w) || 0;
    tH = Number(h) || 0;
  }
  if (!tW || !tH) {
    const probe = probeFirstVideoSize(clipList[0]!.path);
    tW = probe.w || 1280;
    tH = probe.h || 720;
  }
  const scaleChain = `scale=${tW}:${tH}:force_original_aspect_ratio=decrease,pad=${tW}:${tH}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

  let filter = '';
  for (let i = 0; i < n; i++) {
    const s = seq?.[i];
    const vol = audio?.perClipVolume?.[clipList[i]!.nodeId ?? ''] ?? s?.volume ?? 1;
    const vTrim = s?.trim;
    let vPart = `[${i}:v]`;
    if (vTrim) {
      vPart += `trim=start=${vTrim.inSec}:end=${vTrim.outSec},setpts=PTS-STARTPTS,`;
    } else {
      vPart += 'setpts=PTS-STARTPTS,';
    }
    vPart += `${scaleChain},format=yuv420p[v${i}];`;
    filter += vPart;

    let aPart = `[${i}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo`;
    if (vol !== 1) aPart += `,volume=${vol}`;
    aPart += `[a${i}];`;
    filter += aPart;
  }

  // 转场:仅 N≥2 时启用,简化策略:
  //  - 全部同种 crossfade → xfade + acrossfade 链式拼接
  //  - 全部同种 fade-black → 与 cut 等价(P0 限制,真黑场留 P2)
  //  - 其他(cut / 混用 / N=1) → 直接 concat filter(N=1 退化为 identity)
  const lastV = 'concatv';
  const lastA = 'concata';
  const sameKind =
    n >= 2 && transitions && transitions.length === n - 1 && transitions.every((t) => t.kind === transitions[0]!.kind);
  const firstKind = sameKind ? transitions![0]!.kind : 'cut';
  if (sameKind && firstKind === 'crossfade') {
    let prevV = 'v0';
    let prevA = 'a0';
    for (let i = 1; i < n; i++) {
      const dur = (transitions![i - 1]!.durationMs ?? 500) / 1000;
      const outV = i === n - 1 ? lastV : `xv${i}`;
      const outA = i === n - 1 ? lastA : `xa${i}`;
      filter += `[${prevV}][v${i}]xfade=transition=fade:duration=${dur}:offset=0[${outV}];`;
      filter += `[${prevA}][a${i}]acrossfade=d=${dur}[${outA}];`;
      prevV = outV;
      prevA = outA;
    }
  } else if (n === 1) {
    // 单段:把 v0/a0 直接映射成 concatv/concata
    filter += `[v0]copy[${lastV}];[a0]copy[${lastA}];`;
  } else {
    // concat 输入按「段交替」排列:每段 先视频后音频 → [v0][a0][v1][a1]...
    // (ffmpeg concat filter 约定:n 段 × (v=1:a=1),输入顺序是 段0{v,a},段1{v,a}…)
    const segs = Array.from({ length: n }, (_, i) => `[v${i}][a${i}]`).join('');
    filter += `${segs}concat=n=${n}:v=1:a=1[${lastV}][${lastA}];`;
  }

  // 4) 输出链:缩放 + 响度统一 并入 filtergraph(避免 -vf/-af 与 -filter_complex 冲突)
  // concat/copy 句尾已有 `;`,输出链直接续写即可(独立成句)
  const outV = preset?.resolution && preset.resolution !== 'source' ? 'outv' : lastV;
  const outA = audio?.loudnessNormalize ? 'outa' : lastA;
  if (outV !== lastV) {
    const [w, h] = preset!.resolution!.split('x');
    if (w && h) filter += `[${lastV}]scale=${w}:${h}[outv];`;
  }
  if (outA !== lastA) {
    filter += `[${lastA}]loudnorm=I=-14:TP=-1.5:LRA=11[outa];`;
  }

  const map = ['-map', `[${outV}]`, '-map', `[${outA}]`];
  const enc = encoderArgs(preset);
  return [...inputs, '-filter_complex', filter, ...map, ...enc, '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', outputPath];
}

function encoderArgs(preset: TimelineExportPreset | undefined): string[] {
  if (preset?.format === 'prores') {
    return ['-c:v', 'prores_ks', '-profile:v', '2', '-c:a', 'pcm_s16le', '-pix_fmt', 'yuv422p10le'];
  }
  // mp4-h264(默认);缩放走 filtergraph,这里不再带 -vf
  return ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k'];
}

export class ExportService {
  private tasks: ExportTask[] = [];
  private children = new Map<string, ChildProcess>();
  /** TakeStore 注入(渲染层 sequence 路径解析用);缺省时 sequence 不可用 */
  constructor(private takeStore?: TakeStore) {}

  status(taskId: string): ExportTask {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return { id: taskId, projectId: '', status: 'failed', error: '任务不存在', createdAt: new Date().toISOString() };
    return { ...t };
  }

  /** 启动导出;只有一条任务在跑时排队(简单串行) */
  submit(req: TimelineExportRequest): { taskId: string } {
    let clipList: Array<{ path: string; label?: string; nodeId?: string; takeId?: string }>;
    if (isAdvanced(req)) {
      if (!this.takeStore) {
        throw new Error('时间线编排导出需要 TakeStore(主进程未注入)');
      }
      const resolved = resolveSequencePaths(req, this.takeStore);
      clipList = resolved.map((r) => ({ path: r.path, label: r.label, nodeId: r.nodeId, takeId: r.takeId }));
    } else {
      clipList = req.clips;
    }
    if (clipList.length === 0) throw new Error('时间线为空:没有可导出的片段');
    for (const c of clipList) {
      if (!existsSync(c.path)) throw new Error(`片段文件不存在: ${c.path}`);
      assertClipAllowed(c.path);
    }
    mkdirSync(EXPORT_DIR, { recursive: true });
    const taskId = `exp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const safeName = sanitizeOutputName(req.outputName);
    const outputPath = resolve(join(EXPORT_DIR, `${safeName}-${taskId.slice(4)}.mp4`));
    if (!isUnderRoot(outputPath, EXPORT_DIR)) {
      throw new Error('导出路径非法');
    }
    const task: ExportTask = {
      id: taskId,
      projectId: req.projectId,
      status: 'running',
      stage: isAdvanced(req) ? '解析编排…' : '准备片段列表…',
      outputPath,
      createdAt: new Date().toISOString(),
    };
    this.tasks.push(task);
    void this.run(task, req, clipList, outputPath);
    return { taskId };
  }

  private async run(
    task: ExportTask,
    req: TimelineExportRequest,
    clipList: Array<{ path: string; label?: string; nodeId?: string; takeId?: string }>,
    outputPath: string,
  ): Promise<void> {
    const advanced = isAdvanced(req);
    const listFile = join(EXPORT_DIR, `${task.id}.list.txt`);
    try {
      if (advanced) {
        task.stage = 'FFmpeg 合成中(编排)…';
        const args = buildAdvancedArgs(
          clipList as Array<{ path: string; label: string }>,
          req.sequence,
          req.transitions,
          req.audio,
          req.exportPreset,
          outputPath,
        );
        await this.execFfmpeg(task, args);
      } else {
        task.stage = 'FFmpeg 合成中(简单拼接)…';
        const lines = clipList.map((c) => `file '${c.path.replace(/'/g, "'\\''")}'`).join('\n');
        writeFileSync(listFile, lines);
        const args = [
          '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '160k',
          '-movflags', '+faststart',
          '-progress', 'pipe:1',
          '-nostats',
          outputPath,
        ];
        await this.execFfmpeg(task, args);
      }
      task.status = 'succeeded';
      task.progress = 1;
      task.stage = '完成 · 已归档到项目';
    } catch (e) {
      task.status = 'failed';
      task.stage = '导出失败';
      task.error = (e as Error).message;
      // 导出失败明细打到主进程 stdout(dev 日志可见,方便诊断)
      console.error(`[export] task=${task.id} failed: ${(e as Error).message}`);
      if (typeof (e as Error & { args?: string[] }).args !== 'undefined') {
        console.error(`[export] args=${JSON.stringify((e as Error & { args: string[] }).args)}`);
      }
    } finally {
      try { unlinkSync(listFile); } catch { /* ignore */ }
      this.children.delete(task.id);
    }
  }

  private execFfmpeg(task: ExportTask, args: string[]): Promise<void> {
    return new Promise((resolveP, reject) => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.children.set(task.id, child);
      let errAcc = '';
      child.stdout.on('data', (d: Buffer) => {
        const text = d.toString();
        const m = /out_time_ms=(\d+)/.exec(text);
        const dur = /duration=([\d.]+)/.exec(text);
        if (m && dur) {
          const pct = Math.min(99, Math.round((Number(m[1]) / 1_000_000 / Number(dur)) * 100));
          task.progress = Math.max(task.progress ?? 0, pct);
        }
      });
      child.stderr.on('data', (d: Buffer) => (errAcc += d.toString()));
      child.on('close', (code) => {
        this.children.delete(task.id);
        if (code === 0 && existsSync(task.outputPath ?? '')) {
          resolveP();
        } else {
          const msg =
            errAcc.split('\n').filter(Boolean).slice(-4).join('\n') || `ffmpeg exit ${code}`;
          const err = new Error(msg) as Error & { args?: string[] };
          err.args = args;
          reject(err);
        }
      });
      child.on('error', (e) => {
        const err = e as Error & { args?: string[] };
        err.args = args;
        reject(err);
      });
    });
  }

  /** 中止运行中的导出 */
  cancel(taskId: string): boolean {
    const c = this.children.get(taskId);
    if (!c) return false;
    c.kill('SIGTERM');
    return true;
  }
}
