# Agent 技能文档 — 撰写指南与模板

> 状态:定稿(2026-09)
> 配套:能力设计与注入机制见 `docs/Agent技能-指令模板与对话自动加载-产品设计与技术方案.md`。
> 本文件回答「技能文档(`Skill.instructions`)长什么样、怎么写」——给人类作者与 AI 共同使用的
> 撰写规范 + 可复制模板 + 真实示例。

## 1. 技能文档是什么

技能文档 = `Skill.instructions`(一段 Markdown 操作手册)。技能被**激活**到画布后,
这段 Markdown 会以「【当前技能】<名称> 的操作指令:」注入 Agent 系统上下文
(`memory.buildContext`),之后的对话 Agent 会按这份手册调用 `canvas.*` / `engine.*` /
`storyboard.*` 等工具干活。

- 保存方式:`skills.save` 时带 `instructions`,或在 Skills 页指令编辑器(P2 起)写作/修改;
- 注入模式:`inject='full'`(全量注入,默认)或 `'summary'`(上下文只放 160 字摘要,完整文档用 `skills.read` 按需读);
- 参数占位:文档内可用 `{主题}` `{时长}` 等占位,保存/激活时会自动收集进 `Skill.params`。

## 2. 结构规范(推荐的段落顺序)

```markdown
---
name: 技能名(中文,与 Skills 页卡片一致)
desc: 一句话适用场景(LLM 判断「这单活是否用本技能」;skills.list 展示)
params: 逗号分隔的 {占位} 名(主题, 旁白, 时长)
inject: full | summary        # 可选,缺省 full
---

## 任务流程(核心:工具调用 SOP,按序执行)

第 1 步:用 XXX 工具做 XXX;缺什么信息用 ask.user 补齐
第 2 步:…

## 措辞/模板段(提示词风格约束,铺节点时注入)

主体:… 场景:… 构图:… 光影:… 风格:… 约束:…

## 一致性锁定(跨镜不变量)

{角色} 每镜同衣饰同配色…

## 红线(本技能补充;不豁免系统红线)

- 重跑/删除产物前必须 ask.user 确认(系统级,可重复声明)
```

### 2.1 元信息块(Frontmatter)

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 显示名,对话里 Agent 引用技能时用这个名字 |
| `desc` | ✅ | 适用场景一句话。**LLM 主要靠它决定是否启用本技能**,要写清「做什么、什么风格、什么流程」 |
| `params` | 建议 | `{占位}` 参数清单,应用/激活时替换;缺项 Agent 应 `ask.user` 补齐 |
| `inject` | 可选 | `full`(缺省)全量注入 / `summary` 摘要 + `skills.read` |

### 2.2 任务流程段(最重要)

把「这单活怎么干」写成**工具名明确、顺序明确**的步骤。Step 里直接写工具名 + 何时用:

- 用哪个工具:`canvas.list_nodes` / `document.read` / `storyboard.plan` / `storyboard.materialize` / `engine.submit` / `timeline.export`…
- 什么时候停下来问用户:必须 `ask.user`,不能正文写问句
- 什么参数:档位(preview/default)、画幅(16:9/9:16/1:1)、次数

### 2.3 措辞/模板段

铺节点时 Agent 会把这段风格措辞注入每行提示词(与 H3 五段式 / Z-Image 六段式兼容):

- 主体 / 场景 / 构图 / 光影 / 风格 / 约束 六段齐全,约束段锁定身份与材质

### 2.4 红线段

写「本技能特有的操作约束」。**注意**:系统级红线(删除/重跑前 `ask.user` 确认、操作前 `canvas.list_nodes` 现拉节点 id、`ask.user` 是唯一提问通道)不因技能豁免,技能文档只做补充/强调,不能反着写。

## 3. 可用的工具速查(撰写时引用)

| 域 | 工具 | 用途 |
|---|---|---|
| 画布 | `canvas.list_nodes` / `canvas.get_node` / `canvas.create_node` / `canvas.update_node` / `canvas.delete_node` / `canvas.connect` / `canvas.disconnect` / `canvas.connectors` | 建/改/连/删节点 |
| 文档 | `document.read`(chunk 分段) | 读长剧本/需求全文 |
| 分镜 | `storyboard.plan` / `storyboard.materialize` | 出分镜表 / 按行铺节点 |
| 引擎 | `engine.submit` / `engine.queue_status` / `engine.cancel` + `accel.list`(加速包) | 提交/管理生成 |
| 资产 | `assets.list` / `assets.get` / `assets.import` | 资产库 |
| 技能 | `skills.list` / `skills.read` / `skills.activate` / `skills.deactivate` / `skills.apply` / `skills.save` | 技能自身 |
| 时间线 | `timeline.export` | 合成导出 |
| 记忆 | `memory.update_core` / `memory.remember` / `memory.recall_search` | 项目记忆 |
| 连续 | `continuity.check` | 尾帧/首帧连续性 |
| 交互 | `ask.user` | **唯一**提问通道 |

## 4. 完整模板(可直接复制)

```markdown
---
name: <技能名>
desc: <一句话:做什么 · 什么风格 · 什么流程>
params: <占位1>, <占位2>
---

## 任务流程

1. 读需求:`canvas.list_nodes` 找到 document 节点,`document.read` 读全文
   (先 chunk=0 看结构再逐段读);提取 {占位1}/{占位2},缺项用 `ask.user` 补充。
2. 规划:`storyboard.plan`(brief 给融合后的文案,basePrompt 用下方措辞段);默认分步只出表。
3. 铺节点:`storyboard.materialize`(画幅/档位按需);已铺过的行自动跳过。
4. 生成:逐节点 `engine.submit`,每批先 `ask.user` 确认范围与档位,不闭眼批跑。
5. 收尾:`timeline.export`,核对产物是否齐全。

## 措辞段

主体:<主体描述>
场景:<场景描述>
构图:<构图规则>
光影:<光影片场>
风格:<风格关键词>,
约束:<约束(身份锁定/材质排除等)>

## 一致性锁定

- <跨镜不变量,如角色衣饰/配色/构图>

## 红线

- <本技能补充约束;系统红线(删除前 ask.user 等)不豁免>
```

## 5. 示例

### 5.1 纸拼贴剧情片

```markdown
---
name: 纸拼贴剧情片
desc: 纸拼贴风格竖屏剧情短片;双角色锁定 + 5 镜头结构 + 拼贴材质措辞
params: 主题, 旁白, 时长
---

## 任务流程

1. 读需求:`canvas.list_nodes` 找 document 节点,`document.read` 读全文;
   提取 {主题}/{旁白}/{时长},缺项 `ask.user` 补齐。
2. 规划:`storyboard.plan`,brief 给 {主题}+{旁白} 融合文案,basePrompt 用下方措辞段;
   默认分步只出表,不直接铺。
3. 铺节点:`storyboard.materialize`(aspect=9:16,tier=preview);「需配图=是」的行自动多建
   image-gen 首帧,保持 5 镜头结构,不新增不合并。
4. 生成:逐节点 `engine.submit`,每提交一次先 `ask.user` 确认档位与范围。
5. 收尾:`timeline.export`,核对 5 镜产物齐全。

## 措辞段

主体:剪贴画拼贴质感,旧杂志纸张撕边,色纸叠加,保留纸纹与胶水痕迹
场景:疏朗留白,主体居中偏左,边缘不规则纸缘
构图:平光无强烈阴影,纸张哑光
风格:纸拼贴剧情片,镜头节奏 2-3 秒一镜
约束:{角色} 身份措辞锁定,不得出现金属/玻璃等非纸材质拟真

## 一致性锁定

- {角色} 每镜同衣饰同配色,跨镜不换装

## 红线

- 重跑任一镜前 `ask.user` 确认;节点 id 一律 `canvas.list_nodes` 现拉
```

### 5.2 电商产品(多视角管线)

```markdown
---
name: 电商产品
desc: 产品三视角批量管线(白背景棚拍风);浅灰背景 + 居中构图 + 逐视角生成
params: 产品, 视角
---

## 任务流程

1. `ask.user` 确认 {产品}(资产库选择或文本描述)与 {视角}(如:侧视/开盖/场景)。
2. 每个视角建一个 image-gen 节点(`canvas.create_node`,prompt 用下方措辞段 + 视角),
   全部接入同一 asset 输入。
3. 每个视角提交 `engine.submit`,全部成功后再出时间线。

## 措辞段

主体:{产品},电商白底棚拍,浅灰背景,产品居中
构图:产品占画面 70%,底部留 15% 阴影区
光影:顶侧柔光,阴影柔和,无反光杂点
风格:电商产品摄影,写实,高分辨率
约束:不出现文字/水印;{视角} 视角精确,不旋转产品

## 一致性锁定

- 三视角背景色、光照方向、产品朝向必须一致

## 红线

- 任一视角失败须报告并重试,不静默跳过
```

### 5.3 科普讲解(图文穿插)

```markdown
---
name: 科普讲解
desc: 旁白驱动的图文穿插科普短片;每行=画面+旁白,数据图示占位
params: 主题, 旁白, 时长
---

## 任务流程

1. `document.read` 读需求;按 {旁白} 拆 5-8 段,每段一张画面(1:1)。
2. `storyboard.plan` 生成分镜表(行=画面+旁白),数据图示列留占位。
3. 铺节点后逐镜 `engine.submit`,有图示的镜在 image-gen prompt 标注「含数据图表」。
4. `timeline.export` 合成,图表镜检查旁白时长对齐。

## 措辞段

主体:{主题} 相关图示画面,矢量图表+实拍混排
构图:图表居中,标注文字大而清晰
风格:科普讲解,明亮色调,扁平图示
约束:数据准确,不加夸大文案

## 红线

- 数据数值不得虚构;旁白与画面必须一一对应
```

## 6. 撰写检查清单

- [ ] `name`/`desc` 写了,desc 能一眼判断适用场景
- [ ] 任务流程里**每一步都写了工具名**,顺序明确
- [ ] 需要用户决策处写明「`ask.user`」,不是正文问句
- [ ] 措辞段六要素(主体/场景/构图/光影/风格/约束)齐备或明确不适用
- [ ] 跨镜一致性规则已写(多镜技能)
- [ ] 占位符 `{…}` 与 `params` 一致
- [ ] 红线只做补充,不试图豁免系统红线
- [ ] full 模式文档控制在 ~4000 字符内;更长请用 `inject: summary`

## 7. 与技能系统的对应

| 技能文档要素 | 系统落点 |
|---|---|
| `---` 元信息 | `Skill.name` / `Skill.description` / `Skill.params`(`skills.list` 展示) |
| 正文(流程/措辞/红线) | `Skill.instructions`(激活后注入 buildContext「【当前技能】」段) |
| `inject: summary` | 上下文只放 160 字摘要 + `skills.read` 按需取全文 |
| `{占位}` | 保存时收集进 `Skill.params`,应用/激活时替换 |