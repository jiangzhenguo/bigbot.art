# mlxgen 图片引擎 — 引导安装与模型管理全流程

> 适用:BigBotArt 图片类节点(image-gen / image-edit / image-upscale)的本地推理引擎。
> 本文档覆盖:**安装 CLI → 下载模型 → 应用内引导/设置页校验 → 真实推理开关 → 能力矩阵 → 排障**。
> 相关:节点能力定义见 `docs/节点手册.md` §3.3–3.5;视频引擎 h3.c 见 `docs/H3_USAGE.md`。

## 0. 一句话流程

```bash
brew install uv                       # 前置:Python 包管理器(未装时)
uv tool install --upgrade mlx-gen     # 1) 安装 mlxgen CLI
mlxgen download --model <model-id>    # 2) 按需下载模型(见 §3 清单)
mlxgen --help                         # 3) 验证
# 4) 应用内:设置 → 引擎 → mlxgen「检测 / 管理模型」+ 打开「真实推理」
```

---

## 1. 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| 系统 | macOS(Arm64,Apple Silicon) | mlx-gen 基于 Apple MLX 框架,Metal 加速 |
| Python | 3.11+ | `uv` 自动管理,无需手动建 venv |
| uv | ≥ 0.4 | `brew install uv` |
| 磁盘 | 每模型 2–9GB | 模型文件由 mlxgen 管理下载 |
| 显存 | 建议 ≥ 24GB 统一内存 | 图片推理吃显存;与视频槽位互斥(64GB 策略) |

---

## 2. 安装 mlxgen CLI

**方式 A:命令行(推荐)**
```bash
brew install uv
uv tool install --upgrade mlx-gen
mlxgen --help          # 应打印帮助与版本号
```

**方式 B:应用内引导**
- 首次启动引导向导「安装组件」→ mlxgen 行显示 `未安装 · pip 包(uv tool install)`;点击安装按钮会给出并尝试执行上面的命令(`install-runtime` IPC)。
- 设置页「引擎」→ `mlxgen(图片主引擎)` 行:可用 `检测` 重新探测,探测通过后节点即可用。

**验证产物**
- 应用 `probeRuntimes` / 设置页探测:`installed=true` 表示 CLI 在 PATH;`ready=true` 表示 `--help` 可执行。
- ⚠️ `ready` **不代表模型已下载**——模型缺失时提交会失败,见 §3 下载与 §6 排障。

---

## 3. 模型管理与下载(`mlxgen download`)

每个模型族一个 id,按节点用途选装:

| 节点用途 | 模型 id(capabilities 声明) | 体积* | 说明 |
|---|---|---|---|
| 文生图(默认) | `AbstractFramework/z-image-turbo-8bit` | ~11GB | Z-Image Turbo,image-gen 默认 |
| 文生图 + 参考编辑(新一代) | `Qwen/Qwen-Image-2.1`(本地目录 `Qwen-Image-2.1-bf16`) | ~33GB | Qwen-Image-2.1 全量 bf16(7.1B 单流 block-causal + Qwen3-VL 文本编码器 + 4 通道因果 VAE)。**2.1 的唯一模型**(2026-09-28 收敛,原 `JoyFusionAI/...-8bit` 已移除 —— 它无 vision tower、做不了编辑)。能力:**文生图 / latent img2img / 参考编辑 `qwen21.edit`(1-10 张 / 原生 RGBA)**。Provider 自动追加 `--base-model qwen-image-2.1`(仓库全名不在 catalog 里、本地目录同样要给,否则被家族兜底误路由成旧 `qwen.generate`,transformer/编码器/VAE 全不同,加载必失败);默认 **40 步**(官方推荐,guidance 1.0 时负向 pass 整体跳过)。**不支持** ControlNet / outpaint / reframe |
| 文生图(备选) | `qwen-image` | 中等 | Qwen Image(初代,与 2.1 不是同一模型族) |
| 指令编辑 / mask | `mlx-community/Qwen-Image-Edit-8bit` | ~37.5GB | image-edit `instruction` / `inpaint`;8bit 量化版(官方原版 57.7GB,64GB 内存跑不动)。生成时 Provider 自动追加 `--base-model Qwen/Qwen-Image-Edit`(不给会被误路由成文生图 handler) |
| 多参考编辑 / outpaint | `AbstractFramework/flux.2-klein-9b-8bit` | ~18GB | image-edit 多参考 / 扩图 |
| 图片增强(超分) | `AbstractFramework/seedvr2-3b-8bit` | ~4.7GB | image-upscale |
| 看图反推(图片 → 文本) | `gavinmroy/Qwen3-VL-8B-NSFW-Caption-V4.5-affine-4bit` | ~5.4GB | Agent `vision.caption` 的**本地通道**(`mlxgen-caption`,2026-10 接入,见 §6.1)。V4.5 caption 微调(专为提示词反推),必须是 **MLX 格式 dense Qwen3-VL**;原 `qwen2.5-vl`(torch 布局)mlx-gen 加载不了,已替换。⚠️ **无 ModelScope 镜像** → 应用内下载走 HF 通道;HF 不通时在 LM Studio 里下(下完自动认「已就绪」) |

*体积 = HF 官方文件清单实测汇总(2026-09;设置页/检查器展示同口径)。Qwen-Image-2.1 bf16 全量约 33GB(本地目录实测 31GB)

```bash
# 全部装齐(建议先只装 Z-Image-Turbo 跑通闭环;Qwen 系建议用设置页下载,走 ModelScope 直连)
mlxgen download --model AbstractFramework/z-image-turbo-8bit
mlxgen download --model Qwen/Qwen-Image-2.1
mlxgen download --model mlx-community/Qwen-Image-Edit-8bit --base-model Qwen/Qwen-Image-Edit
# ...
```

### 3.1 本地目录直用(免重复下载)

若模型已由用户自行下载/导出到本地目录(散装 HF 布局:`transformer/` + `text_encoder/` + `vae/`),
**不必再拉一份到 HF 缓存**。App 会自动识别并优先使用本地路径:

- 默认根目录 `~/ai/models`(可用 `BIGBOTART_MODELS_DIR` 覆盖)
- 识别方式:`<root>/<模型名>/transformer/` 下有权重分片,且存在 `model.safetensors.index.json` 时
  其 `weight_map` 引用的每个分片都真实存在(防「索引先下完、权重没下完」的半截模型被误用)
- 命中后 `--model` 传本地绝对路径,设置页/检查器显示「已就绪」,不再触发下载

```bash
# 手动验证本地目录可用(注意 --base-model 提示不能省)
mlxgen capabilities --model ~/ai/models/Qwen-Image-2.1-bf16 --base-model qwen-image-2.1
```

> ⚠️ 本地路径**同样需要** `--base-model` 提示。实测:不带提示时本地目录也会被家族兜底
> 误路由成旧 `qwen.generate`(2.1 与初代的 transformer / 文本编码器 / VAE 完全不同)。
> Provider 侧 `BASE_MODEL_HINTS` 按 **repoId**(而非路径)查提示,二者必须同时生效。

实测性能(M5 Max,1024²,40 步):约 **3.5 s/步、全图 2 分 20 秒**;权重约 22GB 常驻(8bit 导出)。

> ⚠️ **Qwen-Image-2.1 需要 mlx-gen ≥ 0.38.0**。0.37.0 及更早版本没有 `qwen21` 模型族:
> `mlxgen capabilities --model Qwen/Qwen-Image-2.1` 不会报错,但会返回**旧 Qwen Image**
> 的能力集(`qwen.generate` handler),真跑才会在加载权重时失败。本机源码在 `~/ai/mlx-gen`
> (分支 `feat/qwen-image-2.1`),用 `uv tool install --force --no-cache ~/ai/mlx-gen` 安装/升级。
> 该分支 `pyproject.toml` 的 `[project.scripts]` 里两个含裸点号的 key
> (`mflux-generate-qwen-2.1` / `mlxgen-generate-qwen-2.1`)**必须加引号**,否则 TOML 会把它
> 解析成嵌套 map,`uv tool install` 直接报 `invalid type: map, expected a string`。
>
> ⚠️ **改完源码务必加 `--no-cache`**:`uv tool install --force` 会复用构建缓存,
> 源码改了但装进去的还是旧文件(实测踩坑:改了 `qwen21_generate.py` 后
> `grep CliRuntimeEventStream site-packages/.../qwen21_generate.py` 为 0 匹配,
> 表现为「改了没生效」)。装完**用 grep 复核安装目录**再测。
>
> ⚠️ **qwen21 路由曾缺进度事件**(2026-09 修复,`src/mflux/models/qwen21/cli/qwen21_generate.py`):
> 该 CLI 未接 `CliRuntimeEventStream`,`--json-events` 被静默忽略 → App 里 2.1 全程无进度
> (模型卡在「推理中」)。已按 z-image/flux2 同构补上 `events.subscribe_model` +
> `emit_save/emit_complete/emit_failed`。**注意 `image_util` 的 `ctx.in_loop` 调用本身是齐的**,
> 缺的只是 CLI 层的事件订阅——排查时别往推理循环里找。
> 验证:`mlxgen generate --json-events ... | head` 应输出 `start/denoise(N/N)/save/complete` JSONL;
> 若只有 tqdm 进度条(stderr)而 stdout 为空,就是这套事件没接。

### Qwen-Image-2.1 参考编辑(`qwen21.edit`,2026-09-28)

2.1 支持**指令化参考编辑**(1–10 张参考图、原生 RGBA、prefix KV cache)。App 里统一用
**全量 bf16** 一个模型搞定全部三种能力:

| 能力 | 全量 bf16(`Qwen/Qwen-Image-2.1`) |
|---|---|
| 文生图 + latent img2img | ✅ |
| **参考编辑 `qwen21.edit`** | ✅ 1–10 张参考图、原生 RGBA |
| text_encoder tensors | 750(**351 个 `visual.*`**) |

> ⚠️ **8bit 社区导出(`JoyFusionAI/Qwen-Image-2.1-MLX-8bit`)已从列表移除**(2026-09-28)。
> 它只能做文生图/latent img2img —— 编辑链路要用 Qwen3-VL vision tower 编码每张参考图,
> 而 8bit 导出是为纯文生图产的:text_encoder 只有 399 个语言侧张量、**0 个 `visual.*`**,
> 且缺 per-component `config.json`。实测失败文案:
> `<dir>/vae/config.json is missing. Qwen-Image-2.1 editing needs a full checkpoint...`
> **留着它只会让人在「文生图选了 8bit、想编辑时编辑不了」上踩坑**,而 bf16 出图质量与速度
> 都够用(实测 512²/20 步约 21 秒),故收敛为一个模型。
> 老项目文件里存的 8bit 仓库名仍能正常打开(别名与 `--base-model` 提示保留作向后兼容,
> 会落到同一份 bf16);手工填 8bit 跑编辑则走既有防呆明确报错,不发必炸的命令。

**引擎版本要求**:正式包 0.38.0 **没有** `qwen21.edit` 路由 —— `mlxgen capabilities` 只报
`qwen21.text`/`qwen21.latent`,传参考图会被判成 latent i2i 并索要 `--image-strength`。
该实现目前只在源码工作区(未提交):`src/mflux/models/qwen21/reference/` +
`variants/edit/qwen_image_21_edit.py` + `cli/qwen21_edit_generate.py`。安装方式:

```bash
cd ~/ai/mlx-gen && uv tool install --editable . --force   # 改代码即时生效,调试期推荐
# 或一次性覆盖安装:uv tool install --force --no-cache ~/ai/mlx-gen
# 复核(必须能列出 qwen21.edit 行):
mlxgen capabilities --model ~/ai/models/Qwen-Image-2.1-bf16 --base-model qwen-image-2.1
```

**参数面**(Provider 的 `isQwen21Edit` 分支已按此构造,**与 flux2/qwen-edit 写法完全不同**):

```bash
mlxgen generate --model <bf16 目录> --base-model qwen-image-2.1 \
  --image-paths ref1.png ref2.png \
  --prompt "..." --steps 40 --output-resolution 1024 --output out.png
```

- 参考图用 **`--image-paths p1 p2 ...`**(复数、`nargs='+'`,一次给多张);
  **不是** flux2/qwen-edit 的重复 `--image` + `--i2i-mode`
- 顺序即语义:第一张锚定几何,后续提供风格/材质线索
- **禁用 `--image-strength`**(该路由是 edit-reference,不是 latent i2i)
- **输出后缀必须 `.png/.webp/.tif/.tiff`**(RGBA 硬约束,其他后缀 CLI 直接报错)
- **最少 2 步**(`requires at least two steps for terminal sigma shifting`),官方推荐 40 步
- 最多 10 张参考图;`--scheduler` 只能 linear(不传即默认)
- 实测(M5 Max,256²、2 步)约 3 秒出图,输出确认 RGBA(35–48% 像素含透明)

App 侧:检查器把模型选为「Qwen-Image-2.1 (bf16 全量 · 参考编辑)」即可;`instruction` 模式的
**默认模型仍是 Qwen Image Edit**(存量行为不变),要用 2.1 编辑需显式换模型。单测见
`packages/providers/src/__tests__/mlxgen.test.ts` 的「Qwen-Image-2.1 参考编辑」组。

> \* 体积为骨架期估算;模型 id、下载命令与落盘目录以 `mlxgen download --help` 与官方仓库(mkdocs/mlx-gen)为准——本应用只把 id 透传给 CLI,不内置下载逻辑。
> 模型由 mlxgen 自管理缓存,应用不需要也不应该手动指定模型路径。

---

## 4. 应用内「设置管理模型」入口

- 设置页「引擎」分组:`mlxgen(图片主引擎)` 行右侧 **「管理模型」** 按钮(当前跳到「模型」分组——该分组是 **LLM 本地模型**(LM Studio / Ollama / pi-mlx)管理,用于 Agent 规划内核;**mlxgen 图像模型**的下载在设置页「模型下载」分组,也可 CLI `mlxgen download`)。
- 设置页「模型下载」分组:白名单 8 个模型(Z-Image-Turbo / Qwen-Image-2.1 / Qwen-Image-2.1-Turbo / Qwen-Image-2.1-Uncensored(手动构建)/ Qwen Image Edit / FLUX.2 Klein 9B / SeedVR2 3B / **Qwen3-VL 8B caption(看图反推)**)。**双通道下载**:Qwen 系(MS 有镜像、sha256 与 HF LFS oid 一致)默认走 **ModelScope 国内 CDN 直连**(`apps/desktop/src/main/ms-download.ts`,主进程按 HF 缓存布局落盘,断点续传 + 4 路并发 + 多轮自愈 + 停滞看门狗,不依赖 HF 可达性;`BIGBOTART_MS_DOWNLOAD=0` 可强制回退 HF);其余模型走 `spawn mlxgen download`(HF),Xet/CAS 报错自动 `HF_HUB_DISABLE_XET=1` 重试,**同一模型去重**(连点复用进行中任务,防多进程互等 hf_hub 锁),**停滞看门狗**(blobs 连续 5 分钟零字节增长判定挂起,杀掉切经典通道重试)。
- **「已下载」判定 = HF 缓存完整性校验**(`apps/desktop/src/main/mlxgen-models.ts` 的 `isCacheComplete`):① blobs 无「无主」`*.incomplete` 中断分块;② snapshot 有可解析的非空文件且无悬空链接;③ 至少一个权重文件(只有配置/分词器不算模型);④ 有 `*.safetensors.index.json` 时其引用的分片必须齐全。注意:Xet→经典通道重试成功后旧 `.incomplete` 分块不清理(同名 blob 已完成),属正常残渣,不会误判为未下载;下载中途掐断(空壳 snapshot / 中断分块 / 权重为零 / 分片缺失)会正确显示「未下载」,重下即可断点续传。
- 节点内选模型:image-gen / image-edit 检查器的「模型」输入框可直接填任意模型 id(与 §3 清单一致);提交时原样传给 `mlxgen`。

---

## 5. 引擎配置与真实推理开关

| 开关 | 位置 | 默认 | 说明 |
|---|---|---|---|
| `renderMode='real'` | 设置 → 引擎 →「真实推理」 | `demo` | demo 模式一律走 mock 占位(秒回、不真实推理) |
| `BIGBOTART_DRYRUN=0` | 环境变量(`.env` / shell) | `1`(dry-run) | `0` 时 mlxgen 真实 spawn 推理;未设时只构造命令不落盘 |
| `BIGBOTART_MLXGEN_OUTPUTS` | 环境变量 | `~/.bigbotart/outputs/images` | 图片产物目录 |

**dry-run 行为(重要)**:dry-run 下 `MlXGenProvider.submit` 只登记命令与输出路径,**不写产物文件**,队列仍返回 SUCCEEDED——节点缩略图会是破图。demo/mock 模式则写 1×1 占位 PNG。真实出图必须 `renderMode=real` + `BIGBOTART_DRYRUN=0`。

**槽位策略**:图片槽位与视频槽位互斥(同一时刻只跑一个引擎,64GB 内存策略,`RenderQueue` FIFO)。

---

## 6. 图片节点能力矩阵(实现状态)

| 节点 | 能力 | 当前实现 | 备注 |
|---|---|---|---|
| `image-gen` | Text→Image,多 seed 批量 | ✅ 命令构造完整(generate) | 默认 `z-image-turbo-8bit` |
| `image-edit` `instruction` | 指令编辑 | 🟠 命令薄映射 | 只拼 `--image-path + --prompt + --output`;真实 CLI 参数(如 mask/强度)待模型就绪后按 `mlxgen edit --help` 校准 |
| `image-edit` `img2img` | latent I2I | ✅ 真实 CLI 已校准(2026-09 实测) | `--i2i-mode latent` + `--image-strength`;**模型须为 Z-Image Turbo**——Qwen Image Edit 无 latent I2I 能力(mlxgen exit 2),Provider 提交前防呆拦截并提示换模型 |
| `image-edit` `inpaint` | 遮罩编辑 | 🟠 支持 `--mask-path` | 需 `maskAssetId` → mask 路径桥接 |
| `image-edit` `outpaint` | 扩图 | 🟠 命令薄映射 | `outpaintSides` 已定义未透传 |
| `image-upscale` | 超分修复 | ✅ 命令构造完整(upscale) | `--resolution 2x/4x` |
| `image-crop` | 按画幅裁剪(1:1 → 9:16) | ✅ 不走引擎 | ffmpeg 本地裁剪,秒级;见节点手册 §3.12 |

> 「🟠」= 骨架期薄映射:截至本文档,本机未安装 mlxgen,四种编辑模式的 CLI 差异无法在真机上验证。安装模型后可跑通闭环,再按真实 CLI 细化各模式参数(建议优先补 inpaint mask / outpaint 边距 / img2img 强度)。

### 6.1 图片 → 文本(看图反推,`mlxgen-caption`,2026-10 对接)

生成路线的**逆向**:一张图 → 一段文字(提示词反推 / 画面描述)。引擎侧是新增的
`mlxgen-caption`(模块 `mflux.models.qwen3_vl_caption.cli.caption`),用**本地 MLX 格式 Qwen3-VL**
跑 mlx-gen 自己的 decoder + vision tower,**不需要 LM Studio 或任何 server**。

```bash
# 直接跑引擎(本地目录或已下载的 repo id 都行;引擎**不会**在运行时联网下载)
mlxgen-caption \
  --model ~/.lmstudio/models/gavinmroy/Qwen3-VL-8B-NSFW-Caption-V4.5-affine-4bit \
  --image-path photo.jpg \
  --prompt-preset zh \
  --max-pixels 640000 \
  --output caption.txt
```

**App 侧怎么用**:Agent 工具 `vision.caption` 现在有两条通道,由 `apps/desktop/src/main/vision.ts`
统一编排、`apps/desktop/src/main/mlxgen-caption.ts` 负责本地通道执行:

| 通道 | 依赖 | 选择方式 |
|---|---|---|
| 端点(`endpoint`) | LM Studio / 任意 OpenAI 兼容多模态端点**要在跑** | 设置 → 工具模型 → 看图反推 → 本地 LM Studio / 云端 / OpenAI 兼容端点;env `BIGBOTART_VL_*` |
| 本地引擎(`mlxgen`) | 只要有 MLX 格式 Qwen3-VL checkpoint | 设置 → 工具模型 → 看图反推 → **本地 · mlxgen-caption**(免 LM Studio) |

选择顺序:**设置页显式绑定 > `BIGBOTART_CAPTION_BACKEND=endpoint|mlxgen` > `auto`**(本机命令 +
checkpoint 都齐 → 本地,否则端点链 —— 存量行为不变)。**回退只在 auto 下发生**,且工具返回里会明写
「主通道 X 失败已回退 Y」(`note` 字段),显式指定通道时失败就报失败。

**「看图反推」那一格填什么**:三种写法都认 —— ①checkpoint **目录绝对路径**;②**`owner/name` 仓库 id**(引擎去本地缓存找);
③**裸模型名**(如 LM Studio 里的 `qwen3-vl-8b-nsfw-caption-v4.5-affine`)→ 按归一化名字自动匹配到本机已发现的 checkpoint。
**留空 = 自动发现**。填错时不再笼统报「通道不可用」,而是给出具体原因(目录不存在 / 目录不是合格 MLX dense Qwen3-VL /
既不是目录也不是仓库 id 且匹配不到,并列出本机已发现的候选)。

相关环境变量:

| 变量 | 默认 | 说明 |
|---|---|---|
| `BIGBOTART_CAPTION_BACKEND` | `auto` | `auto` / `endpoint` / `mlxgen` |
| `BIGBOTART_CAPTION_MODEL` | 自动发现 | checkpoint 目录或 HF repo id |
| `BIGBOTART_CAPTION_BIN` | — | 可执行文件路径(配 `BIGBOTART_CAPTION_MODULE=1` 时视为解释器,走 `-m` 模块入口) |
| `BIGBOTART_CAPTION_MODEL_ROOTS` | `~/.lmstudio/models:~/.ai/models` | 额外扫描根(`:` 分隔);自动发现还会扫 HF 缓存 `snapshots/` |
| `BIGBOTART_CAPTION_MAX_PIXELS` | `640000` | 图片 token 预算(≈800×800),prefill 成本随其平方增长,是主要速度旋钮 |
| `BIGBOTART_CAPTION_MAX_TOKENS` | `1024` | 生成长度(caption 模型卡建议 2048) |
| `BIGBOTART_CAPTION_TIMEOUT_MS` | `300000` | 单次超时 |
| `BIGBOTART_CAPTION_FALLBACK` | 开 | 设 `0` 关闭跨通道回退 |

⚠️ **checkpoint 必须带 vision tower 的 MLX 格式 dense Qwen3-VL**(2B/4B/8B/32B,bf16 或已量化):
torch/HF 原始布局与 MoE `qwen3_vl_moe` 会被引擎**明确拒绝**(报第一个不匹配的 key),不会静默给坏结果。
**模型清单里已有这一行**:设置页「模型下载」→ **Qwen3-VL 8B caption 微调**
(`gavinmroy/Qwen3-VL-8B-NSFW-Caption-V4.5-affine-4bit`,~5.4GB)。
⚠️ **该仓库没有 ModelScope 镜像**(2026-10 实测 `gavinmroy/` `Disty0/` `thesby/` 三个上游在 MS 全部 record not found),
所以应用内下载只能走 `spawn mlxgen download`(HF 通道);**HF 直连不通的环境请在 LM Studio 里下载**
(LM Studio 有自己的通道),下完 App 的本地探测会**直接认成「已就绪」**——它探的是
`~/.lmstudio/models/gavinmroy/...` 这个扁平 MLX-VL 目录(`KNOWN_MODELS` 的 `lmstudioDir` + `isMlxVlCheckpoint`),
不需要用户再配任何路径。放在 `~/ai/models` 或 HF 缓存的其它 MLX Qwen3-VL 也会被自动发现(N 个里 caption 微调排最前)。
原 `qwen2.5-vl` 那行是 **torch 布局**,两个入口(generate / caption)都加载不了,故已替换(2026-10)。

**实测成本**(本机 M5 Pro / 64GB,`Qwen3-VL-8B-NSFW-Caption-V4.5-affine-4bit` 5.4GB):
640×480 一张 15.7 秒、857 字符;引擎 doc 记 1920×1080 冷启动 4.2 秒、峰值 6.3GB。
opt-in 真跑用例:`BIGBOTART_CAPTION_E2E=1 pnpm vitest run apps/desktop/src/main/__tests__/mlxgen-caption-e2e.test.ts`。

---

## 7. 排障表

| 现象 | 原因 | 处理 |
|---|---|---|
| 设置页探测 `installed=false` | mlxgen 不在 PATH | `uv tool install --upgrade mlx-gen`;重开应用 |
| 探测 `ready=false` 但 CLI 在 | `--help` 执行失败(版本不兼容) | `mlxgen --help` 手动看报错;`uv tool install --upgrade mlx-gen` |
| 提交成功但产物不存在(dry-run) | 未关 dry-run 或 demo 模式 | 设置「真实推理」+ `BIGBOTART_DRYRUN=0` |
| 真实推理 `exit != 0` | 模型未下载 / 显存不足 | `mlxgen download --model <id>`;关视频槽位任务后重试 |
| `exit 1: mlxgen download --model Qwen/Qwen-Image-Edit`(DownloadRequired) | 模型字段用了短别名 `qwen-image-edit`,被解析成全量 57.7GB 仓库(未下载) | Provider 已把短别名归一化为 `mlx-community/Qwen-Image-Edit-8bit`;新节点默认即为 8bit 仓库。⚠️ 不要在 64GB 机器下载全量版 |
| `exit 2: --image-strength is required for latent image-to-image mode` | img2img(latent)模式必填强度参数,未设置时旧版 Provider 漏传 | 已修复:未设置/越界自动回退 0.5;检查器滑块可调 |
| `exit 2: Qwen Image Edit does not support latent image-to-image` | img2img 模式配了 Qwen Edit 模型(无 latent I2I) | 检查器把模型改为 `AbstractFramework/z-image-turbo-8bit`,或改用指令编辑模式(Provider 已前置拦截此组合) |
| 图片编辑命令行为与模式不符 | 骨架期薄映射(§6) | 暂以手动指定模型兜底;后续按真实 CLI 校准 |
| 图片槽位一直排队 | 与视频任务互斥 | 等视频任务完成(FIFO) |
| 模型下载行「Qwen3-VL 8B caption」点下载报 HF 错误 | 该仓库无 ModelScope 镜像,只能走 HF;本机 HF 直连不可达 | 在 LM Studio 里下载(下完 App 自动认「已就绪」),或设 `HF_ENDPOINT=<镜像>` 后用 `mlxgen download` 手动拉 |
| `vision.caption` 报 `fetch failed` 且提示「未单独配置看图模型」 | 走的是**端点通道**而端点不可达(最常见:LM Studio 没在跑);⚠️ 若你刚在设置页配好「本地 mlxgen-caption」仍报这个,**说明应用主进程还是改动前启动的** | 重启应用(主进程代码只在启动时加载);或直接在设置页选「本地 · mlxgen-caption」(免 LM Studio) |
| `vision.caption` 报「本地看图通道不可用」 | `mlxgen-caption` 命令缺失(**旧 venv 里没有这个 console script**,引擎 2026-10 才加)或本机没有 MLX 格式 Qwen3-VL | 在 mlx-gen 仓库 `uv tool install --editable .` 重装;或 `BIGBOTART_CAPTION_BIN=<可执行路径>`。App 已内置 shebang 回退(用 `mlxgen` 的解释器跑模块),若仍报此错说明 `mlxgen` 也不在 PATH |
| `vision.caption` 报「未产出文本」 | checkpoint 不是 MLX 格式 dense Qwen3-VL(torch 布局 / MoE),或输出被截断 | 换 `mlx-community` / `mlx-vlm` 转换过的仓库;报错里的 `do not map` 段会点名第一个不匹配的 key;截断则调大 `BIGBOTART_CAPTION_MAX_TOKENS` |
| `vision.caption` 变慢 / 内存高 | 图片 token 预算过大(prefill 随其平方增长) | 调小 `BIGBOTART_CAPTION_MAX_PIXELS`(默认 640000 已接近 800×800) |

---

## 8. 代码索引

- Provider:`packages/providers/src/mlxgen.ts`(`check` / `capabilities` / `submit` / `status`)
- 注册: `packages/providers/src/registry.ts`(dry-run 默认;`BIGBOTART_DRYRUN=0` 反转)
- 输出目录默认:`MLXGEN_DEFAULTS.outputDir`(`BIGBOTART_MLXGEN_OUTPUTS ?? ~/.bigbotart/outputs/images`)
- 节点渲染:image-gen / image-edit / image-upscale 检查器在 `apps/desktop/src/renderer/src/pages/canvas/inspector/InspectorBody.tsx`;提交链路在 `CanvasPage.tsx` `runNode`
- 安装提示:`apps/desktop/src/main/index.ts` `install-runtime`(mlxgen → `uv tool install --upgrade mlx-gen`)
- 看图反推两条通道(§6.1):`apps/desktop/src/main/vision.ts`(通道编排 / 白名单 / 指令 / 回退)+ `apps/desktop/src/main/mlxgen-caption.ts`(命令解析含 shebang 回退 / checkpoint 发现 / spawn / 错误面);设置入口 `apps/desktop/src/renderer/src/pages/ToolModelsSection.tsx`,绑定字段 `ToolModelBinding.captionLocal`(`packages/shared/src/domain.ts`)