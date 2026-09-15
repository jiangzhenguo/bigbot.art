# 调研报告:MiniMax Design 功能拆解 + 本地模型接入方案

> 调研日期:2026-09(基于公开报道:爱范儿、Cocoloop、MiniMax 官方发布)
> 目的:为"无限画布的视频/图片生成 Agent"产品(暂名 **BigBotArt**)提供功能参考与本地模型接入依据。
> 关联项目:H3Mise(`/Users/jiangzhenguo/ai/h3cmise`,本地优先 AI 视频项目管理台)。

---

## 第一部分:MiniMax Design 功能拆解

### 1.1 产品定位

MiniMax Design(2026-08-20 发布)是围绕自研视频模型 **H3** 搭建的多模态创作平台。它的核心卖点不是"一句话生成视频",而是 **"可干预的自动"**:用自然语言拆 Brief、排分镜、生成关键帧、出视频、配乐、加字幕、剪辑,一路走到成片;同时所有中间产物都落在**画布**上,用户可以随时干预任意节点。

> 类比:像 AI 编程工具的 Codex 之于底层模型——底层模型负责单点产出,上面套一层能规划、能自查、能被人打断的编排层。

### 1.2 五大模块

| 模块 | 功能 | 关键细节 |
|---|---|---|
| **工作流画布(核心)** | 无限画布,素材/工作流都在画布上呈现 | 画布下方"+"可添加节点:文本、表格、图片、视频、音频,以及 3D 导演台、视频剪辑、ComfyUI 工作流。每个节点可点开独立编辑(文本节点→文本助理 Agent;图片/视频节点→生成对话框,可调提示词/模型/尺寸) |
| **3D 导演台** | 在 3D 场景摆角色素体、调度机位与姿态 | 先产出"运镜参考小样",再参考该视频帮用户精准生成最终视频。价值:把模糊自然语言需求转成明确的空间和运动参考,降低抽卡/试错成本 |
| **资产中心** | 素材自动落本地、一键存资产中心 | 品牌资产(logo、VI、产品图)→成为画布节点→复用到新生成流程(如 logo→动态片头) |
| **Skills 库** | 现成风格模板(纸拼贴、水墨、动漫科普等)+ 对话生成自定义 Skill | 一套模板 = 一条视频生产线:第一支短片定下纸张质感/角色样式/转场/叙事节奏后,同一 Skill 可套用到新主题(把纸拼贴模板复用到日全食科普,只改主题和旁白)。成片后还可派生无字幕版/儿童版/庄重版等分支 |
| **一组分工的 Agent** | 拆 Brief、生成 Markdown 提示词文档、分镜板、生图、H3 视频、配乐、字幕、剪辑 | Agent 之间互相校验(角色节点发现手部抖动异常→自动触发修复子任务);关键节点回到"核心方向"做多轮质量校验(Harness 概念) |

### 1.3 典型创作流程(实测案例)

1. 用户输入需求 + 上传素材(如"帮我在导演台搭一场戏:男女主草原上走,遇河,女主跃过……")。
2. 系统自动打开画布,生成 **Markdown Brief / 提示词文档节点** + 用生图模型生成**静态帧**。
3. 生图 + H3 视频:结合文本文档与静帧,调用 H3 生成视频。
4. 自动化+人工干预:用户在画布上调整参考图、让 Agent 改提示词、添加导演台。
5. 长视频编排:H3 单次最多 15 秒 → Agent 拆成多个镜头 → 统一风格 → 组织成连贯时间线(**3 分钟片 = 12+ 镜首尾相接**,人物长相/服装/光线/镜头语言要连贯)。
6. 交付:配乐、字幕、剪辑在画布内完成;导出多平台版本。

### 1.4 目标场景(官方)

- 短剧全流程、电商批量出图出视频
- 品牌 TVC、宣传物料、知识视频、PV/MV

共同点:**量大、周期紧、单条预算不高**——正是被工具链效率碾过去的一档。

### 1.5 ComfyUI 工作流导入

ComfyUI 的 API Format 工作流可直接导入画布成为节点,已调好的参数不浪费、不用推翻重学。这是吸引存量创作者的关键通道。

### 1.6 对我们的启示(与 H3Mise 的关系)

- MiniMax Design 的核心资产是:**画布(把所有中间产物留在台面上)+ Agent(接管复杂度)+ 资产/技能复用**。
- H3Mise 已有**叙事→Shot→Take→连续性→时间线**的项目层,但没有画布与 Agent 编排层。
- **两者天然互补**:H3Mise 提供项目/连续性骨架,画布+Agent 提供创作编排层。这正是本 PRD 的方向。

---

## 第二部分:本地模型接入方案

### 2.1 h3.c(MiniMax-H3 视频生成)——已完成本地部署

| 项 | 值 |
|---|---|
| 二进制 | `/Users/jiangzhenguo/ai/h3/h3.c/h3`(已编译) |
| 模型 | `/Users/jiangzhenguo/ai/h3/MiniMax-H3/`(144GB BF16,完整) |
| 机器 | Apple Silicon M5 Pro,64GB 统一内存,Metal 4 |

#### 2.1.1 调用方式(CLI,非交互)

```bash
./h3 -d MODEL_DIR --width 768 --height 768 --frames 124 --steps 30 --layers 50 --reuse 1 \
  -p "Scene: ... Action: ... Camera: ... Look: ... Audio: ..." -o outputs/out.mp4
```

- 必填:`-d`(模型目录)、`-p`(提示词);给 `-o` 则非交互生成。
- 长任务(768²/30步/124帧 ≈ 8-10 分钟)必须后台跑。

#### 2.1.2 支持的条件控制(对接 PRD 的"模式")

| 参数 | 作用 | PRD 模式映射 |
|---|---|---|
| `--first-frame` / `--last-frame` | 首/尾帧条件图(FL2VA) | 首帧控制 / 首尾帧控制 |
| `--ref-image`(可重复) | 有序图参考(Ref2VA) | 参考图驱动(锁角色/场景) |
| `--ref-video` / `--ref-audio` / `--ref-silent-video` | 视频/音频参考 | 风格参考 / 动作参考 |

#### 2.1.3 质量/速度套餐(PRD 的"档位"预设)

| 档位 | 命令片段 | 用途 |
|---|---|---|
| 预览构图 | `256² / 22帧 / 4步 / reuse 1` | 秒级看构图 |
| 快草稿 | `512² / 22帧 / 20步 / layers 45 / reuse 2` | 快速多版本 |
| 默认质量 | `768² / 124帧 / 30步 / layers 50 / reuse 1` | 标准出片 |
| 参考质量 | `+ steps 50` | gold 档,慢(10-12 分钟) |

#### 2.1.4 关键坑(Product 需内建约束)

- 宽高须 32 的倍数,乘积 ≤ 768×1344;帧数自动对齐 `5+17n`。
- 人物场景 `--reuse 1 --layers 50`,否则面部时间性混叠;身份需提示词显式锁定。
- `--layers 40 + --reuse 3 + --token-reduction` 一起开会产生鬼影/振铃——**档位模板要防呆**。
- 首次 Metal shader 编译约 30 分钟(之后暖缓存 5-10 分钟),需要 UI 提示"首次预热"。

#### 2.1.5 接入方案:Provider 封装 + 后台托管(已与用户确认)

```
RenderRequestInput(业务语义:模式/提示词/时长/画幅/参考)
        ↓ Provider 适配(参数映射 → h3 CLI 参数)
后台子进程 spawn h3 → 轮询进程状态 + 输出目录 → SSE 推送进度
        ↓ 成功
MP4 归档为 Take(沿用 H3Mise 媒体/Take 链路)→ 前端画布节点更新
```

- 并发控制:同一时刻仅一个 h3 任务(64GB 内存下 144GB 模型需 SSD streaming 或顺序执行)。
- 失败/取消:取消=kill 子进程;失败=保留 stderr 诊断,不重复付费(本地无付费,但保留同样语义)。

### 2.2 Z-Image(造相,阿里通义)——文生图/图像编辑的主模型

**Z-Image 是 6B 参数、S3-DiT(单流扩散 Transformer)架构的模型族,四个变体:**

| 变体 | 步骤 | 胜任任务 | 状态 |
|---|---|---|---|
| **Z-Image-Turbo** | 8 NFE(蒸馏) | 文生图;双语文本渲染;16GB 显存可跑 | ✅ 已发布(MLX 社区有量化版) |
| **Z-Image** | 50 | 高质量文生图、风格多样、可微调 | ✅ 已发布 |
| **Z-Image-Omni-Base** | 50 | 生成 + 编辑的"原生基础" | ⏳ To be released |
| **Z-Image-Edit** | 50 | **图像编辑专用**(指令式图生图) | ⏳ To be released(官方尚未放出 checkpoint) |

> 关键结论:**Z-Image 家族本身"生成与编辑"双能力是官方路线**,但 Edit 权重尚未发布;当前可用的编辑能力须借助社区 MLX 移植版或以下运行时。

#### 2.2.1 本地部署(MLX)选择

| 方式 | 说明 | 适用 |
|---|---|---|
| **mlx-gen**(推荐) | 见 2.3 | 生产主方案 |
| mlx-community / Z-Image MLX 权重 + 自写生成脚本 | 社区权重(z-image-turbo 8bit 等) | 补充/实验 |
| zimage-ncnn-vulkan / zimage.swift | 其他后端的原生实现 | 不推荐(非 MLX 生态) |

### 2.3 mlx-gen ——本地图片生成/编辑的最优运行时(本轮调研关键发现)

**lpalbou/mlx-gen**(PyPI `mlx-gen` / CLI `mlxgen`,Apple Silicon + MLX)是一个**本地图像与视频生成运行时**,起点是 mflux 的 fork,能力远超普通文生图:

| 能力 | 支持模型/路径 | 与 PRD 的对应 |
|---|---|---|
| 文生图(T2I) | Qwen Image、FLUX.2 Klein、Z-Image、ERNIE Image Turbo、Bonsai Image、FIBO | 图片生成节点 |
| 图生图(I2I) | latent img2img、指令/参考编辑、**多参考编辑** | 图片编辑节点 |
| **遮罩编辑/Inpaint** | `--mask-path`(Qwen Edit 模型、Z-Image Turbo、FLUX.2 Klein) | 局部重绘节点 |
| **Outpaint/Reframe** | FLUX.2 Klein 单侧/双侧/四边扩展、两遍拆分、源锁定outpaint | 扩图节点 |
| 修复/超分 | SeedVR2(3B/7B,图+视频)、SwiftVR(单步,~40x 速度) | 增强/修复节点 |
| 视频(补充) | Wan2.2 T2V/I2V/V2V、Bernini-R、MiniMax-H3(带同步音频) | 视频备选引擎(主引擎仍是 h3.c) |
| 其他 | 模型显式下载/准备、能力 JSON 检查、LoRA 路由、进度回调、逐步预览 | 工程集成 |

**安装(`mlxgen`)`:**
```bash
uv tool install --upgrade mlx-gen   # 或 pip install -U mlx-gen
mlxgen download --model AbstractFramework/z-image-turbo-8bit
mlxgen generate --model AbstractFramework/z-image-turbo-8bit --prompt "..." \
  --width 768 --height 432 --steps 24 --guidance 1.0 --seed 6107 --output out.png
```

**选型建议(对应 PRD"图片引擎"):**
- 文生图:Z-Image-Turbo(8bit ~3GB,亚秒~秒级质量好,中文/英文文本渲染强)。
- 图生图/编辑/遮罩/mlx 编辑:Qwen Image Edit(指令编辑+mask)或 FLUX.2 Klein 9B(多参考编辑、outpaint/reframe)。
- 修复超分:SeedVR2 / SwiftVR。
- 全部走 **`mlxgen` 一个 CLI**,Provider 只需封装 `download/generate/upscale/capabilities` 四个子命令 → 归一化成本低。

**资源约束(PRD 需内建):**
- 64GB 统一内存:h3.c 跑视频与 mlxgen 跑图片**不建议并发**,任务队列按引擎分槽位(视频槽位独占)。
- q8 模型占用:FLUX.2 Klein 9B Q8 ≈ 13GB;Z-Image-Turbo 8bit ≈ 3GB;SeedVR2 3B Q8 ≈ 3GB。

### 2.4 Pi Agent Harness ——LLM/Agent 内核(用户确认选用,支持网络端 + 本地双接口)

**earendil-works/pi**(Pi Agent Harness)是 agent 运行时 + 统一多 Provider LLM API 的项目,核心与 BigBotArt 相关的包:

| 包 | 作用 | 在 BigBotArt 的用途 |
|---|---|---|
| `@earendil-works/pi-ai` | 统一多 Provider LLM API:OpenAI / Anthropic / Google / Azure OpenAI / OpenAI Codex 等;自动鉴权、token/成本跟踪、上下文序列化、跨 provider 切换 | **网络端接口**:Agent 的 Brief 生成、提示词扩写、规划推理 |
| `@earendil-works/pi-agent-core` | Agent 运行时:工具调用(function calling)、状态管理、流式工具调用与参数校验 | 编排层内核,承载规划/执行/校验 Agent |
| `@sinamtz/pi-mlx-provider`(社区) | Apple Silicon 上用 MLX 跑本地模型(MLX-VLM server,OpenAI 兼容 API);支持视觉模型;数据不出机、免费 | **本地端接口**:MLX 本地模型(如 gemma-4 系 4bit),无网络/无 API 费用 |

**双接口适配结论(已确认):**
- **网络端(云端全支持)**:pi-ai 内置多 provider(OpenAI / Anthropic / Google / Azure / Codex),仅暴露支持工具调用的模型(Agentic 必需);并支持 **OpenAI 兼容设置**接入任意云端点——DeepSeek / 智谱 GLM / 月之暗面 Kimi / Qwen / MiniMax 等国内云模型均可用。
- **本地端(三选一或并存)**:
  - **LM Studio(用户主本地运行时,已确认)**:本机已部署 **Ornith-1.5 系列**——`Ornith-1.5-35B-A3B`(MLX 4bit)与 `Ornith-1.5-9B`(MLX 8bit),LM Studio 服务端口 `1234`,OpenAI 兼容 API(`/v1`),已实测可列出模型。
  - **pi-mlx-provider**:Apple Silicon 直接用 MLX 跑模型(免 LM Studio),默认 `mlx-community/gemma-4-e2b-it-4bit`,可换 Qwen 等;首次经 `/mlx_init` 初始化。
  - **任意 OpenAI 兼容本地端点**:Ollama(本机已装,`~/.ollama`)/ vLLM / LM Studio。
- **本地可部署模型清单(Agent 内核候选)**:**Ornith-1.5**(9B / 35B-A3B / 更大尺寸 OptiQ-4bit,默认首选)、Qwen2.5/3、GLM-4、DeepSeek(蒸馏)、Llama 3.x、Mistral/Mixtral、Phi、Gemma 3、MiniCPM;视觉 VLM 用于识图(Qwen2.5-VL、Gemma-3-Vision 等)。图片/视频模型清单见 §2.2/§2.3。
- **切换规则**:设置页选择默认 LLM 来源;未配置本地模型时回退云端或纯模板+手工(AI-optional)。

### 2.5 ComfyUI(已有)

- 本机:`/Users/jiangzhenguo/ComfyUI-Installs/Comfy/ComfyUI` + `ComfyUI-Shared`,已装 Krea2 系列 diffusion 模型 + LTX-2.3 checkpoint。
- 已有 krea2 四视图/图生图/inpaint/outpaint 工作流(在 `/Users/jiangzhenguo/ai/comfy-workflows/`)。
- H3Mise 已实现 **ComfyUI Local Provider**(导入 workflow_api.json、输入映射、`/prompt` 提交、轮询)。
- 结论:作为**图片/视频的补充 Provider**;由于 BigBotArt 是独立新项目,**按其接入协议自研实现**,krea2 工作流文件可直接导入。

### 2.6 接入架构总览

```text
BigBotArt(跨端桌面 App:Electron/Tauri + React + React Flow 画布)
   │
   ├── Agent/LLM 内核:Pi Agent Harness(§2.4,子进程隔离)
   │     ├── 云端:pi-ai → OpenAI / Anthropic / Google / Azure / Codex / OpenAI 兼容(DeepSeek/GLM/Kimi/Qwen/MiniMax)
   │     └── 本地:LM Studio(Ornith-1.5,端口1234)或 pi-mlx-provider(MLX)或 OpenAI 兼容端点(Ollama/vLLM)
   │     └── 本地端:pi-mlx-provider(MLX)或 OpenAI 兼容端点(Ollama/vLLM)
   │
   ├── 视频引擎(Provider 注册表)
   │     ├── h3c-provider    ← h3.c CLI 后台托管(主,带声直出)
   │     ├── comfyui-provider ← 本地 ComfyUI(补充)
   │     └── mock-provider
   │
   └── 图片引擎(Provider 注册表)
         ├── mlxgen-provider ← mlxgen CLI(主:Z-Image Turbo 生图 / Qwen-Edit / FLUX.2 Klein 编辑)
         ├── comfyui-provider ← krea2 工作流(编辑/重绘/扩图补充)
         └── mock-provider
```

统一接口:`capabilities()`(能力声明:支持的模式、模型、输入类型、成本/资源提示)与
`submit/status/result/cancel`(提交/状态/结果/取消),接口形状参考 H3Mise 的 `VideoProvider` 设计(独立实现)。

---

## 第三部分:信息来源

- 爱范儿《MiniMax Design 来了,视频模型也有了自己的 Codex》:https://www.ifanr.com/1675657
- Cocoloop《MiniMax 发布 Design,把 15 秒镜头串成整片》:https://news.cocoloop.cn/2026/08/minimax-design-video-agent/
- 智东西《创作"猫片"、复刻《黑神话:钟馗》,最适合 MiniMax H3 的 Harness 来了》:https://m.zhidx.com/p/587032.html
- MiniMax H3 开源项目(antirez/h3.c):https://github.com/antirez/h3.c
- Z-Image 官方仓库(Tongyi-MAI):https://github.com/Tongyi-MAI/Z-Image ; 技术报告 arXiv:2511.22699
- mlx-gen(lpalbou):https://github.com/lpalbou/mlx-gen ; PyPI: https://pypi.org/project/mlx-gen/
- Z-Image MLX 社区:https://huggingface.co/collections/mlx-community/z-image-mlx
- Pi Agent Harness(earendil-works/pi):https://github.com/earendil-works/pi
- pi-mlx-provider(社区 MLX 本地推理):https://www.npmjs.com/package/@sinamtz/pi-mlx-provider
- Ornith-1.5 模型家族(DeepReinforce 开源,MLX 量化版见 mlx-community):https://gigazine.net/news/20260820-ornith-1-5/
- 360 快资讯深度拆解(部分内容标注为 AI 生成,仅采信与以上来源一致的结构信息)