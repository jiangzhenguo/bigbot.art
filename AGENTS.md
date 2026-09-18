# AGENTS.md — AI 代理工作规范(BigBotArt)

> 本文件是面向所有 AI 编码代理(Claude Code / Cursor / Codex / DSH / Copilot Workspace 等)的强制性工作规范。
> 人类开发者约定见 `docs/AI使用规范.md`;架构背景见 `CLAUDE.md` 与 `PRD-BigBotArt-无限画布视频图片生成Agent.md`。
> 本文件与 CLAUDE.md 冲突时,以本文件为准并回写同步 CLAUDE.md。

## 0. 项目速览(30 秒版)

Electron 31 + React 18 + React Flow 12 的无限画布视频/图片生成 Agent,pnpm workspace:

- `apps/desktop` — Electron 外壳(main / preload / renderer 三进程,各自独立构建)
- `packages/shared` — 领域类型 + IPC 契约 `BigBotArtApi`(**唯一的类型事实来源**)
- `packages/providers` — 渲染后端(h3.c 视频 / mlxgen 图片 / mock 占位),统一走 `registry.ts`
- `packages/agent` — Agent 内核(主进程 `manager.ts` ↔ worker 子进程,stdio JSON-RPC)

```bash
pnpm install && pnpm dev:dry     # 开发(dry-run,安全默认)
pnpm typecheck                   # 提交前必跑,全 workspace tsc --noEmit
pnpm build                       # electron-vite build
```

## 1. 红线(违反 = 直接打回)

| # | 红线 | 原因 |
|---|---|---|
| R1 | **禁止把 `.env`、API Key、令牌写入任何会被 git 跟踪的文件**;新密钥配置只写 `.env.example` 的占位符 + 注释 | 仓库无密钥历史,保持如此 |
| R2 | **禁止默认关闭 dry-run**。代码内 `BIGBOTART_DRYRUN !== '0'` 的判定逻辑不许反转;真实推理只能由用户显式触发 | h3.c 真实推理加载 144GB 模型,preview 也要数分钟 |
| R3 | **禁止绕过 `packages/providers/src/registry.ts` 直接实例化 Provider**;新 Provider 实现 `Provider` 接口后注入 `createRegistry({ extra })` | registry 是唯一的后端选择点 |
| R4 | **禁止 renderer 直接 `import` Node/Electron API**;一切能力经 `BigBotArtApi` IPC 契约 + preload `contextBridge` | 进程隔离是安全边界 |
| R5 | **禁止删除/覆盖 `.bigbotart/`、`outputs/` 下的用户数据**;调试时用临时目录 | 本地优先,用户资产不可逆 |
| R6 | **禁止静默吞错**:`catch` 后必须经 `logger.ts` 写日志总线或向上抛带上下文的错误 | 主进程日志总线是唯一排障入口 |

## 2. 热点区域的联动修改清单(AI 最易漏)

修改以下文件时,**必须**同步修改对应关联方,并在回复中列出核对结果:

### 2.1 IPC 契约(`packages/shared/src/index.ts` 的 `BigBotArtApi`)
改任一方法签名 ⇒ 三处同步,缺一不可:
1. `packages/shared/src/index.ts` — 类型定义
2. `apps/desktop/src/main/index.ts`(或对应模块)— `ipcMain.handle` 实现
3. `apps/desktop/src/preload/index.ts` — `contextBridge` 暴露
4. 完成后跑 `pnpm typecheck`(契约是类型化的,类型不过 = 没改完)

### 2.2 Agent 协议(`packages/agent/src/protocol.ts`)
- 新增 method ⇒ `AgentMethod` 联合类型 + `worker.ts` 分发 + `manager.ts` 调用方三处同步
- 协议是 stdio JSON-RPC 跨进程,**保持向后兼容**:只加可选字段,不改已有字段语义
- 工具调用(`ToolCallRequest`)是 worker→主进程**反向 RPC**,新增工具还要改 `apps/desktop/src/main/tool-handlers.ts` 和 `packages/shared/src/tool-defs.ts`

### 2.3 领域类型(`packages/shared/src/domain.ts`,579 行,全项目最大类型文件)
- `CanvasNode` / `CanvasEdge` / `Take` / `Shot` 等被三进程共用;改字段 ⇒ 检查 `ProjectStore` 的 JSON 持久化是否需要迁移逻辑(旧项目文件不能打不开)

### 2.4 h3.c 命令构造(`packages/providers/src/h3c-command.ts`)
- 宽/高必须保持 32 倍数校验(`clampDimension`)与 `validateTier` 四档防呆,不允许绕过

## 3. 验证纪律

1. **改完必跑 `pnpm typecheck`**;涉及单个包可用 `pnpm --filter <pkg> typecheck`
2. **功能验证默认 dry-run**:`pnpm dev:dry`。需要真实推理前必须先向用户确认(成本:分钟级 + 大内存)
3. Agent worker 改动后,验证子进程路径(`AgentManager.inline` 默认 false):worker 崩溃不应污染主进程
4. mock Provider 永远真实(ffmpeg 占位 MP4),可用它做端到端冒烟而不碰真模型

## 4. 代码风格约定(从现有代码归纳)

- TypeScript ESM,`"type": "module"`;workspace 内部引用用 `@bigbotart/*` 包名,不跨包相对路径
- 注释与文档用中文;标识符用英文;环境变量统一 `BIGBOTART_` 前缀
- 主进程模块化:新能力优先加到 `src/main/` 下的独立模块(assets/export/frames/llm/memory/settings/skills/store/takes 已是先例),不要继续堆 `index.ts`(已 645 行)
- renderer 的 React Flow 画布逻辑集中在 `src/renderer/src/pages/canvas/`;新节点类型要同步 `node-mapping.ts` / `connectors.ts` / `constants.ts`

## 5. 文档同步义务

- 改了架构、命令、环境变量 ⇒ 同步 `CLAUDE.md` 的对应小节(它是多数 AI 工具的第一入口)
- 改了节点/连接器行为 ⇒ 同步 `docs/节点手册.md`(**不要改 `节点手册_副本.md`**,它是历史快照,禁止以副本为准)
- 新增环境变量 ⇒ 同步 `.env.example`(占位符)+ `CLAUDE.md` 环境变量表

## 6. Git 纪律

- 工作分支按 `git-branch-workflow` 约定(时间戳_jzgX);不直接在主干上堆未提交修改
- 提交信息中文、祈使句,说明"为什么"而非复述 diff
- AI 代理**不主动执行 `git push` / `git commit --amend` / `git reset --hard`**,除非用户当次明确要求

## 7. 给 AI 的提问义务(宁可问,不要猜)

遇到以下情况必须先问用户,而不是自行假设:
- 任务要求"真实推理 / 关掉 dry-run / 跑一下 h3 看看效果"
- 要删除任何画布、项目、Take、资产文件
- `BigBotArtApi` 契约语义不明确,需要"猜"主进程行为
- 需要安装新依赖(说明用途与体积后再装)
