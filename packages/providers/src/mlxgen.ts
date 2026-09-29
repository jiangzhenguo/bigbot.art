/**
 * mlxgen Provider — 本地图片生成/编辑引擎(mlx-gen, CLI `mlxgen`)
 * 覆盖:文生图 / 指令编辑 / I2I / Inpaint / Outpaint / 超分
 *
 * 骨架期行为:
 * - check():探测 `mlxgen` 命令(which + --help)
 * - submit:默认 dryRun=true(构造 mlxgen 命令 + 占位);false 时真实调用
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  type Provider,
  type ProviderStatus,
  type ProviderCapabilities,
  type RenderRequest,
  type RenderJobHandle,
  type RenderStatus,
} from '@bigbotart/shared';

const execFileP = promisify(execFile);

const DATA_DIR = process.env.BIGBOTART_HOME ?? join(homedir(), '.bigbotart');

export const MLXGEN_DEFAULTS = {
  bin: 'mlxgen',
  outputDir: process.env.BIGBOTART_MLXGEN_OUTPUTS ?? join(DATA_DIR, 'outputs', 'images'),
};

interface MlXGenProviderOptions {
  bin?: string;
  outputDir?: string;
  dryRun?: boolean;
}

export type { MlXGenProviderOptions };

export class MlXGenProvider implements Provider {
  readonly id = 'mlxgen' as const;
  readonly name = 'mlxgen (MLX 图片)';
  private bin: string;
  private outDir: string;
  private dryRun: boolean;
  private running = new Map<string, ChildProcess>();
  private outPaths = new Map<string, string>();
  /** 失败诊断:taskId → 累计 stderr 尾部 */
  private stderrs = new Map<string, string>();
  /** 实时进度:taskId → 最近一次 --json-events 运行时事件(stdout JSONL,2026-09 实测各路由均支持) */
  private events = new Map<string, MlxgenEvent>();

  constructor(opts: MlXGenProviderOptions = {}) {
    this.bin = opts.bin ?? MLXGEN_DEFAULTS.bin;
    this.outDir = opts.outputDir ?? MLXGEN_DEFAULTS.outputDir;
    this.dryRun = opts.dryRun ?? true;
  }

  async check(): Promise<ProviderStatus> {
    const st = { provider: this.id, installed: false, ready: false } as ProviderStatus;
    try {
      // 探测 PATH 中的 mlxgen
      const { stdout } = await execFileP('sh', ['-lc', `command -v ${this.bin}`], { timeout: 5000 });
      const path = stdout.trim();
      if (!path) {
        st.installHint = '运行 uv tool install --upgrade mlx-gen 安装';
        return st;
      }
      st.installed = true;
      st.installedPath = path;
      const { stdout: help } = await execFileP(path, ['--help'], { timeout: 5000 });
      const ver = /version[^\d]*([\d.]+)/i.exec(help);
      st.version = ver?.[1];
      st.ready = true;
      st.capabilities = await this.capabilities();
    } catch (e) {
      const msg = (e as Error).message;
      if (!/not found|command not found|ENOENT/.test(msg)) st.error = msg;
      st.installHint = '运行 uv tool install --upgrade mlx-gen;模型:mlxgen download --model <id>';
    }
    return st;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      provider: this.id,
      domains: ['image-gen', 'image-edit', 'image-upscale'],
      editModes: ['instruction', 'img2img', 'inpaint', 'outpaint'],
      aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '2:3'],
      models: [
        'AbstractFramework/z-image-turbo-8bit (Z-Image Turbo, 文生图, ~11GB)',
        'qwen-image (Qwen Image, 文生图)',
        'Qwen/Qwen-Image-2.1 (Qwen-Image-2.1 全量 bf16, 文生图/图生图/参考编辑(1-10 张), ~33GB)',
        'mlx-community/Qwen-Image-Edit-8bit (Qwen Image Edit 8bit, 指令编辑/mask, ~37.5GB)',
        'AbstractFramework/flux.2-klein-9b-8bit (多参考编辑/outpaint, ~18GB)',
        'AbstractFramework/seedvr2-3b-8bit (超分修复, ~4.7GB)',
      ],
      notes: [
        '图片槽位与视频槽位互斥',
        '模型文件需 mlxgen download 预下载',
        'Qwen-Image-2.1 统一用全量 bf16 checkpoint(8bit 社区导出无 vision tower,做不了编辑,已移除)',
      ],
    };
  }

  /** 自定义量化仓库 → 基座模型提示(CLI `--base-model`;不给会被误路由成文生图 handler) */
  private static readonly BASE_MODEL_HINTS: Record<string, string> = {
    'mlx-community/Qwen-Image-Edit-8bit': 'Qwen/Qwen-Image-Edit',
    // Qwen-Image-2.1 全量 bf16(官方 Qwen/Qwen-Image-2.1 仓库或其本地就地目录):
    // 必须给家族提示 —— 仓库全名不在 mlxgen catalog 里时 ConfigResolution 解析失败 →
    // aliases 为空 → 落家族兜底 `qwen.generate`(旧 Qwen Image,transformer/text encoder/VAE
    // 完全不同,加载必炸);**本地目录路径同样要给**(ConfigResolution 只按目录内容猜,
    // 不保证命中 2.1 族)。实测(2026-09-28):不给提示 capabilities 只报旧 `qwen.*` 行,
    // 给了才出 `qwen21.text` / `qwen21.edit` / `qwen21.latent`
    'Qwen/Qwen-Image-2.1': 'qwen-image-2.1',
    'Qwen-Image-2.1-bf16': 'qwen-image-2.1',
    // 已移除的 8bit 社区导出(2026-09-28 收敛到 bf16):**保留提示作向后兼容** ——
    // 老项目文件 / 老节点里存的模型名仍是它,不给提示会被家族兜底误路由成旧 `qwen.generate`
    // 直接加载失败。列表里已不提供该模型,但历史数据仍要能打开、能给出可用的报错或降级
    'JoyFusionAI/Qwen-Image-2.1-MLX-8bit': 'qwen-image-2.1',
  };

  /**
   * mlxgen 短别名 → 本机可用仓库
   *
   * `qwen-image-edit`:短别名会被 CLI 解析为全量 `Qwen/Qwen-Image-Edit`(57.7GB,未下载 →
   * exit 1 DownloadRequiredError),归一化到 8bit 社区仓库 + BASE_MODEL_HINTS 补路由提示。
   *
   * `qwen-image-2.1` / `qwen-2.1` / `qwen-image-21`:**统一归一化到全量 bf16**
   * (2026-09-28 收敛,原本指向 8bit 社区导出)。原因:
   *  - 8bit 社区导出为纯文生图产物,**无 vision tower**(text_encoder 仅 399 个语言侧张量、
   *    0 个 `visual.*`)且缺 per-component config.json → `qwen21.edit` 参考编辑根本做不了;
   *    而 bf16 三样能力(文生图 / latent img2img / 参考编辑)全有,真跑出图质量与速度都够用
   *    (实测 512²/20 步约 21 秒)
   *  - 留两个模型只会让用户在「文生图选了 8bit、想编辑时编辑不了」上踩坑
   */
  private static readonly MODEL_ALIASES: Record<string, string> = {
    'qwen-image-edit': 'mlx-community/Qwen-Image-Edit-8bit',
    'qwen-image-2.1': 'Qwen/Qwen-Image-2.1',
    'qwen-2.1': 'Qwen/Qwen-Image-2.1',
    'qwen-image-21': 'Qwen/Qwen-Image-2.1',
  };

  /**
   * Qwen-Image-2.1 参考编辑(`qwen21.edit`)可用的 checkpoint 标识。
   * ⚠️ 编辑路由**必须走带 vision tower 的全量 checkpoint**(bf16 实测 750 tensors 含
   * `visual.*` 351 个)。8bit 社区导出为纯文生图产物,缺 vision tower 与 per-component
   * config.json,跑编辑的直接失败文案:
   *   "<dir>/vae/config.json is missing. Qwen-Image-2.1 editing needs a full checkpoint..."
   * 本项目已统一到 bf16(短别名亦指向它),此判定保留作防御:若有人手工填了 8bit 仓库,
   * 仍能正确识别并走「纯文生图族」的既有防呆,而不是发出一条必炸的命令。
   */
  /** 该 repo(或本地目录名)是否是可用的 2.1 全量 checkpoint(带 vision tower) */
  private static isQwen21EditModel(model: string): boolean {
    const base = model.split('/').pop() ?? model;
    return /Qwen-Image-2\.1-bf16/i.test(base) || /Qwen-Image-2\.1$/i.test(model);
  }

  /**
   * repoId → 本地直用目录(用户已自行下载/导出的散装模型;命中则免下载、直接当 `--model` 传)。
   * 实测 2026-09:mlxgen 接受本地目录路径,但同样要配 `--base-model` 提示
   * (不带提示时本地路径也会被家族兜底误路由;见 BASE_MODEL_HINTS)
   */
  private static readonly LOCAL_MODEL_DIRS: Record<string, string> = {
    // Qwen-Image-2.1 全量 bf16(官方 Qwen/Qwen-Image-2.1 的本地就地目录,31GB,带 vision tower):
    // 2.1 的**唯一**模型(2026-09-28 收敛,原 8bit 社区导出已移除)。
    // 文生图 / latent img2img / `qwen21.edit` 参考编辑三种能力全有;8bit 社区导出缺 vision tower
    // 与 per-component config.json,做不了编辑(见 isQwen21EditModel 注释)。
    // 需要 BASE_MODEL_HINTS 的 `--base-model qwen-image-2.1` 路由提示(不给会落到旧 Qwen 家族兜底)
    'Qwen/Qwen-Image-2.1': 'Qwen-Image-2.1-bf16',
    'Qwen-Image-2.1-bf16': 'Qwen-Image-2.1-bf16',
    // 兼容曾用过 8bit 本地目录的用户:仍认这个目录名,但归一化到同一份 bf16 模型
    // (旧目录若还在也只作路径解析,编辑能力以 bf16 为准)
    'JoyFusionAI/Qwen-Image-2.1-MLX-8bit': 'Qwen-Image-2.1-bf16',
    // FLUX.2 Klein 9B:官方 AbstractFramework 仓库在 HF 上是 gated,国内直连常不通;
    // 实际来源是 ModelScope 的 mlx-community/flux2-klein-9b-8bit(与之同源),
    // 下到本地模型根后即以散装目录直用,免下载、免 HF 授权。
    // 该仓库能被 mlxgen catalog 的 flux2-klein-9b 别名命中(实测 capabilities 正确路由
    // 到 flux2.generate / flux2.edit),故 BASE_MODEL_HINTS 无需补提示
    'AbstractFramework/flux.2-klein-9b-8bit': 'flux2-klein-9b-8bit',
  };

  /** 本地模型根(与主进程 mlxgen-models.ts 的 localModelsRoot() 同口径) */
  private static localModelsRoot(): string {
    return process.env.BIGBOTART_MODELS_DIR ?? join(homedir(), 'ai', 'models');
  }

  /** statSync 兜底(文件缺失/权限 → null,不抛) */
  private static statSafe(p: string): { size: number } | null {
    try {
      return statSync(p);
    } catch {
      return null;
    }
  }

  /**
   * 是否「只有 latent img2img、没有 reference edit 能力」的模型(纯文生图族)。
   * 判定依据 = mlxgen capabilities 的 handler(实测 2026-09):
   *  - z-image-turbo / qwen-image-2.1(8bit 文生图导出) → handler `z-image.generate` /
   *    `qwen21.generate`,能力集只有 text-only 与 latent-img2img,**没有** edit-reference
   *  - Qwen-Image-Edit → `qwen.edit`(edit-reference);flux.2-klein → `flux2.edit`(含 outpaint)
   *  - 🌟 **Qwen-Image-2.1 全量 bf16 → `qwen21.edit`(edit-reference,1-10 张参考图)**。
   *    这是 2026-09-28 引擎新增的能力:同一个模型族,文生图导出做不了编辑、全量导出能编辑,
   *    **不能按族名一刀切**,故此处先放行带 vision tower 的编辑 checkpoint。
   * 传给纯文生图族的输入图会被 auto 路由成 latent i2i,进而要求 --image-strength(缺则 exit 2)
   */
  private static latentOnly(model: string): boolean {
    if (/qwen.*image.*edit/i.test(model) || /flux.?2.*klein/i.test(model)) return false;
    // 2.1 全量 bf16 有 edit-reference 能力(qwen21.edit),不是纯文生图族
    if (MlXGenProvider.isQwen21EditModel(model)) return false;
    return /z-image/i.test(model) || /qwen-image-2\.1/i.test(model) || /qwen.*2\.1/i.test(model);
  }

  /**
   * 若该 repo 在本地模型根下有就绪目录,返回该目录路径(优先于 repoId)。
   * 校验与主进程 isLocalModelDir 同口径(缺一不可,否则会拿半截模型去推理):
   *  1. transformer/ 下有权重分片
   *  2. 存在 *.safetensors.index.json 时,其 weight_map 引用的每个分片都必须真实存在
   *     (实测:索引小文件先下完、权重没下完是常见中断形态;只看「有权重文件」会误判就绪)
   * 返回 undefined 即回退 repoId(走 HF 缓存 / mlxgen 自动下载)
   */
  private static localDirFor(repoId: string): string | undefined {
    const name = MlXGenProvider.LOCAL_MODEL_DIRS[repoId];
    if (!name) return undefined;
    const tf = join(MlXGenProvider.localModelsRoot(), name, 'transformer');
    try {
      if (!existsSync(tf)) return undefined;
      const files = readdirSync(tf);
      if (!files.some((f) => /\.(safetensors|gguf|bin)$/i.test(f))) return undefined;
      const idx = files.find((f) => f.endsWith('.safetensors.index.json'));
      if (idx) {
        const parsed = JSON.parse(readFileSync(join(tf, idx), 'utf-8')) as {
          weight_map?: Record<string, string>;
        };
        for (const shard of new Set(Object.values(parsed.weight_map ?? {}))) {
          const st = MlXGenProvider.statSafe(join(tf, shard));
          if (!st || st.size === 0) return undefined; // 分片缺失/空 → 半截模型,不用
        }
      }
      return join(MlXGenProvider.localModelsRoot(), name);
    } catch {
      return undefined; // 索引损坏/不可读 → 宁可回退下载,也不给残模型
    }
  }

  async submit(req: RenderRequest): Promise<RenderJobHandle> {
    if (req.slot !== 'image') throw new Error('mlxgen 仅支持图片任务');
    const p = req.params as Record<string, unknown>;
    const kind = (p.kind as string) ?? 'generate';
    // 默认模型按 kind 分派(真实事故:Agent 建 image-edit 节点只写了 prompt,没写 model,
    // 缺省成 z-image 纯文生图模型,CLI auto 路由成 latent i2i 缺 --image-strength 直接 exit 2):
    //   文生图/img2img → z-image-turbo;指令编辑/inpaint/outpaint → Qwen Image Edit;超分 → SeedVR2
    // 注意:instruction 的默认仍是 Qwen Image Edit(存量行为不变)。要用 Qwen-Image-2.1 参考编辑
    // (1-10 张参考图 / 原生 RGBA)需在检查器把模型显式换成 Qwen/Qwen-Image-2.1(全量 bf16)
    const DEFAULT_MODEL_BY_KIND: Record<string, string> = {
      generate: 'AbstractFramework/z-image-turbo-8bit',
      img2img: 'AbstractFramework/z-image-turbo-8bit',
      instruction: 'mlx-community/Qwen-Image-Edit-8bit',
      inpaint: 'mlx-community/Qwen-Image-Edit-8bit',
      outpaint: 'mlx-community/Qwen-Image-Edit-8bit',
      upscale: 'AbstractFramework/seedvr2-3b-8bit',
    };
    const rawModel = String(p.model ?? DEFAULT_MODEL_BY_KIND[kind] ?? 'AbstractFramework/z-image-turbo-8bit');
    const repoModel = MlXGenProvider.MODEL_ALIASES[rawModel] ?? rawModel;
    // 本地直用目录优先(免下载):repoId 在本地模型根下有就绪目录时改用该路径;
    // BASE_MODEL_HINTS 仍按 repoId 查——路由提示与「模型在哪」无关,二者必须一起生效
    const localDir = MlXGenProvider.localDirFor(repoModel);
    const model = localDir ?? repoModel;
    const taskId = `mlxgen-${kind}-${Date.now()}`;
    const outBase = `${this.outDir}/${req.nodeId}_${taskId}`;

    // 命令构造对齐真实 mlx-gen CLI(2026-09 静态+实测验证,见 docs/图片生成与编辑能力现状盘点.md 附录):
    // - `--seed` 必须展开为独立参数(`--seed 42 43`),join 成单个 token 会被后端 int 解析拒绝
    // - `upscale` 是无提示词路由,不接受 `--prompt`;`--resolution` 整数=目标短边像素、`2x`=倍率,
    //   检查器存的是数字(2/4),必须转成 `2x/4x`
    // - edit 的 img2img 需 `--i2i-mode latent`(否则被路由成指令编辑);outpaint 需 `--outpaint-padding`
    // - 自定义量化仓库需 `--base-model` 提示(实测:mlx-community/Qwen-Image-Edit-8bit 不给提示会被
    //   误路由成 qwen.generate 文生图,给了才走 qwen.edit 编辑 handler)
    const cmd = ['generate', '--model', model, '--prompt', String(p.prompt ?? ''), '--json-events'];
    // 路由提示按 repoId 查(不能用 model:走本地路径时 model 是目录,查不到提示 → 会被
    // 家族兜底误路由)。实测:本地目录同样需要 `--base-model qwen-image-2.1`
    const baseHint = MlXGenProvider.BASE_MODEL_HINTS[repoModel];
    if (baseHint) cmd.push('--base-model', baseHint);
    const seeds = normalizeSeeds(p.seeds);
    let outPath = `${outBase}.png`;
    if (kind === 'generate') {
      cmd.push('--width', String(p.width ?? 768), '--height', String(p.height ?? 768));
      // Qwen-Image-2.1 官方推荐 40 步且无 guidance(guidance 1.0 时负向 pass 整体跳过);
      // 其余模型维持 24 步 + guidance 1.0 的既有默认(见 mlxgen 各模型 README)
      // 按 **repoModel 正则**判 2.1 族(不能只匹配某一个 repoId:本地路径时 model 是目录,
      // 且 2.1 现有 bf16 与历史 8bit 两个标识,漏一个就会让 40 步默认静默回落成 24)
      const isQwen21 = /qwen.*2\.1/i.test(repoModel);
      const defSteps = isQwen21 ? 40 : 24;
      // ⚠️ 根因记录(2026-09,真实事故:klein exit 2 且表现为「同参数一次成一次败」):
      // FLUX.2 Klein 是**蒸馏**模型,裸 `mflux-generate-flux2` 只对 FLUX.2 **base** 模型接受
      // `--guidance`;给 klein 传会被 argparse 直接拒绝并退出:
      //   "mflux-generate-flux2: error: --guidance is only supported for FLUX.2 base models" → exit 2
      // 故按模型族判定, klein 族一律不推 --guidance(缺省走模型自带默认).
      // 注意判定用 repoModel(本地目录路径时 model 是目录,正则匹配不到 → 会误推参数).
      const isFlux2Klein = /flux.?2.*klein/i.test(repoModel);
      cmd.push('--steps', String(p.steps ?? defSteps));
      if (!isFlux2Klein) cmd.push('--guidance', String(p.guidance ?? 1.0));
      if (p.negativePrompt) cmd.push('--negative-prompt', String(p.negativePrompt));
      // 参考图(ref-image 连线):多参考生成路由 —— 实测(2026-09)CLI 接受 `--i2i-mode multi-reference`
      // + 重复 `--image`(仅多参考 i2i 可重复);z-image-turbo 是纯文生图,带参考图时给明确指引报错
      //
      // ⚠️ 根因记录(2026-09,真实事故:klein 多参考 exit 2):
      // `--image` 是 mlx-gen **路由器入口**参数(router_options.py),后端不认识它。
      // 路由器按 handler 把 `--image` 改写成后端真实参数名:
      //   handler `flux2.generate`(能力行 flux2.latent,max_images=1)→ `--image-path`(单张,不支持多图)
      //   handler `flux2.edit`(能力行 flux2.multi-reference,max_images=None)→ `--image-paths`(复数,多图)
      // `--i2i-mode multi-reference` 是路由器判定到 multi-reference 能力行的**唯一开关**;
      // 一旦它与图片数量不匹配(如 2 张图却落到单图 handler),改写链断裂,`--image` 被原样透传
      // 给裸 `mflux-generate-flux2`,argparse 直接报歧义退出:
      //   "ambiguous option: --image could match --image-path, --image-strength" → exit 2
      // 故此处**按图片数量显式选择 i2i-mode**,绝不依赖 CLI 的 auto 推断。
      const refPaths = (req.references ?? [])
        .filter((r) => r.role === 'ref-image' && r.localPath)
        .map((r) => String(r.localPath));
      if (refPaths.length > 0) {
        if (!/flux.?2.*klein/i.test(model)) {
          throw new Error(
            `带参考图的生成需要多参考模型(当前 ${model} 是纯文生图):` +
              '请把节点模型改为 AbstractFramework/flux.2-klein-9b-8bit(约 18GB,设置页「模型」可下载),' +
              '或断开参考图连线再提交',
          );
        }
        // 单图 → edit(flux2.edit 能力行,单图 max_images=1);多图 → multi-reference(复数参数)
        // 合法取值归一化后为 auto / latent-img2img / edit-reference / multi-reference,
        // 别名 `edit` ≡ `edit-reference`(task_inference.py I2I_MODE_ALIASES);
        // 两者都显式声明,避免 auto 推断把 2 张图塞进单图 handler
        cmd.push('--i2i-mode', refPaths.length > 1 ? 'multi-reference' : 'edit');
        for (const rp of refPaths) cmd.push('--image', rp);
      }
      if (seeds.length > 0) {
        cmd.push('--seed');
        for (const s of seeds) cmd.push(String(s));
        // 多 seed 时官方自动按 `_seed_<n>` 追加文件名;登记第一个产物的真实路径,便于 UI 回写预览
        if (seeds.length > 1) outPath = `${outBase}_seed_${seeds[0]}.png`;
      }
      cmd.push('--output', `${outBase}.png`);
    } else if (kind === 'upscale') {
      cmd.splice(0, 1, 'upscale');
      // 去掉 generate 分支遗留的 --prompt(实测:mlxgen upscale 报 unrecognized arguments: --prompt)
      const pi = cmd.indexOf('--prompt');
      if (pi !== -1) cmd.splice(pi, 2);
      const scale = String(p.scale ?? '2x');
      const res = /^\d+$/i.test(scale) ? `${scale}x` : scale; // 数字 → 倍率 'Nx'(裸整数会被当成短边像素)
      cmd.push('--image-path', String(p.inputPath ?? ''), '--resolution', res, '--output', outPath);
    } else {
      // edit:instruction / img2img / inpaint / outpaint(统一走 mlxgen generate 路由)
      //
      // 🌟 Qwen-Image-2.1 参考编辑(`qwen21.edit`,2026-09-28 引擎新增):**独立路由**,
      // 参数面与其它编辑族不同,必须单独构造,不能混用下面的通用分支:
      //  - 参考图用 `--image-paths p1 p2 ...`(`nargs='+'`,一次给多张);
      //    而 flux2/qwen-edit 是重复 `--image`(路由器按 `--i2i-mode` 改写成 --image-path(s))
      //  - 支持 1-10 张参考图;超过 10 张 CLI 直接 parser.error
      //  - **不接受 `--image-strength`**(该路由是 edit-reference,不是 latent i2i)
      //  - 输出**必须是 RGBA 保留格式**(.png/.webp/.tif/.tiff),否则 CLI 报错退出
      //  - `--scheduler` 只能是 linear(未传=默认 linear,安全)
      //  - 最少 2 步("requires at least two steps for terminal sigma shifting")
      const isQwen21Edit = MlXGenProvider.isQwen21EditModel(repoModel) && kind === 'instruction';
      if (isQwen21Edit) {
        // 参考图:input 连线的输入图 + ref-image 连线的参考图,统一进 --image-paths。
        // 2.1 编辑的「底图」和「参考图」在 CLI 侧是同一个参数(参考图列表),
        // 顺序即语义:第一张锚定几何,后续提供风格/材质线索(见 mlx-gen docs/image-edit-modes.md)
        const qwen21Refs: string[] = [];
        if (p.inputPath) qwen21Refs.push(String(p.inputPath));
        for (const r of req.references ?? []) {
          if (r.localPath && !qwen21Refs.includes(String(r.localPath))) qwen21Refs.push(String(r.localPath));
        }
        if (qwen21Refs.length === 0) {
          throw new Error(
            'Qwen-Image-2.1 参考编辑需要至少 1 张参考图:请把图片节点/资产节点连到本节点的输入端口;' +
              '若想纯文生图,请把模型换成 AbstractFramework/z-image-turbo-8bit 或改用「文生图」节点',
          );
        }
        if (qwen21Refs.length > 10) {
          throw new Error(
            `Qwen-Image-2.1 参考编辑最多支持 10 张参考图(当前 ${qwen21Refs.length} 张);` +
              '请断开多余的参考图连线',
          );
        }
        cmd.push('--image-paths');
        for (const rp of qwen21Refs) cmd.push(rp);
        // ⚠️ **必须显式声明 `--i2i-mode edit`**(真实事故 2026-09-28,多参考真跑 exit 2):
        // ml-gen 的模式推断(task_inference._resolve_i2i_mode)在「多张 `--image-paths`」时
        // 会自动判成 `multi-reference`:
        //   requested_mode = MODE_MULTI_REFERENCE if image_count > 1 else MODE_EDIT_REFERENCE
        // 而 2.1 的能力行是 **edit-reference**(`qwen21.edit`,max_images=10),
        // 于是撞上通用校验:
        //   "Qwen Image 2.1 does not support multi-reference image-to-image generation." → exit 2
        // 1 张时碰巧推对(edit-reference)所以单参考正常,多参考必炸 —— 显式传 `edit` 后
        // 走 `requested_mode = i2i_mode` 分支不被改写,1 张与多张都对。
        // 注意:这里的 `edit` 是 CLI 的模式名(≡ edit-reference),与我们的 `--image-paths` 复数
        // 参数不冲突(那是「怎么给图」,这是「走哪条路由」)。
        cmd.push('--i2i-mode', 'edit');
        // 像素面积预算:参考图会被缩放到该预算,并据此推导输出尺寸(默认 1024)
        if (p.outputResolution != null && Number.isFinite(Number(p.outputResolution))) {
          cmd.push('--output-resolution', String(Number(p.outputResolution)));
        }
        // 步骤:检查器未设置时兜底 30,与检查器 DEFAULT_EDIT_STEPS 同口径(A 方案)。
        // ⚠️ 根因记录(2026-09-29「不改 step 直接就是 40 步」):此处原为无条件 `?? 40`,
        // 而检查器只把 4 显示在滑块上、并不写回 data → **界面显示 4、实跑 40**,
        // 且没有任何地方能让用户看出来(2.1 上 40 步约 4 分钟,6 步版仅 54-92 秒)。
        // 现在两端统一 30:检查器负责写回 data,这里的兜底只作**安全网**
        // (历史节点 / Agent 直传 data 未带 steps 时),不再是一套隐藏默认值。
        cmd.push('--steps', String(Number(p.steps ?? 30)));
        if (p.negativePrompt) cmd.push('--negative-prompt', String(p.negativePrompt));
        if (seeds.length > 0) {
          cmd.push('--seed');
          for (const s of seeds) cmd.push(String(s));
          if (seeds.length > 1) outPath = `${outBase}_seed_${seeds[0]}.png`;
        }
        // RGBA 硬约束:输出必须保留 alpha 的后缀(2.1 编辑会生成透明像素)
        outPath = `${outBase}.png`;
        cmd.push('--output', outPath);
        (this as unknown as Record<string, unknown>).lastCmd = cmd;
        this.outPaths.set(taskId, outPath);
        if (!this.dryRun) this.spawnRun(taskId, cmd);
        return { providerTaskId: taskId };
      }
      if (p.inputPath) cmd.push('--image-path', String(p.inputPath));
      // 采样步数:仅在用户显式设置时传(检查器未设置 → data 无 steps → 不传,
      // 交给 mlxgen 用模型自身默认值,既有节点行为完全不变)。
      // 背景:编辑原本既无检查器控件、provider 也不传 --steps,质量被静默固定在模型默认步数
      // (实测 2026-09:flux.2-klein / z-image-turbo 不传时均为 4 步,对去水印、改动作偏少)。
      // 与 generate 分支不同,这里**不给兜底默认值**——给了就等于改变所有存量节点的生成结果
      if (p.steps != null && Number.isFinite(Number(p.steps))) {
        cmd.push('--steps', String(Number(p.steps)));
      }
      // 防呆(真实事故 2026-09):给「纯文生图族」模型(z-image-turbo / qwen-image-2.1)
      // 传了输入图、却不带 mask、也不带 --i2i-mode/--image-strength 时,CLI 的 auto 路由
      // 会把「有输入图」判成 latent i2i,然后 exit 2:
      //   "--image-strength is required for latent image-to-image mode."
      // 该报错出现在 instruction/outpaint 模式下,用户看不懂。
      // ⚠️ 边界(实测 2026-09):z-image **能**做 inpaint(有 z-image.inpaint = edit-reference + mask),
      //    带 --mask-path 时 CLI 走编辑路由,不会报错 —— 所以必须放行有 mask 的提交,否则误伤。
      //    Flux.2 Klein / Qwen Image Edit 不受影响(有 edit-reference 能力,交给 CLI 正常路由)。
      const hasMask = Boolean(p.maskPath);
      if (kind !== 'img2img' && p.inputPath && !hasMask && MlXGenProvider.latentOnly(model)) {
        throw new Error(
          `模型 ${model} 不支持「指令编辑」(它没有 reference-edit 能力,只有文生图 + 图生图);` +
            '请在检查器把模型改为 mlx-community/Qwen-Image-Edit-8bit(指令编辑)或 ' +
            'AbstractFramework/flux.2-klein-9b-8bit(多参考/扩图);' +
            '若想保留当前模型,可改用「图生图」(带图像强度),或改用「Inpaint」(带遮罩)',
        );
      }
      if (kind === 'img2img') {
        // 实测防呆(2026-09 真实跑):Qwen Image Edit 无 latent I2I 能力,
        // mlxgen 直接 exit 2("Qwen Image Edit does not support latent image-to-image generation");
        // 图生图须用 Z-Image Turbo(capabilities:z-image.latent / latent-img2img,本机已验证)
        if (model in MlXGenProvider.BASE_MODEL_HINTS || /qwen.*image.*edit/i.test(model)) {
          throw new Error(
            `图生图(img2img)模式不支持模型 ${model}(Qwen Image Edit 无 latent I2I 能力);` +
              '请在检查器把模型改为 AbstractFramework/z-image-turbo-8bit,或改用「指令编辑」模式',
          );
        }
        cmd.push('--i2i-mode', 'latent');
        // 图像强度(0-1):实测 latent 路由 **--image-strength 必填**(exit 2: is required for
        // latent image-to-image mode);未设置/越界时回退 0.5(与检查器默认值一致),不省略该参数
        const st = Number(p.imageStrength);
        const strength = Number.isFinite(st) && st > 0 && st <= 1 ? st : 0.5;
        cmd.push('--image-strength', strength.toFixed(2));
      }
      if (kind === 'inpaint' && p.maskPath) cmd.push('--mask-path', String(p.maskPath));
      if (kind === 'outpaint') {
        const sides = (p.outpaintSides ?? undefined) as
          | { top?: number; bottom?: number; left?: number; right?: number }
          | undefined;
        if (sides) {
          const pad = `${sides.top ?? 0},${sides.right ?? 0},${sides.bottom ?? 0},${sides.left ?? 0}`;
          if (/\d/.test(pad)) cmd.push('--outpaint-padding', pad);
        }
      }
      cmd.push('--output', outPath);
    }
    (this as unknown as Record<string, unknown>).lastCmd = cmd;
    this.outPaths.set(taskId, outPath);
    if (!this.dryRun) this.spawnRun(taskId, cmd);
    return { providerTaskId: taskId };
  }

  /**
   * 真实执行一次 mlxgen 命令(spawn + stderr 诊断留存 + stdout JSONL 进度解析)。
   * 抽成方法供 submit 的多条路由分支复用(2.1 参考编辑分支提前 return,否则会漏掉这套接线)
   */
  private spawnRun(taskId: string, cmd: string[]): void {
    const child = spawn(this.bin, cmd, { stdio: ['ignore', 'pipe', 'pipe'] });
    const errAcc: string[] = [];
    child.stderr.on('data', (d: Buffer) => {
      errAcc.push(d.toString());
      this.stderrs.set(taskId, errAcc.join('').slice(-1600));
    });
    // --json-events:stdout 逐行 JSON(phase/step/total_steps/progress),解析成实时进度
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const ev = JSON.parse(t) as MlxgenEvent;
          if (ev && typeof ev === 'object') this.events.set(taskId, ev);
        } catch {
          /* 非 JSON 行忽略 */
        }
      }
    });
    this.running.set(taskId, child);
  }

  async status(handle: RenderJobHandle): Promise<RenderStatus> {
    const child = this.running.get(handle.providerTaskId);
    if (!child) {
      return { status: 'SUCCEEDED', progress: 1, stage: 'dry-run (未真实推理);命令见日志', resultPath: this.outPaths.get(handle.providerTaskId) };
    }
    if (child.exitCode !== null) {
      if (child.exitCode === 0) {
        return { status: 'SUCCEEDED', progress: 1, stage: 'done', resultPath: this.outPaths.get(handle.providerTaskId) };
      }
      const errTail = (this.stderrs.get(handle.providerTaskId) ?? '').split('\n').filter(Boolean).slice(-4).join(' | ').slice(0, 300);
      return { status: 'FAILED', error: `mlxgen exit ${child.exitCode}: ${errTail || '见日志'}` };
    }
    const ev = this.events.get(handle.providerTaskId);
    return { status: 'RUNNING', progress: ev?.progress, stage: ev ? mlxgenStage(ev) : 'mlxgen 推理中' };
  }

  async cancel(handle: RenderJobHandle): Promise<void> {
    const child = this.running.get(handle.providerTaskId);
    if (child) child.kill('SIGTERM');
    this.running.delete(handle.providerTaskId);
  }
}

/** mlxgen --json-events 的运行时事件(stdout JSONL) */
interface MlxgenEvent {
  phase?: string;
  step?: number;
  total_steps?: number;
  progress?: number;
}

/** phase → 中文阶段名(未知阶段原样透传),有步数时附「当前/总步数」 */
const MLXGEN_PHASE_LABELS: Record<string, string> = {
  start: '初始化/加载模型',
  denoise: '去噪',
  generated: '解码出图',
  save: '保存产物',
  complete: '完成',
};

function mlxgenStage(ev: MlxgenEvent): string {
  const label = MLXGEN_PHASE_LABELS[ev.phase ?? ''] ?? (ev.phase || 'mlxgen 推理中');
  return ev.step != null && ev.total_steps ? `${label} ${ev.step}/${ev.total_steps}` : label;
}

/** 归一化 seeds:数组成员 / 单整数 / 逗号或空格分隔字符串 → number[] */
function normalizeSeeds(v: unknown): number[] {
  const arr = Array.isArray(v)
    ? v
    : typeof v === 'number' || typeof v === 'string'
      ? [v]
      : [];
  return arr
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && Number.isInteger(n));
}