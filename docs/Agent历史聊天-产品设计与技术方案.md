# Agent 历史聊天 — 产品设计与技术方案

> 状态:设计定稿 · P0 已落地(2026-10-15)
> 关联:现有「画布级单会话」记忆体系(`ProjectMemory.recall` / `canvasMemory`)的能力扩展。
> 涉及模块:`packages/shared`(domain / BigBotArtApi)、`apps/desktop/src/main`(memory.ts / index.ts /
> auto-continue.ts / project-package.ts)、`apps/desktop/src/renderer`(useAgentChat / AgentPane /
> AgentChatView)、项目包导入导出。

## 1. 背景与目标

### 1.1 现状

Agent 对话以**画布**为唯一会话边界:

| 能力 | 现状 | 说明 |
|---|---|---|
| 存储 | `ProjectMemory.recall[]`,每条带 `canvasId` | 同一画布全部消息挤在一条时间线 |
| 注入 | `recentRecall(projectId, canvasId)` | 最近 12 条 user/assistant/system 进上下文 |
| UI 恢复 | `useAgentChat` 挂载时按 canvasId 拉 recall | `selectRestoreWindow` 只数人类可读卡 |
| 清空 | `/clear` → `memoryClear(projectId, canvasId)` | 抹掉该画布全部对话 + 压缩摘要 |
| 压缩 | `/compact` → `conversationSummary` | 摘要挂在 `canvasMemory[canvasId]` |
| 技能 | `activeSkillId` | 画布级,与对话无关 |

**缺口**:

1. 同一画布上做「角色设定」「分镜铺节点」「修某一镜」等**不同任务**时,上下文互相污染;
2. `/clear` 是**全量销毁**,没有「开新会话、旧的还能回来看」;
3. 用户无法浏览历史任务、切回某次对话继续,只能往上翻当前这一条流。

### 1.2 目标

1. **历史聊天列表**:按当前画布展示会话清单(标题、时间、摘要预览);
2. **关联历史聊天**:每条会话显式归属画布;列表可筛选/搜索;支持从旧会话「续聊/派生」;
3. **切换聊天**:在面板内新建 / 切换 / 归档(删除)会话,切换后消息区与 Agent 上下文同步切换;
4. **兼容存量**:老项目无会话概念时,自动收成「默认会话」,行为与今天一致。

### 1.3 非目标(本方案不做)

- 跨画布合并成一条全局聊天流(画布工具上下文不同,合并易幻觉);
- 把画布节点/产物按会话做物理隔离(会话只隔离**对话记忆**,画布仍共享);
- 云端同步 / 多端会话;
- 会话内消息级搜索高亮(可后续加,本期列表级标题+预览即可)。

## 2. 概念模型

```
Project
└── Canvas(画布,节点/边共享)
    ├── ChatThread A  ← 当前活跃会话
    ├── ChatThread B  ← 历史会话(可切回)
    └── ChatThread C  ← 从 B 派生(可选 parentThreadId)
```

| 概念 | 定义 |
|---|---|
| **ChatThread(会话)** | 一次连续 Agent 对话的容器:标题、消息、压缩摘要、活跃标记 |
| **活跃会话** | 当前画布正在往里写消息、注入上下文的那一条(每画布恰好 0 或 1 个活跃) |
| **关联** | 会话 `canvasId` 绑定画布;可选 `parentThreadId` 表示「从哪次对话开新聊」 |
| **画布状态** | 节点/连线/技能激活仍属画布,不随会话切换复制 |

关键取舍:**会话隔离对话记忆,不隔离画布**。

理由:Agent 工具改的是同一张画布;若每会话克隆画布,会与现有撤销栈、Take、自动续跑、技能激活严重打架。用户切回旧会话时,看到的是「当时说了什么 + 当前画布实况」——与 ChatGPT 切会话后仍面对同一份文档的体验同构。system prompt 里已有「操作前必查 list_nodes」闸,足以缓解「旧对话里的节点 id 过期」。

## 3. 产品交互

### 3.1 入口(Agent 面板头)

在现有 `agent-head`「Agent 对话」旁增加:

| 控件 | 行为 |
|---|---|
| **历史**按钮 | 打开会话列表抽屉/弹出层(贴面板左侧或头部下拉) |
| **新对话**按钮 | 归档当前活跃会话(仍可在列表看到) → 建空会话并切过去 |
| 当前标题 | 显示活跃会话标题(可点改名);空会话显示「新对话」 |

发送中(`sending` / 自动续跑在飞)时:**禁止切换 / 新建**(toast「请先等待本轮结束或打断」),避免半截工具卡写错会话。

### 3.2 历史列表

每行展示:

- 标题(无标题则用首条用户消息截断,≤32 字)
- 相对时间(`updatedAt`)
- 一行预览(最近一条 user/assistant 正文截断)
- 可选徽标:「当前」/「有压缩摘要」/「派生自 xxx」

交互:

- 点行 → 切换到该会话(见 §3.3)
- 右键/悬停菜单:重命名、删除、从此新建(派生)
- 顶部搜索框:按标题 + 预览本地过滤(不调 LLM)
- 列表默认按 `updatedAt` 降序;只列**当前画布**的会话

### 3.3 切换会话

1. 若当前有在飞对话 → 拒绝(见上);
2. 把目标 `threadId` 写入画布活跃指针并持久化;
3. 渲染层清空 `msgs` → 按该 thread 的 recall 走现有 `selectRestoreWindow` 恢复;
4. 下一轮 `agentChat` / `buildContext` 只读该 thread 的 recall + 其 `conversationSummary`。

### 3.4 新对话

- 当前会话若**从未发过用户消息** → 不另建,仍用当前空会话(防空壳刷屏);
- 否则新建 thread,标题暂空,活跃指针切过去,消息区清空;
- **不**自动 `/clear` 旧会话(旧消息保留在列表里)。

### 3.5 `/clear` 与 `/compact` 语义收敛

| 命令 | 新语义 |
|---|---|
| `/clear` | 只清**当前活跃会话**的 recall + 该会话的 `conversationSummary`(不再整画布抹掉) |
| `/compact` | 只压缩**当前活跃会话**,摘要写入该 thread |

删除会话(列表菜单)= 删该 thread 及其全部 recall;若删的是活跃会话,自动切到最近一条或新建空会话。

### 3.6 「关联」的两层含义(产品文案)

1. **默认关联**:会话天生属于当前画布 —— 列表即「本画布的历史聊天」;
2. **派生关联**(可选,MVP 可做):「从此新建」→ 新 thread 带 `parentThreadId`,并把父会话的 `conversationSummary`(若有)或最近 N 条人类消息摘要预填为新会话的开场 system 注记(**不**把父会话全文复制进注入窗口,避免超窗)。

跨画布「把某次聊天挂到另一画布」—— **不做**(会破坏 canvasId 与工具上下文一致性)。

## 4. 数据模型

### 4.1 新增 `ChatThread`

```ts
/** Agent 会话(同一画布可有多条;活跃指针在 CanvasMemory) */
export interface ChatThread {
  id: string;                    // thr-<ts>-<rand>
  canvasId: string;
  /** 展示名;空则 UI 用首条用户消息生成 */
  title: string;
  /** 可选:从哪次会话派生而来 */
  parentThreadId?: string;
  /** /compact 结果(从 CanvasMemory.conversationSummary 下沉到会话级) */
  conversationSummary?: string;
  createdAt: string;
  updatedAt: string;
  /** 软删时间;有值则列表默认隐藏,物理清理可延后 */
  archivedAt?: string;
}
```

### 4.2 `RecallMessage` 扩展

```ts
export interface RecallMessage {
  id: string;
  canvasId: string;
  /** 🆕 所属会话;缺省 = 迁移前的「画布默认会话」 */
  threadId?: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  // …既有字段不变
  createdAt: string;
}
```

约定:**新写入必须带 `threadId`**。读路径对缺字段走迁移映射(§5)。

### 4.3 `CanvasMemory` / `ProjectMemory` 调整

```ts
export interface CanvasMemory {
  summary: string;
  nodeCount: number;
  lastActive: string;
  keyDecisions: string[];
  /** @deprecated 迁移后读 thread.conversationSummary;写路径不再使用 */
  conversationSummary?: string;
  activeSkillId?: string;
  /** 🆕 当前活跃会话 id;缺省则用该画布唯一/默认 thread */
  activeThreadId?: string;
}

export interface ProjectMemory {
  projectId: string;
  core: { /* 不变 */ };
  canvasMemory: Record<string, CanvasMemory>;
  /** 🆕 会话清单(按 id);消息仍在 recall 扁平数组里用 threadId 归属 */
  threads: Record<string, ChatThread>;
  recall: RecallMessage[];
  archival: ArchivalEntry[];
}
```

为什么消息仍扁平在 `recall[]` 而不是 `thread.messages[]`:

- 现有 `addRecall` / `recentRecall` / 恢复窗口 / compact / 项目包导入导出改动面最小;
- archival、system 注记等跨切面逻辑不用重写嵌套遍历;
- 列表元数据(标题/时间)与消息体分离,列表 IPC 不必回传整段 recall。

### 4.4 落盘

仍用 `workspaces/<projectId>/memory.json`,**不新开文件**(与技能激活同口径)。`threads` 与 `recall` 同文件原子写(`MemoryStore.persist` 已有整文件覆盖)。

体积预估:本地优先、单项目会话通常几十条量级;若单项目 recall > 5000 条,后续可再拆 `threads/<id>.json`(本期不做)。

## 5. 迁移(幂等)

启动读 `memory.json` 时(或 `MemoryStore.get` 首次加载)跑一次:

1. 若已有 `threads` 且每条 recall 都有 `threadId`(或该 canvas 无 recall)→ 跳过;
2. 否则对每个出现过的 `canvasId`:
   - 建 `thr-legacy-<canvasId>`(或 `thr-<ts>-migr`);
   - `title` = 「默认对话」或取该画布最早一条 user 截断;
   - 把该 canvas 下无 `threadId` 的 recall 全部补上该 id;
   - 若 `canvasMemory[cid].conversationSummary` 存在 → 挪到 thread,画布字段可保留只读兼容;
   - `activeThreadId` = 该 thread(保持「打开画布就是以前那条流」);
3. 写回 memory.json;可用 `migration.chatThreadsV1: true` 记在 memory 根或 settings,保证幂等。

项目包导入:在 canvasId 重映射之后,同步重映射 `threads[*].canvasId` / `parentThreadId` / `recall.threadId` / `activeThreadId`(与现有 `canvasMemory` 重映射同段完成)。

## 6. 主进程 API / IPC

### 6.1 契约增量(`BigBotArtApi`)

```ts
/** 列出某画布的会话(不含消息体;按 updatedAt 降序) */
chatThreadsList(projectId: string, canvasId: string): Promise<ChatThread[]>;

/** 新建会话并设为活跃;emptyReuse=当前已是空会话则返回现有 id */
chatThreadCreate(projectId: string, canvasId: string, opts?: {
  title?: string;
  parentThreadId?: string;
}): Promise<{ ok: boolean; thread?: ChatThread; error?: string }>;

/** 切换活跃会话 */
chatThreadSwitch(projectId: string, canvasId: string, threadId: string): Promise<{
  ok: boolean;
  thread?: ChatThread;
  error?: string;
}>;

/** 重命名 */
chatThreadRename(projectId: string, threadId: string, title: string): Promise<{ ok: boolean; error?: string }>;

/** 删除(或归档)会话;若删活跃则自动切到最近一条/新建 */
chatThreadDelete(projectId: string, threadId: string): Promise<{
  ok: boolean;
  activeThreadId?: string;
  error?: string;
}>;

/** 读某会话消息(供 UI 恢复;也可继续用 memoryGet + 客户端过滤,但推荐专用以免拉全量) */
chatThreadMessages(projectId: string, threadId: string): Promise<RecallMessage[]>;
```

既有:

- `memoryClear` / `memoryCompact`:**改为按活跃 thread 作用域**(签名可保持 `projectId, canvasId`,内部读 `activeThreadId`);文档与 toast 文案改为「已清空/压缩当前对话」;
- `agentChat`:请求体增加可选 `threadId`;缺省用画布 `activeThreadId`(渲染层应显式传入,避免竞态);
- `AgentEvent`:已有 `canvasId`;**补 `threadId`**,渲染层过滤「事件属于当前展示的会话」——否则切走后旧会话的 `done` 会污染新会话 UI。

### 6.2 `MemoryStore` 方法调整

| 方法 | 变化 |
|---|---|
| `addRecall` | 强制/补全 `threadId`(缺则用 active) |
| `recentRecall` | 签名加 `threadId`,只取该会话 |
| `clearRecall(canvasId)` | → `clearThread(threadId)` 或 clear 时解析 active |
| `compact` | 读写 `thread.conversationSummary`,裁剪该 thread 的 recall |
| `buildContext` | recall / pinnedInstruction / conversationSummary 全部按 active thread 过滤 |
| 新增 | `listThreads` / `createThread` / `switchThread` / `renameThread` / `deleteThread` |

### 6.3 自动续跑(`auto-continue.ts`)

今日闸门是「同画布 inFlight」。补一条:

- 唤醒时带上**提交时的 `threadId`**(在 `engine.submit` / RenderJob 或 AutoContinue 队列项里记下);
- 若用户已切到别的会话 → **仍回到提交时的会话唤醒**(或:若活跃已变,推 continuity 卡让用户决定)。  
  **推荐默认**:回到提交时的 thread 并自动 `switchThread`(保证「提交即收尾」后的推进不丢),UI 若正在看别的会话则 toast「已切回生成完成的对话继续」。

`source==='agent'` 的 job 完成事件需能读到 threadId(RenderRequest 可选字段透传,与 `projectId/canvasId/takeId` 同口径——缺了就不要静默续跑)。

## 7. 渲染层改动

### 7.1 `useAgentChat`

- 状态增加 `activeThreadId` / `threads`(或按需 list);
- 挂载恢复:先 `chatThreadsList` → 确定 active → `chatThreadMessages` → 现有 restore 管线;
- `send` / 事件订阅:过滤 `ev.threadId === activeThreadId`;
- 导出 API:`switchThread` / `newThread` / `renameThread` / `deleteThread` / `threads`;
- 切画布时:仍清空 msgs,再按新画布 active thread 恢复(与今日切画布 effect 同构)。

### 7.2 UI 组件

| 组件 | 职责 |
|---|---|
| `AgentChatHistory.tsx`(新) | 列表 + 搜索 + 菜单(纯展示) |
| `AgentPane` / `agent-head` | 挂「历史」「新对话」、当前标题 |
| `AgentChatView` | 不变为主;空会话可显示短引导「描述你想做的事…」 |

样式走既有 design token(`.agent` / `.chat`),列表用抽屉避免再拆一栏占画布。

### 7.3 标题生成

- 用户可手动改名;
- 首条用户消息发送成功后,若 `title` 仍空 → 主进程用该消息截断写入(确定性,不调 LLM);后续如需「LLM 起名」可加开关,默认关(省 token、避假成功)。

## 8. 与既有能力的交叉核对

| 能力 | 影响 | 处理 |
|---|---|---|
| 技能 `activeSkillId` | 仍画布级 | 切换会话不改技能;新会话继承当前画布技能 |
| `/clear` `/compact` | 作用域收窄到 thread | 文案 + 单测更新 |
| recall 注入窗口 / pinnedInstruction | 必须按 thread 过滤 | `recentRecall` 改签名 |
| UI 恢复窗口 | 同 | `selectRestoreWindow` 输入已是单 thread 消息 |
| 自动续跑 | 见 §6.3 | job 透传 threadId |
| 项目包 `.bba` | 需打包 `threads` + 重映射 | `project-package.ts` |
| 画布分支(待办) | 分支若=新 canvasId | 会话自然按 canvas 隔离;文档已点名交叉 |
| 敏感确认闸 / PiChatSession 状态 | worker 内会话态 | 切换 thread 前应 `agentCancel` 或禁止切换(§3.1) |

## 9. 实施分期

### P0 — 可用 MVP

1. 数据模型 + 迁移 + MemoryStore 按 thread 读写;
2. IPC:`list/create/switch/rename/delete/messages`;
3. UI:历史列表 + 新对话 + 切换 + 改名/删除;
4. `agentChat` / `buildContext` / `/clear` `/compact` 接 active thread;
5. AgentEvent + auto-continue 带 `threadId`;
6. 单测:迁移幂等、切换隔离、clear/compact 不串会话、事件不串台。

### P1 — 体验

1. 「从此新建」派生 + `parentThreadId` 展示;
2. 列表搜索;
3. 项目包导入导出完整覆盖;
4. 空会话复用、标题自动生成打磨。

### P2 — 可选

1. LLM 自动标题;
2. 会话级导出 Markdown;
3. recall 过大时拆文件存储。

## 10. 验证计划

- 单测(主进程):迁移前后 recall 条数不变且都有 threadId;两会话交替 `addRecall` 后 `recentRecall` 互不看见;clear A 不影响 B;compact 只改 A 的 summary;
- 单测(渲染):切 thread 后 restore 窗口只含目标会话;sending 中 switch 被拒;
- 手工(dry-run):同一画布建两会话 → 各说各话 → 切换回显正确 → 重启 App 仍在上次活跃会话;
- 回归:自动续跑在会话 A 提交后,即便 UI 曾打开列表,完成仍推进 A;
- `pnpm typecheck` + 相关 vitest。

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| 切会话后旧 `done` 事件污染 UI | 事件带 threadId + 渲染层硬过滤 |
| 自动续跑丢上下文 | job 记 threadId,完成时切回该会话 |
| 迁移漏网 → 部分消息无 threadId | 读路径兜底:无 threadId 且 canvas 匹配 → 归入 legacy thread |
| 用户以为切会话会「时光倒流画布」 | UI 文案明确「对话历史 · 画布内容共用」;不做假快照 |
| memory.json 变大 | P0 观察;P2 再拆文件,避免过早优化 |

## 12. 文档同步义务(落地时)

- `CLAUDE.md` Agent 对话上下文 / 命令小节:补「画布多会话」;
- `AGENTS.md` 若增 IPC 方法:走契约三处同步清单;
- 本文件状态改为「设计定稿」并注明实施 PR。

---

## 附:与「一个画布一条对话」的差异一句话

以前:`canvasId` = 会话主键。  
现在:`threadId` = 会话主键,`canvasId` = 关联的工作现场;活跃指针记在 `canvasMemory.activeThreadId`。
