# Agent 能力清单 与 工具调用 UI 设计

> 版本:v1.1 · 状态:✅ 工具聚合卡已实现(ToolRunCard + AskCard 结构化选项 + 错误卡;UI 稿 agent-cards.html)
> 关联:PRD §5.2 · [文本节点与Agent分镜管线-产品设计与技术方案](./文本节点与Agent分镜管线-产品设计与技术方案.md)
> 代码入口:`packages/agent/`(规划器/对话 worker)· `packages/shared/tool-defs.ts`(工具定义)· `apps/desktop/src/main/tool-handlers.ts`(工具执行)· `apps/desktop/src/main/memory.ts`(记忆注入)· `CanvasPage.tsx`(对话 UI)

---

## 1. Agent 能力全景(当前已实现)

### 1.1 双入口

| 入口 | 用途 | 实现 |
|---|---|---|
| **规划器** `agentPlanStoryboard` | 一句话起活:需求 → 分镜表节点;默认分步只出表,`autoMaterialize` 可同时铺节点 | `pi-planner.ts`(LLM)+ `plan.ts`(确定性兜底) |
| **对话** `agentChat` | 画布页多轮问答 + 工具调用循环(最多 8 轮) | `pi-chat.ts` worker 子进程 |

### 1.2 输出能力

- **Markdown 自由输出**(对话回复经 `MarkdownText` 渲染):标题 / 列表 / 代码块 / 链接 / **GFM 表格** / 分隔线。
- **结构化输出**(规划器):受控 JSON schema——镜头 `{scene,action,camera,look,audio}`、分镜表 `{title,intro,basePrompt,rows:[…]}`。
- **结构化提问**:`ask.user` 暂停对话,渲染「确认卡片」,用户点选后续聊(§ 1.5)。

### 1.3 工具调用(24 个 · 9 域)

| 域 | 工具 | 能力 |
|---|---|---|
| canvas(7) | `list_nodes` `get_node` `create_node` `update_node` `delete_node` `connect` `connectors` | 读节点内容(含 markdown/分镜表/参数)、增删改节点、连线(**label = 端口语义**)、查连接器能力表 |
| storyboard(2) | `plan` `materialize` | 从文档/文本生成分镜表落画布;按行铺 shot/image-gen(first-frame 直通) |
| engine(3) | `submit` `queue_status` `cancel` | 提交生成(视频/图片)/查队列/取消 |
| assets(3) | `list` `get` `import` | 资产库查询与导入(含系统对话框) |
| skills(3) | `list` `apply` `save` | Skills 库应用/保存 |
| timeline(1) | `export` | 时间线导出(FFmpeg 合成) |
| memory(3) | `update_core` `remember` `recall_search` | 核心记忆/长期事实/检索 |
| continuity(1) | `check` | 相邻镜头连续性校验(基于 shot→shot 边) |
| ask(1) | `user` | **提问**:(question + 2~6 选项),暂停等待用户选择 |

> 注入方式:工具 schema(function calling)随每次对话发给 LLM;工具描述即提示词。`ask.user` 由 worker 拦截,不执行。

### 1.4 记忆与上下文注入(对话 system prompt)

```
[基础人格] 创作 Agent + 提问规范(ask.user 引导)
[画布能力] 节点类型 12 种 + 连接器端口语义表 + 分镜表流程(storyboard.plan → materialize → 重同步)
[项目目标/风格规则/硬性约束/用户偏好]  ← core,有值才注入
[本画布对话摘要(已压缩)] ← /compact 生成(conversationSummary),压缩后仍注入全局脉络
[本项目的其他画布] summary 注入
[项目记忆(相关)] archival 关键字检索 top 3
历史:当前画布 recall 最近 12 条 + 本轮输入(/compact 后更早消息折叠成摘要,尾部保留最近 8 条)
参数:temperature 0.4 · contextWindow 100k · maxTokens 4000
```

### 1.5 提问与打断

- **确认卡片**:Agent 调 `ask.user` → worker 拦截返回 `{ask}` → 渲染层卡片(问题 + 2~6 按钮),点选作为用户消息回传继续。v1.1 起 options 支持 `{label, sub?, recommended?}` 结构化选项(worker 归一化,字符串仍兼容),确认卡带字母序号/副说明/推荐徽标/已选择回显(`AskCard`)。
- **打断**:`agentCancel` + AbortSignal(103ms 生效);对话中可随时「已打断 · 可直接在画布修改」。
- **对话命令**(输入框斜杠命令,Composer 也有对应按钮):
  - `/clear`:清空当前画布对话 —— UI 消息 + 持久化 recall + 压缩摘要一并移除(画布节点/产物/节点总结不受影响;其他画布不受影响;操作不可恢复)。
  - `/compact`:把当前画布旧对话交给 LLM 压成中文摘要,写入 `canvasMemory.conversationSummary` 并裁剪 recall(保留最近 8 条,承接上下文与未确认的 ask 卡);摘要随每次对话注入(见 §1.4),多次 compact 自动合并追加。

### 1.6 容错

- 规划器:LLM 不可达/失败 → **确定性模板兜底**(闭环不中断)。
- 对话:LLM 不可达 → 明确报错(无兜底,依赖模型在线);工具执行异常 → 工具卡标「失败」。
- `/compact`:LLM 不可达/失败 → **确定性兜底摘要**(`compactFallbackSummary`,按角色折叠旧消息,截断 1500 字),压缩流程照常完成,不阻塞用户。

---

## 2. 工具调用 UI 现状与问题(为什么要改)

**现状**:一次对话的工具调用 `res.toolCalls`(数组)在 `CanvasPage` 里被**逐条拆成独立消息**平铺在消息流:

```
[用户] 把《草原之河》做成 30 秒短片

[⚙] canvas.get_node  …成功
[⚙] storyboard.plan   …成功
[⚙] canvas.connect    …成功
[⚙] engine.queue_status …成功
[🎬] 已生成分镜表:N 行…
```

**问题**:
1. **刷屏**:一个任务 4~8 次工具调用 = 4~8 张卡片,长流程一屏全是工具卡,挤掉真正的内容(回复/表格/提问)。
2. **不可折叠**:每条卡固定展开,无法一眼跳过中间过程直达结果。
3. **混杂**:工具卡与正文消息混排,「这是过程还是结论」不清晰。
4. **状态弱**:失败项与成功项视觉区分不够,异常需要立刻被看到但当前平权排列。

---

## 3. UI 设计:工具调用集中聚合卡片(重点)

### 3.1 设计目标

1. **集中**:一次用户消息对应的「本轮工具执行」聚合为**一张卡片**(`ToolRunCard`),不再逐条平铺。
2. **可展开可收起**:默认**收起为一行摘要**(带展开箭头);点开头展开全部工具行;每行可再展开详情(参数/结果)。
3. **异常优先**:存在失败/异常时,收起态摘要即高亮(红点 + 文案「1 项失败」),无需展开即可感知。
4. **不丢信息**:展开态保留现在的全部信息(工具名、状态徽标、参数摘要、结果、定位节点)。

### 3.2 布局示意(收起态 → 展开态)

```
┌────────────────────────────────────────────┐
│ ⚙ 本轮执行 4 个工具 · 3 成功 · 1 失败  ▾  │  ← 收起态(默认)
└────────────────────────────────────────────┘

┌────────────────────────────────────────────┐
│ ⚙ 本轮执行 4 个工具 · 3 成功 · 1 失败  ▴  │  ← 展开态
│ ──────────────────────────────────────── │
│ ▸ canvas.get_node   成功   [定位→]        │  ← 行:工具名+徽标+定位
│   （收起行时:参数一行摘要）
│ ▸ storyboard.plan   成功   [定位→]        │
│ ▾ engine.submit     成功   [定位→]        │  ← 行级展开:详情
│   ┌──────────────────────────────┐       │
│   │ 参数: {"nodeId":"shot-3"}      │       │
│   │ 结果: 已提交生成任务(…)        │       │
│   └──────────────────────────────┘       │
│ ▸ engine.submit     ✕ 失败    [定位→]     │  ← 失败行:红边框红字
│   ┌ 错误原因… ┐                          │
└────────────────────────────────────────────┘
```

**规则**:
- 展开状态:卡片级 `expanded`(整体展开/收起)+ 行级 `open`(单行详情)。默认卡片**收起**。
- 有失败时卡片展开箭头旁显示红色 `dot` + 摘要文案含「N 项失败」;失败行默认保持行级展开(不用点就能看到错误)。
- 参数/结果详情:mono 小字,参数 JSON 截断 240 字符,结果全文 pre-wrap;过长可再点行折叠。
- 定位:`[定位→]` 保留(有 nodeId 的行),点击画布定位并无选中。

### 3.3 数据模型(渲染层改动即可,worker 协议不动)

`res.toolCalls` 本来就是数组——**聚合是纯前端行为**。

```ts
// canvas/types.ts — ChatMsg 扩展(保留 toolCall 兼容旧快照)
export interface ChatMsg {
  // …
  /** 🆕 本轮工具执行聚合(替代逐条 toolCall 平铺) */
  toolRuns?: Array<{
    name: string;
    args: Record<string, unknown>;
    status: 'running' | 'success' | 'error';
    result?: string;
    nodeId?: string;
  }>;
}

// CanvasPage send():单条消息携带整组,不再拆卡
if (res.toolCalls?.length) {
  out.push({
    id: ++msgId.current,
    kind: 'agent',
    odId: 'agent-tools',
    toolRuns: res.toolCalls.map((tc) => ({ name: tc.name, args: tc.args, status: tc.ok ? 'success' : 'error', result: tc.result, nodeId: tc.nodeId })),
  });
}
```

### 3.4 组件结构

```
components/ToolRunCard.tsx          ← 纯展示组件(本地状态:cExpanded/rOpen)
  ├─ .trc(容器,.trc.err 有失败)
  │   header:⚙ 摘要文本 + 失败红点 + ⌃/⌄(点击切换 cExpanded)
  │   body(cExpanded):
  │     rows.map →
  │       .tr-row(.ok/.err,.open)
  │         ▸ 工具名(mono) + 徽标(成功/失败) + [定位→](nodeId) 
  │         body(rOpen): 参数 JSON + 结果 pre
```

**交互状态机**:
| 事件 | 结果 |
|---|---|
| 点击卡片 header | 切换 `cExpanded`(收/展) |
| 点击行头部 | 切换该行 `rOpen`(详情) |
| 有任何失败行 | 卡片自动 `cExpanded=true` 且失败行 `rOpen=true`(异常优先) |
| 定位点击 | `locate(nodeId)`(沿用现有) |
| 全部成功 & 无 nodeId | 更可能被用户收起——保持默认收起 |

### 3.5 与确认卡片 / 正文的关系

```
[用户] …（需求）
[⚙ ToolRunCard 收起行]   ← 过程(可展开)
[🃏 确认卡片]            ← 决策点(ask.user)
[📄 Markdown/表格回复]    ← 结论
```

- 工具调用 = **过程**:聚合、可折叠、以摘要示人。
- 确认卡片 / 正文回复 = **内容与决策点**:常驻可见,不被工具卡淹没。

### 3.6 CSS 要点

```css
.trc          边框 var(--border-soft);圆角;bg var(--surface-warm)
.trc.err      边框红色 40% 混合;失败徽标 var(--danger)
.trc-header   flex;font mono 11px;cursor:pointer;hover bg
.tr-row       行 head flex;gap 6px;padding 5px 9px;cursor:pointer
.tr-row.err   color var(--danger)
.tr-detail    padding 8px 10px;bg var(--bg);pre-wrap mono 10.5px;边框
```

---

## 4. 配套 UI 建议(顺带,不阻塞)

1. **确认卡片**(已实现,微调):选项按钮在收起态可保留一列;question 支持 Markdown 表格(提案对比用)。
2. **模型选择器**保持现状(顶栏/项目级)。
3. P2:ToolRunCard 时间轴模式(每行左侧时间点 + 耗时)。
4. **对话命令按钮**(已实现):Composer 工具行提供 `/clear`(清空对话)、`/compact`(压缩上下文)两个按钮,与斜杠命令等价,便于发现。

---

## 5. 验收清单

- [ ] 一次对话中多次工具调用在消息流里只出现 **1 张聚合卡**;
- [ ] 卡片默认收起为一行摘要(「⚙ 本轮执行 N 个工具 · M 成功 · K 失败」);
- [ ] 点击卡片可展开/收起;点击行显示参数 JSON + 结果全文;再点收起;
- [ ] 有失败时摘要高亮「K 失败」、卡片自动展开、失败行自动展开详情;
- [ ] [定位→] 在有 nodeId 的行生效(定位并选中节点);
- [ ] 旧数据(逐条 toolCall 消息)渲染兼容;
- [ ] ask 确认卡片与聚合卡同在时不互相遮盖、不重复展示 reply 文本。

---

## 6. 代码位置索引

| 位置 | 说明 |
|---|---|
| `packages/shared/src/tool-defs.ts` | 24 个工具定义(注入的提示词);ask.user options 支持 string 或 {label,sub,recommended} |
| `packages/agent/src/pi-chat.ts` | 对话工具循环 + ask.user 拦截(options 归一化为 AskOption) |
| `packages/agent/src/pi-planner.ts` | 规划器 system prompt 与 JSON schema |
| `packages/agent/src/plan.ts` | 确定性兜底(plan / plan-storyboard) |
| `apps/desktop/src/main/memory.ts` | system prompt 组装(人格/画布能力/记忆注入)+ clear/compact 对话管理(recall 裁剪、conversationSummary 注入) |
| `apps/desktop/src/main/tool-handlers.ts` | 24 个工具的主进程执行 |
| `CanvasPage.tsx` | 消息流渲染:toolRuns 聚合卡(send 对账 + SSE 实时更新 + 历史连续 tool 分组)、AskCard、错误卡 |
| `components/ToolRunCard.tsx`(已实现) | 聚合折叠卡片(卡片级/行级展开,失败自动展开) |
| `components/AskCard.tsx`(已实现) | 确认卡片(字母序号/副说明/推荐徽标/已选择态) |