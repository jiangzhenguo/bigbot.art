# Agent 技能 — 指令模板与对话自动加载 · 产品设计与技术方案

> 状态:设计定稿(2026-09,评审后实施)
> 关联:PRD §5.5「Skills 库」的**能力扩展** —— 现有 Skill 只有「画布节点模板」形态,本方案新增
> **「Agent 操作指令/提示词模板」形态**,使技能能在 Agent 对话中自动加载,指导 Agent 用工具操作节点。
> 涉及模块:`packages/shared`(Skill 类型/tool-defs)、`apps/desktop/src/main`(skills.ts / memory.ts /
> tool-handlers.ts / index.ts)、`apps/desktop/src/renderer`(SkillsPage / useAgentChat / AgentComposer)。

## 1. 背景与目标

### 1.1 现状(2026-09)

`Skill`(`packages/shared/src/domain.ts:507`)目前只有**一种形态 —— 画布工作流模板**:

| 能力 | 现状 | 说明 |
|---|---|---|
| 保存 | `skills.save` / `SkillStore.save` | 深拷贝当前画布(节点+连线+参数占位 `{主题}`) |
| 应用 | `skills.apply` / `SkillStore.apply` | 克隆节点换新 id → 新项目画布(只铺结构,不指导 Agent) |
| 工具 | `skills.list` / `skills.apply` / `skills.save`(`tool-defs.ts:44-46`) | 已注入全量工具,LLM 可调用 |
| UI | Skills 页(内置模板 + 我的 Skill) | 管理/保存/应用 |

**缺口**:技能无法携带「Agent 怎么干这份活」的操作指令。用户手工保存的画布模板铺出来后,Agent
对「接下来怎么按这套流程执行」一无所知——风格措辞、工具调用顺序、分镜→生成→导出 SOP 全靠
Agent 现场发挥,无法沉淀与复用。

### 1.2 目标(本方案)

1. **技能可携带 Agent 操作指令**(instructions:Markdown 操作手册/提示词模板),说明该技能
   如何用 `canvas.*` / `engine.*` / `storyboard.*` 等工具操作节点完成任务;
2. **对话自动加载**:技能被「激活」后,其指令段自动注入 Agent 系统上下文
   (`memory.buildContext` 的 systemPrompt),Agent 在后续对话中按技能工作;
3. **与画布模板并存**:同类 Skill 可同时含节点模板与指令段;应用 = 铺节点 + 激活指令,二选一也可;
4. **对话内可切换/停用**:通过对话或 UI 激活/停用技能,即时生效,跨会话持久化。

## 2. 概念模型:Skill 双形态

```
Skill
├── 画布模板形态(现有):nodes + edges + params + description —— 「铺什么结构」
└── 指令模板形态(新增):instructions —— 「怎么用工具干活」
```

| 维度 | 画布模板(Skill.nodes) | 指令模板(Skill.instructions) |
|---|---|---|
| 本质 | 节点结构快照(可克隆实体化) | Agent 系统提示词段(操作 SOP + 措辞 + 约束) |
| 消费方 | 渲染层/主进程(克隆到新项目画布) | LLM worker(buildContext 注入) |
| 生命周期 | 应用时一次性实体化 | 激活期间持续注入每次对话上下文 |
| 激活方式 | `skills.apply`(对话)/ 技能页「铺节点」 | `skills.activate`(对话)/ 技能页「注入指令」/ 输入区快选 |
| 退出方式 | 无(新项目已实体化) | `skills.deactivate` / 切到其他技能 / 新画布默认无 |

两个形态可**并存、可独立**:保存画布时可只存节点;也可把「当前对话中用户强调的操作要求」单独存成
指令技能;内置模板建议双形态齐备(铺结构 + 自动知道怎么执行)。

### 2.1 与「AI 技能」生态的对应关系

| 概念 | 本方案对应物 |
|---|---|
| Claude Skills 的 SKILL.md | `Skill.instructions`(注入 systemPrompt 的操作手册) |
| Skills 的 Frontmatter(name/description) | `Skill.name` + `Skill.description`(工具 `skills.list` 展示用) |
| Skills 的自动加载(Skill 在项目内即生效) | 画布级 `canvasMemory.activeSkillId` 持久化,进入画布自动恢复 |
| Skills 的按需读取(skills.read) | 超长指令降级为「摘要注入 + skills.read 按需读全文」 |

## 3. 数据模型与存储

### 3.1 `Skill` 类型扩展(`packages/shared/src/domain.ts`)

```ts
export interface Skill {
  id: string;
  name: string;
  nodes: CanvasNode[];        // 画布模板(可空:纯指令技能)
  edges: CanvasEdge[];
  params: string[];           // {占位} 参数,应用时替换(指令段内也支持同一占位语法)
  description?: string;       // 列表摘要(工具 skills.list / UI 卡片)
  /** 🆕 Agent 操作指令段:Markdown,对话激活时注入 systemPrompt */
  instructions?: string;
  /** 🆕 注入模式:full=全量注入(缺省) / summary=上下文只放摘要,supports skills.read 按需取全文 */
  inject?: 'full' | 'summary';
  createdAt: string;
  updatedAt: string;
}
```

约定:
- `instructions` 内支持与画布模板相同的 `{主题} {时长}` 占位——应用/激活时扫描替换(空值留空,用户画布上再填);
- 纯指令技能(`nodes: []`)合法;纯画布技能(`instructions` 缺省)保持现状兼容;
- **向后兼容**:只加可选字段,既有技能 JSON 旧结构无需迁移。

### 3.2 激活状态持久化(`memory.ts` — `CanvasMemory`)

激活是**画布级**状态(每个画布可挂一个技能),存 `canvasMemory[canvasId]`:

```ts
interface CanvasMemory {
  nodeCount: number;
  summary?: string;
  conversationSummary?: string;   // 现有:/compact 压缩摘要
  /** 🆕 当前画布激活的技能 */
  activeSkillId?: string;
}
```

- `project-canvas-memory.json` 已随记忆落盘,无需新文件;
- 进入画布时 `buildContext` 读 `activeSkillId` → 取技能 → 按 `inject` 模式注入;
- 切换项目/画布自动跟随各自记忆,天然隔离。

## 4. 上下文注入设计(`memory.buildContext`)

### 4.1 注入点与顺序

`buildContext`(memory.ts:183)的 `parts` 数组,在 **①b 画布能力知识之后、项目核心记忆之前**插入技能段:

```
parts.push(① 核心 prompt + 提问规则)
parts.push(①b 画布能力知识(节点/连接器/分镜流程))
parts.push(🆕 【当前技能】<name>:<instructions | 摘要>   ← 新段
parts.push(项目目标/风格规则/硬性约束/用户偏好)
parts.push(压缩摘要 / 其他画布 / recall / archival)
```

**注入语义**:
- 技能指令视为「本画布的工作方式覆盖",优先级高于默认行为(紧贴能力知识,Agent 先看到技能再看到通用规则);
- 默认规则(ask.user 确认、操作前必查)不删除——技能可以补充/细化但不得取消安全红线;
- 与其他画布的记忆同源,无激活技能时不注入任何内容,**零开销**。

### 4.2 token 与长度策略

| `inject` | 行为 |
|---|---|
| `full`(缺省) | instructions 全量注入(char ≤ 4000 建议;超长由保存侧提示) |
| `summary` | 注入 `description` + 指令长度/结构摘要 + 「详细指令用 skills.read 读取」 |
| 无 instructions | 注入 `【当前技能】<name> · 画布模板已就绪(无操作指令)` |

新增工具 `skills.read(skillId)` = 当前激活技能的按需全量读取通道(LLM 主动取)。

## 5. 工具协议扩展(`tool-defs.ts` / `tool-handlers.ts`)

| 工具 | 变化 | 行为 |
|---|---|---|
| `skills.list` | 增强 | 返回含 `instructions ? '有指令' : '仅画布'` 摘要 + 是否有指令 |
| `skills.apply` | 增强 | 克隆节点到新项目(现状)+ 若 `activate=true` 同时在该新项目画布挂激活 |
| `skills.save` | 增强 | 参数支持 `instructions` 与 `inject`(保存画布时可一并沉淀当前操作要求) |
| `skills.read` | 🆕 | 返回单个技能完整 instructions(按需读取,摘要模式兜底) |
| `skills.activate` | 🆕 | 设置 `canvasMemory[canvasId].activeSkillId`,返回注入预览(前 N 字符) |
| `skills.deactivate` | 🆕 | 清除当前画布激活技能 |

- 协议兼容:新增工具名 + 增补参数,不改既有字段语义(`packages/agent/src/protocol.ts` 向后兼容约定);
- 主进程分发:`tool-handlers.ts` skills 域追加 3 个 handler,复用 `SkillStore` + `MemoryStore`;
- worker 侧零改动:工具全量注入已生效,新工具名自动可用。

## 6. UI 交互(完整设计)

> UI 改动清单:Skills 页(指令编辑器 / 应用二选一 / 激活徽章)、Agent 对话面板(技能快选 / 激活 chip)、
> 画布检查器(激活展示)。全部走现有设计 token(`--accent`/`--border-soft` 等)与 `.pg-*` 页面容器,
> 新交互元素带 `data-od-id` 便于 E2E 定位。

### 6.1 Skills 页(现有页面扩展)

**布局(右侧详情面板,自上而下):**

```
┌─ Skill 详情 ─────────────────────────┐
│ 名称 / 副标题(节点数 · 参数 · 更新)    │
│ [预览缩略图]                          │
│ ┌─ 操作指令(🆕 可折叠)─────────────┐ │
│ │ 无指令:【添加操作指令】空态按钮      │ │
│ │ 有指令:Markdown 文本域(受控)       │ │
│ │   · Frontmatter 提示条              │ │
│ │   · {占位} 语法提示 · 字数 N/4000   │ │
│ │   · inject 切换:全量注入 / 摘要模式 │ │
│ │ [保存指令]                          │ │
│ └────────────────────────────────────┘ │
│ [铺节点到新项目] [注入指令到当前画布]    │  ← 应用二选一(🆕)
└────────────────────────────────────────┘
```

1. **指令编辑器(新组件 `SkillInstructionsEditor`,纯展示 + 受控回调)**
   - 数据:`instructions`(字符串)+ `inject`('full' | 'summary');
   - 字数统计与超长提示(>4000 字符建议 `inject='summary'`);
   - 语法助手:明文提示 `{主题}` 占位写法 + 右上角「查看撰写指南」链接(openExternal 到 docs/Agent技能文档-撰写指南与模板.md);
   - 保存按钮 → `window.bigbotart.saveSkill({ name, projectId, canvasId, instructions, inject })`(P0 已就绪),toast 提示;
   - 空态:无指令的技能显示虚线空态按钮「添加操作指令」,与「仅画布模板」徽章呼应。
2. **应用二选一(主操作拆两个按钮)**
   - 「铺节点到新项目」= 现状 `applySkill(skillId, projectName)`(纯画布模板路径);
   - 「注入指令到当前画布」🆕 = `skillActivate(projectId, canvasId, skillId)`,成功后 toast「已注入操作指令到当前画布」;
     若技能无指令段,提示「该技能只有画布模板,激活仅标记模板」;激活后卡片右上角显示「已激活」徽章
     (`activeSkillId === skillId` 时,需要页面知道当前画布);
   - 两个按钮都 `askPrompt` 确认(铺节点要新项目名;注入需要用户确认目标画布)。
3. **保存增强**:顶部「保存当前画布为 Skill」弹层增加可选项「把当前对话的操作要求一并保存」→
   把最近一轮用户强调的操作要求(简化取对话尾部指令文本)作为 `instructions` 传入;
   `inject` 缺省 `full`。
4. **接线改动(App.tsx)**:`SkillsPage` 新增 props `projectId` / `canvasId`(当前打开的项目与画布),
   供「注入指令到当前画布」与「已激活」徽章使用;无项目时两个激活相关入口置灰并提示先打开项目。

### 6.2 Agent 对话面板(useAgentChat / AgentComposer / AgentChatView)

1. **输入区技能快选(🆕)`AgentComposer` 内,输入框上方一行)**
   - 数据:`COMPOSER_SKILLS`(`pages/agent/constants.ts`:内置模板名称文案)兜底,
     同时可切换为真实技能列表(`window.bigbotart.listSkills()` 的名称,有指令的优先);
   - 点击技能名 → `window.bigbotart.skillActivate(projectId, canvasId, skill.id)` →
     成功:插入一条系统消息「已加载技能「X」的操作指令,后续对话按此执行」+ chip 更新;
   - 已激活同技能 → 幂等(主进程返回 ok,不重复插入消息)。
2. **激活指示 chip(🆕)**
   - 输入区上方或对话头部:「当前技能:<名> ✕」;✕ = `skillDeactivate(projectId, canvasId)` +
     toast「已停用技能」;
   - 状态来源:`useAgentChat` 新增 `activeSkillId`(页面进入时 `memory` 侧无从直读 → 主进程新增
     **`skill-active(projectId, canvasId)` 查询 IPC**(P2 补),或由激活操作回写 + 页面刷新时
     `listSkills` 配合画布记忆恢复;实现取前者,单通道)。
3. **Agent 自主激活(无 UI 改动)**:LLM 在工具轮内调 `skills.activate`/`deactivate`,
   `useAgentChat` 的工具结果渲染(ToolRunCard)与 chip 状态联动:工具返回 ok 且名称为
   `skills.activate` 时同步刷新 `activeSkillId`。

### 6.3 画布检查器(轻量)

- InspectorPane 顶部或画布 header 显示「本画布技能:<名>」(仅激活时),点击跳转 Skills 页
  (`onNavigate('skills')`);无激活不渲染,保持零打扰;
- 检查器技能行同时展示 `inject` 模式徽标(全量/摘要),让用户意识到注入范围。

### 6.4 UI 数据流与状态总览

```
SkillsPage                     AgentComposer/useAgentChat
  ├─ listSkills() ──────────┐   ├─ listSkills()(快选源,可选)
  ├─ saveSkill({…instructions…}) ┤   ├─ skillActivate(pid, cid, sid) → 系统消息 + activeSkillId
  ├─ skillActivate(pid,cid,sid)  ┤   ├─ skillDeactivate(pid, cid) → chip 清除
  ├─ skillDeactivate          └───┼─ skill-active(pid,cid)     ← P2 新增查询 IPC
  └─ applySkill(sid,name)         └─ ToolRunCard(skills.* 结果) → 联动 activeSkillId
                  └──────── 主进程 ────────┘
        SkillStore(JSON)   MemoryStore(canvasMemory.activeSkillId)
```

### 6.5 P2 UI 任务拆分(对应 §8 P2)

- [ ] `SkillInstructionsEditor` 组件(受控文本域 + inject 切换 + 字数/占位提示)
- [ ] SkillsPage 详情面板接入编辑器;应用二选一按钮组;激活徽章;App.tsx 传 projectId/canvasId
- [ ] 主进程新增 `skill-active(projectId, canvasId)` 查询 IPC(契约三处同步)
- [ ] useAgentChat:`activeSkillId` 状态 + activate/deactivate 动作 + 系统消息;进入页面查询恢复
- [ ] AgentComposer:技能快选行 + 激活 chip(✕ 停用);ToolRunCard 联动 skills.activate 结果
- [ ] 画布检查器技能行(激活展示 + 跳转)
- [ ] 验收:技能页编辑保存 → 对话激活 → 上下文注入(单测三态已在 P1);快选与手动激活等效;
      刷新/切画布后 chip 恢复

## 7. 内置技能(首批示例,双形态齐备)

| 技能 | instructions 要点(操作 SOP) |
|---|---|
| 纸拼贴剧情片 | 主题→旁白→ `storyboard.plan` → 改表 → `materialize` → ask.user 确认档位 → `engine.submit` 逐节点 → `timeline.export`;纸拼贴风格措辞(材质/拼贴/色纸);镜头节奏模板 |
| 电商产品 | 多视角管线:三视角 prompt 模板 + 批量 image-gen + 首帧直通 shot + 运镜节奏 |
| 科普讲解 | 图文穿插:分镜表行=画面+旁白 + 数据图示占位 + 导出 SOP |

内置技能作为 `BUILTIN`(可 fork 为「我的 Skill」再编辑),继承现状 Skills 页的 builtin/fork 体系。

## 8. 分期实现计划

### P0 — 数据与存储(半天)
- [ ] `domain.ts` Skill 增 `instructions` / `inject`
- [ ] `skills.ts` SkillStore:save 收 instructions、list 透传、**激活状态读写**(新 `MemoryStore.activeSkill(skillId)` / 透传 canvasMemory)
- [ ] `tool-defs.ts` 增 `skills.read/activate/deactivate` + `skills.save/apply` 参数增强
- [ ] `tool-handlers.ts` skills 域 3 个新 handler(+ save/apply 增强)
- [ ] `shared/index.ts` IPC:`skillActivate` / `skillDeactivate` / `skillRead`(skills 页走 IPC,不走工具)
- [ ] **验收**:typecheck + `pnpm test` 全绿;`skillActivate` 落盘 canvasMemory,重启不丢

### P1 — 上下文注入(半天)
- [x] `memory.buildContext`:`【当前技能】` 段注入(full/summary 两级;第四参 resolveSkill 由调用方注入)✅ 2026-09
- [x] 单测:`memory-compact.test.ts` 扩展(激活技能 → systemPrompt 含指令;未激活零注入;summary 模式只含摘要;技能删除安全跳过)✅
- [ ] **验收**:单测覆盖三态 ✅;真实对话日志可见技能段(待 P2 真机)

### P2 — UI(1 天,任务拆分与组件设计见 §6.5)
- [ ] SkillsPage:指令编辑器(SkillInstructionsEditor)+ 应用二选一 + 激活徽章;App.tsx 传 projectId/canvasId
- [ ] 主进程 `skill-active(projectId, canvasId)` 查询 IPC(进入页面恢复 chip;契约三处同步)
- [ ] useAgentChat:`activeSkillId` 状态 + activate/deactivate + 系统消息;进入页面查询恢复
- [ ] AgentComposer:技能快选行点击即激活 + 激活 chip/停用;ToolRunCard 联动 skills.activate 结果
- [ ] 画布检查器技能行(激活展示 + 跳转技能页)
- [ ] **验收**:技能页编辑保存 → 对话激活 → 上下文注入;快选与手动激活等效;刷新/切画布后 chip 恢复

### P3 — 内置技能 + 文档 + 端到端(1 天)
- [ ] 3 个内置技能(instructions 成文,存 `SkillStore` 出厂表或内置常量)
- [ ] 文档同步:本方案落 `CLAUDE.md` 关键约定(「技能双形态 + 注入点 memory.buildContext」);节点手册补 Skill 段说明
- [ ] 端到端验证:真实对话「用纸拼贴风格做短视频」→ `skills.list/activate` → 对话中 Agent 按指令执行(日志核对工具序列)
- [ ] **验收**:全链路演示通过;`pnpm test` 全绿

## 9. 风险与边界

| 风险 | 对策 |
|---|---|
| 长指令挤占 100k 上下文 | `inject:'summary'` 降级 + `skills.read` 按需;保存侧字数提示(>4000 字符建议 summary) |
| 技能指令诱导危险操作(指令注入) | 指令与用户提示同级可信;系统红线(ask.user 确认、操作前必查)不因技能豁免;UI 提示「技能内容自行负责」 |
| 与画布模板技能混淆 | 列表/badge 明确「有指令/仅画布」;激活与铺节点入口分离 |
| 跨会话一致性 | 激活持久化在 canvasMemory,进画布自动恢复;切换技能 = 覆盖,不叠加(同一画布至多一个激活技能) |
| 旧技能 JSON 兼容 | 只加可选字段;旧数据无 instructions = 「仅画布」形态,行为不变 |

## 10. 验收口径(整体)

1. 保存:画布 + 对话操作要求可一并存成技能(instructions 可编辑);
2. 加载:激活技能后,`buildContext` systemPrompt 包含技能指令,Agent 按指令调用 `canvas.*` / `engine.*` 工具;
3. 切换:对话/UI 激活与停用即时生效,持久化、跨会话恢复;
4. 回归:既有画布模板技能(apply 铺节点)行为不变;typecheck + 全量测试通过。