# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

BigBotArt — 无限画布的视频/图片生成 Agent(跨端桌面 App,本地优先)。
基于 Electron 31 + React 18 + React Flow 12,对接本地部署的 h3.c 视频引擎与 MLX 图片生成/编辑引擎。
当前处于 M1 骨架期:h3.c / mlxgen 默认 dry-run,不真实推理。

## 常用命令

```bash
pnpm install                          # 安装依赖(workspace + electron 二进制)
pnpm dev                              # 开发模式(electron-vite dev,默认在 apps/desktop)
pnpm build                            # 构建产物(electron-vite build)
pnpm start                            # electron-vite preview(运行已构建产物)
pnpm build:packages                   # 单独构建 packages/*
pnpm typecheck                        # 全 workspace tsc --noEmit
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
  - `src/main/index.ts` — 主进程入口,挂载 IPC handler:引擎探测、Provider 调用、项目/画布、Agent 启停与 plan
  - `src/main/store.ts` — `ProjectStore`(JSON 文件持久化,接口预留 SQLite 替换)
  - `src/preload/index.ts` — `contextBridge` 暴露类型化 `bigbotart` API
  - `src/renderer/src/App.tsx` — 三栏布局(节点库侧栏 + React Flow 无限画布 + Agent 控制台),首次启动建默认项目并探测引擎
  - `electron.vite.config.ts` — 三个独立构建(main / preload / renderer)
- **packages/shared** — 领域类型(画布、节点、Shot、Take、Provider、引擎状态、IPC 契约 `BigBotArtApi`)
- **packages/providers** — Provider 抽象与实现
  - `h3c-command.ts` — h3.c CLI 命令构造器(32 倍数宽高校验、`clampDimension`、档位防呆 `validateTier`、`TIER_PRESETS` 四档)
  - `h3c.ts` — h3c Provider(`--info` 探测、`spawn` 真实推理,dry-run 默认开)
  - `mlxgen.ts` — mlxgen Provider(文生图/指令编辑/I2I/Inpaint/Outpaint/超分能力)
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
- **dry-run 默认开启**:`BIGBOTART_DRYRUN !== '0'` 时 h3c / mlxgen 只构造命令 + 占位结果,不真实推理。`mock` 永远真实(用 ffmpeg)。
- **Agent 子进程隔离**:`AgentManager.inline` 默认 false,worker 通过 `spawn(process.execPath, [worker.js])` 独立运行(pi 崩溃不污染主进程)。`inline=true` 仅供调试,直接走 `deterministicPlanner`。
- **LLM 优先级**(worker 内):远端 OpenAI 兼容端点(由 `BIGBOTART_LLM_BASE_URL` 触发)→ 本地 LM Studio(1234)→ 确定性模板兜底。`.env.example` 列出了 DeepSeek / GLM / Kimi / MiniMax 等可选项。
- **画布持久化**:`ProjectStore` 用 JSON 文件 + `mkdirSync(BIGBOTART_HOME ?? ~/.bigbotart)`,接口已抽象,Electron 31 内置 Node 20 暂不支持 `node:sqlite`。
- **IPC 契约**:`BigBotArtApi`(`packages/shared/src/index.ts`)是主进程与渲染进程的类型化合同,preload 通过 `contextBridge` 暴露到 `window.bigbotart`。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BIGBOTART_HOME` | `~/.bigbotart` | 项目/画布数据目录 |
| `BIGBOTART_DRYRUN=0` | `1` | 关闭 dry-run,真实调用 h3.c / mlxgen(需模型就绪) |
| `BIGBOTART_H3_OUTPUTS` | `.bigbotart/outputs` | h3 输出目录 |
| `BIGBOTART_MOCK_OUTPUTS` | `.bigbotart/outputs/mock` | mock 输出目录 |
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
