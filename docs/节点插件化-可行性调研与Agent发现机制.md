# 节点插件化：可行性调研与 Agent 发现机制

> 调研日期：2026-11-01
> 整理日期：2026-11-02
> 状态：可行性调研 + 首版垂直切片实现（本分支）
> 范围：BigBotArt 画布节点插件的安装、注册、展示、连线、执行、持久化，以及 Agent 如何发现和使用插件节点
> 实施说明：实际安装目录、manifest 字段、执行器 Interface 与验证命令见 [节点插件：使用与开发指南](./节点插件-使用与开发指南.md)。

## 1. 结论

**节点可以做成可安装插件，现有架构不需要推翻，但需要先补一个统一的“节点注册与执行层”。**

当前项目已经具备以下可复用基础：

- 画布、节点、连线和业务数据的 JSON 持久化；
- Take 历史、任务状态、进度和取消语义；
- Provider 注入机制；
- Agent worker 子进程与 JSON-RPC 模式；
- Skill 文件夹 / zip 导入与危险路径过滤；
- 产物、资产、ffmpeg 读取目录的白名单机制。

但当前一种可运行节点的实现分布在面板、卡片、检查器、默认值、连线、运行、Agent 提交等多个内置分支中，**并不是增加一个动态 `import()` 就能完成插件化**。

推荐首版采用：

> **声明式节点定义 + 通用节点 UI + 受控的主进程 / 插件宿主执行器。**

首版不建议：

- 允许第三方 React 代码直接进入画布渲染进程；
- 开放不受限的插件市场；
- 把每种插件节点都伪装成一个 Provider；
- 为每种插件节点单独增加一个 LLM 工具；
- 一次性迁移全部内置节点。

## 2. 目标与非目标

### 2.1 首版目标

用户显式安装一个本地插件后，可以：

1. 在节点面板看到新节点；
2. 将节点加入画布并编辑其参数；
3. 按插件声明的端口与媒体类型连接现有节点；
4. 从画布手点运行；
5. 让 Agent 发现、创建、连接并提交该节点；
6. 获得统一的 Take、进度、失败和产物回写；
7. 重启后恢复节点；
8. 停用、卸载或缺少插件时保留项目数据，并明确提示不可运行。

### 2.2 首版非目标

- 第三方自定义 React 卡片和检查器；
- 不受限 npm 依赖安装；
- 自动从项目包下载并执行插件；
- 浏览器远程客户端向宿主机上传并执行插件；
- 完整插件市场、签名分发和自动更新体系；
- 将所有内置节点立即重写到新插件 Interface 上。

## 3. 当前实现与插件化差距

### 3.1 类型与业务数据是封闭定义

`NodeKind` 是内置字符串联合，`CanvasNode.data` 又通过 `NodeDataMap[NodeKind]` 与内置类型绑定：

- [packages/shared/src/domain.ts#L9-L49](../packages/shared/src/domain.ts#L9-L49)
- [packages/shared/src/domain.ts#L150-L200](../packages/shared/src/domain.ts#L150-L200)

这意味着仅让插件返回一个新 kind 字符串并不足够，还需要：

- 内置 kind 与插件 kind 的命名空间；
- 插件业务数据的运行时 Schema 校验；
- 保留内置节点现有 TypeScript 类型精度；
- 对未注册 kind 的明确拒绝和只读降级。

建议插件 kind 使用：

```text
plugin:<插件 id>:<节点名>
```

例如：

```text
plugin:acme-media:audio-extract
```

版本不建议直接编码进 kind，否则每次插件升级都会让旧节点变成另一种节点。插件 id/version 应作为节点元数据单独保存。

### 3.2 节点入口来自静态清单

节点面板和「+」弹层使用静态 `NODE_TYPES`：

- [apps/desktop/src/renderer/src/pages/canvas/constants.ts#L20-L35](../apps/desktop/src/renderer/src/pages/canvas/constants.ts#L20-L35)

因此仅完成主进程插件加载，Agent 或 UI 仍不会自动看到新节点。需要把内置定义与已启用插件定义合并成同一份动态节点清单。

### 3.3 卡片和检查器按 kind 分派，但已有通用降级

卡片使用 `switch (n.kind)`：

- [apps/desktop/src/renderer/src/pages/canvas/nodes/NodeBody.tsx#L42-L52](../apps/desktop/src/renderer/src/pages/canvas/nodes/NodeBody.tsx#L42-L52)

检查器使用 `switch (node.kind)`：

- [apps/desktop/src/renderer/src/pages/canvas/inspector/InspectorBody.tsx#L96-L168](../apps/desktop/src/renderer/src/pages/canvas/inspector/InspectorBody.tsx#L96-L168)

两者已经具有默认分支：

- [NodeBody 默认展示](../apps/desktop/src/renderer/src/pages/canvas/nodes/NodeBody.tsx#L604-L630)
- [InspectorBody 默认展示](../apps/desktop/src/renderer/src/pages/canvas/inspector/InspectorBody.tsx#L1122-L1127)

这对插件化是有利条件：首版可以直接实现“通用插件卡片 + Schema 驱动检查器”，不必允许插件提供 React 代码。

### 3.4 默认值也有内置分派

`makeInitialData()` 按 kind 返回默认参数，未知类型目前返回空对象：

- [apps/desktop/src/renderer/src/pages/canvas/node-mapping.ts#L32-L110](../apps/desktop/src/renderer/src/pages/canvas/node-mapping.ts#L32-L110)

插件需要由 manifest 提供默认值，并保证 UI 创建与 Agent 创建使用同一份默认值，避免两条路径参数不一致。

### 3.5 连线不仅是静态表，还有运行时派发

连接器能力来自 `CONNECTOR_MAP` 和端口语义表：

- [packages/shared/src/connector-map.ts#L12-L35](../packages/shared/src/connector-map.ts#L12-L35)

但新增可运行节点不能只向这张表增加一项，因为边还会参与派生态计算：

- [apps/desktop/src/renderer/src/pages/canvas/edge-dispatch.ts#L86-L99](../apps/desktop/src/renderer/src/pages/canvas/edge-dispatch.ts#L86-L99)

插件 manifest 至少需要声明：

- 输入端口 id、标题、媒体类型；
- 单值 / 多值；
- 必填 / 可选；
- 输出端口及产物媒体类型；
- 上游产物未就绪时的行为；
- 输出如何写回节点，供下游继续消费。

长期应把“边合法性校验”和“运行时输入解析”都收口到同一套端口定义，避免出现“线能画但执行时输入被丢掉”。

### 3.6 当前运行入口不能安全接受未知 kind

`CanvasPage.runNode` 包含大量内置执行分支：

- [apps/desktop/src/renderer/src/pages/CanvasPage.tsx#L3459-L3478](../apps/desktop/src/renderer/src/pages/CanvasPage.tsx#L3459-L3478)

未知 kind 没有统一的“未注册节点”拒绝分支，而会继续落入图片 / 视频判断及 h3c 默认路由：

- [apps/desktop/src/renderer/src/pages/CanvasPage.tsx#L3828-L3830](../apps/desktop/src/renderer/src/pages/CanvasPage.tsx#L3828-L3830)

因此插件化的一个硬性前置条件是：

> **任何未注册、已停用或缺少执行器的 kind，都必须在运行入口明确拒绝，不能落入内置默认引擎。**

### 3.7 参数传递存在显式白名单

渲染层提交参数不是把节点 `data` 原样交给 Provider，而是逐字段构造：

- [apps/desktop/src/renderer/src/pages/CanvasPage.tsx#L4137-L4182](../apps/desktop/src/renderer/src/pages/CanvasPage.tsx#L4137-L4182)

所以“参数已写进节点 data”不代表它一定会到执行层。插件参数必须由通用执行服务按 Schema 读取和校验，不能继续要求每个插件修改这份内置白名单。

### 3.8 Agent 提交是另一条执行路径

Agent 的 `engine.submit` 在主进程另行完成输入解析、参数构造、Provider 路由和 Take 创建：

- [apps/desktop/src/main/tool-handlers.ts#L1753-L1806](../apps/desktop/src/main/tool-handlers.ts#L1753-L1806)
- [apps/desktop/src/main/tool-handlers.ts#L1978-L2071](../apps/desktop/src/main/tool-handlers.ts#L1978-L2071)

如果插件执行只接到渲染层 `runNode`，Agent 仍将无法运行插件。首版必须保证：

> **画布手点与 Agent 提交经过同一个插件执行入口。**

不要求首轮立即迁移所有内置节点，但插件节点不能继续复制第三套提交逻辑。

## 4. 可复用的现有基础

### 4.1 ProviderRegistry 是引擎 seam，不是完整节点 seam

现有 `createRegistry({ extra })` 已允许注入自定义 Provider：

- [packages/providers/src/registry.ts#L12-L43](../packages/providers/src/registry.ts#L12-L43)

适合场景：

- 给现有图片节点增加一个后端；
- 给现有视频节点增加一个模型服务；
- 替换某种引擎实现。

但 `ProviderId`、`RenderRequest.slot` 和能力声明仍围绕图片 / 视频引擎：

- [packages/shared/src/provider.ts#L9-L35](../packages/shared/src/provider.ts#L9-L35)
- [packages/shared/src/provider.ts#L55-L107](../packages/shared/src/provider.ts#L55-L107)

因此需要区分两类 Adapter：

| Adapter | 解决的问题 |
|---|---|
| ProviderAdapter | 新模型、新引擎、新后端 |
| NodeExecutorAdapter | 新节点参数、端口、输入解析、执行行为和产物语义 |

ProviderRegistry 可以继续使用，但不能代替 NodeRegistry / NodeExecutionService。

### 4.2 Agent worker 模式可参考为插件宿主

Agent 已采用独立子进程、JSONL RPC、请求看门狗、取消和退出处理：

- [packages/agent/src/manager.ts#L108-L172](../packages/agent/src/manager.ts#L108-L172)

插件宿主可复用这一模式解决：

- 插件崩溃不拖垮主进程；
- 执行超时；
- 取消与迟到消息丢弃；
- 插件版本升级后的宿主重建；
- 主进程与插件之间的受控 RPC。

但必须明确：

> **子进程隔离解决的是稳定性和生命周期，不自动等于安全沙箱。** 若插件进程仍可任意访问文件、网络和子进程，它仍拥有当前用户的能力。

### 4.3 Skill 导入可复用安装器经验

Skill 已支持文件夹 / zip 导入、入口识别、文件数 / 大小限制和危险路径过滤：

- [apps/desktop/src/main/skill-import.ts#L137-L161](../apps/desktop/src/main/skill-import.ts#L137-L161)

可复用其安装交互和包解析经验，但 Skill 当前只是“现有节点模板 + Markdown 指令”，不提供新的节点执行行为，不能替代节点插件系统。

### 4.4 产物与资产路径白名单可复用

现有输出查找、导入和 ffmpeg 读取都有允许根目录：

- [apps/desktop/src/main/assets.ts#L80-L92](../apps/desktop/src/main/assets.ts#L80-L92)
- [apps/desktop/src/main/assets.ts#L218-L234](../apps/desktop/src/main/assets.ts#L218-L234)

插件产物应由宿主写入受控目录，例如：

```text
~/.bigbotart/outputs/plugins/<pluginId>/<nodeId>/...
```

插件不应自行返回任意本机路径并期望 UI、ffmpeg 或资产系统自动接受。

## 5. 推荐插件包形态

建议首版包结构：

```text
acme-media.bbaplugin
├─ manifest.json
├─ runtime/index.js
├─ icon.svg
├─ README.md
└─ LICENSE
```

manifest 是声明，不是任意提示词或应用代码。示意：

```json
{
  "apiVersion": "bigbotart.node-plugin/v1",
  "id": "acme-media",
  "version": "1.0.0",
  "displayName": "Acme 媒体工具",
  "nodes": [
    {
      "kind": "audio-extract",
      "title": "音频提取",
      "description": "从视频中提取音轨",
      "inputs": [
        {
          "id": "input-video",
          "media": "video",
          "cardinality": "single",
          "required": true
        }
      ],
      "outputs": [
        {
          "id": "audio",
          "media": "audio",
          "primary": true
        }
      ],
      "parametersSchema": {
        "type": "object",
        "properties": {
          "format": {
            "type": "string",
            "enum": ["wav", "mp3"],
            "default": "wav"
          }
        }
      },
      "executor": "runtime/index.js"
    }
  ]
}
```

实际 kind 由注册表加上插件命名空间：

```text
plugin:acme-media:audio-extract
```

首版建议运行时为**自包含的纯 JavaScript bundle**，或由插件声明调用一个明确的外部可执行程序。暂不自动执行 `npm install`，避免依赖供应链、原生模块 ABI 和安装副作用进一步放大首版复杂度。

## 6. 推荐核心架构

### 6.1 NodeRegistry

NodeRegistry 是节点定义的唯一事实源，负责：

- 内置节点和插件节点的注册；
- 插件 id/version/apiVersion 校验；
- 节点标题、图标、说明和默认参数；
- 参数 Schema；
- 输入 / 输出端口；
- 启用、停用和缺失状态；
- 向面板、卡片、检查器、连线和 Agent 提供同一份定义；
- 注册表 revision，供安装后刷新和缓存失效使用。

建议的模块划分（以下是**建议新增路径，不是当前已有实现**）：

```text
packages/shared/src/node-plugin.ts
  类型、manifest 结构、纯校验函数、Agent 摘要生成

apps/desktop/src/main/plugins/
  插件目录、安装存储、加载器、NodeRegistry、插件宿主

apps/desktop/src/main/node-execution.ts
  统一执行入口、输入解析、Take、进度、取消、结果回写

apps/desktop/src/renderer/src/pages/canvas/plugins/
  通用插件卡片与 Schema 驱动检查器
```

### 6.2 NodeExecutionService

NodeExecutionService 是执行的唯一入口，负责：

- 根据 kind 查找已启用定义和执行器；
- 校验参数和输入；
- 将连线解析为插件可消费的输入；
- 输出目录分配；
- 防重复提交；
- Take 创建与终态；
- 进度、取消、超时和错误；
- 主产物与命名产物回写；
- 画布保存和事件广播。

插件执行器只面对一个较小的 Interface：

```text
读取已校验参数和输入
报告进度 / 日志
写入或返回产物
响应取消
```

插件不直接持有 React、Electron BrowserWindow、ProjectStore 或 Agent worker，也不应自行拼接画布快照。

### 6.3 内置节点如何迁移

首版不必重写全部内置节点，可以先让插件走新服务，内置节点维持现状。

但垂直切片完成后，建议迁移一个小型内置节点（如 `frame-grab` 或 `image-crop`）成为第二个 Adapter。只有“内置 + 外部插件”至少两个 Adapter 跑通，才能证明 seam 不是为某一个插件硬编码的。

## 7. Agent 如何发现插件节点

### 7.1 当前 Agent 的节点知识是静态的

系统提示中的节点清单来自 `nodeKindGuide()` 和 `connectorSummary()`：

- [apps/desktop/src/main/memory.ts#L550-L570](../apps/desktop/src/main/memory.ts#L550-L570)

这两个摘要目前来自内置常量：

- [packages/shared/src/connector-map.ts#L227-L272](../packages/shared/src/connector-map.ts#L227-L272)

`canvas.connectors` 也只是返回同一份静态摘要：

- [apps/desktop/src/main/tool-handlers.ts#L774-L777](../apps/desktop/src/main/tool-handlers.ts#L774-L777)

因此：

> **只把插件显示在 React 节点面板，Agent 不会知道它存在。Agent worker 不会读取画布组件状态，也不应扫描插件目录。**

### 7.2 第一层：每轮注入简短能力摘要

主进程在 `buildContext` 时，从 NodeRegistry 读取当前已启用插件，生成固定格式的摘要并追加到系统提示：

```text
【已安装插件节点】
- plugin:acme-media:audio-extract：从视频中提取音轨。
  输入：input-video（video，单值，必填）
  输出：audio
  参数：format=wav|mp3，默认 wav
  使用 canvas.create_node 创建，canvas.connect 连线，engine.submit 执行。
```

摘要至少包含：

- 精确 kind；
- 一句话用途和适用场景；
- 输入 / 输出端口；
- 参数名、类型和默认值；
- 是否有特殊运行约束。

只放摘要，不把完整 manifest、README、实现代码和 JSON Schema 全部注入每轮上下文。

### 7.3 第二层：按需查询完整定义

增加两个通用工具：

```text
plugins.list
  返回当前已启用的插件节点摘要

plugins.read({ kind })
  返回该节点的完整参数 Schema、端口、默认值、限制和使用示例
```

同时让现有 `canvas.connectors` 合并插件端口声明，使 Agent 在连线前能查询：

```text
shot / video-upscale / 视频 asset
  → plugin:acme-media:audio-extract
  → input-video
```

### 7.4 第三层：继续复用通用画布工具

不建议为每种插件节点新增一个 LLM 工具。插件增多后，工具清单会膨胀，本地模型更容易选错工具并消耗更多上下文。

Agent 仍使用：

```text
canvas.create_node
canvas.update_node
canvas.connect / connect_many
engine.submit
```

只是 handler 改为查询 NodeRegistry / NodeExecutionService，而不是只认内置 kind。

示例：用户说“把镜头 01 的声音提取出来”。

```text
canvas.create_node({
  kind: "plugin:acme-media:audio-extract",
  label: "镜头 01 · 音轨",
  data: { format: "wav" }
})

canvas.connect({
  from: "<镜头 01 的真实节点 id>",
  to: "<刚创建的插件节点 id>",
  label: "input-video"
})

engine.submit({
  nodeId: "<插件节点 id>"
})
```

主进程负责再次校验插件状态、参数和输入，不能因为“模型看过 manifest”就跳过运行时校验。

### 7.5 安装后的生效时机

现有系统提示在对话请求时重新组装，因此下一次重新 `buildContext` 的 Agent 对话即可携带新插件摘要，不一定需要重启 worker。

但需要明确：

- 正在生成回答的那一次 LLM 请求不会 retroactively 看到新插件；
- 同一个 `chat()` 请求的多轮工具往返共享已构造的系统提示；
- 安装完成后，应从下一次 AgentChat / 新对话请求开始使用；
- 如需安装后立即继续当前任务，主进程应补一条“插件节点清单已更新”的系统通知，并在下一轮重新构造上下文。

### 7.6 插件描述也属于不可信输入

插件 manifest 中的 description、示例和 README 不能被视为可信系统指令。否则插件可以通过描述文本对 Agent 做提示词注入。

建议：

- 只把结构化字段渲染进宿主固定模板；
- 限制文本长度、控制字符和标记；
- 不提供任意 `agentInstructions` 系统提示注入通道；
- 使用示例必须来自受限字段，而不是任意可执行指令文本；
- 工具权限、文件路径和执行闸门由宿主独立判断，不听从 manifest 自述。

## 8. 安装、更新、停用与卸载

### 8.1 安装

安装阶段只做：

1. 用户显式选择插件包；
2. 校验包大小、文件数、路径穿越、符号链接和入口；
3. 校验 id/version/apiVersion；
4. 校验 manifest、节点 kind、参数 Schema 和端口；
5. 安装到版本化目录；
6. 记录启用状态和安装来源；
7. 发布 registry revision 更新。

安装、探测和启用本身不得触发节点生成、真实推理或任意网络下载。

建议目录：

```text
~/.bigbotart/plugins/<pluginId>/<version>/
~/.bigbotart/plugins.json
```

### 8.2 更新

- 版本并存，避免更新一半破坏旧版本；
- 更新失败继续使用旧版本；
- 插件升级保持 kind 稳定；
- 参数不兼容时提供显式迁移或拒绝运行，不静默猜参数；
- 节点记录最后使用 / 创建时的插件版本，便于排查。

### 8.3 停用与卸载

停用或卸载后：

- 禁止从面板新建；
- 禁止 Agent 新建和提交；
- 已存在节点、连线和 data 原样保留；
- 卡片显示“插件已停用 / 插件缺失”；
- 检查器可以只读查看参数；
- 不自动删除节点，不自动改连其他节点，不伪造产物。

首版可要求安装 / 更新 / 卸载后重启应用，待生命周期稳定后再做热加载。

## 9. 项目持久化与 `.bba` 项目包

建议节点保存：

- 稳定、带命名空间的 kind；
- 插件 id/version 元数据；
- 业务 data；
- 主产物路径和既有 Take 关联。

项目包导出时，根据画布中的插件节点生成依赖清单：

```json
{
  "requiredPlugins": [
    { "id": "acme-media", "version": "1.0.0" }
  ]
}
```

导入时：

- 插件已安装且兼容：正常恢复；
- 插件缺失：保留节点和参数，显示缺失警告；
- 插件版本不兼容：禁止运行并给升级 / 安装指引；
- 不随 `.bba` 自动下载或执行插件；
- 不把 API Key、Token 等插件秘密写进节点 data 或项目包。

现有项目包本就不携带生成产物，而是保留路径并在缺失时警告：

- [apps/desktop/src/main/project-package.ts#L16-L24](../apps/desktop/src/main/project-package.ts#L16-L24)

插件产物应沿用同样的“产物可重跑、路径缺失明确提示”语义。

## 10. 安全与跨端约束

### 10.1 信任级别

首版只支持用户显式安装的可信本地插件，并在安装界面明确说明：

- 插件代码可以执行计算任务；
- 授予哪些文件、网络和子进程权限；
- 子进程隔离不等于无权限；
- 未签名的本地插件不能宣传为安全沙箱插件。

如果未来开放不可信插件市场，需要另行设计：

- 独立插件宿主；
- 最小化 RPC；
- 文件 / 网络 / 环境变量权限；
- 凭据代理；
- 包签名与更新校验；
- 必要时使用 OS 级沙箱。

### 10.2 远程网页模式

插件安装必须限制为桌面管理端，不能让远程浏览器通过 RPC 上传代码到宿主机执行。

现有 API catalog 已有 `desktopOnly`、`pathArg`、`long` 等标记，可复用：

- [packages/shared/src/api-catalog.ts#L11-L16](../packages/shared/src/api-catalog.ts#L11-L16)

网页端可以读取宿主机已经安装并启用的节点定义、使用通用画布功能，但是否允许远程触发高权限插件仍需按插件权限单独判断。

### 10.3 dry-run 与真实执行

- 安装、列插件、读取 manifest、生成 Agent 摘要不得执行节点；
- 插件执行器需要获得明确的 `dryRun` 上下文；
- 不支持 dry-run 的插件必须明确声明，不能在 dry-run 下假装成功；
- 插件的被动探测不能启动大型模型或触发真实推理。

## 11. 推荐实施顺序

### 阶段 A：节点定义与执行收口

- 定义 manifest、NodeDefinition、端口和执行结果类型；
- 实现 NodeRegistry；
- 实现通用插件卡片和 Schema 检查器；
- 实现 NodeExecutionService；
- 未注册 / 停用 / 缺失 kind 明确拒绝；
- UI 与 Agent 共用插件执行入口。

### 阶段 B：一个垂直插件验证完整链路

建议用纯本地“视频提取音频”插件验证：

1. 安装后节点面板动态出现；
2. 通用检查器可编辑参数；
3. 视频节点可连接插件输入；
4. 插件音频输出可连接现有音频 / 镜头节点；
5. 画布手点与 Agent 提交走同一执行器；
6. Take、进度、失败、取消和产物回写正常；
7. 停用 / 卸载后旧节点不丢；
8. 重装后恢复可运行；
9. 未注册 kind 不会落入 h3c 默认路径。

### 阶段 C：安装管理与项目兼容

- `.bbaplugin` 安装、启停、更新和卸载；
- 插件依赖清单进入 `.bba`；
- 缺插件 / 版本不兼容警告；
- 权限说明和桌面端安装限制。

### 阶段 D：证明 seam 的通用性

- 将一个小型内置节点迁移为内置 Adapter；
- 让内置节点与外部插件共享定义、校验和执行路径；
- 再逐步决定是否迁移更多内置节点。

### 阶段 E：可选高级能力

- 受控自定义 UI；
- 多产物与更复杂数据类型；
- 插件签名和分发；
- 不可信插件的真正沙箱。

## 12. 最小验收测试建议

### 12.1 纯函数 / 单元测试

- manifest 缺字段、错误版本、非法 kind；
- 插件 id 命名空间与冲突；
- 参数 Schema 校验和默认值；
- 端口媒体、单多值和必填校验；
- Agent 摘要只包含已启用插件；
- manifest 文本长度与控制字符限制；
- 缺插件 / 停用时的错误文案；
- 输出路径必须位于插件允许目录。

### 12.2 主进程集成测试

- 安装后 registry revision 更新；
- Agent `canvas.create_node` 能创建插件节点；
- 停用后创建和提交均被拒绝；
- UI / Agent 两条提交路径调用同一个执行服务；
- Take 不残留永远 queued 的孤儿记录；
- 执行器异常、超时、取消和迟到消息；
- 卸载后画布节点与连线不变；
- `.bba` 往返保留插件依赖与节点参数。

### 12.3 渲染层集成测试

- 面板与「+」弹层动态显示插件；
- 通用卡片与检查器；
- 缺插件时只读降级；
- 插件产物可预览并被下游读取；
- 连线校验与运行时输入解析一致。

## 13. 方案对比与最终建议

| 方案 | 能力 | 当前可行性 | 改造量 | 建议 |
|---|---|---:|---:|---|
| 现有 Skill 模板包装 | 组合和复用现有节点 | 已有基础 | 小 | 适合工作流模板，不是新节点行为 |
| 声明式节点插件 | 新节点、参数、连线、受控执行 | 可行 | 中到大 | **首版推荐** |
| 完整 JS / React 插件 | 自定义 UI 和任意行为 | 可行但复杂 | 大 | 后置 |
| 不可信插件市场 | 分发、签名、权限、沙箱 | 需要独立体系 | 很大 | 不作为首版目标 |

最终建议：

> **先做 NodeRegistry + NodeExecutionService，再做一个本地插件的垂直切片。Agent 通过“系统提示摘要 + plugins.list/read + 通用画布工具”发现并使用插件。暂不开放任意渲染层代码和不可信插件市场。**

这条路线能够复用当前画布、Take、Provider、Agent 和安装基础设施，同时把首版风险控制在可验证范围内。
