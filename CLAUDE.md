# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

BigBotArt — 无限画布的视频/图片生成 Agent(跨端桌面 App,本地优先)。
基于 Electron 31 + React 18,画布为自研无限画布(DOM 节点 + SVG 连线 + 原生 CSS transform,**未使用 React Flow**),对接本地部署的 h3.c 视频引擎与 MLX 图片生成/编辑引擎。
当前处于 M1 骨架期:h3.c / mlxgen 默认 dry-run,不真实推理。

## 常用命令

```bash
pnpm install                          # 安装依赖(workspace + electron 二进制)
pnpm dev                              # 真实跑(根脚本显式 BIGBOTART_DRYRUN=0,细则见 AGENTS.md §0.5)
pnpm dev:dry                          # 开发/排障 dry-run(安全默认,不碰真模型)
pnpm build                            # 构建产物(electron-vite build)
pnpm start                            # electron-vite preview(运行已构建产物)
pnpm build:packages                   # 单独构建 packages/*
pnpm typecheck                        # 全 workspace tsc --noEmit
pnpm test                             # vitest 单测/集成(200+ 用例 · 见 docs/测试用例-图片节点与裁切.md)
pnpm --filter @bigbotart/desktop typecheck  # 单包类型检查
```

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

- **Provider 注册表**:`packages/providers/src/registry.ts` 是唯一选择渲染后端的地方。新增 Provider 实现 `Provider` 接口后注入 `createRegistry({ extra })`。
- **dry-run 默认开启**:`BIGBOTART_DRYRUN !== '0'` 时 h3c / mlxgen 只构造命令 + 占位结果,不真实推理。`mock` 永远真实(用 ffmpeg)。⚠️ 但根脚本 `pnpm dev` / `pnpm start` 已显式 `BIGBOTART_DRYRUN=0` = **真实跑**;`pnpm dev:dry` 才是 dry-run。真实跑的两层开关、前置条件与常见坑见 **AGENTS.md §0.5**。
- **Agent 子进程隔离**:`AgentManager.inline` 默认 false,worker 通过 `spawn(process.execPath, [worker.js])` 独立运行(pi 崩溃不污染主进程)。`inline=true` 仅供调试,直接走 `deterministicPlanner`。
- **LLM 优先级**(worker 内):远端 OpenAI 兼容端点(由 `BIGBOTART_LLM_BASE_URL` 触发)→ 本地 LM Studio(1234)→ 确定性模板兜底。`.env.example` 列出了 DeepSeek / GLM / Kimi / MiniMax 等可选项。
- **Agent 对话命令**:对话输入框支持斜杠命令 `/clear`(清空当前画布对话,移除 recall 与压缩摘要)与 `/compact`(把旧对话用 LLM 压成摘要写入 `canvasMemory.conversationSummary` 并裁剪 recall,保留最近 8 条;LLM 不可达时走确定性兜底摘要 `compactFallbackSummary`)。压缩摘要在 `buildContext` 里作为「本画布对话摘要(已压缩)」注入当前会话上下文。
- **Agent 对话上下文**:模型声明 `contextWindow = 100k`(`pi-chat.ts` / `pi-planner.ts`,32k 时代的 3 处已统一);单次对话工具往返上限 `MAX_TOOL_ROUNDS = 20`(参考原生 pi 生态 maxTurns≈50、按 100k 窗口等比例折算取保守值,见 `pi-chat.ts` 顶部注释)。注意本地小窗口模型(LM Studio)超窗会被远端拒绝。`buildContext` 注入「【当前画布】」实时状态段(节点 kind 统计 + 关键连线,`canvasStateSummary`);工具成功后的动作摘要写入 `role='system'` 的 recall,随最近消息注入下一轮(worker 转 `[系统记录]` user 消息,pi-ai 无原生 system 消息);recall 注入窗口(`RECALL_INJECT_LIMIT=12`,`memory.ts`)**只数 user/assistant/system 角色**——`role='tool'` 的机器记录仅供 UI 留痕回看、不占窗口(否则一轮「操作前必查」的工具调用就把用户原始指令挤出上下文;真实事故:「编辑图片让女孩站立」经一轮 ask.user 往返即丢失),连续重复的系统记录注入时合并为「… ×N」,且 `pinnedInstruction` 把任务链首条用户指令(最近一条非 ask.user 应答的 user 消息)兜底钉入 systemPrompt「【进行中的任务】」,掉出窗口也不丢目标;渲染层选中节点经 `AgentChatRequest.selectedNodeId` 附详情进本轮 user 消息(`describeSelectedNode` 顶部带「默认操作对象」指令:需要其产物时直接 `canvas.connect` 连为上游,禁止绕道 `assets.import` 另建资产节点;system prompt 另有【选中节点】规则同口径约束);关注节点在 UI 全程可确认——输入框有「关注:节点」chip(点按定位到节点),发出的用户气泡带 `◎ 关注` 徽标(`ChatMsg.contextNode`,recall 经 `RecallMessage.selectedNodeId/Title` 留痕,历史恢复后仍回显)。**称呼规则**:Agent 对用户说话一律用节点标题(system prompt【称呼规则】+ `canvas.list_nodes`/`get_node`/`describeSelectedNode` 返回均「标题」为主、id 仅作工具参数附在行尾),禁止把裸 id 写进回复正文或 ask.user 选项。
- **Agent 分段读文档**:`document.read` 工具按块读取 document/storyboard 节点全文(先读 chunk=0 看结构再逐段读);切块纯函数 `chunkText`/`chunkNav` 在 `packages/shared/src/document.ts`(默认 4000 字符/块、空行段落边界优先断块、返回 1-based 行范围)。
- **Agent 技能(指令模板)**:Skill 双形态 —— 画布模板(`nodes`/`edges`,`skills.apply` 克隆铺节点)+ **Agent 指令段**(`instructions`:Markdown 操作手册,说明如何用 `canvas.*`/`engine.*` 工具干活)。技能被「激活」后,指令经 `memory.buildContext` 作为「【当前技能】」段注入 systemPrompt(位置:①b 画布能力之后、核心记忆之前;`inject:'full'` 全量 / `'summary'` 只放摘要 + `skills.read` 按需取全文)。激活状态 = 画布级 `canvasMemory[canvasId].activeSkillId` 持久化,同一画布至多一个激活技能;工具 `skills.list/apply/save/read/activate/deactivate` 全量注入 worker 自动可用。能力设计见 `docs/Agent技能-指令模板与对话自动加载-产品设计与技术方案.md`,技能文档怎么写见 `docs/Agent技能文档-撰写指南与模板.md`(含纸拼贴/电商/科普三个现成示例,可直接落为内置技能)。
- **内置技能(官方精选)**:`apps/desktop/src/main/skills.ts` 的 `BUILTIN_SKILLS` = 3 个自研(纸拼贴/电商/科普,内联)+ 9 个 MiniMax 官方技能(H3 提示词写作规范 + 8 个场景生成器,源 github.com/MiniMax-AI/MiniMax-H3,已适配为 BigBotArt 工具流程;指令文档在 `apps/desktop/src/main/builtin-skills/*.md`,经 `?raw` 打进 main 包,大文件一律 `inject:'summary'`)。**种子合并机制**:空库首次启动 seed 全部内置;已有库每次启动按 id 合并「官方新增的内置技能」(已存在的内容不覆盖);用户删除内置技能会记入 `~/.bigbotart/skills-builtin-deleted.json`(tombstone),之后不再复活。改内置技能内容 = 改 `builtin-skills/*.md`,注意只对新装/缺失用户生效(已有库里的同 id 旧内容不会被覆盖)。单测:`src/main/__tests__/skills-seed.test.ts`。
- **画布持久化**:`ProjectStore` 用 JSON 文件 + `mkdirSync(BIGBOTART_HOME ?? ~/.bigbotart)`,接口已抽象,Electron 31 内置 Node 20 暂不支持 `node:sqlite`。**两个写入者协调**(2026-09 事故修复):Agent 工具(`canvas.*`/`storyboard.*`)在主进程增量写 `saveCanvasSnapshot`;**版本防护**——传入快照 `version` 落后于 store 当前版本(渲染层未同步)时拒绝整体覆盖(`{ok:false, stale, current}`,渲染层刷新后再存);**写盘广播**——`store.onCanvasSaved` → `canvas-snapshot-updated` 事件推送最新快照,渲染层 `CanvasPage` 据此同步本地(knownVersion + 内容基线比对,无变化不写盘,卸载/崩溃 flush 禁止空快照覆盖)。契约:`BigBotArtApi.saveCanvasSnapshot` 返回扩展 `stale`/`current`;新增 `onCanvasSnapshotUpdated`(preload 订阅)。
- **项目文件夹**:对话发给 Agent 的附件先拷入 `~/.bigbotart/projects/<projectId>/assets/`(`copyAttachmentsToProject`,按资产 id 幂等复用),Agent 一律使用项目内副本——项目自包含、可迁移;全局资产库在 `~/.bigbotart/assets/`。
- **IPC 契约**:`BigBotArtApi`(`packages/shared/src/index.ts`)是主进程与渲染进程的类型化合同,preload 通过 `contextBridge` 暴露到 `window.bigbotart`。
- **加速 LoRA(h3.c 加速)**:h3.c CLI 不接受 `--lora`;「加速 LoRA」= 蒸馏模型包(设置页 `accelPacks`,`src/main/lora.ts` 管理)+ 4/8 步。镜头 `data.accel.enabled` 时,主进程 `submit-render` 把包 id 解析为 `params.modelDir`(-d)与 `params.steps`(包缺失 → 提交报错)。详见 `docs/MiniMax-H3-加速-LoRA-使用手册.md` §8。
- **Take 历史覆盖图片节点**:`Take.shotNodeId` 字段语义 = **节点 id**,shot 与 image-gen / image-edit / image-upscale / image-crop / image-stitch / image-split 统一记录(提交前 `takesCreate(queued)`,队列完成或裁切快路径写终态;检查器可切换回看)。`image-crop` 是纯 ffmpeg 节点,不走渲染队列(`/crop-image` IPC,见 `apps/desktop/src/main/frames.ts`);`image-stitch` / `image-split` 同为纯 ffmpeg 节点(`/stitch-images` `/split-image` IPC,见 `apps/desktop/src/main/stitch.ts`:拼接 = ffprobe 量尺寸 + color 底版逐张 overlay;拆分 = split+crop 多输出,`planStitch`/`planSplit` 纯函数)。拆分多片下游取值:边 label `piece-N` 按序号取片(1-based,不选默认第 1 片),拼接入边 `piece` 是多值端口、按源节点画布位置排序。 Agent 侧:`canvas.create_node` kind 清单已含这三种节点,`engine.submit` 对它们**主进程同步执行**(不走队列,`tool-handlers.ts` `runLocalImageNode`:连线解析输入 → 调 frames/stitch 同函数 → 记 Take + 回写 resultPath/pieces + 落盘广播;纯函数解析器 `resolveNodeImagePath`/`resolveSingleImageInput`/`resolveStitchInputs` 与渲染层同口径,单测 `__tests__/tool-handlers-local-image.test.ts`)。
- **画布视口持久化**:`CanvasSnapshot.viewport?`(`{x,y,z}`,`packages/shared/src/domain.ts`)记录每张画布的平移/缩放,退出应用或切画布后重进恢复上次视角。渲染层 `buildActiveSnapshot` 把 `viewRef` 写进快照;`maybePersist` 在**内容没变但视口变了**时也写盘;视口改动 400ms 防抖落盘(与内容 800ms 防抖分开),切画布(`flushSaveNow`)/离开页面(卸载 flush)强制落盘。旧项目文件缺 `viewport` → `normalizeView` 回退默认视图(`{x:20,y:10,z:0.86}`,缩放钳制 0.4–1.3)。
- **画布撤销/重做**:`apps/desktop/src/renderer/src/pages/canvas/canvas-history.ts` 的 `HistoryStack`(单测 `__tests__/canvas-history.test.ts`)。历史内容 = 节点 + 连线(**不含 viewport**);`commitEdit(label)` 必须在对应 `setNodes/setEdges` **之前**调用(此刻 ref 里还是编辑前内容 = 撤销目标),覆盖拖动结束、建删节点/连线、检查器改参、分镜表铺节点、换绑资产等离散动作;内部用 `structureSig`(忽略 w/h、badge/flash/stale/ghost,与数组顺序无关)去重 → 拖动过程与测量抖动不产生历史;上限 60 条。撤销/重做走 `beginReplay` → `setNodes/setEdges` → 两帧后 `endReplay` 建立新基线,回放期间提交被闸门忽略。画布加载与 Agent 工具写盘推送(`applyCanvasSnapshot` 内容变化)会清空历史换基线。工具栏按钮按 `canUndo/canRedo` 置灰,快捷键 ⌘Z / ⌘⇧Z(⌘Y),输入框内不抢系统文本撤销。
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
| `BIGBOTART_LLM_BASE_URL` | — | 远端 OpenAI 兼容端点,设了优先用 |
| `BIGBOTART_LLM_API_KEY` | — | 远端 API key |
| `BIGBOTART_LLM_MODEL` | `deepseek-chat` | 远端模型 |
| `BIGBOTART_LMSTUDIO_URL` | `http://127.0.0.1:1234/v1` | 本地 LM Studio |
| `BIGBOTART_LMSTUDIO_MODEL` | `ornith-1.5-35b-a3b-abliterated-mlx` | LM Studio 模型 |

## 文档入口

- **AI 代理强制规范:`AGENTS.md`(红线/联动修改清单/验证纪律,动手前先读)**
- 人类协作者 AI 使用规范:`docs/AI使用规范.md`
- 产品 PRD:`PRD-BigBotArt-无限画布视频图片生成Agent.md`
- 调研报告:`docs/调研报告-MiniMaxDesign与本地模型接入方案.md`
- 用户入口文档:`README.md`
