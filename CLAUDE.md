# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

BigBotArt — 无限画布的视频/图片生成 Agent(跨端桌面 App,本地优先)。
基于 Electron 31 + React 18,画布为自研无限画布(DOM 节点 + SVG 连线 + 原生 CSS transform,**未使用 React Flow**),对接本地部署的 h3.c 视频引擎与 MLX 图片生成/编辑引擎。
当前处于 M1 骨架期:h3.c / mlxgen 默认 dry-run,不真实推理。

## 常用命令

```bash
pnpm install                          # 安装依赖(workspace + electron 二进制)
pnpm dev                              # 「重启/启动」用这个 = 真实跑(显式 BIGBOTART_DRYRUN=0,见 §0.5)
pnpm dev:dry                          # AI 自己验证/排障用这个 = dry-run(不碰真模型)
pnpm build                            # 构建产物(electron-vite build)
pnpm start                            # electron-vite preview(运行已构建产物)
pnpm build:packages                   # 单独构建 packages/*
pnpm typecheck                        # 全 workspace tsc --noEmit
pnpm test                             # vitest 单测/集成(800+ 用例 · 见 docs/测试用例-图片节点与裁切.md)
pnpm --filter @bigbotart/desktop typecheck  # 单包类型检查
```

### ⚠️ 「重启」的语义(AI 必读)

- **用户说「重启 / 启动 / 跑起来」= 用 `pnpm dev`(真实跑)**,这是用户对真实推理的显式触发(R2 已满足),**不用再问一次**;禁止拿 `pnpm dev:dry` 冒充重启。
- **AI 自己验证 / 排障 / 冒烟 = 用 `pnpm dev:dry`**,AI 永不自作主张 `pnpm dev`。
- 重启后**回读启动日志确认** `BIGBOTART_DRYRUN=0 · dryRun=false`。
- **重启前先清残留实例**:`pgrep -fl "MacOS/Electron \." | head`——多于一行先 `pkill -9 -f "MacOS/Electron \."`。**两个版本的进程同时写同一份数据是本项目最难查的故障**(2026-09-29 画布"全空"事故真因:一个 12:46 启动的旧实例持续用旧路径覆盖 `projects.json`)。
- 完整细则(两层开关/前置条件/常见坑)见 **AGENTS.md §0.5**。

单个 package 开发:`cd packages/agent && pnpm dev`(tsc -w)。

macOS 上若 Electron 二进制被 Gatekeeper 移除:

```bash
cd node_modules/.pnpm/electron@*/node_modules/electron
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node install.js
codesign --force --deep --sign - dist/Electron.app
```

## 架构(workspace 划分)

pnpm workspace,根 `package.json` 的 `workspaces` 字段覆盖 `packages/*` 和 `apps/*`。

- **apps/desktop** — Electron 外壳(主进程 + preload + 渲染进程)
  - `src/main/index.ts` — 主进程入口,挂载 IPC handler:引擎探测、Provider 调用、项目/画布、Agent 启停与 plan、加速 LoRA(`lora.ts`)
  - `src/main/store.ts` — `ProjectStore`(JSON 文件持久化,接口预留 SQLite 替换)
  - `src/preload/index.ts` — `contextBridge` 暴露类型化 `bigbotart` API
  - `src/renderer/src/App.tsx` — 三栏布局(节点库侧栏 + 自研无限画布 + Agent 控制台),首次启动建默认项目并探测引擎
  - `src/renderer/src/pages/agent/` — Agent 对话面板:`useAgentChat.ts`(消息流/发送/SSE 聚合/模型回显,全部状态与副作用)+ `AgentChatView`/`AgentComposer`(展示层)+ `cards/`(ToolRunCard/AskCard/ErrorCard/ThinkingBlock/ContinuityCard/PlanCard,纯展示)
  - `electron.vite.config.ts` — 三个独立构建(main / preload / renderer)
- **packages/shared** — 领域类型(画布、节点、Shot、Take、Provider、引擎状态、IPC 契约 `BigBotArtApi`)
- **packages/providers** — Provider 抽象与实现
  - `h3c-command.ts` — h3.c CLI 命令构造器(32 倍数宽高校验、`clampDimension`、档位防呆 `validateTier`、`TIER_PRESETS` 四档)
  - `h3c.ts` — h3c Provider(`--info` 探测、`spawn` 真实推理,dry-run 默认开)
  - `mlxgen.ts` — mlxgen Provider(文生图/指令编辑/I2I/Inpaint/Outpaint/超分能力;安装与模型管理见 `docs/mlxgen-图片引擎-安装与模型管理.md`)
  - `mock.ts` — 离线演示 Provider(ffmpeg 生成占位 MP4)
  - `registry.ts` — `createRegistry()` 工厂,根据 `BIGBOTART_DRYRUN` 环境变量决定 dry-run
- **packages/agent** — Agent 内核
  - `manager.ts` — `AgentManager`(主进程侧,管理 worker 子进程生命周期 + stdio JSON-RPC)
  - `worker.ts` — worker 子进程入口,内嵌 `@earendil-works/pi-ai` 真 LLM 规划
  - `pi-planner.ts` — PiPlanner(LM Studio / 远端 OpenAI 兼容端点)
  - `plan.ts` — `deterministicPlanner`(LLM 不可达时的模板兜底)
  - `protocol.ts` — stdio JSON-Lines 协议(`ping` / `plan`)

## 关键约定

- **image-gen 多参考生成**:`ref-image` 连线(资产/图片产物 → image-gen)提交时解析为 `references`(渲染层 `runNode` 与 Agent `engine.submit` 同口径,`resolveRefImagePaths`),mlxgen 走 `--i2i-mode multi-reference` + 逐张 `--image`,**需 flux.2-klein 模型**(z-image-turbo 纯文生图,带参考图报错指引换模型);asset 节点缩略图依赖渲染层资产缓存,Agent 建节点后由画布快照推送触发 `refreshAssets` 刷新(否则显示「资产未加载」)。
- **镜头参考视频(h3 `--ref-video`,2026-09 补)**:镜头节点的 `ref-video` 端口此前只有「视频 asset」能注入,**shot→shot 与 video-upscale→shot 的连线在推导/dispatch 层被静默丢弃**(连线画得出来、提交时参考视频没进生成命令)。现三类源全链路补齐:视频 `asset` / 上游 `shot` 整段成片 / `video-upscale` 增强成片。改动面:**`packages/shared/src/connector-map.ts`**(`shot.shot` 由 `'first-frame'` 改双端口 `'first-frame/ref-video'`;`PORT_SEMANTICS['ref-video']` 补音轨说明)+ **`edge-validate.ts` 的 `deriveShotRefsFromEdges`**(`shot` 分支加 `ref-video → sd.resultPath`,`VIDEO_KINDS` 分支新增同理;`validateRefsForSubmit` 加 `mode='ref-video'` 的 W004 缺参考警告)+ **渲染层 `edge-dispatch.ts`**(asset 分支补 `ref-video` 角色;`fromShot` 分支补整段成片注入;新增 `VIDEO_KINDS` 分支;走既有的 `autoBlocked` 单值让位规则)+ `connectors.ts` / `constants.ts`(`SHOT_MODE_LABEL` 加 `'ref-video'`,`SHOT_REF_ROLES` 各模式补参考视频槽)。**音轨开关**:h3 `--ref-video` 会把源片内嵌音轨一起注入,故加 `data.refVideoSilent`(检查器勾「忽略参考视频音轨」),Provider 侧 `h3c-command.ts` 据此在 `--ref-video` / `--ref-silent-video` 间切换(`h3c.ts` 读 `p.refVideoSilent`,渲染层 `runNode` 的 video `params` 显式传该字段;Agent 走 `node.data` 直传天然覆盖)。⚠️ **`duplicate-edge` 是既有通用规则**:同一对节点之间只能有一条边,所以「上游尾帧作首帧」与「上游成片作参考视频」不能共存于同一对 up→down,需拆成不同来源;`ref-video` 与 `first-frame` 本身语义独立、单值基数互不占用。单测:`shared/__tests__/edge-validate.test.ts` + 渲染层 `__tests__/edge-dispatch.test.ts` + `providers/__tests__/h3c-command.test.ts`(新增)。
- **Qwen-Image-2.1 支持(2026-09;2026-09-28 补参考编辑并收敛为单一模型)**:一个模型、三种能力 ——
  **全量 bf16** `Qwen/Qwen-Image-2.1`(33GB,本机就地目录 `~/ai/models/Qwen-Image-2.1-bf16`)=
  **文生图 / latent img2img / `qwen21.edit` 参考编辑(1–10 张参考图 / 原生 RGBA / prefix KV cache)**。
  - ⚠️ **8bit 社区导出 `JoyFusionAI/Qwen-Image-2.1-MLX-8bit` 已移除**(2026-09-28):它只能文生图/latent,
    编辑链路要用 Qwen3-VL vision tower 编码参考图,而该导出是为纯文生图产的(text_encoder 仅 399 个
    语言侧张量、**0 个 `visual.*`**,且缺 per-component `config.json`,实测报
    `<dir>/vae/config.json is missing. ... needs a full checkpoint`)。留着只会让人踩「文生图选了 8bit、
    想编辑时编辑不了」的坑。bf16 实测 512²/20 步约 21 秒、质量够用。**短别名 `qwen-image-2.1`/`qwen-2.1`/
    `qwen-image-21` 现全部归一化到 bf16**(`MODEL_ALIASES`);老项目文件里的 8bit 仓库名仍在
    `BASE_MODEL_HINTS`/`LOCAL_MODEL_DIRS` 保留兼容(落到同一份 bf16),手工填 8bit 跑编辑走既有防呆报错。
  - **硬前置 = mlx-gen 含 `qwen21.edit` 的版本**(0.38.0 正式包**没有**:capabilities 只报
    `qwen21.text`/`qwen21.latent`,传参考图会被判成 latent i2i 并索要 `--image-strength`;引擎源码
    `~/ai/mlx-gen` 分支 `feat/qwen-image-2.1` 的**未提交工作区**(`src/mflux/models/qwen21/reference/` +
    `variants/edit/` + `cli/qwen21_edit_generate.py`)才有。本机已 `uv tool install --editable .` 装源码,
    旧版备份在 `~/.local/share/uv/tools/mlx-gen.bak-0.38.0`)。
  - Provider 侧(`packages/providers/src/mlxgen.ts`):`BASE_MODEL_HINTS` 补 `--base-model qwen-image-2.1`
    (仓库全名不在 catalog 里 → `ConfigResolution` 解析失败 → 落家族兜底 `qwen.generate`,与 2.1 的
    transformer/text encoder/VAE 完全不同,必炸;**bf16 本地目录也必须给**);`isQwen21EditModel()` 按
    checkpoint 而非模型族判定编辑能力(`latentOnly()` 早先把 `qwen-image-2.1` 正则一刀切判成纯文生图,
    会把 bf16 的编辑提交直接挡下);**步数判定按 `/qwen.*2\.1/i` 正则**(不能只匹配某个 repoId,
    否则 40 步默认会静默回落成 24)。
  - **2.1 编辑路由参数面(`submit()` 的 `isQwen21Edit` 分支)**:参考图走 **`--image-paths p1 p2 ...`**
    (`nargs='+'`,一次给多张),与 flux2/qwen-edit 的重复 `--image` 写法完全不同;input 连线图 +
    `ref-image` 连线合并进同一列表(order 即语义:首张锚定几何);**必须显式带 `--i2i-mode edit`** ——
    CLI 在「多张参考图」时会把模式自动推成 `multi-reference`,而 2.1 的能力行是 edit-reference,
    撞通用校验直接 exit 2(单张碰巧推对、**多参考必炸**,2026-09-28 真跑踩中);**禁用 `--image-strength`**;
    **输出必须 `.png/.webp/.tif/.tiff`**(RGBA 硬约束);`--scheduler` 只能 linear;**最少 2 步**;默认 40 步;
    超 10 张参考图提交前拦截。`instruction` 的**默认模型仍是 Qwen Image Edit**(存量行为不变)。
    单测 `packages/providers/src/__tests__/mlxgen.test.ts` 的「Qwen-Image-2.1 参考编辑」组。
  - 引擎源码在本机 `~/ai/mlx-gen`(分支 `feat/qwen-image-2.1`),安装避坑见
    `docs/mlxgen-图片引擎-安装与模型管理.md` §3;编辑能力总览见引擎仓 `docs/qwen-image-21-editing.md`
    / `docs/image-edit-modes.md`。**kv cache 默认开启**(CLI `--use-kv-cache` 默认 true),App 不传该参数、
    也不暴露开关 —— 实测开 27.8s vs 关 40.8s(20 步/512²)、输出无视觉差异,关掉纯亏速度。

- **引擎引导向导(4 步)**:`apps/desktop/src/renderer/src/pages/OnboardingPage.tsx`(入口:首页卡片 / 设置页 / `components/EnginePanel.tsx`)。步骤 1 探测走真实 `probeRuntimes()`;步骤 2 安装——**lmxgen 真执行** `uv tool install --upgrade mlx-gen`(`src/main/runtime-install.ts`,其余运行时只给手动提示;⚠️ LM Studio 那条 UI 是延迟显示「已安装」的假成功,未接真实安装);步骤 3 下载——**6 个图片模型全部真实可下**(`mlxgenModels`/`mlxgenDownload`/`mlxgenDownloadActive`,挂载即回填状态并恢复进行中的任务),h3 视频模型(144GB)与 LLM(Ornith)标注「手动」(本应用无下载通道,不假装能一键下);步骤 4 自检——**真实探测**(`src/main/selfcheck.ts` + IPC `run-selfcheck`):h3 `--info` 解析 checkpoint 清单 / mlxgen CLI+模型完整性 / LLM 真发带 `tools` 的 chat 请求 / 数据目录真写盘,四项独立判定、失败带可执行 hint、显示真实耗时。**轻量探测不加载大模型、不触发真实推理**(与 dry-run 无关,R2 不破)。⚠️ h3 `--info` 是清单表格式(`13 files 535 tensors`),别按 `.safetensors` 字样解析(会把就绪机器误报为未就绪);单测 `__tests__/selfcheck.test.ts`。
- **Provider 注册表**:`packages/providers/src/registry.ts` 是唯一选择渲染后端的地方。新增 Provider 实现 `Provider` 接口后注入 `createRegistry({ extra })`。
- **dry-run 默认开启**:`BIGBOTART_DRYRUN !== '0'` 时 h3c / mlxgen 只构造命令 + 占位结果,不真实推理。`mock` 永远真实(用 ffmpeg)。⚠️ 但根脚本 `pnpm dev` / `pnpm start` 已显式 `BIGBOTART_DRYRUN=0` = **真实跑**;`pnpm dev:dry` 才是 dry-run。真实跑的两层开关、前置条件与常见坑见 **AGENTS.md §0.5**。
- **Agent 子进程隔离**:`AgentManager.inline` 默认 false,worker 通过 `spawn(process.execPath, [worker.js])` 独立运行(pi 崩溃不污染主进程)。`inline=true` 仅供调试,直接走 `deterministicPlanner`。
- **LLM 优先级**(worker 内):远端 OpenAI 兼容端点(由 `BIGBOTART_LLM_BASE_URL` 触发)→ 本地 LM Studio(1234)→ 确定性模板兜底。`.env.example` 列出了 DeepSeek / GLM / Kimi / MiniMax 等可选项。
- **Agent 对话命令**:对话输入框支持斜杠命令 `/clear`(清空当前画布对话,移除 recall 与压缩摘要)与 `/compact`(把旧对话用 LLM 压成摘要写入 `canvasMemory.conversationSummary` 并裁剪 recall,保留最近 8 条;LLM 不可达时走确定性兜底摘要 `compactFallbackSummary`)。压缩摘要在 `buildContext` 里作为「本画布对话摘要(已压缩)」注入当前会话上下文。
- **Agent 对话上下文**:模型声明 `contextWindow = 100k`(`pi-chat.ts` / `pi-planner.ts`,32k 时代的 3 处已统一);单次对话工具往返上限 `MAX_TOOL_ROUNDS = 20`(参考原生 pi 生态 maxTurns≈50、按 100k 窗口等比例折算取保守值,见 `pi-chat.ts` 顶部注释)。注意本地小窗口模型(LM Studio)超窗会被远端拒绝。`buildContext` 注入「【当前画布】」实时状态段(节点 kind 统计 + 关键连线,`canvasStateSummary`);工具成功后的动作摘要写入 `role='system'` 的 recall,随最近消息注入下一轮(worker 转 `[系统记录]` user 消息,pi-ai 无原生 system 消息);recall 注入窗口(`RECALL_INJECT_LIMIT=12`,`memory.ts`)**只数 user/assistant/system 角色**——`role='tool'` 的机器记录仅供 UI 留痕回看、不占窗口(否则一轮「操作前必查」的工具调用就把用户原始指令挤出上下文;真实事故:「编辑图片让女孩站立」经一轮 ask.user 往返即丢失),连续重复的系统记录注入时合并为「… ×N」,且 `pinnedInstruction` 把任务链首条用户指令(最近一条非 ask.user 应答的 user 消息)兜底钉入 systemPrompt「【进行中的任务】」,掉出窗口也不丢目标;敏感操作确认闸(`pi-chat.ts`)**只拦 `canvas.delete_node`**(Agent 侧删除不进渲染层撤销栈,不可逆;授权签名 `approvedSensitive` 粘滞,同操作不二次拦截),submit/materialize/export 等可回退操作一律直达,模型逐字复述上一问题(确认死循环特征)会被驳回并督促执行;渲染层选中节点经 `AgentChatRequest.selectedNodeId` 附详情进本轮 user 消息(`describeSelectedNode` 顶部带「默认操作对象」指令:需要其产物时直接 `canvas.connect` 连为上游,禁止绕道 `assets.import` 另建资产节点;system prompt 另有【选中节点】规则同口径约束);关注节点在 UI 全程可确认——输入框有「关注:节点」chip(点按定位到节点),发出的用户气泡带 `◎ 关注` 徽标(`ChatMsg.contextNode`,recall 经 `RecallMessage.selectedNodeId/Title` 留痕,历史恢复后仍回显)。**称呼规则**:Agent 对用户说话一律用节点标题(system prompt【称呼规则】+ `canvas.list_nodes`/`get_node`/`describeSelectedNode` 返回均「标题」为主、id 仅作工具参数附在行尾),禁止把裸 id 写进回复正文或 ask.user 选项。⚠️ **副作用与兜底(2026-09-28)**:该排版让模型容易把**标题**当 nodeId 回传(实测 `canvas.get_node({"nodeId":"镜头 03"})` → 「节点 镜头 03 不存在」),白烧一整轮往返(单轮实测 78s),推高看门狗超时风险。故工具入口统一走 **`resolveNodeRef`/`resolveNodeRefOrError`**(`tool-handlers.ts` 纯函数):id 精确优先 → 标题**去空白后唯一**才采用 → 多个则报歧义并列候选 id(**不猜**)→ 都没有才报不存在;已接入 `canvas.get_node`/`canvas.connect`/`canvas.delete_node`。单测 `__tests__/node-ref.test.ts`(10 例)。
- **工具参数 `data` 必须容忍字符串化(2026-09-28 假成功事故)**:工具 schema 把 `data` 声明为 object,但本地小模型(Ornith 等)常把它**序列化成 JSON 字符串**再传(`{"nodeId":"new9-nhz9","data":"{\"prompt\":\"...\"}"}`)。旧 `canvas.update_node` 判 `typeof a.data === 'object'` → 字符串为 false → **整段 patch 被静默跳过却仍返回「✓ 已更新节点」**:模型写了几百字提示词、节点 prompt 长度实际为 0,直到 `engine.submit` 才在很远的地方炸 `h3: prompt must not be empty`。这是最恶劣的「报告成功但什么都没做」。修法:新增纯函数 **`normalizeDataArg`**(`tool-handlers.ts`)= 对象直通 / 字符串尝试 `JSON.parse`(必须是对象,数组与标量拒绝)/ **解析失败明确报错**,已接入 `canvas.update_node` 与 `canvas.create_node`(后者原本直接把 `a.data` 当对象用,传字符串会抛错或存脏数据);`update_node` 另加**写入后回读校验**——patch 里的键必须真的落进 `node.data`,否则返回失败(防「patch 没生效但照样 ✓」)。配套:`engine.submit` 前置拦截空 prompt(不再让 h3 退 1),system prompt 增【写节点参数的两个硬规矩】,工具 schema 的 `data` 描述补「不要用字符串包裹」。单测 `__tests__/normalize-data-arg.test.ts`(13 例)+ `__tests__/update-node-data.test.ts`(9 例,含事故形态回归与失败不留半成品)。
- **标题当 id 的容错已覆盖全部入口(2026-09-28 补全)**:`resolveNodeRef`/`resolveNodeRefOrError` 现接入 `canvas.get_node` / `canvas.connect` / `canvas.delete_node` / `canvas.update_node` / `engine.submit` / `vision.caption` / `frames.extract`(此前只接了 3 个,实测 vision.caption 与 frames.extract 仍因标题参数各白烧一轮)。
- **Agent 分段读文档**:`document.read` 工具按块读取 document/storyboard 节点全文(先读 chunk=0 看结构再逐段读);切块纯函数 `chunkText`/`chunkNav` 在 `packages/shared/src/document.ts`(默认 4000 字符/块、空行段落边界优先断块、返回 1-based 行范围)。
- **Agent 技能(指令模板)**:Skill 双形态 —— 画布模板(`nodes`/`edges`,`skills.apply` 克隆铺节点)+ **Agent 指令段**(`instructions`:Markdown 操作手册,说明如何用 `canvas.*`/`engine.*` 工具干活)。技能被「激活」后,指令经 `memory.buildContext` 作为「【当前技能】」段注入 systemPrompt(位置:①b 画布能力之后、核心记忆之前;`inject:'full'` 全量 / `'summary'` 只放摘要 + `skills.read` 按需取全文)。激活状态 = 画布级 `canvasMemory[canvasId].activeSkillId` 持久化,同一画布至多一个激活技能;工具 `skills.list/apply/save/read/activate/deactivate` 全量注入 worker 自动可用。能力设计见 `docs/Agent技能-指令模板与对话自动加载-产品设计与技术方案.md`,技能文档怎么写见 `docs/Agent技能文档-撰写指南与模板.md`(含纸拼贴/电商/科普三个现成示例,可直接落为内置技能)。
- **内置技能(官方精选)**:`apps/desktop/src/main/skills.ts` 的 `BUILTIN_SKILLS` = 3 个自研(纸拼贴/电商/科普,内联)+ 9 个 MiniMax 官方技能(H3 提示词写作规范 + 8 个场景生成器,源 github.com/MiniMax-AI/MiniMax-H3,已适配为 BigBotArt 工具流程;指令文档在 `apps/desktop/src/main/builtin-skills/*.md`,经 `?raw` 打进 main 包,大文件一律 `inject:'summary'`)。**种子合并机制**:空库首次启动 seed 全部内置;已有库每次启动按 id 合并「官方新增的内置技能」(已存在的内容不覆盖);用户删除内置技能会记入 `~/.bigbotart/skills-builtin-deleted.json`(tombstone),之后不再复活。改内置技能内容 = 改 `builtin-skills/*.md`,注意只对新装/缺失用户生效(已有库里的同 id 旧内容不会被覆盖)。单测:`src/main/__tests__/skills-seed.test.ts`。
- **画布持久化**:`ProjectStore` 用 JSON 文件 + `mkdirSync(BIGBOTART_HOME ?? ~/.bigbotart)`,接口已抽象,Electron 31 内置 Node 20 暂不支持 `node:sqlite`。**两个写入者协调**(2026-09 事故修复):Agent 工具(`canvas.*`/`storyboard.*`)在主进程增量写 `saveCanvasSnapshot`;**版本防护**——传入快照 `version` 落后于 store 当前版本(渲染层未同步)时拒绝整体覆盖(`{ok:false, stale, current}`,渲染层刷新后再存);**写盘广播**——`store.onCanvasSaved` → `canvas-snapshot-updated` 事件推送最新快照,渲染层 `CanvasPage` 据此同步本地(knownVersion + 内容基线比对,无变化不写盘,卸载/崩溃 flush 禁止空快照覆盖)。契约:`BigBotArtApi.saveCanvasSnapshot` 返回扩展 `stale`/`current`;新增 `onCanvasSnapshotUpdated`(preload 订阅)。
- **项目文件夹**:对话发给 Agent 的附件先拷入 `~/.bigbotart/projects/<projectId>/assets/`(`copyAttachmentsToProject`,按资产 id 幂等复用),Agent 一律使用项目内副本——项目自包含、可迁移;全局资产库在 `~/.bigbotart/assets/`。
- **项目级数据按工作空间收拢(2026-09-29)**:项目级数据从 `~/.bigbotart/` 下**平铺**改为**每个项目一个子目录**:`workspaces/<projectId>/{canvases,memory,takes,assets}.json`(原 `canvases-<pid>.json` / `memory-<pid>.json` / `takes-<pid>.json`,以及**项目资源从全局 assets.json 拆出**)。路径唯一事实来源是新模块 **`apps/desktop/src/main/workspace-paths.ts`**(store/memory/takes/assets 四处都从它取,不再各自拼字符串)。**用户可见概念仍叫「项目」**,`projects.json` 文件名与内部 `projects` 键名**都不改**——只做目录收拢,不做全仓库改名(`BigBotArtApi` 契约零改动)。
  - **资源:只拆元数据,不搬实体文件**。`AssetStore` 改为**读写分离**:内存仍是一份扁平数组(`list`/`get`/引用检查等全部调用点**零改动**),`readAll()` 在构造时合并「全局 `assets.json` + 各 `workspaces/<pid>/assets.json`」,`save()` 按 `projectId` 分流写回。**`Asset.localPath` 是绝对路径且不改写**,48+ 条实体文件仍在全局 `~/.bigbotart/assets/`。副作用(正面):**单个项目文件损坏只丢该项目的资源**,不再像单文件时代一旦 JSON 坏掉整个资产库不可读。搬实体文件要连带改 `bba-asset://` 协议白名单 + `importAllowRoots` + `export.ts` 白名单,属独立一步(与 `outputs/` 同口径)。
  - **迁移器 `apps/desktop/src/main/migrate.ts`**:`runDataMigration()` 在 **main/index.ts 中任何 Store 构造之前**调用(各 Store 构造函数就会读文件,晚于它会读到旧路径空容器)。五条不变量:①**幂等**(权威依据是 `.migration-ws-v1.json` 标记;**「workspaces/ 目录存在」不等于迁移完成**——上次可能中断在半途,故不据此直接 return,而是续跑补搬);②**先备份再移动**(被搬文件在 `backups-<YYYYMMDD>-ws-migrate/` 留副本,**全局 assets.json 也备份为 `(global).assets.before-split.json`**;备份失败则**中止资源拆分**——没有回滚依据的破坏性操作不做;总回滚 = 删 `workspaces/` + revert 代码,旧文件永不删,符合红线 R5);③**孤立 pid 一并迁移**(实测 6 个项目却有 19 个画布文件——已删项目的遗留文件靠扫目录取并集,不丢);④**不吞错**(单 pid 失败记 `failures` 继续做其余并写日志总线;目标已存在**拒绝覆盖**而非静默丢弃);⑤**续跑合并而非覆盖**(项目 assets.json 已存在时按 id 去重合并,不丢上次拆出的条目)。`.bak` / `.demo-bak-*` / `.pre-rescue-*` 等历史快照后缀一律跳过留在原地。全局 assets.json 若是**旧版裸数组**则不拆(交给 `AssetStore` 的 V1 迁移处理)。
  - ⚠️ **`outputs/` 与 assets/ 实体文件不在本次迁移内**:节点 `data.resultPath` 与 `asset.localPath` 存的是**绝对路径**(实测 30 个节点 resultPath 全指向 `outputs/`),搬迁会让历史产物全部失效。要动需独立的路径重写方案。
  - ⚠️ **改路径后必须补 `mkdirSync(dirname(f))`**:平铺时代只 `mkdirSync(DATA_DIR)` 就够,改子目录后不建目录直接 ENOENT。单测 `apps/desktop/src/main/__tests__/migrate.test.ts`(**20 例**:无损/幂等/备份/孤立 pid/拒绝覆盖/续跑/全新安装 + 资源拆分的拆分正确性/不重写 localPath/备份/无项目资源时不写盘/合并续跑/裸数组跳过)。
- **IPC 契约**:`BigBotArtApi`(`packages/shared/src/index.ts`)是主进程与渲染进程的类型化合同,preload 通过 `contextBridge` 暴露到 `window.bigbotart`。
- **加速 LoRA(h3.c 加速)**:h3.c CLI 不接受 `--lora`;「加速 LoRA」= 蒸馏模型包(设置页 `accelPacks`,`src/main/lora.ts` 管理)+ 4/8 步。镜头 `data.accel.enabled` 时,主进程 `submit-render` 把包 id 解析为 `params.modelDir`(-d)与 `params.steps`(包缺失 → 提交报错)。详见 `docs/MiniMax-H3-加速-LoRA-使用手册.md` §8。
- **视频增强(超分 + 合修脸)节点**:`video-upscale`(`apps/desktop/src/main/video-post.ts` + `~/ai/face-fix/video_post.py`,IPC `video-upscale` / `video-post-probe` / 推送 `video-post-progress`)。h3 出片后的**本地后处理**,对应 `/Users/jiangzhenguo/ai/h3/POST_PROCESSING.md`:① 去块(ffmpeg `deblock=filter=strong:block=4` + CRF 14,**必须在超分之前**,否则压缩块被放大成方格;⚠️ 文档 §5.4 的 `flat-strength=20` 在新版 ffmpeg(实测 8.0.1)已不存在,照抄会 `exit 8`——单测用本机 ffmpeg 真实解析该 filtergraph 防回归)→ ② 超分 → ③ 修脸。**不走渲染队列、不加载 h3 模型、与 dry-run 无关**,但属**分钟级长任务**,只由用户显式触发。
  - **引擎 = 统一 PyTorch 管线**(2026-09 由 ncnn 外部二进制切换):超分用 `basicsr.RealESRGANer`(MPS,fp32),修脸用 GFPGAN/CodeFormer,**同一 Python 进程只拆一次帧、只拼一次回**,省掉一轮完整编解码。`RealESRGANer` 在官方 basicsr 里没有,而 CodeFormer 那份 vendored 副本与官方 `ARCH_REGISTRY` 撞名(实测 `AssertionError: 'ResNetArcFace' was already registered`)→ 已 **vendored** 到 `~/ai/face-fix/realesrgan_utils.py`(就地实现 `get_device`,不挂 CodeFormer 进 `sys.path`)。
  - **权重必须用 `.pth`**:PyTorch 读不了 ncnn 的 `.bin/.param`;`RealESRGAN_x4plus.pth`(~64MB)在 `~/ai/weights/`。**模型短名 ≠ 权重文件名**(`realesrgan-x4plus` → `RealESRGAN_x4plus.pth`),映射表 `SR_WEIGHT_FILES` 有单测防回归。
  - `-s` 是**最终总倍数**:已开超分时超分器输出 scale 倍、修脸器 scale 固定 1,否则二次放大成 4x(换算在 `video_post.py` 内)。
  - GFPGAN 的 `FaceRestoreHelper(model_rootpath='gfpgan/weights')` 是**相对路径**,facexlib 按**进程 CWD** 解析 → 子进程 `cwd` 固定 `~/ai/GFPGAN`(否则本地已有权重也会联网重下 100MB+),脚本内再 `os.chdir` 兜底 + 从 `~/ai/weights/` 幂等补齐 facexlib 权重。
  - 进度:`video_post.py` 按 `PROGRESS <stage> <done> <total>` 上报,主进程解析后**按阶段耗时加权**换算成**跨阶段单调递增**的整体百分比(阶段内取峰值,防「拼回」把 96% 拽回 27%),经 `video-post-progress` 事件推送;节点卡与检查器都有进度条。并发保护:`videoPostRunningRef` 防重入 + 重跑按钮置灰。
  - 产物落 `outputs/video-post/`。Agent 侧:`canvas.create_node(kind='video-upscale')` 有默认参数,`engine.submit` 走 `runLocalImageNode` → `runVideoUpscale`(同步阻塞到出片),解析器 `resolveSingleVideoInput`/`resolveNodeVideoPath`。
  - 单测 `__tests__/video-post.test.ts`(**53 例**,含真实 PyTorch 端到端、进度单调性、权重名映射、ffmpeg filtergraph 真实解析)。
- **视频取帧(抽首/尾帧/指定时间点)**:`apps/desktop/src/main/frames.ts` 的 `extractFrame(videoPath, mode, seconds?)` —— `mode` 三态 `'first' | 'last' | 'at'`(统一类型 `FrameMode`),`'at'` 时 `seconds` 必填且为**非负有限数**(纯函数 `parseAtSeconds` 校验,`NaN`/负数/缺省一律拒绝)。ffmpeg 参数差异:首帧 `-i` 后取 1 帧;尾帧 `-sseof -0.2` 回退定位;**时间点 `-ss <秒>` 放在 `-i` 之前**(输入侧关键帧 seek,不重解码全片),`+ -frames:v 1`。产物落 `outputs/frames/<基名>-<mode|at-Ns>-<毫秒>.png`(时间点模式文件名带秒数);沿用白名单校验(`ffmpegReadRoots`+`isUnderRoot`,只允许产物/资产/导出目录)+ 全局串行链 `extractChain`(与 `cropImage` 共用,防多 ffmpeg 抢 CPU/IO)。**超出片长不静默产出空文件**:ffmpeg 可能退 0 但不出文件 → 显式报「第 Ns 处没有取到帧(可能超出视频时长)」。
  - **Agent 工具 `frames.extract`**(`tool-handlers.ts` frames 域,紧邻 `assets.import`):从视频抽一帧 → 导入资产库(`importFromPaths`,projectId 归属项目)→ **在画布新建一个 asset 资源节点**,返回 `nodeId` 可直接 `canvas.connect` 给下游(image-edit 的 `input` / shot 的 `first-frame`)。入参:`nodeId`(走 `resolveNodeVideoPath`,复用节点产物解析,含 asset 节点)或 `videoPath`(绝对路径,白名单在 frames.ts 内校验)二选一;`at` = `'first'`(默认)/ `'last'` / 数字(秒,也接受数字字符串);`label`/`x`/`y` 可选(默认落在**来源节点右侧** +300px,节点 `data.frameSource` 记录取帧来源便于回看)。节点无产物 / 来源缺失 / `at` 非法 / 超片长 **全部明确报错且不留半成品节点**(帧已抽出但入资产库失败时也返回失败并附帧文件名,不静默吞)。
  - IPC `extract-frame`(`main/index.ts`)与契约 `BigBotArtApi.extractFrame`(`packages/shared/src/index.ts`,`seconds?` 可选)三处同步;现有 3 处渲染层调用点(尾帧归档 / 镜头接续兜底 / image-edit 取帧源)**零改动**(不传 `seconds` 保持原行为)。
  - 单测:`__tests__/frames-crop.test.ts`(`parseAtSeconds` 纯函数 + `mode='at'` 真实 ffmpeg 集成,含超片长/负数/白名单回归)、`__tests__/frames-extract-tool.test.ts`(**13 例**:参数校验 / 真实抽帧建节点 / frameSource 落盘 / version 自增 / 失败不留半成品)。
- **Take 历史覆盖图片节点**:`Take.shotNodeId` 字段语义 = **节点 id**,shot 与 image-gen / image-edit / image-upscale / video-upscale / image-crop / image-stitch / image-split 统一记录(提交前 `takesCreate(queued)`,队列完成或本地快路径写终态;检查器可切换回看)。`image-crop` 是纯 ffmpeg 节点,不走渲染队列(`/crop-image` IPC,见 `apps/desktop/src/main/frames.ts`);`image-stitch` / `image-split` 同为纯 ffmpeg 节点(`/stitch-images` `/split-image` IPC,见 `apps/desktop/src/main/stitch.ts`:拼接 = ffprobe 量尺寸 + color 底版逐张 overlay;拆分 = split+crop 多输出,`planStitch`/`planSplit` 纯函数)。拆分多片下游取值:边 label `piece-N` 按序号取片(1-based,不选默认第 1 片),拼接入边 `piece` 是多值端口、按源节点画布位置排序。 Agent 侧图片节点提交参数由 `buildImageSubmitParams` 统一构造(与渲染层 runNode 同口径:kind 从节点类型/mode 推导——node.data 无 kind 字段,直传会被 Provider 缺省成 generate 丢输入图;image-edit/upscale 的 inputPath 从 input 连线解析,无连线明确报错),`canvas.create_node` kind 清单已含这三种节点,`engine.submit` 对它们**主进程同步执行**(不走队列,`tool-handlers.ts` `runLocalImageNode`:连线解析输入 → 调 frames/stitch 同函数 → 记 Take + 回写 resultPath/pieces + 落盘广播;纯函数解析器 `resolveNodeImagePath`/`resolveSingleImageInput`/`resolveStitchInputs` 与渲染层同口径,单测 `__tests__/tool-handlers-local-image.test.ts`)。**新增 `frame-grab`(视频裁切取帧,2026-09)**:纯 ffmpeg 节点,从视频截一帧 → 导入资产库 → 产物是**图片**;它是「视频 → 图片」的**唯一合法通道** —— `shot`/`video-upscale` 产物是 mp4,而图片编辑/增强的 `input` 要静帧。输入端口 `input-video`(单值,媒体要求 video),归入 `IMAGE_KINDS`;`engine.submit` 走 `runLocalImageNode`(复用 `extractFrame`),`resolveSingleVideoInput` 兼容 `input`/`input-video` 两种 label。
- **「视频不能直连图片编辑」+ 渲染层写边校验闸(2026-09 闪烁事故)**:根因是**两份权威表分叉** —— 渲染层 `connectors.ts` 的 `BY_KIND` 与 `packages/shared/src/connector-map.ts` 是手工维护的同构表,而渲染层**从不调用** shared 的 `validateEdge`(全目录只 grep 到一句注释),于是「shared 判定无可用端口」的边照样能建出来:典型 `video-upscale → image-edit`,`edge-dispatch` 又不认 VIDEO_KINDS(派生态什么都不写)、写盘广播把快照推回来 ⇒ 两边对同一条边期望相反 ⇒ 节点在「有输入图/无输入图」间反复翻 = **不停闪烁**。修法两条:①渲染层新增 **`guardEdge()`**(`connectors.ts`)作为写边前唯一校验闸,**直接调用 shared `validateEdge`** 而不是复制判断(复制=制造第三份表),接入 `commitConnectEdge`(拖拽连已有节点)与 `createFromPop`(「+」弹层建节点,校验放在 `setNodes` **之前**,避免留孤儿节点);单值端口冲突(`replaceable`)放行——那是「新边顶旧边」的正常交互。②语义收紧:`shot → image-edit` 从两张表里**移除**,视频必须先经 `frame-grab` 落成图片(转换点是**可见节点**,取代原先隐式的自动抽帧)。单测 `canvas/__tests__/connectors.test.ts`(39 例:弹层可见类型、非法边拦截、不误伤、单值冲突放行)+ `shared/__tests__/edge-validate.test.ts` 的 frame-grab 组(6 例)。
- **`SINGLE_VALUE_PORTS` 含 `input-video`**:`video-upscale`/`frame-grab` 的视频输入语义是单值(一个节点只能增强/取帧一路视频);漏登记会让两路视频同时连入而不报冲突(写单测时踩中并修正)。
- **Agent 提交必须带全 projectId/canvasId/takeId(2026-09-28 「生成成功但历史里什么都没有」事故)**:`RenderRequest` 的这三个可选字段(`packages/shared/src/provider.ts`)**缺一个就会静默丢归档**。事故形态:Agent 侧 `engine.submit`(`tool-handlers.ts`)只传 `provider/nodeId/slot/params/references`,于是队列完成时 `index.ts` 的 `queue.onJobFinish` **两个分支全落空**——`if (job.takeId && job.projectId) takes.patch(...) else if (job.projectId && ...) takes.append(...)`。后果分两层:**①** `takeId` 缺 → Take 从来没被创建,`takes-<projectId>.json` 里查不到该节点,检查器的 attempt 列表 / Take 切换 / `timeline.export`(优先读 `currentTakeId`)全空;**②** `projectId` 缺 → **连失败任务都不归档**,看门狗超时后完全无从回查(违反红线 R6)。实测:17:10 提交的任务 18:09 出片(864×480/124 帧/5.175s/h264+aac,产物完全有效),而 takes json 的最后写入时间比提交**还早**,节点上 `resultPath` 有值(`currentTakeId` 字段则完全不存在)——`resultPath` 是被渲染层队列事件旁路救回的,历史那一层永久断裂。**修法三处**:①`engine.submit` 提交前先 `this.takes.append(ctx.projectId, {shotNodeId, status:'queued', params})` 建 Take,再把 `projectId/canvasId/takeId` 一起传给 `queue.submit`(与渲染层 `runNode` 同口径,那里早就这么做了);②`queue.onJobFinish` 补 **else 兜底 `logger.log('warn', ...)`**——任务结局明确却缺 `projectId` 时立刻在日志总线暴露,让**未来任何新增提交方**漏传字段不再静默;③渲染层 `CanvasPage` 队列完成分支回写 `currentTakeId`(原实现只写 `resultPath`,故 Agent 发起的任务在检查器里「当前 Take」永远为空)。另注:`ctx.canvasId` 为空时 `engine.submit` 明确报「画布不存在」而不入队(无归属上下文本就不该提交,禁止静默)。单测 `__tests__/submit-take-archive.test.ts`(5 例:提交字段完整性 / queued Take 落盘 / 终态 patch / 失败归档可回查 / 无画布上下文明确失败)。
- **Agent 看图(反推提示词)**:**主对话 LLM 是纯文本的**——`pi-chat.ts` 声明 `input: ['text']`,图片像素从不进入主模型上下文,`describeSelectedNode` 也只把节点传成元数据文字。因此 Agent 无法自己「看图」,过去面对反推类需求会盲目建节点搪塞。解法是把看图拆成独立一步:工具 `vision.caption`(`apps/desktop/src/main/vision.ts`,单独端点解析 `resolveVisionEndpoint`)调**视觉模型端点**(LM Studio 的 VL 模型 / 任意 OpenAI 兼容多模态端点,`BIGBOTART_VL_*`,未配则回退主 LLM 端点再回退本地默认)把图片转成文字,再交回主 LLM 成稿;主链路 `pi-chat` 零改动、主模型无需具备视觉能力。入参 `nodeId`(走 `resolveNodeImagePath`,含 asset 节点)或 `assetId` 二选一,`style` = `prompt`(通用英文)/`zimage`(六段式中文)/`h3`(五段式)/`json`,非法值显式拒绝;**只读产物/资产/导出白名单目录**(与 `frames.ts` 同口径)防任意读。systemPrompt 新增【看图的唯一通道】段(`memory.ts`),明令看图类任务必须调本工具、**禁止凭空编造画面内容**、**禁止用建节点代替回答**。单测 `__tests__/vision-caption.test.ts`(24 例:端点回退 / 指令组装 / 请求体 / 白名单 / 错误面 / handler 集成,fetch 打桩不碰真模型)。
- **h3 参数组合防呆(validateParams,A+C)**:`packages/providers/src/h3c-command.ts` 的 **`validateParams`** 是提交前统一防呆入口(`h3c.ts` submit 调用;旧 `validateTier` 降为它的子规则)。三条规则:**①** `layers≤40 + reuse≥3` → 拒绝(易出鬼影/振铃,原有规则);**②** **带内嵌音轨的参考视频 + 输出时长 <2 秒 → 拒绝** —— 依据 h3 硬规则 `h3.c:1146`(truncate 分支 `max_samples = condition_frames × 32000 / H3_FPS < 64000` ⇒ 报 `video soundtrack N requires at least 2 seconds; request at least 56 output frames`)。**真实事故 2026-09**:`preview` 档只有 22 帧(≈0.92s),而 ref-video 端口现已全链路打通(asset/上游镜头/视频增强都可连),组合起来必炸,且报错发生在**入队之后**、英文文案看不出怎么改。拒绝文案给**两条可执行修法**:提到 ≥56 帧,或勾「忽略参考视频音轨」(`--ref-silent-video` 不走 truncate 分支,短时长合法);**③** `reuse≥2 + steps<8` → 警告(与 h3 自己的 `leaves very few fresh model evaluations` 同口径,提前到提交前告知)。导出 `MIN_SOUNDTRACK_SECONDS=2` / `MIN_SOUNDTRACK_FRAMES=56` / `H3_FPS=24` / `outputSeconds()`。**渲染层同口径预警**:`constants.ts` 复制同名常量 + `h3OutputSeconds()`(renderer 不 import providers——包边界),`ShotInspector` 在勾选框下方实时显示「⚠️ 参考视频带音轨时 h3 要求输出 ≥2 秒,当前 N 秒」,避免提交后才发现。⚠️ 常量是**复制品**,改一处要同步另一处(单测 `__tests__/soundtrack-duration.test.ts` 锁一致性)。单测另见 `providers/__tests__/h3c-command.test.ts`(含事故参数回归、48/47 帧边界、silent 绕法、seconds 优先)。
- **h3 真实进度条(A/B/C,2026-09)**:原进度是**时间估算**(`h3c.ts` 的 `elapsed/etaSec`,etaSec = 档位分钟数×面积系数×加速系数),与引擎实际进度无关 —— 会出现「爬到 99% 干等」「卡死却显示正常」两种假象(实测一个 864×480/8 步任务真跑 9 分钟、累计 CPU 仅 42 秒明显僵死,估算进度条却一路照爬)。**真实进度源**:h3 的进度回调写 **stderr**(不是 stdout!)**`fprintf(stderr, "\r%-25s %4d/%-4d", phase, completed, total)`**(`h3.c` 的 `main.c:168` / `h3_cli.c:122`),形如 `denoise 5/8`;phase 语义化(tokenizer / text encoder / Qwen vision / video VAE load / preview VAE load / audio VAE / audio VAE encoder / video VAE encoder / denoise / denoise enqueue / FFmpeg)。**最讽刺的一点**:这份数据一直从 stderr(始终 pipe)流经手里,却被当成「错误尾巴」塞进 `errAcc` 丢掉,而进度解析器却在消费 **stdout**(进度根本不在那)。新模块 `packages/providers/src/h3c-progress.ts`:**A** `parseProgressLine`/`splitProgressChunks`(纯函数,按 `\r`/`\n` 切、剥 ANSI、拒绝 `done>total` 等非法值);**B** `phaseWeightedProgress`(按 `H3_PHASE_WEIGHTS` 阶段权重加权成总进度,权重顺序即执行顺序,denoise 占大头 55)+ `ProgressTracker`(**单调不减** clamp,对齐 `video-post.ts` 既有做法);**C** `stallLevel`/`stallMessage`(120s→`suspect` 提示、300s→`likely-dead` 建议取消,**文案带「停在 denoise 5/8」**——停滞不动的阶段名就是最强诊断信号;无任何进度行时不误报,因为首跑加载权重/编译 Metal shader 可达 30 分钟)。⚠️ **`denoise enqueue` 与 `denoise` 是交错阶段**(`h3_dit.c:2674` 每步入队报 enqueue、`2781/2817/2850` 每步完成报 denoise),**不能线性排序也不能并桶**:并桶会算出低于 `denoise 8/8` 的值(纯函数无历史必然回退),故 `ProgressTracker.pushLine` 对交错阶段**只更新 stageText 与续期停滞计时、不参与进度计算**。`h3c.ts` 侧:stderr 边解析进度边保留非进度行做失败诊断(错误信息不丢),`status()` 优先返回真实进度与 `h3 · denoise 5/8` 阶段名,封顶 0.99(收尾无进度行),未解析到进度时用「已 N 分钟 · 可能在加载权重/编译 shader」的诚实说明而非编造百分比。**`RenderJob.progress`/`stage` 字段与 UI 零改动**(队列 2s 轮询 `provider.status()`,`ShotInspector.tsx:233` 直接渲染 `job.stage`)。单测 `providers/__tests__/h3c-progress.test.ts`(30 例,含按 h3 真实 `fprintf` 格式复刻的解析与交错单调性回归)。
- **写提示词走顶层 `prompt` 参数(B 方案,2026-09-28)**:`canvas.update_node` 新增**顶层字符串参数 `prompt`**(直接传原文),与旧的 `data.prompt` 并存但**顶层优先**,tool schema 描述里把 `data.prompt` 标注为「兼容但不推荐」。**为什么**:`data` 是 object,本地小模型倾向把整个对象**序列化成 JSON 字符串**再传,转义符放大输出量;叠加 thinking(常占输出预算一半以上)把 `maxTokens` 烧光 → JSON 被腰斩成非法值(实测 552 字符处断)→ 重试又截断 → 最终 0 工具调用 / 0 字回复。**顶层 string 参数没有「要不要序列化」的歧义空间**,直接消灭该根因;不额外占轮次(分段写要 2-3 轮,而实测 prompt 仅 250–323 字符≈400–520 token 根本不大,病灶是序列化+thinking 而非内容体量,故**不做**分段累积方案)。实现:`tool-handlers.ts` 的 `patch = {...norm.data, ...(顶层 prompt)}`,复用既有「写入后回读校验」;`prompt` 传非字符串明确报错。配套:`memory.ts` 的【写提示词与节点参数的规矩】重写(明确「写提示词一律用顶层 prompt」+ 截断时的拆写建议),`pi-chat.ts` 的 **`maxTokens` 12000 → 32000**(实测依据:LM Studio `loaded_context_length = 262144`,且 `max_tokens: 20000/32000` 均被接受;可用 `BIGBOTART_AGENT_MAX_TOKENS` / `BIGBOTART_AGENT_CONTEXT_WINDOW` 覆盖)。单测 `__tests__/update-node-data.test.ts`(16 例,含顶层优先、非字符串报错、多行特殊字符、旧写法兼容、与标题容错叠加)。
- **模型输出截断(stop=length)必须显式告知(2026-09-28 「假成功」事故)**:`pi-chat.ts` 的 `calls.length === 0` 分支原本对 `assistant.stopReason === 'length'` **毫无处理** —— 若本轮没发出工具调用,就把可能为空的 `reply` 当作正常结果返回,用户看到**静默的 0 字回复**;若有半句话,则被当成完整交付。这是「假成功」,与批次1 修的「假失败」是同一类问题的镜像。**真实事故**:用户「将3d人物转化成真人的视频」,模型把含几千字 prompt 的 `data` **序列化成 JSON 字符串**输出时烧光 `maxTokens: 12000`,JSON 在 552 字符处断成非法值(被 `normalizeDataArg` 当场拦下);下一轮重试时 thinking 又用尽 token,**连工具调用都没发出** → 日志 `round=3 stop=length blocks=thinking calls=(none)` + `回复 0 字`,整轮被判成功。修法:新增纯函数 **`composeTruncatedReply`**(导出供单测)= 无文本 → 完整解释 + 可执行建议(指出「一次写入太长」这个最常见原因、建议拆分多轮);有部分文本 → **保留内容**但追加「内容可能不完整」标注。单测 `__tests__/truncated-reply.test.ts`(6 例)。⚠️ **根因提示**:模型倾向把 `data` 序列化成字符串是 `maxTokens` 被烧光的主因之一,`normalizeDataArg` 只能兜底不能治本;遇到反复重试可考虑拆分写入或调大输出预算。
- **Agent 长任务任务化(批次1)**:chat 不再「一次请求 await 到底」。`agent-chat` 收到请求即返回 `{ok:true, accepted:true}`,真正结果经 `AgentEvent` 的 **`done`/`failed`** 终局事件推送(渲染层 `useAgentChat` 的 `settleChat` 收尾,`ask`/`aborted` 作为 `final` 的字段照旧携带)。动机:反推提示词实测 11 轮/249 秒,撞穿 manager 的**固定 5 分钟总超时**后整轮报「agent 无响应」,而任务其实已成功(提示词早已写进节点)——**假失败**比真失败更糟。配套三改:**①静默看门狗**(`manager.ts` 的 `SILENT_TIMEOUT_MS`,`BIGBOTART_AGENT_SILENT_TIMEOUT_MS`,**默认 600s**,2026-09 由 180s 调大)——worker 发 `heartbeat` 给主进程续期,**静默**够久才判失败。心跳有两处:`PiChatSession.onRound`(轮首一次)+ **`onTick` 轮内定时心跳**(`LLM_HEARTBEAT_MS`,`BIGBOTART_AGENT_HEARTBEAT_MS`,默认 15s;只包住 LLM 调用,`finally` 清定时器)。⚠️ **调大默认值的实测依据**:本机 35B 本地模型**单轮**真实规模请求(30 工具定义 + 13 节点画布状态 + 历史 ≈ 75KB,thinking + maxTokens 12000)耗时 **78 秒**,连「你好」都要 30 秒;原 180s 阈值配合「心跳仅轮首一次」会在多步任务正常推进中判死 → **假失败**(2026-09-28 主画布对话实测踩中,模型没崩、worker 存活 `STAT S`,纯属被误杀)。轮内心跳把最长无信号间隔压到 15s 级,阈值从此主要防「worker 真死」而非贴着单轮耗时设。**②失败带已完成摘要**(`toolActivity` 按画布归集成功的 `tool-end`,失败文案附「已完成 N 个操作…画布改动已生效」)。**③`handleToolCall` 兜住工具异常**——此前工具一抛异常就不回写结果,worker 侧 `pendingTools` 永远等不到 resolve → 整个对话挂起,表现为看门狗超时且真因全丢(排查时极易误判成心跳失效);现转为 worker 可见的失败结果。⚠️ 自建 `toolExecutor` 时必须返回 `ToolCallResponse`(**含 `id`**),只返回工具结果会让 worker 永久等待。
- **画布视口持久化**:`CanvasSnapshot.viewport?`(`{x,y,z}`,`packages/shared/src/domain.ts`)记录每张画布的平移/缩放,退出应用或切画布后重进恢复上次视角。渲染层 `buildActiveSnapshot` 把 `viewRef` 写进快照;`maybePersist` 在**内容没变但视口变了**时也写盘;视口改动 400ms 防抖落盘(与内容 800ms 防抖分开),切画布(`flushSaveNow`)/离开页面(卸载 flush)强制落盘。旧项目文件缺 `viewport` → `normalizeView` 回退默认视图(`{x:20,y:10,z:0.86}`,缩放钳制 0.4–1.3)。
- **画布撤销/重做**:`apps/desktop/src/renderer/src/pages/canvas/canvas-history.ts` 的 `HistoryStack`(单测 `__tests__/canvas-history.test.ts`)。历史内容 = 节点 + 连线 + **分组**(不含 viewport);`commitEdit(label)` 必须在对应 `setNodes/setEdges` **之前**调用(此刻 ref 里还是编辑前内容 = 撤销目标),覆盖拖动结束、建删节点/连线、检查器改参、分镜表铺节点、换绑资产等离散动作;内部用 `structureSig`(忽略 w/h、badge/flash/stale/ghost,与数组顺序无关,但**分组计入签名**,故「只改分组」也算一次真实编辑)去重 → 拖动过程与测量抖动不产生历史;上限 60 条。撤销/重做走 `beginReplay` → `setNodes/setEdges` → 两帧后 `endReplay` 建立新基线,回放期间提交被闸门忽略。画布加载与 Agent 工具写盘推送(`applyCanvasSnapshot` 内容变化)会清空历史换基线。工具栏按钮按 `canUndo/canRedo` 置灰,快捷键 ⌘Z / ⌘⇧Z(⌘Y),输入框内不抢系统文本撤销。
- **画布框选 / 多选 / 分组**:选中态是 `selectedIds: string[]`(CanvasPage),单选派生 `selected = length===1 ? [0] : null`,保持下游(检查器 / Agent 关注节点 / `deleteNode` / `duplicateNode`)零改动。**「框选」是模式开关**(工具栏 `marqueeMode`):开 = 拖空白框选、关 = 拖空白平移(原行为);**中键拖动 / 空格+拖动永远平移**(`spaceDownRef`,失焦清空格状态)。框选矩形在 world 坐标系计算与渲染(`selectionRect` state + `selRectRef` 每帧几何),与矩形**相交即选中**、未测量高度按兜底参与命中、**边缘相切算未选中**、零面积按点命中;Shift 框选 = 并入现有选区、Shift 点节点 = 切换选中(不启动拖动)。纯函数集中 `canvas/selection.ts`(`rectFromPoints`/`nodesInRect`/`boundingRect`/`expandSelectionToGroups`/`pruneGroups`/`normalizeGroups`/`clientPointOf`,单测 `__tests__/selection.test.ts` 43 例)。**两条事件硬约束(2026-09 事故:框选矩形画得出来却一个节点都选不中,「建组」因此常灰)**:①指针坐标必须**当场**用 `clientPointOf(e)` 取出 —— React 合成事件在处理器返回后被回收,把 `e` 存进 ref、下一帧再读 `clientX` 只会得到 `undefined → NaN 矩形`;起止点以屏幕坐标存进 `selRectRef`,计算时统一 `screenToWorld`。②**选区清空只能写在 pointerdown / pointerup,不能写在 `onClick`** —— 事件顺序是 pointerdown→pointerup→click,框选在 pointerup 结束,在 click 里清选区会把刚框出的选区当场清掉;现约定:点空白(node/world 的 pointerdown,含 `[data-node]/.gname/弹层/框选矩形` 命中检测)清空、框选结束按矩形重算、`onStageClick` 只关弹层、组框自身 `stopPropagation`。**分组(`CanvasNodeGroup`)独立挂在 `CanvasSnapshot.groups`**,不写进节点(单点真源 = `members`;一个节点至多属一组,建组时自动从旧组摘除),删节点后必须 `pruneGroups` 清脏 id。组内任一节点参与拖动 → `expandSelectionToGroups` **整组一起动**;组框画在节点下方(`z-index:0`,只有组名可点)。快捷键 ⌘A 全选 / ⌘G 建组 / ⌘⇧G 解组 / Esc 取消框选(不清选区)。`buildActiveSnapshot`、内容基线 `lastSavedRef`、`maybePersist` 比对、`HistoryContent` 均已纳入 `groups`(否则「仅改分组」不写盘、不可撤销);旧项目文件缺 `groups` → 空数组照常打开。多选拖动**必须在按下时冻结各节点起点坐标**(`dragRef.origins`),禁止在 setState updater 里做累加增量(StrictMode 双跑会翻倍,见 AGENTS.md §5.1)。
- **界面 i18n(中/英)**:`apps/desktop/src/renderer/src/i18n/index.tsx`(`I18nProvider` + `useT()` + 非 hook 的 `translate`)。字典**以中文原文为 key**(zh-CN 原样返回;en 查 `i18n/en/*.ts` 按页合并的字典,缺译回退中文),插值用 `{var}` 占位:`t('已导入 {n} 项资源', { n })`。语言持久化在 `AppSettings.language`(settings.json),设置页「通用 › 语言」切换即写盘,App 启动回填。**新写 UI 文案一律包 `t()`**;v1 已覆盖 home/assets/skills/projects/settings 与全局 chrome(页面名/返回),canvas/agent/timeline 深区文案仍是中文,增量补字典即可。注意:字典中含空格/全角标点的中文 key 必须加引号,否则 esbuild 报语法错。
- **公共页面顶栏**:`components/PageTopBar.tsx`(返回 + 面包屑 + 动作区,样式来自各页 `.topbar` 作用域 CSS);返回走 App 导航栈(`navStackRef`,`handleNavigate` 压栈、详情页 `onBack` 出栈回来源页),不要再写死返回目标。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BIGBOTART_HOME` | `~/.bigbotart` | 项目/画布数据目录 |
| `BIGBOTART_DRYRUN=0` | `1` | 关闭 dry-run,真实调用 h3.c / mlxgen(需模型就绪) |
| `BIGBOTART_H3_OUTPUTS` | `.bigbotart/outputs` | h3 输出目录 |
| `BIGBOTART_MOCK_OUTPUTS` | `.bigbotart/outputs/mock` | mock 输出目录 |
| `BIGBOTART_MLXGEN_OUTPUTS` | `~/.bigbotart/outputs/images` | mlxgen 图片产物目录 |
| `BIGBOTART_MS_DOWNLOAD` | `1` | 设 `0` 时模型下载不走 ModelScope 直连,强制回退 HF(`mlxgen download`) |
| `BIGBOTART_MODELS_DIR` | `~/ai/models` | 本地模型目录根:该目录下已就绪的模型(如 `Qwen-Image-2.1-bf16`、`flux2-klein-9b-8bit`)直接当 `--model` 用,免下载 |
| `BIGBOTART_VIDEO_POST_SCRIPT` | `~/ai/face-fix/video_post.py` | 视频增强统一后处理脚本(超分 + 修脸,同一 Python 进程) |
| `BIGBOTART_SUPERRES_PYTHON` | `~/venvs/superres/bin/python` | 后处理 Python(torch/facexlib/basicsr/gfpgan) |
| `BIGBOTART_GFPGAN_ROOT` | `~/ai/GFPGAN` | GFPGAN 仓库根,**同时作为子进程 cwd**(facexlib 相对权重目录解析依赖它) |
| `BIGBOTART_CODEFORMER_ROOT` | `~/ai/CodeFormer` | 仅取 facelib;其 vendored basicsr 与官方撞注册名,不进 `sys.path` |
| `BIGBOTART_WEIGHTS_DIR` | `~/ai/weights` | 权重目录(`RealESRGAN_x4plus.pth` / GFPGANv1.4.pth / codeformer.pth / facexlib 检测权重) |
| `BIGBOTART_LLM_BASE_URL` | — | 远端 OpenAI 兼容端点,设了优先用 |
| `BIGBOTART_LLM_API_KEY` | — | 远端 API key |
| `BIGBOTART_LLM_MODEL` | `deepseek-chat` | 远端模型 |
| `BIGBOTART_LMSTUDIO_URL` | `http://127.0.0.1:1234/v1` | 本地 LM Studio |
| `BIGBOTART_LMSTUDIO_MODEL` | `ornith-1.5-35b-a3b-abliterated-mlx` | LM Studio 模型 |
| `BIGBOTART_VL_BASE_URL` | 回退 `BIGBOTART_LLM_BASE_URL` → `http://127.0.0.1:1234/v1` | **视觉端点**(Agent `vision.caption` 看图反推用) |
| `BIGBOTART_VL_MODEL` | `qwen3-vl-8b-nsfw-caption-v4.5-affine` | 视觉模型名 |
| `BIGBOTART_VL_API_KEY` | 回退 `BIGBOTART_LLM_API_KEY` | 视觉端点 key |
| `BIGBOTART_AGENT_SILENT_TIMEOUT_MS` | `600000` | Agent chat **静默**看门狗(ms):连续这么久无心跳才判失败。2026-09 由 180000 调大(单轮实测 78s,180s 会误杀多步任务) |
| `BIGBOTART_AGENT_HEARTBEAT_MS` | `15000` | 轮内**心跳**间隔(ms):worker 等待 LLM 返回期间按此周期报活,把最长无信号间隔压到秒级 |
| `BIGBOTART_AGENT_MAX_TOKENS` | `32000` | Agent 单轮**输出**预算(tokens)。2026-09-28 由硬编码 12000 调大并改为可配(本地 35B 实测 256K 上下文、20000/32000 均被接受);太小会导致长提示词被截断成半截 JSON |
| `BIGBOTART_AGENT_CONTEXT_WINDOW` | `100000` | 声明给框架的模型上下文窗口(实际由端点决定) |

## 文档入口

- **AI 代理强制规范:`AGENTS.md`(红线/联动修改清单/验证纪律,动手前先读)**
- 人类协作者 AI 使用规范:`docs/AI使用规范.md`
- 产品 PRD:`PRD-BigBotArt-无限画布视频图片生成Agent.md`
- 调研报告:`docs/调研报告-MiniMaxDesign与本地模型接入方案.md`
- 用户入口文档:`README.md`
