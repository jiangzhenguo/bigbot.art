# CosyVoice3 语音合成与视频配音 — 产品设计与技术方案

> 状态:**设计待确认**(尚未动手改代码)
> 引擎来源:[mlx-gen](file:///Users/jiangzhenguo/ai/mlx-gen) `mlxgen tts` / `mlxgen dub`(CosyVoice 3 · Fun-CosyVoice3-0.5B-2512)
> 引擎文档:`~/ai/mlx-gen/docs/cosyvoice3-tts.md`
> 关联:[节点手册.md](./节点手册.md) §3.5b video-upscale / §3.9 audio-ref / §3.8 timeline · [时间线剪辑-需求.md](./时间线剪辑-需求.md) §1.1 · [工具模型选择-产品设计与技术方案.md](./工具模型选择-产品设计与技术方案.md)
>
> **修订记录**
> - 2026-10-16 初稿:能力盘点 + 画布结合方案 + 分期落地

---

## 1. 要解决的问题

BigBotArt 当前的「声音」能力全部是**引用 / 抽取**,没有**生成**:

| # | 现有能力 | 实际做什么 | 缺口 |
|---|---|---|---|
| 1 | `audio-ref` / 音频 `asset` | 绑用户音频 → shot 的 h3 `--ref-audio` | 不能从文本造出旁白 |
| 2 | `extractAudio` | 从视频抽 wav | 同上,只抽不生成 |
| 3 | h3 镜头自带音轨 | 生成时模型内嵌声景 / 对白 | **不可控音色**,难做「指定人声念旁白」 |
| 4 | timeline | 保留 Take 内嵌音轨导出 | 文档明确「不做独立配乐/旁白引擎」 |
| 5 | 技能里的「旁白」 | 分镜表 / 提示词里的**文字** | 成片听不到那句旁白(除非碰巧写进 h3 Audio 段) |

mlx-gen 新增的 CosyVoice3 正好补这一环:**零样本音色克隆 + 文生语音 + 给已有视频配旁白**。

**核心诉求**:在画布上把「念一句旁白 / 给成片配旁白」做成**可见、可连、可重跑**的节点,与现有 shot → video-upscale → timeline 流水线自然衔接;Agent / 科普类技能能真正「用声音交付旁白」,而不是只把旁白写进 prompt。

---

## 2. 引擎能力面(事实源)

> 以下与 `~/ai/mlx-gen/docs/cosyvoice3-tts.md` 对齐;引擎变更时先改那边再回写本节。

### 2.1 为什么是独立命令

`mlxgen tts` / `mlxgen dub` **不是** `mlxgen generate` 的路由分支:

- 参数形状不同(参考音、逐字稿、instruct、混音模式);
- CosyVoice3 官方栈是 **Python 3.11 + PyTorch + transformers 4.x**,与 mlx-gen 图片/视频侧的 `transformers>=5` **不能同环境**;
- `mlxgen prepare --model cosyvoice3` 建隔离包后,每次推理 spawn `<package>/venv/bin/python` 跑 worker,mlx-gen 主环境**从不** import torch / CosyVoice。

进度契约与 `generate` 相同:`--json-events` 打 JSONL runtime events。

### 2.2 准备

```bash
mlxgen prepare --model cosyvoice3 --path ./models/cosyvoice3
# 默认落 $MFLUX_CACHE_DIR/cosyvoice3
```

包结构:

```
<path>/
  model/        Fun-CosyVoice3-0.5B-2512 权重(~5.4 GB)
  runtime/      官方推理代码(含 mlx-gen 的 CPU 兼容补丁)
  venv/         独立 Python 3.11 + 推理依赖
  manifest.json
```

本机开发包已有:`~/ai/mlx-gen/out/cosyvoice3/`。准备完成后 `tts` / `dub` **全离线**。

### 2.3 `mlxgen tts` — 文 → wav

| 参数 | 必填 | 说明 |
|---|---|---|
| `--text` / `--text-file` | ✅ | 要念的文本 |
| `--ref-audio` | ✅ | 参考人声 wav,**3–30 秒**干净语音;无预设音色 |
| `--ref-text` | 可选 | 参考音的逐字稿 → **zero_shot** 模式 |
| `--instruct` | 可选 | 风格指令(如「用温柔亲切的语气说」)→ **instruct2** |
| `--speed` | 默认 1.0 | 语速倍率 |
| `--seed` | 默认 42 | 随机种子 |
| `--output` | 默认 `speech.wav` | 产物路径 |
| `--metadata` / `--json-events` | 可选 | sidecar / 进度 |

模式自动选择(有 instruct → instruct2;有 ref-text → zero_shot;否则 → cross_lingual)。

### 2.4 `mlxgen dub` — 视频 + 旁白 → mp4

在 `tts` 全部参数之上:

| 参数 | 说明 |
|---|---|
| `--video-path` | 源视频(通常是 h3 成片) |
| `--mode replace\|mix` | 换轨 / 叠在原音上(默认 replace) |
| `--orig-volume` | mix 时原声音量(默认 0.15) |
| `--tts-volume` | 旁白音量(默认 1.0) |
| `--keep-wav` | 旁白 wav 另存为 `<output>.wav` |

行为要点:

- **视频 stream-copy**,只重编码音轨(依赖 PATH 上的 ffmpeg);
- 旁白短于视频 → 尾部 pad 静音;长于视频 → **裁到视频时长**(不拉长成片);
- **不调用 H3** —— 只吃现成 mp4。

### 2.5 性能与限制(实测口径,引擎文档)

| 项 | 值 |
|---|---|
| 推理设备 | CPU(官方路径未迁 CUDA/MPS) |
| 短句(~4 字) | ~2.8s 音频 / ~5.5s 墙钟 / RTF≈1.95 |
| ~20 字 | ~8.6s 音频 / ~15.3s 墙钟 / RTF≈1.78 |
| 磁盘 | ~5.4 GB;工作集在 128GB Mac 预算内 |
| 硬限制 | 必须有 `--ref-audio`;无网络合成(prepare 之后离线) |

---

## 3. 产品目标与非目标

### 3.1 目标

1. 用户能在画布上对**已有成片**配一条可控音色的旁白(替换或混音),并看到进度、可取消、可重跑;
2. 用户能单独把文本合成 wav,并把它接到 shot 的 `ref-audio` / 资产库,供后续镜头参考;
3. Agent / 科普类技能能走「旁白文字 → 配音节点」真实交付,禁止「只把旁白写进 prompt 就算完成」;
4. 模型准备与探测对用户可见(设置 / 引导),失败给可执行 hint(先 prepare)。

### 3.2 非目标(本方案不做)

| 项 | 原因 |
|---|---|
| 把 TTS 塞进 `MlXGenProvider` / `mlxgen generate` 路由 | 引擎刻意隔离;污染图片 Provider 与 transformers 版本 |
| 改 timeline 成「旁白引擎」 | 时间线需求 §1.1 已钉死「不做独立配乐/旁白」;配音是**上游节点**的事 |
| 预设说话人库 / 云端 TTS | CosyVoice3 无预设;云端另议 |
| 口型同步 / 说话人脸驱动 | 能力面没有,属另一产品 |
| 多说话人对话轨编辑器 | v1 单条旁白即可 |
| AI 默认真实跑 TTS 冒烟 | 红线 R2;与 video-post 同口径,仅用户显式触发 |

### 3.3 与 timeline「不做旁白引擎」的关系

**不冲突。** timeline 继续只编排 / 导出镜头内嵌音轨;`video-dub` 是成片后的**本地后处理节点**(同 `video-upscale`),产出新的视频节点,再可选入 timeline。职责边界:

```
shot(h3 画面+可选声景)
  └─▶ video-upscale?(画质)
        └─▶ video-dub?(旁白) ──▶ timeline / 导出 / 下游 shot.ref-video
```

---

## 4. 节点设计

分两个节点。**P0 只做 `video-dub`**(成片配旁白,价值最高、与引擎 `dub` 一一对应);**P1 做 `tts-gen`**(纯文生音,喂 ref-audio / 资产库)。

### 4.1 P0 · `video-dub` — 视频配音

**一句话**:给一条视频加旁白(克隆参考音色),视频画面不动。

#### 画布拓扑

```
视频源 ──input-video──▶ video-dub ──▶ 带旁白 mp4
参考人声 ──ref-voice──▶     ▲
旁白文本 ──(节点 data / document 连线)──┘
```

| 端口 | 基数 | 来源 | 语义 |
|---|---|---|---|
| `input-video` | 单值 | `shot` / `video-upscale` / `timeline`(有 resultPath) / 视频 `asset` | 待配音视频 |
| `ref-voice` | 单值 | 音频 `asset` / `audio-ref` / `tts-gen`(P1)产物;也允许带人声的短视频(提交前 `extractAudio`) | CosyVoice `--ref-audio` |
| (文本) | — | 节点 `data.text` 为主;可选后续接 `document`→`prompt` 注入 | 旁白正文 |

下游:与其它视频产物同口径 —— `timeline` / `frame-grab` / `video-upscale` / `shot` 的 `ref-video`·`ref-audio` / `audio-ref`。

#### 节点数据(`NodeDataMap['video-dub']` 草案)

```ts
{
  /** 旁白正文;顶层字段,避免 Agent 把长文塞进 data 对象再序列化截断 */
  text: string;
  /** 参考音逐字稿 → zero_shot;与 instruct 互斥优先规则见引擎 */
  refText?: string;
  /** 风格指令 → instruct2 */
  instruct?: string;
  /** 语速,默认 1 */
  speed?: number;
  seed?: number;
  /** 混音策略 */
  mixMode?: 'replace' | 'mix'; // 默认 replace
  origVolume?: number;         // mix 默认 0.15
  ttsVolume?: number;          // 默认 1.0
  keepWav?: boolean;           // 是否保留旁白 wav 旁路
  /** 派生态 / 产物 */
  inputVideoFrom?: { nodeId: string };
  refVoiceFrom?: { nodeId: string };
  resultPath?: string;         // 配音后 mp4
  narrationPath?: string;      // keepWav 时的 wav
  /** 运行态(与 video-upscale 同形,便于 UI 复用进度条) */
  progress?: number;
  stage?: string;
}
```

#### 检查器要点

- 旁白多行文本框 + 字数提示(长文 RTF≈2 → 预计墙钟粗估);
- 参考音色源(连线优先,可选手动绑资产);
- `refText` / `instruct` 二选一引导(同时填时按引擎:`instruct` 优先 → instruct2);
- mixMode + 两个音量滑杆(仅 mix 显示 origVolume);
- 进度条 + 取消(对标 video-upscale);
- 未 prepare 时禁用运行并给「去设置准备 CosyVoice3」入口。

#### 运行语义

- **不进** `RenderQueue`(与 video-upscale / frame-grab 同族:本地长任务);
- dry-run:`BIGBOTART_DRYRUN !== '0'` 时只构造命令 + 写占位 mp4(或明确跳过合成),**不** spawn CosyVoice worker;
- 真实跑:用户显式(设置页真实推理 + 环境变量,与 AGENTS.md §0.5 同口径);
- 同节点重复提交:沿用「在途即拒」闸(本地任务也要防双开抢 CPU)。

### 4.2 P1 · `tts-gen` — 文生语音

**一句话**:文本 + 参考人声 → wav,不绑视频。

```
旁白文本 + 参考人声 → tts-gen → wav
                              ├─▶ audio-ref / asset → shot.ref-audio
                              └─▶ video-dub.ref-voice(同一音色复用)
```

数据面是 `video-dub` 的 TTS 子集(无 mix / video 字段)+ `resultPath` 指向 wav。产物可 `importFromPaths` 进项目资产,方便资产库复用。

### 4.3 不新增的节点

- **不**把配音能力塞进 `audio-ref`(它是「引用」,语义已钉死为 h3 `--ref-audio` 源);
- **不**在 `shot` 上加「生成后再配音」隐式步骤 —— 转换点必须是**可见节点**(同 frame-grab 教训:隐式抽帧曾导致假成功与闪烁)。

---

## 5. 架构与模块落点

### 5.1 总览

```
渲染层 CanvasPage.runNode(kind=video-dub)
        │ IPC
主进程  tts.ts / video-dub.ts
        │ spawn
        ├─ mlxgen dub ... --json-events   (或: package/venv/python + worker,与引擎同路径)
        │      └─ CosyVoice3 隔离 venv(CPU)
        └─ 解析 JSONL → video-dub-progress 事件 → 节点进度条
产物    ~/.bigbotart/outputs/dub/<name>-<ts>.mp4
        (可选) 同名 .wav
```

### 5.2 为什么对标 `video-post` / `mlxgen-caption`,而不是 Provider

| 方案 | 结论 |
|---|---|
| A. 扩 `MlXGenProvider` | ❌ 命令面/依赖栈都不同;slot 目前是 image-only |
| B. 新 Provider `cosyvoice3` 进 registry | ⚠️ 可行但过重:无队列收益、还要改 Provider 契约与 dry-run 矩阵 |
| **C. 主进程本地模块 + 节点**(推荐) | ✅ 与 video-upscale、caption 一致;IPC 清晰;Agent 走 `runLocal*` |

### 5.3 文件与契约(实现清单,待动手时勾)

| 层 | 文件 / 动作 |
|---|---|
| 领域 | `packages/shared/src/domain.ts`:`NodeKind` + `NodeDataMap` |
| 连接器 | `connector-map.ts` / 渲染层 `connectors.ts` / `edge-dispatch.ts` / `edge-validate.ts` |
| 主进程 | 新 `apps/desktop/src/main/tts.ts`(探测 + spawn + 进度解析)+ 可选薄封装 `video-dub` IPC |
| IPC | `BigBotArtApi` + `main/index.ts` + `preload` 三处同步:`ttsProbe` / `videoDub` / `videoDubCancel` + 事件 `video-dub-progress` |
| 渲染 | `NODE_TYPES` / Inspector / `NodeBody` / `runNode` 分支 / 进度订阅 |
| Agent | `tool-defs` kind 枚举;`tool-handlers` `runLocal*` 分支;system prompt【旁白交付】段 |
| 设置/引导 | `KNOWN_MODELS` 或独立「语音」行:`prepare` 状态 + 路径;`BIGBOTART_COSYVOICE3_PATH` |
| 文档 | 本文 + 落地后回写 `节点手册.md` / `CLAUDE.md` 环境变量表 / `.env.example` |
| 单测 | 命令构造纯函数、探测、dry-run 不 spawn、端口校验、Agent 本地执行、进度单调性 |

### 5.4 环境变量(草案)

| 变量 | 默认 | 说明 |
|---|---|---|
| `BIGBOTART_COSYVOICE3_PATH` | 引擎默认 cache / 本机 `~/ai/mlx-gen/out/cosyvoice3` 探测顺序 | prepared package 根目录 |
| `BIGBOTART_TTS_OUTPUTS` | `~/.bigbotart/outputs/dub` | 配音产物目录 |
| (既有) `BIGBOTART_DRYRUN` | 非 `0` = dry-run | TTS/dub 同样遵守,禁止默认真跑 |

探测顺序建议:`BIGBOTART_COSYVOICE3_PATH` → 常见开发路径 → `MFLUX_CACHE_DIR/cosyvoice3` → 失败返回「请运行 mlxgen prepare --model cosyvoice3」。

### 5.5 命令解析(对齐 caption 教训)

`mlxgen tts` / `dub` 是顶层子命令;旧版 `uv tool install` 的 mlx-gen **可能没有**这些入口。解析顺序:

1. `BIGBOTART_MLXGEN_BIN` / PATH 上的 `mlxgen`(新版含 tts/dub);
2. 若 `mlxgen <sub> --help` 不认子命令 → 明确报错「请升级 mlx-gen 并 prepare cosyvoice3」,**禁止静默回退假成功**;
3. 不强制再做 `-m` 模块回退(tts/dub 的入口在 CLI dispatcher;与 caption 的 console script 缺文件形态不同)。可选增强:直接 spawn `package/venv/bin/python` + 引擎 worker 模块(绕过 mlxgen 入口版本),作为探测失败时的第二通道 —— **P1 再定**,P0 要求用户把 mlx-gen 升到含 CosyVoice3 的版本即可。

### 5.6 dry-run 与真实跑

与 AGENTS.md §0.5 完全一致:

- AI 自测 / 排障 → `pnpm dev:dry`,TTS 只构造 argv + 占位;
- 用户说「重启」→ `pnpm dev` + 设置页真实推理 = 允许真跑 CosyVoice;
- 首次真跑前 UI 提示:CPU、RTF≈2、长旁白可能数十秒到数分钟。

---

## 6. Agent 与技能

### 6.1 工具面

- `canvas.create_node(kind='video-dub'|'tts-gen')` 进入 kind 白名单;
- `engine.submit` 对二者走本地同步/长任务路径(同 video-upscale),返回 job 摘要含 `resultPath`;
- 新建工具**不必要**:旁白写作仍可用 document / 节点 `text`;合成走 submit。

### 6.2 system prompt 硬规矩(草案)

```
【旁白 / 配音的唯一通道】
- 用户要「念出来 / 配音 / 旁白成声」时,必须建 video-dub(已有成片)或 tts-gen(只要音频),
  再 engine.submit;禁止只把旁白写进 shot.prompt 的 Audio 段就算完成。
- 参考音色必须来自真实资产或上游节点;禁止编造 assetId。
- CosyVoice3 无预设说话人:没有 ref-voice 连线/绑定就不得提交。
```

### 6.3 技能文档影响

科普讲解 / 旁白驱动类技能(内置或用户技能)应改流程示例:

旧:`storyboard` 写旁白 → shot 生成 → timeline 导出  
新:… → shot(画面) → **video-dub(旁白文本 + 参考人声)** → timeline

音乐 MV 类技能**不变**:用户音乐仍走 `ref-audio` 进 h3(见 skill-gates);TTS 是旁白轨,不是替换用户歌——若叠旁白用 `mix` + 低 `origVolume`,或先 tts-gen 再人工混,P0 不自动混用户音乐。

---

## 7. 分期与验收

### 7.1 分期

| 阶段 | 范围 | 完成标准 |
|---|---|---|
| **P0** | 探测 + `video-dub` 节点 + IPC/进度/取消 + 检查器 + dry-run + 单测 | 用户手点:shot 成片 → 选参考音 → 填旁白 → 出带声 mp4 |
| **P0.5** | Agent `create_node` / `engine.submit` + prompt 硬规矩 | Agent 能跑通一条配音,假成功闸覆盖「只写 prompt」 |
| **P1** | `tts-gen` 节点 + 产物入资产库 + 可连 `video-dub.ref-voice` / `shot.ref-audio` | 同一音色多处复用 |
| **P1.5** | 设置页/引导「准备 CosyVoice3」+ 路径覆盖 | 新机器可自助 prepare(或明确手动指引) |
| **P2**(可选) | timeline 外挂旁白轨 / 多说话人 / worker 直 spawn | 另开需求,不阻塞 P0 |

### 7.2 P0 验收清单

- [ ] 未 prepare:探测失败文案含 `mlxgen prepare --model cosyvoice3`,运行按钮灰
- [ ] dry-run:不出现 CosyVoice/torch 进程,节点有占位或诚实「dry-run 跳过合成」说明
- [ ] 真跑:replace 模式成片可播、画面与源一致(stream-copy)、音轨为旁白
- [ ] mix 模式:原声可辨、旁白可辨;无原声视频自动降为 replace 并提示
- [ ] 缺 ref-voice / 空 text / 参考音不在白名单目录 → **明确拒绝**,不入队、不留半成品节点
- [ ] 进度条单调;取消后徽标「已取消」,可重跑
- [ ] 同节点在途再提交 → 拒绝
- [ ] `pnpm typecheck` + 新增单测通过

### 7.3 风险与开放问题

| # | 问题 | 倾向 |
|---|---|---|
| Q1 | P0 是否暴露 `instruct` 与 `refText` 两个高级项,还是先只做 cross_lingual(仅 ref-audio)? | **建议 P0 三模式都露出**(引擎已支持;UI 用折叠「高级」) |
| Q2 | 旁白远长于视频时裁切是否够用,要不要自动降语速? | P0 裁切 + UI 预估时长警告;自动调速 P2 |
| Q3 | 参考音来自「带对白的 h3 成片」是否允许? | 允许,但提示「请裁 3–30s 干净人声」;可用 frame 级裁切另议 |
| Q4 | 设置页「工具模型」要不要加 `audio.tts` 能力行? | P1.5 再挂;P0 只做就绪探测 |
| Q5 | 是否与 h3 `--ref-audio` 抢同一条「用户音乐」闸? | 否:TTS 旁白 ≠ 用户音乐;skill-gates 音乐闸保持原样 |

---

## 8. 一句话产品叙事

**H3 负责画面(与可选声景),CosyVoice3 负责「用指定人声念旁白」;BigBotArt 用可见的 `video-dub`(及后续 `tts-gen`)把两段接到画布上,不在时间线里偷偷混、不在 Provider 里硬塞。**

---

## 附录 A · 与现有节点对照

| 节点 | 推理? | 队列? | 产物 | 角色 |
|---|---|---|---|---|
| `shot` | h3 是 | ✅ | mp4 | 画面(+声景)生成 |
| `video-upscale` | 否(PyTorch 本地) | ❌ | mp4 | 画质后处理 |
| **`video-dub`(新)** | CosyVoice CPU | ❌ | mp4 | **旁白后处理** |
| **`tts-gen`(新)** | CosyVoice CPU | ❌ | wav | 文生音 |
| `audio-ref` | 否 | — | 绑定资产 | 给 shot 当 `--ref-audio` |
| `timeline` | 否(ffmpeg) | 导出任务 | mp4 | 剪辑交付,不生成旁白 |

## 附录 B · 典型用户路径

**科普短片旁白**

1. 用户导入 10s 干净人声样本 → 资产库;
2. Agent / 用户跑分镜 → 逐镜 `shot` 出片;
3. 每镜或成片挂 `video-dub`:旁白 = 分镜表「对白/旁白」列,`ref-voice` = 样本;
4. `mix` 保留 h3 环境声 + 旁白,或 `replace` 只要旁白;
5. 入 `timeline` 导出。

**角色音色库**

1. `tts-gen` 用同一 `ref-voice` 批出多句 wav → 资产;
2. 需要「这句当镜头音轨参考」时 → `audio-ref` → shot `ref-audio`(走 h3 带声直出,与 TTS 旁白是另一条链路)。
