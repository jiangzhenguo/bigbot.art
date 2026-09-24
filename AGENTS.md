# AGENTS.md — AI 代理工作规范(BigBotArt)

> 本文件是面向所有 AI 编码代理(Claude Code / Cursor / Codex / DSH / Copilot Workspace 等)的强制性工作规范。
> 人类开发者约定见 `docs/AI使用规范.md`;架构背景见 `CLAUDE.md` 与 `PRD-BigBotArt-无限画布视频图片生成Agent.md`。
> 本文件与 CLAUDE.md 冲突时,以本文件为准并回写同步 CLAUDE.md。

## 0. 项目速览(30 秒版)

Electron 31 + React 18 的无限画布视频/图片生成 Agent(画布为自研实现:DOM 节点 + SVG 连线 + 原生 CSS transform,**未使用 React Flow**),pnpm workspace:

- `apps/desktop` — Electron 外壳(main / preload / renderer 三进程,各自独立构建)
- `packages/shared` — 领域类型 + IPC 契约 `BigBotArtApi`(**唯一的类型事实来源**)
- `packages/providers` — 渲染后端(h3.c 视频 / mlxgen 图片 / mock 占位),统一走 `registry.ts`
- `packages/agent` — Agent 内核(主进程 `manager.ts` ↔ worker 子进程,stdio JSON-RPC)

```bash
pnpm install && pnpm dev:dry     # 开发(dry-run,安全默认;AI 排障/开发默认用这个)
pnpm dev                         # 真实跑(上线真跑,见 §0.5;仅用户明确要求时用)
pnpm typecheck                   # 提交前必跑,全 workspace tsc --noEmit
pnpm build                       # electron-vite build
```

## 0.5 真实跑模式(上线真跑)

> 与 dry-run 相对。红线 R2 不变:真实推理**只能由用户显式触发**,AI 代理不得默认进入真实跑。

| 入口 | 模式 | 行为 |
|---|---|---|
| `pnpm dev:dry` | dry-run(测试) | 只构造命令 + 占位结果,不碰真模型;**开发/排障默认** |
| `pnpm dev` / `pnpm start` | **真实跑** | 根脚本已显式 `BIGBOTART_DRYRUN=0`,真实 spawn h3.c / mlxgen |

真实跑必须**两层开关同时满足**(缺一不可):

1. 环境变量 `BIGBOTART_DRYRUN=0` —— 主进程**启动时只读一次**;改了 `.env` 或启动命令后必须**重启 App** 才生效
2. 设置页「真实推理」开关 = real —— 持久化在 `~/.bigbotart/settings.json` 的 `renderMode:'real'`

前置条件(不满足会白等或失败):

- 引擎模型就绪:`h3 --info -d <modelDir>` 能列出 checkpoint(本机部署见 h3c-usage skill)
- 接受成本:144GB 模型驻内存,preview 档也要 1-2 分钟、768² 档 8-10 分钟;首次 Metal shader 编译约 30 分钟
- 不要同时开两个真实任务(App 内生成 + CLI 直跑会争抢内存)

常见坑(均为本项目实测):

- 启动报「does not provide an export named …」:`packages/*` 的 dist 过期,先 `pnpm build:packages` 再启动
- 提交成功但 Take「无产物文件」:仍是 dry-run(回查上面两层开关)
- 启动日志显示 `BIGBOTART_DRYRUN=1`:实例是用 `pnpm dev:dry` 起的,要重启切 `pnpm dev`

## 1. 红线(违反 = 直接打回)

| # | 红线 | 原因 |
|---|---|---|
| R1 | **禁止把 `.env`、API Key、令牌写入任何会被 git 跟踪的文件**;新密钥配置只写 `.env.example` 的占位符 + 注释 | 仓库无密钥历史,保持如此 |
| R2 | **禁止默认关闭 dry-run**。代码内 `BIGBOTART_DRYRUN !== '0'` 的判定逻辑不许反转;真实推理只能由用户显式触发(真实跑的操作细则见 §0.5) | h3.c 真实推理加载 144GB 模型,preview 也要数分钟 |
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
2. **功能验证默认 dry-run**:`pnpm dev:dry`。需要真实推理前必须先向用户确认(成本:分钟级 + 大内存;入口/前置条件/常见坑见 §0.5)
3. Agent worker 改动后,验证子进程路径(`AgentManager.inline` 默认 false):worker 崩溃不应污染主进程
4. mock Provider 永远真实(ffmpeg 占位 MP4),可用它做端到端冒烟而不碰真模型

## 4. 代码风格约定(从现有代码归纳)

- TypeScript ESM,`"type": "module"`;workspace 内部引用用 `@bigbotart/*` 包名,不跨包相对路径
- 注释与文档用中文;标识符用英文;环境变量统一 `BIGBOTART_` 前缀
- 主进程模块化:新能力优先加到 `src/main/` 下的独立模块(assets/export/frames/llm/lora/memory/settings/skills/store/takes 已是先例),不要继续堆 `index.ts`(已 645 行)
- renderer 的自研画布逻辑集中在 `src/renderer/src/pages/canvas/`;新节点类型要同步 `node-mapping.ts` / `connectors.ts` / `constants.ts`
- renderer 的 Agent 对话面板在 `src/renderer/src/pages/agent/`:`useAgentChat.ts`(全部状态与副作用)+ `AgentChatView`/`AgentComposer`(展示)+ `cards/`(消息卡片,纯展示)

## 5. React 开发规范(渲染层强制)

以下规则来自本项目的真实事故,违反会在评审中被指出:

1. **setState updater 必须纯**。禁止在 updater 里改 ref、自增 id、发请求——本项目开 StrictMode,dev 下 updater 会**双跑**,副作用会执行两次(真实事故:updater 内清 ref 导致工具卡对账失败、重复建卡)。id/ref 分配一律在 updater 外一次完成。
2. **容器/展示分离**。页面组件(容器)只组合与接线;状态+副作用收敛到自定义 hook(`useXxx`);展示组件(如 `pages/agent/cards/*`)只接 props,**不直接调 `window.bigbotart`**。
3. **消息/列表数据只存可序列化数据,不存 ReactNode**。渲染分派集中在列表组件(如 `ChatMessageList`),新增消息类型 = 加一个数据字段 + 一张卡片组件,禁止往消息里塞 JSX。
4. **文件规模红线**:单个 tsx 超过 300 行考虑拆分;超过 500 行必须拆(拆出 hook 或子组件)。CanvasPage 曾是 3700+ 行的反面教材。
5. **effect 纪律**:订阅类 effect 必须返回清理函数;依赖数组如实填写(确需省略时用 eslint-disable 注释说明原因)。
6. **样式**:只用设计 token(`var(--fg)`/`--border-soft`/`--accent` 等),禁止新增硬编码色值;新卡片/交互组件带 `data-od-id` 便于设计稿对照与 E2E 定位。
7. **列表渲染**:key 用稳定 id,不用数组索引。
8. **可滚动的 flex 列容器必须给子项 `flex:none`**(如 `.chat > *{flex:none}`)。带 `overflow:hidden` 的卡片(圆角收边常用)`min-height:auto` 会算成 0,默认 `flex-shrink:1` 会把它压扁成一条线且列表失去滚动——本项目真实事故(工具卡/确认卡被压成空胶囊)。
9. **非受控 DOM 组件(contentEditable 表格等)在"构建 html 字符串"阶段禁止读 live DOM**。如 TableEditor 的 `rowHtml` 曾在 `innerHTML` 写入前读 `tHead.rows` 取列数,首挂时 `tHead=null` 直接白屏;构建参数必须显式传参,live DOM 读取一律可选链兜底。页面级 `ErrorBoundary`(`components/ErrorBoundary.tsx`)已就位,新页面/大区域直接复用——任何组件错误只降级为错误面板,不允许整窗白屏。

## 6. 文档同步义务

- 改了架构、命令、环境变量 ⇒ 同步 `CLAUDE.md` 的对应小节(它是多数 AI 工具的第一入口)
- 改了节点/连接器行为 ⇒ 同步 `docs/节点手册.md`(**不要改 `节点手册_副本.md`**,它是历史快照,禁止以副本为准)
- 新增环境变量 ⇒ 同步 `.env.example`(占位符)+ `CLAUDE.md` 环境变量表

## 7. Git 纪律

- 工作分支按 `git-branch-workflow` 约定(时间戳_jzgX);不直接在主干上堆未提交修改
- 提交信息中文、祈使句,说明"为什么"而非复述 diff
- AI 代理**不主动执行 `git push` / `git commit --amend` / `git reset --hard`**,除非用户当次明确要求

## 8. 给 AI 的提问义务(宁可问,不要猜)

遇到以下情况必须先问用户,而不是自行假设:
- 任务要求"真实推理 / 关掉 dry-run / 跑一下 h3 看看效果"
- 要删除任何画布、项目、Take、资产文件
- `BigBotArtApi` 契约语义不明确,需要"猜"主进程行为
- 需要安装新依赖(说明用途与体积后再装)
