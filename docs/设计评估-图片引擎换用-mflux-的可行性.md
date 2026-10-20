# 设计评估:把图片生成库换成 mflux 有没有可能?

> 评估日期:2026-09 · 性质:**只读调研 + 设计,未改任何代码**
> 前置文档:`docs/图片生成与编辑能力现状盘点.md`(兼容性验证 + 真实冒烟)、`docs/mlxgen-图片引擎-安装与模型管理.md`

---

## 0. 结论(先说答案)

**"换成 mflux"这个动作本身在技术上可行,但它大概率是个伪命题 —— 因为 mflux 不是 mlxgen 的竞品,而是 mlxgen 的底层实现。**

本机实测证据(2026-09 验证):

```
$ uv tool list
mlx-gen v0.37.0
- mflux-completions
- mflux-generate
- mflux-generate-z-image-turbo
- mflux-generate-flux2
- mflux-generate-qwen-edit
- mflux-upscale-seedvr2
- … (40+ 个 mflux-* 命令)
- mlxgen
```

```python
# ~/.local/share/uv/tools/mlx-gen/lib/python3.11/site-packages/mflux/__init__.py
from mflux.python_runtime import (...)
```

即:`mflux` 是这个 pip 包里的 Python 包名,`mlxgen` 是它对外暴露的**统一 CLI 门面**,`mflux-*` 是**遗留兼容命令**。mflux 自己的 help 文案就把这事说透了:

```
$ mflux-generate-flux2 --help
"Legacy compatibility command for FLUX.2 Klein image generation.
 Prefer `mlxgen generate --model <model> ...` for new integrations."

$ mflux-generate-flux2-edit --help
"Prefer `mlxgen generate --model <model> --image <path> ...` for new integrations."
```

**所以 `uv tool install mflux` 装的就是 mlx-gen 这个包。** 项目现在已经在用 mflux 了 —— 只是通过它推荐的新门面 `mlxgen` 调用。

结论:换门面(从 `mlxgen generate` 改调 `mflux-generate-*`)**技术上可行、且是负收益**(详见 §4);真正值得考虑的不是"换成 mflux",而是**是否要利用 mflux 门面独有的、统一门面尚未覆盖的能力**(详见 §5)。

---

## 1. 现状:当前图片引擎接入面(基线)

| 层 | 位置 | 说明 |
|---|---|---|
| Provider 接口 | `packages/shared/src/provider.ts` | `ProviderId = 'h3c' \| 'mlxgen' \| 'comfyui' \| 'mock'` |
| 图片 Provider | `packages/providers/src/mlxgen.ts`(301 行) | 单例 `MlXGenProvider`,内部按 `kind` 分派命令 |
| 注册表 | `packages/providers/src/registry.ts` | **唯一后端选择点**(红线 R3);`createRegistry({ extra })` |
| 模型管理 | `apps/desktop/src/main/mlxgen-models.ts` | 清单 / 缓存探测 / 真实下载(spawn `mlxgen download`) |
| 安装 | `apps/desktop/src/main/runtime-install.ts` | spawn `uv tool install --upgrade mlx-gen-jzg` |
| IPC 契约 | `packages/shared/src/index.ts` | `mlxgenModels/Download/DownloadStatus/…`(5 个方法) |
| 领域类型 | `packages/shared/src/domain.ts:252,269` | `ImageGenParams.engine` / `ImageEditParams.engine` **字面量写死 `'mlxgen'`** |

**接入面本身是干净的、窄的** —— 全部收敛在一个 Provider 类 + 一个注册表工厂里,这决定了"换实现"的改动量可控(见 §3)。

---

## 2. 两个门面的命令面对照(本机实测)

### 2.1 统一门面(现用)

```bash
mlxgen generate  --model M --prompt P --width W --height H --steps S --guidance G \
                 --seed 42 43 --image-path in.png --mask-path mask.png \
                 --i2i-mode latent|multi-reference --outpaint-padding t,r,b,l \
                 --json-events --output o.png
mlxgen upscale   --model seedvr2-3b --image-path in.png --resolution 2x --output o.png
mlxgen capabilities --model <id>        # 机器可读的能力矩阵(JSON)
mlxgen download  --model <id>
mlxgen prepare   --model <id> --path ./m --quantize 8
```

路由层自动按 `--image-path` / `--mask-path` 决定 text / edit-reference / masked-edit / inpaint / outpaint handler。**这正是当前 Provider 依赖的语义。**

### 2.2 mflux 遗留门面(候选替换目标)

mflux 是**一模型一命令**,没有统一路由:

| 场景 | mflux 命令 |
|---|---|
| 文生图(Z-Image Turbo) | `mflux-generate-z-image-turbo` |
| 文生图(FLUX.2 Klein) | `mflux-generate-flux2 --model flux2-klein-9b` |
| 编辑(FLUX.2) | `mflux-generate-flux2-edit --image-paths A B --mask-path M --outpaint-padding P` |
| 编辑(Qwen) | `mflux-generate-qwen-edit --image-paths ... --mask-path ...` |
| 超分 | `mflux-upscale-seedvr2 --image-path X --resolution 2x` |
| 兼容旧模型 | `mflux-generate` / `mflux-generate-kontext` / `mflux-generate-fill` / `mflux-generate-controlnet` … |

### 2.3 关键差异表

| 维度 | `mlxgen` 统一门面 | `mflux-*` 遗留门面 |
|---|---|---|
| 命令数量 | 1 个入口,6 个子命令 | 40+ 个独立命令 |
| 模型→命令映射 | **由路由层自动完成** | **必须由调用方手工维护** |
| 参数一致性 | 统一 | 跨命令有差异(如 `--image-path` vs `--image-paths`、`-q/--quantize` 支持范围不同) |
| 多参考图 | `--image` 重复 | `--image-paths` 空格分隔 |
| 机器可读事件 | `--json-events`(两门面都有) | 同 |
| 能力自省 | ✅ `mlxgen capabilities --model X`(JSON) | ❌ 无 |
| 模型下载 | ✅ `mlxgen download` | ❌ 无(靠首跑自动下载,不可控) |
| 模型预量化/固化 | ✅ `mlxgen prepare --quantize` | ✅ `mflux-save` |
| LoRA 库/多 LoRA/LoKr | ⚠️ 需核(能力矩阵有 `lora_*` 字段) | ✅ `mflux-lora-library` + 多 LoRA/LoKr |
| ControlNet / Depth / Kontext / Redux / Fill | ⚠️ 未见统一入口 | ✅ 各有专用命令 |
| LoRA 训练 | ❌ 无 | ✅ `mflux-train` |
| 官方定位 | **推荐新集成走这条** | 明确标注 "Legacy compatibility" |

---

## 3. 如果真要做:改动量与影响面

假设目标是"用 mflux 命令替换当前 mlxgen 命令构造",新增一个 `MfluxProvider`(不动现有实现):

### 3.1 必须改的(契约三处同步,AGENTS.md §2.1)

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/shared/src/provider.ts` | `ProviderId` 加 `'mflux'` |
| 2 | `packages/shared/src/index.ts` | IPC 契约(仅当要暴露 mflux 模型管理时才动) |
| 3 | `apps/desktop/src/main/index.ts` | `ipcMain.handle` 对应实现 |
| 4 | `apps/desktop/src/preload/index.ts` | `contextBridge` 暴露 |

### 3.2 建议改的(收敛而非分叉)

| 文件 | 改动 | 理由 |
|---|---|---|
| `packages/providers/src/registry.ts` | `createRegistry({ extra })` 注入 `new MfluxProvider(...)` | 红线 R3:**禁止绕过 registry**,新 Provider 走 `extra` |
| `packages/providers/src/mflux.ts` | 新建,实现 `Provider` | 与 `mlxgen.ts` 并存,便于 A/B |
| `packages/shared/src/domain.ts:254,271` | `engine` 联合类型加 `'mflux'` | ⚠️ **注意**:这是持久化字段,旧项目文件读回来不能炸 —— 只加不删,保持向后兼容 |
| `apps/desktop/src/renderer/src/pages/canvas/node-mapping.ts` | 新节点默认 engine | 可选 |
| `apps/desktop/src/main/render-queue.ts:49` | 路由表 | 图片默认 provider 选择 |

### 3.3 需要新增的映射逻辑(真正的成本所在)

mflux 门面 **没有自动路由**,所以 Provider 内部要自己写一张 `(kind, model) → 命令` 的表:

```
kind=generate   + z-image 系模型 → mflux-generate-z-image-turbo
kind=generate   + flux2 系模型   → mflux-generate-flux2 --model flux2-klein-9b
kind=instruction/inpaint/outpaint + flux2 → mflux-generate-flux2-edit
kind=instruction/inpaint/outpaint + qwen  → mflux-generate-qwen-edit
kind=upscale                       → mflux-upscale-seedvr2
kind=img2img                       → ??? 需确认 mflux 侧对应命令
```

这张表是**持续维护负担**:每上一个新模型,统一门面加一条 `capabilities` 记录即可自动生效,mflux 门面要在代码里加一个 `if`。

### 3.4 工作量粗估

| 项 | 估时 | 备注 |
|---|---|---|
| `mflux.ts` Provider 骨架 + check() | 0.5 天 | 探测 40 个命令存在性 |
| 命令映射表 + 参数对齐 | 1–1.5 天 | 逐命令核对 `--help`(本机可实测) |
| 单测(dry-run 命令构造) | 0.5 天 | 对齐 `__tests__/mlxgen.test.ts` 12 例的口径 |
| 契约三处 + typecheck | 0.5 天 | 机械同步 |
| **小计** | **≈ 3 天** | 不含真实推理验证 |

---

## 4. 为什么直接换门面是负收益

| # | 问题 | 说明 |
|---|---|---|
| 1 | **不是替换,是重复** | 同一 pip 包、同一套权重、同一套推理内核。换来的是"命令行长什么样",不是能力 |
| 2 | **丢失模型自省** | `mlxgen capabilities --model X` 返回 JSON(handler_id / mode / min·max_images / outpaint_fill_modes / lora 信息 …)。当前 Provider 的防呆靠**硬编码 `if`**(如 `img2img` 拒绝 Qwen Edit、带参考图必须 flux2-klein)。换成 mflux 门面后**这套自省没了**,只能继续堆硬编码 |
| 3 | **丢失统一下载** | `mlxgen download --model X` 是当前 `mlxgen-models.ts` 的基础;mflux 门面无对应子命令,首跑隐式下载无法做进度/断点/Xet 回退(现网已踩过 Xet 401 的坑并内置回退) |
| 4 | **模型清单维护成本上升** | 当前一个 `KNOWN_MODELS` 数组 + repo id 即可;mflux 门面下 repo id 与"该用哪个命令"绑死 |
| 5 | **与上游方向相反** | mflux 自己把统一门面标为 *推荐新集成*、遗留命令标为 *Legacy compatibility*。基于 Legacy 面做新集成,后续上游收敛时会被动 |
| 6 | **回退成本不对称** | 真出问题要回退到 mlxgen 门面时,`domain.ts` 的 `engine` 字面量已扩散到持久化数据 |

> 补充:第 2 点尤其致命。本项目的 Provider 里已经沉淀了**两次真实事故**的防呆逻辑(见 `mlxgen.ts:119-129` 注释:Agent 建 image-edit 节点漏写 model → 被路由成文生图;`mlxgen.ts:186-194`:Qwen Image Edit 无 latent I2I → exit 2)。这些恰恰是 `capabilities` 本可以自动回答的问题。

---

## 5. 真正值得考虑的:不是"换",是"补"

如果动机是「当前 mlxgen 门面能力不够」,那 mflux 门面里**确实独有**、统一门面尚未覆盖的东西是:

| 能力 | mflux 命令 | 对 BigBotArt 的价值 | 优先级 |
|---|---|---|---|
| **LoRA 库 + 多 LoRA + 权重** | `mflux-lora-library`、`--lora-paths/--lora-scales` | 高 —— 项目已有加速 LoRA 概念(h3c 侧),图片侧同等诉求 | ⭐⭐⭐ |
| **LyCORIS LoKr**(FLUX.1/FLUX.2) | 同上 | 中 —— 社区模型主流格式 | ⭐⭐ |
| **ControlNet / Depth 条件** | `mflux-generate-controlnet`、`-depth` | 中高 —— 直接对应"构图控制"节点 | ⭐⭐ |
| **Kontext / Redux / Fill** | `mflux-generate-kontext` / `-redux` / `-fill` | 中 —— 编辑模式扩展 | ⭐⭐ |
| **LoRA 训练**(本地出风格) | `mflux-train` | 低-中 —— 产品级新方向,但重 | ⭐ |
| **深度图提取** | `mflux-save-depth` | 低 | ⭐ |
| **元数据导出/复用** | `--metadata` / `--config-from-metadata` | 中 —— Take 复现/参数回填 | ⭐⭐ |

**推荐路径:先查统一门面是否已覆盖,再决定要不要走 mflux 专用命令。**

```bash
mlxgen capabilities --model z-image-turbo     # 看 lora_status / lora_target_roles
mlxgen capabilities --model flux2-klein-9b
mlxgen generate --help                        # 看是否已有 --lora-paths
```

本机已初步看到:能力矩阵里存在 `lora_status` / `lora_target_roles` 字段,且统一门面的 `--help` 里 `--lora-paths` / `--lora-scales` / `--lora-style` **都在**。也就是说 **LoRA 这张牌统一门面已经打了** —— 这进一步削弱了"换门面"的必要性。

---

## 6. 建议

### 6.1 不推荐
❌ **把 `MlXGenProvider` 重写为调用 `mflux-generate-*`**。收益近乎为零,成本 3 天 + 长期维护负担 + 丢失自省与下载能力 + 与上游定位相反。

### 6.2 推荐
✅ **保持 `mlxgen` 门面不动**,把精力放在两件更有价值的事:

1. **用 `mlxgen capabilities` 替换硬编码防呆**
   把 `mlxgen.ts` 里那些 `if (model 含 qwen-edit) 抛错` 的手写判断,改为启动时拉一次能力矩阵、按 `mode` / `max_images` / `outpaint_fill_modes` 做通用校验。
   → 新增模型零代码,且防呆更准。这是一个**纯增量、可独立验证**的改动。

2. **按需为特定能力引入 mflux 专用命令作为"补充 Provider"**
   仅当确认统一门面没有对应能力时(如 `mflux-train`、`mflux-lora-library`),再新增窄接口的 Provider 走 `createRegistry({ extra })` 注入。**保持 mlxgen 为图片主引擎。**

### 6.3 如果用户坚持要换
最小风险落地顺序:
1. 先写 `packages/providers/src/mflux.ts`,**与现有 mlxgen 并存**,通过 `extra` 注入;
2. `ProviderId` 加 `'mflux'`,**`domain.ts` 的 `engine` 只加不删**;
3. 用 `__tests__/mlxgen.test.ts` 的 12 例口径写 mflux 版单测(纯 dry-run 命令构造,不碰真模型);
4. `pnpm typecheck` + `pnpm test`;
5. **不主动真实推理**(AGENTS.md 红线 R2)—— 真实跑需用户显式开启两层开关。

---

## 7. 待确认问题(需用户决策)

1. 想换成 mflux 的**真实动机**是什么?
   - (a) mlxgen 某些能力缺失 → 应该具体列出缺哪些,大概率是走"补"而非"换"
   - (b) 稳定性/兼容性出过问题 → 需定位具体故障,可能只是单点 bug
   - (c) 只是觉得 mflux 更"正统"/社区更大 → 说明:两者同包,不存在这个差别
2. 是否要 **LoRA(图片侧)** 能力?这是 mflux 唯一真正独立的价值点。
3. 是否需要 **ControlNet / Depth / Kontext** 这类结构化条件控制?

---

## 附:证据留档(本机实测,2026-09)

```bash
# 1. mflux 与 mlxgen 同包同源
$ uv tool list | head
mlx-gen v0.37.0
- mflux-generate-z-image-turbo
- mflux-generate-flux2
- …
- mlxgen

# 2. mflux 的 Python 实现就是 mfluor 运行时
$ head ~/.local/share/uv/tools/mlx-gen/lib/python3.11/site-packages/mflux/__init__.py
from mflux.python_runtime import (...)
from mflux.release.validation_registry import (...)

# 3. mflux 官方自我定位
$ mflux-generate-flux2 --help | grep -A1 Legacy
Legacy compatibility command for FLUX.2 Klein image generation.
Prefer `mlxgen generate --model <model> ...` for new integrations.

# 4. 统一门面已有 LoRA 参数
$ mflux-generate-z-image-turbo --help | grep lora
  [--lora-style {...}] [--lora-paths [LORA_PATHS ...]] [--lora-scales [LORA_SCALES ...]]

# 5. 能力自省(统一门面独有)
$ mlxgen capabilities --model z-image-turbo
{ "capabilities": [ { "handler_id": "z-image-turbo.generate", "public_task": "text-to-image",
                      "lora_status": "mapped-unvalidated", "max_images": 0, ... } ] }
```
