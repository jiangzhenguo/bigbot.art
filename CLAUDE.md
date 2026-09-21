# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

BigBotArt — 无限画布的视频/图片生成 Agent(跨端桌面 App,本地优先)。
基于 Electron 31 + React 18 + React Flow 12,对接本地部署的 h3.c 视频引擎与 MLX 图片生成/编辑引擎。
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
pnpm test                             # vitest 单测/集成(70 用例 · 见 docs/测试用例-图片节点与裁切.md)
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
  - `src/renderer/src/App.tsx` — 三栏布局(节点库侧栏 + React Flow 无限画布 + Agent 控制台),首次启动建默认项目并探测引擎
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
- **Agent 对话上下文**:模型声明 `contextWindow = 100k`(`pi-chat.ts` / `pi-planner.ts`,32k 时代的 3 处已统一);单次对话工具往返上限 `MAX_TOOL_ROUNDS = 20`(参考原生 pi 生态 maxTurns≈50、按 100k 窗口等比例折算取保守值,见 `pi-chat.ts` 顶部注释)。注意本地小窗口模型(LM Studio)超窗会被远端拒绝。
- **Agent 分段读文档**:`document.read` 工具按块读取 document/storyboard 节点全文(先读 chunk=0 看结构再逐段读);切块纯函数 `chunkText`/`chunkNav` 在 `packages/shared/src/document.ts`(默认 4000 字符/块、空行段落边界优先断块、返回 1-based 行范围)。
- **画布持久化**:`ProjectStore` 用 JSON 文件 + `mkdirSync(BIGBOTART_HOME ?? ~/.bigbotart)`,接口已抽象,Electron 31 内置 Node 20 暂不支持 `node:sqlite`。
- **项目文件夹**:对话发给 Agent 的附件先拷入 `~/.bigbotart/projects/<projectId>/assets/`(`copyAttachmentsToProject`,按资产 id 幂等复用),Agent 一律使用项目内副本——项目自包含、可迁移;全局资产库在 `~/.bigbotart/assets/`。
- **IPC 契约**:`BigBotArtApi`(`packages/shared/src/index.ts`)是主进程与渲染进程的类型化合同,preload 通过 `contextBridge` 暴露到 `window.bigbotart`。
- **加速 LoRA(h3.c 加速)**:h3.c CLI 不接受 `--lora`;「加速 LoRA」= 蒸馏模型包(设置页 `accelPacks`,`src/main/lora.ts` 管理)+ 4/8 步。镜头 `data.accel.enabled` 时,主进程 `submit-render` 把包 id 解析为 `params.modelDir`(-d)与 `params.steps`(包缺失 → 提交报错)。详见 `docs/MiniMax-H3-加速-LoRA-使用手册.md` §8。
- **Take 历史覆盖图片节点**:`Take.shotNodeId` 字段语义 = **节点 id**,shot 与 image-gen / image-edit / image-upscale / image-crop 统一记录(提交前 `takesCreate(queued)`,队列完成或裁切快路径写终态;检查器可切换回看)。`image-crop` 是纯 ffmpeg 节点,不走渲染队列(`/crop-image` IPC,见 `apps/desktop/src/main/frames.ts`)。

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
