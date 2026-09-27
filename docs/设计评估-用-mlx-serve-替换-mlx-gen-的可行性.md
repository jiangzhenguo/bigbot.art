# 设计评估:用 mlx-serve 替换 mlx-gen 的可行性

> 评估日期:2026-09 · 性质:**只读调研 + 设计,未改任何代码**
> 相关文档:`docs/设计评估-图片引擎换用-mflux-的可行性.md`、`docs/图片生成与编辑能力现状盘点.md`
> 本机实测环境:macOS Apple Silicon · mlx-serve `26.9.5`(mlx `0.32.2`)

---

## 0. 结论(先说答案)

**这是一个真命题 —— mlx-serve 与 mlx-gen 是两个真正不同的东西,不是同一栈的两个门面。**

(对比:`mflux` 与 `mlxgen` 是同一 pip 包的两个门面,所以那题是伪命题;本题不是。)

| 维度 | 结论 |
|---|---|
| **技术可行性** | ✅ 完全可行。mlx-serve 有真实的 `POST /v1/images/generations` + `POST /v1/images/edits` 端点,OpenAI 兼容形态 |
| **架构契合度** | ✅ **意外地高**。Provider 接口本来就是 `submit/status/cancel` 异步模型,HTTP 服务比 spawn CLI 更贴合 |
| **能力覆盖度** | ⚠️ **有缺口**。图像侧模型家族远少于 mlx-gen(详见 §3) |
| **主要风险** | 🔴 **把"进程内 spawn"换成"常驻服务依赖"**,引入生命周期管理、端口占用、单点故障 |
| **建议** | ⚠️ **不作为图片主引擎替换**;作为**补充 Provider** 接入其独有能力(见 §6) |

**一句话**:mlx-gen 是"**进程式批处理引擎**",mlx-serve 是"**常驻 HTTP 推理服务**"。前者适合"点一次跑一次",后者适合"服务化、多客户端、带状态"。BigBotArt 当前架构是前者。换过去不是升级,是**换了一类依赖形态**,需要按这个视角决策,而不是按"功能多少"决策。

---

## 1. mlx-serve 是什么

- **项目**:[ddalcu/mlx-serve](https://github.com/ddalcu/mlx-serve) — *Native LLM inference server for Apple Silicon. OpenAI + Anthropic API compatible. No Python.*
- **形态**:**Swift 原生二进制**(不是 Python 包),配套 macOS 应用 `MLX Core.app`
- **本机版本**:`mlx-serve 26.9.5` / `mlx 0.32.2` / `nax on (M5 neural accelerators)`
- **本机状态**:✅ **已安装且正在运行**

```bash
$ ps aux | grep mlx-serve
/Applications/MLX Core.app/Contents/MacOS/mlx-serve --serve --port 11234 --host 0.0.0.0 \
  --log-level info --model-dir ~/.mlx-serve/models --model-dir ~/.lmstudio/models \
  --metrics --pld --pld-draft-len 5 --pld-key-len 3 --mtp --prefix-cache-entries 8 \
  --prefix-cache-disk off --temp 0.8 --top-p 0.95
```

### 定位差异(关键)

| | mlx-gen(`mlxgen`) | mlx-serve |
|---|---|---|
| 语言/形态 | Python (uv tool),CLI | Swift 原生,HTTP 服务 |
| 进程模型 | **短生命周期**:每次提交 spawn 一个进程,跑完退出 | **常驻**:后台服务,模型按需加载 |
| 调用方式 | `spawn(bin, args)` | `fetch('http://127.0.0.1:11234/v1/...')` |
| 安装 | `uv tool install mlx-gen` | macOS App / 独立二进制 |
| 模型目录 | HF 缓存(`~/.cache/huggingface`) | `~/.mlx-serve/models`(+ 可挂载 LM Studio 目录) |
| 协议 | 自有 CLI 子命令 | **OpenAI + Anthropic + Ollama 三套线协议** |
| 能力自省 | ✅ `mlxgen capabilities` | ✅ `GET /v1/models` 带 `capabilities` 字段 |

> 注意:`mlx-serve` 的模型目录**已经挂了 `~/.lmstudio/models`** —— 与本项目的 LLM 走 LM Studio 是同一生态位,存在**能力重叠**。

---

## 2. 实测证据(本机,2026-09)

### 2.1 图像端点真实存在

```bash
$ curl -s -X POST http://127.0.0.1:11234/v1/images/generations -H 'Content-Type: application/json' -d '{}'
{"error":{"message":"No default model configured","type":"no_model","param":null,"code":503}}

$ curl -s -X POST http://127.0.0.1:11234/v1/images/edits -H 'Content-Type: application/json' -d '{}'
{"error":{"message":"No default model configured","type":"no_model","param":null,"code":503}}

$ curl -s -X POST http://127.0.0.1:11234/v1/images/edit -d '{}'
{"error":{"message":"Unknown endpoint","type":"not_found","param":null,"code":404}}
```

→ `generations` 与 `edits` **是注册路由**(503 = 端点存在,只是没配默认模型);`edit` 单数不存在。**OpenAI 图像 API 形态确认。**

### 2.2 模型能力自省

```bash
$ curl -s http://127.0.0.1:11234/v1/models | python3 -m json.tool
{
  "object": "list",
  "data": [
    { "id": "ddalcu/Qwen-Image-2.1-MLX-Serve-8bit",
      "object": "model", "owned_by": "mlx-serve",
      "loaded": false, "state": "error",
      "capabilities": ["image"] },          ← 图像模型,capabilities 明确区分
    { "id": "PocketAiHub/Ornith-1.5-35B-A3B-Abliterated-MLX-4bit",
      "capabilities": ["chat","tool_use","streaming","json_schema","vision"], ... }
  ]
}
```

→ **`capabilities` 字段区分 `image` / `chat` / `vision`**,Provider 可据此做能力判定(这是 mlx-gen 的 `mlxgen capabilities` 的对等物)。

### 2.3 ⚠️ 本机 image 模型处于损坏状态(重要观察)

```bash
$ curl -s -X POST .../v1/images/generations -d '{"model":"ddalcu/Qwen-Image-2.1-MLX-Serve-8bit","prompt":"a cat"}'
{"error":{"message":"Model load failed: QwenImageConfigMissing","type":"model_load_failed","code":500}}

$ find ~/.mlx-serve/models -name "*.partial"
.../text_encoder/model-00002-of-00004.safetensors.partial

$ du -sh ~/.mlx-serve/models/ddalcu/Qwen-Image-2.1-MLX-Serve-8bit
3.4G
```

**下载中断 → 模型损坏 → 加载 500**。这暴露了 mlx-serve 的一个运维特征:模型完整性由**它自己**管,失败以 HTTP 500 形式呈现。相比 mlx-gen 侧本项目已实现的"HF 缓存完整性校验 + Xet 回退 + 停滞看门狗"(`apps/desktop/src/main/mlxgen-models.ts`),**这套容错在 mlx-serve 路径上需要重新建设**。

### 2.4 媒体能力全景(官方文档)

```bash
$ curl -s .../docs/api.md
```

| 端点 | 模型家族 |
|---|---|
| `POST /v1/images/generations`、`/v1/images/edits` | **FLUX.2、Krea-2、Mage-Flow、Qwen-Image-2.1** |
| `POST /v1/video/generations` | **LTX-Video 2.3/2.5、MiniMax-H3** ⭐ |
| `POST /v1/audio/speech` | Qwen3-TTS、Kokoro |
| `POST /v1/audio/music-generations` | ACE-Step、MiniMax Music 3 |
| `POST /v1/3d/generations` | Hunyuan3D-2.1 |

媒体能力细节(官方原文要点):
- 所有媒体端点支持 `"stream": true` → **SSE 进度流**,以 base64 `complete` 载荷收尾
- 媒体 LoRA 统一文法:`lora_paths` + `lora_scales`,**最多 8 个,依次叠加**
- edits 端点走 **OpenAI SDK multipart 形态**(`client.images.edit`),**支持重复 `image[]` 传多参考图** ⭐
- `POST /v1/load-model` / `unload-model`(带 `"default": true`)/ `models/rescan`

---

## 3. 能力对照:BigBotArt 现有节点 vs mlx-serve

| BigBotArt 节点/能力 | mlx-gen 现状 | mlx-serve | 判定 |
|---|---|---|---|
| **image-gen 文生图** | ✅ z-image-turbo / flux2-klein / qwen-image | ✅ Qwen-Image-2.1 / FLUX.2 / Krea-2 / Mage-Flow | ✅ 覆盖 |
| **image-edit 指令编辑** | ✅ Qwen-Image-Edit / flux2-klein | ✅ `/v1/images/edits` | ✅ 覆盖 |
| **image-stitch / split / crop** | ✅ 纯 ffmpeg(不经引擎) | — | 无关 |
| **image-upscale 超分** | ✅ SeedVR2-3B / 7B | ⚠️ **未在端点表出现** | 🔴 **缺口** |
| **多参考图(ref-image)** | ✅ flux2-klein multi-reference | ✅ `image[]` 重复 | ✅ 覆盖 |
| **inpaint(mask)** | ✅ `--mask-path` | ⚠️ 端点表未明确列 mask 参数 | 🟡 **待核** |
| **outpaint(扩图)** | ✅ `--outpaint-padding` | ⚠️ 未见 | 🟡 待核 |
| **img2img(latent)** | ✅ z-image `--i2i-mode latent` | ⚠️ 未见 | 🟡 待核 |
| **多 seed** | ✅ `--seed 42 43` | ⚠️ 未见(OpenAI 形态通常单 seed,`n` 参数待核) | 🟡 待核 |
| **视频生成** | ✅ wan2.2-ti2v | ✅ **LTX-Video 2.3/2.5 + MiniMax-H3** | ⭐ **重叠**(本项目 h3c 已负责) |
| **LoRA(8 个叠加)** | ⚠️ 有 `--lora-paths` | ✅ `lora_paths`+`lora_scales` 最多 8 个 | ✅ 覆盖 |
| **进度反馈** | ✅ `--json-events` JSONL | ✅ SSE `stream:true` | ✅ 覆盖 |
| **取消** | ✅ `child.kill('SIGTERM')` | ⚠️ HTTP 断连 / 未明确取消语义 | 🟡 待核 |

### 关键缺口

1. 🔴 **超分(SeedVR2)未见于 mlx-serve 端点表** —— 而 `image-upscale` 是项目**已存在的节点类型**
2. 🟡 **inpaint mask / outpaint / img2img / 多 seed** 四个参数面需要实测确认(文档诚实地说"use each model's README",图像参数细节未展开)
3. ⭐ **`/v1/video/generations` 支持 MiniMax-H3** —— 与本项目 h3c 引擎**正面重叠**,需要考虑是否收编

---

## 4. 架构契合度分析(这一节是重点)

### 4.1 有利面:Provider 接口天然适配 HTTP

`packages/shared/src/provider.ts` 的接口:

```typescript
interface Provider {
  check(): Promise<ProviderStatus>;
  capabilities(): Promise<ProviderCapabilities>;
  submit(req: RenderRequest): Promise<RenderJobHandle>;
  status(handle: RenderJobHandle): Promise<RenderStatus>;
  cancel(handle: RenderJobHandle): Promise<void>;
}
```

**这是一个异步任务模型,HTTP 服务比 spawn CLI 更贴合** —— 特别是:

| 当前 spawn CLI 的痛点 | HTTP 服务的改善 |
|---|---|
| `status()` 靠轮询 `child.exitCode` + 存 `Map<taskId, ChildProcess>` | 天然有 job id,可配 SSE 进度 |
| stdout JSONL 手工 buffer 切行解析(`mlxgen.ts:224-240`) | SSE 事件流,无需手写行解析 |
| stderr 累积到 `Map` 里截断 1600 字符 | HTTP 错误体结构化 |
| `cancel()` = `SIGTERM` 杀进程(粗暴,模型加载状态丢失) | 可保留服务与已载模型,只取消请求 |
| 每次提交**冷启动**:进程启动 + 模型加载(实测 8 步 512² 约 1.1 it/s,但**加载占大头**) | **模型常驻**,二次生成省掉加载时间 ⭐ |
| 并发 = 多个进程抢内存(红线:不能同时开两个真实任务) | 服务侧排队/复用 ⭐ |

**"模型常驻"是这个方案最实在的技术收益** —— 当前 mlx-gen 每次生成都要重载模型。

### 4.2 不利面:引入常驻服务依赖

| # | 问题 | 说明 |
|---|---|---|
| 1 | **生命周期谁管** | 当前 App 不管理 mlxgen 进程(用完即走)。换成 mlx-serve,谁启动/停止服务?App 托管?用户手起?崩溃了谁拉起? |
| 2 | **端口占用/冲突** | 固定 `127.0.0.1:11234`。若用户已跑 MLX Core.app(本机就是),App 再起一个会冲突 |
| 3 | **默认监听 `0.0.0.0`** | ⚠️ **安全**:help 明确写 *"default: 0.0.0.0 — open to the local network"*。本机进程实测就是 `--host 0.0.0.0`,**局域网可访问**。Electron 应用若托管这个服务,需强制改 `--host 127.0.0.1` |
| 4 | **与 MLX Core.app 生态重叠** | 本机已在跑,且挂了 `~/.lmstudio/models`。同时跑两个服务争抢统一内存(Apple Silicon 的 GPU 内存是全局资源) |
| 5 | **模型目录双份** | mlx-gen 用 HF 缓存,mlx-serve 用 `~/.mlx-serve/models`。**同一模型可能被下载两份**(本机 z-image-turbo 已有 HF 一份) |
| 6 | **错误语义变化** | 加载失败 = HTTP 500 + `type:"model_load_failed"`;需要重新建错误映射(现有 `stderrs` 尾部诊断逻辑作废) |
| 7 | **红线 R2 不变** | 真实推理仍须用户显式触发,HTTP 化不改变这一点 |

### 4.3 与现有红线/规范的关系

| 规范 | 影响 |
|---|---|
| **R3**(禁止绕过 registry) | 新 Provider 必须经 `createRegistry({ extra })` 注入 —— 与 mflux 评估结论一致 |
| **R4**(renderer 不得直接调 Node/Electron) | HTTP 请求应走主进程,不要从 renderer 直接 fetch(保持进程隔离) |
| **§2.1 IPC 契约三处同步** | 若要暴露服务管理(启停/状态),需改 `BigBotArtApi` + `ipcMain.handle` + `preload` |
| **§2.1 领域类型持久化** | `ImageGenParams.engine`(`domain.ts:254`)是**持久化字段**,加 `'mlxserve'` 只能加不能删 |

---

## 5. 改动量估算

假设新增 `MlxServeProvider`(与 `MlXGenProvider` 并存):

| # | 项 | 文件 | 估时 |
|---|---|---|---|
| 1 | Provider 实现(HTTP 客户端 + SSE 解析) | `packages/providers/src/mlxserve.ts`(新建) | 1.5 天 |
| 2 | 服务生命周期管理(探测/可选启动/健康检查) | `apps/desktop/src/main/mlxserve-service.ts`(新建) | 1 天 |
| 3 | `ProviderId` 加 `'mlxserve'` | `packages/shared/src/provider.ts` | 0.1 天 |
| 4 | `engine` 联合类型加 `'mlxserve'` | `packages/shared/src/domain.ts:254,271` | 0.1 天 |
| 5 | 注册表注入 | `packages/providers/src/registry.ts` | 0.1 天 |
| 6 | 模型清单/下载适配(若要用其模型管理) | 新模块 | 1 天 |
| 7 | IPC 契约三处同步(若暴露服务管理) | `shared/index.ts` + `main/index.ts` + `preload/index.ts` | 0.5 天 |
| 8 | 单测(dry-run:HTTP mock,不碰真模型) | `packages/providers/src/__tests__/mlxserve.test.ts` | 0.5 天 |
| 9 | 参数面实测核对(**需真实模型**) | — | 0.5 天 |
| | **合计** | | **≈ 5 天** |

> 对照:mflux 换门面估 ≈3 天且是负收益;mlx-serve 估 ≈5 天,**有真实收益(模型常驻 + SSE + 多协议)但也有真实缺口**(超分等)。

---

## 6. 建议

### 6.1 不推荐:`mlx-gen` → `mlx-serve` 整体切换

理由:
1. **架构形态变更**,不是能力升级 —— 从"批处理 CLI"变成"常驻服务",牵出生命周期/端口/安全/双份模型 5 个新问题
2. **能力有缺口**:超分(SeedVR2)在 mlx-serve 端点表中未见,而这是**已有节点类型**
3. **多个参数面未验证**(inpaint mask / outpaint / img2img / 多 seed),文档明说要看各模型 README
4. **本机既存服务已占用端口**,且默认监听 `0.0.0.0`(安全问题)
5. 与 `MLX Core.app` + LM Studio 生态重叠,内存是全局稀缺资源

### 6.2 推荐:作为**并列补充 Provider** 按需接入

**保留 mlx-gen 为图片主引擎**,在以下**真正独有**的场景引入 mlx-serve:

| 优先 | 场景 | 理由 |
|---|---|---|
| ⭐⭐⭐ | **模型常驻加速交互式迭代** | 当前每次生成都重载模型;常驻服务对"反复调参"场景收益显著 |
| ⭐⭐ | **`/v1/video/generations`(LTX-Video / MiniMax-H3)** | 与 h3c 重叠,但 h3c 是 CLI;若未来要服务化视频,这是现成路径 |
| ⭐⭐ | **多协议兼容(OpenAI/Anthropic/Ollama 线协议)** | 若未来要开放 API 给第三方,不用自己造轮子 |
| ⭐ | **音频/音乐/3D 端点** | 产品新方向素材(当前无对应节点) |
| ⭐ | **多参考图 edits(`image[]`)** | 与现有 ref-image 能力重叠,可对比质量 |

### 6.3 无论如何都要先做的一件事

**先验证 §3 的 5 个 🟡 待核项**。在做任何架构决策前,用真实模型跑一遍:

```bash
# 1. 先修好那个损坏的模型(下载未完成)
mlx-serve pull ddalcu/Qwen-Image-2.1-MLX-Serve-8bit   # 或删除后重拉

# 2. 逐项实测(用户显式授权后)
curl -X POST http://127.0.0.1:11234/v1/images/generations \
  -d '{"model":"...","prompt":"...","size":"512x512"}'          # 基础生成
curl -X POST http://127.0.0.1:11234/v1/images/edits \
  -F 'image=@in.png' -F 'prompt=make it blue'                    # 指令编辑
# 3. 逐一确认:mask? outpaint-padding? img2img strength? 多 seed? 取消语义?
```

**这 5 项答案决定了 mlx-serve 到底能覆盖几个现有节点**,是后续决策的唯一硬依据。

---

## 7. 待用户决策的问题

1. **动机**:想换 mlx-serve 是想解决什么?
   - (a) **生成太慢** → 大概率是**模型重载**问题,常驻服务确实能解决 ⭐ 推荐走"补充 Provider"
   - (b) **想要更好的模型**(Krea-2 / Mage-Flow / FLUX.2)→ 需确认这些在 mlx-gen 侧是否已覆盖
   - (c) **想要视频/音频/3D 能力** → 那是**新增能力**,不是替换
   - (d) **想要统一 API 对外** → 独立议题,与图片引擎替换无关
2. **是否接受引入常驻服务依赖?**(生命周期/端口/内存三件事由谁管)
3. **是否已知道本机 MLX Core.app 正在运行且监听 `0.0.0.0`?** 是否需要收紧为 `127.0.0.1`?
4. **超分(SeedVR2)怎么办?** 若 mlx-serve 确无此能力,替换后这个节点要么保留双引擎,要么降级。

---

## 附:证据留档(本机实测,2026-09)

```bash
# 1. mlx-serve 是独立 Swift 二进制,与本机 MLX Core.app 同源
$ file ~/.local/bin/mlx-serve        # → /Applications/MLX Core.app/Contents/MacOS/mlx-serve
$ mlx-serve --version
mlx-serve 26.9.5 / mlx 0.32.2 / nax on (M5 neural accelerators)

# 2. 服务正在运行
$ ps aux | grep mlx-serve
... --serve --port 11234 --host 0.0.0.0 --model-dir ~/.mlx-serve/models \
    --model-dir ~/.lmstudio/models --metrics --pld ...

# 3. 图像端点存在(OpenAI 形态)
$ curl -s -X POST .../v1/images/generations -d '{}'   # → 503 no_model(端点存在)
$ curl -s -X POST .../v1/images/edits       -d '{}'   # → 503 no_model
$ curl -s -X POST .../v1/images/edit        -d '{}'   # → 404(单数不存在)

# 4. 能力自省
$ curl -s .../v1/models | python3 -m json.tool
  ddalcu/Qwen-Image-2.1-MLX-Serve-8bit → capabilities: ["image"]  state: "error"

# 5. ⚠️ 本机 image 模型损坏(下载中断)
$ find ~/.mlx-serve/models -name "*.partial"
  .../text_encoder/model-00002-of-00004.safetensors.partial
$ curl -s -X POST .../v1/images/generations -d '{"model":"...","prompt":"a cat"}'
  {"error":{"message":"Model load failed: QwenImageConfigMissing","type":"model_load_failed","code":500}}

# 6. 官方 API 文档(媒体端点全景 + LoRA 文法 + SSE)
$ curl -s https://raw.githubusercontent.com/ddalcu/mlx-serve/main/docs/api.md
  - /v1/images/generations, /v1/images/edits      → FLUX.2 / Krea-2 / Mage-Flow / Qwen-Image-2.1
  - /v1/video/generations                          → LTX-Video 2.3/2.5, MiniMax-H3
  - /v1/audio/speech, /v1/audio/music-generations  → Qwen3-TTS, Kokoro, ACE-Step, MiniMax Music 3
  - /v1/3d/generations                             → Hunyuan3D-2.1
  - 所有媒体端点支持 "stream": true → SSE 进度流
  - LoRA:lora_paths + lora_scales,最多 8 个
```

参考链接:
- [ddalcu/mlx-serve](https://github.com/ddalcu/mlx-serve) — 官方仓库
- [mlx-serve docs/api.md](https://github.com/ddalcu/mlx-serve/blob/main/docs/api.md) — HTTP API 文档
- [mlx-serve docs/models.md](https://github.com/ddalcu/mlx-serve/blob/main/docs/models.md) — 支持模型清单
- [Release v26.9.5](https://github.com/ddalcu/mlx-serve/releases/tag/v26.9.5) — 当前版本
