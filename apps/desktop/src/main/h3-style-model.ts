/**
 * h3 风格模型包 —— 下载 + 离线融合构建(2026-10,MiniMax-H3-mystic 接入)
 *
 * 背景:h3.c CLI 不接受 `--lora`;风格 LoRA 的使用方式是**离线融合** ——
 * 用 merge_lora_h3.py 把 LoRA 增量烤进基础模型(MiniMax-H3)的 FL2VA / Ref2VA
 * transformer 副本,产出完整模型目录(如 ~/ai/h3/MiniMax-H3-mystic),推理时 `-d` 指向它。
 *
 * 构建管线(styleModelBuild):
 *   ① 下载缺失的 LoRA safetensors(curl -fL -C - 断点续传;已存在跳过);
 *   ② 复制基础模型的非 transformer 组件(APFS `cp -c` clonefile,几乎不占新空间);
 *   ③ 对 FL2VA / Ref2VA 两个 transformer 各跑一次融合(strength 1.0 烤死)。
 *
 * ⚠️ 幂等性红线:merge 脚本是「copy + 就地 patch」,对**已融合**目录重跑会把 delta
 * 再叠加一次(双重 LoRA ⇒ 画面过饱和/崩坏)。故每次 merge 前一律 `rm -rf` 产物侧的
 * transformer/ 再重跑 —— 重跑 = 干净重来。⚠️ 删除目标严格限定在产物目录内。
 *
 * 数据源(mystic v4):
 *  - FL2VA LoRA:HF lynaNSFW/mysticxxx_MM_H3(无需登录);
 *  - Ref2VA LoRA:仅 Civitai(NSFW 模型,匿名下载可能被 403 拦 → 明确报手动下载指引,
 *    绝不静默跳过 —— 半融合目录(FL2VA 有风格、Ref2VA 没有)是「假成功」形态)。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { StyleLoraSource, StyleModelProgress, StyleModelStatus } from '@bigbotart/shared';

/** h3 部署根目录(模型/脚本都在这下面;env 可覆盖便于测试) */
function h3Root(): string {
  return process.env.BIGBOTART_H3_ROOT ?? join(homedir(), 'ai', 'h3');
}

/** 基础模型目录(与 h3c.ts / selfcheck.ts 同口径:BIGBOTART_H3_MODEL 覆盖) */
function baseModelDir(): string {
  return process.env.BIGBOTART_H3_MODEL ?? join(h3Root(), 'MiniMax-H3');
}

/** 融合脚本(merge_lora_h3.py;env 可覆盖) */
function mergeScriptPath(): string {
  return process.env.BIGBOTART_H3_MERGE_PY ?? join(h3Root(), 'merge_lora_h3.py');
}

/** 已知风格包的下载/构建方案登记(未登记的 style 包只能手动构建) */
interface StyleModelSource {
  packId: string;
  /** LoRA 文件落盘目录 */
  loraDir: string;
  /** 融合产物目录(-d 目标) */
  outDir: string;
  loras: StyleLoraSource[];
}

const STYLE_MODEL_SOURCES: StyleModelSource[] = [
  {
    packId: 'mystic',
    loraDir: join(h3Root(), 'mysticxxx-lora'),
    outDir: join(h3Root(), 'MiniMax-H3-mystic'),
    loras: [
      {
        fileName: 'MysticXXX_MMH3-V4.safetensors',
        target: 'FL2VA',
        url: 'https://huggingface.co/lynaNSFW/mysticxxx_MM_H3/resolve/main/MysticXXX_MMH3-V4.safetensors',
        origin: 'HuggingFace lynaNSFW/mysticxxx_MM_H3',
      },
      {
        fileName: 'MysticXXX_MMH3-V4-ref2va.safetensors',
        target: 'Ref2VA',
        url: 'https://civitai.com/api/download/models/3266628?fileId=3156453',
        origin: 'Civitai [MMH3] Mystic XXX v4.0(可能需登录)',
      },
    ],
  },
  {
    /* 风格+加速双融合(2026-10-13):先融 mystic 画风、再融 turbo 提速,同一 transformer 顺序两次 merge。
     * 本机构建配方经张量级逐位验证:产物 == base + mystic + turbo(FL2VA/Ref2VA 均如此)。
     * turbo LoRA 文件:minimax_h3_turbo_v4_step600_ema.safetensors(larryvrh/MiniMax-H3-Turbo-Lora)。 */
    packId: 'mystic-turbo',
    loraDir: join(h3Root(), 'mysticxxx-lora'),
    outDir: join(h3Root(), 'MiniMax-H3-mystic-turbo'),
    loras: [
      {
        fileName: 'MysticXXX_MMH3-V4.safetensors',
        target: 'FL2VA',
        url: 'https://huggingface.co/lynaNSFW/mysticxxx_MM_H3/resolve/main/MysticXXX_MMH3-V4.safetensors',
        origin: 'HuggingFace lynaNSFW/mysticxxx_MM_H3',
      },
      {
        fileName: 'minimax_h3_turbo_v4_step600_ema.safetensors',
        target: 'FL2VA',
        dir: join(h3Root(), 'turbo-lora'),
        url: 'https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/resolve/main/minimax_h3_turbo_v4_step600_ema.safetensors',
        origin: 'HuggingFace larryvrh/MiniMax-H3-Turbo-Lora(v4 step600)',
      },
      {
        fileName: 'MysticXXX_MMH3-V4-ref2va.safetensors',
        target: 'Ref2VA',
        url: 'https://civitai.com/api/download/models/3266628?fileId=3156453',
        origin: 'Civitai [MMH3] Mystic XXX v4.0(可能需登录)',
      },
      {
        fileName: 'minimax_h3_turbo_v4_step600_ema.safetensors',
        target: 'Ref2VA',
        dir: join(h3Root(), 'turbo-lora'),
        url: 'https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/resolve/main/minimax_h3_turbo_v4_step600_ema.safetensors',
        origin: 'HuggingFace larryvrh/MiniMax-H3-Turbo-Lora(v4 step600)',
      },
    ],
  },
];

/** safetensors 轻校验:前 8 字节 little-endian header 长度 + 第 9 字节是 '{'(防 403 HTML 当真模型) */
function looksLikeSafetensors(path: string): boolean {
  try {
    if (statSync(path).size < 1024 * 1024) return false; // 真 LoRA 至少几十 MB;<1MB 基本是错误页
    const fd = openSync(path, 'r');
    const buf = Buffer.alloc(9);
    readSync(fd, buf, 0, 9, 0);
    closeSync(fd);
    const hlen = Number(buf.readBigUInt64LE(0));
    return hlen > 2 && hlen < 100 * 1024 * 1024 && buf[8] === 0x7b; // '{'
  } catch {
    return false;
  }
}

export class H3StyleModelBuilder {
  private running: ChildProcess | null = null;
  /** 整个构建任务占位(阶段间隙 running 会短暂为 null,防重入必须看它) */
  private building = false;
  private cancelled = false;

  constructor(private emit: (ev: StyleModelProgress) => void) {}

  /** 状态检测(设置页进入时调用;全是 existsSync/statSync,轻量) */
  status(packId: string): StyleModelStatus {
    const src = STYLE_MODEL_SOURCES.find((s) => s.packId === packId);
    const baseDir = baseModelDir();
    const scriptPath = mergeScriptPath();
    if (!src) {
      return {
        packId,
        buildable: false,
        outDir: '',
        mergedReady: false,
        baseReady: existsSync(join(baseDir, 'FL2VA')),
        baseDir,
        scriptReady: existsSync(scriptPath),
        scriptPath,
        loras: [],
        missing: ['该风格包没有登记的下载/构建方案,请手动融合后把目录登记为模型包'],
      };
    }
    const loras = src.loras.map((l) => {
      const p = join(l.dir ?? src.loraDir, l.fileName);
      const exists = existsSync(p) && looksLikeSafetensors(p);
      return { fileName: l.fileName, target: l.target, exists, sizeBytes: exists ? statSync(p).size : 0, path: p };
    });
    const baseReady = existsSync(join(baseDir, 'FL2VA', 'transformer')) && existsSync(join(baseDir, 'Ref2VA', 'transformer'));
    const scriptReady = existsSync(scriptPath);
    const mergedReady =
      existsSync(join(src.outDir, 'FL2VA', 'transformer')) && existsSync(join(src.outDir, 'Ref2VA', 'transformer'));
    const missing: string[] = [];
    if (!baseReady) missing.push(`基础模型未就绪(${baseDir} 缺 FL2VA/Ref2VA transformer)`);
    if (!scriptReady) missing.push(`融合脚本不存在:${scriptPath}`);
    for (const l of loras) if (!l.exists) missing.push(`LoRA 缺失:${l.fileName}`);
    return { packId, buildable: true, outDir: src.outDir, mergedReady, baseReady, baseDir, scriptReady, scriptPath, loras, missing };
  }

  /** 取消进行中的构建(杀当前子进程;半成品目录保留,重跑会先清 transformer 保证幂等) */
  cancel(): { ok: boolean } {
    if (!this.running) return { ok: false };
    this.cancelled = true;
    this.running.kill('SIGTERM');
    return { ok: true };
  }

  /** 是否正在构建(设置页按钮置灰用;看整个任务而非某个子进程) */
  isRunning(): boolean {
    return this.building;
  }

  /**
   * 执行下载 + 融合构建。防重入:同时只允许一个构建。
   * 失败/取消均明确上报,绝不留「看起来成功」的半成品状态(产物目录本身保留以便续跑)。
   */
  async build(packId: string): Promise<{ ok: boolean; error?: string }> {
    const src = STYLE_MODEL_SOURCES.find((s) => s.packId === packId);
    if (!src) return { ok: false, error: '该风格包没有登记的下载/构建方案' };
    if (this.building) return { ok: false, error: '已有构建任务进行中' };
    // 前置校验在占位**之前**:失败 return 不该留下 building=true(防重入锁泄漏)
    const st = this.status(packId);
    if (!st.baseReady) return { ok: false, error: `基础模型未就绪:${st.baseDir}(需先备好 MiniMax-H3 完整模型,144GB)` };
    if (!st.scriptReady) return { ok: false, error: `融合脚本不存在:${st.scriptPath}(h3 部署目录应含 merge_lora_h3.py)` };
    this.building = true;
    this.cancelled = false;

    try {
      /* ① 下载缺失 LoRA(断点续传;下完做 safetensors 轻校验;同名文件不同 target 只下一次) */
      const seen = new Set<string>();
      for (const l of src.loras) {
        const dir = l.dir ?? src.loraDir;
        const dest = join(dir, l.fileName);
        if (seen.has(dest)) continue;
        seen.add(dest);
        mkdirSync(dir, { recursive: true });
        if (existsSync(dest) && looksLikeSafetensors(dest)) continue;
        await this.runStage(packId, 'download', `下载 ${l.fileName}(${l.origin})`, [
          'curl',
          ['-fL', '-C', '-', '--retry', '3', '-o', dest, l.url],
        ]);
        if (!looksLikeSafetensors(dest)) {
          throw new Error(
            `${l.fileName} 下载结果不是合法 safetensors(可能被登录页/错误页拦截)· 请手动从 ${l.origin} 下载放到 ${dir}`,
          );
        }
      }

      /* ② 复制非 transformer 组件(APFS clonefile;transformer 交给 merge 脚本 copy+patch) */
      const baseDir = baseModelDir();
      for (const sub of ['FL2VA', 'Ref2VA'] as const) {
        this.progress(packId, 'copy', undefined, `复制基础组件 ${sub}/(clonefile,不含 transformer)`);
        mkdirSync(join(src.outDir, sub), { recursive: true });
        for (const item of readdirSync(join(baseDir, sub))) {
          if (item === 'transformer') continue;
          const dstItem = join(src.outDir, sub, item);
          if (existsSync(dstItem)) continue;
          await this.runStage(packId, 'copy', `复制 ${sub}/${item}`, [
            '/bin/cp',
            ['-Rc', join(baseDir, sub, item), dstItem],
          ]);
        }
      }

      /* ③ 融合两个 transformer。
       * ⚠️ 幂等红线:每个 transformer **只删一次**产物侧目录,然后按登记的 LoRA 顺序逐次 merge
       * (单 LoRA 包 = 一次;双融合包 = 先风格后 turbo 两次 —— 顺序删除会把第一次的成果清掉,
       *  不删直接重跑则等于把整串 LoRA 再叠加一遍)。 */
      for (const sub of ['FL2VA', 'Ref2VA'] as const) {
        const subLoras = src.loras.filter((l) => l.target === sub);
        if (subLoras.length === 0) throw new Error(`构建方案缺 ${sub} 的 LoRA 源`);
        const dstTransformer = join(src.outDir, sub, 'transformer');
        rmSync(dstTransformer, { recursive: true, force: true });
        const stage = sub === 'FL2VA' ? ('merge-FL2VA' as const) : ('merge-Ref2VA' as const);
        for (const lora of subLoras) {
          await this.runStage(
            packId,
            stage,
            `融合 ${sub} transformer ← ${lora.fileName}(~60GB,约 20-60 分钟)`,
            [
              'python3',
              [mergeScriptPath(), '--lora', join(lora.dir ?? src.loraDir, lora.fileName), '--src', join(baseDir, sub, 'transformer'), '--dst', dstTransformer, '--strength', '1.0'],
            ],
          );
        }
      }

      this.progress(packId, 'done', 100, `构建完成:${src.outDir}`);
      return { ok: true };
    } catch (e) {
      if (this.cancelled) {
        this.progress(packId, 'cancelled', undefined, '已取消(半成品目录保留,重跑会先清 transformer 再融合)');
        return { ok: false, error: '已取消' };
      }
      const msg = (e as Error).message;
      this.progress(packId, 'error', undefined, msg, msg);
      return { ok: false, error: msg };
    } finally {
      this.running = null;
      this.building = false;
    }
  }

  private progress(packId: string, stage: StyleModelProgress['stage'], pct: number | undefined, message: string, error?: string): void {
    this.emit({ packId, stage, pct, message, error });
  }

  /** 跑一个子进程阶段;stdout/stderr 行尾缓存进错误信息;cancel 时 kill */
  private runStage(packId: string, stage: StyleModelProgress['stage'], label: string, [cmd, args]: [string, string[]]): Promise<void> {
    this.progress(packId, stage, undefined, label);
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.running = child;
      let tail = '';
      const onData = (b: Buffer) => {
        tail = (tail + b.toString()).slice(-4000);
        // merge 脚本按 shard 打进度行,转发为消息(不解析百分比,粗粒度足够)
        const lastLine = tail.trim().split('\n').pop()?.trim();
        if (lastLine) this.progress(packId, stage, undefined, `${label} · ${lastLine.slice(-120)}`);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (e) => reject(new Error(`${label} 启动失败:${e.message}`)));
      child.on('close', (code, signal) => {
        this.running = null;
        if (this.cancelled || signal === 'SIGTERM') return reject(new Error('已取消'));
        if (code !== 0) return reject(new Error(`${label} 失败(exit ${code}):${tail.trim().split('\n').pop() ?? ''}`));
        resolve();
      });
    });
  }
}
