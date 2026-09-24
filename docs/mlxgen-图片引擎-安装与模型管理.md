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
| 文生图(备选) | `qwen-image` | 中等 | Qwen Image |
| 指令编辑 / mask | `mlx-community/Qwen-Image-Edit-8bit` | ~37.5GB | image-edit `instruction` / `inpaint`;8bit 量化版(官方原版 57.7GB,64GB 内存跑不动)。生成时 Provider 自动追加 `--base-model Qwen/Qwen-Image-Edit`(不给会被误路由成文生图 handler) |
| 多参考编辑 / outpaint | `AbstractFramework/flux.2-klein-9b-8bit` | ~18GB | image-edit 多参考 / 扩图 |
| 图片增强(超分) | `AbstractFramework/seedvr2-3b-8bit` | ~4.7GB | image-upscale |

*体积 = HF 官方文件清单实测汇总(2026-09;设置页/检查器展示同口径)

```bash
# 全部装齐(建议先只装 Z-Image-Turbo 跑通闭环;Qwen 系建议用设置页下载,走 ModelScope 直连)
mlxgen download --model AbstractFramework/z-image-turbo-8bit
mlxgen download --model mlx-community/Qwen-Image-Edit-8bit --base-model Qwen/Qwen-Image-Edit
# ...
```

> \* 体积为骨架期估算;模型 id、下载命令与落盘目录以 `mlxgen download --help` 与官方仓库(mkdocs/mlx-gen)为准——本应用只把 id 透传给 CLI,不内置下载逻辑。
> 模型由 mlxgen 自管理缓存,应用不需要也不应该手动指定模型路径。

---

## 4. 应用内「设置管理模型」入口

- 设置页「引擎」分组:`mlxgen(图片主引擎)` 行右侧 **「管理模型」** 按钮(当前跳到「模型」分组——该分组是 **LLM 本地模型**(LM Studio / Ollama / pi-mlx)管理,用于 Agent 规划内核;**mlxgen 图像模型**的下载在设置页「模型下载」分组,也可 CLI `mlxgen download`)。
- 设置页「模型下载」分组:白名单 4 个模型(Z-Image-Turbo / Qwen Image Edit / SeedVR2 3B / Qwen2.5-VL)。**双通道下载**:Qwen 系(MS 有镜像、sha256 与 HF LFS oid 一致)默认走 **ModelScope 国内 CDN 直连**(`apps/desktop/src/main/ms-download.ts`,主进程按 HF 缓存布局落盘,断点续传 + 4 路并发 + 多轮自愈 + 停滞看门狗,不依赖 HF 可达性;`BIGBOTART_MS_DOWNLOAD=0` 可强制回退 HF);其余模型走 `spawn mlxgen download`(HF),Xet/CAS 报错自动 `HF_HUB_DISABLE_XET=1` 重试,**同一模型去重**(连点复用进行中任务,防多进程互等 hf_hub 锁),**停滞看门狗**(blobs 连续 5 分钟零字节增长判定挂起,杀掉切经典通道重试)。
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

---

## 8. 代码索引

- Provider:`packages/providers/src/mlxgen.ts`(`check` / `capabilities` / `submit` / `status`)
- 注册: `packages/providers/src/registry.ts`(dry-run 默认;`BIGBOTART_DRYRUN=0` 反转)
- 输出目录默认:`MLXGEN_DEFAULTS.outputDir`(`BIGBOTART_MLXGEN_OUTPUTS ?? ~/.bigbotart/outputs/images`)
- 节点渲染:image-gen / image-edit / image-upscale 检查器在 `apps/desktop/src/renderer/src/pages/canvas/inspector/InspectorBody.tsx`;提交链路在 `CanvasPage.tsx` `runNode`
- 安装提示:`apps/desktop/src/main/index.ts` `install-runtime`(mlxgen → `uv tool install --upgrade mlx-gen`)