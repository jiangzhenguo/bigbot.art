# 文本节点与 Agent 分镜管线 — 产品设计与技术方案

> 版本:v1.0(调研 + 决策已确认,待开工评审)
> 日期:2026-09 · 状态:📋 设计定稿,未开工
> 关联文档:[PRD](./../PRD-BigBotArt-无限画布视频图片生成Agent.md) · [节点手册](./节点手册.md) · [连接器设计](./连接器设计.md) · [视频节点下游连接规划](./视频节点下游连接规划.md) · [调研报告](./调研报告-MiniMaxDesign与本地模型接入方案.md)
> 对标产品:LibTV(LiblibAI) · MiniMax Design · 腾讯云创意工坊 · libtv-video-agent(开源方法论)

---

## 0. 需求一句话

> **文本节点(含 Markdown 表格)作为提示词源,灌给下游图片/视频生成节点;Agent 把「一部小说」拆成「分镜剧本表」→ 逐行生成「提示词」→ 拆分铺到每个 image-gen / shot 节点。**

---

## 1. 背景与目标

### 1.1 背景

- 本项目已有 `document` 节点(Markdown Brief / 提示词容器),`MarkdownText` 渲染器**不支持表格**;`document → image-gen/shot` 的提示词注入已有**全文注入**基础(`promptFrom` + 运行期解析),但无「选段/按行」能力。
- 业内同赛道产品(LibTV、MiniMax Design、腾讯云创意工坊)已把「文本/脚本节点 → 分镜 → 生成节点」做成核心产线,且**分镜表(表格)是让人干预、保住一致性的关键中间产物**。
- h3.c 单镜头成本高(默认档 8–10 分钟/条),「先表格确认、再按行铺节点」能显著降低无效生成。

### 1.2 目标

1. **文本节点 = 提示词源**:document 升级为通用文本节点,支持 Markdown 全渲染(含表格)、表格基本操作;提示词通过连线注入下游 image-gen / shot。
2. **脚本/分镜表节点(storyboard)**:新增独立节点,以 Markdown 表格为数据载体,一行 = 一个分镜;支持「一键从表格铺生成节点」。
3. **Agent 小说 → 成片管线**:用户丢一部小说(或分镜需求)进文本节点 → Agent 生成分镜剧本表 → 确认/改表后 → 逐行拆出提示词、铺到图片/视频生成节点并连线。
4. **双模式复用**:默认「分步可干预」(先表后节点),可切「自动档」(一步到位)。

### 1.3 非目标(本期不做)

- 不做专业表格(类 Excel)能力:不提多 sheet、公式、冻结、单元格合并。
- 不做语义级视频编辑(MiniMax Design 实测翻车的那条路线)。
- 不做多 Agent 协作/校验 Agent(沿用 PRD M2 规划)。
- 不做角色资产绑定进分镜表(可配置列映射为 P2,表结构预留列即可)。

---

## 2. 对标产品拆解(与本次需求相关的部分)

### 2.1 LibTV(LiblibAI)——"人 + Agent 双平等用户"的节点工作流

| 维度 | LibTV 做法 | 对本方案的启示 |
|---|---|---|
| 节点体系 | 五类基础节点:**文本、图片、视频、音频、脚本**;双击画布放置,节点自由连线,上游输出 = 下游输入 | **文本与脚本是两类节点**:文本管提示词/设定,脚本管结构化的分镜表 |
| 脚本节点 | 三种模式:**剧本 → 分镜脚本 / 视频参考 → 分镜脚本 / 角色 → 分镜脚本**;「生成分镜」按钮批量出分镜图;分镜图一键转动态视频分镜 | 「生成分镜」= 从文本产结构化表 + 逐行铺节点,天然可拆分 |
| 工作流复用 | 节点串联成流程 →「打组」存工具箱,模板换输入即复用 | storyboard 的列映射/提示词组装规则应可存为模板(Skill)【P2】 |
| Agent 侧 | 一句话需求 → 自动生成整条工作流(剧本→角色视图→分镜→视频→配乐→终剪),返回成片 + 可操作画布;所有节点仍可手动编辑重生成 | 自动模式参照此形态;产物**必须可干预** |
| CLI/能力契约 | `libtv node create -t video/audio/script/image --prompt --left(参考槽位) -s(参数)`;单镜出片,终剪下沉 ffmpeg | 本地无云端 CLI,引擎走 Provider 抽象,但「单镜一节点」心智一致 |

### 2.2 MiniMax Design——"可干预的自动"与表格型中间产物

| 维度 | MiniMax Design 做法 | 对本方案的启示 |
|---|---|---|
| 文本节点 | 画布上文本节点点开即**文本助理 Agent**;用户文本可随时被 Agent 修改/扩写 | 文本节点不只是"显示文本",是 Agent 的**可读写工作对象** |
| 编排层 | 主 Agent 拆任务地图 + 四个专职 Agent(文案/图像/视频/音频)并行;所有产物(脚本/分镜/视频/音乐/剪辑)都是画布节点,自动连线 | 「脚本、分镜」是**节点的产出**,不是画布外的黑盒 |
| 项目级记忆 | 多轮对话可复述"确认过的人设/品牌信息";角色/场景可存资产跨项目复用 | 分镜表行可引用资产锚(角色/场景定版),锁一致性【P2】 |
| 经验教训 | 语义级视频编辑实测翻车(调色无效、换背景主体变形);画质先行不如产线顺滑 | **让用户以表格/文本形式干预中间产物**,比"改视频"可靠得多 |

### 2.3 腾讯云创意工坊——智能体节点 + 分镜表绑定

- **智能体节点**:剧本创作、角色设定、分镜制作、提示词优化、视频理解、超分——每个能力是一个可连节点。
- **分镜表绑定**:分镜表生成可绑定前序节点创建的角色形象,保证画面主体一致性。
- 单画布走完「故事与角色 → 分镜与视频 → 后期成片」。
- 启示:分镜表的**列设计**要为"一致性"服务(角色/场景参考列),生成节点时把参考图连成 `ref-image`/`first-frame` 边。

### 2.4 libtv-video-agent(开源方法论)——提示词组装的纪律

- 管线:`定调(质感词)→ 定版资产(角色/场景/道具)→ 黑白九宫格故事板 → clean → 单镜 image2video → 抽帧自查 → 拼预览 → ffmpeg 终剪`。
- 19 条 prompt 铁律:角色不混、比例锁定、零文字、场景锁定、正面穷举、服装渗透等。
- 启示:按行组装提示词时,**质感词/角色锚/场景锚应作为"全局段"注入每一行**,避免逐行自由发挥破坏整体一致性(本项目已有 H3 五段式 / Z-Image 六段式模板,可承载)。

---

## 3. 已确认决策(2026-09 用户拍板)

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 节点形态 | **document 升级为通用文本节点(含表格)+ 新增独立「脚本/分镜表」storyboard 节点**(LibTV 式分工) |
| D2 | 表格能力 | 渲染 + 单元格编辑 + 增删行列 + 剪贴板粘贴导入(CSV/TSV/表格文本) |
| D3 | 提示词桥接 | Markdown 标记选段 + 全文兜底(` ```prompt ` 块 / `#shot-N` 标题块;无标记 = 全文注入,沿用现有 `promptFrom`) |
| D4 | Agent 流程 | 分步(默认,先表后节点可干预)与自动(一键全铺)双模式,设置可切 |
| D5 | 拆分粒度 | 分镜表带「需配图」列,按行决定是否创建 image-gen 节点(配图 → shot 首帧直通) |
| D6 | 文档深度 | 产品设计 + 详细技术方案(本文件),含渲染库选型、数据模型、API、里程碑 |

---

## 4. 节点模型设计

### 4.1 `document` 升级 —— 通用文本节点

**定位**:提示词源 + 自由文本(Markdown Brief、小说原文、设定文档)。

**数据字段**(保持 `NodeDataMap.document`,不破坏旧快照):

```ts
{ markdown: string }   // 完整 Markdown 文本;表格是其中的一种块
```

**新增能力**:
- `MarkdownText` 渲染升级:支持 **GFM 表格块**(`| a | b |`)与**表格编辑**。
- 检查器(`InspectorBody`)升级:
  - 保留 Markdown 源码 textarea(已有);
  - 渲染预览区支持「表格块 → 可编辑表格」:点击单元格原地编辑、表格工具条(增删行列、粘贴导入);
  - 「从文件导入 .md/.txt」按钮(读入 markdown;也与资产中心 `kind:'document'` 资产打通)。
- 节点卡片(`renderBody`):有表格时显示「表格概览」(列头 + 前 N 行行数),替代现在"首行标题 + 120 字"预览。

**连线(维持现有端口,语义增强)**:
- 作为上游:→ `image-gen`/`image-edit`/`shot`/`director`(`prompt`,由 `promptFrom` 记录注入来源)+ 标记选段。
- → `workflow-input`(text 槽位):现有全文注入不变;有选中块时注入选中块【P1】。

### 4.2 `storyboard` 新增 —— 脚本 / 分镜表节点

**定位**:结构化分镜剧本,以 **Markdown 表格**为数据载体,是「表格 → 生成节点」管线的心脏。一行 = 一个分镜。

**NodeKind 新增**:`'storyboard'`

**数据字段**(新增 `NodeDataMap['storyboard']`):

```ts
{
  markdown: string;                 // 完整 Markdown:标题 + 说明 + 分镜表格(GFM)
  basePrompt?: string;              // 全局质感段(质感词/风格,铺节点时注入每行)
  columnMap?: Record<string, string>; // 可选:表列名 → 语义槽位(镜号/画面/对白/景别/运镜/时长/需配图/提示词)【P1 可配置】
}
```

**默认表格 schema**(第 0 版固定列,列映射 P1 放开):

| 镜号 | 画面描述 | 对白/旁白 | 景别 | 运镜 | 时长(s) | 需配图 | 提示词(可选) |
|---|---|---|---|---|---|---|---|
| 1 | 草原上男女主并行 | 「我们走吧」 | 全景 | 横移 | 5 | 是 | (空,自动组装) |
| 2 | 遇河,女主跃过 | 无 | 中景 | 仰拍 | 6 | 是 | (空) |

- `镜号`:自动编号(增行自动续号,删行不影响其他行内容)。
- `需配图`:是/否(默认是)——决定铺节点时是否创建 image-gen 节点。
- `提示词(可选)`:有值 → 铺节点时直接使用;为空 → 由组装器从「画面描述/对白/景别/运镜/时长」+ 全局 `basePrompt` 组装(H3 五段式 / Z-Image 六段式)。

**显示**:
- 卡片:表格首屏预览(列头 + 前 2-3 行 + 行数徽标)。
- 检查器:新 `StoryboardInspector`,表格编辑器为主视图(见 §5.3),头部有 `basePrompt` 输入。

**连线**:
- 作为上游:→ `image-gen` / `shot` / `edit` / `timeline` / `director`(端口 `prompt`/`clip`,取自表格按行物化)。
- 作为下游:接收 `document`(剧本/小说,`prompt`)、`workflow-input`(text 槽位)。
- **边 label 约定**:沿用端口锚定 `prompt` + `data.promptFrom = { nodeId, mode:'row', row }` 追溯来源;显式 `row-N` label 仅为可读性辅助。

**与 document 的关系(分工)**:
| | document | storyboard |
|---|---|---|
| 核心 | 自由文本(含表格),提示词源 | 分镜剧本表,批量生成编排 |
| 表格 | 中/轻量展示与编辑 | 一等公民,进检查器主视图 |
| 典型用法 | 小说原文 / Brief / 设定 | Agent 产出的分镜剧本 / 用户自建分镜表 |

---

## 5. 表格能力设计(文本节点与分镜表共用)

### 5.1 渲染(MarkdownText 扩展)

在现有零依赖渲染器上增加**块级「表格」分支**:

```
识别:连续行匹配 /^\s*\|.*\|\s*$/ 且第二行是对齐分隔(|---|:---:|---|)
解析:headers / align(忽略,统一默认左对齐) / rows: string[][](管道转义 \| 处理)
渲染:<table> + <thead> + <tbody>,沿用 var(--border-soft)/var(--surface) 样式
```

抽出为可复用组件 `MarkdownTable`(纯展示)与 `TableEditor`(可编辑),二者共用同一份 `TableData` 类型与 GFM 序列化器(见 §5.4)。

### 5.2 基本操作(TableEditor)

| 操作 | 交互 |
|---|---|
| 单元格编辑 | 单击单元格进入 input 编辑(失焦/回车提交);需配图列用 是/否 下拉 |
| 增行/删行 | 表格工具条「+ 行 / − 行」;删除前确认该行已铺节点时提示(仅提示,不级联删节点) |
| 增列/删列 | 工具条「+ 列 / − 列」;删列提示该列是否被 `columnMap` 引用 |
| 粘贴导入 | 在表格内 Ctrl/Cmd+V:自动识别 TSV / CSV / GFM 表格文本 → 弹「追加 / 替换当前表」二选一(默认追加) |
| 导出 | 复制为 GFM 表格文本 / CSV(工具条按钮,进剪贴板)【P2】 |

- 粘贴导入由 `onPaste` 解析 `clipboardData` 的 text/plain(TSV 自带)与 text/html(有 `<table>` 时走 HTML 表解析)。
- 所有编辑 → `TableData` → 防抖(≈300ms)序列化回写 `data.markdown` 中的表格块(原位替换),保持其余 Markdown 不动。

### 5.3 两个入口的用法差异

- **document 检查器**:源码 textarea 为主;预览区右下角提供「进入表格编辑」切换(检测到表格块时)。
- **storyboard 检查器**:表格编辑器即主视图(所见即所得);源码视图为次级 tab,满足"想手写 Markdown"的用户。

### 5.4 TableData 与序列化(共享工具)

```ts
// packages/shared/src/table.ts(新增,零依赖)
export interface TableData {
  headers: string[];
  rows: string[][];          // 不含分隔行
}
export function parseGfmTable(md: string): TableData | null;      // 提取首个表格块(或提供表格块内解析)
export function tableToGfm(t: TableData): string;                 // 序列化回 GFM
export function parseClipboard(text: string): string[][] | null;  // TSV/CSV/GFM → 二维数组
```

> 表格块在 storyboard 的 `markdown` 中**是唯一数据区**;解析时定位首个表格块,编辑后原位替换。多表格块【P2】。

---

## 6. 提示词桥接设计

### 6.1 现状盘点(调研确认)

- `connectors.ts` 已声明 `document → image/shot/edit/director` 端口 `prompt`;
- `CanvasPage` 统一边分派已实现 **全文注入**:连边时写 `data.promptFrom = { nodeId }`,`runNode` 运行期在目标自身 `prompt` 为空时注入 source 的 `markdown` 全文;
- 缺:**选段能力、表格行级驱动、storyboard 节点本身**。

### 6.2 选段语法(标记选段 + 全文兜底)

`promptFrom` 扩展为:

```ts
// 原 typeof: { nodeId: string }
// 新 typeof:
interface PromptSource {
  nodeId: string;
  mode: 'full' | 'block' | 'row';
  blockId?: string; // mode='block': 'prompt' | 'shot-<N>'(标题块 #shot-N)
  row?: number;     // mode='row': 表格行号(1 起,跳过表头)
}
```

**选取规则(优先级从高到低)**:

1. ` ```prompt ` 代码块(语言标记为 `prompt`)→ 块内文本即提示词(mode=`block`, blockId=`prompt`);
2. `#shot-N` / `## 镜头N` 标题块 → 该标题下到下一个同级标题之间的正文(mode=`block`, blockId=`shot-N`);`N` 同时可对应 storyboard 表格行号;
3. 无标记 → 全文注入(现状, mode=`full`)。

- 分派逻辑升级:连 `document → image-gen/shot` 边时,不再只存 `{ nodeId }`,而是**解析 source markdown 判断命中规则**,一次性写入 `promptFrom`。
- `runNode` 运行期解析同步升级:按 `mode` 取段;**选中块为空时回退全文**。
- 用户可在目标节点检查器看到「提示词来源:文档 · ```prompt 块(#2)」并一键「改为全文 / 换块」。

### 6.3 表格行驱动(storyboard → 生成)

铺节点(§7.4)物化提示词时:

- 目标节点写 `data.prompt` = 组装结果(显式值),并记 `data.promptFrom = { nodeId: storyboardId, mode: 'row', row }`;
- 边 label 用现有 `prompt`(端口锚定不变),边本身是**来源追溯**而非唯一数据通道 → 运行期零侵入,即使边断了产物参数仍在(可复现);
- 「重新同步」按钮(= 铺节点的幂等变体):按当前表格重新组装 prompt 写回目标节点并标 `stale`,**不重建/不删节点**;表格新增行 → 提示「将为新增行创建 N 个节点」。

---

## 7. Agent 分镜管线设计(小说 → 分镜剧本 → 提示词 → 节点)

### 7.1 两种模式

| 模式 | 流程 | 交互 |
|---|---|---|
| **分步(默认)** | ①小说/需求进文本节点 → ②Agent 生成 storyboard 节点(表格) → ③用户检查/改表(+改 basePrompt) → ④点「从分镜表生成节点」→ ⑤逐行铺 image-gen/shot + 连线 | 每步可打断;④前零生成成本 |
| **自动** | ① → ②' → ④' 一气呵成(Agent 直接出表 + 铺节点) | 设置里切「自动档」;表格仍可事后改 + 重新同步 |

- 入口:Agent 面板自然语言(「把这篇小说做成 1 分钟短片」);或 storyboard 节点菜单「✍ Agent 生成分镜」;或 document 节点菜单「📋 生成分镜表」。
- 自动模式下 Agent 的 report 会说明拆镜思路,用户可整体撤销(移除本次新增的全部节点)【P1】。

### 7.2 输入与上下文

- 输入:document / storyboard 节点的 `markdown` + 目标时长 + 可选质感段(`basePrompt` 或 Skill)。
- Agent 不需要读整本小说时可由用户先选中段落(标记选段同款 ` ```prompt ` / `#shot-N`),未选 = 全文。

### 7.3 Agent 产出(storyboard 表格)

Agent 按「导演规则」输出(沿用 `SYSTEM_PROMPT` 风格,新增 storyboard 分支):

1. 剧本摘要(若干行说明,可含角色/场景定版引用);
2. **分镜表格**:每行 = 一场/一镜(默认列见 §4.2);
3. 一致性纪律继承 h3 用法:人物镜头 `reuse 1 / layers 50`、身份措辞显式锁定、质感词只出现一次(set 到 `basePrompt`,不逐行漂移)。

**规划器形态选择**:新增 `plan-storyboard` 方法(新 `PlanStoryboardResult`),**保留旧 `plan` 兼容**(旧 plan 目前只发 document→shot `scene-brief` 边,不受影响)。

```ts
// packages/agent/src/protocol.ts 新增
interface PlanStoryboardParams extends PlanParams { story?: string; basePrompt?: string; autoMaterialize?: boolean }
interface PlanStoryboardResult {
  storyboard: CanvasNode;        // kind='storyboard', data.markdown = 标题 + 摘要 + 表格
  images: CanvasNode[];          // 需配图=是 的行 → image-gen(mode=auto 时;分步模式为空)
  shots: CanvasNode[];           // 每行一个 shot(mode=auto 时;分步模式为空)
  edges: CanvasEdge[];           // storyboard→image-gen / storyboard→shot / image-gen→shot(first-frame)
  report: string;
}
```

- `SYSTEM_PROMPT` 增加 storyboard JSON schema 约束(表头固定 + 行规则:不超 15s/镜、长片按时长切片)。
- `deterministicPlanner` 同步补 `planStoryboardDeterministic` 兜底(LLM 不可达时给模板表格)。
- worker / protocol / manager 路由新增 `plan-storyboard`。

### 7.4 铺节点(materialize)——表格 → 生成节点

对表格每行(纯前端执行,不消耗 LLM):

```
对每行 r:
  1. 组装提示词:
     行「提示词」列有值 → 直接用;
     否则 assemblePrompt(row, basePrompt, kind)      // §7.5
  2. shot 节点:
     kind='shot', data.prompt=组装结果, data.promptFrom={nodeId, mode:'row', row}
     aspect/时长:行「时长」列 → seconds;画幅取全局默认(检查器可选)
     tier:默认档(可批量改成预览档先看构图)
  3. 若「需配图」= 是:
     image-gen 节点:data.prompt = 行「画面描述」→ Z-Image 六段式
     边 image-gen → shot(label=first-frame,静帧直通,复用现有端口)
  4. 连线:storyboard → shot / storyboard → image-gen(label=prompt)
  5. 可选:shot → timeline(入线,按行序)【P1】;「需配图」行同时 timeline 接 image-gen【P1】
```

- 布局:铺节点时按网格错开坐标(行 → 列/行递增),避免叠放;沿用 `makeNodeId` 唯一 id 机制。
- **撤销支持**:铺节点是一次原子操作,可整体撤销(记录本次新增节点 id 集)。【P1】

### 7.5 提示词组装(assemblePrompt)

```ts
// packages/shared/src/prompt.ts(新增,渲染层与 agent 共用,零依赖)
export function assembleH3Prompt(row: TableRow, basePrompt?: string): string
export function assembleZImagePrompt(row: TableRow, basePrompt?: string): string
```

- **H3 五段式**(shot):
  ```
  Scene: 场景地点(画面描述 + 景别落位)
  Action: 动作与对白(画面描述 + 对白/旁白)
  Camera: 运镜(景别 + 运镜列;默认固定镜头)
  Look: 风格/质感(basePrompt 或默认)
  Audio: 音效提示(H3 带声直出;对白列有值时提示口型)
  ```
- **Z-Image 六段式**(image-gen,参考 image-prompt-writer 公式):主体 / 场景 / 构图 / 光影 / 风格 / 约束,输入取 画面描述 + 景别 + basePrompt。
- `basePrompt` 为空时给内置默认质感段(「电影感,自然光影,写实」),保证不是空 prompt。

---

## 8. 技术方案

### 8.1 涉及改动清单(按层)

| 层 | 文件 | 改动 |
|---|---|---|
| 领域类型 | `packages/shared/src/domain.ts` | `NodeKind` + `'storyboard'`;`NodeDataMap['storyboard']`;`PromptSource` 类型(实测现有 `promptFrom` 是 `{nodeId?}` 匿名结构,建议收敛为具名类型) |
| 共享工具 | `packages/shared/src/table.ts`(新) | `TableData` / `parseGfmTable` / `tableToGfm` / `parseClipboard` |
| 共享工具 | `packages/shared/src/prompt.ts`(新) | `assembleH3Prompt` / `assembleZImagePrompt` |
| 渲染器 | `apps/desktop/src/renderer/src/components/MarkdownText.tsx` | 表格块解析 + `<table>` 渲染 |
| 表格组件 | `apps/desktop/src/renderer/src/components/TableEditor.tsx`(新) | 单元格编辑 / 增删行列 / 粘贴导入 / GFM 回写 |
| 节点注册 | `apps/desktop/src/renderer/src/pages/canvas/constants.ts` | `NODE_TYPES` 加 storyboard 条目;`COMPAT` 加源/目标兼容项 |
| 连接器 | `apps/desktop/src/renderer/src/pages/canvas/connectors.ts` | `BY_KIND` 加 `storyboard` 源行(→ image/shot/edit/director/timeline)与 document→storyboard;`resolvePort` 兼容 |
| 分派/运行期 | `apps/desktop/src/renderer/src/pages/CanvasPage.tsx` | `promptFrom` 写入扩展(mode/blockId/row);`runNode` 按 mode 取段;storyboard 卡片渲染 |
| 默认数据 | `apps/desktop/src/renderer/src/pages/canvas/node-mapping.ts` | `makeInitialData` 加 storyboard 默认(`markdown`: 表头模板) |
| 检查器 | `apps/desktop/src/renderer/src/pages/canvas/inspector/` | document 检查器加表格编辑入口;新增 `StoryboardInspector`(表格主视图 + basePrompt) |
| 规划器 | `packages/agent/src/pi-planner.ts` / `plan.ts` / `protocol.ts` / `worker.ts` / `manager.ts` | `plan-storyboard` 方法 + `PlanStoryboardResult` + SYSTEM_PROMPT storyboard 分支 + 确定性兜底 |
| 主进程路由 | `apps/desktop/src/main/index.ts` | 注册 `plan-storyboard` IPC / 工具路由 |
| 资产导入 | `assets` 页 / 文件读入 | document 导入 .md/.txt(读文件 → markdown)【P1】 |

### 8.2 表格渲染/编辑选型对比

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **A. 零依赖手写**(与现 MarkdownText 一致) | 无依赖树;GFM 表格子集实现约 200–300 行;与项目风格统一;可完全控制样式/交互 | 需自写解析与序列化;仅覆盖本需求子集 | ✅ **推荐** |
| B. 引入 `markdown-it` + 表格插件 | GFM 全量合规;生态成熟 | 引入依赖树与项目「轻量无第三方依赖」声明冲突;表格编辑仍需自写 | 暂不采用(可留作 Markdown 需求膨胀时的升级路径) |
| C. 成熟表格组件(tanstack/AG-Grid 等) | 交互丰富 | 过重;与本地优先/轻量定位不符 | 不采用 |

> 落点:A。若后续 Markdown 面扩张(任务列表/删除线/引用块等),再评估 B(替换 `MarkdownText` 内核,`TableEditor` 外壳不变)。

### 8.3 数据一致性要点

- **表格是 Markdown 的投影**:所有编辑唯一真源 = `data.markdown`;表格编辑回写是"替换 markdown 中的表格块",避免双向状态漂移。
- `promptFrom` 具名化后,旧快照(`{ nodeId }` 匿名)在解析时按 `mode:'full'` 兼容,零迁移成本。
- storyboard 行删除不级联删下游节点(只提示),符合「画布可干预」原则。

### 8.4 资源与成本护栏

- 铺节点默认 `tier='default'`(768²/30 步 ≈ 8–10 分钟/条);提供「先铺预览档(256²/4 步,秒级)看构图」批量动作,与现有 `RES` 档位矩阵一致。
- 图片/视频槽位互斥不变;批量铺节点只建节点**不触发运行**(生成须用户逐节点或批跑),避免误烧资源。

---

## 9. 里程碑

| 阶段 | 内容 | 交付 |
|---|---|---|
| **M1(本期)** | document 表格渲染/编辑/粘贴导入;storyboard 节点(表格主视图);`promptFrom` 选段扩展(` ```prompt `/`#shot-N`/全文兜底);plan-storyboard 分步模式(先表后节点);铺节点(需配图列、组装器、连线、材质词 basePrompt) | 小说 → 分镜表 → 确认 → 一键铺节点(图/视频/连线)可跑 |
| **M2** | 自动模式(一键全铺 + 可撤销);批量「先预览档」;`重新同步`(表格改 → 重组 prompt 标 stale);storyboard → timeline 入线;document 导入 .md/.txt;列映射 `columnMap` 可配置 | 分步/自动双模式齐备,表格可反复迭代 |
| **M3** | 分镜表列映射存 Skill;角色/场景锚(资产)绑定进表格行;storyboard 多表块;导出 CSV/GFM | 复用与一致性强化 |

---

## 10. 验收标准(可测)

- [ ] text 节点:粘贴带表格的 Markdown 能正确渲染表格;双击单元格可编辑;增删行列生效;粘贴 CSV/TSV 追加成功;编辑后 `data.markdown` 的表格块被原位更新。
- [ ] document → shot / image-gen 连线:无标记 → 全文注入(现状保持);有 ` ```prompt ` 块 → 只注入该块;`#shot-2` → 注入标题 2 下正文;目标自身有 prompt → 不覆盖。
- [ ] Agent 分步:一部小说 → 生成 storyboard 节点(表格 ≥ 2 行,列头符合默认 schema)→ 改表(改时长/需配图)→ 铺节点:每行一个 shot,需配图=是的行多一个 image-gen 且连 `first-frame`;提示词 = 组装后的 H3 五段式 / Z-Image 六段式。
- [ ] 自动模式:一步出表 + 铺完节点;整次操作可撤销。
- [ ] 资源:铺节点不自动触发运行;批量「预览档」动作存在;图片/视频槽位互斥保持。
- [ ] 兼容:旧画布快照(document 节点、匿名 promptFrom)打开无异常。

---

## 11. 信息来源

- 量子位《龙虾也能当导演了!LibTV 解锁全自动拍片,一句话从剧本干到成片》:https://www.qbitai.com/2026/03/390320.html
- LibTV 官网:https://www.liblib.tv/ · GitHub(libtv-labs/libtv-skills):https://github.com/libtv-labs/libtv-skills
- libtv-video-agent(跨工具视频制作 Agent 方法论):https://github.com/PomeloR611/libtv-video-agent
- 爱范儿《MiniMax Design 来了,视频模型也有了自己的 Codex》:https://www.ifanr.com/1675657
- AI星球《MiniMax Design 评测:把 H3 装进产线,一句话出片到底行不行》:https://www.aixq.cc/66428.html
- 腾讯云《腾讯云创意工坊:一站式 AIGC 工作流实现专业级 AI 漫剧生产》:https://cloud.tencent.com.cn/developer/article/2680522
- 本地参考:PRD(§5.1.2 节点类型 / §5.2.1 规划 Agent)· 调研报告(§1.2 MiniMax Design 五大模块)· 节点手册(§3.1 document)· 连接器设计(§5 端口表)